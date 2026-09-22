/** Records of the Venice Director (VENICE_DIRECTOR_SPEC §2). German data, English `*_en` fields for Jev and Venice. */
export type Severity = "block" | "warn";
export type CheckType = "code" | "jev" | "vision" | "review";
export type ReferenceKind = "image" | "video" | "audio";
export type ReferenceRole = "identity" | "keyframe" | "style" | "motion" | "audio";
export type Workflow = "t2v" | "i2v" | "r2v_reference" | "r2v_edit" | "r2v_extend" | "r2v_stitch";
export type TransitionIn = "hard_cut" | "extend";
export type ShotStatus = "draft" | "claude" | "gated" | "approved" | "queued" | "done" | "review" | "failed";
export type Verdict = "green" | "yellow" | "red";

export interface Project { id: number; name: string; aspect_ratio: string; default_resolution: string; default_engine: string; style_guide_de: string; style_guide_en: string; created_at: number }
export interface Character { id: number; project_id: number; name: string; fixed_attributes_de: string; fixed_attributes_en: string; variable_attributes: string; likeness_cap: number | null; notes: string }
export interface Reference { id: number; project_id: number; character_id: number | null; kind: ReferenceKind; path: string; role_default: ReferenceRole; duration_s: number | null; sha256: string; consent_json: string | null }
export interface Rule { id: number; project_id: number | null; code: string; text_de: string; text_en: string; severity: Severity; check_type: string; active: number; origin: string }
export interface Shot {
  id: number; project_id: number; seq: number; beat_de: string; shot_size: string; camera_move: string; lens_note: string; lighting: string; composition: string;
  action_physical_de: string; action_physical_en: string; duration_s: number; engine: string; resolution: string; aspect_ratio: string; workflow: Workflow; transition_in: TransitionIn;
  prompt_final: string; negative_prompt: string; seed: number | null; status: ShotStatus; prev_shot_id: number | null; resolution_reason: string; review_note: string;
}
export interface ShotReference { shot_id: number; reference_id: number; slot: string; role: ReferenceRole; subject_label: string }
export interface GateResult { id: number; shot_id: number; created_at: number; jev_model: string; answers_json: string; confidence_json: string; code_checks_json: string; verdict: Verdict }
export interface ClaudeCall { id: number; shot_id: number | null; purpose: string; input_tokens: number; output_tokens: number; model: string; request_json: string; response_json: string; created_at: number }
export interface Job { id: number; shot_id: number; venice_model: string; request_json: string; quote_usd: number | null; approved_at: number | null; queue_id: string | null; status: string; download_url: string | null; output_path: string | null; error_json: string | null; created_at: number; finished_at: number | null }
export interface Review { id: number; shot_id: number; job_id: number; frame_paths_json: string; compare_image_path: string | null; checklist_json: string; verdict: "pass" | "fail" | null; notes: string; vision_json: string | null; created_at: number }
export interface CostEntry { id: number; kind: "venice" | "claude" | "jev"; ref_id: string; usd: number; tokens: number; created_at: number }
