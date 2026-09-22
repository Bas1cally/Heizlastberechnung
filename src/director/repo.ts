import { createHash } from "node:crypto";
import type { Db } from "../persistence/database.js";
import { SEED_RULES } from "./seed-rules.js";
import type { Character, ClaudeCall, CostEntry, GateResult, Job, Project, Reference, Review, Rule, Shot, ShotReference } from "./types.js";

/** Thin, explicit access to the director's tables. Every write is one statement; no ORM. */
export class DirectorRepo {
  constructor(readonly db: Db, readonly now: () => number = () => Date.now()) {}

  // ---- project / bible ----
  createProject(p: Partial<Project> & { name: string }): Project {
    this.db.run(`INSERT INTO project (name, aspect_ratio, default_resolution, default_engine, style_guide_de, style_guide_en, created_at) VALUES (?,?,?,?,?,?,?)`,
      [p.name, p.aspect_ratio ?? "16:9", p.default_resolution ?? "480p", p.default_engine ?? "seedance-2-0-reference-to-video", p.style_guide_de ?? "", p.style_guide_en ?? "", this.now()]);
    const project = this.db.get<Project>(`SELECT * FROM project ORDER BY id DESC LIMIT 1`)!;
    this.seedRules(project.id);
    return project;
  }
  updateProject(id: number, patch: Partial<Project>): void { this.patch("project", id, patch, ["name", "aspect_ratio", "default_resolution", "default_engine", "style_guide_de", "style_guide_en"]); }
  project(id: number): Project | undefined { return this.db.get<Project>(`SELECT * FROM project WHERE id = ?`, [id]); }
  projects(): Project[] { return this.db.all<Project>(`SELECT * FROM project ORDER BY id`); }

