import { describe, expect, it } from "vitest";
import { animalPolicy, animalPolicyCall } from "../../src/jev/policy-animal.js";
import type { JevInputState } from "../../src/jev/decision-types.js";
import { QUESTIONS } from "../../src/jev/questions.js";

const ask = (call: ReturnType<typeof animalPolicyCall>, s: JevInputState) => call(s, QUESTIONS, new AbortController().signal);

// Late in a market: DOWN leads at 0.98, UP (the tail) is offered at 0.01 with a hedge on the book.
const base: JevInputState = {
  market: { openedAtMs: 1_790_000_000_000, secondsRemaining: 60, settlementStartPrice: 85000, settlementCurrentPrice: 84990, distanceUsd: -10, distanceBps: -1.2, spotPrice: 84988, spotVsTwapBps: -0.2, leadHeldRate: 0.97, leadHeldSamples: 200 },
  movement: { return1s: 0, return3s: 0, return5s: 0, return10s: 0, return30s: 0, realizedVol5s: 0, realizedVol10s: 0, realizedVol30s: 0 },
  orderbook: { upBid: 0.0, upAsk: 0.01, downBid: 0.97, downAsk: 0.98, upDepth: 5000, downDepth: 400, pairAskCost: 0.99, pairExecutableQty: 400, pairEdge: 0.01, upSpread: 0.01, downSpread: 0.01, imbalanceUp: 0, imbalanceDown: 0, leader: "DOWN", leaderAsk: 0.98, leaderAskDepth: 400, tailAsk: 0.01, tailAskDepth: 5000 },
  inventory: { upShares: 0, downShares: 0, avgUpEntry: 0, avgDownEntry: 0, pairedShares: 0, unpairedUpShares: 0, unpairedDownShares: 0, pnlIfUp: 0, pnlIfDown: 0, guaranteedPairPnl: 0, hedgePriceCap: null, hedgeAvailable: false, openOrders: 0 },
  dataQuality: { chainlinkAgeMs: 100, bookAgeMs: 20 },
};
const st = (over: { market?: Partial<JevInputState["market"]>; orderbook?: Partial<JevInputState["orderbook"]>; inventory?: Partial<JevInputState["inventory"]> }): JevInputState => ({
  ...base, market: { ...base.market, ...over.market }, orderbook: { ...base.orderbook, ...over.orderbook }, inventory: { ...base.inventory, ...over.inventory },
});
const plain = { variant: "plain" as const };
const plus = { variant: "plus" as const };

describe("animalPolicy: flat", () => {
  it("buys the tail inside the window when it is cheap, whether or not the leader is offered", () => {
    const d = animalPolicy(base, plain);
    expect(d.action).toBe("BUY_UP");
    expect(d.inventory).toBe("PAIR"); // the engine hedges the instant the tail fills
    expect(d.urgency).toBe("NORMAL");
    // The measured case: the leader's ask side is empty (recorded as 1.00, depth 0). The hedge will be a resting bid.
    expect(animalPolicy(st({ orderbook: { leaderAsk: 1, leaderAskDepth: 0 } }), plain).action).toBe("BUY_UP");
  });

  it("buys the other tail when UP leads", () => {
    const d = animalPolicy(st({ orderbook: { leader: "UP", upAsk: 0.98, downAsk: 0.01, leaderAsk: 0.98, tailAsk: 0.01 } }), plain);
    expect(d.action).toBe("BUY_DOWN");
    expect(d.inventory).toBe("PAIR");
  });

  it("buys one tail per market", () => {
    expect(animalPolicy(st({}), { ...plain, tailsBought: 1 }).why).toBe("tail already bought this market");
    expect(animalPolicy(st({}), { ...plain, tailsBought: 1, maxTailsPerMarket: 2 }).action).toBe("BUY_UP");
  });

  it("holds outside the window, when the tail is not cheap or has no depth, and while a tail order is in flight", () => {
    expect(animalPolicy(st({ market: { openedAtMs: 1_790_000_000_000, secondsRemaining: 200 } }), plain).why).toBe("outside the window");
    expect(animalPolicy(st({ orderbook: { tailAsk: 0.02 } }), plain).why).toBe("tail not cheap"); // 0.02 would put the hedge a tick below the 0.99 queue
    expect(animalPolicy(st({ orderbook: { tailAskDepth: 0 } }), plain).action).toBe("HOLD");
    expect(animalPolicy(st({ inventory: { openOrders: 1 } }), plain).why).toBe("tail order in flight");
  });

  it("initiates nothing in the last seconds or without a leader", () => {
    expect(animalPolicy(st({ market: { openedAtMs: 1_790_000_000_000, secondsRemaining: 5 } }), plain).action).toBe("HOLD");
    expect(animalPolicy(st({ orderbook: { leader: null } }), plain).action).toBe("HOLD");
  });

  it("plus: takes the tail early when the measured reversal rate exceeds its price, plain does not", () => {
    // 3% of such leads reverse; the tail costs 0.01: worth more than it costs.
    const early = st({ market: { openedAtMs: 1_790_000_000_000, secondsRemaining: 200, leadHeldRate: 0.97 }, orderbook: { tailAsk: 0.01 } });
    expect(animalPolicy(early, plus).action).toBe("BUY_UP");
    expect(animalPolicy(early, plus).why).toMatch(/early/);
    expect(animalPolicy(early, plain).action).toBe("HOLD");
    // 1% reverse: not worth 0.01 plus a cent of margin.
    expect(animalPolicy(st({ market: { openedAtMs: 1_790_000_000_000, secondsRemaining: 200, leadHeldRate: 0.99 }, orderbook: { tailAsk: 0.01 } }), plus).action).toBe("HOLD");
    // No measurement: window only.
    expect(animalPolicy(st({ market: { openedAtMs: 1_790_000_000_000, secondsRemaining: 200, leadHeldRate: null } }), plus).action).toBe("HOLD");
  });
});

