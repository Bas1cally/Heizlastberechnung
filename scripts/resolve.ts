/**
 * Backfill official resolutions for closed markets from Polymarket's
 * resolution API (`client.fetchResolutions({ conditionIds })`, verified in
 * @polymarket/client 0.10.0 types: rows carry `status` and per-outcome
 * `payouts`). The feed's market_resolved event rarely arrives while the
 * market is still being observed, so calibration otherwise rests on outcomes
 * derived from our own ticks.
 *
 *   pnpm resolve
 *
 * Cross-checks every official outcome against the market's own final price.
 * If the API's payout order disagreed with the market on most markets, the
 * outcome index mapping would be wrong; the script then refuses to write.
 */
import { createPublicClient } from "@polymarket/client";
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { openDatabase } from "../src/persistence/database.js";
import { marketConsistency } from "../src/analytics/observations.js";

loadEnvFile();
const cfg = loadConfig();
const db = openDatabase(cfg.databaseUrl);
const client = createPublicClient();

const pending = db.all<{ market_id: string; condition_id: string; slug: string; resolved_outcome: string | null }>(
  `SELECT market_id, condition_id, slug, resolved_outcome FROM markets WHERE closes_at_ms < ? AND (resolved_source IS NULL OR resolved_source <> 'official') ORDER BY opened_at_ms`, [Date.now() - 60_000]);
console.log(`resolve: ${pending.length} closed market(s) without an official outcome`);

type Row = { conditionId?: string; status: string; payouts?: [string, string]; resolvedAt?: string };
const found = new Map<string, Row>();
for (let i = 0; i < pending.length; i += 20) {
  const batch = pending.slice(i, i + 20);
  try {
    const rows = (await client.fetchResolutions({ conditionIds: batch.map((b) => b.condition_id) })) as unknown as Row[];
    for (const r of rows) if (r.conditionId) found.set(r.conditionId.toLowerCase(), r);
  } catch (err) {
    console.error(`  batch ${i / 20 + 1} failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
}

// Outcome index 0 is the market's first outcome ("Up" / "Yes"), index 1 the second.
const decoded = pending.map((m) => {
  const r = found.get(m.condition_id.toLowerCase());
  if (!r || r.status !== "resolved" || !r.payouts) return { ...m, official: undefined as "UP" | "DOWN" | undefined, status: r?.status ?? "not found" };
  const [up, down] = r.payouts.map(Number);
  return { ...m, official: up! > down! ? "UP" as const : down! > up! ? "DOWN" as const : undefined, status: r.status, resolvedAt: r.resolvedAt };
});

const consistency = new Map(marketConsistency(db, Date.now()).map((c) => [c.slug, c]));
const resolved = decoded.filter((d) => d.official);
const comparable = resolved.filter((d) => { const c = consistency.get(d.slug); return c?.marketUpMid !== undefined && Math.abs(c.marketUpMid - 0.5) >= 0.4; });
const agreeing = comparable.filter((d) => consistency.get(d.slug)!.marketImplied === d.official);
console.log(`  ${resolved.length} resolved by the API; ${agreeing.length} of ${comparable.length} agree with the market's own final price`);
if (comparable.length >= 5 && agreeing.length / comparable.length < 0.5) {
  console.error("  the API's payout order disagrees with the market on most markets: outcome index mapping is wrong; nothing written");
  process.exit(2);
}

let written = 0;
for (const d of resolved) {
  db.run(`UPDATE markets SET resolved_outcome = ?, resolved_source = 'official' WHERE market_id = ?`, [d.official === "UP" ? "Up" : "Down", d.market_id]);
  written++;
  const c = consistency.get(d.slug);
  const derived = c?.twap?.outcome ?? c?.spot?.outcome;
  const flag = derived && derived !== d.official ? `   <-- derived ${derived}` : "";
  console.log(`  ${d.slug}  ${d.official}  (market ${c?.marketImplied ?? "-"} @ ${c?.marketUpMid?.toFixed(3) ?? "-"}, Jev ${c?.jevFinal?.side ?? "-"})${flag}`);
}
for (const d of decoded.filter((x) => !x.official)) console.log(`  ${d.slug}  ${d.status}`);
console.log(`\nwritten: ${written} official outcome(s) into ${cfg.databaseUrl}`);
