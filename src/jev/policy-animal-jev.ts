import { choice, type ChoiceQuestion } from "@typesafe-ai/sdk";
import type { JevCall } from "./decision-engine.js";
import type { JevAnswers, JevInputState } from "./decision-types.js";
import type { FocusedAsk } from "./client.js";
import { policyAnswers, type PolicyDecision } from "./policy-animal.js";

/**
 * The reference trader's sequence as the skeleton, Jev at the two moments
 * where a judgment exists (nowhere else):
 *
 *   1. The tail is at 0.01 inside the window: take it now, wait, or skip
 *      this market.
 *   2. The tail is filled and the hedge bid rests (the engine placed it the
 *      instant the tail filled): keep the bid, or pull it because the lead
 *      is reversing; once pulled, re-bid or stay unhedged.
 *
 * Everything else is mechanical and identical to policy-animal: 0.01 only,
 * one tail per market, hedge at 1.00 minus the tail, merge when paired, the
 * bid forced back with 8 s left. The hedge placement itself is never Jev's:
 * the 0.99 level fills with thousands of shares within seconds of opening,
 * and a judgment in that path can only lose the queue.
 *
 * Measured against policy-animal (the same skeleton with fixed rules) on
 * the same markets: that difference, and nothing else, is what Jev adds.
 */
export interface AnimalJevOptions {
  readonly ask: FocusedAsk;
  /** Seconds before the close from which the tail question is put. Default 180 (the copy's fixed window is 110; Jev may go earlier or later). */
  readonly askWindowS?: number;
  readonly tailMaxPrice?: number;
  readonly noNewAfterS?: number;
  /** With this many seconds left the hedge bid is forced regardless of Jev. Default 8. */
  readonly hedgeFloorS?: number;
  /** Re-put the hedge question at most this often (ms). Default 1000. */
  readonly hedgeAskEveryMs?: number;
  readonly now?: () => number;
}

const FACTS = "Facts measured on the reference trader over 1,580 settled markets: his hedge filled in about 75% of markets; 21 markets won on a reversal and made all of his profit (+3,688 USD); 413 markets lost the tail (-2,509 USD); the rest were flat. The hedge bid is filled by other traders buying the tail after us and by holders selling the leader; the 0.99 level fills with thousands of shares within seconds of opening, so an early bid fills and a late one does not.";

export const TAIL_QUESTION: ChoiceQuestion = choice(
  `You decide ONE thing for a mechanical strategy on a Polymarket BTC 5-minute up/down market. The strategy buys the trailing side (the tail) at 0.01 and, the instant it fills, rests a bid for the leading side at 0.99. A filled hedge merges the pair back to 1.00 (net zero). A tail whose hedge never fills before the close loses 0.01 per share. A tail that wins because the lead reverses before the hedge fills pays 1.00 per share. ${FACTS} \`leadHeldRate\` is the measured share of markets in which a lead of this size, with this much time left and spot on this side of the TWAP, held to settlement, from \`leadHeldMarkets\` markets. Decide whether to take the tail now, look again later, or leave this market alone.`,
  {
    TAKE_NOW: "Buy the tail at 0.01 now; the hedge bid at 0.99 goes in the moment it fills.",
    WAIT: "Not now: look again on the next change. The tail may still cost 0.01 later; the 0.99 queue will be longer.",
    SKIP: "No tail in this market at all.",
  },
);

export const HEDGE_RESTING_QUESTION: ChoiceQuestion = choice(
  `You hold the tail (the trailing side) bought at \`tailEntry\` and decide ONE thing: whether the hedge bid for the leading side at \`hedgePriceCap\` stays in the book. While it rests it fills when others buy the tail or sell the leader; a filled hedge ends the market at net zero. Pulling it keeps the reversal option open: if the lead reverses before the close the tail pays 1.00 per share; if it does not, the tail loses its price. A bid pulled and re-placed goes to the back of the 0.99 queue. With 8 seconds left the bid is forced back regardless of you. ${FACTS} The reference trader's 21 large wins were tails that were NOT hedged when the reversal came.`,
  {
    KEEP_BID: "Leave the hedge bid resting; take net zero when it fills.",
    PULL_BID: "Cancel the hedge bid: the lead is reversing and the tail is worth more unhedged.",
  },
);

export const HEDGE_PULLED_QUESTION: ChoiceQuestion = choice(
  `You hold the tail (the trailing side) bought at \`tailEntry\`; its hedge bid was pulled earlier. Decide ONE thing: re-bid for the leading side at \`hedgePriceCap\` now (the bid joins the back of the queue and may or may not fill before the close), or stay unhedged and let the tail ride to settlement. With 8 seconds left the bid is forced back regardless of you. ${FACTS}`,
  {
    REBID: "Put the hedge bid back now.",
    STAY_UNHEDGED: "Stay unhedged: the reversal is on and the tail pays 1.00 if it completes.",
  },
);

