import { describe, expect, it } from "vitest";
import { animalPolicy, animalPolicyCall } from "../../src/jev/policy-animal.js";
import type { JevInputState } from "../../src/jev/decision-types.js";

// Late in a market: DOWN leads at 0.98, UP (the tail) is offered at 0.01 with a hedge on the book.
const base: JevInputState = {
  market: { secondsRemaining: 60, settlementStartPrice: 85000, settlementCurrentPrice: 84990, distanceUsd: -10, distanceBps: -1.2, spotPrice: 84988, spotVsTwapBps: -0.2, leadHeldRate: 0.97, leadHeldSamples: 200 },
  movement: { return1s: 0, return3s: 0, return5s: 0, return10s: 0, return30s: 0, realizedVol5s: 0, realizedVol10s: 0, realizedVol30s: 0 },
  orderbook: { upBid: 0.0, upAsk: 0.01, downBid: 0.97, downAsk: 0.98, upDepth: 5000, downDepth: 400, pairAskCost: 0.99, pairExecutableQty: 400, pairEdge: 0.01, upSpread: 0.01, downSpread: 0.01, imbalanceUp: 0, imbalanceDown: 0, leader: "DOWN", leaderAsk: 0.98, leaderAskDepth: 400, tailAsk: 0.01, tailAskDepth: 5000 },
  inventory: { upShares: 0, downShares: 0, avgUpEntry: 0, avgDownEntry: 0, pairedShares: 0, unpairedUpShares: 0, unpairedDownShares: 0, pnlIfUp: 0, pnlIfDown: 0, guaranteedPairPnl: 0, hedgePriceCap: null, hedgeAvailable: false },
  dataQuality: { chainlinkAgeMs: 100, bookAgeMs: 20 },
};
const st = (over: { market?: Partial<JevInputState["market"]>; orderbook?: Partial<JevInputState["orderbook"]>; inventory?: Partial<JevInputState["inventory"]> }): JevInputState => ({
  ...base, market: { ...base.market, ...over.market }, orderbook: { ...base.orderbook, ...over.orderbook }, inventory: { ...base.inventory, ...over.inventory },
});
const plain = { variant: "plain" as const };
const plus = { variant: "plus" as const };

describe("animalPolicy: flat", () => {
  it("buys the tail inside the window when it is cheap and the leader is offered under 1 - tail", () => {
    const d = animalPolicy(base, plain);
    expect(d.action).toBe("BUY_UP");
    expect(d.inventory).toBe("ADD_UP");
    expect(d.urgency).toBe("NORMAL");
  });

  it("buys the other tail when UP leads", () => {
    const d = animalPolicy(st({ orderbook: { leader: "UP", upAsk: 0.98, downAsk: 0.01, leaderAsk: 0.98, tailAsk: 0.01 } }), plain);
    expect(d.action).toBe("BUY_DOWN");
    expect(d.inventory).toBe("ADD_DOWN");
  });

  it("holds outside the window, when the tail is not cheap, and when no hedge is on the book", () => {
    expect(animalPolicy(st({ market: { secondsRemaining: 200 } }), plain).action).toBe("HOLD");
    expect(animalPolicy(st({ orderbook: { tailAsk: 0.03 } }), plain).action).toBe("HOLD");
    // leader at 0.995 with the tail at 0.01 makes a set cost 1.005: no free option.
    expect(animalPolicy(st({ orderbook: { leaderAsk: 0.995 } }), plain).why).toBe("no hedge on the book");
    expect(animalPolicy(st({ orderbook: { leaderAskDepth: 0 } }), plain).action).toBe("HOLD");
  });

  it("initiates nothing in the last seconds or without a leader", () => {
    expect(animalPolicy(st({ market: { secondsRemaining: 5 } }), plain).action).toBe("HOLD");
    expect(animalPolicy(st({ orderbook: { leader: null } }), plain).action).toBe("HOLD");
  });

  it("plus: takes the tail early when the measured reversal rate exceeds its price, plain does not", () => {
    // 6% of such leads reverse; the tail costs 0.02: worth more than it costs.
    const early = st({ market: { secondsRemaining: 200, leadHeldRate: 0.94 }, orderbook: { tailAsk: 0.02 } });
    expect(animalPolicy(early, plus).action).toBe("BUY_UP");
    expect(animalPolicy(early, plus).why).toMatch(/early/);
    expect(animalPolicy(early, plain).action).toBe("HOLD");
    // 1% reverse: not worth 0.02.
    expect(animalPolicy(st({ market: { secondsRemaining: 200, leadHeldRate: 0.99 }, orderbook: { tailAsk: 0.02 } }), plus).action).toBe("HOLD");
    // No measurement: window only.
    expect(animalPolicy(st({ market: { secondsRemaining: 200, leadHeldRate: null } }), plus).action).toBe("HOLD");
  });

  it("plus: needs real hedge depth before buying a tail", () => {
    expect(animalPolicy(st({ orderbook: { leaderAskDepth: 5 } }), plus).action).toBe("HOLD");
    expect(animalPolicy(st({ orderbook: { leaderAskDepth: 5 } }), plain).action).toBe("BUY_UP");
  });
});

describe("animalPolicy: with inventory", () => {
  const unpaired = st({ inventory: { upShares: 100, unpairedUpShares: 100, avgUpEntry: 0.01, hedgePriceCap: 0.99, hedgeAvailable: true } });

  it("hedges an unpaired tail immediately when the leader is offered under the cap", () => {
    const d = animalPolicy(unpaired, plain);
    expect(d.action).toBe("ADD_COMPLEMENT");
    expect(d.inventory).toBe("PAIR");
    expect(d.urgency).toBe("IMMEDIATE");
  });

  it("holds the unpaired tail while the hedge is not offered under the cap", () => {
    const d = animalPolicy(st({ inventory: { ...unpaired.inventory, hedgeAvailable: false } }), plain);
    expect(d.action).toBe("HOLD");
    expect(d.inventory).toBe("NONE");
  });

  it("plus: keeps the option open while spot is on the tail's side and there is time, hedges once time runs out", () => {
    // UP tail held; spot above the start price means the reversal is under way.
    const reversing = st({ ...unpaired, market: { spotPrice: 85010 } });
    expect(animalPolicy({ ...reversing, inventory: unpaired.inventory }, plus).action).toBe("HOLD");
    expect(animalPolicy({ ...reversing, inventory: unpaired.inventory }, plain).action).toBe("ADD_COMPLEMENT");
    const late = st({ market: { spotPrice: 85010, secondsRemaining: 10 }, inventory: unpaired.inventory });
    expect(animalPolicy(late, plus).action).toBe("ADD_COMPLEMENT");
    // Spot back on the leader's side: hedge now.
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
    const r = await animalPolicyCall(plus)(base);
    expect(r.model).toBe("policy-animal-plus");
    expect((await animalPolicyCall(plain)(base)).model).toBe("policy-animal");
    expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(r.answers.action.choice).toBe("BUY_UP");
    expect(r.answers.inventory_action.choice).toBe("ADD_UP");
    expect(r.answers.execution_urgency.choice).toBe("NORMAL");
    expect(r.answers.settlement_direction.choice).toBe("DOWN");
    expect(r.answers.settlement_direction.probabilities["DOWN"]).toBeCloseTo(0.97);
    const p = Object.values(r.answers.action.probabilities).reduce((a, b) => a + b, 0);
    expect(p).toBeCloseTo(1);
  });

  it("is deterministic: the same state gives the same answer", async () => {
    const call = animalPolicyCall(plain);
    expect(await call(base)).toEqual(await call(base));
  });
});
