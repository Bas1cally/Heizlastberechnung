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
const span = db.get<{ a: number | null; b: number | null }>(`SELECT MIN(timestamp_ms) AS a, MAX(timestamp_ms) AS b FROM jev_requests`);

console.log(JSON.stringify({
  database: cfg.databaseUrl,
  markets,
  decisions: n,
  span: span?.a && span?.b ? { from: new Date(span.a).toISOString(), to: new Date(span.b).toISOString(), hours: Number(((span.b - span.a) / 3.6e6).toFixed(2)) } : null,
  tokens: { input: tokens?.i ?? 0, output: tokens?.o ?? 0, perDecision: n ? Number((((tokens?.i ?? 0) + (tokens?.o ?? 0)) / n).toFixed(1)) : null },
  actions: Object.fromEntries(actions.map((r) => [r.a, r.n])),
  risk: risk.map((r) => ({ result: r.r, reason: r.reason, n: r.n })),
  jevLatencyMs: percentiles(jev),
  pipelineLatencyMs: pipeline,
  errors: Object.fromEntries(errors.map((r) => [r.c, r.n])),
}, null, 2));
