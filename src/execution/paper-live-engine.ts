import type { Db } from "../persistence/database.js";
import type { MarketIdentity, MarketState } from "../market/market-state.js";
import type { OrderBook } from "../market/types.js";
import type { Trade } from "../feeds/polymarket-ws.js";
import { applyFill, computeInventory, EMPTY_POSITION, type Position } from "../inventory/accounting.js";
import { marketPnl, settle, simulateMerge, type MergeResult } from "../inventory/settlement.js";
import type { Decision } from "../jev/decision-engine.js";
import type { Urgency } from "../jev/decision-types.js";
import { buildOrders, type OrderIntent } from "./order-builder.js";
import { fillMarketable, fillResting, isMarketable, seededRandom, type FillParams, type FillResult } from "../replay/paper-fill-model.js";
import type { RiskLimits } from "../risk/limits.js";

/**
 * Paper trading against LIVE order books (brief §14, PAPER). Runs beside the
 * observer in real time: an approved decision becomes hypothetical orders; a
 * marketable order is evaluated against the book that arrives after the
 * configured latency; a resting order is watched until traded through or
 * expired; fills update a simulated position that is fed back into the
 * state; at resolution the position settles at the real outcome.
 *
 * Resting bids also fill as a MAKER, from the trades printed on the market
 * channel: at placement the order joins the queue behind every bid at its
 * price or better (price-time priority); each taker sell at or through its
 * price consumes that queue first, whatever is left fills the order. This is
 * how the reference trader gets his hedges (39 of 40 checked printed while
 * the side had no ask at all), and it is the only way a paper hedge at
 * 1.00 minus the tail can fill once the leader's ask side has emptied.
 * A hedge (`completesSet`) rests until the close: cancelling and
 * re-placing it would throw away its place in the queue.
 *
 * Nothing here can reach the exchange - there is no client in this module.
 */
export interface PaperLiveOptions {
  readonly market: MarketIdentity;
  readonly limits: RiskLimits;
  readonly latencyMs: number;
  readonly fill: FillParams;
  readonly seed: number;
  readonly mono: () => number;
  readonly wall: () => number;
  readonly db: Db;
  readonly onInventory: (inv: ReturnType<typeof computeInventory>, openOrders: number) => void;
  readonly log: (msg: string, fields?: Record<string, unknown>) => void;
}

interface PendingMarketable { order: OrderIntent; decisionId: string; arriveAtMono: number; version: bigint }
interface Resting {
  order: OrderIntent; decisionId: string; placedAtMono: number; expiresAtMono: number; version: bigint; id: string;
  /** Books (after the latency) whose ask reached the order's price; enough for the taker-side fill rules. */
  booksSeen: OrderBook[];
  /** Shares queued ahead at placement (bids at the order's price or better); undefined until the order is in the book. */
  queueAhead: number | undefined;
  filled: number;
}

export interface PaperLiveSummary {
  readonly orders: number; readonly fills: number; readonly partials: number; readonly noFills: number; readonly cancelled: number; readonly merges: number;
  readonly position: Position; readonly settled: boolean; readonly outcome?: "UP" | "DOWN"; readonly netPnl?: number;
}

export class PaperLiveEngine {
  private position: Position = EMPTY_POSITION;
  private readonly rand: () => number;
  private readonly pending: PendingMarketable[] = [];
  private readonly resting: Resting[] = [];
  private readonly merges: MergeResult[] = [];
  private readonly latest = new Map<string, OrderBook>();
  private fillFees = 0;
  private seq = 0;
  private counts = { orders: 0, fills: 0, partials: 0, noFills: 0, cancelled: 0 };
  private settled: { outcome: "UP" | "DOWN"; netPnl: number } | undefined;
  private killed = false;

  constructor(private readonly o: PaperLiveOptions) {
    this.rand = seededRandom(o.seed);
  }

