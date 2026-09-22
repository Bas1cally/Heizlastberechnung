import type { AdviceRow, ReadingRow, TftStore } from "./store.js";
import type { Advice, BoardRead } from "./types.js";

/**
 * One game (or session) in numbers: what was read, what was advised, by
 * whom and how fast, what failed and what it cost. The session is the run
 * of readings since the last gap of more than `gapMs`.
 */
export interface Prices { [model: string]: { inPerM: number; outPerM: number } }
export interface TftReport {
  from: number; to: number; minutes: number;
  readings: number; phases: Record<string, number>; readingMsMedian: number; readConfidenceMedian: number;
  stages: string[]; augmentScreens: number;
  advices: number; bySource: Record<string, { n: number; msMedian: number }>; augmentAdvice: { stage: string; options: string[]; pick: string; source: string }[];
  lastAdvice: { comp: string; action: string; buy: string[] }[];
  errors: { kind: string; n: number; example: string }[];
  tokens: { read: number; advice: number }; usd: number | null;
}

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

export function sessionStart(readings: readonly ReadingRow[], gapMs = 10 * 60_000): number {
  if (!readings.length) return 0;
  let start = readings[readings.length - 1]!.ts;
  for (let i = readings.length - 1; i > 0; i--) { if (readings[i]!.ts - readings[i - 1]!.ts > gapMs) break; start = readings[i - 1]!.ts; }
  return start;
}

export function buildReport(store: TftStore, prices: Prices = {}, since?: number): TftReport {
  const all = store.readingsSince(0);
  const from = since ?? sessionStart(all);
  const readings = store.readingsSince(from);
  const advice = store.adviceSince(from);
  const reads = readings.map((r) => JSON.parse(r.read_json) as BoardRead);
  const phases: Record<string, number> = {};
  for (const r of reads) phases[r.phase] = (phases[r.phase] ?? 0) + 1;
  const stages = [...new Set(reads.map((r) => r.stage).filter((s) => /^\d-\d$/.test(s)))];
  const bySource: Record<string, { n: number; msMedian: number }> = {};
  for (const src of new Set(advice.map((a) => a.source))) { const xs = advice.filter((a) => a.source === src); bySource[src] = { n: xs.length, msMedian: median(xs.map((a) => a.latency_ms)) }; }
  const parsed = advice.map((a: AdviceRow) => ({ row: a, adv: JSON.parse(a.advice_json) as Advice, read: readings.find((r) => r.id === a.reading_id) }));
  const cost = (model: string, i: number, o: number) => { const p = prices[model]; return p ? (i * p.inPerM + o * p.outPerM) / 1e6 : null; };
  const costs = [...readings.map((r) => cost(r.model, r.input_tokens, r.output_tokens)), ...advice.filter((a) => a.source !== "jev").map((a) => cost(a.model, a.input_tokens, a.output_tokens))];
  const to = Math.max(readings.at(-1)?.ts ?? from, advice.at(-1)?.ts ?? from);
  return {
    from, to, minutes: Math.round((to - from) / 60_000),
    readings: readings.length, phases, readingMsMedian: median(readings.map((r) => r.latency_ms)), readConfidenceMedian: median(reads.map((r) => r.confidence)),
    stages, augmentScreens: reads.filter((r) => r.phase === "augment_choice").length,
    advices: advice.length, bySource,
    augmentAdvice: parsed.filter((p) => p.adv.augment).map((p) => ({ stage: p.read ? (JSON.parse(p.read.read_json) as BoardRead).stage : "?", options: p.adv.augment!.options, pick: p.adv.augment!.pick, source: p.adv.source })),
    lastAdvice: parsed.filter((p) => !p.adv.augment).slice(-5).map((p) => ({ comp: p.adv.comp, action: p.adv.action, buy: p.adv.buy })),
    errors: store.errorsSince(from),
    tokens: { read: readings.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0), advice: advice.reduce((s, a) => s + a.input_tokens + a.output_tokens, 0) },
    // Known prices only; Jev is billed by TypeSafe, not Venice. null when no price was known at all.
    usd: costs.some((c) => c !== null) ? costs.reduce((s: number, c) => s + (c ?? 0), 0) : null,
  };
}

const ERR_DE: Record<string, string> = { venice_no_credit: "Venice ohne Guthaben", venice_overloaded: "Modell überlastet (429)", screenshot: "Screenshot fehlgeschlagen", token_limit: "Antwort abgeschnitten (Token-Limit)", bad_answer: "Antwort nicht lesbar", network: "Netz/Timeout", other: "sonstiges" };

export function renderReport(r: TftReport): string {
  const t = (ms: number) => new Date(ms).toLocaleString("de-DE");
  const L: string[] = [];
  L.push(`TFT-Bericht ${r.readings ? `${t(r.from)} bis ${t(r.to)} (${r.minutes} min)` : "(keine Lesungen)"}`);
  L.push("");
  L.push(`Lesungen: ${r.readings}, Median ${(r.readingMsMedian / 1000).toFixed(1)} s, Sicherheit ${r.readConfidenceMedian.toFixed(2)}`);
  L.push(`  Phasen: ${Object.entries(r.phases).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
  L.push(`  Stages gesehen: ${r.stages.join(" ") || "-"}`);
  L.push(`  Augment-Bildschirme erkannt: ${r.augmentScreens}`);
  L.push(`Ratschläge: ${r.advices}${Object.entries(r.bySource).map(([k, v]) => `, ${k} ${v.n}× (Median ${(v.msMedian / 1000).toFixed(1)} s)`).join("")}`);
  for (const a of r.augmentAdvice) L.push(`  Augment ${a.stage}: ${a.pick}  aus  ${a.options.join(" | ")}  [${a.source}]`);
  for (const a of r.lastAdvice) L.push(`  ${a.comp}: ${a.action}${a.buy.length ? ` (${a.buy.join(", ")})` : ""}`);
  L.push(`Fehler: ${r.errors.reduce((s, e) => s + e.n, 0) || "keine"}`);
  for (const e of r.errors) L.push(`  ${ERR_DE[e.kind] ?? e.kind}: ${e.n}×  z. B. ${e.example.replace(/\s+/g, " ").slice(0, 140)}`);
  L.push(`Tokens: lesen ${r.tokens.read}, Rat ${r.tokens.advice}${r.usd !== null ? `, Kosten ca. ${(r.usd * 100).toFixed(2)} Cent (Venice)` : ""}`);
  return L.join("\n");
}
