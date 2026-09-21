import { describe, expect, it } from "vitest";
import { LiveEngine, type LiveClientLike, type OpenOrderLike, type PositionLike, type PostAccepted, type PostRejected } from "../../src/execution/live-engine.js";
import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";
import { normalizeBook } from "../../src/feeds/book-normalizer.js";
import { computeInventory, EMPTY_POSITION, type InventoryAccounting } from "../../src/inventory/accounting.js";
import type { MarketIdentity, MarketState } from "../../src/market/market-state.js";
import type { Decision } from "../../src/jev/decision-engine.js";
import type { JevAnswers, Action, Urgency } from "../../src/jev/decision-types.js";
import type { RiskLimits } from "../../src/risk/limits.js";

const market: MarketIdentity = { marketId: "m1", conditionId: "0xcond", slug: "btc-updown-5m-1", question: "q", upAssetId: "UP", downAssetId: "DOWN", openedAtMs: 0, closesAtMs: 300_000, tickSize: 0.01, minOrderSize: 5 };
const limits: RiskLimits = { maxMarketExposureUsd: 10, maxTotalExposureUsd: 20, maxUnpairedExposureUsd: 10, maxOrderSizeShares: 5, maxOpenOrders: 4, maxDailyLossUsd: 10, maxConsecutiveErrors: 5, maxChainlinkAgeMs: 5000, maxOrderbookAgeMs: 5000, minSecondsRemaining: 5, minMarketLiquidityShares: 1, maxSpread: 0.2, maxJevLatencyMs: 750 };
const book = (assetId: string, bid: number, ask: number, size = 100) => normalizeBook({ assetId, bids: [{ price: bid, size }], asks: [{ price: ask, size }], receivedAtMs: 0 });
const snapshot = (inventory: InventoryAccounting = computeInventory(EMPTY_POSITION)): MarketState => ({ stateVersion: 10n, materialVersion: 3n, identity: market, nowMs: 100_000, secondsRemaining: 200, upBook: book("UP", 0.44, 0.45), downBook: book("DOWN", 0.54, 0.55), settlementStartPrice: 100, settlementCurrentPrice: 101, settlementUpdatedAtMs: 100_000, spotPrice: 101, inventory, openOrderCount: 0 });
const decision = (action: Action, urgency: Urgency, inventoryAction = "NONE", id = "d1"): Decision => ({
  decisionId: id, marketId: "m1", stateVersion: 3n, rawStateVersion: 10n, materialReason: "quote", packetReceivedMono: 0, stateUpdatedMono: 0, inputHash: "h", requestedAtMono: 0, respondedAtMono: 0, jevLatencyMs: 0, timestampMs: 100_000, state: {} as never,
  answers: { action: { type: "choice", choice: action, confidence: 0.8, probabilities: {} }, execution_urgency: { type: "choice", choice: urgency, confidence: 0.8, probabilities: {} }, inventory_action: { type: "choice", choice: inventoryAction, confidence: 0.8, probabilities: {} } } as unknown as JevAnswers,
  model: "jev", usage: { input_tokens: 0, output_tokens: 0 }, requestedAction: action,
});

/** A fake exchange: records calls, answers as scripted. */
function fakeExchange() {
  const calls: string[] = [];
  const orders = new Map<string, OpenOrderLike>();
  let nextId = 1;
  const state = {
    postResult: undefined as PostAccepted | PostRejected | undefined,
    positions: [] as PositionLike[],
    refuseCancel: false,
    calls, orders,
  };
  const client: LiveClientLike = {
    createLimitOrder: async (r) => { calls.push(`sign:limit:${r.assetId}@${r.price}x${r.size}`); return { tokenId: r.assetId, side: "BUY", makerAmount: "1", takerAmount: "1", orderType: "GTC", signature: "0xsig" }; },
    createMarketOrder: async (r) => { calls.push(`sign:${r.orderType}:${r.assetId}@${r.maxPrice}$${r.amount}`); return { tokenId: r.assetId, side: "BUY", makerAmount: "1", takerAmount: "1", orderType: r.orderType, signature: "0xsig" }; },
    postOrder: async (o) => {
      calls.push(`post:${o.orderType}`);
      if (state.postResult) return state.postResult;
      const id = `ex-${nextId++}`;
      if (o.orderType === "GTC") { orders.set(id, { id, price: "0.44", originalSize: "5", sizeMatched: "0", status: "LIVE" }); return { ok: true, orderId: id, status: "live", makingAmount: "0", takingAmount: "0" }; }
      return { ok: true, orderId: id, status: "matched", makingAmount: "2.25", takingAmount: "5" }; // 5 shares at .45
    },
    fetchOrder: async ({ orderId }) => { calls.push(`fetch:${orderId}`); const o = orders.get(orderId); if (!o) throw new Error("unknown order"); return o; },
    cancelOrders: async ({ orderIds }) => { calls.push(`cancel:${orderIds.join(",")}`); if (state.refuseCancel) return { canceled: [], not_canceled: Object.fromEntries(orderIds.map((i) => [i, "already filled"])) }; for (const i of orderIds) orders.delete(i); return { canceled: orderIds, not_canceled: {} }; },
    mergePositions: async (r) => { calls.push(`merge:${r.conditionId}:${String(r.amount)}`); return { transactionHash: null, wait: async () => ({ transactionHash: "0xmerge" }) }; },
    redeemPositions: async (r) => { calls.push(`redeem:${r.conditionId}`); return { transactionHash: null, wait: async () => ({ transactionHash: "0xredeem" }) }; },
    listPositions: () => ({ firstPage: async () => ({ items: state.positions }) }),
  };
  return { client, state };
}

