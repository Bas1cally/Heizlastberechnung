import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";
import { buildHoldRateTable, HoldRateTable } from "../../src/analytics/hold-rate.js";

describe("hold-rate table", () => {
  it("counts, per distance and time bucket, how often the leading side won; only markets recorded from the open, only markets already over", () => {
    const db = openDatabase(":memory:");
    const repo = new DecisionRepository(db);
    const market = (n: number, path: (sec: number) => number, outcome: "Up" | "Down", lateStart = false) => {
      const open = n * 1_000_000;
      repo.upsertMarket({ marketId: `m${n}`, conditionId: "c", slug: `s${n}`, question: "q", upAssetId: "u", downAssetId: "d", openedAtMs: open, closesAtMs: open + 300_000, tickSize: 0.01, minOrderSize: 5 }, 0);
      db.run(`UPDATE markets SET resolved_outcome = ? WHERE market_id = ?`, [outcome, `m${n}`]);
      for (let sec = lateStart ? 20 : 0; sec < 300; sec++) repo.saveTick(`m${n}`, "chainlink-twap60", open + sec * 1000, open + sec * 1000, path(sec));
    };
    // Market 1: leads UP by ~8 bps from second 10 on, resolves UP.
    market(1, (s) => (s < 10 ? 100_000 : 100_080), "Up");
    // Market 2: same lead, reverses at the end, resolves DOWN.
    market(2, (s) => (s < 10 ? 100_000 : s < 280 ? 100_080 : 99_990), "Down");
    // Market 3: recorded 20 s late: excluded.
    market(3, () => 100_080, "Up", true);
    // Market 4: not over yet at the time of the lookup: excluded.
    market(4, () => 100_080, "Up");

    const table = buildHoldRateTable(db, 4 * 1_000_000 + 10_000);
    expect(table.markets).toBe(2);
    const e = table.estimate(8, 200, 20, 1)!;          // 5-10bps @ 300-120s: market 1 held, market 2 held too (reversal came later)
    expect(e.bucket).toBe("5-10bps @ 300-120s");
    expect(e.rate).toBe(0.5);                    // per-second samples: half from market 1 (won), half from market 2 (lost)
    expect(e.seconds).toBe(2 * 171);             // seconds 10..180 of each market have >= 120 s left
    expect(e.samples).toBe(2);                   // two markets behind it
    expect(table.estimate(8, 200)).toBeUndefined(); // fewer than 5 markets: no estimate by default
    expect(table.estimate(8, 1, 20, 1)).toBeUndefined(); // <2s bucket for 5-10 bps: market 2 is at -1 bps there, market 1 alone has 2 samples: too few
    expect(table.estimate(8, 200, 100_000, 1)).toBeUndefined();
    expect(HoldRateTable.bucketFor(-3, 45)).toEqual({ distance: "2.5-5bps", time: "60-30s" });
    expect(table.toJSON().cells.every((c) => c.n > 0)).toBe(true);
  });
});