/** The compact state the two questions see: what matters, nothing else. */
export function focusedState(s: JevInputState): Record<string, unknown> {
  const { market: m, orderbook: b, inventory: inv, movement: mv } = s;
  const leader = b.leader;
  const tailShares = inv.unpairedUpShares > 0 ? inv.unpairedUpShares : inv.unpairedDownShares;
  const tailEntry = inv.unpairedUpShares > 0 ? inv.avgUpEntry : inv.unpairedDownShares > 0 ? inv.avgDownEntry : null;
  return {
    secondsRemaining: m.secondsRemaining,
    leader,
    twapLeadBps: m.distanceBps,
    spotVsTwapBps: m.spotVsTwapBps,
    spotOnLeaderSide: m.distanceBps === 0 || m.spotVsTwapBps === 0 ? true : Math.sign(m.distanceBps) === Math.sign(m.spotVsTwapBps),
    leadHeldRate: m.leadHeldRate,
    leadHeldMarkets: m.leadHeldSamples,
    return5s: mv.return5s, return10s: mv.return10s, return30s: mv.return30s,
    realizedVol10s: mv.realizedVol10s, realizedVol30s: mv.realizedVol30s,
    tailAsk: b.tailAsk, tailAskDepth: b.tailAskDepth,
    leaderAsk: b.leaderAskDepth > 0 ? b.leaderAsk : null, leaderAskDepth: b.leaderAskDepth,
    tailShares, tailEntry,
    hedgePriceCap: inv.hedgePriceCap,
    hedgeBidResting: inv.openOrders > 0,
    hedgeOfferedNow: inv.hedgeAvailable,
  };
}

interface MarketMemory { tails: number; skipped: boolean; lastHedgeAskMono: number }

/** The policy as a JevCall: skeleton decisions are free; the two questions go to Jev. */
export function animalJevPolicyCall(o: AnimalJevOptions): JevCall {
  const model = "policy-animal-jev";
  const askWindow = o.askWindowS ?? 180, tailMax = o.tailMaxPrice ?? 0.01, noNewAfter = o.noNewAfterS ?? 8, hedgeFloor = o.hedgeFloorS ?? 8, hedgeEvery = o.hedgeAskEveryMs ?? 1_000;
  const now = o.now ?? (() => performance.now());
  const memory = new Map<number, MarketMemory>();
  const mem = (key: number): MarketMemory => {
    for (const k of memory.keys()) if (k < key - 3_600_000) memory.delete(k);
    let m = memory.get(key);
    if (!m) { m = { tails: 0, skipped: false, lastHedgeAskMono: Number.NEGATIVE_INFINITY }; memory.set(key, m); }
    return m;
  };
  const hold = (why: string): PolicyDecision => ({ action: "HOLD", inventory: "NONE", urgency: "NORMAL", why });

  return async (state, _questions, signal) => {
    const { market: m, orderbook: b, inventory: inv } = state;
    const mm = mem(m.openedAtMs);
    let d: PolicyDecision;
    let focused: JevAnswers["focused"] | undefined;
    let usage = { input_tokens: 0, output_tokens: 0 };
    const askJev = async (name: string, q: ChoiceQuestion) => {
      const a = await o.ask(name, q, focusedState(state), signal);
      focused = { name, choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, latencyMs: a.latencyMs, model: a.model };
      usage = { input_tokens: usage.input_tokens + a.usage.input_tokens, output_tokens: usage.output_tokens + a.usage.output_tokens };
      return a.choice;
    };

    const unpaired = inv.unpairedUpShares > 0 || inv.unpairedDownShares > 0;
    if (unpaired) {
      // 2. The hedge decision. Mechanical floor first.
      if (m.secondsRemaining <= hedgeFloor) {
        d = inv.openOrders > 0 ? hold("hedge bid resting (floor)") : { action: "ADD_COMPLEMENT", inventory: "PAIR", urgency: "IMMEDIATE", why: "hedge forced: time floor" };
      } else if (now() - mm.lastHedgeAskMono < hedgeEvery) {
        d = hold("hedge question asked recently");
      } else {
        mm.lastHedgeAskMono = now();
        if (inv.openOrders > 0) {
          const c = await askJev("hedge", HEDGE_RESTING_QUESTION);
          d = c === "PULL_BID" ? { action: "CANCEL", inventory: "NONE", urgency: "IMMEDIATE", why: "jev: pull the hedge bid" } : hold("jev: keep the hedge bid");
        } else {
          const c = await askJev("hedge", HEDGE_PULLED_QUESTION);
          d = c === "REBID" ? { action: "ADD_COMPLEMENT", inventory: "PAIR", urgency: "IMMEDIATE", why: "jev: re-bid the hedge" } : hold("jev: stay unhedged");
        }
      }
    } else if (inv.pairedShares > 0) {
      d = { action: "HOLD", inventory: "MERGE", urgency: "NORMAL", why: "merge the set" };
    } else if (inv.upShares > 0 || inv.downShares > 0) {
      d = hold("position held");
    } else if (inv.openOrders > 0) {
      d = hold("tail order in flight");
    } else if (mm.tails >= 1) {
      d = hold("tail already bought this market");
    } else if (mm.skipped) {
      d = hold("jev skipped this market");
    } else if (!b.leader || m.secondsRemaining < noNewAfter) {
      d = hold("no leader or too late");
    } else if (!(b.tailAsk > 0 && b.tailAsk <= tailMax + 1e-9 && b.tailAskDepth > 0)) {
      d = hold("tail not at 0.01");
    } else if (m.secondsRemaining > askWindow) {
      d = hold("before the window");
    } else {
      // 1. The tail decision.
      const c = await askJev("tail", TAIL_QUESTION);
      if (c === "TAKE_NOW") {
        mm.tails++;
        const tailSide = b.leader === "UP" ? "DOWN" : "UP";
        d = { action: tailSide === "UP" ? "BUY_UP" : "BUY_DOWN", inventory: "PAIR", urgency: "NORMAL", why: "jev: take the tail now" };
      } else if (c === "SKIP") {
        mm.skipped = true;
        d = hold("jev: skip this market");
      } else {
        d = hold("jev: wait");
      }
    }
    const answers: JevAnswers = { ...policyAnswers(d, state), ...(focused ? { focused } : {}) };
    return { answers, model, usage };
  };
}
