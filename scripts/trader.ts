/**
 * Pull a wallet's public trading history from Polymarket's data API and
 * measure its behaviour on the BTC 5-minute markets, trade by trade
 * (brief §19: test the Animal00 pattern against facts, not claims).
 *
 *   pnpm trader -- 0x55aeeb3eb4e8cc0da6d9e4939caf533bf6c3f5df
 *   pnpm trader -- 0x... --days 30
 *
 * Uses `client.listActivity({ user, window })` (verified in
 * @polymarket/client 0.10.0: TRADE rows carry side, price, shares, amount,
 * outcome, slug, conditionId, timestamp; MERGE / REDEEM / SPLIT rows carry
 * amount) and `listPositions({ user })`. Rows land in `trader_activity`
 * (exported by pnpm sync); the summary goes to reports/trader-<wallet>.json
 * and to stdout.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient } from "@polymarket/client";
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { openDatabase } from "../src/persistence/database.js";
import { parseSlug } from "../src/market/window.js";
import { TIME_BUCKETS } from "../src/analytics/calibration.js";
import { analyzeTrader, type ActivityRow } from "../src/analytics/trader.js";

loadEnvFile();
const cfg = loadConfig();
const argv = process.argv.slice(2);
const wallet = argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a))?.toLowerCase();
if (!wallet) { console.error("usage: pnpm trader -- 0x<wallet> [--days 7]"); process.exit(1); }
const daysIdx = argv.indexOf("--days");
const days = daysIdx >= 0 ? Number(argv[daysIdx + 1]) : 7;

const db = openDatabase(cfg.databaseUrl);
db.run(`CREATE TABLE IF NOT EXISTS trader_activity (
  wallet TEXT NOT NULL, type TEXT NOT NULL, condition_id TEXT, slug TEXT, outcome TEXT, side TEXT,
  price REAL, shares REAL, amount REAL, ts_ms INTEGER NOT NULL, tx_hash TEXT, raw_json TEXT NOT NULL,
  PRIMARY KEY (wallet, tx_hash, type, condition_id, outcome, side, price, shares, ts_ms))`);
db.run(`CREATE INDEX IF NOT EXISTS trader_activity_wallet_ts ON trader_activity(wallet, ts_ms)`);

const client = createPublicClient();
type Act = { type: string; timestamp: number; transactionHash: string; conditionId?: string; slug?: string; outcome?: string; side?: string; price?: string; shares?: string; amount?: string | null };
const paginator = (client as unknown as { listActivity(r: { user: string; pageSize: number; window: { start: number } }): AsyncIterable<{ items: Act[] }> })
  .listActivity({ user: wallet, pageSize: 100, window: { start: Date.now() - days * 86_400_000 } });

let fetched = 0, inserted = 0, pages = 0;
for await (const page of paginator) {
  pages++;
  for (const a of page.items) {
    fetched++;
    const before = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM trader_activity WHERE wallet = ? AND tx_hash = ? AND type = ? AND ts_ms = ? AND IFNULL(price, -1) = IFNULL(?, -1) AND IFNULL(shares, -1) = IFNULL(?, -1) AND IFNULL(outcome,'') = IFNULL(?,'')`,
      [wallet, a.transactionHash, a.type, a.timestamp, a.price === undefined ? null : Number(a.price), a.shares === undefined ? null : Number(a.shares), a.outcome ?? null])?.n ?? 0;
    if (before) continue;
    db.run(`INSERT OR IGNORE INTO trader_activity (wallet, type, condition_id, slug, outcome, side, price, shares, amount, ts_ms, tx_hash, raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [wallet, a.type, a.conditionId ?? null, a.slug ?? null, a.outcome ?? null, a.side ?? null, a.price === undefined ? null : Number(a.price), a.shares === undefined ? null : Number(a.shares), a.amount === undefined || a.amount === null ? null : Number(a.amount), a.timestamp, a.transactionHash, JSON.stringify(a)]);
    inserted++;
  }
  process.stdout.write(`\rfetched ${fetched} activity rows (${pages} pages), ${inserted} new`);
  if (pages >= 400) { console.log("\nstopping at 400 pages"); break; }
}
console.log();

const rows = db.all<ActivityRow>(`SELECT type, condition_id AS conditionId, slug, outcome, side, price, shares, amount, ts_ms AS tsMs, tx_hash AS txHash FROM trader_activity WHERE wallet = ? ORDER BY ts_ms`, [wallet]);
const resolved = new Map(db.all<{ slug: string; resolved_outcome: string | null }>(`SELECT slug, resolved_outcome FROM markets WHERE resolved_outcome IS NOT NULL`).map((m) => [m.slug, m.resolved_outcome!]));
const report = analyzeTrader(rows, (slug) => { const p = parseSlug(slug); return p ? { openedAtMs: p.openedAtMs, closesAtMs: p.closesAtMs } : undefined; }, (slug) => resolved.get(slug));

mkdirSync("reports", { recursive: true });
writeFileSync(`reports/trader-${wallet.slice(0, 10)}.json`, JSON.stringify({ wallet, days, generatedAt: new Date().toISOString(), ...report }, null, 2));

const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(d));
console.log(`\nwallet ${wallet}: ${rows.length} activity row(s) over ${days} day(s); ${report.btcMarkets} BTC 5-minute market(s) touched, ${report.otherMarkets} other market(s)`);
console.log(`BTC 5m: ${report.trades} trade(s), ${report.merges} merge(s), ${report.redeems} redemption(s), ${report.splits} split(s)`);
console.log(`  net cash flow on BTC 5m (redeem + merge + sells - buys): ${f(report.netCashUsd, 2)} USD over ${report.settledMarkets} settled market(s); per market ${f(report.netPerMarket, 4)}; wins ${report.wins} / losses ${report.losses} / flat ${report.flat}`);
console.log(`  buys: ${report.buys} for ${f(report.buyUsd, 2)} USD, mean price ${f(report.meanBuyPrice)}; sells: ${report.sells}`);
console.log(`  markets with both outcomes bought: ${report.marketsBothSides} (${f(report.marketsBothSides / Math.max(1, report.btcMarkets) * 100, 0)}%); markets with a merge: ${report.marketsWithMerge}`);
console.log("\n  buy price bucket      trades   shares      USD   won%(known)");
for (const b of report.buyPriceBuckets) console.log(`  ${b.bucket.padEnd(20)} ${String(b.trades).padStart(6)} ${f(b.shares, 0).padStart(8)} ${f(b.usd, 2).padStart(8)}   ${b.wonRate === null ? "-" : (b.wonRate * 100).toFixed(0) + "% (" + b.known + ")"}`);
console.log("\n  seconds before close  trades   shares   mean price   won%(known)");
for (const b of report.buyTimeBuckets) console.log(`  ${b.bucket.padEnd(20)} ${String(b.trades).padStart(6)} ${f(b.shares, 0).padStart(8)}   ${f(b.meanPrice).padStart(8)}   ${b.wonRate === null ? "-" : (b.wonRate * 100).toFixed(0) + "% (" + b.known + ")"}`);
console.log("\n  per market (last 15):  slug  buys[outcome@price x shares, s before close]  merge  redeem  net");
for (const m of report.perMarket.slice(-15)) console.log(`  ${m.slug.slice(-10)}  ${m.buys.map((b) => `${b.outcome}@${b.price}x${b.shares}(${b.secondsBeforeClose}s)`).join(" ")}  merge ${f(m.mergedUsd, 2)}  redeem ${f(m.redeemedUsd, 2)}  net ${f(m.netUsd, 2)}${m.outcome ? "  [" + m.outcome + "]" : ""}`);
console.log(`\nwritten: reports/trader-${wallet.slice(0, 10)}.json (${TIME_BUCKETS.length} time buckets)`);
