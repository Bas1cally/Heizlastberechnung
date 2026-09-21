import { describe, expect, it } from "vitest";
import { buildOrders } from "../../src/execution/order-builder.js";
import { styleFor } from "../../src/execution/order-types.js";
import { computeInventory } from "../../src/inventory/accounting.js";
import { normalizeBook } from "../../src/feeds/book-normalizer.js";
import type { MarketState } from "../../src/market/market-state.js";

const book = (assetId: string, asks: [number, number][]) =>
  normalizeBook({ assetId, bids: [], asks: asks.map(([price, size]) => ({ price, size })), receivedAtMs: 0 });

const state = (inv = { upShares: 0, downShares: 0, avgUpEntry: 0, avgDownEntry: 0 }): MarketState => ({
  stateVersion: 1n, materialVersion: 1n,
  identity: { marketId: "m", conditionId: "c", slug: "s", question: "q", upAssetId: "UP", downAssetId: "DOWN", openedAtMs: 0, closesAtMs: 300_000, tickSize: 0.001, minOrderSize: 5 },
  nowMs: 0, secondsRemaining: 100,
  upBook: book("UP", [[0.45, 40], [0.46, 100], [0.47, 500]]),
  downBook: book("DOWN", [[0.55, 30], [0.56, 200]]),
  settlementStartPrice: 1, settlementCurrentPrice: 1, settlementUpdatedAtMs: 0, spotPrice: 1,
  inventory: computeInventory(inv), openOrderCount: 0,
});
const limits = { maxOrderSizeShares: 100, riskAllowanceUsd: 1000, tickSize: 0.001, minOrderSize: 5 };

describe("urgency mapping", () => {
  it("maps every urgency except DO_NOT_TRADE to an order style", () => {
    expect(styleFor("PASSIVE")).toMatchObject({ type: "GTC", postOnly: true });
    expect(styleFor("PASSIVE")?.ttlMs).toBeLessThan(180_000); // we cancel ourselves; GTD needs >= 3 min
    expect(styleFor("IMMEDIATE")?.type).toBe("FOK");
    expect(styleFor("DO_NOT_TRADE")).toBeUndefined();
  });
});

describe("buildOrders", () => {
  it("never invents an order for HOLD, ABSTAIN, CANCEL or DO_NOT_TRADE", () => {
    expect(buildOrders("HOLD", "URGENT", state(), limits)).toEqual([]);
    expect(buildOrders("BUY_UP", "DO_NOT_TRADE", state(), limits)).toEqual([]);
  });

  it("sizes a NORMAL buy at the touch by what the touch can fill", () => {
    const [o] = buildOrders("BUY_UP", "NORMAL", state(), limits);
    expect(o).toMatchObject({ side: "UP", price: 0.45, size: 40, sizedBy: "depth", style: { type: "GTC" } });
  });

  it("lets an URGENT order cross ticks and take more depth", () => {
    const [o] = buildOrders("BUY_UP", "URGENT", state(), limits);
    expect(o).toMatchObject({ price: 0.452, size: 40 }); // two ticks above .45 still below .46
    const [big] = buildOrders("BUY_UP", "IMMEDIATE", state(), limits);
    expect(big).toMatchObject({ price: 0.455, style: { type: "FOK" } });
  });

  it("caps by risk allowance when that binds", () => {
    const [o] = buildOrders("BUY_DOWN", "IMMEDIATE", state(), { ...limits, riskAllowanceUsd: 10 });
    expect(o!.sizedBy).toBe("risk");
    expect(o!.size).toBe(Math.floor(10 / o!.price));
  });

  it("sizes a complement to the unpaired inventory on the other side", () => {
    const [o] = buildOrders("ADD_COMPLEMENT", "NORMAL", state({ upShares: 25, downShares: 0, avgUpEntry: 0.99, avgDownEntry: 0 }), limits);
    expect(o).toMatchObject({ side: "DOWN", size: 25, sizedBy: "complement" });
    expect(buildOrders("ADD_COMPLEMENT", "NORMAL", state(), limits)).toEqual([]);
  });

  it("buys a pair at one common size or not at all", () => {
    const legs = buildOrders("BUY_PAIR", "IMMEDIATE", state(), limits);
    expect(legs).toHaveLength(2);
    expect(legs[0]!.size).toBe(legs[1]!.size);
    expect(legs.map((l) => l.side).sort()).toEqual(["DOWN", "UP"]);
  });

  it("drops an order below the minimum size", () => {
    expect(buildOrders("BUY_UP", "NORMAL", state(), { ...limits, riskAllowanceUsd: 1 })).toEqual([]);
  });
});
