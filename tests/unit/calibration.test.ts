import { describe, expect, it } from "vitest";
import { brierScore, calibrationByConfidence, calibrationByTime, edgeByPrice, naiveEdge, toCsv, type Observation } from "../../src/analytics/calibration.js";

const ob = (pUp: number, outcomeUp: boolean, over: Partial<Observation> = {}): Observation => ({
  pUp, unresolvedMass: 0.1, outcomeUp, secondsRemaining: 100, upAsk: 0.6, downAsk: 0.41, action: "HOLD", marketId: "m", ...over,
});

describe("calibration by confidence", () => {
  it("scores the favoured side, so a 0.02 UP call is a 98% DOWN call", () => {
    const rows = calibrationByConfidence([ob(0.02, false), ob(0.02, false), ob(0.98, true), ob(0.98, false)]);
    const r = rows.find((x) => x.bucket === "97.5-99%")!;
    expect(r.n).toBe(4);
    expect(r.predicted).toBeCloseTo(0.98, 9);
    expect(r.observed).toBe(0.75);
    expect(r.calibrationError).toBeCloseTo(-0.23, 9); // overconfident
  });

  it("leaves empty buckets as NaN rather than inventing zeros", () => {
    const rows = calibrationByConfidence([ob(0.55, true)]);
    expect(rows.find((x) => x.bucket === "99%+")!.n).toBe(0);
    expect(Number.isNaN(rows.find((x) => x.bucket === "99%+")!.observed)).toBe(true);
  });
});

describe("brier score", () => {
  it("is 0 for perfect and 1 for perfectly wrong", () => {
    expect(brierScore([ob(1, true), ob(0, false)])).toBe(0);
    expect(brierScore([ob(1, false), ob(0, true)])).toBe(1);
    expect(brierScore([ob(0.5, true)])).toBe(0.25);
  });
});

describe("calibration by time", () => {
  it("assigns the brief's segments", () => {
    const rows = calibrationByTime([ob(0.9, true, { secondsRemaining: 250 }), ob(0.9, true, { secondsRemaining: 1.5 })]);
    expect(rows.find((x) => x.bucket === "300-120s")!.n).toBe(1);
    expect(rows.find((x) => x.bucket === "<2s")!.n).toBe(1);
  });
});

describe("naive edge", () => {
  it("is an upper bound: buy the favoured side at its ask, pay it when wrong", () => {
    expect(naiveEdge(ob(0.8, true))).toEqual({ side: "UP", ask: 0.6, won: true, executable: true, pnl: expect.closeTo(0.4, 9), jevEdge: expect.closeTo(0.2, 9) });
    expect(naiveEdge(ob(0.8, false)).pnl).toBe(-0.6);
    expect(naiveEdge(ob(0.2, false))).toEqual({ side: "DOWN", ask: 0.41, won: true, executable: true, pnl: expect.closeTo(0.59, 9), jevEdge: expect.closeTo(0.39, 9) });
    // An empty ask side (recorded as 1.0) is not a price: the call still counts for accuracy, not for pnl.
    const empty = naiveEdge(ob(0.99, true, { upAsk: 1 }));
    expect(empty).toMatchObject({ won: true, executable: false });
    expect(Number.isNaN(empty.pnl)).toBe(true);
  });

  it("segments by the ask actually payable", () => {
    const rows = edgeByPrice([ob(0.99, true, { upAsk: 0.98 }), ob(0.6, false, { upAsk: 0.55 })]);
    expect(rows.find((x) => x.bucket === "0.97-0.995")!.meanPnl).toBeCloseTo(0.02, 9);
    expect(rows.find((x) => x.bucket === "0.50-0.70")!.meanPnl).toBeCloseTo(-0.55, 9);
  });
});

describe("csv", () => {
  it("writes numbers with fixed precision and blanks for NaN", () => {
    expect(toCsv([{ a: "x", b: 0.5, c: NaN }])).toBe("a,b,c\nx,0.50000,\n");
  });
});
