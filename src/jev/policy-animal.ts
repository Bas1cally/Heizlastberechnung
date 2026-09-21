import type { JevCall } from "./decision-engine.js";
import type { JevAnswers, JevInputState } from "./decision-types.js";

/**
 * A deterministic stand-in for Jev that plays the pattern measured on
 * wallet 0x55aeeb3e (docs/JEV_DECISIONS.md): buy the trailing side while it
 * costs a cent or two, hedge it with the leading side at no more than
 * 1.00 minus the tail's price, merge. It exists as a BENCHMARK for the
 * paper comparison (brief §19, §45): whether Jev's timing adds anything is
 * measurable only against the mechanical version on the same markets.
 *
 * Two variants:
 *   plain - the copy: tail as soon as it is cheap inside the window, hedge as
 *           soon as the leader is offered under the cap, merge.
 *   plus  - the copy with three measured improvements: the tail is sized to
 *           the hedge depth actually on the book; the hedge waits while spot
 *           is on the tail's side of the start price (a reversal under way)
 *           and there is still time; and the tail is also taken earlier
 *           when the measured reversal rate exceeds its price.
 *
 * Nothing here calls the network; the answers have the same shape as Jev's
 * so the observer, gate, engines and analytics treat them identically. The
 * model name "policy-animal[-plus]" marks every record they produce.
 */
export interface AnimalPolicyOptions {
  readonly variant: "plain" | "plus";
  /** Seconds before the close inside which the tail is bought. Default 110 (the measured median was 64, p90 125). */
  readonly tailWindowS?: number;
  /** Most the tail may cost. Default 0.02. */
  readonly tailMaxPrice?: number;
  /** Stop initiating anything this close to the close. Default 8 s. */
  readonly noNewAfterS?: number;
  /** plus: hedge at the latest with this many seconds left, reversal or not. Default 12. */
  readonly hedgeLatestS?: number;
  /** plus: fewest leader shares on offer for a tail to be worth holding. Default 20. */
  readonly minHedgeDepth?: number;
}

const choice = <T extends string>(c: T, others: readonly T[], confidence = 0.9) => ({
  type: "choice" as const, choice: c, confidence,
  probabilities: Object.fromEntries([[c, confidence], ...others.filter((o) => o !== c).map((o) => [o, (1 - confidence) / Math.max(1, others.length - 1)])]) as Record<string, number>,
});
const score = (s: number) => ({ type: "score" as const, score: s, confidence: 0.8, legend: {}, probabilities: {} as Record<string, number> });
const ACTIONS = ["BUY_UP", "BUY_DOWN", "BUY_PAIR", "ADD_COMPLEMENT", "HOLD", "CANCEL", "ABSTAIN"] as const;
const INV = ["NONE", "ADD_UP", "ADD_DOWN", "PAIR", "MERGE", "REDUCE_RISK"] as const;
const URG = ["PASSIVE", "NORMAL", "URGENT", "IMMEDIATE"] as const;

export interface PolicyDecision { readonly action: (typeof ACTIONS)[number]; readonly inventory: (typeof INV)[number]; readonly urgency: (typeof URG)[number]; readonly why: string }

