import type { AppConfig } from "./config.js";
import type { Logger } from "../observability/logger.js";
import type { Clock } from "../feeds/clock.js";
import { BookFeed, type SubscribeFn, type Trade } from "../feeds/polymarket-ws.js";
import { ChainlinkFeed, type ChainlinkSubscribeFn } from "../feeds/chainlink-feed.js";
import { MarketStateStore, type MarketIdentity, type MarketState } from "../market/market-state.js";
import type { OrderBook } from "../market/types.js";
import { computeInventory, EMPTY_POSITION, type InventoryAccounting } from "../inventory/accounting.js";
import { PriceWindow } from "../features/returns.js";
import { buildJevState } from "../jev/state-builder.js";
import { DecisionEngine, type Decision, type JevCall } from "../jev/decision-engine.js";
import { evaluateRisk, liquidityFor, type RiskVerdict } from "../risk/risk-gate.js";
import { bestAsk, bestBid, depth } from "../features/orderbook.js";
import { directionalProbability } from "../analytics/edge-analysis.js";
import { LatencyTracker, breakdown } from "../analytics/latency.js";
import type { DecisionRepository } from "../persistence/repositories/decisions.js";
import { formatProbability } from "./format.js";
import { DEFAULT_MATERIAL, materialChange } from "../jev/material-change.js";
import { DEFAULT_KILL_THRESHOLDS, KillSwitch, type KillState } from "../risk/kill-switch.js";
import { APIConnectionError, APITimeoutError } from "@typesafe-ai/sdk";
import type { JevInputState } from "../jev/decision-types.js";

export interface SettlementStart { readonly price: number; readonly ts: number; readonly source: string }

