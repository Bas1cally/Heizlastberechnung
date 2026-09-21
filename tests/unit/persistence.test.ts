import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";
import type { Decision } from "../../src/jev/decision-engine.js";
import type { JevAnswers } from "../../src/jev/decision-types.js";

const answers = { action: { type: "choice", choice: "HOLD", confidence: 0.7, probabilities: { HOLD: 0.7, ABSTAIN: 0.3 } } } as unknown as JevAnswers;
const decision: Decision = {
  decisionId: "d-1", marketId: "m-1", stateVersion: 42n, inputHash: "h", requestedAtMono: 0, respondedAtMono: 91, jevLatencyMs: 91,
  timestampMs: 1_700_000_000_000, state: { market: { secondsRemaining: 17.4 } } as never, answers, model: "jev-1.13.0",
  usage: { input_tokens: 600, output_tokens: 100 }, requestedAction: "HOLD",
};

describe("DecisionRepository", () => {
  it("stores the full decision and can explain it back, distribution included", () => {
    const repo = new DecisionRepository(openDatabase(":memory:"));
    repo.upsertMarket({ marketId: "m-1", conditionId: "c", slug: "s", question: "q", upAssetId: "u", downAssetId: "d", openedAtMs: 0, closesAtMs: 1, tickSize: 0.001, minOrderSize: 5 }, 0);
    repo.saveDecision(decision, { result: "REJECTED", reason: "LIVE_TRADING_DISABLED" });

    const why = repo.explain("d-1")!;
    expect(why.request).toMatchObject({ stateVersion: "42", model: "jev-1.13.0", jevLatencyMs: 91 });
    expect(why.answers).toMatchObject({ requestedAction: "HOLD", risk: { result: "REJECTED", reason: "LIVE_TRADING_DISABLED" } });
    expect((why.answers as { action: { probabilities: Record<string, number> } }).action.probabilities.ABSTAIN).toBe(0.3);
    expect(repo.countDecisions()).toBe(1);
  });

  it("caches by input hash and keeps the first response", () => {
    const repo = new DecisionRepository(openDatabase(":memory:"));
    repo.saveDecision(decision, { result: "APPROVED" });
    repo.saveDecision({ ...decision, decisionId: "d-2", model: "other" }, { result: "APPROVED" });
    expect(repo.cachedAnswers("h")?.model).toBe("jev-1.13.0");
    expect(repo.cachedAnswers("nope")).toBeUndefined();
  });

  it("rolls back the whole decision if one insert fails", () => {
    const db = openDatabase(":memory:");
    const repo = new DecisionRepository(db);
    repo.saveDecision(decision, { result: "APPROVED" });
    // Same decision id violates the primary key on jev_requests -> nothing new lands.
    expect(() => repo.saveDecision(decision, { result: "APPROVED" })).toThrow();
    expect(repo.countDecisions()).toBe(1);
  });

  it("records latency stages as nulls when they did not happen", () => {
    const db = openDatabase(":memory:");
    const repo = new DecisionRepository(db);
    repo.saveLatency("m-1", null, 1, { feed_to_state_ms: 2, jev_ms: 91 });
    const row = db.get<{ jev_ms: number; submit_to_ack_ms: number | null }>(`SELECT jev_ms, submit_to_ack_ms FROM latency_measurements`);
    expect(row).toEqual({ jev_ms: 91, submit_to_ack_ms: null });
  });
});
