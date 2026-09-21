import { describe, expect, it } from "vitest";
import { PaperLiveEngine } from "../../src/execution/paper-live-engine.js";
import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";
import { normalizeBook } from "../../src/feeds/book-normalizer.js";
import { DEFAULT_FILL_PARAMS } from "../../src/replay/paper-fill-model.js";
import { computeInventory, EMPTY_POSITION, type InventoryAccounting } from "../../src/inventory/accounting.js";
import type { MarketIdentity, MarketState } from "../../src/market/market-state.js";
import type { Decision } from "../../src/jev/decision-engine.js";
import type { JevAnswers, Action, Urgency } from "../../src/jev/decision-types.js";
import type { RiskLimits } from "../../src/risk/limits.js";

const market: MarketIdentity = { marketId: "m1", conditionId: "c1", slug: "btc-updown-5m-1", question: "q", upAssetId: "UP", downAssetId: "DOWN", openedAtMs: 0, closesAtMs: 300_000, tickSize: 0.01, minOrderSize: 5 };
const limits: RiskLimits = { maxMarketExposureUsd: 100, maxTotalExposureUsd: 100, maxUnpairedExposureUsd: 100, maxOrderSizeShares: 10, maxOpenOrders: 4, maxDailyLossUsd: 50, maxConsecutiveErrors: 5, maxChainlinkAgeMs: 5000, maxOrderbookAgeMs: 5000, minSecondsRemaining: 5, minMarketLiquidityShares: 1, maxSpread: 0.2 } as RiskLimits;

const book = (assetId: string, bid: number, ask: number, size = 100) => normalizeBook({ assetId, bids: [{ price: bid, size }], asks: [{ price: ask, size }], receivedAtMs: 0 });

function snapshot(upBook = book("UP", 0.44, 0.45), downBook = book("DOWN", 0.54, 0.55), inventory: InventoryAccounting = computeInventory(EMPTY_POSITION)): MarketState {
  return { stateVersion: 10n, materialVersion: 3n, identity: market, nowMs: 100_000, secondsRemaining: 200, upBook, downBook, settlementStartPrice: 100, settlementCurrentPrice: 101, settlementUpdatedAtMs: 100_000, spotPrice: 101, inventory, openOrderCount: 0 };
}

function decision(action: Action, urgency: Urgency, inventoryAction = "NONE", id = "d1"): Decision {
  const answers = {
    action: { type: "choice", choice: action, confidence: 0.8, probabilities: {} },
    execution_urgency: { type: "choice", choice: urgency, confidence: 0.8, probabilities: {} },
    inventory_action: { type: "choice", choice: inventoryAction, confidence: 0.8, probabilities: {} },
  } as unknown as JevAnswers;
  return { decisionId: id, marketId: "m1", stateVersion: 3n, rawStateVersion: 10n, materialReason: "quote", packetReceivedMono: 0, stateUpdatedMono: 0, inputHash: "h", requestedAtMono: 0, respondedAtMono: 0, jevLatencyMs: 0, timestampMs: 100_000, state: {} as never, answers, model: "jev", usage: { input_tokens: 0, output_tokens: 0 }, requestedAction: action };
}

function engine(opts: { latencyMs?: number; seed?: number; queueFillProbability?: number } = {}) {
  const db = openDatabase(":memory:");
  const repo = new DecisionRepository(db);
  repo.upsertMarket(market, 0);
  const inventories: { inv: InventoryAccounting; open: number }[] = [];
  const logs: string[] = [];
  const inner = new PaperLiveEngine({
    market, limits, latencyMs: opts.latencyMs ?? 300, fill: { ...DEFAULT_FILL_PARAMS, slippage: 0, queueFillProbability: opts.queueFillProbability ?? DEFAULT_FILL_PARAMS.queueFillProbability }, seed: opts.seed ?? 1,
    mono: () => 0, wall: () => 123, db, onInventory: (inv, open) => inventories.push({ inv, open }), log: (m) => logs.push(m),
  });
  // Orders reference the decision they came from; the observer persists every decision before it reaches the engine.
  const original = PaperLiveEngine.prototype.onApproved;
  const e = Object.assign(inner, { onApproved: (d: Decision, snap: MarketState, mono: number) => { repo.saveDecision(d, { result: "APPROVED" }); return original.call(inner, d, snap, mono); } });
  const orders = () => db.all<{ order_id: string; status: string; order_type: string; price: number; size: number; mode: string }>(`SELECT order_id, status, order_type, price, size, mode FROM orders ORDER BY order_id`);
  const fills = () => db.all<{ side: string; price: number; size: number; mode: string }>(`SELECT side, price, size, mode FROM fills`);
  return { e, db, inventories, logs, orders, fills };
}

