import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";
import { loadMarketIdentity, loadReplayEvents, replayMarket } from "../../src/replay/replay-engine.js";
import { DEFAULT_LIMITS } from "../../src/risk/limits.js";
import type { JevAnswers, JevInputState } from "../../src/jev/decision-types.js";
import type { MarketIdentity } from "../../src/market/market-state.js";

const identity: MarketIdentity = {
  marketId: "m1", conditionId: "0xc", slug: "btc-updown-5m-1000", question: "q",
  upAssetId: "UP", downAssetId: "DOWN", openedAtMs: 1_000_000, closesAtMs: 1_300_000, tickSize: 0.001, minOrderSize: 5,
};

const choice = (c: string, probabilities: Record<string, number>) => ({ type: "choice", choice: c, confidence: 0.9, probabilities });
const score = (s: number) => ({ type: "score", score: s, confidence: 0.8, legend: {}, probabilities: {} });
const answers = (action: string): JevAnswers => ({
  action: choice(action, { [action]: 1 }), settlement_direction: choice("UP", { UP: 0.7, DOWN: 0.2, UNRESOLVED: 0.1 }),
  market_mispricing: choice("NONE", { NONE: 1 }), inventory_action: choice("NONE", { NONE: 1 }), execution_urgency: choice("PASSIVE", { PASSIVE: 1 }),
  winner_confidence: score(2), reversal_risk: score(1), adverse_selection_risk: score(1),
}) as unknown as JevAnswers;

/** A recorded market: one book per side, then ticks every second with a quote move at t+3s. */
function recordedSource() {
  const db = openDatabase(":memory:");
  const repo = new DecisionRepository(db);
  repo.upsertMarket(identity, 1_000_000);
  const book = (asset: string, ask: number, at: number) =>
    repo.saveBook("m1", asset, at, [{ price: ask - 0.01, size: 100 }], [{ price: ask, size: 100 }]);
  book("UP", 0.45, 1_000_100);
  book("DOWN", 0.56, 1_000_150);
  for (let i = 0; i < 6; i++) repo.saveTick("m1", "chainlink", 1_000_000 + i * 1000, 1_000_200 + i * 1000, 85_000 + i * 20);
  book("UP", 0.47, 1_003_100); // quote moves at +3.1 s
  return { db, repo };
}

