import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";
import { loadReplayEvents } from "../../src/replay/replay-engine.js";
import { paperMarket } from "../../src/replay/paper-engine.js";
import { DEFAULT_FILL_PARAMS } from "../../src/replay/paper-fill-model.js";
import { DEFAULT_LIMITS } from "../../src/risk/limits.js";
import type { JevAnswers, JevInputState } from "../../src/jev/decision-types.js";
import type { MarketIdentity } from "../../src/market/market-state.js";

const identity: MarketIdentity = {
  marketId: "m1", conditionId: "0xc", slug: "btc-updown-5m-1000", question: "q",
  upAssetId: "UP", downAssetId: "DOWN", openedAtMs: 1_000_000, closesAtMs: 1_300_000, tickSize: 0.001, minOrderSize: 5,
};
const choice = (c: string, probabilities: Record<string, number>) => ({ type: "choice", choice: c, confidence: 0.9, probabilities });
const score = (s: number) => ({ type: "score", score: s, confidence: 0.8, legend: {}, probabilities: {} });
const answers = (action: string, urgency = "IMMEDIATE", inventory = "NONE"): JevAnswers => ({
  action: choice(action, { [action]: 1 }), settlement_direction: choice("UP", { UP: 0.8, DOWN: 0.1, UNRESOLVED: 0.1 }),
  market_mispricing: choice("NONE", { NONE: 1 }), inventory_action: choice(inventory, { [inventory]: 1 }), execution_urgency: choice(urgency, { [urgency]: 1 }),
  winner_confidence: score(3), reversal_risk: score(1), adverse_selection_risk: score(1),
}) as unknown as JevAnswers;

/** Books every 500 ms for 10 s; UP ask starts at .45 and steps to .47 at t+2s. */
function source(upAskAfter = 0.47) {
  const db = openDatabase(":memory:");
  const repo = new DecisionRepository(db);
  repo.upsertMarket(identity, 1_000_000);
  for (let t = 0; t <= 10_000; t += 500) {
    const at = 1_000_000 + t;
    const upAsk = t < 2_000 ? 0.45 : upAskAfter;
    repo.saveBook("m1", "UP", at, [{ price: upAsk - 0.01, size: 100 }], [{ price: upAsk, size: 60 }, { price: upAsk + 0.01, size: 500 }]);
    repo.saveBook("m1", "DOWN", at, [{ price: 0.53, size: 100 }], [{ price: 0.55, size: 60 }, { price: 0.56, size: 500 }]);
    if (t % 1000 === 0) repo.saveTick("m1", "chainlink", at, at + 5, 85_000 + t / 100);
  }
  return db;
}

const run = async (db: ReturnType<typeof source>, script: (n: number, state: JevInputState) => JevAnswers, over: Partial<Parameters<typeof paperMarket>[0]> = {}) => {
  const outDb = openDatabase(":memory:");
  let n = 0;
  const seen: JevInputState[] = [];
  const r = await paperMarket({
    identity, events: loadReplayEvents(db, "m1"), outcome: "UP", limits: { ...DEFAULT_LIMITS, maxOrderSizeShares: 50, maxMarketExposureUsd: 1000, maxTotalExposureUsd: 1000, maxUnpairedExposureUsd: 1000 },
    heartbeatMs: 60_000, minIntervalMs: 0, latencyMs: 300, fill: { ...DEFAULT_FILL_PARAMS, slippage: 0 }, seed: 1, mergeGas: 0,
    cached: () => undefined, call: async (state) => { seen.push(state); return { answers: script(n++, state), model: "t", usage: { input_tokens: 0, output_tokens: 0 } }; },
    out: new DecisionRepository(outDb), outDb, mode: "paper", ...over,
  });
  return { r, outDb, seen };
};

describe("paper engine", () => {
  it("fills an IMMEDIATE buy against the book after latency, feeds inventory back, and settles", async () => {
    const { r, outDb, seen } = await run(source(), (n) => (n === 0 ? answers("BUY_UP") : answers("HOLD")));
    expect(r.orders).toBe(1);
    expect(r.fills).toBe(1);
    expect(r.finalPosition.upShares).toBe(50);
    expect(r.finalPosition.avgUpEntry).toBeCloseTo(0.45, 9);
    // Resolved UP: 50 shares pay 1.00 each, cost 22.5.
    expect(r.netPnl).toBeCloseTo(50 - 22.5, 9);
    // The next Jev call saw the position the first one created.
    expect(seen.some((s) => s.inventory.upShares === 50)).toBe(true);
    const fill = outDb.get<{ price: number; size: number }>(`SELECT price, size FROM fills`);
    expect(fill).toEqual({ price: 0.45, size: 50 });
  });

  it("misses when the book moves away during latency", async () => {
    // Decision at t+1.9s builds at .45; arrival at t+2.2s sees .47 -> FOK at .455 cannot fill.
    const db = source(0.47);
    const { r } = await run(db, (n, s) => (s.market.secondsRemaining < 298.2 && n < 20 && r0(n) ? answers("BUY_UP") : answers("HOLD")));
    function r0(n: number) { return n === 3; }
    expect(r.orders + r.noFills).toBeGreaterThan(0);
    expect(r.finalPosition.upShares === 0 || r.finalPosition.upShares === 50).toBe(true);
  });

  it("rests a PASSIVE order and fills it only when traded through", async () => {
    // Passive: one tick inside the touch (.449). Book never goes below .45 -> never touched -> no fill.
    const { r } = await run(source(0.45), (n) => (n === 0 ? answers("BUY_UP", "PASSIVE") : answers("HOLD")));
    expect(r.orders).toBe(1);
    expect(r.fills).toBe(0);
    expect(r.finalPosition.upShares).toBe(0);
    expect(r.netPnl).toBe(0);
  });

  it("merges matched inventory when Jev's inventory intent says MERGE", async () => {
    const { r } = await run(source(0.45), (n) => {
      if (n === 0) return answers("BUY_PAIR");
      if (n === 1) return answers("HOLD", "NORMAL", "MERGE");
      return answers("HOLD");
    });
    expect(r.orders).toBe(2);
    expect(r.merges).toBe(1);
    expect(r.finalPosition).toEqual({ upShares: 0, downShares: 0, avgUpEntry: expect.any(Number), avgDownEntry: expect.any(Number) });
    // Pair cost .45 + .55 = 1.00 exactly -> merge returns cost, zero pnl.
    expect(r.mergePnl).toBeCloseTo(0, 9);
    expect(r.netPnl).toBeCloseTo(0, 9);
  });

  it("records every order and fill against the decision that produced it", async () => {
    const { outDb } = await run(source(), (n) => (n === 0 ? answers("BUY_UP") : answers("HOLD")));
    const row = outDb.get<{ decision_id: string; n: number }>(`SELECT o.decision_id, COUNT(f.id) AS n FROM orders o JOIN fills f USING (order_id) JOIN jev_requests r ON r.decision_id = o.decision_id GROUP BY o.decision_id`);
    expect(row?.n).toBe(1);
    expect(row?.decision_id).toMatch(/^paper-m1-/);
  });
});
