import type { AppConfig } from "./config.js";
import type { Logger } from "../observability/logger.js";
import type { Clock } from "../feeds/clock.js";
import { BookFeed, type SubscribeFn } from "../feeds/polymarket-ws.js";
import { ChainlinkFeed, type ChainlinkSubscribeFn } from "../feeds/chainlink-feed.js";
import { MarketStateStore, type MarketIdentity } from "../market/market-state.js";
import { computeInventory, EMPTY_POSITION } from "../inventory/accounting.js";
import { PriceWindow } from "../features/returns.js";
import { buildJevState } from "../jev/state-builder.js";
import { DecisionEngine, type Decision, type JevCall } from "../jev/decision-engine.js";
import { evaluateRisk, type RiskVerdict } from "../risk/risk-gate.js";
import { bestAsk, bestBid, depth } from "../features/orderbook.js";
import { directionalProbability } from "../analytics/edge-analysis.js";
import { LatencyTracker, breakdown } from "../analytics/latency.js";
import type { DecisionRepository } from "../persistence/repositories/decisions.js";
import { formatProbability } from "./format.js";
import { DEFAULT_MATERIAL, materialChange } from "../jev/material-change.js";
import type { JevInputState } from "../jev/decision-types.js";

export interface ObserverDeps {
  readonly cfg: AppConfig;
  readonly log: Logger;
  readonly clock: Clock;
  readonly marketSubscribe: SubscribeFn;
  readonly chainlinkSubscribe: ChainlinkSubscribeFn;
  readonly jevCall: JevCall;
  readonly repo: DecisionRepository;
  readonly display?: (line: string) => void;
}

/**
 * One market's observe-mode lifecycle: feeds -> state -> Jev -> risk gate ->
 * persistence -> display. Never builds an order. Returns when the market
 * closes so the caller can roll to the next one.
 */
export class MarketObserver {
  private readonly store: MarketStateStore;
  private readonly prices = new PriceWindow(120_000);
  private readonly latency = new LatencyTracker();
  private readonly engine: DecisionEngine;
  private readonly books: BookFeed;
  private readonly chainlink: ChainlinkFeed;
  private lastPacketMono = Number.NaN;
  private lastStateMono = Number.NaN;
  private decisions = 0;
  private stopped = false;
  private lastWaitLogMono = Number.NEGATIVE_INFINITY;
  private lastBookSaveMono = new Map<string, number>();
  private submitted = 0;
  private readonly startedMono: number;
  private lastJevState: JevInputState | undefined;
  private lastSubmitMono = Number.NEGATIVE_INFINITY;
  private lastPersistFailMono = Number.NEGATIVE_INFINITY;

