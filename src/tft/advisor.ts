import { choice, noul, score, type ChoiceResponse, type NoulResponse, type ScoreResponse } from "@typesafe-ai/sdk";
import { z } from "zod";
import { chatJson } from "../director/text-venice.js";
import type { FetchLike } from "../director/venice.js";
import { ACTIONS, type Action, type Advice, type BoardRead, type Comp, type Meta } from "./types.js";

/**
 * The judgment: given what is on screen and what the meta says, which comp
 * to go for and what to do with the gold this round. Jev answers four
 * questions in one call (this is the use case: fast, typed, no prose);
 * without a TypeSafe key a text model on Venice answers the same questions
 * as JSON, slower and pricier per call.
 */
export const compKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "comp";

export function buildState(read: BoardRead, meta: Meta): Record<string, unknown> {
  return {
    stage: read.stage, gold: read.gold, level: read.level, hp: read.hp, phase: read.phase,
    board: read.board, bench: read.bench, shop: read.shop, augments: read.augments, item_bench: read.item_bench,
    comps: meta.comps.map((c) => ({ key: compKey(c.name), name: c.name, tier: c.tier, core_units: c.core_units, carries: c.carries, key_items: c.key_items, playstyle: c.playstyle, when_to_play: c.when_to_play })),
    patch: meta.patch,
  };
}

export function buildQuestions(meta: Meta) {
  const criteria: Record<string, string> = {};
  for (const c of meta.comps) criteria[compKey(c.name)] = `${c.name} (tier ${c.tier}): core ${c.core_units.join(", ")}${c.carries.length ? `; carries ${c.carries.join(", ")}` : ""}${c.key_items.length ? `; items ${c.key_items.join(", ")}` : ""}.`;
  return {
    comp: choice("Which of these current-patch comps is the best target from this exact position? Weigh the units already on board and bench, the items held, the augments taken and the stage against the comp's tier: a lower-tier comp the board already fits beats a top comp that would need a full pivot, especially after stage 3-2.", criteria),
    action: choice("What should the gold do this round? Rolling is right when the level fits the comp's key units and the board needs immediate strength or is one unit from a 2-star carry; levelling when the next level unlocks the comp's core units or the stage rewards tempo; saving when interest is worth more than what a few gold could buy now; buying when the shop already shows units the comp needs.", ACTIONS),
    on_track: noul("The units and items already on board and bench fit the chosen comp well enough that no pivot is needed."),
    urgency: score("How urgent is it to strengthen the board for HP right now?", ["low: HP is comfortable and the streak allows losing", "medium: HP is falling and a few losses more would hurt", "high: HP is critical, every fight must be won"] as const),
  };
}
export type Questions = ReturnType<typeof buildQuestions>;
export type Answers = { comp: ChoiceResponse; action: ChoiceResponse; on_track: NoulResponse; urgency: ScoreResponse };

/** Shop units the chosen comp lists as core or carry. */
export function unitsToBuy(read: BoardRead, comp: Comp | undefined): string[] {
  if (!comp) return [];
  const wanted = new Set([...comp.core_units, ...comp.carries].map((u) => u.toLowerCase()));
  return read.shop.filter((s) => s && wanted.has(s.toLowerCase()));
}

export function adviceFrom(answers: Answers, read: BoardRead, meta: Meta, model: string, latencyMs: number): Advice {
  const key = String(answers.comp.choice);
  const comp = meta.comps.find((c) => compKey(c.name) === key);
  const urg = answers.urgency.score >= 1.5 ? "high" : answers.urgency.score >= 0.5 ? "medium" : "low";
  const action = (answers.action.choice in ACTIONS ? answers.action.choice : "SAVE") as Action;
  const probs = Object.entries(answers.comp.probabilities as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, p]) => `${meta.comps.find((c) => compKey(c.name) === k)?.name ?? k} ${(p * 100).toFixed(0)}%`);
  return {
    comp: comp?.name ?? key, compKey: key, action, buy: unitsToBuy(read, comp), urgency: urg, onTrack: answers.on_track.noul, confidence: answers.comp.confidence,
    reasons: [`comps: ${probs.join(", ")}`, `action ${action} (${(answers.action.confidence * 100).toFixed(0)}%)`, `on track p=${answers.on_track.noul.toFixed(2)}`, `urgency ${urg}`],
    source: "jev", model, latencyMs,
  };
}

export type JevAsk = (state: Record<string, unknown>, questions: Questions) => Promise<{ answers: Answers; model: string; usage: { input_tokens: number; output_tokens: number } }>;

export function createJevAsk(client: { systemOne(req: { state: unknown; questions: Questions }, opts?: unknown): Promise<{ answers: unknown; model: string; usage: { input_tokens: number; output_tokens: number } }> }): JevAsk {
  return async (state, questions) => { const r = await client.systemOne({ state, questions }); return { answers: r.answers as Answers, model: r.model, usage: r.usage }; };
}

const TextAdviceSchema = z.object({ comp_key: z.string(), action: z.enum(["ROLL", "LEVEL", "SAVE", "BUY"]), on_track: z.number().min(0).max(1), urgency: z.enum(["low", "medium", "high"]), reason: z.string() });
export interface TextAdvisorOptions { readonly apiKey: string; readonly model: string; readonly fetch?: FetchLike | undefined; readonly base?: string | undefined }

export async function adviseWithText(read: BoardRead, meta: Meta, o: TextAdvisorOptions, now: () => number = () => performance.now()): Promise<{ advice: Advice; usage: { input_tokens: number; output_tokens: number } }> {
  const t0 = now();
  const q = buildQuestions(meta);
  const r = await chatJson({
    apiKey: o.apiKey, model: o.model, purpose: "tft_advice", system: "You coach one Teamfight Tactics turn. Answer only from the state given; comp_key must be one of the comp keys listed. Output only the JSON.",
    user: JSON.stringify({ state: buildState(read, meta), questions: { comp: q.comp.instructions, action: q.action.instructions, on_track: q.on_track.instructions, urgency: q.urgency.instructions } }), schema: TextAdviceSchema, maxTokens: 400, temperature: 0.1, reasoningEffort: "low", fetch: o.fetch, base: o.base,
  });
  const comp = meta.comps.find((c) => compKey(c.name) === r.value.comp_key);
  const advice: Advice = { comp: comp?.name ?? r.value.comp_key, compKey: r.value.comp_key, action: r.value.action, buy: unitsToBuy(read, comp), urgency: r.value.urgency, onTrack: r.value.on_track, confidence: 0.5, reasons: [r.value.reason], source: "text", model: r.usage.model, latencyMs: Math.round(now() - t0) };
  return { advice, usage: r.usage };
}

export async function adviseWithJev(read: BoardRead, meta: Meta, ask: JevAsk, now: () => number = () => performance.now()): Promise<{ advice: Advice; usage: { input_tokens: number; output_tokens: number } }> {
  const t0 = now();
  const r = await ask(buildState(read, meta), buildQuestions(meta));
  return { advice: adviceFrom(r.answers, read, meta, r.model, Math.round(now() - t0)), usage: r.usage };
}
