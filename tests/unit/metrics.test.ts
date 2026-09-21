import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";
import { animal00, evSegments, executionMetrics, latencyReport, realizedPnlByTime, unpairedExposure } from "../../src/analytics/metrics.js";
import type { Observation } from "../../src/analytics/calibration.js";
import type { Decision } from "../../src/jev/decision-engine.js";
import type { JevAnswers } from "../../src/jev/decision-types.js";

function seeded() {
  const db = openDatabase(":memory:");
  const repo = new DecisionRepository(db);
  repo.upsertMarket({ marketId: "m1", conditionId: "c", slug: "s1", question: "q", upAssetId: "u", downAssetId: "d", openedAtMs: 0, closesAtMs: 300_000, tickSize: 0.01, minOrderSize: 5 }, 0);
  const answers = { action: { type: "choice", choice: "BUY_UP", confidence: 0.8, probabilities: {} } } as unknown as JevAnswers;
  const dec = (id: string, secs: number): Decision => ({
    decisionId: id, marketId: "m1", stateVersion: 1n, rawStateVersion: 1n, materialReason: "quote", packetReceivedMono: 0, stateUpdatedMono: 0, inputHash: id, requestedAtMono: 0, respondedAtMono: 300, jevLatencyMs: 300,
    timestampMs: 1000, state: { market: { secondsRemaining: secs } } as never, answers, model: "jev", usage: { input_tokens: 1000, output_tokens: 100 }, requestedAction: "BUY_UP",
  });
  repo.saveDecision(dec("d1", 200), { result: "APPROVED" });
  repo.saveDecision(dec("d2", 20), { result: "APPROVED" });
  repo.saveDecision(dec("d3", 10), { result: "REJECTED", reason: "STALE_DECISION" });
  const order = (id: string, dId: string, type: string, status: string) =>
    db.run(`INSERT INTO orders (order_id, decision_id, state_version, market_id, mode, side, asset_id, order_type, price, size, status, created_ms, updated_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, dId, "1", "m1", "paper", "UP", "u", type, 0.6, 10, status, 0, 0]);
  order("o1", "d1", "FOK", "FILLED");
  order("o2", "d2", "GTC", "FILLED");
  order("o3", "d2", "GTC", "CANCELLED");
  order("o4", "d3", "FOK", "NO_FILL");
  db.run(`INSERT INTO fills (order_id, decision_id, state_version, market_id, mode, side, asset_id, price, size, fee, ts_ms) VALUES ('o1','d1','1','m1','paper','UP','u',0.6,10,0,10000)`);
  db.run(`INSERT INTO fills (order_id, decision_id, state_version, market_id, mode, side, asset_id, price, size, fee, ts_ms) VALUES ('o2','d2','1','m1','paper','DOWN','d',0.3,10,0,200000)`);
  db.run(`INSERT INTO inventory_snapshots (market_id, mode, ts_ms, inventory_json) VALUES ('m1','paper',10000,?)`, [JSON.stringify({ unpairedUpShares: 10, unpairedDownShares: 0, totalCost: 6 })]);
  db.run(`INSERT INTO inventory_snapshots (market_id, mode, ts_ms, inventory_json) VALUES ('m1','paper',200000,?)`, [JSON.stringify({ unpairedUpShares: 0, unpairedDownShares: 0, totalCost: 9 })]);
  db.run(`INSERT INTO pnl_snapshots (market_id, mode, ts_ms, pnl_json) VALUES ('m1','paper',310000,?)`, [JSON.stringify({ netPnl: 1, grossPnl: 1, fees: 0, gas: 0, mergePnl: 1, settlementPnl: 0 })]);
  return db;
}

describe("executionMetrics", () => {
  it("is null without records and prices Jev calls into the net result", () => {
    expect(executionMetrics(openDatabase(":memory:"), "paper")).toBeNull();
    const m = executionMetrics(seeded(), "paper", 20)!; // 20 USD per million tokens
    expect(m.settledMarkets).toBe(1);
    expect(m.netPnl).toBe(1);
    expect(m.deployedCapitalUsd).toBeCloseTo(9, 9);         // 6 + 3
    expect(m.returnOnDeployedCapital).toBeCloseTo(1 / 9, 9);
    expect(m.pnlPerFill).toBe(0.5);
    expect(m.jevCalls).toBe(3);
    expect(m.pnlPerJevCall).toBeCloseTo(1 / 3, 9);
    expect(m.orders).toBe(4); expect(m.fills).toBe(2); expect(m.cancelled).toBe(1); expect(m.noFills).toBe(1);
    expect(m.fillRatio).toBe(0.5); expect(m.cancelRatio).toBe(0.25);
    expect(m.makerFills).toBe(1); expect(m.takerFills).toBe(1); expect(m.makerTakerRatio).toBe(1);
    expect(m.worstCaseExposureUsd).toBe(9);
    expect(m.jevTokens).toEqual({ input: 3000, output: 300 });
    expect(m.jevCostUsd).toBeCloseTo(3300 / 1e6 * 20, 12);
    expect(m.netPnlAfterJevCost).toBeCloseTo(1 - 0.066, 9);
    expect(m.unpairedExposure.totalMs).toBe(190_000); // unpaired from 10 s to 200 s
    expect(m.unpairedExposure.shareOfMarketTime).toBeCloseTo(190 / 300, 9);
  });

  it("extends the last unpaired snapshot to settlement", () => {
    const db = openDatabase(":memory:");
    db.run(`INSERT INTO inventory_snapshots (market_id, mode, ts_ms, inventory_json) VALUES ('m','paper',100,?)`, [JSON.stringify({ unpairedUpShares: 5, unpairedDownShares: 0 })]);
    const u = unpairedExposure(db, "paper", [{ marketId: "m", openedAtMs: 0, closesAtMs: 1000, settledAtMs: 1200 }]);
    expect(u.totalMs).toBe(1100);
    expect(u.maxMs).toBe(1100);
  });
});

describe("realizedPnlByTime", () => {
  it("attributes each fill's settlement value to the decision's time bucket", () => {
    const rows = realizedPnlByTime(seeded(), "paper", new Map([["m1", "UP"]]));
    const early = rows.find((r) => r.bucket === "300-120s")!;
    expect(early.pnl).toBeCloseTo(4, 9);       // UP at .60 wins: (1 - .6) x 10
    expect(early.winRate).toBe(1);
    const late = rows.find((r) => r.bucket === "30-15s")!;
    expect(late.pnl).toBeCloseTo(-3, 9);       // DOWN at .30 loses
    expect(late.pnlPerShare).toBeCloseTo(-0.3, 9);
  });

  it("skips fills on markets without an outcome", () => {
    expect(realizedPnlByTime(seeded(), "paper", new Map())).toEqual([]);
  });
});

const ob = (over: Partial<Observation>): Observation => ({ pUp: 0.9, unresolvedMass: 0.05, outcomeUp: true, secondsRemaining: 100, upAsk: 0.7, downAsk: 0.31, action: "BUY_UP", marketId: "m", ...over });

describe("evSegments", () => {
  it("buckets by absolute distance, vol, confidence, action and pair cost, keeping unknowns visible", () => {
    const s = evSegments([
      ob({ distanceBps: -3, realizedVol30s: 0.0003, actionConfidence: 0.95, pairAskCost: 1.01 }),
      ob({ distanceBps: 30, realizedVol30s: 0.005, actionConfidence: 0.6, pairAskCost: 0.985, action: "HOLD" }),
      ob({}),
    ]);
    expect(s.byDistanceBps.find((r) => r.bucket === "2.5-5bps")!.n).toBe(1);
    expect(s.byDistanceBps.find((r) => r.bucket === "20-50bps")!.n).toBe(1);
    expect(s.byDistanceBps.find((r) => r.bucket === "unknown")!.n).toBe(1);
    expect(s.byVolatility.find((r) => r.bucket === "2-5bps")!.n).toBe(1);
    expect(s.byVolatility.find((r) => r.bucket === "20bps+")!.n).toBe(1);
    expect(s.byJevConfidence.find((r) => r.bucket === "0.9-0.99")!.n).toBe(1);
    expect(s.byAction.map((r) => r.bucket)).toEqual(["BUY_UP", "HOLD"]);
    expect(s.byAction.find((r) => r.bucket === "BUY_UP")!.n).toBe(2);
    expect(s.byPairCost.find((r) => r.bucket === "0.98-0.99")!.n).toBe(1);
    expect(s.byPairCost.find((r) => r.bucket === "1.01-1.03")!.n).toBe(1);
    // Naive EV of buying UP at .70 and winning: .30 per share.
    expect(s.byAction.find((r) => r.bucket === "BUY_UP")!.meanPnl).toBeCloseTo(0.3, 9);
  });
});

describe("animal00", () => {
  it("counts only states with a 0.98-0.995 winner and a <= 0.02 complement, and prices the pair", () => {
    const r = animal00([
      ob({ pUp: 0.99, upAsk: 0.99, downAsk: 0.005, outcomeUp: true }),   // pair .995 < 1: locked .005
      ob({ pUp: 0.99, upAsk: 0.985, downAsk: 0.02, outcomeUp: false }),  // pair 1.005
      ob({ pUp: 0.02, upAsk: 0.01, downAsk: 0.99, outcomeUp: false }),   // DOWN favoured; candidate
      ob({ pUp: 0.99, upAsk: 0.97, downAsk: 0.01 }),                     // winner too cheap: not a candidate
      ob({ pUp: 0.6 }),
    ]);
    expect(r.observations).toBe(5);
    expect(r.candidateStates).toBe(3);
    expect(r.winnerAccuracy).toBeCloseTo(2 / 3, 9);
    expect(r.pairBelowParStates).toBe(1);
    expect(r.meanLockedPairPnlPerShare).toBeCloseTo(0.005, 9);
    expect(r.meanComplementAsk).toBeCloseTo((0.005 + 0.02 + 0.01) / 3, 9);
    expect(r.actionMixInCandidates).toEqual({ BUY_UP: 3 });
  });
});

describe("latencyReport", () => {
  it("reports Jev percentiles, over-threshold shares and stale buys", () => {
    const r = latencyReport(seeded(), "now");
    expect(r.decisions).toBe(3);
    expect(r.jevLatencyMs.p50).toBe(300);
    expect(r.jevOver["250ms"]).toBe(1);
    expect(r.jevOver["500ms"]).toBe(0);
    expect(r.staleness).toEqual({ buys: 3, staleBuys: 1, staleShare: 1 / 3 });
    expect(r.shadow).toBeNull();
  });
});
