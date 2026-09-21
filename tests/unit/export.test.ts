import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";
import { exportCompact } from "../../src/persistence/export.js";

describe("exportCompact", () => {
  it("copies the small tables in full and windows the high-volume ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-export-"));
    try {
      const src = join(dir, "src.sqlite");
      const repo = new DecisionRepository(openDatabase(src));
      repo.upsertMarket({ marketId: "m", conditionId: "c", slug: "s", question: "q", upAssetId: "u", downAssetId: "d", openedAtMs: 0, closesAtMs: 1, tickSize: 0.01, minOrderSize: 5 }, 0);
      for (let t = 0; t < 60_000; t += 1000) repo.saveTick("m", "chainlink", t, t, 1);
      for (let t = 0; t < 60_000; t += 500) repo.saveBook("m", "u", t, [], []);
      repo.saveError("x", "old", "m", 5);
      const out = join(dir, "out.sqlite");
      const { tables } = exportCompact(src, out, 30_000);
      expect(tables["markets"]).toBe(1);
      expect(tables["errors"]).toBe(1);
      expect(tables["ticks"]).toBe(30);           // only the last 30 s
      expect(tables["orderbook_snapshots"]).toBe(3); // 30 s window thinned to one per 10 s
      const copy = openDatabase(out);
      expect(copy.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jev_requests`)!.n).toBe(0);
      expect(copy.get<{ slug: string }>(`SELECT slug FROM markets`)!.slug).toBe("s");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