export interface ObserverDeps {
  readonly cfg: AppConfig;
  readonly log: Logger;
  readonly clock: Clock;
  readonly marketSubscribe: SubscribeFn;
  /** Chainlink spot stream: movement features. */
  readonly chainlinkSubscribe: ChainlinkSubscribeFn;
  /** Chainlink TWAP stream (60 s): the settlement quantity. Falls back to spot when absent. */
  readonly chainlinkTwapSubscribe?: ChainlinkSubscribeFn;
  readonly jevCall: JevCall;
  /**
   * The settlement price at the open second, from a tape that was listening
   * before this observer existed (feeds/price-tape.ts). Without it the first
   * tick this observer sees becomes the start, which is late by however long
   * discovery took - and wrong by however far BTC moved meanwhile.
   */
  readonly settlementStart?: SettlementStart | Promise<SettlementStart | undefined> | undefined;
  /** Empirical hold-rate lookup for the Jev state (analytics/hold-rate.ts). */
  readonly holdRate?: ((distanceBps: number, secondsRemaining: number, spotVsTwapBps: number) => { rate: number; samples: number } | undefined) | undefined;
  readonly repo: DecisionRepository;
  readonly display?: (line: string) => void;
  /** Execution mode handed to the risk gate. "none" in observe. */
  readonly executionMode?: "none" | "simulated" | "live";
  /** Realised PnL today in the mode being run, for the daily-loss limit and the kill switch. Default 0. */
  readonly dailyPnlUsd?: () => number;
  /** Called for every APPROVED decision with the snapshot it was checked against. Shadow/paper-live plug in here. */
  readonly onApproved?: (decision: Decision, snapshot: MarketState, decisionMono: number) => void | Promise<void>;
  /** Called with every normalised book update (for engines that track post-decision book movement). */
  readonly onBookUpdate?: (book: OrderBook, nowMono: number) => void;
  /** Called with every match printed on the market channel (the paper engine's maker-fill queue runs on these). */
  readonly onTrade?: (trade: Trade, nowMono: number) => void;
  /** Label for the heartbeat the dashboard shows ("observer", "shadow"). */
  readonly processName?: string;
  /** Called when the kill switch trips: cancel resting orders, reconcile. Never liquidate. */
  readonly onKill?: (state: KillState) => void | Promise<void>;
  /** Called when a transient trip clears or the operator resumes: new orders may be built again. */
  readonly onKillCleared?: () => void;
  /** Called when the feed reports the market resolved. */
  readonly onResolved?: (outcome: "UP" | "DOWN" | undefined, raw: { conditionId: string; winningAssetId?: string | null; winningOutcome?: string | null }) => void;
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
  private readonly twap: ChainlinkFeed | undefined;
  private lastPacketMono = Number.NaN;
  private lastStateMono = Number.NaN;
  private decisions = 0;
  private stopped = false;
  private lastWaitLogMono = Number.NEGATIVE_INFINITY;
  private lastBookSaveMono = new Map<string, number>();
  private submitted = 0;
  private readonly startedMono: number;
  private lastJevState: JevInputState | undefined;
  private readonly kill: KillSwitch;
  private lastControlPollMono = Number.NEGATIVE_INFINITY;
  private lastHeartbeatMono = Number.NEGATIVE_INFINITY;
  private manualKill = false;
  private manualNote: string | undefined;
  private tapeStart: SettlementStart | undefined;
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
    this.kill = new KillSwitch(
      { ...DEFAULT_KILL_THRESHOLDS, maxClockDriftMs: cfg.maxClockDriftMs, maxDailyLossUsd: cfg.limits.maxDailyLossUsd },
      {
        onTrip: (reasons) => {
          log.error("KILL SWITCH TRIPPED - no new orders", { reasons });
          // The operator's note marks the row as a command; keep it while their kill is active.
          this.persist("control", () => deps.repo.setControl("kill", JSON.stringify({ tripped: true, reasons, hard: this.kill.state().hard, since: clock.wall(), ...(this.manualKill ? { note: this.manualNote ?? "manual" } : {}) }), clock.wall()));
          this.persist("error", () => deps.repo.saveError("kill-switch", `tripped: ${reasons.join(", ")}`, market.marketId, clock.wall()));
          void Promise.resolve(deps.onKill?.(this.kill.state())).catch((err: unknown) => log.error("onKill failed", { err }));
        },
        onClear: () => {
          log.warn("kill switch cleared - resuming");
          this.persist("control", () => deps.repo.setControl("kill", JSON.stringify({ tripped: false, clearedAt: clock.wall() }), clock.wall()));
          try { deps.onKillCleared?.(); } catch (err) { log.error("onKillCleared failed", { err }); }
        },
      },
    );
    this.persist("market", () => deps.repo.upsertMarket(market, clock.wall()));
    // The tape's open-second tick may arrive a few seconds after the open
    // (the TWAP stream lags). It overrides whatever the first live tick set.
    void Promise.resolve(deps.settlementStart).then((st) => {
      if (this.stopped) return;
      if (!st) {
        log.warn("no start price on the tape for this market; the first settlement tick stands in and is late", { openedAt: new Date(market.openedAtMs).toISOString() });
        return;
      }
      const before = this.store.snapshot(clock.wall()).settlementStartPrice;
      this.store.setSettlementStartPrice(st.price);
      this.tapeStart = st;
      // Record the start tick under this market so a replay derives the same outcome.
      this.persist("tick", () => deps.repo.saveTick(market.marketId, st.source, st.ts, clock.wall(), st.price));
      this.persist("market", () => deps.repo.setStartLag(market.marketId, st.ts - market.openedAtMs, st.source, true));
      log.info("settlement start price from tape", { price: st.price, source: st.source, lagMs: st.ts - market.openedAtMs, replaced: before !== undefined && before !== st.price ? before : undefined });
      this.maybeDecide();
    }).catch((err: unknown) => log.error("settlement start lookup failed", { err }));