  /**
   * Persistence must never take a feed down. A failed write is logged (rate
   * limited) and dropped; the state in memory stays correct.
   */
  private persist(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      const now = this.deps.clock.mono();
      if (now - this.lastPersistFailMono > 5_000) {
        this.lastPersistFailMono = now;
        this.deps.log.error("persistence failed (dropping writes)", { what, err });
      }
    }
  }

  constructor(private readonly deps: ObserverDeps, readonly market: MarketIdentity) {
    const { cfg, log, clock } = deps;
    this.startedMono = clock.mono();
    this.store = new MarketStateStore(market, computeInventory(EMPTY_POSITION));
    this.persist("market", () => deps.repo.upsertMarket(market, clock.wall()));

    this.engine = new DecisionEngine({
      call: deps.jevCall,
      mono: clock.mono,
      wall: clock.wall,
      log,
      coalesceMs: cfg.jev.coalesceMs,
      minIntervalMs: cfg.jev.minIntervalMs,
      onDecision: (d) => this.onDecision(d),
      onError: (err, v) => {
        log.error("jev call failed", { err, stateVersion: v });
        this.persist("error", () => deps.repo.saveError("jev", err instanceof Error ? err.message : String(err), market.marketId, clock.wall()));
      },
    });

    this.books = new BookFeed({
      assetIds: [market.upAssetId, market.downAssetId],
      subscribe: deps.marketSubscribe,
      now: clock.mono,
      log: log.child({ feed: "market" }),
      onStreamError: (reason) => this.persist("error", () => deps.repo.saveError("market-ws", reason, market.marketId, clock.wall())),
      handlers: {
        // Market events carry millisecond timestamps; Chainlink's are rounded
        // to whole seconds and would bias the drift estimate by up to 1 s.
        onServerTime: (serverMs) => clock.observeServerTime(serverMs),
        onBook: (book) => {
          this.lastPacketMono = clock.mono();
          this.store.setBook(book);
          this.lastStateMono = clock.mono();
          // Books change hundreds of times a second; one snapshot per asset
          // every 500 ms is plenty for replay and keeps the event loop free.
          const lastSave = this.lastBookSaveMono.get(book.assetId) ?? Number.NEGATIVE_INFINITY;
          if (clock.mono() - lastSave >= 500) {
            this.lastBookSaveMono.set(book.assetId, clock.mono());
            this.persist("book", () => deps.repo.saveBook(market.marketId, book.assetId, clock.wall(), book.bids.slice(0, 10), book.asks.slice(0, 10)));
          }
          this.maybeDecide();
        },
        onResolved: (p) => {
          log.info("market resolved", { conditionId: p.conditionId, winningOutcome: p.winningOutcome });
          if (p.winningOutcome) this.persist("resolved", () => deps.repo.markResolved(market.marketId, p.winningOutcome!));
        },
        onReconnect: (n) => log.warn("market feed reconnected", { attempt: n }),
      },
    });

    this.chainlink = new ChainlinkFeed({
      symbol: cfg.chainlinkSymbol,
      subscribe: deps.chainlinkSubscribe,
      now: clock.mono,
      log: log.child({ feed: "chainlink" }),
      onStreamError: (reason) => this.persist("error", () => deps.repo.saveError("chainlink-ws", reason, market.marketId, clock.wall())),
      onTick: (t) => {
        this.lastPacketMono = clock.mono();
        this.prices.push({ ts: t.ts, price: t.price });
        this.store.setSettlementPrice(t.price, t.ts);
        this.lastStateMono = clock.mono();
        this.persist("tick", () => deps.repo.saveTick(market.marketId, "chainlink", t.ts, clock.wall(), t.price));
        this.maybeDecide();
      },
    });
  }

  private maybeDecide(): void {
    if (this.stopped) return;
    const { cfg, clock, log, repo } = this.deps;
    const snap = this.store.snapshot(clock.wall());
    const drifted = !clock.withinTolerance(cfg.maxClockDriftMs);
    const missing = [
      snap.upBook ? null : "upBook",
      snap.downBook ? null : "downBook",
      snap.settlementCurrentPrice === undefined ? "chainlinkPrice" : null,
      drifted ? `clockDrift(${Math.round(clock.driftMs())}ms > ${cfg.maxClockDriftMs}ms)` : null,
    ].filter((x): x is string => x !== null);

    if (missing.length > 0) {
      // Say why nothing is happening - once every 10 s after a 3 s warm-up,
      // persisted so the report shows it even when the console is gone.
      if (clock.mono() - this.startedMono > 3_000 && clock.mono() - this.lastWaitLogMono > 10_000) {
        this.lastWaitLogMono = clock.mono();
        const msg = `not deciding: ${missing.join(", ")}`;
        if (drifted) log.error(msg, { driftMs: clock.driftMs() }); else log.info(msg);
        this.persist("error", () => repo.saveError(drifted ? "clock" : "observer-wait", msg, this.market.marketId, clock.wall()));
      }
      return;
    }

    const state = buildJevState({
      state: snap,
      prices: this.prices,
      chainlinkAgeMs: this.chainlink.ageMs(),
      bookAgeMs: this.books.ageMs(),
      pairQty: cfg.limits.maxOrderSizeShares,
    });

    // Only a material change earns a request (brief §10). Everything else
    // bumps the raw version for the audit trail and stops here.
    const reason = materialChange(this.lastJevState, state, clock.mono() - this.lastSubmitMono, { ...DEFAULT_MATERIAL, heartbeatMs: cfg.jev.heartbeatMs });
    if (!reason) return;
    this.lastJevState = state;
    this.lastSubmitMono = clock.mono();
    const materialVersion = this.store.markMaterial();

    this.engine.submit(this.market.marketId, materialVersion, state, {
      rawStateVersion: snap.stateVersion,
      materialReason: reason,
      packetReceivedMono: this.lastPacketMono,
      stateUpdatedMono: this.lastStateMono,
    });
    if (this.submitted++ === 0) log.info("first state submitted to jev", { materialVersion, rawStateVersion: snap.stateVersion, reason, secondsRemaining: state.market.secondsRemaining });
  }

  private onDecision(d: Decision): void {
    const { cfg, clock, log, repo } = this.deps;
    const validatedMono = clock.mono();
    const snap = this.store.snapshot(clock.wall());
    const spreadOf = (b: typeof snap.upBook) => (b ? (bestAsk(b) ?? 1) - (bestBid(b) ?? 0) : 1);

    const verdict: RiskVerdict = evaluateRisk(
      {
        decisionStateVersion: d.stateVersion,
        currentStateVersion: snap.materialVersion,
        action: d.requestedAction,
        orderSizeShares: cfg.limits.maxOrderSizeShares,
        secondsRemaining: snap.secondsRemaining,
        chainlinkAgeMs: this.chainlink.ageMs(),
        orderbookAgeMs: this.books.ageMs(),
        jevLatencyMs: d.jevLatencyMs,
        marketLiquidityShares: Math.min(depth(snap.upBook?.asks ?? []), depth(snap.downBook?.asks ?? [])),
        spread: Math.max(spreadOf(snap.upBook), spreadOf(snap.downBook)),
        marketExposureUsd: snap.inventory.totalCost,
        totalExposureUsd: snap.inventory.totalCost,
        unpairedExposureUsd: snap.inventory.unpairedUpShares * snap.inventory.avgUpEntry + snap.inventory.unpairedDownShares * snap.inventory.avgDownEntry,
        openOrders: snap.openOrderCount,
        dailyPnlUsd: 0,
        consecutiveErrors: 0,
        executionMode: "none",
      },
      cfg.limits,
    );

    if (this.decisions === 0) log.info("first jev decision received", { jevMs: Number(d.jevLatencyMs.toFixed(1)), action: d.requestedAction });
    this.persist("decision", () => repo.saveDecision(d, verdict));
    const b = breakdown({
      packetReceived: d.packetReceivedMono,
      stateUpdated: d.stateUpdatedMono,
      jevRequestStarted: d.requestedAtMono,
      jevResponseReceived: d.respondedAtMono,
      decisionValidated: validatedMono,
    });
    this.latency.record(b);
    this.persist("latency", () => repo.saveLatency(this.market.marketId, d.decisionId, d.timestampMs, b));
    this.decisions++;

    this.render(d, verdict);
    log.info("decision", {
      decisionId: d.decisionId, stateVersion: d.stateVersion, action: d.requestedAction,
      risk: verdict, jevMs: Number(d.jevLatencyMs.toFixed(1)), model: d.model, tokens: d.usage,
    });
  }

  private render(d: Decision, verdict: RiskVerdict): void {
    const out = this.deps.display ?? ((l: string) => process.stdout.write(l + "\n"));
    const s = d.state;
    const dir = directionalProbability(d.answers.settlement_direction);
    const probs = Object.entries(d.answers.action.probabilities as Record<string, number>)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join("  ");
    const pct = (p: number) => `${(p * 100).toFixed(2)}%`;
    const risk = verdict.result === "APPROVED" ? "APPROVED" : `REJECTED (${verdict.reason})`;
    out(
      [
        `BTC-5M ${this.market.slug} | ${s.market.secondsRemaining.toFixed(1)}s | Δ ${s.market.distanceBps >= 0 ? "+" : ""}${s.market.distanceBps.toFixed(2)}bps`,
        `UP ${s.orderbook.upBid.toFixed(3)}/${s.orderbook.upAsk.toFixed(3)}  DOWN ${s.orderbook.downBid.toFixed(3)}/${s.orderbook.downAsk.toFixed(3)}  PAIR ${s.orderbook.pairAskCost.toFixed(4)} (edge ${s.orderbook.pairEdge.toFixed(4)} @ ${s.orderbook.pairExecutableQty})`,
        `JEV: UP ${pct(dir.pUp)}  DOWN ${pct(dir.pDown)}  unresolved ${formatProbability(dir.unresolvedMass)}`,
        `ACTION: ${probs}   -> ${d.requestedAction}  [${risk}]`,
        `JEV ${d.jevLatencyMs.toFixed(0)}ms  tokens ${d.usage.input_tokens}/${d.usage.output_tokens}  model ${d.model}  m${d.stateVersion} (raw ${d.rawStateVersion}, ${d.materialReason})  #${this.decisions}`,
        "",
      ].join("\n"),
    );
  }

  latencyReport(): Record<string, unknown> {
    return this.latency.report();
  }

  decisionCount(): number {
    return this.decisions;
  }

  /** Runs until the market closes (plus a grace period for the resolve event). */
  async run(graceMs = 15_000): Promise<void> {
    this.books.start();
    this.chainlink.start();
    const { clock } = this.deps;
    while (!this.stopped && clock.wall() < this.market.closesAtMs + graceMs) {
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.stop();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.all([this.books.stop(), this.chainlink.stop()]);
  }
}