  private orderId(): string { return `paperlive-${this.o.market.marketId}-${++this.seq}`; }

  private record(order: OrderIntent, decisionId: string, version: bigint, status: string): string {
    const id = this.orderId();
    const now = this.o.wall();
    this.o.db.run(`INSERT INTO orders (order_id, decision_id, state_version, market_id, mode, side, asset_id, order_type, price, size, status, created_ms, updated_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, decisionId, version.toString(), this.o.market.marketId, "paper", order.side, order.assetId, order.style.type, order.price, order.size, status, now, now]);
    this.counts.orders++;
    return id;
  }

  private applyFillResult(id: string, decisionId: string, order: OrderIntent, r: FillResult, version: bigint): void {
    const now = this.o.wall();
    this.o.db.run(`UPDATE orders SET status = ?, updated_ms = ? WHERE order_id = ?`, [r.status, now, id]);
    this.o.log("paper fill", { orderId: id, side: order.side, type: order.style.type, price: order.price, size: order.size, status: r.status, filled: r.filledQty, at: r.avgPrice, reason: r.reason });
    if (r.filledQty <= 0) { this.counts.noFills++; this.publish(); return; }
    this.o.db.run(`INSERT INTO fills (order_id, decision_id, state_version, market_id, mode, side, asset_id, price, size, fee, ts_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, decisionId, version.toString(), this.o.market.marketId, "paper", order.side, order.assetId, r.avgPrice, r.filledQty, r.fee, now]);
    this.position = applyFill(this.position, order.side, r.filledQty, r.avgPrice);
    this.fillFees += r.fee;
    if (r.status === "PARTIAL") this.counts.partials++; else this.counts.fills++;
    this.o.db.run(`INSERT INTO inventory_snapshots (market_id, mode, ts_ms, inventory_json) VALUES (?,?,?,?)`, [this.o.market.marketId, "paper", now, JSON.stringify(computeInventory(this.position))]);
    this.publish();
  }

  private publish(): void {
    this.o.onInventory(computeInventory(this.position), this.resting.length + this.pending.length);
  }

