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
    // Asks .44 / .55: the set costs .99, a cent under what it merges back to.
    const legs = buildOrders("BUY_PAIR", "IMMEDIATE", { ...state(), upBook: book("UP", [[0.44, 40], [0.46, 100], [0.47, 500]]) }, limits);
    expect(legs).toHaveLength(2);
    expect(legs[0]!.size).toBe(legs[1]!.size);
    expect(legs.map((l) => l.side).sort()).toEqual(["DOWN", "UP"]);
  });

  it("never pays more than 1.00 for a set, and caps a hedge so the pair merges back at no cost", () => {
    // Asks .44 / .55 sum to .99: bought at the touch, the cent of slack is not spent on aggression beyond the cap.
    const pair = buildOrders("BUY_PAIR", "IMMEDIATE", { ...state(), upBook: book("UP", [[0.44, 100]]) }, limits);
    expect(pair.map((l) => l.price)).toEqual([0.44, 0.55]);
    // Asks summing to 1.00 or more: opening a set outright earns nothing, so no set at all.
    expect(buildOrders("BUY_PAIR", "IMMEDIATE", state(), limits)).toEqual([]);
    expect(buildOrders("BUY_PAIR", "IMMEDIATE", { ...state(), upBook: book("UP", [[0.46, 100]]) }, limits)).toEqual([]);
    // A tail bought at .01 may be hedged at .99 at most; with the leader asking .995 the hedge rests at .99 as GTC.
    const tail = state({ upShares: 100, downShares: 0, avgUpEntry: 0.01, avgDownEntry: 0 });
    const hedge = buildOrders("ADD_COMPLEMENT", "IMMEDIATE", { ...tail, downBook: book("DOWN", [[0.995, 5000]]) }, { ...limits, tickSize: 0.005 });
    expect(hedge).toHaveLength(1);
    expect(hedge[0]).toMatchObject({ side: "DOWN", price: 0.99, size: 100 });
    expect(hedge[0]!.style.type).toBe("GTC");
    // Leader asking .99: the hedge crosses at .99 as the immediate order it was asked to be.
    const hedgeNow = buildOrders("ADD_COMPLEMENT", "IMMEDIATE", { ...tail, downBook: book("DOWN", [[0.99, 5000]]) }, { ...limits, tickSize: 0.005 });
    expect(hedgeNow[0]).toMatchObject({ price: 0.99 });
    expect(hedgeNow[0]!.style.type).toBe("FOK");
  });

  it("caps a plain buy of the opposite side so that the set it completes never costs more than 1.00", () => {
    // Holding 100 UP bought at .41: DOWN may cost at most .59; the book asks .65 -> rest at .59.
    const held = state({ upShares: 100, downShares: 0, avgUpEntry: 0.41, avgDownEntry: 0 });
    const legs = buildOrders("BUY_DOWN", "NORMAL", { ...held, downBook: book("DOWN", [[0.65, 500]]) }, { ...limits, tickSize: 0.01 });
    expect(legs[0]).toMatchObject({ side: "DOWN", price: 0.59 });
    expect(legs[0]!.style.type).toBe("GTC");
  });

  it("drops an order below the minimum size", () => {
    expect(buildOrders("BUY_UP", "NORMAL", state(), { ...limits, riskAllowanceUsd: 1 })).toEqual([]);
  });
});
