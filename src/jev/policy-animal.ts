import type { JevCall } from "./decision-engine.js";
import type { JevAnswers, JevInputState } from "./decision-types.js";

/**
 * A deterministic stand-in for Jev that plays the pattern measured on
 * wallet 0x55aeeb3e (docs/JEV_DECISIONS.md): buy the trailing side while it
 * costs a cent or two, bid for the leading side at 1.00 minus the tail's
 * price and let holders sell into that bid, merge. It exists as a BENCHMARK
 * for the paper comparison (brief §19, §45): whether Jev's timing adds
 * anything is measurable only against the mechanical version on the same
 * markets.
 *
 * Measured, not assumed: late in a market the leader's ask side is empty;
 * the trader's hedges (39 of 40 checked against our books) were maker fills
 * of a resting 0.99 bid. So the copy does not wait for a hedge to be
 * offered: it buys the tail, rests the hedge at the cap at once, and keeps
 * that bid until the close.
 *
 * Two variants:
 *   plain - the copy: tail at 0.01 as soon as it is offered inside the
 *           window, hedge bid at 0.99 at once, merge.
 *   plus  - the copy with two measured changes: the hedge bid is pulled
 *           while spot is on the tail's side of the start price (a reversal
 *           under way, the case that made his 21 large wins) and there is
 *           still time; and the tail is also taken earlier when the measured
 *           reversal rate exceeds its price.
 *
 * Nothing here calls the network; the answers have the same shape as Jev's
 * so the observer, gate, engines and analytics treat them identically. The
 * model name "policy-animal[-plus]" marks every record they produce.
 */
export interface AnimalPolicyOptions {
  readonly variant: "plain" | "plus";
  /** Seconds before the close inside which the tail is bought. Default 110 (the measured median was 64, p90 125). */
  readonly tailWindowS?: number;
  /**
   * Most the tail may cost. Default 0.01: a tail at 0.02 puts the hedge cap
   * at 0.98, one tick BELOW the 0.99 level where the leader's bids and all
   * the taker sells are, and such a bid never fills (measured 22 markets,
   * 2 fills). The reference trader pays 0.01 and bids 0.99, always.
   */
  readonly tailMaxPrice?: number;
  /** Stop initiating anything this close to the close. Default 8 s. */
  readonly noNewAfterS?: number;
  /** plus: hedge at the latest with this many seconds left, reversal or not. Default 12. */
  readonly hedgeLatestS?: number;
  /** Tails per market. Default 1: the reference trader buys once; re-buying after every merge multiplied the copy's unhedged tails. */
  readonly maxTailsPerMarket?: number;
  /** Tails already bought in this market (kept by the call wrapper); the pure policy only reads it. */
  readonly tailsBought?: number;
}

export const pick = <T extends string>(c: T, others: readonly T[], confidence = 0.9) => ({
  type: "choice" as const, choice: c, confidence,
  probabilities: Object.fromEntries([[c, confidence], ...others.filter((o) => o !== c).map((o) => [o, (1 - confidence) / Math.max(1, others.length - 1)])]) as Record<string, number>,
});
export const score = (s: number) => ({ type: "score" as const, score: s, confidence: 0.8, legend: {}, probabilities: {} as Record<string, number> });
export const ACTIONS = ["BUY_UP", "BUY_DOWN", "BUY_PAIR", "ADD_COMPLEMENT", "HOLD", "CANCEL", "ABSTAIN"] as const;
export const INV = ["NONE", "ADD_UP", "ADD_DOWN", "PAIR", "MERGE", "REDUCE_RISK"] as const;
export const URG = ["PASSIVE", "NORMAL", "URGENT", "IMMEDIATE"] as const;

export interface PolicyDecision { readonly action: (typeof ACTIONS)[number]; readonly inventory: (typeof INV)[number]; readonly urgency: (typeof URG)[number]; readonly why: string }

