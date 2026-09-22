import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chatJson } from "../director/text-venice.js";
import type { FetchLike } from "../director/venice.js";
import { MetaSchema, type Meta } from "./types.js";
import { validComps, type SetData } from "./setdata.js";

/**
 * The current meta, once per day, from a text model on Venice with its web
 * search switched on ("mehrere Seiten durchforsten" happens server-side).
 * Cached as JSON; `--refresh-meta` forces a new fetch.
 */
const SYSTEM = "You are a Teamfight Tactics analyst. Use web search to find the CURRENT set and patch meta from at least three of: tactics.tools, metatft.com, lolchess.gg, mobalytics.gg, tftactics.gg. Report the 8 strongest comps of the current patch as they are named on those sites, with core units, carries, key items, best augments, playstyle (tempo, fast 8, reroll level) and what early signals point to the comp. Also report the 30 augments with the best average placement this patch (name exactly as in the game, avg placement as a number, a note on what they pair with). Use exact champion and augment names of the current set. Output only the JSON.";

export interface MetaOptions { readonly set?: SetData | undefined; readonly apiKey: string; readonly model: string; readonly cachePath: string; readonly maxAgeMs?: number; readonly fetch?: FetchLike | undefined; readonly base?: string | undefined; readonly now?: () => number }

export function loadCachedMeta(path: string, maxAgeMs: number, now = Date.now(), set?: SetData): { meta: Meta; fetchedAt: number } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { fetchedAt: number; meta: unknown };
    const meta = MetaSchema.safeParse(j.meta);
    // A cache from before augment statistics existed is refetched.
    if (!meta.success || now - j.fetchedAt > maxAgeMs || meta.data.augments.length === 0) return undefined;
    // A cache whose comps do not fit the live set (another set, or invented) is refetched.
    if (set && validComps(meta.data.comps, set).keep.length < 3) return undefined;
    return { meta: meta.data, fetchedAt: j.fetchedAt };
  } catch { return undefined; }
}

export async function fetchMeta(o: MetaOptions): Promise<{ meta: Meta; usage: { input_tokens: number; output_tokens: number } }> {
  const now = o.now ?? Date.now;
  const today = new Date(now()).toISOString().slice(0, 10);
  const roster = o.set ? ` The live set is ${o.set.set}. Its champions are exactly: ${o.set.champions.map((c) => c.en).join(", ")}. Use only these champions; comps from any other set are wrong.` : "";
  const r = await chatJson({
    apiKey: o.apiKey, model: o.model, purpose: "tft_meta", system: SYSTEM, user: `Today is ${today}. Find the current TFT meta comps.${roster}`, schema: MetaSchema, maxTokens: 4000, temperature: 0.1, reasoningEffort: "none",
    extra: { venice_parameters: { enable_web_search: "on", include_venice_system_prompt: false } }, fetch: o.fetch, base: o.base, timeoutMs: 180_000,
  });
  let meta = r.value;
  if (o.set) {
    const v = validComps(meta.comps, o.set);
    if (v.keep.length < 3) throw new Error(`meta does not match ${o.set.set}: ${v.dropped.length} of ${meta.comps.length} comps use champions outside the set (e.g. ${v.dropped.slice(0, 2).map((c) => `${c.name}: ${c.core_units.join(", ")}`).join("; ")})`);
    meta = { ...meta, set: o.set.set, comps: v.keep };
  }
  mkdirSync(dirname(o.cachePath), { recursive: true });
  writeFileSync(o.cachePath, JSON.stringify({ fetchedAt: now(), meta }, null, 2));
  return { meta, usage: r.usage };
}

export async function ensureMeta(o: MetaOptions, force = false): Promise<{ meta: Meta; fromCache: boolean }> {
  const cached = force ? undefined : loadCachedMeta(o.cachePath, o.maxAgeMs ?? 24 * 3_600_000, (o.now ?? Date.now)(), o.set);
  if (cached) return { meta: cached.meta, fromCache: true };
  return { meta: (await fetchMeta(o)).meta, fromCache: false };
}