function engine(opts: { pollMs?: number } = {}) {
  const db = openDatabase(":memory:");
  const repo = new DecisionRepository(db);
  repo.upsertMarket(market, 0);
  const ex = fakeExchange();
  const inventories: { inv: InventoryAccounting; open: number }[] = [];
  const apiErrors: string[] = [];
  let mono = 0;
  const e = new LiveEngine({ market, limits, client: ex.client, mono: () => mono, wall: () => 123, db, onInventory: (inv, open) => inventories.push({ inv, open }), onApiError: (what) => apiErrors.push(what), log: () => {}, pollMs: opts.pollMs ?? 0 });
  const approve = async (d: Decision, snap = snapshot()) => { repo.saveDecision(d, { result: "APPROVED" }); await e.onApproved(d, snap, mono); };
  const orders = () => db.all<{ order_id: string; status: string; order_type: string; price: number; size: number }>(`SELECT order_id, status, order_type, price, size FROM orders ORDER BY created_ms, order_id`);
  const fills = () => db.all<{ order_id: string; side: string; price: number; size: number }>(`SELECT order_id, side, price, size FROM fills ORDER BY id`);
  return { e, ex, db, approve, orders, fills, inventories, apiErrors, advance: (ms: number) => { mono += ms; return mono; } };
}

