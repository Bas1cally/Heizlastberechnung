import { describe, expect, it, vi } from "vitest";
import { DecisionEngine, type Decision } from "../../src/jev/decision-engine.js";
import type { JevAnswers, JevInputState } from "../../src/jev/decision-types.js";
import { buildJevState, canonicalJson } from "../../src/jev/state-builder.js";
import { createLogger } from "../../src/observability/logger.js";
import { MarketStateStore, type MarketIdentity } from "../../src/market/market-state.js";
import { computeInventory, EMPTY_POSITION } from "../../src/inventory/accounting.js";
import { normalizeBook } from "../../src/feeds/book-normalizer.js";
import { PriceWindow } from "../../src/features/returns.js";

const log = createLogger({ level: "error", write: () => {} });

const choice = (c: string, probabilities: Record<string, number>) =>
  ({ type: "choice", choice: c, confidence: 0.9, probabilities }) as unknown as JevAnswers["action"];
const score = (s: number) =>
  ({ type: "score", score: s, confidence: 0.8, legend: {}, probabilities: {} }) as unknown as JevAnswers["reversal_risk"];

const answersFor = (action: string): JevAnswers => ({
  action: choice(action, { [action]: 0.8, HOLD: 0.2 }),
  settlement_direction: choice("UP", { UP: 0.9, DOWN: 0.05, UNRESOLVED: 0.05 }),
  market_mispricing: choice("NONE", { NONE: 1 }),
  inventory_action: choice("NONE", { NONE: 1 }),
  execution_urgency: choice("PASSIVE", { PASSIVE: 1 }),
  winner_confidence: score(3),
  reversal_risk: score(1),
  adverse_selection_risk: score(1),
});

const someState = (secondsRemaining: number): JevInputState =>
  ({ market: { secondsRemaining }, movement: {}, orderbook: {}, inventory: {}, dataQuality: {} }) as unknown as JevInputState;

/** Timer that runs callbacks when `tick()` is called, so tests are deterministic. */
function manualTimer() {
  const queue: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => { queue.push(fn); return 0; },
    tick: () => { const q = queue.splice(0); q.forEach((f) => f()); },
  };
}

describe("DecisionEngine", () => {
  it("coalesces a burst into one request carrying the newest state", async () => {
    const call = vi.fn(async (s: JevInputState) => ({ answers: answersFor("HOLD"), model: "jev", usage: { input_tokens: 1, output_tokens: 1 } }));
    const t = manualTimer();
    const decisions: Decision[] = [];
    const eng = new DecisionEngine({
      call, mono: () => 0, wall: () => 0, log, coalesceMs: 15, minIntervalMs: 0,
      onDecision: (d) => decisions.push(d), onError: () => {}, timer: t.schedule,
    });
    eng.submit("m", 1n, someState(10));
    eng.submit("m", 2n, someState(9));
    eng.submit("m", 3n, someState(8));
    t.tick();
    await vi.waitFor(() => expect(decisions).toHaveLength(1));
    expect(call).toHaveBeenCalledTimes(1);
    expect(decisions[0]!.stateVersion).toBe(3n);
    expect(decisions[0]!.state.market.secondsRemaining).toBe(8);
    expect(decisions[0]!.requestedAction).toBe("HOLD");
  });

  it("aborts an in-flight request when a newer state arrives and never emits the stale one", async () => {
    let release!: () => void;
    let calls = 0;
    const call = vi.fn((s: JevInputState, _q: unknown, signal: AbortSignal) => {
      calls++;
      if (calls === 1) {
        return new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
          release = () => reject(new Error("aborted"));
        });
      }
      return Promise.resolve({ answers: answersFor("ABSTAIN"), model: "jev", usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const t = manualTimer();
    const decisions: Decision[] = [];
    const errors: unknown[] = [];
    const eng = new DecisionEngine({
      call, mono: () => 0, wall: () => 0, log, coalesceMs: 0, minIntervalMs: 0,
      onDecision: (d) => decisions.push(d), onError: (e) => errors.push(e), timer: t.schedule,
    });
    eng.submit("m", 1n, someState(10));
    t.tick();
    expect(eng.hasInflight()).toBe(true);

    eng.submit("m", 2n, someState(9));
    t.tick(); // flush aborts #1 and starts #2

    await vi.waitFor(() => expect(decisions).toHaveLength(1));
    expect(decisions[0]!.stateVersion).toBe(2n);
    expect(errors).toHaveLength(0); // an intentional abort is not an error
    void release;
  });

  it("discards a late response for a superseded version even without abort support", async () => {
    const resolvers: Array<(v: { answers: JevAnswers; model: string; usage: { input_tokens: number; output_tokens: number } }) => void> = [];
    const call = vi.fn(() => new Promise<never>((resolve) => resolvers.push(resolve as never)));
    const t = manualTimer();
    const decisions: Decision[] = [];
    const eng = new DecisionEngine({
      call, mono: () => 0, wall: () => 0, log, coalesceMs: 0, minIntervalMs: 0,
      onDecision: (d) => decisions.push(d), onError: () => {}, timer: t.schedule,
    });
    eng.submit("m", 1n, someState(10)); t.tick();
    eng.submit("m", 2n, someState(9)); t.tick();
    // The first (superseded) call resolves late.
    resolvers[0]!({ answers: answersFor("BUY_UP"), model: "jev", usage: { input_tokens: 1, output_tokens: 1 } });
    resolvers[1]!({ answers: answersFor("HOLD"), model: "jev", usage: { input_tokens: 1, output_tokens: 1 } });
    await vi.waitFor(() => expect(decisions).toHaveLength(1));
    expect(decisions[0]!.stateVersion).toBe(2n);
    expect(decisions[0]!.requestedAction).toBe("HOLD");
  });

  it("ignores a submission older than one already seen", () => {
    const call = vi.fn(async () => ({ answers: answersFor("HOLD"), model: "jev", usage: { input_tokens: 1, output_tokens: 1 } }));
    const t = manualTimer();
    const eng = new DecisionEngine({ call, mono: () => 0, wall: () => 0, log, coalesceMs: 0, minIntervalMs: 0, onDecision: () => {}, onError: () => {}, timer: t.schedule });
    eng.submit("m", 5n, someState(1));
    eng.submit("m", 4n, someState(2));
    t.tick();
    expect(call).toHaveBeenCalledTimes(1);
    expect((call.mock.calls[0] as unknown[])[0]).toMatchObject({ market: { secondsRemaining: 1 } });
  });

  it("routes a synchronous throw inside call() to onError", async () => {
    const call = vi.fn(() => { throw new Error("sync boom"); });
    const t = manualTimer();
    const errors: unknown[] = [];
    const eng = new DecisionEngine({ call: call as never, mono: () => 0, wall: () => 0, log, coalesceMs: 0, minIntervalMs: 0, onDecision: () => {}, onError: (e) => errors.push(e), timer: t.schedule });
    eng.submit("m", 1n, someState(1));
    expect(() => t.tick()).not.toThrow();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
  });

  it("reports a real failure through onError with the version", async () => {
    const call = vi.fn(async () => { throw new Error("boom"); });
    const t = manualTimer();
    const errors: Array<[unknown, bigint]> = [];
    const eng = new DecisionEngine({ call, mono: () => 0, wall: () => 0, log, coalesceMs: 0, minIntervalMs: 0, onDecision: () => {}, onError: (e, v) => errors.push([e, v]), timer: t.schedule });
    eng.submit("m", 7n, someState(1)); t.tick();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]![1]).toBe(7n);
    expect(eng.hasInflight()).toBe(false);
  });
});

