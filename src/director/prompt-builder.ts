import type { EngineSpec } from "./engines.js";
import type { Character, Reference, Shot, ShotReference } from "./types.js";

/**
 * The deterministic prompt builder (spec §4). Input: the card, its
 * references, the engine. Output: `prompt_final` and the Venice request
 * body. Order for every engine: subject/reference binding, shot size,
 * camera movement, action (physical, cause before effect), lighting,
 * composition, style excerpt. No LLM touches the final prompt; nothing is
 * replaced by a synonym; sentences that describe the prompt's own
 * correctness are removed (Jev reacts to them).
 */
export interface BuildInput {
  readonly shot: Shot;
  readonly references: readonly (ShotReference & { reference: Reference })[];
  readonly characters: readonly Character[];
  readonly engine: EngineSpec | undefined;
  readonly styleGuideEn: string;
  /** The previous shot's output clip path when this shot extends it. */
  readonly prevClipPath?: string | undefined;
}

export interface VeniceVideoRequest {
  model: string;
  prompt: string;
  negative_prompt?: string;
  duration: string;
  aspect_ratio: string;
  resolution: string;
  /** Local paths in slot order; the Venice client turns them into URLs or base64 as the API wants. */
  reference_images?: { slot: string; role: string; path: string }[];
  reference_videos?: { slot: string; role: string; path: string; duration_s: number }[];
  reference_audio?: { slot: string; role: string; path: string }[];
  reference_video_total_duration?: number;
  seed?: number;
}

export type BuildResult = { ok: true; prompt: string; request: VeniceVideoRequest; notes: string[] } | { ok: false; reason: string };

const META = /\b(this (prompt|shot|description|card) (is|follows|complies|meets)|is correct|correctly|as required|according to the (rules|bible)|complies with|follows the (rules|style guide)|rule-compliant)\b/i;

/** Drops sentences that talk about the text's own correctness. */
export function stripMetaStatements(text: string): string {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() && !META.test(s)).join(" ").trim();
}

const slotNumber = (slot: string) => Number(slot.replace(/\D+/g, "")) || 0;

export function buildPrompt(input: BuildInput): BuildResult {
  const { shot, references, characters, engine } = input;
  if (!engine) return { ok: false, reason: `unknown engine '${shot.engine}': the card stays draft until engines.json knows it` };
  if (!engine.workflows.includes(shot.workflow)) return { ok: false, reason: `engine ${engine.id} does not run workflow ${shot.workflow}` };
  const notes: string[] = [];
  const images = references.filter((r) => r.reference.kind === "image").sort((a, b) => slotNumber(a.slot) - slotNumber(b.slot));
  const videos = references.filter((r) => r.reference.kind === "video").sort((a, b) => slotNumber(a.slot) - slotNumber(b.slot));
  const audio = references.filter((r) => r.reference.kind === "audio").sort((a, b) => slotNumber(a.slot) - slotNumber(b.slot));

  // R3: extend only through the R2V extend workflow with the previous clip as a video reference, never a grabbed frame.
  if (shot.transition_in === "extend") {
    if (shot.workflow !== "r2v_extend") return { ok: false, reason: "transition_in = extend needs workflow r2v_extend (R3)" };
    if (!videos.length) return { ok: false, reason: "transition_in = extend needs the previous shot's clip as a video reference (R3)" };
  }
  if (shot.workflow.startsWith("r2v") && !images.length && !videos.length) return { ok: false, reason: "a reference-to-video workflow needs at least one reference" };

  const parts: string[] = [];
  // 1. Subject / reference binding, in Venice's R2V syntax.
  if (shot.workflow.startsWith("r2v")) {
    const bindings = images.filter((r) => r.role === "identity" || r.role === "keyframe").map((r) => {
      const ch = characters.find((c) => c.id === r.reference.character_id);
      const subject = r.subject_label || (ch ? ch.name : "Subject");
      return r.role === "keyframe" ? `Start from the frame in ${r.slot}` : `Refer to ${subject} in ${r.slot}`;
    });
    if (bindings.length) parts.push(`${bindings.join("; ")} to generate the shot.`);
    if (shot.workflow === "r2v_extend" && videos[0]) parts.push(`Continue directly from the end of ${videos[0].slot}, same scene, same subjects.`);
    if (shot.workflow === "r2v_stitch" && videos.length > 1) parts.push(`Stitch ${videos.map((v) => v.slot).join(" and ")} into one continuous shot.`);
    for (const s of images.filter((r) => r.role === "style")) parts.push(`Match the look of ${s.slot}.`);
    for (const m of videos.filter((r) => r.role === "motion")) parts.push(`Follow the motion of ${m.slot}.`);
  }
  // 2. Shot size, 3. camera movement.
  if (shot.shot_size) parts.push(`${cap(shot.shot_size)}.`);
  if (shot.camera_move) parts.push(`${cap(shot.camera_move)}.`);
  if (shot.lens_note) parts.push(`${cap(shot.lens_note)}.`);
  // 4. Action: physical, cause before effect.
  const action = stripMetaStatements(shot.action_physical_en.trim());
  if (!action) return { ok: false, reason: "action_physical_en is empty" };
  parts.push(action.endsWith(".") ? action : `${action}.`);
  // 5. Lighting, 6. composition, 7. style excerpt.
  if (shot.lighting) parts.push(`Lighting: ${shot.lighting}.`);
  if (shot.composition) parts.push(`Composition: ${shot.composition}.`);
  const style = stripMetaStatements(input.styleGuideEn.trim());
  if (style) parts.push(`Style: ${style.length > 400 ? style.slice(0, 400).replace(/\s+\S*$/, "") : style}`);
  const prompt = parts.join(" ").replace(/\s+/g, " ").trim();

  const request: VeniceVideoRequest = {
    model: engine.id, prompt, duration: `${Math.round(shot.duration_s)}s`, aspect_ratio: shot.aspect_ratio, resolution: shot.resolution,
    ...(shot.negative_prompt ? { negative_prompt: shot.negative_prompt } : {}),
    ...(shot.seed !== null ? { seed: shot.seed } : {}),
  };
  if (images.length) request.reference_images = images.map((r) => ({ slot: r.slot, role: r.role, path: r.reference.path }));
  if (videos.length) {
    request.reference_videos = videos.map((r) => ({ slot: r.slot, role: r.role, path: r.reference.path, duration_s: r.reference.duration_s ?? 0 }));
    // Without the summed clip seconds the quote does not match the bill (spec §4).
    request.reference_video_total_duration = Math.round(videos.reduce((s, r) => s + (r.reference.duration_s ?? 0), 0));
    if (videos.some((r) => !r.reference.duration_s)) notes.push("a video reference has no duration_s: reference_video_total_duration is incomplete");
  }
  if (audio.length) request.reference_audio = audio.map((r) => ({ slot: r.slot, role: r.role, path: r.reference.path }));
  return { ok: true, prompt, request, notes };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