  seedRules(projectId: number): void {
    for (const r of SEED_RULES) {
      if (this.db.get(`SELECT 1 FROM rule WHERE project_id = ? AND code = ?`, [projectId, r.code])) continue;
      this.db.run(`INSERT INTO rule (project_id, code, text_de, text_en, severity, check_type, active, origin) VALUES (?,?,?,?,?,?,1,'seed')`, [projectId, r.code, r.text_de, r.text_en, r.severity, r.check.join("+")]);
    }
  }
  addRule(projectId: number, r: { code?: string; text_de: string; text_en: string; severity: Rule["severity"]; check_type: string; origin: string }): Rule {
    const code = r.code ?? `R${(this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM rule WHERE project_id = ?`, [projectId])?.n ?? 0) + 1}`;
    this.db.run(`INSERT INTO rule (project_id, code, text_de, text_en, severity, check_type, active, origin) VALUES (?,?,?,?,?,?,1,?)`, [projectId, code, r.text_de, r.text_en, r.severity, r.check_type, r.origin]);
    return this.db.get<Rule>(`SELECT * FROM rule ORDER BY id DESC LIMIT 1`)!;
  }
  setRuleActive(id: number, active: boolean): void { this.db.run(`UPDATE rule SET active = ? WHERE id = ?`, [active ? 1 : 0, id]); }
  rules(projectId: number, activeOnly = true): Rule[] { return this.db.all<Rule>(`SELECT * FROM rule WHERE (project_id = ? OR project_id IS NULL) ${activeOnly ? "AND active = 1" : ""} ORDER BY id`, [projectId]); }

  createCharacter(c: Partial<Character> & { project_id: number; name: string }): Character {
    this.db.run(`INSERT INTO character (project_id, name, fixed_attributes_de, fixed_attributes_en, variable_attributes, likeness_cap, notes) VALUES (?,?,?,?,?,?,?)`,
      [c.project_id, c.name, c.fixed_attributes_de ?? "", c.fixed_attributes_en ?? "", c.variable_attributes ?? "", c.likeness_cap ?? null, c.notes ?? ""]);
    return this.db.get<Character>(`SELECT * FROM character ORDER BY id DESC LIMIT 1`)!;
  }
  updateCharacter(id: number, patch: Partial<Character>): void { this.patch("character", id, patch, ["name", "fixed_attributes_de", "fixed_attributes_en", "variable_attributes", "likeness_cap", "notes"]); }
  characters(projectId: number): Character[] { return this.db.all<Character>(`SELECT * FROM character WHERE project_id = ? ORDER BY id`, [projectId]); }
  character(id: number): Character | undefined { return this.db.get<Character>(`SELECT * FROM character WHERE id = ?`, [id]); }

  addReference(r: Omit<Reference, "id" | "sha256" | "consent_json"> & { bytes?: Buffer; sha256?: string }): Reference {
    const sha = r.sha256 ?? (r.bytes ? createHash("sha256").update(r.bytes).digest("hex") : createHash("sha256").update(r.path).digest("hex"));
    this.db.run(`INSERT INTO reference (project_id, character_id, kind, path, role_default, duration_s, sha256) VALUES (?,?,?,?,?,?,?)`, [r.project_id, r.character_id, r.kind, r.path, r.role_default, r.duration_s, sha]);
    return this.db.get<Reference>(`SELECT * FROM reference ORDER BY id DESC LIMIT 1`)!;
  }
  setReferenceConsent(id: number, consent: unknown): void { this.db.run(`UPDATE reference SET consent_json = ? WHERE id = ?`, [JSON.stringify(consent), id]); }
  references(projectId: number): Reference[] { return this.db.all<Reference>(`SELECT * FROM reference WHERE project_id = ? ORDER BY id`, [projectId]); }
  reference(id: number): Reference | undefined { return this.db.get<Reference>(`SELECT * FROM reference WHERE id = ?`, [id]); }

  // ---- shots ----
  createShot(s: Partial<Shot> & { project_id: number }): Shot {
    const project = this.project(s.project_id)!;
    const seq = s.seq ?? ((this.db.get<{ m: number | null }>(`SELECT MAX(seq) AS m FROM shot WHERE project_id = ?`, [s.project_id])?.m ?? 0) + 1);
    const prev = s.prev_shot_id ?? this.db.get<{ id: number }>(`SELECT id FROM shot WHERE project_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1`, [s.project_id, seq])?.id ?? null;
    this.db.run(`INSERT INTO shot (project_id, seq, beat_de, shot_size, camera_move, lens_note, lighting, composition, action_physical_de, action_physical_en, duration_s, engine, resolution, aspect_ratio, workflow, transition_in, prompt_final, negative_prompt, seed, status, prev_shot_id, resolution_reason, review_note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [s.project_id, seq, s.beat_de ?? "", s.shot_size ?? "", s.camera_move ?? "", s.lens_note ?? "", s.lighting ?? "", s.composition ?? "", s.action_physical_de ?? "", s.action_physical_en ?? "", s.duration_s ?? 5,
        s.engine ?? project.default_engine, s.resolution ?? project.default_resolution, s.aspect_ratio ?? project.aspect_ratio, s.workflow ?? "t2v", s.transition_in ?? "hard_cut", s.prompt_final ?? "", s.negative_prompt ?? "", s.seed ?? null, s.status ?? "draft", prev, s.resolution_reason ?? "", s.review_note ?? ""]);
    return this.db.get<Shot>(`SELECT * FROM shot ORDER BY id DESC LIMIT 1`)!;
  }
  updateShot(id: number, patch: Partial<Shot>): void {
    this.patch("shot", id, patch, ["seq", "beat_de", "shot_size", "camera_move", "lens_note", "lighting", "composition", "action_physical_de", "action_physical_en", "duration_s", "engine", "resolution", "aspect_ratio", "workflow", "transition_in", "prompt_final", "negative_prompt", "seed", "status", "prev_shot_id", "resolution_reason", "review_note"]);
  }
  shot(id: number): Shot | undefined { return this.db.get<Shot>(`SELECT * FROM shot WHERE id = ?`, [id]); }
  shots(projectId: number): Shot[] { return this.db.all<Shot>(`SELECT * FROM shot WHERE project_id = ? ORDER BY seq, id`, [projectId]); }

  setShotReferences(shotId: number, refs: readonly Omit<ShotReference, "shot_id">[]): void {
    this.db.transaction(() => {
      this.db.run(`DELETE FROM shot_reference WHERE shot_id = ?`, [shotId]);
      for (const r of refs) this.db.run(`INSERT INTO shot_reference (shot_id, reference_id, slot, role, subject_label) VALUES (?,?,?,?,?)`, [shotId, r.reference_id, r.slot, r.role, r.subject_label]);
    });
  }
  shotReferences(shotId: number): (ShotReference & { reference: Reference })[] {
    return this.db.all<ShotReference & Reference & { reference_id: number }>(`SELECT sr.shot_id, sr.reference_id, sr.slot, sr.role, sr.subject_label, r.* FROM shot_reference sr JOIN reference r ON r.id = sr.reference_id WHERE sr.shot_id = ? ORDER BY sr.slot`, [shotId])
      .map((row) => ({ shot_id: row.shot_id, reference_id: row.reference_id, slot: row.slot, role: row.role, subject_label: row.subject_label,
        reference: { id: row.reference_id, project_id: row.project_id, character_id: row.character_id, kind: row.kind, path: row.path, role_default: row.role_default, duration_s: row.duration_s, sha256: row.sha256, consent_json: row.consent_json } }));
  }

  // ---- gate / claude / jobs / review / costs ----
  saveGateResult(g: Omit<GateResult, "id" | "created_at">): GateResult {
    this.db.run(`INSERT INTO gate_result (shot_id, created_at, jev_model, answers_json, confidence_json, code_checks_json, verdict) VALUES (?,?,?,?,?,?,?)`, [g.shot_id, this.now(), g.jev_model, g.answers_json, g.confidence_json, g.code_checks_json, g.verdict]);
    return this.db.get<GateResult>(`SELECT * FROM gate_result ORDER BY id DESC LIMIT 1`)!;
  }
  latestGate(shotId: number): GateResult | undefined { return this.db.get<GateResult>(`SELECT * FROM gate_result WHERE shot_id = ? ORDER BY id DESC LIMIT 1`, [shotId]); }
  saveClaudeCall(c: Omit<ClaudeCall, "id" | "created_at">): ClaudeCall {
    this.db.run(`INSERT INTO claude_call (shot_id, purpose, input_tokens, output_tokens, model, request_json, response_json, created_at) VALUES (?,?,?,?,?,?,?,?)`, [c.shot_id, c.purpose, c.input_tokens, c.output_tokens, c.model, c.request_json, c.response_json, this.now()]);
    return this.db.get<ClaudeCall>(`SELECT * FROM claude_call ORDER BY id DESC LIMIT 1`)!;
  }
  claudeCalls(shotId: number): ClaudeCall[] { return this.db.all<ClaudeCall>(`SELECT * FROM claude_call WHERE shot_id = ? ORDER BY id`, [shotId]); }
  createJob(j: { shot_id: number; venice_model: string; request_json: string; quote_usd?: number | null }): Job {
    this.db.run(`INSERT INTO job (shot_id, venice_model, request_json, quote_usd, status, created_at) VALUES (?,?,?,?,'quoted',?)`, [j.shot_id, j.venice_model, j.request_json, j.quote_usd ?? null, this.now()]);
    return this.db.get<Job>(`SELECT * FROM job ORDER BY id DESC LIMIT 1`)!;
  }
  updateJob(id: number, patch: Partial<Job>): void { this.patch("job", id, patch, ["quote_usd", "approved_at", "queue_id", "status", "download_url", "output_path", "error_json", "finished_at", "request_json"]); }
  job(id: number): Job | undefined { return this.db.get<Job>(`SELECT * FROM job WHERE id = ?`, [id]); }
  jobs(shotId?: number): Job[] { return shotId === undefined ? this.db.all<Job>(`SELECT * FROM job ORDER BY id DESC`) : this.db.all<Job>(`SELECT * FROM job WHERE shot_id = ? ORDER BY id DESC`, [shotId]); }
  createReview(r: Omit<Review, "id" | "created_at">): Review {
    this.db.run(`INSERT INTO review (shot_id, job_id, frame_paths_json, compare_image_path, checklist_json, verdict, notes, vision_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)`, [r.shot_id, r.job_id, r.frame_paths_json, r.compare_image_path, r.checklist_json, r.verdict, r.notes, r.vision_json, this.now()]);
    return this.db.get<Review>(`SELECT * FROM review ORDER BY id DESC LIMIT 1`)!;
  }
  updateReview(id: number, patch: Partial<Review>): void { this.patch("review", id, patch, ["checklist_json", "verdict", "notes", "vision_json", "compare_image_path", "frame_paths_json"]); }
  review(id: number): Review | undefined { return this.db.get<Review>(`SELECT * FROM review WHERE id = ?`, [id]); }
  reviews(shotId: number): Review[] { return this.db.all<Review>(`SELECT * FROM review WHERE shot_id = ? ORDER BY id DESC`, [shotId]); }
  addCost(kind: CostEntry["kind"], refId: string, usd: number, tokens: number): void { this.db.run(`INSERT INTO cost_ledger (kind, ref_id, usd, tokens, created_at) VALUES (?,?,?,?,?)`, [kind, refId, usd, tokens, this.now()]); }
  costs(): { kind: string; usd: number; tokens: number; n: number }[] { return this.db.all(`SELECT kind, COALESCE(SUM(usd),0) AS usd, COALESCE(SUM(tokens),0) AS tokens, COUNT(*) AS n FROM cost_ledger GROUP BY kind`); }

  // ---- translation cache ----
  cachedTranslation(source: string): string | undefined { return this.db.get<{ target: string }>(`SELECT target FROM translation_cache WHERE sha256 = ?`, [sha(source)])?.target; }
  cacheTranslation(source: string, target: string): void { this.db.run(`INSERT OR REPLACE INTO translation_cache (sha256, source, target, created_at) VALUES (?,?,?,?)`, [sha(source), source, target, this.now()]); }

  private patch(table: string, id: number, patch: Record<string, unknown>, allowed: readonly string[]): void {
    const keys = allowed.filter((k) => patch[k] !== undefined);
    if (!keys.length) return;
    this.db.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => patch[k] as never), id]);
  }
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
