import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A compact copy of the database for analysis elsewhere: every table in
 * full except the two high-volume ones, which are windowed (`sinceMs`) and,
 * for books, thinned to roughly one snapshot per asset per 10 s. Decisions,
 * answers, latency, execution records and errors are complete.
 */
export function exportCompact(srcPath: string, outPath: string, sinceMs: number): { tables: Record<string, number> } {
  mkdirSync(dirname(outPath), { recursive: true });
  rmSync(outPath, { force: true });
  // Not readOnly: the attached output database is written through this connection.
  const db = new DatabaseSync(srcPath);
  try {
    db.exec(`ATTACH DATABASE '${outPath.replace(/'/g, "''")}' AS out`);
    const full = ["markets", "trader_activity", "jev_requests", "jev_answers", "jev_cache", "orders", "fills", "inventory_snapshots", "merges", "redemptions", "latency_measurements", "shadow_orders", "pnl_snapshots", "control", "errors"];
    const tables: Record<string, number> = {};
    for (const t of full) {
      if (t === "trader_activity" && !(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trader_activity'`).get())) continue;
      db.exec(`CREATE TABLE out.${t} AS SELECT * FROM main.${t}`);
      tables[t] = (db.prepare(`SELECT COUNT(*) AS n FROM out.${t}`).get() as { n: number }).n;
    }
    db.prepare(`CREATE TABLE out.ticks AS SELECT * FROM main.ticks WHERE received_at_ms >= ?`).run(sinceMs);
    tables["ticks"] = (db.prepare(`SELECT COUNT(*) AS n FROM out.ticks`).get() as { n: number }).n;
    db.prepare(`CREATE TABLE out.orderbook_snapshots AS SELECT * FROM main.orderbook_snapshots WHERE received_at_ms >= ? AND (received_at_ms / 500) % 20 = 0`).run(sinceMs);
    tables["orderbook_snapshots"] = (db.prepare(`SELECT COUNT(*) AS n FROM out.orderbook_snapshots`).get() as { n: number }).n;
    db.exec(`DETACH DATABASE out`);
    return { tables };
  } finally {
    db.close();
  }
}