    this.engine = new DecisionEngine({
      call: deps.jevCall,
      mono: clock.mono,
      wall: clock.wall,
      log,
      coalesceMs: cfg.jev.coalesceMs,
      minIntervalMs: cfg.jev.minIntervalMs,
      onDecision: (d) => this.onDecision(d),
      onError: (err, v) => {
        this.kill.jevFailed(err instanceof APITimeoutError ? "JEV_TIMEOUT" : err instanceof APIConnectionError ? "JEV_UNAVAILABLE" : "JEV_INVALID", clock.mono());
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
          deps.onBookUpdate?.(book, clock.mono());
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
          const k = p.winningOutcome?.trim().toLowerCase();
          const outcome = k === "up" || k === "yes" ? "UP" : k === "down" || k === "no" ? "DOWN"
            : p.winningAssetId === market.upAssetId ? "UP" : p.winningAssetId === market.downAssetId ? "DOWN" : undefined;
          deps.onResolved?.(outcome, p);
        },
        onTrade: (t) => {
          this.persist("trade", () => deps.repo.saveTrade(market.marketId, t.assetId, t.tsMs, clock.wall(), t.price, t.size, t.side, t.feeRateBps));
          deps.onTrade?.(t, clock.mono());
        },
        onReconnect: (n) => log.warn("market feed reconnected", { attempt: n }),
      },
    });

    const hasTwap = !!deps.chainlinkTwapSubscribe;
    this.chainlink = new ChainlinkFeed({
      symbol: cfg.chainlinkSymbol,
      subscribe: deps.chainlinkSubscribe,
      now: clock.mono,
      log: log.child({ feed: "chainlink" }),
      onStreamError: (reason) => this.persist("error", () => deps.repo.saveError("chainlink-ws", reason, market.marketId, clock.wall())),
      onTick: (t) => {
        this.lastPacketMono = clock.mono();
        this.prices.push({ ts: t.ts, price: t.price });
        this.store.setSpotPrice(t.price);
        // Without a TWAP stream the spot stands in for settlement (older behaviour).
        if (!hasTwap) this.store.setSettlementPrice(t.price, t.ts);
        this.lastStateMono = clock.mono();
        this.persist("tick", () => deps.repo.saveTick(market.marketId, "chainlink", t.ts, clock.wall(), t.price));
        this.maybeDecide();
      },
    });
    this.twap = hasTwap
      ? new ChainlinkFeed({
          symbol: cfg.chainlinkSymbol,
          subscribe: deps.chainlinkTwapSubscribe!,
          now: clock.mono,
          log: log.child({ feed: "chainlink-twap" }),
          onStreamError: (reason) => this.persist("error", () => deps.repo.saveError("chainlink-twap-ws", reason, market.marketId, clock.wall())),
          onTick: (t) => {
            this.lastPacketMono = clock.mono();
            if (!this.tapeStart && this.store.snapshot(clock.wall()).settlementStartPrice === undefined && t.ts >= market.openedAtMs) {
              this.persist("market", () => deps.repo.setStartLag(market.marketId, t.ts - market.openedAtMs, `chainlink-twap${cfg.chainlinkTwapSeconds}`, false));
            }
            this.store.setSettlementPrice(t.price, t.ts);
            this.lastStateMono = clock.mono();
            this.persist("tick", () => deps.repo.saveTick(market.marketId, `chainlink-twap${cfg.chainlinkTwapSeconds}`, t.ts, clock.wall(), t.price));
            this.maybeDecide();
          },
        })
      : undefined;
  }

  /** Kill-switch health, operator control and heartbeat. Cheap; runs on every event. */
  private housekeeping(): void {
    const { clock, repo, log } = this.deps;
    const nowMono = clock.mono();
    this.kill.evaluate({ nowMono, chainlinkAgeMs: this.settlementAgeMs(), marketWsAgeMs: this.books.ageMs(), clockDriftMs: clock.driftMs(), dailyPnlUsd: this.deps.dailyPnlUsd?.() ?? 0 });

    if (nowMono - this.lastControlPollMono >= 1_000) {
      this.lastControlPollMono = nowMono;
      let ctl: { value: string } | undefined;
      try { ctl = repo.getControl("kill"); } catch { ctl = undefined; }
      // Only an operator's row counts as a command. The bot writes its own
      // trips into the same row; reading those back as "manual" would turn
      // every self-clearing trip into a hard one that never clears.
      // An operator row (dashboard, pnpm kill) carries MANUAL and a note; rows
      // the bot wrote for its own trips carry neither.
      const parsed = ctl ? (JSON.parse(ctl.value) as { tripped?: boolean; reasons?: string[]; note?: string }) : undefined;
      const wantKill = parsed?.tripped === true && (parsed.reasons ?? []).includes("MANUAL") && typeof parsed.note === "string";
      if (wantKill && !this.manualKill) { this.manualKill = true; this.manualNote = parsed?.note; this.kill.manualKill(nowMono); }
      if (!wantKill && this.manualKill) { this.manualKill = false; this.kill.resume(); log.info("operator resume acknowledged"); }
    }
    if (nowMono - this.lastHeartbeatMono >= 2_000) {
      this.lastHeartbeatMono = nowMono;
      this.persist("heartbeat", () => repo.heartbeat(this.deps.processName ?? "observer", { phase: "observing", market: this.market.slug, decisions: this.decisions, killed: this.kill.state().tripped, chainlinkAgeS: Number((this.settlementAgeMs() / 1000).toFixed(1)), spotAgeS: Number((this.chainlink.ageMs() / 1000).toFixed(1)), bookAgeS: Number((this.books.ageMs() / 1000).toFixed(1)) }, clock.wall()));
    }
  }

  /** Age of the settlement stream: TWAP when subscribed, else spot. */
  private settlementAgeMs(): number {
    return this.twap ? this.twap.ageMs() : this.chainlink.ageMs();
  }

  /** Execution engines feed the position back so the next decision sees it. */
  setInventory(inv: InventoryAccounting): void {
    this.store.setInventory(inv);
  }

  setOpenOrderCount(n: number): void {
    this.store.setOpenOrderCount(n);
  }

  latestBook(assetId: string): OrderBook | undefined {
    return this.books.book(assetId);
  }

  settlementNow(): { start: number | undefined; current: number | undefined } {
    const s = this.store.snapshot(this.deps.clock.wall());
    return { start: s.settlementStartPrice, current: s.settlementCurrentPrice };
  }

  killState(): KillState {
    return this.kill.state();
  }

  /** Execution engines report exchange failures and hard faults here. */
  apiError(): void { this.kill.apiError(this.deps.clock.mono()); }
  hardFault(reason: Parameters<KillSwitch["hardFault"]>[0]): void { this.kill.hardFault(reason, this.deps.clock.mono()); }

  private maybeDecide(): void {
    if (this.stopped) return;
    const { cfg, clock, log, repo } = this.deps;
    // After the close there is nothing left to decide; the grace period only
    // waits for the resolution event. Decisions made there would be judged
    // against ticks the settlement no longer includes.
    if (clock.wall() >= this.market.closesAtMs) return;
    this.housekeeping();
    const snap = this.store.snapshot(clock.wall());
    const drifted = !clock.withinTolerance(cfg.maxClockDriftMs);
    const missing = [
      snap.upBook ? null : "upBook",
      snap.downBook ? null : "downBook",
      snap.settlementCurrentPrice === undefined ? (this.twap ? "twapPrice" : "chainlinkPrice") : null,
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
      chainlinkAgeMs: this.settlementAgeMs(),
      bookAgeMs: this.books.ageMs(),
      pairQty: cfg.limits.maxOrderSizeShares,
      holdRate: this.deps.holdRate,
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

    this.kill.jevSucceeded();
    const killed = this.kill.state();
    // Measured edge of a directional buy: the side's win probability from the
    // hold-rate table against the ask it would pay. A buy that completes a set
    // against unpaired inventory is a hedge and needs none.
    const edge = (() => {
      if (d.requestedAction !== "BUY_UP" && d.requestedAction !== "BUY_DOWN") return {};
      const side = d.requestedAction === "BUY_UP" ? "UP" : "DOWN";
      const completesSet = side === "UP" ? snap.inventory.unpairedDownShares > 0 : snap.inventory.unpairedUpShares > 0;
      if (completesSet) return {};
      const book = side === "UP" ? snap.upBook : snap.downBook;
      const ask = book ? bestAsk(book) : undefined;
      if (ask === undefined) return {};
      if (snap.settlementStartPrice === undefined || snap.settlementCurrentPrice === undefined) return { buyPrice: ask };
      const dist = ((snap.settlementCurrentPrice - snap.settlementStartPrice) / snap.settlementStartPrice) * 10_000;
      const spotVsTwap = snap.spotPrice !== undefined ? ((snap.spotPrice - snap.settlementCurrentPrice) / snap.settlementCurrentPrice) * 10_000 : 0;
      const held = this.deps.holdRate?.(dist, snap.secondsRemaining, spotVsTwap);
      if (!held) return { buyPrice: ask };
      const leader = dist >= 0 ? "UP" : "DOWN";
      return { buyPrice: ask, measuredWinProbability: side === leader ? held.rate : 1 - held.rate, measuredSamples: held.samples };
    })();
    const verdict: RiskVerdict = killed.tripped && !["HOLD", "ABSTAIN"].includes(d.requestedAction)
      ? { result: "REJECTED", reason: "KILL_SWITCH" }
      : evaluateRisk(
      {
        ...edge,
        decisionStateVersion: d.stateVersion,
        currentStateVersion: snap.materialVersion,
        action: d.requestedAction,
        orderSizeShares: cfg.limits.maxOrderSizeShares,
        secondsRemaining: snap.secondsRemaining,
        chainlinkAgeMs: this.settlementAgeMs(),
        orderbookAgeMs: this.books.ageMs(),
        jevLatencyMs: d.jevLatencyMs,
        marketLiquidityShares: liquidityFor(d.requestedAction, depth(snap.upBook?.asks ?? []), depth(snap.downBook?.asks ?? []), snap.inventory),
        spread: Math.max(spreadOf(snap.upBook), spreadOf(snap.downBook)),
        marketExposureUsd: snap.inventory.totalCost,
        totalExposureUsd: snap.inventory.totalCost,
        unpairedExposureUsd: snap.inventory.unpairedUpShares * snap.inventory.avgUpEntry + snap.inventory.unpairedDownShares * snap.inventory.avgDownEntry,
        openOrders: snap.openOrderCount,
        dailyPnlUsd: this.deps.dailyPnlUsd?.() ?? 0,
        consecutiveErrors: 0,
        executionMode: this.deps.executionMode ?? "none",
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
    if (verdict.result === "APPROVED" && this.deps.onApproved) {
      void Promise.resolve(this.deps.onApproved(d, snap, validatedMono)).catch((err: unknown) => log.error("onApproved failed", { err }));
    }
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
        `BTC-5M ${this.market.slug} | ${s.market.secondsRemaining.toFixed(1)}s | TWAP Δ ${s.market.distanceBps >= 0 ? "+" : ""}${s.market.distanceBps.toFixed(2)}bps | spot vs TWAP ${s.market.spotVsTwapBps >= 0 ? "+" : ""}${s.market.spotVsTwapBps.toFixed(2)}bps`,
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

  /**
   * Runs until the market closes, plus a short grace period for a resolve
   * event. The resolution normally arrives minutes later (pnpm resolve backfills
   * it), so the grace is kept short: every second here is a second the next
   * market is not being observed.
   */
  async run(graceMs = 3_000): Promise<void> {
    this.books.start();
    this.chainlink.start();
    this.twap?.start();
    const { clock } = this.deps;
    while (!this.stopped && clock.wall() < this.market.closesAtMs + graceMs) {
      // Health, kill switch and heartbeat must not depend on feed events:
      // a silent feed is exactly the case the kill switch exists for.
      this.housekeeping();
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.stop();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.all([this.books.stop(), this.chainlink.stop(), this.twap?.stop()]);
  }
}
