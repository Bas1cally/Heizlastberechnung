/**
 * Causal replay of recorded markets (brief §24, §25).
 *
 *   pnpm replay                       # all recorded markets, cached Jev answers only
 *   pnpm replay -- --jev              # call Jev for states not in the cache
 *   pnpm replay -- --fresh-jev        # ignore the cache entirely
 *   pnpm replay -- --market <id>      # one market
 *
 * Output goes to data/replay.sqlite (override with --out) so live records
 * are never mixed with replayed ones.
 */
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { openDatabase } from "../src/persistence/database.js";
import { DecisionRepository } from "../src/persistence/repositories/decisions.js";
import { createJevCall } from "../src/jev/client.js";
import { loadMarketIdentity, loadReplayEvents, replayMarket } from "../src/replay/replay-engine.js";

loadEnvFile();
const cfg = loadConfig();
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

const src = openDatabase(cfg.databaseUrl);
const srcRepo = new DecisionRepository(src);
const outPath = opt("out") ?? "data/replay.sqlite";
const out = new DecisionRepository(openDatabase(outPath));
const useJev = flag("jev") || flag("fresh-jev");
const call = useJev && cfg.typesafeApiKey ? createJevCall({ apiKey: cfg.typesafeApiKey, model: cfg.typesafeModel, timeoutMs: 10_000, retries: 2 }) : undefined;
if (useJev && !call) { console.error("--jev needs TYPESAFE_API_KEY"); process.exit(1); }

const ids = opt("market") ? [opt("market")!] : src.all<{ market_id: string }>(`SELECT market_id FROM markets WHERE closes_at_ms < ? ORDER BY opened_at_ms`, [Date.now()]).map((r) => r.market_id);
console.log(`replaying ${ids.length} market(s) from ${cfg.databaseUrl} into ${outPath}  (jev: ${call ? (flag("fresh-jev") ? "fresh" : "cache-then-call") : "cache only"})\n`);

let totals = { events: 0, decisions: 0, cacheHits: 0, jevCalls: 0, skippedNoJev: 0 };
for (const id of ids) {
  const identity = loadMarketIdentity(src, id);
  if (!identity) continue;
  const events = loadReplayEvents(src, id);
  const r = await replayMarket({
    identity, events, limits: cfg.limits, heartbeatMs: cfg.jev.heartbeatMs, minIntervalMs: cfg.jev.minIntervalMs,
    cached: (h) => srcRepo.cachedAnswers(h), call, freshJev: flag("fresh-jev"), out,
  });
  totals = { events: totals.events + r.events, decisions: totals.decisions + r.decisions, cacheHits: totals.cacheHits + r.cacheHits, jevCalls: totals.jevCalls + r.jevCalls, skippedNoJev: totals.skippedNoJev + r.skippedNoJev };
  console.log(`${identity.slug}: ${r.events} events -> ${r.decisions} decisions (${r.cacheHits} cached, ${r.jevCalls} jev calls, ${r.skippedNoJev} skipped)`);
}
console.log(`\ntotal: ${JSON.stringify(totals)}`);
if (totals.skippedNoJev > 0 && !call) console.log("states without a cached answer were skipped; run with --jev to evaluate them");