describe("buildJevState", () => {
  const id: MarketIdentity = { marketId: "m", conditionId: "c", slug: "s", question: "q", upAssetId: "UP", downAssetId: "DOWN", openedAtMs: 0, closesAtMs: 300_000, tickSize: 0.001, minOrderSize: 5 };

  it("produces a compact, fully numeric snapshot with no NaN anywhere", () => {
    const store = new MarketStateStore(id, computeInventory({ upShares: 1000, downShares: 500, avgUpEntry: 0.99, avgDownEntry: 0.005 }));
    store.setBook(normalizeBook({ assetId: "UP", bids: [{ price: "0.991", size: "100" }], asks: [{ price: "0.992", size: "300" }], receivedAtMs: 0 }));
    store.setBook(normalizeBook({ assetId: "DOWN", bids: [{ price: "0.007", size: "100" }], asks: [{ price: "0.008", size: "700" }], receivedAtMs: 0 }));
    store.setSettlementPrice(100_000, 0);
    store.setSettlementPrice(100_182, 10_000);
    const prices = new PriceWindow(60_000);
    prices.push({ ts: 0, price: 100_000 }); prices.push({ ts: 5_000, price: 100_100 }); prices.push({ ts: 10_000, price: 100_182 });

    const s = buildJevState({ state: store.snapshot(282_600), prices, chainlinkAgeMs: 120, bookAgeMs: 40, pairQty: 100 });
    expect(s.market.secondsRemaining).toBe(17.4);
    expect(s.market.distanceBps).toBeCloseTo(18.2, 2);
    // Without a spot feed the spot defaults to the settlement price: no gap.
    expect(s.market.spotPrice).toBe(100_182);
    expect(s.market.spotVsTwapBps).toBe(0);
    expect(s.orderbook.pairAskCost).toBeCloseTo(1.0, 5);
    expect(s.orderbook.pairExecutableQty).toBe(100);
    expect(s.inventory.pairedShares).toBe(500);
    expect(s.inventory.pnlIfDown).toBe(-492.5);
    expect(s.dataQuality).toEqual({ chainlinkAgeMs: 120, bookAgeMs: 40 });
    const flat = JSON.stringify(s);
    // The only permitted null is the hold-rate feature before enough markets exist.
    expect(flat.replace('"leadHeldRate":null', "")).not.toContain("null");
    expect(flat).not.toContain("NaN");
  });

  it("degrades to safe defaults before any data has arrived", () => {
    const store = new MarketStateStore(id, computeInventory(EMPTY_POSITION));
    const s = buildJevState({ state: store.snapshot(0), prices: new PriceWindow(1000), chainlinkAgeMs: Number.POSITIVE_INFINITY, bookAgeMs: Number.POSITIVE_INFINITY, pairQty: 100 });
    expect(s.orderbook.upAsk).toBe(1);
    expect(s.orderbook.pairExecutableQty).toBe(0);
    expect(s.dataQuality.chainlinkAgeMs).toBe(1e9);
  });
});

describe("canonicalJson", () => {
  it("is independent of key order so equal states hash equal", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});
