/**
 * Thresholds live here, not in the questions.
 *
 * The SDK returns raw judgments; this turns them into behaviour. Keeping the
 * two apart means changing a threshold or a weight is a code change with no
 * new inference, as long as the evidence and the question meanings are
 * unchanged.
 *
 * Pick the numbers by evaluating them on your own data and the cost of being
 * wrong in each direction - they are not properties of the model.
 */

import type { NoulResponse, ScoreResponse } from "@typesafe-ai/sdk";

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
 * The middle band is the point: `noul` near 0.5 means yes and no are about
 * equally likely, which is a case a person should see rather than a coin flip
 * in code. It does not mean "medium intensity".
 */
export function band(answer: NoulResponse, thresholds: Thresholds): Band {
  if (thresholds.act < thresholds.review) {
    throw new RangeError(
      `act threshold (${thresholds.act}) must not be below review threshold (${thresholds.review})`,
    );
  }
  if (answer.noul >= thresholds.act) return "act";
  if (answer.noul >= thresholds.review) return "review";
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
  parts: ReadonlyArray<{ answer: NoulResponse; weight: number }>,
): number {
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  if (totalWeight <= 0) {
    throw new RangeError("weightedScore needs a positive total weight");
  }
  const weighted = parts.reduce((sum, p) => sum + p.answer.noul * p.weight, 0);
  return weighted / totalWeight;
}

/**
 * The rubric description nearest to an expected score.
 *
 * A score is an expected value and may fall between rubric levels, so 1.6 has
 * no exact legend entry. Rounding gives the closest described level, which is
 * what you want for display; keep the raw `score` for ranking and thresholds.
 */
export function nearestLevel(answer: ScoreResponse): string {
  const legend = answer.legend as Readonly<Record<string, unknown>>;
  const levels = Object.keys(legend)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (levels.length === 0) return String(answer.score);

  const nearest = levels.reduce((best, level) =>
    Math.abs(level - answer.score) < Math.abs(best - answer.score) ? level : best,
  );
  const description = legend[String(nearest)];
  return typeof description === "string" ? description : String(nearest);
}

/**
 * Format a probability without overstating it.
 *
 * `toFixed(2)` turns 0.9996 into "1.00", which reads as certainty. A routing
 * decision made on that misreads the model. This keeps the distinction between
 * "exactly 1" and "very close to 1" visible.
 */
export function formatProbability(p: number): string {
  if (!Number.isFinite(p)) return String(p);
  if (p >= 1) return "1";
  if (p <= 0) return "0";
  if (p > 0.999) return ">0.999";
  if (p < 0.001) return "<0.001";
  return p.toFixed(3);
}
