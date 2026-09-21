/**
 * Summarise what the observer has recorded: decisions, action mix, Jev
 * latency percentiles, pipeline latency, token spend, errors.
 *
 *   pnpm report
 */
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { openDatabase } from "../src/persistence/database.js";
import { percentiles } from "../src/analytics/latency.js";

loadEnvFile();
const cfg = loadConfig();
const db = openDatabase(cfg.databaseUrl);

const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jev_requests`)?.n ?? 0;
const markets = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM markets`)?.n ?? 0;
const tokens = db.get<{ i: number; o: number }>(`SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM jev_requests`);
const actions = db.all<{ a: string; n: number }>(`SELECT requested_action AS a, COUNT(*) AS n FROM jev_answers GROUP BY 1 ORDER BY 2 DESC`);
const risk = db.all<{ r: string; reason: string | null; n: number }>(`SELECT risk_result AS r, risk_reason AS reason, COUNT(*) AS n FROM jev_answers GROUP BY 1,2 ORDER BY 3 DESC`);
const jev = db.all<{ ms: number }>(`SELECT jev_latency_ms AS ms FROM jev_requests`).map((r) => r.ms);
const stages = ["feed_to_state_ms", "state_to_jev_ms", "jev_ms"] as const;
const pipeline = Object.fromEntries(stages.map((s) => [s, percentiles(db.all<{ v: number | null }>(`SELECT ${s} AS v FROM latency_measurements WHERE ${s} IS NOT NULL`).map((r) => r.v as number))]));
const errors = db.all<{ c: string; n: number }>(`SELECT component AS c, COUNT(*) AS n FROM errors GROUP BY 1`);
const lastErrors = db.all<{ ts_ms: number; component: string; message: string }>(`SELECT ts_ms, component, message FROM errors ORDER BY ts_ms DESC LIMIT 5`);
const ticks = db.get<{ n: number; last: number | null }>(`SELECT COUNT(*) AS n, MAX(received_at_ms) AS last FROM ticks`);
const books = db.all<{ asset_id: string; n: number; last: number | null }>(`SELECT asset_id, COUNT(*) AS n, MAX(received_at_ms) AS last FROM orderbook_snapshots GROUP BY 1`);
const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
const perMarket = db.all<{ slug: string; resolved: string | null; n: number; last_state: string | null; last_answers: string | null }>(`
  SELECT m.slug, m.resolved_outcome AS resolved, COUNT(r.decision_id) AS n,
         (SELECT state_json FROM jev_requests r2 WHERE r2.market_id = m.market_id ORDER BY r2.timestamp_ms DESC LIMIT 1) AS last_state,
         (SELECT a.answers_json FROM jev_requests r3 JOIN jev_answers a USING (decision_id) WHERE r3.market_id = m.market_id ORDER BY r3.timestamp_ms DESC LIMIT 1) AS last_answers
  FROM markets m LEFT JOIN jev_requests r ON r.market_id = m.market_id GROUP BY m.market_id ORDER BY m.opened_at_ms`);
const marketRows = perMarket.map((m) => {
  const st = m.last_state ? JSON.parse(m.last_state) : null;
  const an = m.last_answers ? JSON.parse(m.last_answers) : null;
  const probs = an?.settlement_direction?.probabilities ?? {};
  return {
    slug: m.slug, decisions: m.n, resolved: m.resolved,
    finalDistanceBps: st?.market?.distanceBps ?? null,
    finalSecondsRemaining: st?.market?.secondsRemaining ?? null,
    jevFinal: { UP: probs.UP ?? null, DOWN: probs.DOWN ?? null, UNRESOLVED: probs.UNRESOLVED ?? null, action: an?.action?.choice ?? null },
  };
});
const span = db.get<{ a: number | null; b: number | null }>(`SELECT MIN(timestamp_ms) AS a, MAX(timestamp_ms) AS b FROM jev_requests`);

console.log(JSON.stringify({
  database: cfg.databaseUrl,
  markets,
  perMarket: marketRows,
  decisions: n,
  span: span?.a && span?.b ? { from: new Date(span.a).toISOString(), to: new Date(span.b).toISOString(), hours: Number(((span.b - span.a) / 3.6e6).toFixed(2)) } : null,
  tokens: { input: tokens?.i ?? 0, output: tokens?.o ?? 0, perDecision: n ? Number((((tokens?.i ?? 0) + (tokens?.o ?? 0)) / n).toFixed(1)) : null },
  actions: Object.fromEntries(actions.map((r) => [r.a, r.n])),
  risk: risk.map((r) => ({ result: r.r, reason: r.reason, n: r.n })),
  jevLatencyMs: percentiles(jev),
  pipelineLatencyMs: pipeline,
  feeds: {
    chainlinkTicks: { count: ticks?.n ?? 0, last: iso(ticks?.last ?? null) },
    orderbookSnapshots: books.map((b) => ({ asset: b.asset_id.slice(0, 12) + "...", count: b.n, last: iso(b.last) })),
  },
  errors: Object.fromEntries(errors.map((r) => [r.c, r.n])),
  lastErrors: lastErrors.map((e) => ({ at: iso(e.ts_ms), component: e.component, message: e.message })),
}, null, 2));
