import type { Db } from "../persistence/database.js";
import type { MarketIdentity, MarketState } from "../market/market-state.js";
import { applyFill, applyMerge, computeInventory, EMPTY_POSITION, type InventoryAccounting, type Position } from "../inventory/accounting.js";
import { marketPnl, settle, simulateMerge, type MergeResult } from "../inventory/settlement.js";
import type { Decision } from "../jev/decision-engine.js";
import type { Urgency } from "../jev/decision-types.js";
import { buildOrders, type OrderIntent } from "./order-builder.js";
import type { SignedOrderLike } from "./shadow-engine.js";
import type { RiskLimits } from "../risk/limits.js";
import { breakdown } from "../analytics/latency.js";

/**
 * Phase 5, limited live (brief §40): real orders through the Polymarket SDK.
 *
 * The client surface below is exactly what this engine needs and was
 * verified against @polymarket/client 0.10.0 type declarations:
 *   createLimitOrder / createMarketOrder -> SignedOrder (sign only)
 *   postOrder(SignedOrder) -> { ok: true, orderId, status: live|matched|delayed, makingAmount, takingAmount }
 *                           | { ok: false, code, message }
 *   fetchOrder({ orderId }) -> OpenOrder { sizeMatched, originalSize, price, status }
 *   cancelOrders({ orderIds }) -> { canceled, not_canceled }
 *   mergePositions({ conditionId, amount: 'max' }) / redeemPositions({ conditionId }) -> TransactionHandle (gasless relayer)
 *   listPositions({ conditionId }).firstPage().items -> Position { assetId, currentSize, redeemable }
 *
 * Everything that reaches the exchange goes through here, and every order
 * and fill is written with the decision that produced it. Nothing is
 * retried silently: a rejected post is a recorded REJECTED order.
 */
export interface PostAccepted { readonly ok: true; readonly orderId: string; readonly status: string; readonly makingAmount: string; readonly takingAmount: string }
export interface PostRejected { readonly ok: false; readonly code: string; readonly message: string }
export interface OpenOrderLike { readonly id: string; readonly price: string; readonly originalSize: string; readonly sizeMatched: string; readonly status: string }
export interface TxHandleLike { readonly transactionHash: string | null; wait(): Promise<{ transactionHash: string }> }
export interface PositionLike { readonly assetId: string; readonly currentSize: string; readonly redeemable: boolean }

export interface LiveClientLike {
  createLimitOrder(req: { assetId: string; price: number; size: number; side: "BUY"; postOnly?: boolean }): Promise<SignedOrderLike>;
  createMarketOrder(req: { assetId: string; amount: number; maxSpend: number; maxPrice: number; side: "BUY"; orderType: "FAK" | "FOK" }): Promise<SignedOrderLike>;
  postOrder(order: SignedOrderLike): Promise<PostAccepted | PostRejected>;
  fetchOrder(req: { orderId: string }): Promise<OpenOrderLike>;
  cancelOrders(req: { orderIds: string[] }): Promise<{ canceled: string[]; not_canceled: Record<string, string> }>;
  mergePositions(req: { conditionId: string; amount: bigint | "max" }): Promise<TxHandleLike>;
  redeemPositions(req: { conditionId: string }): Promise<TxHandleLike>;
  listPositions(req: { conditionId: string }): { firstPage(): Promise<{ items: readonly PositionLike[] }> };
}

export interface LiveEngineOptions {
  readonly market: MarketIdentity;
  readonly limits: RiskLimits;
  readonly client: LiveClientLike;
  readonly mono: () => number;
  readonly wall: () => number;
  readonly db: Db;
  readonly onInventory: (inv: InventoryAccounting, openOrders: number) => void;
  /** A rejected post or a failed exchange call; the caller counts these for the kill switch. */
  readonly onApiError: (what: string, err: unknown) => void;
  readonly log: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
  /** Poll interval for resting orders. Default 1000 ms. */
  readonly pollMs?: number;
  /** Fewer paired shares than this are not worth a merge transaction. Default 1. */
  readonly minMergeShares?: number;
}

