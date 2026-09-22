import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Rule } from "./types.js";

const run = promisify(execFile);

/**
 * Review (spec §8): after `done`, ffmpeg extracts the first, middle and last
 * frame; a comparison image puts the identity reference on the left and
 * the output frames on the right. The checklist comes from the rules whose
 * check type is vision or review. The user's verdict has priority over
 * anything a vision call says.
 */
export interface ChecklistItem { readonly rule: string; readonly text_de: string; readonly text_en: string; pass: boolean | null }

export function checklistFrom(rules: readonly Rule[]): ChecklistItem[] {
  return rules.filter((r) => /vision|review/.test(r.check_type) || r.origin.startsWith("review:")).map((r) => ({ rule: r.code, text_de: r.text_de, text_en: r.text_en, pass: null }));
}

async function durationOf(video: string, ffprobe: string): Promise<number> {
  const { stdout } = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", video]);
  const d = Number(stdout.trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** First, middle and last frame as PNGs next to the clip. */
export async function extractFrames(video: string, outDir: string, tools: { ffmpeg?: string; ffprobe?: string } = {}): Promise<string[]> {
  const ffmpeg = tools.ffmpeg ?? "ffmpeg", ffprobe = tools.ffprobe ?? "ffprobe";
  mkdirSync(outDir, { recursive: true });
  const dur = await durationOf(video, ffprobe);
  const stamps = [0, dur / 2, Math.max(0, dur - 0.1)];
  const out: string[] = [];
  for (const [i, t] of stamps.entries()) {
    const p = join(outDir, `frame-${["first", "middle", "last"][i]}.png`);
    await run(ffmpeg, ["-y", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", p]);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/** Left the identity reference, right the frames, scaled to one height. */
export async function compareImage(referenceImage: string | undefined, frames: readonly string[], outPath: string, ffmpeg = "ffmpeg"): Promise<string | undefined> {
  const inputs = [...(referenceImage ? [referenceImage] : []), ...frames];
  if (!inputs.length) return undefined;
  const args = ["-y", ...inputs.flatMap((p) => ["-i", p])];
  const scaled = inputs.map((_, i) => `[${i}:v]scale=-1:480[s${i}]`).join(";");
  const stack = inputs.length > 1 ? `${inputs.map((_, i) => `[s${i}]`).join("")}hstack=inputs=${inputs.length}[out]` : `[s0]copy[out]`;
  args.push("-filter_complex", `${scaled};${stack}`, "-map", "[out]", outPath);
  await run(ffmpeg, args);
  return existsSync(outPath) ? outPath : undefined;
}
