import { describe, expect, it } from "vitest";
import { MarketObserver } from "../../src/app/observer.js";
import { createClock } from "../../src/feeds/clock.js";
import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";
import { PaperLiveEngine } from "../../src/execution/paper-live-engine.js";
import { DEFAULT_FILL_PARAMS } from "../../src/replay/paper-fill-model.js";
import { collectTrading } from "../../src/app/trading-view.js";
import { executionMetrics } from "../../src/analytics/metrics.js";
import { answersFor, bookStream, identityFor, priceStream, quietLog, scriptedJev, testConfig } from "./helpers.js";

/**
 * The whole PAPER pipeline, end to end, with scripted feeds and a scripted
 * Jev: feeds -> versioned state -> material change -> decision -> risk gate
 * (simulated) -> paper order -> fill after latency -> inventory fed back ->
 * resolution event -> settlement -> persisted PnL -> dashboard + metrics.
 */
describe("paper pipeline end to end", () => {
  it("turns an approved BUY_UP into a fill, feeds the position back, settles at the feed's resolution and persists everything", async () => {
    const cfg = testConfig();
    const db = openDatabase(":memory:");
    const repo = new DecisionRepository(db);
    const clock = createClock();
    const market = identityFor(clock.wall(), 3_500);
    repo.upsertMarket(market, clock.wall());

    // Jev buys UP immediately while flat, then holds; the position it sees is the engine's.
    const jev = scriptedJev((state) => (state.inventory.upShares > 0 ? answersFor("HOLD", "NORMAL") : answersFor("BUY_UP", "IMMEDIATE")));
    const inventories: number[] = [];
    let observer: MarketObserver | undefined;
    const engine = new PaperLiveEngine({
      market, limits: cfg.limits, latencyMs: 50, fill: { ...DEFAULT_FILL_PARAMS, slippage: 0 }, seed: 1, mono: clock.mono, wall: clock.wall, db,
      onInventory: (inv, open) => { inventories.push(inv.upShares); observer?.setInventory(inv); observer?.setOpenOrderCount(open); }, log: () => {},
    });
    let resolvedWith: string | undefined;
    observer = new MarketObserver({
      cfg, log: quietLog(), clock, repo, jevCall: jev.call,
      marketSubscribe: bookStream({ everyMs: 50, resolveAtMs: 2_500, winner: "Up" }),
      chainlinkSubscribe: priceStream((t) => 85_000 + t / 10),
      chainlinkTwapSubscribe: priceStream((t) => 85_000 + t / 20),
      executionMode: "simulated", processName: "paper",
      onBookUpdate: (b, mono) => engine.onBook(b, mono),
      onApproved: (d, snap, mono) => engine.onApproved(d, snap, mono),
      onResolved: (outcome) => { resolvedWith = outcome; if (outcome) engine.settleAt(outcome, clock.mono()); },
    }, market);
    const ticker = setInterval(() => engine.tick(clock.mono()), 50);
    try { await observer.run(300); } finally { clearInterval(ticker); }

    // Decisions were made and recorded with their risk verdicts.
    const decisions = db.all<{ requested_action: string; risk_result: string; risk_reason: string | null }>(`SELECT requested_action, risk_result, risk_reason FROM jev_answers`);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.some((d) => d.requested_action === "BUY_UP" && d.risk_result === "APPROVED")).toBe(true);
    expect(decisions.every((d) => d.risk_reason !== "LIVE_TRADING_DISABLED")).toBe(true); // simulated mode, not "none"

    // Exactly one buy filled: after the first fill Jev saw the position and held.
    const orders = db.all<{ status: string; order_type: string; mode: string; decision_id: string }>(`SELECT status, order_type, mode, decision_id FROM orders`);
    expect(orders.length).toBeGreaterThanOrEqual(1);
    expect(orders[0]).toMatchObject({ status: "FILLED", order_type: "FOK", mode: "paper" });
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jev_requests WHERE decision_id = ?`, [orders[0]!.decision_id])?.n).toBe(1);
    const fills = db.all<{ side: string; price: number; size: number }>(`SELECT side, price, size FROM fills WHERE mode = 'paper'`);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ side: "UP", size: 10 });
    expect(fills[0]!.price).toBeCloseTo(0.45, 9);
    expect(inventories.at(-1)).toBe(10);
    expect(jev.seen.some((s) => s.inventory.upShares === 10)).toBe(true); // the position reached Jev's state

    // Settlement came from the feed's resolution event, at the real outcome.
    expect(resolvedWith).toBe("UP");
    expect(db.get<{ resolved_outcome: string }>(`SELECT resolved_outcome FROM markets`)?.resolved_outcome).toBe("Up");
    const pnl = JSON.parse(db.get<{ pnl_json: string }>(`SELECT pnl_json FROM pnl_snapshots WHERE mode = 'paper'`)!.pnl_json) as { netPnl: number };
    expect(pnl.netPnl).toBeCloseTo(5.5, 9); // 10 x (1 - .45)
    expect(engine.summary()).toMatchObject({ settled: true, outcome: "UP", orders: 1, fills: 1 });

    // The audit trail is complete: latency per decision, heartbeats, and the dashboard/metrics read it back.
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM latency_measurements`)!.n).toBe(decisions.length);
    expect(JSON.parse(repo.getControl("heartbeat:paper")!.value)).toMatchObject({ market: market.slug });
    expect(collectTrading(db, "paper")).toMatchObject({ settledMarkets: 1, wins: 1, fills: 1 });
    expect(collectTrading(db, "live")).toBeNull();
    expect(executionMetrics(db, "paper")).toMatchObject({ settledMarkets: 1, netPnl: pnl.netPnl, fills: 1, takerFills: 1, makerFills: 0 });
  }, 15_000);

  it("never builds an order in observe mode: the gate rejects every buy with LIVE_TRADING_DISABLED", async () => {
    const cfg = testConfig();
    const db = openDatabase(":memory:");
    const repo = new DecisionRepository(db);
    const clock = createClock();
    const market = identityFor(clock.wall(), 3_000);
    repo.upsertMarket(market, clock.wall());
    const jev = scriptedJev(() => answersFor("BUY_UP", "IMMEDIATE"));
    let approved = 0;
    const observer = new MarketObserver({
      cfg, log: quietLog(), clock, repo, jevCall: jev.call,
      marketSubscribe: bookStream({ everyMs: 50 }), chainlinkSubscribe: priceStream((t) => 85_000 + t / 10), chainlinkTwapSubscribe: priceStream((t) => 85_000 + t / 20),
      onApproved: () => { approved++; },
    }, market);
    await observer.run(0);
    const verdicts = db.all<{ risk_result: string; risk_reason: string | null }>(`SELECT risk_result, risk_reason FROM jev_answers`);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((v) => v.risk_result === "REJECTED" && v.risk_reason === "LIVE_TRADING_DISABLED")).toBe(true);
    expect(approved).toBe(0);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM orders`)!.n).toBe(0);
  }, 15_000);
});

describe("settlement start from the tape", () => {
  it("uses the tape's open-second price as the start, records it under the market, and stops deciding at the close", async () => {
    const cfg = testConfig();
    const db = openDatabase(":memory:");
    const repo = new DecisionRepository(db);
    const clock = createClock();
    const market = identityFor(clock.wall(), 2_500);
    repo.upsertMarket(market, clock.wall());
    const jev = scriptedJev(() => answersFor("HOLD", "NORMAL"));
    const observer = new MarketObserver({
      cfg, log: quietLog(), clock, repo, jevCall: jev.call,
      marketSubscribe: bookStream({ everyMs: 50 }), chainlinkSubscribe: priceStream((t) => 85_000 + t / 10), chainlinkTwapSubscribe: priceStream((t) => 85_100 + t / 20),
      settlementStart: { price: 84_990, ts: market.openedAtMs + 400, source: "chainlink-twap60" },
    }, market);
    await observer.run(1_000);
    // Every Jev state carries the tape's start, not the first TWAP tick the observer saw (85_100+).
    expect(jev.seen.length).toBeGreaterThan(0);
    expect(jev.seen.every((s) => s.market.settlementStartPrice === 84_990)).toBe(true);
    expect(db.get<{ price: number; source: string }>(`SELECT price, source FROM ticks WHERE market_id = ? ORDER BY ts_ms LIMIT 1`, [market.marketId])).toMatchObject({ price: 84_990, source: "chainlink-twap60" });
    expect(db.get<{ start_lag_ms: number; start_source: string }>(`SELECT start_lag_ms, start_source FROM markets`)).toEqual({ start_lag_ms: 400, start_source: "chainlink-twap60" });
    // No decision after the close, although the feeds kept ticking through the grace period.
    const lastDecision = db.get<{ t: number }>(`SELECT MAX(timestamp_ms) AS t FROM jev_requests`)!.t;
    expect(lastDecision).toBeLessThan(market.closesAtMs);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ticks WHERE received_at_ms >= ?`, [market.closesAtMs])!.n).toBeGreaterThan(0);
  }, 15_000);
});
