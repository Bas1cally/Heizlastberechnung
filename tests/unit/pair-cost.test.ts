import { describe, expect, it } from "vitest";
import { computePairCost, pairBidValue } from "../../src/features/pair-cost.js";
import { depth, executeAgainst, imbalance } from "../../src/features/orderbook.js";
import type { OrderBook } from "../../src/market/types.js";

// The book from the project brief, section 18.
const UP_ASKS = [
  { price: 0.989, size: 300 },
  { price: 0.99, size: 500 },
];
const DOWN_ASKS = [
  { price: 0.003, size: 100 },
  { price: 0.004, size: 700 },
];

describe("depth-weighted execution", () => {
  it("walks levels rather than quoting the top of book", () => {
    const up = executeAgainst(UP_ASKS, 500);
    // 300 @ .989 + 200 @ .990
    expect(up.cost).toBeCloseTo(494.7, 9);
    expect(up.vwap).toBeCloseTo(0.9894, 9);
    expect(up.filledQty).toBe(500);
    expect(up.exhausted).toBe(false);
  });

  it("reports exhaustion instead of inventing depth", () => {
    const e = executeAgainst(UP_ASKS, 5000);
    expect(e.filledQty).toBe(800);
    expect(e.exhausted).toBe(true);
  });

  it("returns a zero execution for a non-positive quantity", () => {
    for (const qty of [0, -10, Number.NaN]) {
      const e = executeAgainst(UP_ASKS, qty);
      expect(e).toEqual({ filledQty: 0, cost: 0, vwap: 0, exhausted: false });
    }
  });
});

describe("complete-set cost", () => {
  it("prices a 500-share set at real depth", () => {
    const pair = computePairCost({
      upAsks: UP_ASKS,
      downAsks: DOWN_ASKS,
      requestedQty: 500,
    });
    expect(pair.pairExecutableQty).toBe(500);
    expect(pair.pairVWAP).toBeCloseTo(0.9932, 9); // .9894 + .0038
    expect(pair.totalCost).toBeCloseTo(496.6, 9);
    expect(pair.pairEdge).toBeCloseTo(0.0068, 9);
  });

  it("is more conservative than the top-of-book quote", () => {
    const naiveEdge = 1 - (0.989 + 0.003); // 0.008
    const real = computePairCost({
      upAsks: UP_ASKS,
      downAsks: DOWN_ASKS,
      requestedQty: 500,
    });
    // Believing the naive number would overstate the edge by ~18%.
    expect(real.pairEdge).toBeLessThan(naiveEdge);
  });

  it("caps the quantity at the thinner side and prices both legs there", () => {
    const thinDown = [{ price: 0.004, size: 120 }];
    const pair = computePairCost({
      upAsks: UP_ASKS,
      downAsks: thinDown,
      requestedQty: 500,
    });
    expect(pair.pairExecutableQty).toBe(120);
    expect(pair.exhausted).toBe(true);
    // UP priced at 120 shares, entirely inside the .989 level.
    expect(pair.pairVWAP).toBeCloseTo(0.989 + 0.004, 9);
  });

  it("subtracts fees from the edge", () => {
    const pair = computePairCost({
      upAsks: UP_ASKS,
      downAsks: DOWN_ASKS,
      requestedQty: 500,
      feePerSet: 0.005,
    });
    expect(pair.pairEdge).toBeCloseTo(0.0018, 9);
  });

  it("reports no edge when a side is empty", () => {
    const pair = computePairCost({ upAsks: UP_ASKS, downAsks: [], requestedQty: 500 });
    expect(pair.pairExecutableQty).toBe(0);
    expect(pair.pairEdge).toBe(0);
    expect(pair.exhausted).toBe(true);
  });

  it("values selling a set into the bids", () => {
    const value = pairBidValue(
      [{ price: 0.985, size: 500 }],
      [{ price: 0.002, size: 500 }],
      500,
    );
    expect(value).toBeCloseTo(0.987, 9);
  });
});

describe("book summary features", () => {
  const book = (bids: typeof UP_ASKS, asks: typeof UP_ASKS): OrderBook => ({
    assetId: "t",
    bids,
    asks,
    receivedAtMs: 0,
  });

  it("measures imbalance between -1 and 1", () => {
    expect(imbalance(book([{ price: 0.5, size: 300 }], [{ price: 0.51, size: 100 }])))
      .toBeCloseTo(0.5, 9);
    expect(imbalance(book([], [{ price: 0.51, size: 100 }]))).toBe(-1);
  });

  it("reads an empty book as no signal, not NaN", () => {
    expect(imbalance(book([], []))).toBe(0);
    expect(depth([])).toBe(0);
  });
});
