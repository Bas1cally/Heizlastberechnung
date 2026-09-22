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
 * channel: the order joins the queue behind every bid at its price or
 * better in the book the decision was made on (price-time priority; bids
 * that appear during our latency are behind us, and the 0.99 level fills
 * with thousands of shares within a second of opening, so counting the
 * first post-latency book put us behind bids that came after ours: 22
 * markets, 2 fills, while the reference trader filled 1,000 shares from
 * the same sells); each taker sell at or through its price consumes that
 * queue first, whatever is left fills the order. This is
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

interface PendingMarketable { order: OrderIntent; decisionId: string; arriveAtMono: number; version: bigint; pairOnFill: boolean; /** The hedge already resting for this tail, placed in the same instant; reconciled when the tail's fill is known. */ hedgeId?: string }
interface Resting {
  order: OrderIntent; decisionId: string; placedAtMono: number; expiresAtMono: number; version: bigint; id: string;
  /** The decision said PAIR: the moment this fills, the hedge for the filled shares is placed, without waiting for another decision. */
  pairOnFill: boolean;
  /** Books (after the latency) whose ask reached the order's price; enough for the taker-side fill rules. */
  booksSeen: OrderBook[];
  /** Shares queued ahead: bids at the order's price or better in the book the decision was made on; undefined only when that book was missing. */
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

  private applyFillResult(id: string, decisionId: string, order: OrderIntent, r: FillResult, version: bigint, pairOnFill = false, hedgeId?: string): void {
    const now = this.o.wall();
    if (hedgeId !== undefined) this.reconcileHedge(hedgeId, r.filledQty);
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
    if (pairOnFill && !order.completesSet && hedgeId === undefined) this.hedgeNow(order, r, decisionId, version);
  }

  /**
   * The hedge went out with the tail, sized for the tail's full size; now
   * the tail's fill is known. Nothing filled: the hedge is withdrawn. A
   * partial: the hedge shrinks to the filled shares (queue position kept).
   */
  private reconcileHedge(hedgeId: string, tailFilled: number): void {
    const i = this.resting.findIndex((r) => r.id === hedgeId);
    if (i < 0) return;
    const r = this.resting[i]!;
    const keep = Math.floor(tailFilled);
    if (keep >= r.order.size) return;
    if (keep - r.filled < (this.o.market.minOrderSize ?? 5) || keep <= 0) {
      this.resting.splice(i, 1);
      this.o.db.run(`UPDATE orders SET status = 'CANCELLED', updated_ms = ? WHERE order_id = ?`, [this.o.wall(), r.id]);
      this.counts.cancelled++;
      this.o.log("paper cancel", { orderId: r.id, reason: `tail filled ${tailFilled}: hedge withdrawn` });
    } else {
      this.resting[i] = { ...r, order: { ...r.order, size: keep } };
      this.o.db.run(`UPDATE orders SET size = ?, updated_ms = ? WHERE order_id = ?`, [keep, this.o.wall(), r.id]);
      this.o.log("paper resize", { orderId: r.id, size: keep, reason: `tail filled ${tailFilled}` });
    }
    this.publish();
  }

  /**
   * The hedge for a tail that is about to be taken, placed in the same
   * instant as the tail: a bid for the other side at 1.00 minus the tail's
   * touch, resting from the decision's book (the queue as it was when we
   * decided). Waiting for the tail's fill cost ~700 ms, and the 0.99 level
   * held 1,600 shares by then (measured 22 Sep, 06:19Z). Returns the order
   * id, or undefined when nothing could be placed.
   */
  private hedgeWithTail(tail: OrderIntent, touch: number, snap: MarketState, decisionId: string, version: bigint, decisionMono: number): string | undefined {
    const side = tail.side === "UP" ? "DOWN" : "UP";
    const assetId = side === "UP" ? this.o.market.upAssetId : this.o.market.downAssetId;
    const tick = this.o.market.tickSize ?? 0.001;
    const cap = Math.floor((1 - touch) / tick + 1e-9) * tick;
    if (cap < tick) return undefined;
    const price = Number(cap.toFixed(4));
    const open = [...this.pending.map((p) => p.order), ...this.resting.map((x) => x.order)].filter((o) => o.assetId === assetId && o.completesSet).reduce((s, o) => s + o.size, 0)
      - this.resting.filter((x) => x.order.assetId === assetId && x.order.completesSet).reduce((s, x) => s + x.filled, 0);
    const size = Math.floor(tail.size - Math.max(0, open));
    if (size < (this.o.market.minOrderSize ?? 5)) return undefined;
    const book = side === "UP" ? snap.upBook : snap.downBook;
    const ask = book?.asks[0]?.price;
    if (ask !== undefined && ask <= price + 1e-12) {
      // Offered under the cap right now: take it at arrival, like the tail.
      const order: OrderIntent = { side, assetId, price, size, style: { type: "FOK", aggressionTicks: 0, ttlMs: 20_000 }, sizedBy: "complement", completesSet: true };
      this.pending.push({ order, decisionId, arriveAtMono: decisionMono + this.o.latencyMs, version, pairOnFill: false });
      this.o.log("paper hedge now", { side, price, size, reason: "offered under the cap, with the tail" });
      return undefined;
    }
    const order: OrderIntent = { side, assetId, price, size, style: { type: "GTC", aggressionTicks: 0, ttlMs: 20_000 }, sizedBy: "complement", completesSet: true };
    const id = this.record(order, decisionId, version, "RESTING");
    const ttl = Math.max(20_000, this.o.market.closesAtMs - this.o.wall());
    const queueAhead = book ? queueAheadOf(order, book) : undefined;
    this.o.log("paper rest", { orderId: id, side, price, size, queueAhead, ttlMs: ttl, reason: "hedge with the tail" });
    this.resting.push({ order, decisionId, placedAtMono: decisionMono, expiresAtMono: decisionMono + ttl, booksSeen: [], version, id, queueAhead, filled: 0, pairOnFill: false });
    return id;
  }

