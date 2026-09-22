import { openDatabase, type Db } from "../persistence/database.js";

/** Tables of VENICE_DIRECTOR_SPEC §2, plus a translation cache and a consent column. */
export const DIRECTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS project (id INTEGER PRIMARY KEY, name TEXT NOT NULL, aspect_ratio TEXT NOT NULL DEFAULT '16:9', default_resolution TEXT NOT NULL DEFAULT '480p', default_engine TEXT NOT NULL DEFAULT 'seedance-2-0-reference-to-video-basic', style_guide_de TEXT NOT NULL DEFAULT '', style_guide_en TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS character (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES project(id), name TEXT NOT NULL, fixed_attributes_de TEXT NOT NULL DEFAULT '', fixed_attributes_en TEXT NOT NULL DEFAULT '', variable_attributes TEXT NOT NULL DEFAULT '', likeness_cap REAL, notes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS reference (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES project(id), character_id INTEGER REFERENCES character(id), kind TEXT NOT NULL, path TEXT NOT NULL, role_default TEXT NOT NULL, duration_s REAL, sha256 TEXT NOT NULL, consent_json TEXT);
CREATE TABLE IF NOT EXISTS rule (id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES project(id), code TEXT NOT NULL, text_de TEXT NOT NULL, text_en TEXT NOT NULL, severity TEXT NOT NULL, check_type TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT 'seed');
CREATE TABLE IF NOT EXISTS shot (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES project(id), seq INTEGER NOT NULL, beat_de TEXT NOT NULL DEFAULT '',
  shot_size TEXT NOT NULL DEFAULT '', camera_move TEXT NOT NULL DEFAULT '', lens_note TEXT NOT NULL DEFAULT '', lighting TEXT NOT NULL DEFAULT '', composition TEXT NOT NULL DEFAULT '',
  action_physical_de TEXT NOT NULL DEFAULT '', action_physical_en TEXT NOT NULL DEFAULT '', duration_s REAL NOT NULL DEFAULT 5, engine TEXT NOT NULL DEFAULT '', resolution TEXT NOT NULL DEFAULT '480p', aspect_ratio TEXT NOT NULL DEFAULT '16:9',
  workflow TEXT NOT NULL DEFAULT 't2v', transition_in TEXT NOT NULL DEFAULT 'hard_cut', prompt_final TEXT NOT NULL DEFAULT '', negative_prompt TEXT NOT NULL DEFAULT '', seed INTEGER, status TEXT NOT NULL DEFAULT 'draft', prev_shot_id INTEGER REFERENCES shot(id),
  resolution_reason TEXT NOT NULL DEFAULT '', review_note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS shot_reference (shot_id INTEGER NOT NULL REFERENCES shot(id), reference_id INTEGER NOT NULL REFERENCES reference(id), slot TEXT NOT NULL, role TEXT NOT NULL, subject_label TEXT NOT NULL DEFAULT '', PRIMARY KEY (shot_id, slot));
CREATE TABLE IF NOT EXISTS gate_result (id INTEGER PRIMARY KEY, shot_id INTEGER NOT NULL REFERENCES shot(id), created_at INTEGER NOT NULL, jev_model TEXT NOT NULL, answers_json TEXT NOT NULL, confidence_json TEXT NOT NULL, code_checks_json TEXT NOT NULL, verdict TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claude_call (id INTEGER PRIMARY KEY, shot_id INTEGER REFERENCES shot(id), purpose TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, model TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY, shot_id INTEGER NOT NULL REFERENCES shot(id), venice_model TEXT NOT NULL, request_json TEXT NOT NULL, quote_usd REAL, approved_at INTEGER, queue_id TEXT, status TEXT NOT NULL, download_url TEXT, output_path TEXT, error_json TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE TABLE IF NOT EXISTS review (id INTEGER PRIMARY KEY, shot_id INTEGER NOT NULL REFERENCES shot(id), job_id INTEGER NOT NULL REFERENCES job(id), frame_paths_json TEXT NOT NULL, compare_image_path TEXT, checklist_json TEXT NOT NULL, verdict TEXT, notes TEXT NOT NULL DEFAULT '', vision_json TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cost_ledger (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL, usd REAL NOT NULL, tokens INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS translation_cache (sha256 TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS engine_cache (id TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);
`;

export function openDirectorDb(path = "data/director.sqlite"): Db {
  const db = openDatabase(path);
  for (const stmt of DIRECTOR_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) db.run(stmt);
  return db;
}
