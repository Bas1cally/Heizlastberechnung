import { describe, expect, it } from "vitest";
import { MarketStateStore, type MarketIdentity } from "../../src/market/market-state.js";
import { computeInventory, EMPTY_POSITION } from "../../src/inventory/accounting.js";
import { normalizeBook } from "../../src/feeds/book-normalizer.js";

const id: MarketIdentity = {
  marketId: "m", conditionId: "c", slug: "btc-5m", question: "q",
  upAssetId: "UP", downAssetId: "DOWN",
  openedAtMs: 1_000, closesAtMs: 301_000, tickSize: 0.001, minOrderSize: 5,
};
const store = () => new MarketStateStore(id, computeInventory(EMPTY_POSITION));

describe("MarketStateStore", () => {
  it("bumps the version on every mutation and never on a snapshot", () => {
    const s = store();
    expect(s.stateVersion).toBe(0n);
    s.setSettlementPrice(100, 2_000);
    expect(s.stateVersion).toBe(1n);
    s.snapshot(3_000);
    s.snapshot(4_000);
    expect(s.stateVersion).toBe(1n);
    s.setOpenOrderCount(1);
    expect(s.stateVersion).toBe(2n);
  });

  it("routes a book to the right side and rejects unknown assets", () => {
    const s = store();
    const up = normalizeBook({ assetId: "UP", bids: [], asks: [{ price: "0.99", size: "1" }], receivedAtMs: 1 });
    expect(s.setBook(up)).toBe(true);
    expect(s.setBook({ ...up, assetId: "ETH" })).toBe(false);
    expect(s.snapshot(5).upBook?.asks[0]?.price).toBe(0.99);
    expect(s.snapshot(5).downBook).toBeUndefined();
  });

  it("takes the first price at or after open as the start price", () => {
    const s = store();
    s.setSettlementPrice(99_000, 500);      // before open: not the start
    s.setSettlementPrice(100_000, 1_000);   // at open
    s.setSettlementPrice(100_500, 2_000);
    const snap = s.snapshot(2_000);
    expect(snap.settlementStartPrice).toBe(100_000);
    expect(snap.settlementCurrentPrice).toBe(100_500);
  });

  it("computes seconds remaining from the wall clock and floors at zero", () => {
    const s = store();
    expect(s.snapshot(281_000).secondsRemaining).toBeCloseTo(20, 6);
    expect(s.snapshot(999_000).secondsRemaining).toBe(0);
  });
});

describe("spot beside settlement", () => {
  it("keeps the spot price separate from the TWAP the market settles on", () => {
    const s = store();
    s.setSettlementPrice(100_000, 1_000);
    s.setSettlementPrice(100_010, 2_000);
    s.setSpotPrice(100_050);
    const snap = s.snapshot(2_000);
    expect(snap.settlementCurrentPrice).toBe(100_010);
    expect(snap.spotPrice).toBe(100_050);
  });
});