describe("animalPolicy: with inventory", () => {
  const unpaired = st({ inventory: { upShares: 100, unpairedUpShares: 100, avgUpEntry: 0.01, hedgePriceCap: 0.99, hedgeAvailable: false } });

  it("asks for the hedge at once, offered or not: the builder rests it at the cap", () => {
    const d = animalPolicy(unpaired, plain);
    expect(d.action).toBe("ADD_COMPLEMENT");
    expect(d.inventory).toBe("PAIR");
    expect(d.urgency).toBe("IMMEDIATE");
    expect(d.why).toMatch(/rest the hedge bid/);
    expect(animalPolicy(st({ inventory: { ...unpaired.inventory, hedgeAvailable: true } }), plain).why).toMatch(/take it/);
  });

  it("holds while the hedge bid rests instead of placing it again", () => {
    const d = animalPolicy(st({ inventory: { ...unpaired.inventory, openOrders: 1 } }), plain);
    expect(d.action).toBe("HOLD");
    expect(d.why).toBe("hedge bid resting");
  });

  it("plus: pulls the hedge bid while spot is on the tail's side and there is time, bids once time runs out", () => {
    // UP tail held; spot above the start price means the reversal is under way.
    const reversing = st({ market: { spotPrice: 85010 }, inventory: unpaired.inventory });
    expect(animalPolicy(reversing, plus).action).toBe("HOLD");
    expect(animalPolicy(reversing, plain).action).toBe("ADD_COMPLEMENT");
    expect(animalPolicy(st({ market: { spotPrice: 85010 }, inventory: { ...unpaired.inventory, openOrders: 1 } }), plus).action).toBe("CANCEL");
    const late = st({ market: { spotPrice: 85010, secondsRemaining: 10 }, inventory: unpaired.inventory });
    expect(animalPolicy(late, plus).action).toBe("ADD_COMPLEMENT");
    // Spot back on the leader's side: bid now.
    expect(animalPolicy(st({ market: { spotPrice: 84980 }, inventory: unpaired.inventory }), plus).action).toBe("ADD_COMPLEMENT");
  });

  it("merges a paired set and then stays out", () => {
    const paired = st({ inventory: { upShares: 100, downShares: 100, pairedShares: 100 } });
    const d = animalPolicy(paired, plain);
    expect(d.action).toBe("HOLD");
    expect(d.inventory).toBe("MERGE");
    const held = st({ inventory: { upShares: 100, downShares: 100, pairedShares: 0 } });
    expect(animalPolicy(held, plain)).toMatchObject({ action: "HOLD", inventory: "NONE" });
  });
});

describe("animalPolicyCall", () => {
  it("returns Jev-shaped answers, costs nothing, and marks the model", async () => {
    const r = await ask(animalPolicyCall(plus), base);
    expect(r.model).toBe("policy-animal-plus");
    expect((await ask(animalPolicyCall(plain), base)).model).toBe("policy-animal");
    expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(r.answers.action.choice).toBe("BUY_UP");
    expect(r.answers.inventory_action.choice).toBe("PAIR");
    expect(r.answers.execution_urgency.choice).toBe("NORMAL");
    expect(r.answers.settlement_direction.choice).toBe("DOWN");
    expect(r.answers.settlement_direction.probabilities["DOWN"]).toBeCloseTo(0.97);
    const p = Object.values(r.answers.action.probabilities).reduce((a, b) => a + b, 0);
    expect(p).toBeCloseTo(1);
  });

  it("is deterministic: the same state gives the same answer from a fresh policy", async () => {
    expect(await ask(animalPolicyCall(plain), base)).toEqual(await ask(animalPolicyCall(plain), base));
  });

  it("remembers the tail it bought in this market, and starts afresh in the next one", async () => {
    const call = animalPolicyCall(plain);
    expect((await ask(call, base)).answers.action.choice).toBe("BUY_UP");
    expect((await ask(call, base)).answers.action.choice).toBe("HOLD");
    const next = st({ market: { openedAtMs: base.market.openedAtMs + 300_000 } });
    expect((await ask(call, next)).answers.action.choice).toBe("BUY_UP");
  });
});
