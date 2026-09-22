import { describe, expect, it } from "vitest";
import { animalJevPolicyCall, focusedState, HEDGE_PULLED_QUESTION, HEDGE_RESTING_QUESTION, TAIL_QUESTION } from "../../src/jev/policy-animal-jev.js";
import type { FocusedAsk } from "../../src/jev/client.js";
import type { JevInputState } from "../../src/jev/decision-types.js";
import { QUESTIONS } from "../../src/jev/questions.js";

const base: JevInputState = {
  market: { openedAtMs: 1_790_000_000_000, secondsRemaining: 90, settlementStartPrice: 85000, settlementCurrentPrice: 84990, distanceUsd: -10, distanceBps: -1.2, spotPrice: 84988, spotVsTwapBps: -0.2, leadHeldRate: 0.97, leadHeldSamples: 40 },
  movement: { return1s: 0, return3s: 0, return5s: 0, return10s: 0, return30s: 0, realizedVol5s: 0, realizedVol10s: 0, realizedVol30s: 0 },
  orderbook: { upBid: 0.0, upAsk: 0.01, downBid: 0.99, downAsk: 1, upDepth: 5000, downDepth: 0, pairAskCost: 1.01, pairExecutableQty: 0, pairEdge: -0.01, upSpread: 0.01, downSpread: 0.01, imbalanceUp: 0, imbalanceDown: 0, leader: "DOWN", leaderAsk: 1, leaderAskDepth: 0, tailAsk: 0.01, tailAskDepth: 5000 },
  inventory: { upShares: 0, downShares: 0, avgUpEntry: 0, avgDownEntry: 0, pairedShares: 0, unpairedUpShares: 0, unpairedDownShares: 0, pnlIfUp: 0, pnlIfDown: 0, guaranteedPairPnl: 0, hedgePriceCap: null, hedgeAvailable: false, openOrders: 0 },
  dataQuality: { chainlinkAgeMs: 100, bookAgeMs: 20 },
};
const st = (over: { market?: Partial<JevInputState["market"]>; orderbook?: Partial<JevInputState["orderbook"]>; inventory?: Partial<JevInputState["inventory"]> }): JevInputState => ({
  ...base, market: { ...base.market, ...over.market }, orderbook: { ...base.orderbook, ...over.orderbook }, inventory: { ...base.inventory, ...over.inventory },
});
const holdingTail = st({ inventory: { upShares: 100, unpairedUpShares: 100, avgUpEntry: 0.01, hedgePriceCap: 0.99, openOrders: 1 } });

/** A scripted Jev: answers by question name, records what it was asked. */
function scripted(answers: Record<string, string | string[]>) {
  const asked: { name: string; state: Record<string, unknown> }[] = [];
  const ask: FocusedAsk = async (name, _q, state) => {
    asked.push({ name, state });
    const a = answers[name];
    const c = Array.isArray(a) ? (a.shift() ?? "WAIT") : (a ?? "WAIT");
    return { choice: c, confidence: 0.8, probabilities: { [c]: 0.8 }, model: "jev-test", usage: { input_tokens: 10, output_tokens: 1 }, latencyMs: 250 };
  };
  return { ask, asked };
}
let mono = 0;
const call = (ask: FocusedAsk) => animalJevPolicyCall({ ask, now: () => mono });
const run = (c: ReturnType<typeof call>, s: JevInputState) => c(s, QUESTIONS, new AbortController().signal);

describe("policy-animal-jev: the tail question", () => {
  it("asks only when the tail is at 0.01 inside the window, and buys with PAIR on TAKE_NOW", async () => {
    const { ask, asked } = scripted({ tail: "TAKE_NOW" });
    const c = call(ask);
    expect((await run(c, st({ market: { secondsRemaining: 200 } }))).answers.note).toBe("before the window");
    expect((await run(c, st({ orderbook: { tailAsk: 0.02 } }))).answers.note).toBe("tail not at 0.01");
    expect(asked).toHaveLength(0);
    const r = await run(c, base);
    expect(r.answers.action.choice).toBe("BUY_UP");
    expect(r.answers.inventory_action.choice).toBe("PAIR");
    expect(r.answers.focused).toMatchObject({ name: "tail", choice: "TAKE_NOW", latencyMs: 250 });
    expect(r.model).toBe("policy-animal-jev");
    expect(r.usage.input_tokens).toBe(10);
    expect(asked[0]?.state).toMatchObject({ secondsRemaining: 90, leader: "DOWN", tailAsk: 0.01, leaderAsk: null, hedgeBidResting: false });
    // Rejected by the gate (state still flat): asked again. Once the order is seen: once per market, no second question.
    expect((await run(c, base)).answers.action.choice).toBe("BUY_UP");
    expect(asked).toHaveLength(2);
    await run(c, st({ inventory: { openOrders: 1 } }));
    expect((await run(c, base)).answers.note).toBe("tail already bought this market");
    expect(asked).toHaveLength(2);
  });

  it("WAIT asks again on the next change; SKIP is final for the market and a new market starts afresh", async () => {
    const { ask, asked } = scripted({ tail: ["WAIT", "SKIP"] });
    const c = call(ask);
    expect((await run(c, base)).answers.note).toBe("jev: wait");
    expect((await run(c, base)).answers.note).toBe("jev: skip this market");
    expect((await run(c, base)).answers.note).toBe("jev skipped this market");
    expect(asked).toHaveLength(2);
    const next = st({ market: { openedAtMs: base.market.openedAtMs + 300_000 } });
    await run(c, next);
    expect(asked).toHaveLength(3);
  });

  it("does not ask without a leader, too late, or with a tail order in flight", async () => {
    const { ask, asked } = scripted({ tail: "TAKE_NOW" });
    const c = call(ask);
    expect((await run(c, st({ orderbook: { leader: null } }))).answers.action.choice).toBe("HOLD");
    expect((await run(c, st({ market: { secondsRemaining: 5 } }))).answers.action.choice).toBe("HOLD");
    expect((await run(c, st({ inventory: { openOrders: 1 } }))).answers.note).toBe("tail order in flight");
    expect(asked).toHaveLength(0);
  });
});