describe("replay engine", () => {
  it("orders events causally and rebuilds the identity from the database", () => {
    const { db } = recordedSource();
    const events = loadReplayEvents(db, "m1");
    expect(events.map((e) => e.atMs)).toEqual([...events.map((e) => e.atMs)].sort((a, b) => a - b));
    expect(loadMarketIdentity(db, "m1")?.upAssetId).toBe("UP");
  });

  it("decides only from state available at the time, and only on material change", async () => {
    const { db, repo } = recordedSource();
    const seen: Array<{ at: number; upAsk: number; reason: string }> = [];
    const call = vi.fn(async (state: JevInputState) => ({ answers: answers("HOLD"), model: "jev", usage: { input_tokens: 1, output_tokens: 1 } }));
    const out = new DecisionRepository(openDatabase(":memory:"));
    const r = await replayMarket({
      identity, events: loadReplayEvents(db, "m1"), limits: DEFAULT_LIMITS, heartbeatMs: 60_000, minIntervalMs: 0,
      cached: (h) => repo.cachedAnswers(h), call, freshJev: false, out,
      onDecision: (d) => seen.push({ at: d.timestampMs, upAsk: d.state.orderbook.upAsk, reason: d.materialReason }),
    });
    // First decision once both books and a price exist; the quote move at +3.1 s is the next material change.
    expect(seen[0]!.at).toBe(1_000_200);
    expect(seen[0]!.upAsk).toBe(0.45);
    expect(seen[0]!.reason).toBe("first");
    const moved = seen.find((s) => s.upAsk === 0.47)!;
    expect(moved.at).toBe(1_003_100);
    expect(moved.reason).toBe("quote");
    // Nothing decided before the first book/price, and no look-ahead: the
    // 0.47 ask never appears in a decision stamped before 1_003_100.
    expect(seen.filter((s) => s.at < 1_003_100).every((s) => s.upAsk === 0.45)).toBe(true);
    expect(r.jevCalls).toBe(seen.length);
    expect(r.cacheHits).toBe(0);
  });

  it("reuses cached answers by input hash and skips uncached states without a Jev call", async () => {
    const { db, repo } = recordedSource();
    const out = new DecisionRepository(openDatabase(":memory:"));
    const call = vi.fn(async () => ({ answers: answers("ABSTAIN"), model: "jev-live", usage: { input_tokens: 1, output_tokens: 1 } }));

    // First pass with Jev: populates the OUTPUT db cache. Copy those into the source cache
    // the way a live run would have, then replay again cache-only.
    const first = await replayMarket({ identity, events: loadReplayEvents(db, "m1"), limits: DEFAULT_LIMITS, heartbeatMs: 60_000, minIntervalMs: 0, cached: () => undefined, call, freshJev: false, out });
    expect(first.jevCalls).toBeGreaterThan(0);
    const outDb = openDatabase(":memory:"); // fresh output for the second pass
    const second = await replayMarket({
      identity, events: loadReplayEvents(db, "m1"), limits: DEFAULT_LIMITS, heartbeatMs: 60_000, minIntervalMs: 0,
      cached: (h) => out.cachedAnswers(h), call: undefined, freshJev: false, out: new DecisionRepository(outDb),
    });
    expect(second.cacheHits).toBe(first.jevCalls);
    expect(second.jevCalls).toBe(0);
    expect(second.skippedNoJev).toBe(0);

    const third = await replayMarket({ identity, events: loadReplayEvents(db, "m1"), limits: DEFAULT_LIMITS, heartbeatMs: 60_000, minIntervalMs: 0, cached: () => undefined, call: undefined, freshJev: false, out: new DecisionRepository(openDatabase(":memory:")) });
    expect(third.skippedNoJev).toBe(first.jevCalls);
    expect(third.decisions).toBe(0);
    void repo;
  });
});

describe("TWAP vs spot ticks", () => {
  it("settles on the TWAP stream and uses spot for movement when both were recorded", async () => {
    const { db, repo } = recordedSource();
    repo.saveTick("m1", "chainlink-twap60", 1_000_000, 1_000_250, 85_500);
    repo.saveTick("m1", "chainlink-twap60", 1_003_000, 1_003_250, 85_520);
    const seen: Array<{ settlement: number; spot: number }> = [];
    const out = new DecisionRepository(openDatabase(":memory:"));
    await replayMarket({
      identity, events: loadReplayEvents(db, "m1"), limits: DEFAULT_LIMITS, heartbeatMs: 60_000, minIntervalMs: 0,
      cached: () => undefined, call: async () => ({ answers: answers("HOLD"), model: "jev", usage: { input_tokens: 1, output_tokens: 1 } }), freshJev: false, out,
      onDecision: (d) => seen.push({ settlement: d.state.market.settlementCurrentPrice, spot: d.state.market.spotPrice }),
    });
    const last = seen[seen.length - 1]!;
    expect(last.settlement).toBe(85_520);   // TWAP
    expect(last.spot).toBe(85_100);         // spot tick at +5s from recordedSource
    expect(seen.every((s) => s.settlement === 85_500 || s.settlement === 85_520)).toBe(true);
  });

  it("falls back to spot as settlement for recordings without a TWAP stream", async () => {
    const { db } = recordedSource();
    const seen: number[] = [];
    await replayMarket({
      identity, events: loadReplayEvents(db, "m1"), limits: DEFAULT_LIMITS, heartbeatMs: 60_000, minIntervalMs: 0,
      cached: () => undefined, call: async () => ({ answers: answers("HOLD"), model: "jev", usage: { input_tokens: 1, output_tokens: 1 } }), freshJev: false,
      out: new DecisionRepository(openDatabase(":memory:")), onDecision: (d) => seen.push(d.state.market.settlementCurrentPrice),
    });
    expect(seen[seen.length - 1]).toBe(85_100);
  });
});