/** The policy itself, pure: state in, intent out. */
export function animalPolicy(s: JevInputState, o: AnimalPolicyOptions): PolicyDecision {
  const tailWindow = o.tailWindowS ?? 110, tailMax = o.tailMaxPrice ?? 0.02, noNewAfter = o.noNewAfterS ?? 8, hedgeLatest = o.hedgeLatestS ?? 12, minDepth = o.minHedgeDepth ?? 20;
  const { market: m, orderbook: b, inventory: inv } = s;
  const leader = b.leader;
  const unpairedUp = inv.unpairedUpShares, unpairedDown = inv.unpairedDownShares;

  // 1. Something unpaired: hedge it when the leader is offered under the cap.
  if (unpairedUp > 0 || unpairedDown > 0) {
    if (!inv.hedgeAvailable) return { action: "HOLD", inventory: "NONE", urgency: "NORMAL", why: "unpaired, hedge not offered under the cap" };
    if (o.variant === "plus" && m.secondsRemaining > hedgeLatest && m.settlementStartPrice > 0) {
      // Reversal under way: spot has crossed to the tail's side of the start price. Hold the option a little longer.
      const tailSide = unpairedUp > 0 ? "UP" : "DOWN";
      const spotSide = m.spotPrice >= m.settlementStartPrice ? "UP" : "DOWN";
      if (spotSide === tailSide) return { action: "HOLD", inventory: "NONE", urgency: "NORMAL", why: "reversal under way: spot on the tail's side of the start" };
    }
    return { action: "ADD_COMPLEMENT", inventory: "PAIR", urgency: "IMMEDIATE", why: "hedge the tail at no more than the cap" };
  }
  // 2. Paired and nothing open: merge, then stay out.
  if (inv.pairedShares > 0) return { action: "HOLD", inventory: "MERGE", urgency: "NORMAL", why: "merge the set" };
  if (inv.upShares > 0 || inv.downShares > 0) return { action: "HOLD", inventory: "NONE", urgency: "NORMAL", why: "position held" };
  // 3. Flat: buy the tail inside the window while it is cheap and a hedge is on the book.
  if (!leader || m.secondsRemaining < noNewAfter) return { action: "HOLD", inventory: "NONE", urgency: "NORMAL", why: "no leader or too late" };
  const tailSide = leader === "UP" ? "DOWN" : "UP";
  const hedgeCapNow = 1 - b.tailAsk;
  const hedgeOnBook = b.leaderAsk > 0 && b.leaderAsk <= hedgeCapNow + 1e-9 && b.leaderAskDepth >= (o.variant === "plus" ? minDepth : 1);
  const cheap = b.tailAsk > 0 && b.tailAsk <= tailMax;
  const inWindow = m.secondsRemaining <= tailWindow;
  // plus: earlier too, when the measured reversal rate is worth more than the tail costs.
  const reversalWorthIt = o.variant === "plus" && m.leadHeldRate !== null && (1 - m.leadHeldRate) > b.tailAsk + 0.01 && b.tailAsk <= 0.05;
  if (cheap && hedgeOnBook && (inWindow || reversalWorthIt)) {
    return { action: tailSide === "UP" ? "BUY_UP" : "BUY_DOWN", inventory: tailSide === "UP" ? "ADD_UP" : "ADD_DOWN", urgency: "NORMAL", why: reversalWorthIt && !inWindow ? "tail early: measured reversal rate exceeds its price" : "tail inside the window with a hedge on the book" };
  }
  return { action: "HOLD", inventory: "NONE", urgency: "NORMAL", why: cheap ? (hedgeOnBook ? "outside the window" : "no hedge on the book") : "tail not cheap" };
}

/** Wraps the policy as a JevCall so the whole pipeline runs unchanged. */
export function animalPolicyCall(o: AnimalPolicyOptions): JevCall {
  const model = `policy-animal${o.variant === "plus" ? "-plus" : ""}`;
  return async (state) => {
    const d = animalPolicy(state, o);
    const leader = state.orderbook.leader ?? "UP";
    const pLead = state.market.leadHeldRate ?? 0.5;
    const answers: JevAnswers = {
      action: choice(d.action, ACTIONS),
      settlement_direction: { type: "choice", choice: leader, confidence: pLead, probabilities: { UP: leader === "UP" ? pLead : 1 - pLead, DOWN: leader === "DOWN" ? pLead : 1 - pLead, UNRESOLVED: 0 } } as unknown as JevAnswers["settlement_direction"],
      market_mispricing: choice("NONE", ["UP_UNDERVALUED", "DOWN_UNDERVALUED", "PAIR_UNDERVALUED", "NONE", "UNCERTAIN"]),
      inventory_action: choice(d.inventory, INV),
      execution_urgency: choice(d.urgency, URG),
      winner_confidence: score(3), reversal_risk: score(1), adverse_selection_risk: score(1),
    } as unknown as JevAnswers;
    return { answers, model, usage: { input_tokens: 0, output_tokens: 0 } };
  };
}
