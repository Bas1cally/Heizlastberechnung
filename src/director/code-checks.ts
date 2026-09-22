import type { EngineSpec } from "./engines.js";
import type { Vocabulary } from "./vocabulary.js";
import { namesTerm } from "./vocabulary.js";
import type { Character, Reference, Shot, ShotReference } from "./types.js";

/** Deterministic checks (spec §5, "Code-Checks"): Jev does not count and does not compute. */
export interface CodeCheck { readonly rule: string; readonly severity: "block" | "warn"; readonly ok: boolean; readonly detail: string }

export interface CheckInput {
  readonly shot: Shot;
  readonly references: readonly (ShotReference & { reference: Reference })[];
  readonly characters: readonly Character[];
  readonly engine: EngineSpec | undefined;
  readonly vocabulary: Vocabulary;
  readonly promptFinal: string;
}

/** Characters whose name appears in the beat or the action. */
export function namedCharacters(shot: Shot, characters: readonly Character[]): Character[] {
  const text = `${shot.beat_de}\n${shot.action_physical_de}\n${shot.action_physical_en}`.toLowerCase();
  return characters.filter((c) => c.name && text.includes(c.name.toLowerCase()));
}

export function codeChecks(i: CheckInput): CodeCheck[] {
  const { shot, references, engine } = i;
  const out: CodeCheck[] = [];
  const named = namedCharacters(shot, i.characters);
  const images = references.filter((r) => r.reference.kind === "image");
  const videos = references.filter((r) => r.reference.kind === "video");

  // R1: every named character has an image reference with an identity role.
  const missing = named.filter((c) => !images.some((r) => r.reference.character_id === c.id && r.role === "identity"));
  out.push({ rule: "R1", severity: "block", ok: missing.length === 0, detail: missing.length ? `no identity reference for: ${missing.map((c) => c.name).join(", ")}` : `${named.length} named character(s), each with an identity reference` });
  if (named.length === 0 && i.characters.length > 0) out.push({ rule: "R1", severity: "warn", ok: false, detail: "no character of the bible is named in the beat or the action" });

  // R2: a start image means R2V with the keyframe as Image 1 and an identity as Image 2.
  const keyframe = images.find((r) => r.role === "keyframe");
  if (keyframe || shot.workflow === "i2v") {
    const ok = shot.workflow.startsWith("r2v") && keyframe?.slot === "Image 1" && images.some((r) => r.role === "identity" && r.slot === "Image 2");
    out.push({ rule: "R2", severity: "block", ok, detail: ok ? "keyframe as Image 1, identity as Image 2, R2V workflow" : `a start image runs as R2V with the keyframe in Image 1 and an identity in Image 2 (workflow ${shot.workflow}, keyframe slot ${keyframe?.slot ?? "none"})` });
  }

  // R3: extend only with a video reference; never a grabbed frame as a start image.
  if (shot.transition_in === "extend") {
    const ok = shot.workflow === "r2v_extend" && videos.length > 0;
    out.push({ rule: "R3", severity: "block", ok, detail: ok ? "extend through r2v_extend with a video reference" : "extend needs workflow r2v_extend and the previous clip as a video reference" });
  }
  const grabbed = images.find((r) => r.role === "keyframe" && /frame|grab/i.test(r.reference.path));
  if (grabbed) out.push({ rule: "R3", severity: "block", ok: false, detail: `keyframe ${grabbed.slot} looks like a grabbed frame (${grabbed.reference.path})` });

  // R5: shot size and camera movement in the film vocabulary, in the card and in the prompt.
  const size = namesTerm(shot.shot_size, i.vocabulary.shotSizes), move = namesTerm(shot.camera_move, i.vocabulary.cameraMoves);
  out.push({ rule: "R5", severity: "block", ok: !!size && !!move, detail: size && move ? `shot size '${size}', camera move '${move}'` : `${size ? "" : "shot size not in vocabulary; "}${move ? "" : "camera move not in vocabulary"}`.trim() });
  if (i.promptFinal) {
    const inPrompt = !!namesTerm(i.promptFinal, i.vocabulary.shotSizes) && !!namesTerm(i.promptFinal, i.vocabulary.cameraMoves);
    out.push({ rule: "R5", severity: "block", ok: inPrompt, detail: inPrompt ? "prompt names both" : "prompt does not name a shot size and a camera move from the vocabulary" });
  }

  // Engine constraints from engines.json.
  if (!engine) out.push({ rule: "ENGINE", severity: "block", ok: false, detail: `unknown engine '${shot.engine}'` });
  else {
    const dur = engine.durationsS.includes(Math.round(shot.duration_s));
    const res = engine.resolutions.includes(shot.resolution);
    const ar = engine.aspectRatios.includes(shot.aspect_ratio);
    const wf = engine.workflows.includes(shot.workflow);
    const imgs = images.length <= engine.inputs.images, vids = videos.length <= engine.inputs.videos;
    const ok = dur && res && ar && wf && imgs && vids;
    out.push({ rule: "ENGINE", severity: "block", ok, detail: ok ? `${engine.id}: duration, resolution, aspect ratio, workflow and reference counts within limits` : [dur ? "" : `duration ${shot.duration_s}s not in ${engine.durationsS.join("/")}`, res ? "" : `resolution ${shot.resolution} not in ${engine.resolutions.join("/")}`, ar ? "" : `aspect ${shot.aspect_ratio} not in ${engine.aspectRatios.join("/")}`, wf ? "" : `workflow ${shot.workflow} not offered`, imgs ? "" : `${images.length} images > ${engine.inputs.images}`, vids ? "" : `${videos.length} videos > ${engine.inputs.videos}`].filter(Boolean).join("; ") });
  }

  // R9: above 480p only with a reason.
  if (shot.resolution !== "480p") out.push({ rule: "R9", severity: "warn", ok: shot.resolution_reason.trim().length > 0, detail: shot.resolution_reason.trim() ? `${shot.resolution} with reason: ${shot.resolution_reason.trim()}` : `${shot.resolution} without a reason (standard is 480p, upscale externally)` });

  // R10: engine and duration live on the card, not in the prompt.
  if (i.promptFinal) {
    const leaks = /\b(\d+\s*(s|sec|seconds)\b|seedance|wan\b|kling|ltx|480p|720p|1080p)/i.test(i.promptFinal);
    out.push({ rule: "R10", severity: "warn", ok: !leaks, detail: leaks ? "prompt mentions the engine, a resolution or a duration" : "prompt free of engine and duration" });
  }
  return out;
}
