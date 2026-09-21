import { createHash } from "node:crypto";
import type { Db } from "../persistence/database.js";
import type { DecisionRepository } from "../persistence/repositories/decisions.js";
import type { MarketIdentity } from "../market/market-state.js";
import { MarketStateStore } from "../market/market-state.js";
import type { OrderBook } from "../market/types.js";
import { applyFill, computeInventory, EMPTY_POSITION, type Position } from "../inventory/accounting.js";
import { marketPnl, settle, simulateMerge, type MergeResult } from "../inventory/settlement.js";
import { PriceWindow } from "../features/returns.js";
import { normalizeBook } from "../feeds/book-normalizer.js";
import { buildJevState, canonicalJson } from "../jev/state-builder.js";
import { DEFAULT_MATERIAL, materialChange } from "../jev/material-change.js";
import type { JevAnswers, JevInputState, Urgency } from "../jev/decision-types.js";
import type { Decision, JevCall } from "../jev/decision-engine.js";
import { QUESTIONS } from "../jev/questions.js";
import { evaluateRisk, liquidityFor, type RiskVerdict } from "../risk/risk-gate.js";
import type { RiskLimits } from "../risk/limits.js";
import { buildOrders, type OrderIntent } from "../execution/order-builder.js";
import { DEFAULT_FILL_PARAMS, fillMarketable, fillResting, isMarketable, seededRandom, type FillParams, type FillResult } from "./paper-fill-model.js";
import { applyTick, type ReplayEvent } from "./replay-engine.js";

/**
 * Paper trading over recorded markets (brief §38). The full simulated
 * lifecycle: Jev decision -> hypothetical order -> realistic fill/no-fill ->
 * inventory -> merge -> resolution -> PnL.
 *
 * Latency is modelled: an order built on the state at t is evaluated against
 * the first book recorded at or after t + latencyMs. A resting order is
 * evaluated against every book until it expires. Inventory is fed back into
 * the state, so the next Jev call sees the position the last one created.
 */
export interface PaperOptions {
  readonly identity: MarketIdentity;
  readonly events: readonly ReplayEvent[];
  readonly outcome: "UP" | "DOWN";
  readonly limits: RiskLimits;
  readonly heartbeatMs: number;
  readonly minIntervalMs: number;
  readonly latencyMs: number;
  readonly fill: FillParams;
  readonly seed: number;
  readonly mergeGas: number;
  readonly cached: (inputHash: string) => { answers: string; model: string; latencyMs: number } | undefined;
  /** Empirical hold-rate lookup; a replay should pass one built from markets that closed before this one. */
  readonly holdRate?: ((distanceBps: number, secondsRemaining: number) => { rate: number; samples: number } | undefined) | undefined;
  /** Fallback when the hash misses: the decision recorded on this market nearest in time (see DecisionRepository.recordedAnswersAt). */
  readonly recorded?: (atMs: number) => { answers: string; model: string; latencyMs: number; decisionId: string } | undefined;
  readonly call: JevCall | undefined;
  readonly out: DecisionRepository;
  readonly outDb: Db;
  readonly mode: "paper" | "backtest";
}

export interface PaperMarketResult {
  readonly slug: string;
  readonly outcome: "UP" | "DOWN";
  readonly decisions: number;
  readonly approved: number;
  readonly orders: number;
  readonly fills: number;
  readonly partials: number;
  readonly noFills: number;
  readonly merges: number;
  readonly finalPosition: Position;
  readonly grossPnl: number;
  readonly netPnl: number;
  readonly mergePnl: number;
  readonly fees: number;
  readonly jevCalls: number;
  readonly cacheHits: number;
  /** Decisions taken from the recording by time rather than by hash. */
  readonly recordedHits: number;
  readonly skippedNoJev: number;
}

interface Resting {
  readonly order: OrderIntent;
  readonly decisionId: string;
  readonly placedAtMs: number;
  readonly expiresAtMs: number;
  readonly booksSeen: OrderBook[];
}