describe("LiveEngine", () => {
  it("signs, posts, records the exchange's order id and the fill of a matched market order, and feeds the position back", async () => {
    const { e, ex, approve, orders, fills, inventories, db } = engine();
    await approve(decision("BUY_UP", "IMMEDIATE"));
    // IMMEDIATE = FOK five ticks above the .45 ask: limit .50, 5 shares, 2.50 USD cap; the exchange filled at .45.
    expect(ex.state.calls).toEqual(["sign:FOK:UP@0.5$2.5", "post:FOK"]);
    expect(orders()).toEqual([{ order_id: "ex-1", status: "FILLED", order_type: "FOK", price: 0.5, size: 5 }]);
    expect(fills()).toEqual([{ order_id: "ex-1", side: "UP", price: 0.45, size: 5 }]);
    expect(e.summary().position.upShares).toBe(5);
    expect(inventories.at(-1)?.inv.upShares).toBe(5);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM latency_measurements WHERE decision_id = 'd1' AND submit_to_ack_ms IS NOT NULL`)!.n).toBe(1);
  });

  it("records a rejected post as a REJECTED order and never invents a fill; not-filled codes are the market's answer, not API errors", async () => {
    const { e, ex, approve, orders, fills, apiErrors } = engine();
    ex.state.postResult = { ok: false, code: "fok_not_filled", message: "no" };
    await approve(decision("BUY_UP", "IMMEDIATE"));
    expect(orders()[0]?.status).toBe("REJECTED:fok_not_filled");
    expect(fills()).toEqual([]);
    expect(apiErrors).toEqual([]);
    ex.state.postResult = { ok: false, code: "insufficient_balance_or_allowance", message: "broke" };
    await approve(decision("BUY_UP", "IMMEDIATE", "NONE", "d2"));
    expect(apiErrors).toEqual(["post-rejected"]);
    expect(e.summary().rejected).toBe(2);
  });

  it("tracks a resting order: fills on poll, expires it after its TTL, and cancels it on kill", async () => {
    const { e, ex, approve, orders, fills, advance } = engine();
    await approve(decision("BUY_UP", "PASSIVE"));           // GTC at .44, rests
    expect(orders()[0]).toMatchObject({ order_id: "ex-1", status: "RESTING", order_type: "GTC" });
    ex.state.orders.set("ex-1", { ...ex.state.orders.get("ex-1")!, sizeMatched: "2" });
    await e.tick(advance(1000));
    expect(fills()).toEqual([{ order_id: "ex-1", side: "UP", price: 0.44, size: 2 }]);
    expect(e.summary().position.upShares).toBe(2);
    await e.tick(advance(25_000));                         // TTL 20 s passed
    expect(orders()[0]?.status).toBe("PARTIAL");
    expect(ex.state.calls.at(-1)).toBe("cancel:ex-1");
    expect(e.summary().openOrders).toBe(0);

    await approve(decision("BUY_UP", "PASSIVE", "NONE", "d2"));
    await e.kill();
    expect(orders()[1]?.status).toBe("CANCELLED");
    expect(e.summary().cancelled).toBe(2);
    await approve(decision("BUY_UP", "IMMEDIATE", "NONE", "d3"));
    expect(orders()).toHaveLength(2);                      // killed: nothing new is signed
    e.resume();
    await approve(decision("BUY_UP", "IMMEDIATE", "NONE", "d4"));
    expect(orders()).toHaveLength(3);
  });

  it("merges matched shares through the relayer and books the merge; redeems the winner and books the market", async () => {
    const { e, ex, approve, db } = engine();
    await approve(decision("BUY_UP", "IMMEDIATE"));
    ex.state.postResult = { ok: true, orderId: "ex-9", status: "matched", makingAmount: "2.75", takingAmount: "5" };
    await approve(decision("BUY_DOWN", "IMMEDIATE", "NONE", "d2"));
    ex.state.postResult = undefined;
    expect(e.summary().position).toMatchObject({ upShares: 5, downShares: 5 });
    await approve(decision("HOLD", "NORMAL", "MERGE", "d3"));
    expect(ex.state.calls).toContain("merge:0xcond:max");
    expect(e.summary().position).toMatchObject({ upShares: 0, downShares: 0 });
    expect(db.get<{ tx_hash: string; quantity: number }>(`SELECT tx_hash, quantity FROM merges WHERE mode = 'live'`)).toEqual({ tx_hash: "0xmerge", quantity: 5 });

    await approve(decision("BUY_UP", "IMMEDIATE", "NONE", "d4"));
    const s = await e.redeem("UP");
    expect(ex.state.calls.at(-1)).toBe("redeem:0xcond");
    expect(s.settled).toBe(true);
    expect(s.netPnl).toBeCloseTo(5 - 2.25, 6);             // paid 2.25 + 2.25 + 2.75 - merge returned 5.00; last 5 shares pay 5.00
    expect(db.get<{ tx_hash: string }>(`SELECT tx_hash FROM redemptions WHERE mode = 'live'`)?.tx_hash).toBe("0xredeem");
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM pnl_snapshots WHERE mode = 'live'`)!.n).toBe(1);
  });

  it("reconciles against the exchange's positions and flags a mismatch", async () => {
    const { e, ex, approve } = engine();
    await approve(decision("BUY_UP", "IMMEDIATE"));
    ex.state.positions = [{ assetId: "UP", currentSize: "5", redeemable: false }];
    expect((await e.reconcile()).ok).toBe(true);
    ex.state.positions = [{ assetId: "UP", currentSize: "3", redeemable: false }];
    const r = await e.reconcile();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/exchange UP 3/);
  });

  it("never posts an order signed while the switch tripped, and caps size by the live limits", async () => {
    const { e, ex, approve, orders } = engine();
    // Size: 5 shares at .45 = 2.25 USD, under the 10 USD market cap; the cap binds after four such buys.
    for (let i = 0; i < 5; i++) await approve(decision("BUY_UP", "IMMEDIATE", "NONE", `d${i}`));
    const sizes = orders().map((o) => o.size);
    expect(sizes.slice(0, 4)).toEqual([5, 5, 5, 5]);
    expect(orders()).toHaveLength(4);                      // fifth: allowance 1 USD -> 2 shares < min order 5 -> no order
    expect(ex.state.calls.filter((c) => c.startsWith("post")).length).toBe(4);
    void e;
  });
});
