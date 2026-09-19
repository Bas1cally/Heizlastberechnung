import type { ChoiceResponse } from "@typesafe-ai/sdk";

/**
 * Jev's directional probability, renormalised for comparison with a price.
 *
 * `settlement_direction` has three outcomes: UP, DOWN and UNRESOLVED. The
 * market price of the UP token is a probability over two outcomes only. Using
 * `probabilities.UP` directly against it compares different denominators:
 * UNRESOLVED holds probability mass that the market has no place to put, so
 * every edge would be biased downward by exactly that mass, and the bias would
 * be largest early in the market when UNRESOLVED is largest.
 *
 * Renormalising over UP and DOWN removes that bias. `unresolvedMass` is
 * returned so callers can stand down when the judgment is mostly "too early to
 * call" - a renormalised 0.5/0.5 from a 0.02/0.02/0.96 answer is arithmetically
 * fine and strategically meaningless.
 */
export interface DirectionalProbability {
  readonly pUp: number;
  readonly pDown: number;
  readonly unresolvedMass: number;
  /** False when UP and DOWN carry no meaningful mass at all. */
  readonly usable: boolean;
}

export function directionalProbability(
  answer: ChoiceResponse,
): DirectionalProbability {
  const probabilities = answer.probabilities as Readonly<Record<string, number>>;
  const up = probabilities["UP"] ?? 0;
  const down = probabilities["DOWN"] ?? 0;
  const directional = up + down;

  if (!(directional > 1e-9)) {
    return { pUp: 0.5, pDown: 0.5, unresolvedMass: 1, usable: false };
  }

  return {
    pUp: up / directional,
    pDown: down / directional,
    unresolvedMass: Math.max(0, 1 - directional),
    usable: true,
  };
}

export interface EdgeInput {
  readonly direction: ChoiceResponse;
  /** Depth-weighted price actually payable for the intended size. */
  readonly executableUpPrice: number;
  readonly executableDownPrice: number;
  /** Per-share costs that eat the edge before it is realised. */
  readonly feePerShare?: number;
  /** Probability the order actually fills, in [0,1]. */
  readonly fillProbability?: number;
}

export interface EdgeResult {
  readonly pUp: number;
  readonly pDown: number;
  readonly unresolvedMass: number;
  /** Raw probability minus executable price. Not a profit. */
  readonly jevEdgeUp: number;
  readonly jevEdgeDown: number;
  /** The best raw edge after fees, scaled by the chance of being filled. */
  readonly effectiveEdge: number;
  readonly usable: boolean;
}

/**
 * The raw difference between a probability and a price is not profit: it is
 * not fee-adjusted, and it is only realised if the order fills.
 */
export function computeEdge(input: EdgeInput): EdgeResult {
  const {
    direction,
    executableUpPrice,
    executableDownPrice,
    feePerShare = 0,
    fillProbability = 1,
  } = input;

  const { pUp, pDown, unresolvedMass, usable } = directionalProbability(direction);

  const jevEdgeUp = pUp - executableUpPrice;
  const jevEdgeDown = pDown - executableDownPrice;

  const best = Math.max(jevEdgeUp, jevEdgeDown);
  const afterFees = best - feePerShare;
  const clampedFill = Math.min(1, Math.max(0, fillProbability));

  return {
    pUp,
    pDown,
    unresolvedMass,
    jevEdgeUp,
    jevEdgeDown,
    // A negative edge is not improved by being less likely to fill.
    effectiveEdge: usable && afterFees > 0 ? afterFees * clampedFill : afterFees,
    usable,
  };
}
