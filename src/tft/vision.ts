import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { chatJson, type ChatContent } from "../director/text-venice.js";
import type { FetchLike } from "../director/venice.js";
import type { ClaudeResult } from "../director/claude.js";
import { BoardReadSchema, type BoardRead } from "./types.js";

/**
 * One screenshot in, one structured board out, through a vision model on
 * Venice. The prompt asks for names as printed in the game, and for empty
 * fields rather than guesses; `confidence` is the reader's own estimate and
 * is measured against hand-labelled screenshots (pnpm tft -- --measure).
 */
const SYSTEM = "You read screenshots of Teamfight Tactics (TFT). The game client may run in German or another language: always write champion, item and augment names as their official ENGLISH names (e.g. German \"Kiesel\" -> its English champion name), so they match English meta sites. Report exactly what is visible: champion names, star levels from the stars above units, items from their icons, gold, level, HP and the stage indicator. Shop slots read left to right; an empty or sold slot is an empty string. When augment cards are offered (three large cards in the middle of the planning board, each with an augment name and effect text), set phase to augment_choice and list the card names left to right in augment_options. The loading screen shows player tacticians (Little Legends, often named Chibi-...), never augments: that is phase loading with empty augment_options. If the screen is not a TFT planning phase, set phase accordingly and leave lists empty. Never invent units that are not clearly visible; lower confidence when text is small or blurred. Output only the JSON.";

export interface VisionOptions { readonly apiKey: string; readonly model: string; readonly fetch?: FetchLike | undefined; readonly base?: string | undefined; readonly reasoningEffort?: string | undefined }

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export function imagePart(path: string): { type: "image_url"; image_url: { url: string } } {
  const mime = MIME[extname(path).toLowerCase()] ?? "image/jpeg";
  return { type: "image_url", image_url: { url: `data:${mime};base64,${readFileSync(path).toString("base64")}` } };
}

export async function readBoard(imagePath: string, o: VisionOptions, hint = ""): Promise<ClaudeResult<BoardRead>> {
  const user: ChatContent = [{ type: "text", text: `Read this TFT screenshot.${hint ? ` Context: ${hint}` : ""}` }, imagePart(imagePath)];
  try {
    const r = await chatJson({ apiKey: o.apiKey, model: o.model, purpose: "tft_read", system: SYSTEM, user, schema: BoardReadSchema, maxTokens: 2000, temperature: 0, reasoningEffort: o.reasoningEffort ?? "none", fetch: o.fetch, base: o.base, timeoutMs: 60_000 });
    // Augment names only count on the augment screen; anywhere else they are misreadings (tacticians on the loading screen).
    if (r.value.phase !== "augment_choice" && r.value.augment_options.length) r.value.augment_options = [];
    return r;
  } catch (err) {
    // An empty list is what the reader sends for loading screens and transitions: a reading with nothing in it, not a failure.
    if (err instanceof Error && /Raw: \[\s*\]/.test(err.message)) return { value: BoardReadSchema.parse({ stage: "", phase: "unknown", confidence: 0 }), usage: { input_tokens: 0, output_tokens: 0, model: o.model }, request: null, response: [] };
    throw err;
  }
}

/** What changed between two readings, for deciding whether to ask the advisor again. */
export function fingerprint(r: BoardRead): string {
  return [r.stage, r.gold, r.level, r.hp, r.phase === "augment_choice" ? `A:${r.augment_options.join("|")}` : "", r.shop.join("|"), r.board.map((u) => `${u.name}${u.stars}`).sort().join("|"), r.bench.map((u) => `${u.name}${u.stars}`).sort().join("|"), r.augments.join("|")].join("#");
}
