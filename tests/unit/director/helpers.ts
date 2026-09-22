import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateAnswers, GateCall } from "../../../src/director/jev-gate.js";
import { DirectorRepo } from "../../../src/director/repo.js";
import { openDirectorDb } from "../../../src/director/schema.js";
import type { Character, Reference, Shot, ShotReference } from "../../../src/director/types.js";
import { DEFAULT_VOCABULARY } from "../../../src/director/vocabulary.js";
import { EngineRegistry } from "../../../src/director/engines.js";

export const vocabulary = DEFAULT_VOCABULARY;
export const engines = new EngineRegistry();

export function memRepo(): DirectorRepo { return new DirectorRepo(openDirectorDb(":memory:"), () => 1_700_000_000_000); }

export function tmpDir(): string { return mkdtempSync(join(tmpdir(), "director-")); }

/** A one-pixel PNG on disk, so uploads and base64 wire bodies have real bytes. */
export function pngFile(dir: string, name = "mara.png"): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  return p;
}

export const shotOf = (over: Partial<Shot> = {}): Shot => ({
  id: 1, project_id: 1, seq: 1, beat_de: "Mara hebt die Tasse.", shot_size: "medium close-up", camera_move: "slow push-in", lens_note: "", lighting: "soft window light", composition: "centered",
  action_physical_de: "Mara hebt die Tasse und trinkt.", action_physical_en: "Mara lifts the cup with her right hand and drinks.", duration_s: 5, engine: "seedance-2-0-reference-to-video", resolution: "480p", aspect_ratio: "16:9",
  workflow: "r2v_reference", transition_in: "hard_cut", prompt_final: "", negative_prompt: "", seed: null, status: "draft", prev_shot_id: null, resolution_reason: "", review_note: "", ...over,
});
export const mara: Character = { id: 1, project_id: 1, name: "Mara", fixed_attributes_de: "rote Haare", fixed_attributes_en: "red hair, green eyes, scar on left brow", variable_attributes: "", likeness_cap: null, notes: "" };
export const identityRef = (path = "/refs/mara.png"): ShotReference & { reference: Reference } => ({
  shot_id: 1, reference_id: 1, slot: "Image 1", role: "identity", subject_label: "Mara",
  reference: { id: 1, project_id: 1, character_id: 1, kind: "image", path, role_default: "identity", duration_s: null, sha256: "x", consent_json: null },
});

const noul = (p: number) => ({ type: "noul" as const, noul: p });
/** Every question answered the way a green gate needs; override keys to script red / yellow. */
export function greenAnswers(over: Partial<GateAnswers> = {}): GateAnswers {
  return {
    q1_references: noul(0.95), q2_physical_action: noul(0.9), q3_camera_move: noul(0.92), q4_shot_size: noul(0.93), q5_character_drift: noul(0.05), q6_style_drift: noul(0.05), q7_continuity: noul(0.05), q8_frame_grab: noul(0.02), q9_engine_fit: noul(0.9),
    q10_action_clarity: { type: "score", score: 1.8, confidence: 0.85, legend: {}, probabilities: {} } as unknown as GateAnswers["q10_action_clarity"],
    q11_workflow: { type: "choice", choice: "reference", confidence: 0.9, probabilities: { reference: 0.9, edit: 0.03, extend: 0.03, stitch: 0.02, none: 0.02 } } as unknown as GateAnswers["q11_workflow"],
    ...over,
  };
}
export function scriptedGate(answers: GateAnswers = greenAnswers()): { call: GateCall; states: Record<string, unknown>[] } {
  const states: Record<string, unknown>[] = [];
  const call: GateCall = async (state) => { states.push(state); return { answers, model: "jev-test", usage: { input_tokens: 500, output_tokens: 11 }, latencyMs: 210 }; };
  return { call, states };
}
