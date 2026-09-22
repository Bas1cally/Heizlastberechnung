import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Workflow } from "./types.js";

/**
 * What an engine accepts (spec §1, §4): cached in `director/engines.json`
 * from Venice's GET /models?type=video on each start, with the Seedance
 * 2.0 ids as the built-in floor. Live ids (probe 2026-09-22) carry a
 * `-basic` suffix: seedance-2-0-{text,image,reference}-to-video-basic;
 * the list also has seedance-2-5, -fast and -mini variants, wan, kling,
 * veo, sora, ltx, pixverse and topaz-video-upscale (the upscale hook). Field names of Venice's model entries
 * are normalised best-effort in `normalizeVeniceModel`; whatever is not
 * recognised keeps the defaults below and is flagged in `source`.
 */
export interface EngineSpec {
  readonly id: string;
  readonly name: string;
  readonly workflows: readonly Workflow[];
  readonly resolutions: readonly string[];
  readonly durationsS: readonly number[];
  readonly aspectRatios: readonly string[];
  readonly inputs: { readonly images: number; readonly videos: number; readonly audio: number };
  readonly source: "documented" | "venice-models" | "venice-models-partial";
}

const SEEDANCE_COMMON = { resolutions: ["480p", "720p", "1080p"], durationsS: [5, 10], aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] } as const;

export const DOCUMENTED_ENGINES: readonly EngineSpec[] = [
  { id: "seedance-2-0-text-to-video-basic", name: "Seedance 2.0 T2V", workflows: ["t2v"], ...SEEDANCE_COMMON, inputs: { images: 0, videos: 0, audio: 0 }, source: "documented" },
  { id: "seedance-2-0-image-to-video-basic", name: "Seedance 2.0 I2V", workflows: ["i2v"], ...SEEDANCE_COMMON, inputs: { images: 2, videos: 0, audio: 0 }, source: "documented" },
  { id: "seedance-2-0-reference-to-video-basic", name: "Seedance 2.0 R2V", workflows: ["r2v_reference", "r2v_edit", "r2v_extend", "r2v_stitch"], ...SEEDANCE_COMMON, inputs: { images: 9, videos: 3, audio: 3 }, source: "documented" },
];

const num = (x: unknown): number | undefined => { const n = Number(x); return Number.isFinite(n) ? n : undefined; };
const list = (x: unknown): string[] | undefined => Array.isArray(x) ? x.map(String) : typeof x === "string" ? x.split(/[,\s]+/).filter(Boolean) : undefined;

/** Best-effort normalisation of one entry of Venice's /models response. Unknown shapes keep the documented defaults. */
export function normalizeVeniceModel(raw: Record<string, unknown>): EngineSpec | undefined {
  const id = String(raw["id"] ?? raw["model"] ?? "");
  if (!id) return undefined;
  const spec = (raw["model_spec"] ?? raw["spec"] ?? raw["constraints"] ?? raw) as Record<string, unknown>;
  const caps = (spec["capabilities"] ?? spec["constraints"] ?? spec) as Record<string, unknown>;
  const documented = DOCUMENTED_ENGINES.find((e) => e.id === id);
  const resolutions = list(caps["resolutions"] ?? caps["supported_resolutions"] ?? caps["resolution"]);
  const durations = list(caps["durations"] ?? caps["supported_durations"] ?? caps["duration"])?.map((d) => num(String(d).replace(/s$/i, ""))).filter((d): d is number => d !== undefined);
  const aspects = list(caps["aspect_ratios"] ?? caps["supported_aspect_ratios"] ?? caps["aspect_ratio"]);
  const isVideo = String(raw["type"] ?? spec["type"] ?? "").includes("video") || /video/i.test(id) || !!documented;
  if (!isVideo) return undefined;
  const wf: Workflow[] = documented?.workflows.slice() ?? (/reference/i.test(id) ? ["r2v_reference", "r2v_edit", "r2v_extend", "r2v_stitch"] : /image/i.test(id) ? ["i2v"] : ["t2v"]);
  const partial = !resolutions || !durations || !aspects;
  return {
    id, name: String(raw["name"] ?? spec["name"] ?? id), workflows: wf,
    resolutions: resolutions ?? documented?.resolutions ?? ["480p"], durationsS: durations?.length ? durations : documented?.durationsS ?? [5], aspectRatios: aspects ?? documented?.aspectRatios ?? ["16:9"],
    inputs: documented?.inputs ?? { images: num(caps["max_images"] ?? caps["reference_images"]) ?? (wf[0] === "t2v" ? 0 : 1), videos: num(caps["max_videos"]) ?? 0, audio: num(caps["max_audio"]) ?? 0 },
    source: partial ? "venice-models-partial" : "venice-models",
  };
}

/** "seedance-2-0", "kling-v3", "wan-3-0": the id up to the workflow words, for grouping in the UI. */
export const engineFamily = (id: string): string => id.replace(/-(text|image|reference|video|first-last-frame)-to-video.*$/, "").replace(/-(basic|private)$/, "").replace(/-(multi-angle|motion-control|transition|text)$/, "");

export class EngineRegistry {
  private readonly byId = new Map<string, EngineSpec>();
  constructor(specs: readonly EngineSpec[] = DOCUMENTED_ENGINES) { for (const s of specs) this.byId.set(s.id, s); }
  /** Ids written before the probe (without `-basic`) still resolve. */
  get(id: string): EngineSpec | undefined { return this.byId.get(id) ?? this.byId.get(`${id}-basic`); }
  all(): EngineSpec[] { return [...this.byId.values()]; }
  merge(specs: readonly EngineSpec[]): void { for (const s of specs) this.byId.set(s.id, s); }
  static load(path = "director/engines.json"): EngineRegistry {
    const reg = new EngineRegistry();
    if (existsSync(path)) { try { reg.merge(JSON.parse(readFileSync(path, "utf8")) as EngineSpec[]); } catch { /* keep documented */ } }
    return reg;
  }
  save(path = "director/engines.json"): void { writeFileSync(path, JSON.stringify(this.all(), null, 2)); }
}