  /** Every book update from the observer: resolves pending marketables past their arrival time, tracks resting orders. */
  onBook(book: OrderBook, nowMono: number): void {
    this.latest.set(book.assetId, book);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (p.order.assetId !== book.assetId || nowMono < p.arriveAtMono) continue;
      this.pending.splice(i, 1);
      const id = this.record(p.order, p.decisionId, p.version, "SUBMITTED");
      this.applyFillResult(id, p.decisionId, p.order, fillMarketable(p.order, book, this.o.fill), p.version);
    }
    for (let i = this.resting.length - 1; i >= 0; i--) {
      const r = this.resting[i]!;
      if (r.order.assetId !== book.assetId || nowMono < r.placedAtMono + this.o.latencyMs) continue;
      if (r.queueAhead === undefined) r.queueAhead = queueAheadOf(r.order, book);
      const ask = book.asks[0]?.price;
      // Only books whose ask reached the price matter to the taker-side rules; keep those, bounded.
      if (ask !== undefined && ask <= r.order.price + 1e-12 && r.booksSeen.length < 64) r.booksSeen.push(book);
      // Resolve early when traded through; otherwise wait for TTL.
      if (ask !== undefined && ask < r.order.price - 1e-12) this.resolveResting(i, nowMono);
    }
  }

  /** A match printed on the market channel: taker sells at or through a resting bid's price work through its queue and then fill it. */
  onTrade(t: Trade, nowMono: number): void {
    if (t.side !== "SELL" || t.size <= 0) return;
    for (let i = this.resting.length - 1; i >= 0; i--) {
      const r = this.resting[i]!;
      if (r.order.assetId !== t.assetId || nowMono < r.placedAtMono + this.o.latencyMs) continue;
      if (r.queueAhead === undefined) {
        const book = this.latest.get(t.assetId);
        if (!book) continue; // not in the book yet as far as the model knows
        r.queueAhead = queueAheadOf(r.order, book);
      }
      // A sell above our price consumed bids that were ahead of us; one at or below our price reaches us once they are gone.
      const ahead = r.queueAhead;
      const consumed = Math.min(ahead, t.size);
      r.queueAhead = ahead - consumed;
      if (t.price > r.order.price + 1e-12) continue;
      const reaching = t.size - consumed;
      if (reaching <= 0) continue;
      const qty = Math.min(reaching, r.order.size - r.filled);
      if (qty <= 0) continue;
      r.filled += qty;
      const done = r.order.size - r.filled < 1e-9;
      if (done) this.resting.splice(i, 1);
      this.applyFillResult(r.id, r.decisionId, r.order, { status: done ? "FILLED" : "PARTIAL", filledQty: qty, avgPrice: r.order.price, fee: qty * this.o.fill.makerFee, reason: `maker fill: a taker sell of ${t.size} at ${t.price} reached the queue` }, r.version);
    }
  }

  /** Periodic: expire resting orders past their TTL. */
  tick(nowMono: number): void {
    for (let i = this.resting.length - 1; i >= 0; i--) if (nowMono >= this.resting[i]!.expiresAtMono) this.resolveResting(i, nowMono);
  }

  private resolveResting(i: number, _nowMono: number): void {
    const r = this.resting.splice(i, 1)[0]!;
    const remaining = r.order.size - r.filled;
    if (remaining <= 1e-9) return;
    const res = fillResting({ ...r.order, size: remaining }, r.booksSeen, this.o.fill, this.rand);
    if (res.filledQty <= 0 && r.filled > 0) {
      // Partly filled by the queue, the rest never reached: the order ends PARTIAL, not NO_FILL.
      this.o.db.run(`UPDATE orders SET status = 'PARTIAL', updated_ms = ? WHERE order_id = ?`, [this.o.wall(), r.id]);
      this.o.log("paper fill", { orderId: r.id, side: r.order.side, type: r.order.style.type, price: r.order.price, size: r.order.size, status: "PARTIAL", filled: r.filled, at: r.order.price, reason: res.reason });
      this.publish();
      return;
    }
    this.applyFillResult(r.id, r.decisionId, r.order, res, r.version);
  }

  cancelAll(reason: string): void {
    for (const r of this.resting.splice(0)) {
      this.o.db.run(`UPDATE orders SET status = 'CANCELLED', updated_ms = ? WHERE order_id = ?`, [this.o.wall(), r.id]);
      this.counts.cancelled++;
      this.o.log("paper cancel", { orderId: r.id, reason });
    }
    this.pending.splice(0);
    this.publish();
  }

  kill(): void { this.killed = true; this.cancelAll("kill switch"); }

  /** The switch cleared: accept decisions again. Cancelled orders stay cancelled. */
  resume(): void { this.killed = false; }

  /** An APPROVED decision with the snapshot it was checked against. */
  onApproved(d: Decision, snap: MarketState, decisionMono: number): void {
    if (this.killed || this.settled) return;
    const inv = computeInventory(this.position);
    if (d.requestedAction === "CANCEL") { this.cancelAll("jev CANCEL"); return; }
    const invAction = d.answers.inventory_action.choice;
    if (invAction === "MERGE" && inv.pairedShares > 0) {
      const m = simulateMerge(this.position, inv.pairedShares, 0);
      if (m) {
        this.merges.push(m); this.position = m.position;
        this.o.db.run(`INSERT INTO merges (market_id, mode, tx_hash, quantity, paired_cost_basis, collateral_returned, gas, effective_pair_pnl, ts_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
          [this.o.market.marketId, "paper", null, m.quantity, m.pairedCostBasis, m.collateralReturned, m.gas, m.effectivePairPnl, this.o.wall()]);
        this.o.log("paper merge", { quantity: m.quantity, pairPnl: m.effectivePairPnl });
        this.publish();
      }
    }
    const exposure = computeInventory(this.position).totalCost;
    const allowance = Math.max(0, Math.min(this.o.limits.maxMarketExposureUsd - exposure, this.o.limits.maxTotalExposureUsd - exposure));
    const intents = buildOrders(d.requestedAction, d.answers.execution_urgency.choice as Urgency, snap, {
      maxOrderSizeShares: this.o.limits.maxOrderSizeShares, riskAllowanceUsd: allowance, tickSize: this.o.market.tickSize ?? 0.001, minOrderSize: this.o.market.minOrderSize ?? 5,
    });
    for (const order of intents) {
      const bookAtBuild = order.side === "UP" ? snap.upBook : snap.downBook;
      if (bookAtBuild && isMarketable(order, bookAtBuild)) {
        this.pending.push({ order, decisionId: d.decisionId, arriveAtMono: decisionMono + this.o.latencyMs, version: d.stateVersion });
      } else {
        const id = this.record(order, d.decisionId, d.stateVersion, "RESTING");
        // A hedge keeps its place in the queue until the close; anything else lives for its TTL.
        const ttl = order.completesSet ? Math.max(order.style.ttlMs ?? 20_000, this.o.market.closesAtMs - this.o.wall()) : (order.style.ttlMs ?? 20_000);
        this.resting.push({ order, decisionId: d.decisionId, placedAtMono: decisionMono, expiresAtMono: decisionMono + ttl, booksSeen: [], version: d.stateVersion, id, queueAhead: undefined, filled: 0 });
      }
    }
    this.publish();
  }

  /** Market over: resolve leftovers on the last books, settle at the real outcome. */
  settleAt(outcome: "UP" | "DOWN", nowMono: number): PaperLiveSummary {
    if (this.settled) return this.summary();
    for (const p of this.pending.splice(0)) {
      const book = this.latest.get(p.order.assetId);
      const id = this.record(p.order, p.decisionId, p.version, "SUBMITTED");
      this.applyFillResult(id, p.decisionId, p.order, book ? fillMarketable(p.order, book, this.o.fill) : { status: "NO_FILL", filledQty: 0, avgPrice: 0, fee: 0, reason: "no book" }, p.version);
    }
    while (this.resting.length) this.resolveResting(0, nowMono);
    const s = settle(this.position, outcome);
    const pnl = marketPnl(this.merges, s, this.fillFees);
    const now = this.o.wall();
    this.o.db.run(`INSERT INTO redemptions (market_id, mode, tx_hash, gross_payout, cost_basis, fees_gas, net_pnl, ts_ms) VALUES (?,?,?,?,?,?,?,?)`,
      [this.o.market.marketId, "paper", null, s.grossPayout, s.costBasis, s.feesGas + this.fillFees, pnl.netPnl, now]);
    this.o.db.run(`INSERT INTO pnl_snapshots (market_id, mode, ts_ms, pnl_json) VALUES (?,?,?,?)`, [this.o.market.marketId, "paper", now, JSON.stringify(pnl)]);
    this.settled = { outcome, netPnl: pnl.netPnl };
    this.o.log("paper settled", { outcome, netPnl: Number(pnl.netPnl.toFixed(4)), position: this.position, orders: this.counts.orders, fills: this.counts.fills + this.counts.partials });
    return this.summary();
  }

  summary(): PaperLiveSummary {
    return { ...this.counts, merges: this.merges.length, position: this.position, settled: !!this.settled, ...(this.settled ? { outcome: this.settled.outcome, netPnl: this.settled.netPnl } : {}) };
  }
}

/** Shares queued ahead of a new bid: every bid at its price or better already in the book (price-time priority). */
export function queueAheadOf(order: OrderIntent, book: OrderBook): number {
  return book.bids.filter((l) => l.price >= order.price - 1e-12).reduce((s, l) => s + l.size, 0);
}
