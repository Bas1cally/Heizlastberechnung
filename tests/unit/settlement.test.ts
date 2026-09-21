import { describe, expect, it } from "vitest";
import { marketPnl, settle, simulateMerge } from "../../src/inventory/settlement.js";

// The accumulate-winner-plus-tail state from brief §19.
const position = { upShares: 1000, downShares: 500, avgUpEntry: 0.99, avgDownEntry: 0.005 };

describe("merge", () => {
  it("returns 1.00 per matched pair and books the locked-in profit", () => {
    const m = simulateMerge(position, 500)!;
    expect(m.quantity).toBe(500);
    expect(m.collateralReturned).toBe(500);
    expect(m.pairedCostBasis).toBeCloseTo(497.5, 9);
    expect(m.effectivePairPnl).toBeCloseTo(2.5, 9);
    expect(m.position).toEqual({ ...position, upShares: 500, downShares: 0 });
  });

  it("cannot merge more than is paired, and nothing when nothing is paired", () => {
    expect(simulateMerge(position, 9999)!.quantity).toBe(500);
    expect(simulateMerge({ ...position, downShares: 0 }, 10)).toBeUndefined();
  });

  it("subtracts gas from the effective pair pnl", () => {
    expect(simulateMerge(position, 500, 0.4)!.effectivePairPnl).toBeCloseTo(2.1, 9);
  });
});

describe("settlement", () => {
  it("pays the winning side at 1.00 and the losing side nothing", () => {
    const up = settle(position, "UP");
    expect(up.grossPayout).toBe(1000);
    expect(up.netPnl).toBeCloseTo(1000 - 992.5, 9);
    const down = settle(position, "DOWN");
    expect(down.grossPayout).toBe(500);
    expect(down.netPnl).toBeCloseTo(500 - 992.5, 9);
  });
});

describe("market pnl", () => {
  it("merge first, then settle the remainder: the pair profit is outcome-independent", () => {
    const m = simulateMerge(position, 500)!;
    const ifUp = marketPnl([m], settle(m.position, "UP"), 0);
    const ifDown = marketPnl([m], settle(m.position, "DOWN"), 0);
    expect(ifUp.mergePnl).toBeCloseTo(2.5, 9);
    expect(ifDown.mergePnl).toBeCloseTo(2.5, 9);
    // Remaining 500 UP at .99: +5 if UP, -495 if DOWN.
    expect(ifUp.netPnl).toBeCloseTo(7.5, 9);
    expect(ifDown.netPnl).toBeCloseTo(-492.5, 9);
  });

  it("nets fees and gas out of the gross figure", () => {
    const m = simulateMerge(position, 500, 0.5)!;
    const r = marketPnl([m], settle(m.position, "UP", 0.25), 1.0);
    expect(r.grossPnl).toBeCloseTo(7.5, 9);
    expect(r.netPnl).toBeCloseTo(7.5 - 1.0 - 0.75, 9);
  });
});
