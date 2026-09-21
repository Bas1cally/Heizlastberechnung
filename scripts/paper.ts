/**
 * Paper trading over recorded markets (brief §38).
 *
 *   pnpm bot:paper                    # cached Jev answers only
 *   pnpm bot:paper -- --jev           # call Jev for uncached states
 *   pnpm bot:paper -- --latency 400 --seed 7
 *
 * Output: data/paper.sqlite and reports/backtest-summary.json. Never sends
 * anything anywhere.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { openDatabase } from "../src/persistence/database.js";
import { DecisionRepository } from "../src/persistence/repositories/decisions.js";
import { createJevCall } from "../src/jev/client.js";
import { loadMarketIdentity, loadReplayEvents } from "../src/replay/replay-engine.js";
import { loadMarketOutcomes } from "../src/analytics/observations.js";
import { DEFAULT_FILL_PARAMS } from "../src/replay/paper-fill-model.js";
import { paperMarket, type PaperMarketResult } from "../src/replay/paper-engine.js";

loadEnvFile();
const cfg = loadConfig();
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d: number) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };

const src = openDatabase(cfg.databaseUrl);
const srcRepo = new DecisionRepository(src);
const outDb = openDatabase("data/paper.sqlite");
const out = new DecisionRepository(outDb);
const call = flag("jev") && cfg.typesafeApiKey ? createJevCall({ apiKey: cfg.typesafeApiKey, model: cfg.typesafeModel, timeoutMs: 10_000, retries: 2 }) : undefined;
const latencyMs = opt("latency", 350);
const seed = opt("seed", 1);

const outcomes = loadMarketOutcomes(src, Date.now()).filter((m) => m.outcome);
console.log(`paper: ${outcomes.length} resolved market(s), latency ${latencyMs} ms, seed ${seed}, jev ${call ? "cache-then-call" : "cache only"}\n`);

const results: PaperMarketResult[] = [];
for (const m of outcomes) {
  const identity = loadMarketIdentity(src, m.marketId);
  if (!identity) continue;
  const r = await paperMarket({
    identity, events: loadReplayEvents(src, m.marketId), outcome: m.outcome!, limits: cfg.limits,
    heartbeatMs: cfg.jev.heartbeatMs, minIntervalMs: cfg.jev.minIntervalMs, latencyMs, fill: DEFAULT_FILL_PARAMS, seed, mergeGas: 0,
    cached: (h) => srcRepo.cachedAnswers(h), call, out, outDb, mode: "paper",
  });
  results.push(r);
  console.log(`${r.slug}  ${r.outcome.padEnd(4)}  dec ${String(r.decisions).padStart(3)} appr ${String(r.approved).padStart(3)}  orders ${String(r.orders).padStart(3)} fills ${String(r.fills).padStart(3)} part ${String(r.partials).padStart(2)} miss ${String(r.noFills).padStart(3)}  merges ${r.merges}  pos UP ${r.finalPosition.upShares}/DOWN ${r.finalPosition.downShares}  net ${r.netPnl.toFixed(3)}`);
}

const sum = (f: (r: PaperMarketResult) => number) => results.reduce((s, r) => s + f(r), 0);
const orders = sum((r) => r.orders);
const summary = {
  generatedAt: new Date().toISOString(), markets: results.length, latencyMs, seed, fillParams: DEFAULT_FILL_PARAMS,
  decisions: sum((r) => r.decisions), approved: sum((r) => r.approved), orders,
  fillRatio: orders ? sum((r) => r.fills + r.partials) / orders : null,
  partialRatio: orders ? sum((r) => r.partials) / orders : null,
  merges: sum((r) => r.merges),
  grossPnl: sum((r) => r.grossPnl), netPnl: sum((r) => r.netPnl), mergePnl: sum((r) => r.mergePnl), fees: sum((r) => r.fees),
  pnlPerMarket: results.length ? sum((r) => r.netPnl) / results.length : null,
  worstMarket: results.length ? Math.min(...results.map((r) => r.netPnl)) : null,
  bestMarket: results.length ? Math.max(...results.map((r) => r.netPnl)) : null,
  skippedNoJev: sum((r) => r.skippedNoJev),
  note: "Simulated fills against recorded books at 500 ms resolution with a fixed latency; no live order was ever built.",
  perMarket: results,
};
mkdirSync("reports", { recursive: true });
writeFileSync("reports/backtest-summary.json", JSON.stringify(summary, null, 2));
console.log(`\ntotal net ${summary.netPnl.toFixed(3)} over ${results.length} market(s); fill ratio ${summary.fillRatio === null ? "-" : (summary.fillRatio * 100).toFixed(0) + "%"}; written reports/backtest-summary.json`);
if (summary.skippedNoJev > 0 && !call) console.log(`${summary.skippedNoJev} state(s) had no cached answer; run with --jev to evaluate them`);