export async function paperMarket(o: PaperOptions): Promise<PaperMarketResult> {
  const store = new MarketStateStore(o.identity, computeInventory(EMPTY_POSITION));
  const prices = new PriceWindow(120_000);
  const rand = seededRandom(o.seed);
  let position: Position = EMPTY_POSITION;
  let lastJev: JevInputState | undefined;
  let lastSubmitAt = Number.NEGATIVE_INFINITY;
  let lastBookAt = Number.NEGATIVE_INFINITY;
  let lastTickAt = Number.NEGATIVE_INFINITY;
  let decisions = 0, approved = 0, orders = 0, fills = 0, partials = 0, noFills = 0, jevCalls = 0, cacheHits = 0, recordedHits = 0, skippedNoJev = 0;
  let lastRecordedId: string | undefined;
  let fillFees = 0;
  const merges: MergeResult[] = [];
  const pendingMarketable: Array<{ order: OrderIntent; decisionId: string; arriveAtMs: number }> = [];
  const resting: Resting[] = [];
  const latestBook = new Map<string, OrderBook>();
  let orderSeq = 0;

  o.out.upsertMarket(o.identity, o.events[0]?.atMs ?? 0);
  const hasTwap = o.events.some((e) => e.kind === "tick" && e.source?.startsWith("chainlink-twap"));

  const recordOrder = (order: OrderIntent, decisionId: string, materialVersion: bigint, status: string, atMs: number): string => {
    const id = `paper-${o.identity.marketId}-${++orderSeq}`;
    o.outDb.run(`INSERT INTO orders (order_id, decision_id, state_version, market_id, mode, side, asset_id, order_type, price, size, status, created_ms, updated_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, decisionId, materialVersion.toString(), o.identity.marketId, o.mode, order.side, order.assetId, order.style.type, order.price, order.size, status, atMs, atMs]);
    orders++;
    return id;
  };
  const recordFill = (orderId: string, decisionId: string, order: OrderIntent, r: FillResult, atMs: number) => {
    o.outDb.run(`UPDATE orders SET status = ?, updated_ms = ? WHERE order_id = ?`, [r.status, atMs, orderId]);
    if (r.filledQty <= 0) { noFills++; return; }
    o.outDb.run(`INSERT INTO fills (order_id, decision_id, state_version, market_id, mode, side, asset_id, price, size, fee, ts_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [orderId, decisionId, "0", o.identity.marketId, o.mode, order.side, order.assetId, r.avgPrice, r.filledQty, r.fee, atMs]);
    position = applyFill(position, order.side, r.filledQty, r.avgPrice);
    fillFees += r.fee;
    if (r.status === "PARTIAL") partials++; else fills++;
    store.setInventory(computeInventory(position));
    o.outDb.run(`INSERT INTO inventory_snapshots (market_id, mode, ts_ms, inventory_json) VALUES (?,?,?,?)`, [o.identity.marketId, o.mode, atMs, JSON.stringify(computeInventory(position))]);
  };

  const settleMarketable = (nowMs: number) => {
    for (let i = pendingMarketable.length - 1; i >= 0; i--) {
      const p = pendingMarketable[i]!;
      if (nowMs < p.arriveAtMs) continue;
      const book = latestBook.get(p.order.assetId);
      pendingMarketable.splice(i, 1);
      if (!book) continue;
      const id = recordOrder(p.order, p.decisionId, 0n, "SUBMITTED", nowMs);
      recordFill(id, p.decisionId, p.order, fillMarketable(p.order, book, o.fill), nowMs);
    }
  };
  const settleResting = (nowMs: number, force: boolean) => {
    for (let i = resting.length - 1; i >= 0; i--) {
      const r = resting[i]!;
      const book = latestBook.get(r.order.assetId);
      if (book && book.receivedAtMs >= r.placedAtMs + o.latencyMs) r.booksSeen.push(book);
      if (!force && nowMs < r.expiresAtMs) continue;
      resting.splice(i, 1);
      const id = recordOrder(r.order, r.decisionId, 0n, "RESTING", r.placedAtMs);
      recordFill(id, r.decisionId, r.order, fillResting(r.order, r.booksSeen, o.fill, rand), nowMs);
    }
  };

  for (const ev of o.events) {
    if (ev.kind === "tick") {
      applyTick(ev, hasTwap, prices, store);
      if (!hasTwap || ev.source?.startsWith("chainlink-twap")) lastTickAt = ev.atMs;
    } else {
      const book = normalizeBook({ assetId: ev.assetId!, bids: ev.bids!, asks: ev.asks!, receivedAtMs: ev.atMs });
      store.setBook(book);
      latestBook.set(book.assetId, book);
      lastBookAt = ev.atMs;
    }
    settleMarketable(ev.atMs);
    settleResting(ev.atMs, false);

    const snap = store.snapshot(ev.atMs);
    if (!snap.upBook || !snap.downBook || snap.settlementCurrentPrice === undefined) continue;
    if (ev.atMs - lastSubmitAt < o.minIntervalMs) continue;

    const state = buildJevState({ state: snap, prices, chainlinkAgeMs: ev.atMs - lastTickAt, bookAgeMs: ev.atMs - lastBookAt, pairQty: o.limits.maxOrderSizeShares, holdRate: o.holdRate });
    const reason = materialChange(lastJev, state, ev.atMs - lastSubmitAt, { ...DEFAULT_MATERIAL, heartbeatMs: o.heartbeatMs });
    if (!reason) continue;
    lastJev = state;
    lastSubmitAt = ev.atMs;
    const materialVersion = store.markMaterial();
    const inputHash = createHash("sha256").update(canonicalJson(state)).digest("hex");

    let answers: JevAnswers | undefined;
    let model = "cache";
    let latency = 0;
    const c = o.cached(inputHash);
    const rec = c ? undefined : o.recorded?.(ev.atMs);
    if (c) { answers = JSON.parse(c.answers); model = c.model; latency = c.latencyMs; cacheHits++; }
    else if (rec && rec.decisionId !== lastRecordedId) { lastRecordedId = rec.decisionId; answers = JSON.parse(rec.answers); model = rec.model; latency = rec.latencyMs; recordedHits++; }
    else if (o.call) { const t0 = performance.now(); const res = await o.call(state, QUESTIONS, new AbortController().signal); latency = performance.now() - t0; answers = res.answers; model = res.model; jevCalls++; }
    else { skippedNoJev++; continue; }

    const d: Decision = {
      decisionId: `paper-${o.identity.marketId}-${materialVersion}`, marketId: o.identity.marketId,
      stateVersion: materialVersion, rawStateVersion: snap.stateVersion, materialReason: reason,
      packetReceivedMono: undefined, stateUpdatedMono: undefined, inputHash,
      requestedAtMono: 0, respondedAtMono: latency, jevLatencyMs: latency, timestampMs: ev.atMs,
      state, answers: answers!, model, usage: { input_tokens: 0, output_tokens: 0 },
      requestedAction: answers!.action.choice as Decision["requestedAction"],
    };
    decisions++;

    const inv = computeInventory(position);
    const exposure = inv.totalCost;
    const verdict: RiskVerdict = evaluateRisk({
      decisionStateVersion: materialVersion, currentStateVersion: materialVersion,
      action: d.requestedAction, orderSizeShares: o.limits.maxOrderSizeShares,
      secondsRemaining: snap.secondsRemaining, chainlinkAgeMs: ev.atMs - lastTickAt, orderbookAgeMs: ev.atMs - lastBookAt, jevLatencyMs: Math.min(latency, o.limits.maxJevLatencyMs),
      marketLiquidityShares: liquidityFor(d.requestedAction, snap.upBook.asks.reduce((s, l) => s + l.size, 0), snap.downBook.asks.reduce((s, l) => s + l.size, 0), inv),
      spread: Math.max(state.orderbook.upSpread, state.orderbook.downSpread),
      marketExposureUsd: exposure, totalExposureUsd: exposure,
      unpairedExposureUsd: inv.unpairedUpShares * inv.avgUpEntry + inv.unpairedDownShares * inv.avgDownEntry,
      openOrders: resting.length + pendingMarketable.length, dailyPnlUsd: 0, consecutiveErrors: 0,
      executionMode: "simulated",
    }, o.limits);
    o.out.saveDecision(d, verdict);
    if (verdict.result !== "APPROVED") continue;
    approved++;

    const urgency = answers!.execution_urgency.choice as Urgency;
    if (d.requestedAction === "CANCEL") { settleResting(ev.atMs, true); continue; }

    // Inventory intent MERGE: convert matched pairs back into collateral.
    const invAction = answers!.inventory_action.choice;
    if (invAction === "MERGE" && inv.pairedShares > 0) {
      const m = simulateMerge(position, inv.pairedShares, o.mergeGas);
      if (m) {
        merges.push(m); position = m.position; store.setInventory(computeInventory(position));
        o.outDb.run(`INSERT INTO merges (market_id, mode, tx_hash, quantity, paired_cost_basis, collateral_returned, gas, effective_pair_pnl, ts_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
          [o.identity.marketId, o.mode, null, m.quantity, m.pairedCostBasis, m.collateralReturned, m.gas, m.effectivePairPnl, ev.atMs]);
      }
    }

    const allowance = Math.max(0, Math.min(o.limits.maxMarketExposureUsd - exposure, o.limits.maxTotalExposureUsd - exposure));
    const intents = buildOrders(d.requestedAction, urgency, snap, {
      maxOrderSizeShares: o.limits.maxOrderSizeShares, riskAllowanceUsd: allowance,
      tickSize: o.identity.tickSize ?? 0.001, minOrderSize: o.identity.minOrderSize ?? 5,
    });
    for (const order of intents) {
      const bookAtBuild = order.side === "UP" ? snap.upBook : snap.downBook;
      if (isMarketable(order, bookAtBuild)) pendingMarketable.push({ order, decisionId: d.decisionId, arriveAtMs: ev.atMs + o.latencyMs });
      else resting.push({ order, decisionId: d.decisionId, placedAtMs: ev.atMs, expiresAtMs: ev.atMs + (order.style.ttlMs ?? 60_000), booksSeen: [] });
    }
  }

  // Market closed: anything still pending is evaluated on what was seen, then settle.
  settleMarketable(Number.POSITIVE_INFINITY);
  settleResting(o.identity.closesAtMs, true);
  const s = settle(position, o.outcome);
  const pnl = marketPnl(merges, s, fillFees);
  o.outDb.run(`INSERT INTO redemptions (market_id, mode, tx_hash, gross_payout, cost_basis, fees_gas, net_pnl, ts_ms) VALUES (?,?,?,?,?,?,?,?)`,
    [o.identity.marketId, o.mode, null, s.grossPayout, s.costBasis, s.feesGas + fillFees, pnl.netPnl, o.identity.closesAtMs]);
  o.outDb.run(`INSERT INTO pnl_snapshots (market_id, mode, ts_ms, pnl_json) VALUES (?,?,?,?)`, [o.identity.marketId, o.mode, o.identity.closesAtMs, JSON.stringify(pnl)]);

  return {
    slug: o.identity.slug, outcome: o.outcome, decisions, approved, orders, fills, partials, noFills, merges: merges.length,
    finalPosition: position, grossPnl: pnl.grossPnl, netPnl: pnl.netPnl, mergePnl: pnl.mergePnl, fees: pnl.fees, jevCalls, cacheHits, recordedHits, skippedNoJev,
  };
}
