import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";
import { collectTrading } from "../../src/app/trading-view.js";

describe("collectTrading", () => {
  it("is null when the mode has no execution records", () => {
    expect(collectTrading(openDatabase(":memory:"), "paper")).toBeNull();
  });

  it("builds the cumulative curve, drawdown and fill ratio per mode", () => {
    const db = openDatabase(":memory:");
    const repo = new DecisionRepository(db);
    const market = (id: string, closes: number) => repo.upsertMarket({ marketId: id, conditionId: "c", slug: `btc-updown-5m-${id}`, question: "q", upAssetId: "u", downAssetId: "d", openedAtMs: closes - 300_000, closesAtMs: closes, tickSize: 0.001, minOrderSize: 5 }, 0);
    market("1", 1_000); market("2", 2_000); market("3", 3_000);
    for (const [m, net] of [["1", 5], ["2", -8], ["3", 2]] as const) {
      db.run(`INSERT INTO pnl_snapshots (market_id, mode, ts_ms, pnl_json) VALUES (?,?,?,?)`, [m, "paper", 0, JSON.stringify({ netPnl: net, grossPnl: net, fees: 0, gas: 0, mergePnl: 0 })]);
    }
    db.run(`INSERT INTO jev_requests (decision_id, market_id, state_version, input_hash, timestamp_ms, state_json, model, input_tokens, output_tokens, jev_latency_ms) VALUES ('d','1','1','h',0,'{}','m',0,0,0)`);
    db.run(`INSERT INTO orders (order_id, decision_id, state_version, market_id, mode, side, asset_id, order_type, price, size, status, created_ms, updated_ms) VALUES ('o1','d','1','1','paper','UP','u','FOK',0.45,10,'FILLED',0,0)`);
    db.run(`INSERT INTO orders (order_id, decision_id, state_version, market_id, mode, side, asset_id, order_type, price, size, status, created_ms, updated_ms) VALUES ('o2','d','1','1','paper','UP','u','FOK',0.45,10,'NO_FILL',0,0)`);
    db.run(`INSERT INTO fills (order_id, decision_id, state_version, market_id, mode, side, asset_id, price, size, fee, ts_ms) VALUES ('o1','d','1','1','paper','UP','u',0.45,10,0.01,5)`);

    const t = collectTrading(db, "paper")!;
    expect(t.curve.map((c) => c.pnl)).toEqual([5, -3, -1]);
    expect(t.maxDrawdown).toBe(8);
    expect(t.netPnl).toBe(-1);
    expect(t.wins).toBe(2); expect(t.losses).toBe(1);
    expect(t.fillRatio).toBe(0.5);
    expect(t.volumeUsd).toBe(4.5);
    expect(t.recentFills[0]).toMatchObject({ side: "UP", price: 0.45, size: 10 });
    expect(collectTrading(db, "live")).toBeNull();
  });
});
