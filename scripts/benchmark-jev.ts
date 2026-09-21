/**
 * Jev benchmark (brief §13): speed and consistency on realistic states.
 *
 *   pnpm benchmark:jev                 # 1000 requests from recorded states
 *   pnpm benchmark:jev -- --n 200 --repeat 25
 *
 * States come from `jev_requests.state_json` in the database (recorded by the
 * observer). Without recordings it refuses to run rather than benchmark on
 * invented data. Output: reports/jev-benchmark.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { createJevCall } from "../src/jev/client.js";
import { QUESTIONS } from "../src/jev/questions.js";
import type { JevInputState } from "../src/jev/decision-types.js";
import { openDatabase } from "../src/persistence/database.js";
import { percentiles } from "../src/analytics/latency.js";

loadEnvFile();
const cfg = loadConfig();
const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const N = arg("n", 1000);
const REPEAT = arg("repeat", 20);
const CONCURRENCY = arg("concurrency", 4);

if (!cfg.typesafeApiKey) { console.error("TYPESAFE_API_KEY is not set"); process.exit(1); }

const db = openDatabase(cfg.databaseUrl);
const rows = db.all<{ state_json: string }>(`SELECT state_json FROM jev_requests ORDER BY timestamp_ms DESC LIMIT ?`, [N]);
if (rows.length === 0) {
  console.error("no recorded states in the database - run `pnpm bot:observe` first; this benchmark does not invent market states");
  process.exit(1);
}
const states: JevInputState[] = rows.map((r) => JSON.parse(r.state_json));
const call = createJevCall({ apiKey: cfg.typesafeApiKey, model: cfg.typesafeModel, timeoutMs: 5_000 });

console.log(`benchmark: ${states.length} recorded state(s), target ${N} requests, concurrency ${CONCURRENCY}, stability repeats ${REPEAT}`);

// --- throughput / latency -------------------------------------------------
const latencies: number[] = [];
const errors: Record<string, number> = {};
let success = 0;
let idx = 0;
const t0 = performance.now();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (idx < N) {
      const state = states[idx++ % states.length]!;
      const start = performance.now();
      try {
        await call(state, QUESTIONS, new AbortController().signal);
        latencies.push(performance.now() - start);
        success++;
      } catch (e) {
        const key = e instanceof Error ? e.name : "unknown";
        errors[key] = (errors[key] ?? 0) + 1;
      }
      if ((success + Object.values(errors).reduce((a, b) => a + b, 0)) % 100 === 0) process.stdout.write(".");
    }
  }),
);
const wallMs = performance.now() - t0;
console.log();

// --- stability on one repeated state ---------------------------------------
const probe = states[0]!;
const actions: Record<string, number> = {};
const pUp: number[] = [];
const conf: number[] = [];
for (let i = 0; i < REPEAT; i++) {
  try {
    const r = await call(probe, QUESTIONS, new AbortController().signal);
    actions[r.answers.action.choice] = (actions[r.answers.action.choice] ?? 0) + 1;
    pUp.push((r.answers.settlement_direction.probabilities as Record<string, number>)["UP"] ?? 0);
    conf.push(r.answers.action.confidence);
  } catch { /* counted above */ }
}
const variance = (xs: number[]) => {
  if (xs.length < 2) return NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
};

const report = {
  generatedAt: new Date().toISOString(),
  model: cfg.typesafeModel ?? "jev-latest",
  requests: N,
  success,
  successRate: success / N,
  errors,
  wallMs: Math.round(wallMs),
  requestsPerSecond: Number((N / (wallMs / 1000)).toFixed(2)),
  latencyMs: percentiles(latencies),
  stability: { repeats: REPEAT, actionDistribution: actions, pUpVariance: variance(pUp), confidenceVariance: variance(conf), pUpSamples: pUp },
};
mkdirSync("reports", { recursive: true });
writeFileSync("reports/jev-benchmark.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, stability: { ...report.stability, pUpSamples: undefined } }, null, 2));
console.log("\nwritten: reports/jev-benchmark.json");