describe("PaperLiveEngine", () => {
  it("fills a marketable order only against the book that arrives after the latency", () => {
    const { e, orders, fills, inventories } = engine({ latencyMs: 300 });
    e.onApproved(decision("BUY_UP", "IMMEDIATE"), snapshot(), 1000);
    expect(orders()).toHaveLength(0); // nothing recorded until it "arrives"
    expect(inventories.at(-1)?.open).toBe(1);

    e.onBook(book("UP", 0.44, 0.45), 1200); // too early: still in flight
    expect(orders()).toHaveLength(0);

    e.onBook(book("UP", 0.46, 0.47), 1300); // arrival: book moved to .47; FOK at .45 + 5 ticks = .50 still reaches it
    const o = orders();
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ status: "FILLED", order_type: "FOK", size: 10, mode: "paper" });
    expect(fills()[0]).toMatchObject({ side: "UP", size: 10, mode: "paper" });
    expect(fills()[0]?.price).toBeCloseTo(0.47, 9);
    expect(e.summary().position.upShares).toBe(10);
    expect(inventories.at(-1)?.inv.upShares).toBe(10);
    expect(inventories.at(-1)?.open).toBe(0);
  });

  it("reports NO_FILL when the book ran away before arrival", () => {
    const { e, orders, fills } = engine({ latencyMs: 300 });
    e.onApproved(decision("BUY_UP", "IMMEDIATE"), snapshot(), 1000);
    e.onBook(book("UP", 0.60, 0.61), 1300);
    expect(orders()[0]?.status).toBe("NO_FILL");
    expect(fills()).toHaveLength(0);
    expect(e.summary().noFills).toBe(1);
    expect(e.summary().position.upShares).toBe(0);
  });

  it("rests a passive order, fills it when traded through, expires it otherwise", () => {
    const { e, orders } = engine({ latencyMs: 100, queueFillProbability: 0 });
    // PASSIVE: GTC one tick below the ask -> .44, not marketable, rests with 20 s TTL.
    e.onApproved(decision("BUY_UP", "PASSIVE"), snapshot(), 1000);
    expect(orders()[0]).toMatchObject({ status: "RESTING", order_type: "GTC", price: 0.44 });
    e.onBook(book("UP", 0.43, 0.44), 1050); // before latency: not even seen
    e.onBook(book("UP", 0.43, 0.44), 1500); // touched, but queue draw is 0
    e.tick(21_500);                          // TTL passed
    expect(orders()[0]?.status).toBe("NO_FILL");

    e.onApproved(decision("BUY_UP", "PASSIVE", "NONE", "d2"), snapshot(), 30_000);
    e.onBook(book("UP", 0.42, 0.43), 30_200); // traded through the .44 limit
    expect(orders()[1]).toMatchObject({ status: "FILLED", price: 0.44 });
    expect(e.summary().position.upShares).toBe(10);
  });

  it("cancels resting orders on kill and ignores later decisions", () => {
    const { e, orders, inventories } = engine();
    e.onApproved(decision("BUY_UP", "PASSIVE"), snapshot(), 1000);
    e.onApproved(decision("BUY_DOWN", "IMMEDIATE", "NONE", "d2"), snapshot(), 1000);
    e.kill();
    expect(orders()[0]?.status).toBe("CANCELLED");
    expect(e.summary().cancelled).toBe(1);
    expect(inventories.at(-1)?.open).toBe(0);
    e.onBook(book("DOWN", 0.54, 0.55), 5000); // the pending marketable was dropped too
    expect(orders()).toHaveLength(1);
    e.onApproved(decision("BUY_UP", "IMMEDIATE", "NONE", "d3"), snapshot(), 6000);
    e.onBook(book("UP", 0.44, 0.45), 7000);
    expect(orders()).toHaveLength(1);
  });

  it("honours a CANCEL decision", () => {
    const { e, orders } = engine();
    e.onApproved(decision("BUY_UP", "PASSIVE"), snapshot(), 1000);
    e.onApproved(decision("CANCEL", "NORMAL", "NONE", "d2"), snapshot(), 1500);
    expect(orders()[0]?.status).toBe("CANCELLED");
  });

  it("merges paired shares when Jev says MERGE and settles at the real outcome", () => {
    const { e, db } = engine({ latencyMs: 0 });
    e.onApproved(decision("BUY_UP", "IMMEDIATE"), snapshot(), 1000);
    e.onBook(book("UP", 0.44, 0.45), 1000);
    e.onApproved(decision("BUY_DOWN", "IMMEDIATE", "NONE", "d2"), snapshot(), 2000);
    e.onBook(book("DOWN", 0.54, 0.55), 2000);
    expect(e.summary().position).toMatchObject({ upShares: 10, downShares: 10 });

    // A HOLD with inventory intent MERGE: 10 pairs bought for 1.00 return 1.00 each.
    e.onApproved(decision("HOLD", "NORMAL", "MERGE", "d3"), snapshot(), 3000);
    expect(e.summary().merges).toBe(1);
    expect(e.summary().position).toMatchObject({ upShares: 0, downShares: 0 });
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM merges WHERE mode = 'paper'`)?.n).toBe(1);

    const s = e.settleAt("UP", 4000);
    expect(s.settled).toBe(true);
    expect(s.outcome).toBe("UP");
    expect(s.netPnl).toBeCloseTo(0, 6); // 4.50 + 5.50 paid, 10.00 back, no fees
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM pnl_snapshots WHERE mode = 'paper'`)?.n).toBe(1);
    expect(db.get<{ net_pnl: number }>(`SELECT net_pnl FROM redemptions WHERE mode = 'paper'`)?.net_pnl).toBeCloseTo(0, 6);
    // Settling twice is a no-op; decisions after settlement are ignored.
    expect(e.settleAt("DOWN", 5000).outcome).toBe("UP");
    e.onApproved(decision("BUY_UP", "IMMEDIATE", "NONE", "d4"), snapshot(), 6000);
    expect(e.summary().orders).toBe(2);
  });

  it("settles a directional position: winner pays 1, loser pays 0", () => {
    const { e } = engine({ latencyMs: 0 });
    e.onApproved(decision("BUY_UP", "IMMEDIATE"), snapshot(), 1000);
    e.onBook(book("UP", 0.44, 0.45), 1000);
    expect(e.settleAt("DOWN", 2000).netPnl).toBeCloseTo(-4.5, 6);
    const { e: e2 } = engine({ latencyMs: 0 });
    e2.onApproved(decision("BUY_UP", "IMMEDIATE"), snapshot(), 1000);
    e2.onBook(book("UP", 0.44, 0.45), 1000);
    expect(e2.settleAt("UP", 2000).netPnl).toBeCloseTo(5.5, 6);
  });

  it("resolves in-flight and resting orders on the last known books at settlement", () => {
    const { e, orders } = engine({ latencyMs: 10_000, queueFillProbability: 0 });
    e.onBook(book("UP", 0.44, 0.45), 500);
    e.onApproved(decision("BUY_UP", "IMMEDIATE"), snapshot(), 1000);           // in flight for 10 s
    e.onApproved(decision("BUY_DOWN", "PASSIVE", "NONE", "d2"), snapshot(), 1000); // resting, never touched
    const s = e.settleAt("UP", 2000);
    expect(orders().map((o) => o.status).sort()).toEqual(["FILLED", "NO_FILL"]);
    expect(s.position.upShares).toBe(10);
  });

  it("caps size by the remaining exposure allowance", () => {
    const { e, orders } = engine({ latencyMs: 0 });
    const inv = computeInventory({ ...EMPTY_POSITION, upShares: 100, avgUpEntry: 0.96 });
    e.onApproved(decision("BUY_UP", "IMMEDIATE"), snapshot(undefined, undefined, inv), 1000);
    e.onBook(book("UP", 0.44, 0.45), 1000);
    // Engine's own position is empty, so its allowance is the full 100 USD -> 10 shares by max_order.
    expect(orders()[0]?.size).toBe(10);
  });
});
