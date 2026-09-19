import { describe, expect, it } from "vitest";
import type { ChoiceResponse } from "@typesafe-ai/sdk";
import { computeEdge, directionalProbability } from "../../src/analytics/edge-analysis.js";

const direction = (probabilities: Record<string, number>): ChoiceResponse =>
  ({
    type: "choice",
    choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0],
    confidence: 0.9,
    probabilities,
  }) as unknown as ChoiceResponse;

describe("renormalising away UNRESOLVED", () => {
  it("compares like with like against a binary price", () => {
    const d = directionalProbability(
      direction({ UP: 0.6, DOWN: 0.2, UNRESOLVED: 0.2 }),
    );
    // Without renormalising this would read 0.60 against a market that has no
    // UNRESOLVED outcome to price.
    expect(d.pUp).toBeCloseTo(0.75, 9);
    expect(d.pDown).toBeCloseTo(0.25, 9);
    expect(d.unresolvedMass).toBeCloseTo(0.2, 9);
    expect(d.usable).toBe(true);
  });

  it("always sums to one across the two tradable outcomes", () => {
    const d = directionalProbability(
      direction({ UP: 0.02, DOWN: 0.02, UNRESOLVED: 0.96 }),
    );
    expect(d.pUp + d.pDown).toBeCloseTo(1, 9);
    // Arithmetically fine, strategically meaningless - the caller can see why.
    expect(d.unresolvedMass).toBeCloseTo(0.96, 9);
  });

  it("marks an all-UNRESOLVED answer unusable instead of dividing by zero", () => {
    const d = directionalProbability(direction({ UP: 0, DOWN: 0, UNRESOLVED: 1 }));
    expect(d.usable).toBe(false);
    expect(Number.isNaN(d.pUp)).toBe(false);
    expect(d.pUp).toBe(0.5);
  });
});

describe("edge is not profit", () => {
  const dir = direction({ UP: 0.75, DOWN: 0.05, UNRESOLVED: 0.2 });

  it("measures probability against the executable price", () => {
    const e = computeEdge({
      direction: dir,
      executableUpPrice: 0.9,
      executableDownPrice: 0.11,
    });
    // renormalised pUp = .75/.80 = .9375
    expect(e.pUp).toBeCloseTo(0.9375, 9);
    expect(e.jevEdgeUp).toBeCloseTo(0.0375, 9);
  });

  it("subtracts fees and scales by fill probability", () => {
    const e = computeEdge({
      direction: dir,
      executableUpPrice: 0.9,
      executableDownPrice: 0.11,
      feePerShare: 0.01,
      fillProbability: 0.5,
    });
    // (0.0375 - 0.01) * 0.5
    expect(e.effectiveEdge).toBeCloseTo(0.01375, 9);
  });

  it("does not improve a negative edge by making it less likely to fill", () => {
    const e = computeEdge({
      direction: dir,
      executableUpPrice: 0.99,
      executableDownPrice: 0.5,
      feePerShare: 0.01,
      fillProbability: 0.1,
    });
    expect(e.effectiveEdge).toBeLessThan(0);
  });

  it("clamps an out-of-range fill probability", () => {
    const e = computeEdge({
      direction: dir,
      executableUpPrice: 0.9,
      executableDownPrice: 0.11,
      fillProbability: 5,
    });
    expect(e.effectiveEdge).toBeCloseTo(0.0375, 9);
  });
});
