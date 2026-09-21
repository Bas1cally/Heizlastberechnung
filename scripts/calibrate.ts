/**
 * Calibration and naive-edge reports (brief §27, §28, §30, §37) from what
 * the observer recorded.
 *
 *   pnpm calibrate
 *
 * Writes reports/calibration.csv, reports/calibration.json,
 * reports/edge-by-time.csv, reports/edge-by-price.csv.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { openDatabase } from "../src/persistence/database.js";
import { loadMarketOutcomes, loadObservations, marketConsistency } from "../src/analytics/observations.js";
import { brierScore, calibrationByConfidence, calibrationByTime, edgeByPrice, edgeByTime, naiveEdge, toCsv } from "../src/analytics/calibration.js";

loadEnvFile();
const cfg = loadConfig();
const db = openDatabase(cfg.databaseUrl);

const outcomes = loadMarketOutcomes(db, Date.now());
const resolved = outcomes.filter((o) => o.outcome);
const obs = loadObservations(db, outcomes);

const conf = calibrationByConfidence(obs);
const time = calibrationByTime(obs);
const byTime = edgeByTime(obs);
const byPrice = edgeByPrice(obs);
const edges = obs.map(naiveEdge);
const consistency = marketConsistency(db, Date.now());

const summary = {
  generatedAt: new Date().toISOString(),
  markets: { total: outcomes.length, resolved: resolved.length, byFeed: resolved.filter((o) => o.source === "feed").length, derivedFromTicks: resolved.filter((o) => o.source === "derived").length,
    upShare: resolved.length ? resolved.filter((o) => o.outcome === "UP").length / resolved.length : null },
  observations: obs.length,
  overall: obs.length ? {
    brier: brierScore(obs),
    directionalAccuracy: obs.filter((o) => (o.pUp >= 0.5) === o.outcomeUp).length / obs.length,
    meanUnresolvedMass: obs.reduce((s, o) => s + o.unresolvedMass, 0) / obs.length,
    naiveGrossPnlPerShare: edges.reduce((s, e) => s + e.pnl, 0) / edges.length,
    naiveWinRate: edges.filter((e) => e.pnl > 0).length / edges.length,
    note: "naive = buy Jev's favoured side at the executable ask on every decision; no fees, fills or slippage. An upper bound, not a forecast.",
  } : null,
  calibrationByConfidence: conf,
  calibrationByTime: time,
  edgeByTime: byTime,
  edgeByPrice: byPrice,
  consistency,
  perMarket: outcomes.map((o) => ({ slug: o.slug, outcome: o.outcome ?? null, source: o.source, decisions: o.decisions, derivedStart: o.derivedStart ?? null, derivedEnd: o.derivedEnd ?? null })),
};

mkdirSync("reports", { recursive: true });
writeFileSync("reports/calibration.json", JSON.stringify(summary, null, 2));
writeFileSync("reports/calibration.csv", toCsv(conf as unknown as Record<string, unknown>[]));
writeFileSync("reports/edge-by-time.csv", toCsv(byTime as unknown as Record<string, unknown>[]));
writeFileSync("reports/edge-by-price.csv", toCsv(byPrice as unknown as Record<string, unknown>[]));

const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : "  -  ");
console.log(`markets: ${outcomes.length} total, ${resolved.length} resolved (${summary.markets.byFeed} by feed, ${summary.markets.derivedFromTicks} derived), UP share ${summary.markets.upShare === null ? "-" : (summary.markets.upShare * 100).toFixed(0) + "%"}`);
console.log(`observations: ${obs.length}\n`);
if (summary.overall) {
  console.log(`overall: brier ${fmt(summary.overall.brier)}  accuracy ${fmt(summary.overall.directionalAccuracy)}  naive pnl/share ${fmt(summary.overall.naiveGrossPnlPerShare)}  win ${fmt(summary.overall.naiveWinRate)}\n`);
  console.log("calibration by confidence   n     predicted  observed   error    brier");
  for (const r of conf) console.log(`  ${r.bucket.padEnd(12)} ${String(r.n).padStart(6)}   ${fmt(r.predicted)}     ${fmt(r.observed)}   ${fmt(r.calibrationError)}   ${fmt(r.brier)}`);
  console.log("\nnaive edge by time          n     ask      jevEdge  pnl/share  win");
  for (const r of byTime) console.log(`  ${r.bucket.padEnd(12)} ${String(r.n).padStart(6)}   ${fmt(r.meanAsk)}   ${fmt(r.meanJevEdge)}   ${fmt(r.meanPnl)}     ${fmt(r.winRate)}`);
}
console.log("\noutcome cross-check per market   feed  TWAP  spot  market(UPmid)  Jev(last)      start: derived / Jev    first tick +s  last tick -s");
for (const c of consistency) {
  const o = (x: string | undefined) => (x ?? "-").padEnd(5);
  const jf = c.jevFinal ? `${c.jevFinal.side}@${c.jevFinal.secondsRemaining}s`.padEnd(13) : "-".padEnd(13);
  console.log(`  ${c.slug.slice(-10)}  ${o(c.feed)} ${o(c.twap?.outcome)} ${o(c.spot?.outcome)} ${o(c.marketImplied)}(${c.marketUpMid === undefined ? "  -  " : c.marketUpMid.toFixed(3)})  ${jf}  ${(c.twap ?? c.spot) ? (c.twap ?? c.spot)!.startPrice.toFixed(1) : "-"} / ${c.jevFinal ? c.jevFinal.start.toFixed(1) : "-"}   ${c.twapFirstAfterOpenS ?? "-"}  ${c.twapLastBeforeCloseS ?? "-"}${c.agree ? "" : "   <-- " + c.notes.join("; ")}`);
}
console.log(`  ${consistency.filter((c) => c.agree).length} of ${consistency.length} market(s) consistent across all sources`);
console.log("\nwritten: reports/calibration.{json,csv}, reports/edge-by-time.csv, reports/edge-by-price.csv");
