/**
 * Thresholds live here, not in the questions.
 *
 * Judgments stay raw and reusable; policy turns them into behaviour. Changing
 * a threshold or a weight is then a code change with no new inference, as long
 * as the evidence and the question meanings are unchanged.
 *
 * Pick the numbers by evaluating them on your own data and the cost of being
 * wrong in each direction - they are not properties of the model.
 */

import type { NoulAnswer } from "./types.js";

export type Band = "act" | "review" | "ignore";

export interface Thresholds {
  /** At or above this probability, act automatically. */
  readonly act: number;
  /** At or above this probability (but below `act`), send it to a human. */
  readonly review: number;
}

/**
 * Split a noul probability into act / review / ignore.
 *
 * The middle band is the useful part: a probability near 0.5 means yes and no
 * are close to equally likely, which is exactly the case a person should see
 * rather than a coin flip in code.
 */
export function band(answer: NoulAnswer, thresholds: Thresholds): Band {
  if (thresholds.act < thresholds.review) {
    throw new RangeError(
      `act threshold (${thresholds.act}) must not be below review threshold (${thresholds.review})`,
    );
  }
  if (answer.probability >= thresholds.act) return "act";
  if (answer.probability >= thresholds.review) return "review";
  return "ignore";
}

/**
 * Weighted combination of independent noul probabilities.
 *
 * Suitable for compensating preferences, where a weak signal can be offset by
 * a strong one. It is the wrong shape for an "any serious violation blocks it"
 * rule - express that as separate conditions, not as a weight.
 */
export function weightedScore(
  parts: ReadonlyArray<{ answer: NoulAnswer; weight: number }>,
): number {
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  if (totalWeight <= 0) {
    throw new RangeError("weightedScore needs a positive total weight");
  }
  const weighted = parts.reduce(
    (sum, p) => sum + p.answer.probability * p.weight,
    0,
  );
  return weighted / totalWeight;
}
