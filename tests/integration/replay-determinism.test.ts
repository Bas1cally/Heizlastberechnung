import { describe, expect, it } from "vitest";
import { MarketObserver } from "../../src/app/observer.js";
import { createClock } from "../../src/feeds/clock.js";
import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";
import { loadMarketIdentity, loadReplayEvents, replayMarket } from "../../src/replay/replay-engine.js";
import { paperMarket } from "../../src/replay/paper-engine.js";
import { DEFAULT_FILL_PARAMS } from "../../src/replay/paper-fill-model.js";
import { loadMarketOutcomes } from "../../src/analytics/observations.js";
import { answersFor, bookStream, identityFor, priceStream, quietLog, scriptedJev, testConfig } from "./helpers.js";

/**
 * Deterministic reconstruction (brief §41): what the observer recorded can be
 * replayed, the replay decides only from recorded data, and two replays of
 * the same recording produce byte-identical decisions and identical paper
 * results.
 */
describe("replay reconstructs a recorded market deterministically", () => {
  it("records live, then replays twice with identical hashes, decisions and paper PnL", async () => {
    const cfg = testConfig();
    const db = openDatabase(":memory:");
    const repo = new DecisionRepository(db);
    const clock = createClock();
    const market = identityFor(clock.wall(), 4_000);
    repo.upsertMarket(market, clock.wall());
    const live = scriptedJev(() => answersFor("BUY_UP", "IMMEDIATE"));
    const observer = new MarketObserver({
      cfg, log: quietLog(), clock, repo, jevCall: live.call,
      marketSubscribe: bookStream({ everyMs: 100 }), chainlinkSubscribe: priceStream((t) => 85_000 + t / 10, 100), chainlinkTwapSubscribe: priceStream((t) => 85_000 + t / 20, 100),
    }, market);
    await observer.run(0);
    expect(observer.decisionCount()).toBeGreaterThan(0);

    // The recording alone rebuilds the market and its outcome (TWAP rose, so UP).
    const identity = loadMarketIdentity(db, market.marketId)!;
    expect(identity).toMatchObject({ slug: market.slug, upAssetId: "UP", downAssetId: "DOWN" });
    const events = loadReplayEvents(db, market.marketId);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e, i) => i === 0 || e.atMs >= events[i - 1]!.atMs)).toBe(true); // causal order
    const outcome = loadMarketOutcomes(db, market.closesAtMs + 1).find((m) => m.marketId === market.marketId)!;
    expect(outcome.outcome).toBe("UP");
    expect(outcome.source).toBe("derived");

    // Replay with a Jev that answers from the state only; run it twice.
    const replayOnce = async () => {
      const out = openDatabase(":memory:");
      const jev = scriptedJev((s) => answersFor(s.market.distanceBps >= 0 ? "BUY_UP" : "BUY_DOWN", "IMMEDIATE"));
      const r = await replayMarket({ identity, events, limits: cfg.limits, heartbeatMs: cfg.jev.heartbeatMs, minIntervalMs: cfg.jev.minIntervalMs, cached: () => undefined, call: jev.call, freshJev: true, out: new DecisionRepository(out) });
      const rows = out.all<{ input_hash: string; state_version: string; requested_action: string; risk_result: string }>(`SELECT r.input_hash, r.state_version, a.requested_action, a.risk_result FROM jev_requests r JOIN jev_answers a USING (decision_id) ORDER BY r.timestamp_ms, r.state_version`);
      return { r, rows, calls: jev.seen.length };
    };
    const a = await replayOnce();
    const b = await replayOnce();
    expect(a.rows.length).toBeGreaterThan(0);
    expect(a.rows).toEqual(b.rows);
    expect(a.calls).toBe(b.calls);
    expect(a.rows.every((r) => r.risk_result === "REJECTED")).toBe(true); // replay is observe-mode: nothing is ever "approved" for real

    // The same recording through the paper engine, twice, with the same seed: identical fills and PnL.
    const paperOnce = async () => {
      const out = openDatabase(":memory:");
      const jev = scriptedJev((s) => (s.inventory.upShares > 0 ? answersFor("HOLD", "NORMAL") : answersFor("BUY_UP", "IMMEDIATE")));
      const r = await paperMarket({ identity, events, outcome: "UP", limits: cfg.limits, heartbeatMs: cfg.jev.heartbeatMs, minIntervalMs: cfg.jev.minIntervalMs, latencyMs: 50, fill: { ...DEFAULT_FILL_PARAMS, slippage: 0 }, seed: 7, mergeGas: 0, cached: () => undefined, call: jev.call, out: new DecisionRepository(out), outDb: out, mode: "backtest" });
      const fills = out.all<{ side: string; price: number; size: number }>(`SELECT side, price, size FROM fills ORDER BY ts_ms`);
      return { net: r.netPnl, fills, orders: r.orders };
    };
    const p = await paperOnce();
    const q = await paperOnce();
    expect(p.fills.length).toBeGreaterThan(0);
    expect(p).toEqual(q);
    expect(p.net).toBeCloseTo(p.fills.reduce((s, f) => s + (1 - f.price) * f.size, 0), 9);
  }, 20_000);
});
