/**
 * Consistency scan over Polymarket's active markets (docs/JEV_DECISIONS.md,
 * "Jev where the judgment is"): fetch the catalogue, pair markets that could
 * be logically related, ask Jev the relation for each pair (cached in
 * data/scan.sqlite so a re-run only judges new pairs), check the prices
 * against the relation, write reports/consistency.{json,txt}. The sync
 * pushes the reports.
 *
 *   pnpm scan                      # all active markets with >= 500 USD liquidity
 *   pnpm scan -- --min-liquidity 2000 --max-pairs 4000 --concurrency 4
 */
import { createPublicClient } from "@polymarket/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { createFocusedAsk } from "../src/jev/client.js";
import { openDatabase } from "../src/persistence/database.js";
import { candidatePairs, checkPrices, RELATION_QUESTION, renderReport, type JudgedPair, type Relation, type ScanMarket } from "../src/analytics/consistency.js";

loadEnvFile();
const cfg = loadConfig();
const argv = process.argv.slice(2);
const opt = (n: string, d: number) => { const i = argv.indexOf(`--${n}`); const v = i >= 0 ? Number(argv[i + 1]) : d; return Number.isFinite(v) ? v : d; };
const minLiquidity = opt("min-liquidity", 500), maxPairs = opt("max-pairs", 6000), concurrency = opt("concurrency", 4), maxMarkets = opt("max-markets", 20000);
if (!cfg.typesafeApiKey) { console.error("TYPESAFE_API_KEY is not set"); process.exit(1); }
const say = (msg: string, fields: Record<string, unknown> = {}) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), msg, ...fields }) + "\n");

const client = createPublicClient();
const num = (x: unknown): number | null => { const n = Number(x); return x === null || x === undefined || !Number.isFinite(n) ? null : n; };

async function fetchMarkets(): Promise<ScanMarket[]> {
  const out: ScanMarket[] = [];
  const paginator = client.listMarkets({ closed: false, pageSize: 100, liquidityNumMin: minLiquidity, order: "liquidityNum", ascending: false } as never);
  for await (const page of paginator as AsyncIterable<{ items: readonly Record<string, unknown>[] }>) {
    for (const raw of page.items) {
      const m = raw as { id: string; slug?: string | null; question?: string | null; description?: string | null; state: { active?: boolean | null; closed?: boolean | null; negRisk?: boolean | null; endDate?: string | null; acceptingOrders?: boolean | null }; outcomes: { yes: { tokenId: string | null; price: string | null }; no: { tokenId: string | null } }; metrics: { liquidityNum?: string | null; liquidity?: string | null; volume24hr?: string | null }; prices: { bestBid?: string | null; bestAsk?: string | null }; trading: { feesEnabled?: boolean | null }; events: { slug: string | null; title: string | null }[] };
      if (m.state.closed || m.state.active === false || !m.question) continue;
      out.push({
        id: String(m.id), slug: m.slug ?? String(m.id), question: m.question, description: (m.description ?? "").slice(0, 700),
        eventSlug: m.events[0]?.slug ?? null, eventTitle: m.events[0]?.title ?? null, endDate: m.state.endDate ?? null, negRisk: !!m.state.negRisk,
        yesTokenId: m.outcomes.yes.tokenId, noTokenId: m.outcomes.no.tokenId, yesPrice: num(m.outcomes.yes.price),
        bestBid: num(m.prices.bestBid), bestAsk: num(m.prices.bestAsk), liquidity: num(m.metrics.liquidityNum ?? m.metrics.liquidity) ?? 0, volume24h: num(m.metrics.volume24hr) ?? 0,
        feesEnabled: m.trading.feesEnabled ?? null,
      });
    }
    say("fetched", { markets: out.length });
    if (out.length >= maxMarkets) break;
  }
  return out;
}

const db = openDatabase("data/scan.sqlite");
db.run(`CREATE TABLE IF NOT EXISTS pair_judgments (pair_key TEXT PRIMARY KEY, a_id TEXT, b_id TEXT, relation TEXT, confidence REAL, probabilities_json TEXT, model TEXT, latency_ms INTEGER, judged_ms INTEGER)`);
const ask = createFocusedAsk({ apiKey: cfg.typesafeApiKey, model: cfg.typesafeModel, timeoutMs: 10_000 });

