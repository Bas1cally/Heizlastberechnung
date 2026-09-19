import { describe, expect, it } from "vitest";
import {
  EMPTY_POSITION,
  applyFill,
  applyMerge,
  computeInventory,
} from "../../src/inventory/accounting.js";

describe("inventory pairing identity", () => {
  it("always pairs to min(up, down)", () => {
    for (const [up, down] of [
      [0, 0],
      [1000, 0],
      [1000, 500],
      [500, 1000],
      [750, 750],
    ] as const) {
      const inv = computeInventory({
        upShares: up,
        downShares: down,
        avgUpEntry: 0.99,
        avgDownEntry: 0.005,
      });
      expect(inv.pairedShares).toBe(Math.min(up, down));
      expect(inv.unpairedUpShares + inv.pairedShares).toBe(up);
      expect(inv.unpairedDownShares + inv.pairedShares).toBe(down);
    }
  });
});

describe("the accumulate-winner-plus-cheap-tail state", () => {
  // Section 19: 1000 UP near the top, 500 DOWN as cheap tail inventory.
  const inv = computeInventory({
    upShares: 1000,
    downShares: 500,
    avgUpEntry: 0.99,
    avgDownEntry: 0.005,
  });

  it("knows both settlement outcomes before adding anything", () => {
    expect(inv.totalCost).toBeCloseTo(992.5, 9);
    expect(inv.pnlIfUp).toBeCloseTo(7.5, 9);
    expect(inv.pnlIfDown).toBeCloseTo(-492.5, 9);
  });

  it("reports the collateral a merge would return", () => {
    expect(inv.pairedShares).toBe(500);
    expect(inv.mergeableCollateral).toBeCloseTo(500, 9);
  });

  it("separates locked-in pair profit from the directional bet", () => {
    // 500 pairs bought for .99 + .005 and redeemable at 1.00.
    expect(inv.guaranteedPairPnl).toBeCloseTo(2.5, 9);
  });

  it("bounds the settlement value", () => {
    expect(inv.worstCaseSettlementValue).toBe(500);
    expect(inv.bestCaseSettlementValue).toBe(1000);
  });
});

describe("a flat book", () => {
  it("has no cost, no pnl and no NaN", () => {
    const inv = computeInventory(EMPTY_POSITION);
    expect(inv.totalCost).toBe(0);
    expect(inv.pnlIfUp).toBe(0);
    expect(inv.pnlIfDown).toBe(0);
    expect(inv.guaranteedPairPnl).toBe(0);
    expect(Number.isNaN(inv.avgUpEntry)).toBe(false);
  });
});

describe("fills", () => {
  it("keeps a weighted average entry", () => {
    let p = applyFill(EMPTY_POSITION, "UP", 100, 0.98);
    p = applyFill(p, "UP", 300, 0.99);
    expect(p.upShares).toBe(400);
    // (100*.98 + 300*.99) / 400
    expect(p.avgUpEntry).toBeCloseTo(0.9875, 9);
  });

  it("ignores a zero or negative fill", () => {
    expect(applyFill(EMPTY_POSITION, "UP", 0, 0.9)).toEqual(EMPTY_POSITION);
    expect(applyFill(EMPTY_POSITION, "DOWN", -5, 0.9)).toEqual(EMPTY_POSITION);
  });
});

describe("merge", () => {
  const position = {
    upShares: 1000,
    downShares: 500,
    avgUpEntry: 0.99,
    avgDownEntry: 0.005,
  };

  it("removes matched shares from both sides", () => {
    const after = applyMerge(position, 500);
    expect(after.upShares).toBe(500);
    expect(after.downShares).toBe(0);
  });

  it("cannot merge more than the matched quantity", () => {
    const after = applyMerge(position, 9999);
    expect(after.upShares).toBe(500);
    expect(after.downShares).toBe(0);
  });

  it("leaves the remaining directional bet intact", () => {
    const after = computeInventory(applyMerge(position, 500));
    expect(after.pairedShares).toBe(0);
    expect(after.unpairedUpShares).toBe(500);
    // 500 shares still held at .99.
    expect(after.totalCost).toBeCloseTo(495, 9);
    expect(after.pnlIfUp).toBeCloseTo(5, 9);
  });
});