interface Tracked { readonly orderId: string; readonly intent: OrderIntent; readonly decisionId: string; readonly version: bigint; readonly placedMono: number; readonly expiresMono: number; matched: number; lastPollMono: number }

export interface LiveSummary {
  readonly orders: number; readonly rejected: number; readonly fills: number; readonly cancelled: number; readonly merges: number;
  readonly position: Position; readonly openOrders: number; readonly settled: boolean; readonly netPnl?: number;
}

export class LiveEngine {
  private position: Position = EMPTY_POSITION;
  private readonly open = new Map<string, Tracked>();
  private readonly merges: MergeResult[] = [];
  private fillFees = 0;
  private counts = { orders: 0, rejected: 0, fills: 0, cancelled: 0 };
  private settled: { outcome: "UP" | "DOWN"; netPnl: number } | undefined;
  private killed = false;
  private busy = Promise.resolve();

  constructor(private readonly o: LiveEngineOptions) {}

  private get mode() { return "live" as const; }

  /** Exchange calls for one market are serialised so a cancel never races a post. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.then(() => undefined, () => undefined);
    return run;
  }

  private publish(): void { this.o.onInventory(computeInventory(this.position), this.open.size); }

  private recordFill(orderId: string, decisionId: string, version: bigint, intent: OrderIntent, qty: number, price: number, fee: number): void {
    if (!(qty > 0)) return;
    const now = this.o.wall();
    this.o.db.run(`INSERT INTO fills (order_id, decision_id, state_version, market_id, mode, side, asset_id, price, size, fee, ts_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [orderId, decisionId, version.toString(), this.o.market.marketId, this.mode, intent.side, intent.assetId, price, qty, fee, now]);
    this.position = applyFill(this.position, intent.side, qty, price);
    this.fillFees += fee;
    this.counts.fills++;
    this.o.db.run(`INSERT INTO inventory_snapshots (market_id, mode, ts_ms, inventory_json) VALUES (?,?,?,?)`, [this.o.market.marketId, this.mode, now, JSON.stringify(computeInventory(this.position))]);
    this.o.log("info", "live fill", { orderId, side: intent.side, qty, price, position: this.position });
    this.publish();
  }

  private setStatus(orderId: string, status: string): void {
    this.o.db.run(`UPDATE orders SET status = ?, updated_ms = ? WHERE order_id = ?`, [status, this.o.wall(), orderId]);
  }

  /** An APPROVED decision. Signs, posts, records; never throws. */
  async onApproved(d: Decision, snap: MarketState, decisionMono: number): Promise<void> {
    if (this.killed || this.settled) return;
    if (d.requestedAction === "CANCEL") { await this.cancelAll("jev CANCEL"); return; }
    if (d.answers.inventory_action.choice === "MERGE") await this.merge();
    const exposure = computeInventory(this.position).totalCost;
    const allowance = Math.max(0, Math.min(this.o.limits.maxMarketExposureUsd - exposure, this.o.limits.maxTotalExposureUsd - exposure));
    const intents = buildOrders(d.requestedAction, d.answers.execution_urgency.choice as Urgency, snap, {
      maxOrderSizeShares: this.o.limits.maxOrderSizeShares, riskAllowanceUsd: allowance, tickSize: this.o.market.tickSize ?? 0.001, minOrderSize: this.o.market.minOrderSize ?? 5,
    });
    for (const intent of intents) await this.serial(() => this.place(intent, d, decisionMono));
  }