  /**
   * The hedge for a just-filled tail, placed in the same instant: a bid for
   * the other side at 1.00 minus the fill price for the filled shares, taken
   * at once when that side is offered under the cap, resting until the
   * close otherwise. Measured 2026-09-22: by the time the next decision
   * placed the hedge, 10-25k shares were queued ahead at 0.99 (the level
   * opens and fills within seconds of the ask emptying); the reference
   * trader hedged 11 of 16 markets, the copy 2.
   */
  private hedgeNow(tail: OrderIntent, r: FillResult, decisionId: string, version: bigint): void {
    if (this.killed || this.settled) return;
    const side = tail.side === "UP" ? "DOWN" : "UP";
    const assetId = side === "UP" ? this.o.market.upAssetId : this.o.market.downAssetId;
    const tick = this.o.market.tickSize ?? 0.001;
    const cap = Math.floor((1 - r.avgPrice) / tick + 1e-9) * tick;
    if (cap < tick) return;
    const price = Number(cap.toFixed(4));
    const open = [...this.pending.map((p) => p.order), ...this.resting.map((x) => x.order)].filter((o) => o.assetId === assetId && o.completesSet).reduce((s, o) => s + o.size, 0)
      - this.resting.filter((x) => x.order.assetId === assetId && x.order.completesSet).reduce((s, x) => s + x.filled, 0);
    const size = Math.floor(r.filledQty - Math.max(0, open));
    if (size < (this.o.market.minOrderSize ?? 5)) return;
    const book = this.latest.get(assetId);
    const ask = book?.asks[0]?.price;
    const nowMono = this.o.mono();
    if (ask !== undefined && ask <= price + 1e-12) {
      const order: OrderIntent = { side, assetId, price, size, style: { type: "FOK", aggressionTicks: 0, ttlMs: 20_000 }, sizedBy: "complement", completesSet: true };
      this.pending.push({ order, decisionId, arriveAtMono: nowMono + this.o.latencyMs, version, pairOnFill: false });
      this.o.log("paper hedge now", { side, price, size, reason: "offered under the cap" });
    } else {
      const order: OrderIntent = { side, assetId, price, size, style: { type: "GTC", aggressionTicks: 0, ttlMs: 20_000 }, sizedBy: "complement", completesSet: true };
      const id = this.record(order, decisionId, version, "RESTING");
      const ttl = Math.max(20_000, this.o.market.closesAtMs - this.o.wall());
      const queueAhead = book ? queueAheadOf(order, book) : undefined;
      this.o.log("paper rest", { orderId: id, side, price, size, queueAhead, ttlMs: ttl, reason: "hedge on tail fill" });
      this.resting.push({ order, decisionId, placedAtMono: nowMono, expiresAtMono: nowMono + ttl, booksSeen: [], version, id, queueAhead, filled: 0, pairOnFill: false });
    }
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
      this.applyFillResult(id, p.decisionId, p.order, fillMarketable(p.order, book, this.o.fill), p.version, p.pairOnFill, p.hedgeId);
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

  /**
   * A match printed on the market channel. Two kinds of flow reach a
   * resting bid at p: taker SELLS of the same token at or through p, and
   * taker BUYS of the complementary token at 1 - p or better - Polymarket's
   * CLOB matches a bid for DOWN at 0.99 against a bid for UP at 0.01 by
   * minting the set. Measured over 20 markets: the complementary flow was
   * 2.2x the same-side sells, and the reference trader's 0.99 hedges were
   * filled mostly by tail buyers, not by sellers.
   */
  onTrade(t: Trade, nowMono: number): void {
    if (t.size <= 0) return;
    const otherOf = (asset: string) => asset === this.o.market.upAssetId ? this.o.market.downAssetId : asset === this.o.market.downAssetId ? this.o.market.upAssetId : undefined;
    for (let i = this.resting.length - 1; i >= 0; i--) {
      const r = this.resting[i]!;
      if (nowMono < r.placedAtMono + this.o.latencyMs) continue;
      // The trade expressed on our token: a sell of ours at q, or a buy of the other token at 1 - q.
      let q: number;
      if (t.assetId === r.order.assetId && t.side === "SELL") q = t.price;
      else if (t.assetId === otherOf(r.order.assetId) && t.side === "BUY") q = 1 - t.price;
      else continue;
      if (r.queueAhead === undefined) {
        const book = this.latest.get(r.order.assetId);
        if (!book) continue; // not in the book yet as far as the model knows
        r.queueAhead = queueAheadOf(r.order, book);
      }
      // Flow above our price consumed bids that were ahead of us; flow at or below our price reaches us once they are gone.
      const ahead = r.queueAhead;
      const consumed = Math.min(ahead, t.size);
      r.queueAhead = ahead - consumed;
      if (q > r.order.price + 1e-12) continue;
      const reaching = t.size - consumed;
      if (reaching <= 0) continue;
      const qty = Math.min(reaching, r.order.size - r.filled);
      if (qty <= 0) continue;
      r.filled += qty;
      const done = r.order.size - r.filled < 1e-9;
      if (done) this.resting.splice(i, 1);
      this.applyFillResult(r.id, r.decisionId, r.order, { status: done ? "FILLED" : "PARTIAL", filledQty: qty, avgPrice: r.order.price, fee: qty * this.o.fill.makerFee, reason: `maker fill: a taker ${t.side === "SELL" ? "sell" : "buy of the other side"} of ${t.size} at ${t.price} reached the queue` }, r.version, r.pairOnFill);
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
    this.applyFillResult(r.id, r.decisionId, r.order, res, r.version, r.pairOnFill);
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
    // Sizing uses the position as it is NOW, not the snapshot's copy: a
    // decision made while the previous hedge was in flight would otherwise
    // hedge the same tail again (observed: four 0.59 hedges for one 0.41
    // tail, 300 shares of directional exposure, -177 USD).
    const live = computeInventory(this.position);
    const exposure = live.totalCost;
    const allowance = Math.max(0, Math.min(this.o.limits.maxMarketExposureUsd - exposure, this.o.limits.maxTotalExposureUsd - exposure));
    const intents = buildOrders(d.requestedAction, d.answers.execution_urgency.choice as Urgency, { ...snap, inventory: live }, {
      maxOrderSizeShares: this.o.limits.maxOrderSizeShares, riskAllowanceUsd: allowance, tickSize: this.o.market.tickSize ?? 0.001, minOrderSize: this.o.market.minOrderSize ?? 5,
    });
    const pairOnFill = d.answers.inventory_action.choice === "PAIR";
    for (const intent of intents) {
      let order = intent;
      if (order.completesSet) {
        // Whatever is already in flight or resting for this side counts as hedged.
        const open = [...this.pending.map((p) => p.order), ...this.resting.map((r) => r.order)].filter((o) => o.assetId === order.assetId && o.completesSet).reduce((s, o) => s + o.size, 0)
          + this.resting.filter((r) => r.order.assetId === order.assetId && r.order.completesSet).reduce((s, r) => s - r.filled, 0);
        const size = Math.floor(order.size - open);
        if (size < (this.o.market.minOrderSize ?? 5)) { this.o.log("paper skip", { side: order.side, reason: "hedge already in flight or resting", open }); continue; }
        order = { ...order, size };
      }
      const bookAtBuild = order.side === "UP" ? snap.upBook : snap.downBook;
      if (bookAtBuild && isMarketable(order, bookAtBuild)) {
        const tailToPair = pairOnFill && !order.completesSet;
        const touch = bookAtBuild.asks[0]?.price;
        const hedgeId = tailToPair && touch !== undefined ? this.hedgeWithTail(order, touch, snap, d.decisionId, d.stateVersion, decisionMono) : undefined;
        this.pending.push({ order, decisionId: d.decisionId, arriveAtMono: decisionMono + this.o.latencyMs, version: d.stateVersion, pairOnFill: tailToPair, ...(hedgeId !== undefined ? { hedgeId } : {}) });
      } else {
        const id = this.record(order, d.decisionId, d.stateVersion, "RESTING");
        // A hedge keeps its place in the queue until the close; anything else lives for its TTL.
        const ttl = order.completesSet ? Math.max(order.style.ttlMs ?? 20_000, this.o.market.closesAtMs - this.o.wall()) : (order.style.ttlMs ?? 20_000);
        const bookAtDecision = order.side === "UP" ? snap.upBook : snap.downBook;
        const queueAhead = bookAtDecision ? queueAheadOf(order, bookAtDecision) : undefined;
        this.o.log("paper rest", { orderId: id, side: order.side, price: order.price, size: order.size, queueAhead, ttlMs: ttl });
        this.resting.push({ order, decisionId: d.decisionId, placedAtMono: decisionMono, expiresAtMono: decisionMono + ttl, booksSeen: [], version: d.stateVersion, id, queueAhead, filled: 0, pairOnFill: pairOnFill && !order.completesSet });
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
      this.applyFillResult(id, p.decisionId, p.order, book ? fillMarketable(p.order, book, this.o.fill) : { status: "NO_FILL", filledQty: 0, avgPrice: 0, fee: 0, reason: "no book" }, p.version, false, p.hedgeId);
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