/** The policy itself, pure: state in, intent out. */
export function animalPolicy(s: JevInputState, o: AnimalPolicyOptions): PolicyDecision {
  const tailWindow = o.tailWindowS ?? 110, tailMax = o.tailMaxPrice ?? 0.01, noNewAfter = o.noNewAfterS ?? 8, hedgeLatest = o.hedgeLatestS ?? 12;
  const { market: m, orderbook: b, inventory: inv } = s;
  const leader = b.leader;
  const unpairedUp = inv.unpairedUpShares, unpairedDown = inv.unpairedDownShares;

  // 1. Something unpaired: the hedge bid rests at the cap (the builder prices it) until it fills or the market closes.
  if (unpairedUp > 0 || unpairedDown > 0) {
    if (o.variant === "plus" && m.secondsRemaining > hedgeLatest && m.settlementStartPrice > 0) {
      // Reversal under way: spot has crossed to the tail's side of the start price. Keep the option open: no hedge bid.
      const tailSide = unpairedUp > 0 ? "UP" : "DOWN";
      const spotSide = m.spotPrice >= m.settlementStartPrice ? "UP" : "DOWN";
      if (spotSide === tailSide) {
        return inv.openOrders > 0
          ? { action: "CANCEL", inventory: "NONE", urgency: "IMMEDIATE", why: "reversal under way: pull the hedge bid, keep the option open" }
          : { action: "HOLD", inventory: "NONE", urgency: "NORMAL", why: "reversal under way: no hedge bid while spot is on the tail's side" };
      }
    }
    if (inv.openOrders > 0) return { action: "HOLD", inventory: "NONE", urgency: "NORMAL", why: "hedge bid resting" };
    return { action: "ADD_COMPLEMENT", inventory: "PAIR", urgency: "IMMEDIATE", why: inv.hedgeAvailable ? "hedge offered under the cap: take it" : "rest the hedge bid at the cap" };
  }
  // 2. Paired and nothing open: merge, then stay out.
  if (inv.pairedShares > 0) return { action: "HOLD", inventory: "MERGE", urgency: "NORMAL", why: "merge the set" };
  if (inv.upShares > 0 || inv.downShares > 0) return { action: "HOLD", inventory: "NONE", urgency: "NORMAL", why: "position held" };
  if (inv.openOrders > 0) return { action: "HOLD", inventory: "NONE", urgency: "NORMAL", why: "tail order in flight" };
  if ((o.tailsBought ?? 0) >= (o.maxTailsPerMarket ?? 1)) return { action: "HOLD", inventory: "NONE", urgency: "NORMAL", why: "tail already bought this market" };
  // 3. Flat: buy the tail inside the window while it is cheap.
  if (!leader || m.secondsRemaining < noNewAfter) return { action: "HOLD", inventory: "NONE", urgency: "NORMAL", why: "no leader or too late" };
  const tailSide = leader === "UP" ? "DOWN" : "UP";
  const cheap = b.tailAsk > 0 && b.tailAsk <= tailMax + 1e-9 && b.tailAskDepth > 0;
  const inWindow = m.secondsRemaining <= tailWindow;
  // plus: earlier too, when the measured reversal rate is worth more than the tail costs.
  const reversalWorthIt = o.variant === "plus" && m.leadHeldRate !== null && (1 - m.leadHeldRate) > b.tailAsk + 0.01 && b.tailAsk <= 0.05;
  if (cheap && (inWindow || reversalWorthIt)) {
    // PAIR: the engine places the hedge bid the instant the tail fills (measured: waiting for the next decision put 10-25k shares ahead of it).
    return { action: tailSide === "UP" ? "BUY_UP" : "BUY_DOWN", inventory: "PAIR", urgency: "NORMAL", why: reversalWorthIt && !inWindow ? "tail early: measured reversal rate exceeds its price" : "tail inside the window" };
  }
  return { action: "HOLD", inventory: "NONE", urgency: "NORMAL", why: cheap ? "outside the window" : "tail not cheap" };
}

/** Wraps the policy as a JevCall so the whole pipeline runs unchanged. */
export function animalPolicyCall(o: AnimalPolicyOptions): JevCall {
  const model = `policy-animal${o.variant === "plus" ? "-plus" : ""}`;
  // Tails bought per market (by the market's open), so the copy buys once like the trader does.
  const tails = new Map<number, number>();
  return async (state) => {
    const key = state.market.openedAtMs;
    for (const k of tails.keys()) if (k < key - 3_600_000) tails.delete(k);
    // Counted when the position (or an order in flight) is SEEN, not when the intent is emitted:
    // an intent the gate rejects must not use up the market's one tail.
    const inv = state.inventory;
    if (inv.upShares > 0 || inv.downShares > 0 || inv.openOrders > 0) tails.set(key, Math.max(1, tails.get(key) ?? 0));
    const d = animalPolicy(state, { ...o, tailsBought: tails.get(key) ?? 0 });
    return { answers: policyAnswers(d, state), model, usage: { input_tokens: 0, output_tokens: 0 } };
  };
}

/** A policy decision in Jev's answer shape, so observer, gate, engines and analytics treat it like any other. */
export function policyAnswers(d: PolicyDecision, state: JevInputState): JevAnswers {
  const leader = state.orderbook.leader ?? "UP";
  const pLead = state.market.leadHeldRate ?? 0.5;
  return {
    action: pick(d.action, ACTIONS),
    settlement_direction: { type: "choice", choice: leader, confidence: pLead, probabilities: { UP: leader === "UP" ? pLead : 1 - pLead, DOWN: leader === "DOWN" ? pLead : 1 - pLead, UNRESOLVED: 0 } } as unknown as JevAnswers["settlement_direction"],
    market_mispricing: pick("NONE", ["UP_UNDERVALUED", "DOWN_UNDERVALUED", "PAIR_UNDERVALUED", "NONE", "UNCERTAIN"]),
    inventory_action: pick(d.inventory, INV),
    execution_urgency: pick(d.urgency, URG),
    winner_confidence: score(3), reversal_risk: score(1), adverse_selection_risk: score(1),
    note: d.why,
  } as unknown as JevAnswers;
}