describe("policy-animal-jev: the hedge question", () => {
  it("keeps or pulls the resting bid on Jev's word, re-bids or stays once pulled, and never asks more than once a second", async () => {
    const { ask, asked } = scripted({ hedge: ["PULL_BID", "STAY_UNHEDGED", "REBID", "KEEP_BID"] });
    const c = call(ask);
    mono = 0;
    let r = await run(c, holdingTail);
    expect(r.answers.action.choice).toBe("CANCEL");
    expect(r.answers.focused?.name).toBe("hedge");
    expect(asked[0]?.state).toMatchObject({ tailShares: 100, tailEntry: 0.01, hedgePriceCap: 0.99, hedgeBidResting: true });
    mono = 500;
    expect((await run(c, holdingTail)).answers.note).toBe("hedge question asked recently");
    mono = 1500;
    r = await run(c, st({ inventory: { ...holdingTail.inventory, openOrders: 0 } }));
    expect(r.answers.action.choice).toBe("HOLD");
    expect(r.answers.note).toBe("jev: stay unhedged");
    mono = 3000;
    r = await run(c, st({ inventory: { ...holdingTail.inventory, openOrders: 0 } }));
    expect(r.answers.action.choice).toBe("ADD_COMPLEMENT");
    expect(r.answers.inventory_action.choice).toBe("PAIR");
    mono = 4500;
    expect((await run(c, holdingTail)).answers.note).toBe("jev: keep the hedge bid");
    expect(asked.map((a) => a.name)).toEqual(["hedge", "hedge", "hedge", "hedge"]);
  });

  it("forces the bid back under the time floor without asking, and merges a paired set", async () => {
    const { ask, asked } = scripted({ hedge: "STAY_UNHEDGED" });
    const c = call(ask);
    const late = st({ market: { secondsRemaining: 6 }, inventory: { ...holdingTail.inventory, openOrders: 0 } });
    expect((await run(c, late)).answers.action.choice).toBe("ADD_COMPLEMENT");
    expect((await run(c, st({ market: { secondsRemaining: 6 }, inventory: holdingTail.inventory }))).answers.note).toBe("hedge bid resting (floor)");
    expect(asked).toHaveLength(0);
    const paired = st({ inventory: { upShares: 100, downShares: 100, pairedShares: 100 } });
    expect((await run(c, paired)).answers.inventory_action.choice).toBe("MERGE");
  });

  it("lets a failing Jev call propagate (the observer counts it, the kill switch decides)", async () => {
    const c = call(async () => { throw new Error("upstream 503"); });
    await expect(run(c, base)).rejects.toThrow("upstream 503");
  });
});

describe("policy-animal-jev: questions", () => {
  it("are choice questions with the options the policy maps", () => {
    expect(Object.keys(TAIL_QUESTION.criteria)).toEqual(["TAKE_NOW", "WAIT", "SKIP"]);
    expect(Object.keys(HEDGE_RESTING_QUESTION.criteria)).toEqual(["KEEP_BID", "PULL_BID"]);
    expect(Object.keys(HEDGE_PULLED_QUESTION.criteria)).toEqual(["REBID", "STAY_UNHEDGED"]);
    expect(focusedState(base)).toMatchObject({ spotOnLeaderSide: true, leadHeldMarkets: 40 });
    expect(focusedState(st({ market: { spotVsTwapBps: 0.4 } })).spotOnLeaderSide).toBe(false);
  });
});