async function judge(a: ScanMarket, b: ScanMarket): Promise<{ relation: Relation; confidence: number }> {
  const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
  const cached = db.get<{ relation: string; confidence: number; a_id: string }>(`SELECT relation, confidence, a_id FROM pair_judgments WHERE pair_key = ?`, [key]);
  if (cached) {
    // The cached relation was judged with a_id as A; flip if the roles are reversed now.
    const flip: Record<string, Relation> = { A_IMPLIES_B: "B_IMPLIES_A", B_IMPLIES_A: "A_IMPLIES_B" };
    const rel = cached.relation as Relation;
    return { relation: cached.a_id === a.id ? rel : (flip[rel] ?? rel), confidence: cached.confidence };
  }
  const state = {
    A: { question: a.question, rules: a.description, resolvesBy: a.endDate, event: a.eventTitle },
    B: { question: b.question, rules: b.description, resolvesBy: b.endDate, event: b.eventTitle },
  };
  const r = await ask("relation", RELATION_QUESTION, state, new AbortController().signal);
  db.run(`INSERT OR REPLACE INTO pair_judgments (pair_key, a_id, b_id, relation, confidence, probabilities_json, model, latency_ms, judged_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
    [key, a.id, b.id, r.choice, r.confidence, JSON.stringify(r.probabilities), r.model, r.latencyMs, Date.now()]);
  return { relation: r.choice as Relation, confidence: r.confidence };
}

const markets = await fetchMarkets();
const candidates = candidatePairs(markets).slice(0, maxPairs);
say("candidates", { markets: markets.length, pairs: candidates.length });
const judged: JudgedPair[] = [];
let i = 0, failed = 0;
const started = Date.now();
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (;;) {
    const c = candidates[i++];
    if (!c) return;
    try {
      const j = await judge(c.a, c.b);
      judged.push({ a: c.a, b: c.b, why: c.why, relation: j.relation, confidence: j.confidence, violation: checkPrices(j.relation, c.a, c.b) });
    } catch (err) {
      failed++;
      if (failed <= 5) say("judgment failed", { a: c.a.slug, b: c.b.slug, err: err instanceof Error ? err.message : String(err) });
    }
    if (judged.length % 200 === 0) say("progress", { judged: judged.length, failed, elapsedS: Math.round((Date.now() - started) / 1000) });
  }
}));
const btc = markets.filter((m) => /^btc-updown-5m-/.test(m.slug));
const feeNotes = [`btc-updown-5m markets seen: ${btc.length}, feesEnabled: ${[...new Set(btc.map((m) => String(m.feesEnabled)))].join("/") || "n/a"}`, `all markets with feesEnabled=true: ${markets.filter((m) => m.feesEnabled === true).length} of ${markets.length}`];
mkdirSync("reports", { recursive: true });
const meta = { markets: markets.length, candidates: candidates.length, judged: judged.length, generatedAt: new Date().toISOString(), feeNotes };
writeFileSync("reports/consistency.txt", renderReport(judged, meta));
writeFileSync("reports/consistency.json", JSON.stringify({ ...meta, failed, pairs: judged.map((p) => ({ a: { id: p.a.id, slug: p.a.slug, question: p.a.question, yes: p.a.yesPrice, bid: p.a.bestBid, ask: p.a.bestAsk, liquidity: p.a.liquidity }, b: { id: p.b.id, slug: p.b.slug, question: p.b.question, yes: p.b.yesPrice, bid: p.b.bestBid, ask: p.b.bestAsk, liquidity: p.b.liquidity }, why: p.why, relation: p.relation, confidence: p.confidence, violation: p.violation ?? null })) }, null, 1));
say("done", { judged: judged.length, failed, executable: judged.filter((p) => (p.violation?.executable ?? 0) > 0.005).length, tookS: Math.round((Date.now() - started) / 1000) });
process.stdout.write(renderReport(judged, meta).split("\n").slice(0, 60).join("\n") + "\n");
db.close();