  private async place(intent: OrderIntent, d: Decision, decisionMono: number): Promise<void> {
    if (this.killed) return;
    const localId = `live-${this.o.market.marketId}-${d.decisionId}-${intent.side}`;
    const now = this.o.wall();
    this.o.db.run(`INSERT INTO orders (order_id, decision_id, state_version, market_id, mode, side, asset_id, order_type, price, size, status, created_ms, updated_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [localId, d.decisionId, d.stateVersion.toString(), this.o.market.marketId, this.mode, intent.side, intent.assetId, intent.style.type, intent.price, intent.size, "SIGNING", now, now]);
    this.counts.orders++;
    const signingStarted = this.o.mono();
    let signed: SignedOrderLike;
    try {
      signed = intent.style.type === "FAK" || intent.style.type === "FOK"
        ? await this.o.client.createMarketOrder({ assetId: intent.assetId, amount: Number((intent.price * intent.size).toFixed(6)), maxSpend: Number((intent.price * intent.size).toFixed(6)), maxPrice: intent.price, side: "BUY", orderType: intent.style.type })
        : await this.o.client.createLimitOrder({ assetId: intent.assetId, price: intent.price, size: intent.size, side: "BUY", ...(intent.style.postOnly ? { postOnly: true } : {}) });
    } catch (err) {
      this.setStatus(localId, "SIGN_FAILED");
      this.o.log("error", "signing failed", { err });
      this.o.onApiError("sign", err);
      return;
    }
    const signingCompleted = this.o.mono();
    if (this.killed) { this.setStatus(localId, "CANCELLED"); return; } // tripped while signing: never post
    const submitted = this.o.mono();
    let res: PostAccepted | PostRejected;
    try {
      res = await this.o.client.postOrder(signed);
    } catch (err) {
      this.setStatus(localId, "POST_FAILED");
      this.o.log("error", "post failed", { err });
      this.o.onApiError("post", err);
      return;
    }
    const ack = this.o.mono();
    this.o.db.run(`INSERT INTO latency_measurements (decision_id, market_id, ts_ms, feed_to_state_ms, state_to_jev_ms, jev_ms, jev_to_submit_ms, submit_to_ack_ms, feed_to_ack_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
      (() => { const b = breakdown({ packetReceived: d.packetReceivedMono, stateUpdated: d.stateUpdatedMono, jevRequestStarted: d.requestedAtMono, jevResponseReceived: d.respondedAtMono, decisionValidated: decisionMono, signingStarted, signingCompleted, orderSubmitted: submitted, ack });
        return [d.decisionId, this.o.market.marketId, this.o.wall(), b.feed_to_state_ms ?? null, b.state_to_jev_ms ?? null, b.jev_ms ?? null, b.jev_to_submit_ms ?? null, b.submit_to_ack_ms ?? null, b.feed_to_ack_ms ?? null]; })());
    if (!res.ok) {
      this.counts.rejected++;
      this.setStatus(localId, `REJECTED:${res.code}`);
      this.o.log("warn", "order rejected by the exchange", { code: res.code, message: res.message, side: intent.side, type: intent.style.type, price: intent.price, size: intent.size });
      // Not filling is the market's answer, not an API failure; anything else counts.
      if (!["fok_not_filled", "fak_not_filled", "unmatched", "post_only_would_cross"].includes(res.code)) this.o.onApiError("post-rejected", res);
      return;
    }
    // Keep the exchange's id as the order id so fills and cancels line up.
    this.o.db.run(`UPDATE orders SET order_id = ?, status = ?, updated_ms = ? WHERE order_id = ?`, [res.orderId, res.status.toUpperCase(), this.o.wall(), localId]);
    const making = Number(res.makingAmount), taking = Number(res.takingAmount);
    // BUY: maker amount is collateral paid, taker amount is shares received.
    const filledShares = taking > 0 ? taking : 0;
    const avgPrice = filledShares > 0 ? making / filledShares : intent.price;
    if (intent.style.type === "FAK" || intent.style.type === "FOK") {
      this.setStatus(res.orderId, filledShares <= 0 ? "NO_FILL" : filledShares + 1e-9 < intent.size ? "PARTIAL" : "FILLED");
      this.recordFill(res.orderId, d.decisionId, d.stateVersion, intent, filledShares, avgPrice, 0);
      return;
    }
    // Resting (GTC): whatever matched at placement is a fill; the rest is tracked until filled, expired or cancelled.
    this.recordFill(res.orderId, d.decisionId, d.stateVersion, intent, filledShares, avgPrice, 0);
    if (filledShares + 1e-9 >= intent.size) { this.setStatus(res.orderId, "FILLED"); return; }
    this.setStatus(res.orderId, "RESTING");
    this.open.set(res.orderId, { orderId: res.orderId, intent, decisionId: d.decisionId, version: d.stateVersion, placedMono: this.o.mono(), expiresMono: this.o.mono() + (intent.style.ttlMs ?? 20_000), matched: filledShares, lastPollMono: this.o.mono() });
    this.publish();
  }

  /** Periodic: poll resting orders for fills, expire them past their TTL. */
  async tick(nowMono: number): Promise<void> {
    if (this.open.size === 0) return;
    await this.serial(async () => {
      const expired: string[] = [];
      for (const t of this.open.values()) {
        if (nowMono >= t.expiresMono) { expired.push(t.orderId); continue; }
        if (nowMono - t.lastPollMono < (this.o.pollMs ?? 1_000)) continue;
        t.lastPollMono = nowMono;
        try {
          const o = await this.o.client.fetchOrder({ orderId: t.orderId });
          const matched = Number(o.sizeMatched);
          if (matched > t.matched + 1e-9) { this.recordFill(t.orderId, t.decisionId, t.version, t.intent, matched - t.matched, Number(o.price) || t.intent.price, 0); t.matched = matched; }
          const st = o.status.toUpperCase();
          if (matched + 1e-9 >= Number(o.originalSize) || st === "MATCHED") { this.setStatus(t.orderId, "FILLED"); this.open.delete(t.orderId); this.publish(); }
          else if (st === "CANCELED" || st === "CANCELLED" || st === "EXPIRED") { this.setStatus(t.orderId, t.matched > 0 ? "PARTIAL" : "CANCELLED"); this.open.delete(t.orderId); this.publish(); }
        } catch (err) {
          this.o.log("warn", "order poll failed", { orderId: t.orderId, err });
          this.o.onApiError("fetchOrder", err);
        }
      }
      if (expired.length) await this.cancelIds(expired, "ttl");
    });
  }

  private async cancelIds(ids: string[], reason: string): Promise<void> {
    if (ids.length === 0) return;
    try {
      const r = await this.o.client.cancelOrders({ orderIds: ids });
      for (const id of r.canceled) { const t = this.open.get(id); this.setStatus(id, t && t.matched > 0 ? "PARTIAL" : "CANCELLED"); this.open.delete(id); this.counts.cancelled++; }
      for (const [id, why] of Object.entries(r.not_canceled)) {
        // Usually already filled or gone: one more poll settles it either way.
        this.o.log("warn", "cancel refused", { orderId: id, why, reason });
        const t = this.open.get(id);
        if (t) t.lastPollMono = Number.NEGATIVE_INFINITY;
      }
      this.o.log("info", "orders cancelled", { canceled: r.canceled.length, refused: Object.keys(r.not_canceled).length, reason });
    } catch (err) {
      this.o.log("error", "cancel failed", { ids, err });
      this.o.onApiError("cancel", err);
    }
    this.publish();
  }

  cancelAll(reason: string): Promise<void> { return this.serial(() => this.cancelIds([...this.open.keys()], reason)); }

  /** Kill switch: cancel everything resting, accept nothing new. Never sells. */
  async kill(): Promise<void> { this.killed = true; await this.cancelAll("kill switch"); }
  resume(): void { this.killed = false; }

  /** Merge matched shares back into collateral (brief §20), min(up, down), through the relayer. */
  private async merge(): Promise<void> {
    const inv = computeInventory(this.position);
    if (inv.pairedShares < (this.o.minMergeShares ?? 1)) return;
    await this.serial(async () => {
      const paired = computeInventory(this.position).pairedShares;
      const expected = simulateMerge(this.position, paired, 0);
      if (!expected) return;
      try {
        const handle = await this.o.client.mergePositions({ conditionId: this.o.market.conditionId, amount: "max" });
        const outcome = await handle.wait();
        this.position = applyMerge(this.position, paired);
        this.merges.push(expected);
        this.o.db.run(`INSERT INTO merges (market_id, mode, tx_hash, quantity, paired_cost_basis, collateral_returned, gas, effective_pair_pnl, ts_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
          [this.o.market.marketId, this.mode, outcome.transactionHash, expected.quantity, expected.pairedCostBasis, expected.collateralReturned, 0, expected.effectivePairPnl, this.o.wall()]);
        this.o.log("info", "merged", { quantity: expected.quantity, tx: outcome.transactionHash, pairPnl: expected.effectivePairPnl });
        this.publish();
      } catch (err) {
        this.o.log("error", "merge failed", { err });
        this.o.onApiError("merge", err);
      }
    });
  }

  /** Compare the book-kept position with the exchange's view; a mismatch is a hard fault for the caller. */
  async reconcile(): Promise<{ ok: boolean; detail: string }> {
    try {
      const page = await this.o.client.listPositions({ conditionId: this.o.market.conditionId }).firstPage();
      const size = (asset: string) => page.items.filter((p) => p.assetId === asset).reduce((s, p) => s + Number(p.currentSize), 0);
      const up = size(this.o.market.upAssetId), down = size(this.o.market.downAssetId);
      const dUp = Math.abs(up - this.position.upShares), dDown = Math.abs(down - this.position.downShares);
      const ok = dUp < 0.01 && dDown < 0.01;
      const detail = `exchange UP ${up} / DOWN ${down}, books UP ${this.position.upShares} / DOWN ${this.position.downShares}`;
      if (!ok) this.o.log("error", "inventory mismatch", { detail });
      return { ok, detail };
    } catch (err) {
      this.o.onApiError("listPositions", err);
      return { ok: true, detail: `reconciliation unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** After the official resolution: redeem the winning shares (brief §21) and book the market's PnL. */
  async redeem(outcome: "UP" | "DOWN"): Promise<LiveSummary> {
    if (this.settled) return this.summary();
    await this.cancelAll("market over");
    const s = settle(this.position, outcome);
    let tx: string | null = null;
    if (s.winningShares > 0) {
      try {
        const handle = await this.o.client.redeemPositions({ conditionId: this.o.market.conditionId });
        tx = (await handle.wait()).transactionHash;
      } catch (err) {
        this.o.log("error", "redeem failed; position left for the next sweep", { err });
        this.o.onApiError("redeem", err);
        return this.summary();
      }
    }
    const pnl = marketPnl(this.merges, s, this.fillFees);
    const now = this.o.wall();
    this.o.db.run(`INSERT INTO redemptions (market_id, mode, tx_hash, gross_payout, cost_basis, fees_gas, net_pnl, ts_ms) VALUES (?,?,?,?,?,?,?,?)`,
      [this.o.market.marketId, this.mode, tx, s.grossPayout, s.costBasis, s.feesGas + this.fillFees, pnl.netPnl, now]);
    this.o.db.run(`INSERT INTO pnl_snapshots (market_id, mode, ts_ms, pnl_json) VALUES (?,?,?,?)`, [this.o.market.marketId, this.mode, now, JSON.stringify(pnl)]);
    this.settled = { outcome, netPnl: pnl.netPnl };
    this.o.log("info", "live market settled", { outcome, netPnl: Number(pnl.netPnl.toFixed(4)), tx, position: this.position });
    return this.summary();
  }

  hasPosition(): boolean { return this.position.upShares > 0 || this.position.downShares > 0; }
  isSettled(): boolean { return !!this.settled; }

  summary(): LiveSummary {
    return { ...this.counts, merges: this.merges.length, position: this.position, openOrders: this.open.size, settled: !!this.settled, ...(this.settled ? { netPnl: this.settled.netPnl } : {}) };
  }
}
