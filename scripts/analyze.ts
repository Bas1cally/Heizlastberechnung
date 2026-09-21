/**
 * Performance metrics, EV segmentation, Animal00 research and the latency
 * report (brief §12, §19, §26, §30, §37) from what the bot has recorded.
 *
 *   pnpm analyze                    # mode "paper" from the main database
 *   pnpm analyze -- --mode backtest # data/backtest.sqlite
 *
 * Writes reports/metrics-<mode>.json, reports/ev-segments.json (+ CSVs),
 * reports/animal00.json, reports/latency.json. Jev API cost is priced at
 * TYPESAFE_USD_PER_MTOKEN (USD per million tokens, default 0: the account
 * in use is not billed).
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { openDatabase } from "../src/persistence/database.js";
import { loadMarketOutcomes, loadObservations } from "../src/analytics/observations.js";
import { toCsv } from "../src/analytics/calibration.js";
import { animal00, evSegments, executionMetrics, latencyReport, realizedPnlByTime } from "../src/analytics/metrics.js";

loadEnvFile();
const cfg = loadConfig();
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const mode = opt("mode") ?? "paper";
const usdPerMToken = Number(process.env["TYPESAFE_USD_PER_MTOKEN"] ?? 0) || 0;

const db = openDatabase(cfg.databaseUrl);
const outcomes = loadMarketOutcomes(db, Date.now());
const obs = loadObservations(db, outcomes);
const outcomeMap = new Map(outcomes.filter((o) => o.outcome).map((o) => [o.marketId, o.outcome!] as const));

// Execution records: "backtest" lives in its own database.
const execDb = mode === "backtest" ? (existsSync("data/backtest.sqlite") ? openDatabase("data/backtest.sqlite") : undefined) : db;
const metrics = execDb ? executionMetrics(execDb, mode, usdPerMToken) : null;
const realized = execDb ? realizedPnlByTime(execDb, mode, outcomeMap) : [];
const segments = evSegments(obs);
const animal = animal00(obs);
const latency = latencyReport(db, new Date().toISOString());

mkdirSync("reports", { recursive: true });
const w = (name: string, data: unknown) => writeFileSync(`reports/${name}`, typeof data === "string" ? data : JSON.stringify(data, null, 2));
w(`metrics-${mode}.json`, { generatedAt: new Date().toISOString(), mode, usdPerMToken, metrics, realizedPnlByTime: realized, note: metrics ? undefined : `no ${mode} records yet` });
w("ev-segments.json", { generatedAt: new Date().toISOString(), observations: obs.length, resolvedMarkets: outcomeMap.size, note: "naive EV: buy Jev's favoured side at the executable ask, hold to settlement; no fees, fills or slippage. Upper bound.", ...segments });
for (const [k, rows] of Object.entries(segments)) w(`ev-by-${k.replace(/^by/, "").replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "")}.csv`, toCsv(rows as unknown as Record<string, unknown>[]));
w("animal00.json", { generatedAt: new Date().toISOString(), ...animal, definition: "candidate = favoured side asks 0.98-0.995 and the complement asks <= 0.02 at decision time" });
w("latency.json", latency);

const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "  -  " : v.toFixed(d));
const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : (v * 100).toFixed(0) + "%");
console.log(`analyze: ${outcomes.length} market(s), ${outcomeMap.size} resolved, ${obs.length} observation(s); mode ${mode}\n`);
if (metrics) {
  console.log(`${mode}: ${metrics.settledMarkets} settled market(s)  net ${f(metrics.netPnl)}  gross ${f(metrics.grossPnl)}  merge ${f(metrics.mergePnl)}  settlement ${f(metrics.settlementPnl)}  fees ${f(metrics.fees)}  gas ${f(metrics.gas)}`);
  console.log(`  deployed ${f(metrics.deployedCapitalUsd, 2)} USD  ROC ${pct(metrics.returnOnDeployedCapital)}  per market ${f(metrics.pnlPerMarket)}  per fill ${f(metrics.pnlPerFill)}  per Jev call ${f(metrics.pnlPerJevCall, 4)} (${metrics.jevCalls} calls)`);
  console.log(`  max drawdown ${f(metrics.maxDrawdown)}  worst exposure ${f(metrics.worstCaseExposureUsd, 2)} USD  unpaired ${(metrics.unpairedExposure.totalMs / 1000).toFixed(0)} s total, ${pct(metrics.unpairedExposure.shareOfMarketTime)} of market time`);
  console.log(`  orders ${metrics.orders}: filled ${metrics.fills} partial ${metrics.partials} none ${metrics.noFills} cancelled ${metrics.cancelled}  fill ${pct(metrics.fillRatio)}  cancel ${pct(metrics.cancelRatio)}  maker/taker ${metrics.makerFills}/${metrics.takerFills}`);
  console.log(`  Jev tokens ${metrics.jevTokens.input + metrics.jevTokens.output} -> ${f(metrics.jevCostUsd, 4)} USD at ${usdPerMToken}/Mtok; net after Jev cost ${f(metrics.netPnlAfterJevCost)}\n`);
  if (realized.length) {
    console.log("realised PnL by time      fills  shares    cost     pnl    /share   win");
    for (const r of realized) console.log(`  ${r.bucket.padEnd(12)} ${String(r.fills).padStart(6)} ${f(r.shares, 0).padStart(7)} ${f(r.costUsd, 2).padStart(8)} ${f(r.pnl).padStart(8)} ${f(r.pnlPerShare).padStart(8)}   ${pct(r.winRate)}`);
    console.log();
  }
} else console.log(`no ${mode} execution records yet\n`);

const table = (title: string, rows: { bucket: string; n: number; meanAsk: number; meanJevEdge: number; meanPnl: number; winRate: number }[]) => {
  console.log(`${title.padEnd(28)} n     ask     jevEdge  pnl/share  win`);
  for (const r of rows) console.log(`  ${r.bucket.padEnd(12)} ${String(r.n).padStart(6)}   ${f(r.meanAsk)}   ${f(r.meanJevEdge)}   ${f(r.meanPnl)}     ${pct(r.winRate)}`);
  console.log();
};
if (obs.length) {
  table("naive EV by distance", segments.byDistanceBps);
  table("naive EV by 30s vol", segments.byVolatility);
  table("naive EV by Jev confidence", segments.byJevConfidence);
  table("naive EV by action", segments.byAction);
  table("naive EV by pair cost", segments.byPairCost);
  console.log(`animal00: ${animal.candidateStates} candidate state(s) (${pct(animal.candidateShare)} of observations); winner accuracy ${pct(animal.winnerAccuracy)} at mean ask ${f(animal.meanWinnerAsk)}; complement ${f(animal.meanComplementAsk)}; pair cost ${f(animal.meanPairCost)}; pair below par in ${animal.pairBelowParStates} (${pct(animal.pairBelowParShare)}), locked ${f(animal.meanLockedPairPnlPerShare, 4)}/share; naive winner EV ${f(animal.naiveWinnerPnlPerShare, 4)}/share\n`);
}
console.log(`latency: ${latency.decisions} decision(s); Jev p50 ${f(latency.jevLatencyMs.p50, 0)} p95 ${f(latency.jevLatencyMs.p95, 0)} max ${f(latency.jevLatencyMs.max, 0)} ms; over 500 ms ${pct(latency.jevOver["500ms"])}; stale buys ${latency.staleness.staleBuys}/${latency.staleness.buys} (${pct(latency.staleness.staleShare)})`);
console.log(`\nwritten: reports/metrics-${mode}.json, reports/ev-segments.json (+ ev-by-*.csv), reports/animal00.json, reports/latency.json`);
