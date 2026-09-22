import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { codeChecks, namedCharacters, type CodeCheck } from "./code-checks.js";
import { usdFor, type ClaudeResult, type TextCalls } from "./claude.js";
import type { EngineRegistry } from "./engines.js";
import { buildGateState, evaluateGate, GATE_QUESTIONS, type GateCall, type GateEvaluation } from "./jev-gate.js";
import { buildPrompt, type BuildResult, type VeniceVideoRequest } from "./prompt-builder.js";
import type { DirectorRepo } from "./repo.js";
import { checklistFrom, compareImage, extractFrames } from "./review.js";
import type { Job, Reference, Review, Rule, Shot, ShotReference } from "./types.js";
import { outputFileName, type VeniceClient } from "./venice.js";
import type { Vocabulary } from "./vocabulary.js";

/**
 * The operations behind the UI's buttons, in the order of the card's
 * status: draft -> claude (the text model filled the fields) -> gated (Jev + code
 * checks, verdict stored) -> approved (user clicked, quote known) ->
 * queued -> done -> review -> back to draft on fail. Nothing here sends a
 * job without `approved_at`; nothing here retries a failed Venice job.
 */
export interface ServiceDeps {
  readonly repo: DirectorRepo;
  readonly engines: EngineRegistry;
  readonly vocabulary: Vocabulary;
  /** Draft / review_fix / translate: Anthropic directly or a text model on Venice. */
  readonly text?: TextCalls | undefined;
  readonly textPrice: { inPerM: number; outPerM: number };
  readonly gate?: GateCall | undefined;
  readonly venice?: VeniceClient | undefined;
  readonly dataDir: string;
  readonly tools?: { ffmpeg?: string; ffprobe?: string } | undefined;
  readonly log: (msg: string, fields?: Record<string, unknown>) => void;
}

export class DirectorService {
  constructor(private readonly d: ServiceDeps) {}

  private ctx(shotId: number) {
    const shot = this.d.repo.shot(shotId);
    if (!shot) throw new Error(`shot ${shotId} not found`);
    const project = this.d.repo.project(shot.project_id)!;
    const characters = this.d.repo.characters(project.id);
    const references = this.d.repo.shotReferences(shot.id);
    const previous = shot.prev_shot_id ? this.d.repo.shot(shot.prev_shot_id) : undefined;
    const rules = this.d.repo.rules(project.id);
    return { shot, project, characters, references, previous, rules };
  }

  /** Every text-model call lands in claude_call (request, answer, tokens); the cost goes to the account that pays: Venice or Anthropic. */
  private logText<T>(shotId: number | null, purpose: string, r: ClaudeResult<T>): void {
    this.d.repo.saveClaudeCall({ shot_id: shotId, purpose, input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens, model: r.usage.model, request_json: JSON.stringify(r.request), response_json: JSON.stringify(r.response) });
    this.d.repo.addCost(this.d.text?.provider === "venice" ? "venice" : "claude", `${purpose}:${shotId ?? "-"}`, usdFor(r.usage, this.d.textPrice), r.usage.input_tokens + r.usage.output_tokens);
  }
  private text(): TextCalls { if (!this.d.text) throw new Error("no text model configured (VENICE_API_KEY or ANTHROPIC_API_KEY)"); return this.d.text; }

  /** DE -> EN through the text model, cached by the source's sha256 (spec §6 translate). */
  async translate(textDe: string, shotId: number | null = null): Promise<string> {
    const t = textDe.trim();
    if (!t) return "";
    const cached = this.d.repo.cachedTranslation(t);
    if (cached) return cached;
    const r = await this.text().translate(t);
    this.logText(shotId, "translate", r);
    this.d.repo.cacheTranslation(t, r.value);
    return r.value;
  }

  /** Makes sure the English fields the gate and the prompt need exist. */
  async ensureEnglish(projectId: number): Promise<void> {
    const p = this.d.repo.project(projectId)!;
    if (p.style_guide_de && !p.style_guide_en) this.d.repo.updateProject(p.id, { style_guide_en: await this.translate(p.style_guide_de) });
    for (const c of this.d.repo.characters(p.id)) if (c.fixed_attributes_de && !c.fixed_attributes_en) this.d.repo.updateCharacter(c.id, { fixed_attributes_en: await this.translate(c.fixed_attributes_de) });
    for (const r of this.d.repo.rules(p.id, false)) if (r.text_de && !r.text_en) this.d.repo.db.run(`UPDATE rule SET text_en = ? WHERE id = ?`, [await this.translate(r.text_de), r.id]);
  }

  /** The text model fills the creative fields from the beat (spec §6 draft). Status -> claude. */
  async draft(shotId: number): Promise<Shot> {
    const { shot, project, characters, previous } = this.ctx(shotId);
    await this.ensureEnglish(project.id);
    const r = await this.text().draft({
      styleGuideEn: this.d.repo.project(project.id)!.style_guide_en, characters: this.d.repo.characters(project.id).map((c) => ({ name: c.name, fixed_attributes_en: c.fixed_attributes_en, variable_attributes: c.variable_attributes })),
      previous: previous ? { seq: previous.seq, shot_size: previous.shot_size, camera_move: previous.camera_move, lighting: previous.lighting, action_physical_en: previous.action_physical_en, transition_in: previous.transition_in } : undefined,
      beatDe: shot.beat_de, engine: shot.engine, workflow: shot.workflow, vocabulary: this.d.vocabulary,
    });
    this.logText(shot.id, "draft", r);
    const v = r.value;
    this.d.repo.updateShot(shot.id, { shot_size: v.shot_size, camera_move: v.camera_move, lens_note: v.lens_note, lighting: v.lighting, composition: v.composition, action_physical_en: v.action_physical_en, action_physical_de: v.action_physical_de, status: "claude" });
    void characters;
    return this.d.repo.shot(shot.id)!;
  }

  /**
   * Every character named in the beat or the action gets its identity image as the next
   * free `Image n` slot (R1), and a card that names characters runs as R2V, not T2V. Slots the
   * user set by hand stay untouched.
   */
  autoReferences(shotId: number): (ShotReference & { reference: Reference })[] {
    const { shot, characters, references } = this.ctx(shotId);
    const named = namedCharacters(shot, characters);
    const current = references.map((r) => ({ reference_id: r.reference_id, slot: r.slot, role: r.role, subject_label: r.subject_label }));
    let changed = false;
    for (const c of named) {
      if (current.some((r) => r.role === "identity" && references.find((x) => x.reference_id === r.reference_id)?.reference.character_id === c.id)) continue;
      const identity = this.d.repo.references(shot.project_id).find((r) => r.character_id === c.id && r.kind === "image" && r.role_default === "identity");
      if (!identity) continue;
      const used = new Set(current.map((r) => r.slot));
      let n = 1; while (used.has(`Image ${n}`)) n++;
      current.push({ reference_id: identity.id, slot: `Image ${n}`, role: "identity", subject_label: c.name });
      changed = true;
    }
    if (changed) this.d.repo.setShotReferences(shot.id, current);
    if (current.some((r) => r.role === "identity") && !shot.workflow.startsWith("r2v")) {
      const engine = this.d.engines.get(shot.engine);
      const r2v = engine?.workflows.some((w) => w.startsWith("r2v")) ? shot.engine : this.d.repo.project(shot.project_id)!.default_engine;
      this.d.repo.updateShot(shot.id, { workflow: "r2v_reference", engine: r2v });
    }
    return this.d.repo.shotReferences(shot.id);
  }

  /** The "Entwurf" button: references from the bible, then the text model fills the card. */
  async prepare(shotId: number): Promise<Shot> {
    this.autoReferences(shotId);
    return this.draft(shotId);
  }

  /** The "Prüfen" button: prompt + code checks, and the Jev gate when a key is there. */
  async check(shotId: number): Promise<{ built: BuildResult; checks: CodeCheck[]; gate?: Awaited<ReturnType<DirectorService["gate"]>>; gateError?: string }> {
    this.autoReferences(shotId);
    const built = this.build(shotId);
    const checks = this.codeChecks(shotId);
    if (!this.d.gate) return { built, checks };
    // Jev unreachable or out of credit: the prompt and the code checks still count; the card just does not turn "gated".
    try { return { built, checks, gate: await this.gate(shotId) }; }
    catch (err) { const gateError = err instanceof Error ? err.message : String(err); this.d.log("gate failed", { shot: shotId, gateError }); return { built, checks, gateError }; }
  }

  /** Deterministic prompt + request body (spec §4); stored on the card. */
  build(shotId: number): BuildResult {
    const { shot, project, characters, references } = this.ctx(shotId);
    const res = buildPrompt({ shot, references, characters, engine: this.d.engines.get(shot.engine), styleGuideEn: project.style_guide_en });
    if (res.ok) this.d.repo.updateShot(shot.id, { prompt_final: res.prompt });
    return res;
  }

  codeChecks(shotId: number): CodeCheck[] {
    const { shot, characters, references } = this.ctx(shotId);
    return codeChecks({ shot, references, characters, engine: this.d.engines.get(shot.engine), vocabulary: this.d.vocabulary, promptFinal: shot.prompt_final });
  }

  /** Jev + code checks, verdict stored (spec §5). Status -> gated. */
  async gate(shotId: number): Promise<{ evaluation: GateEvaluation; model: string; latencyMs: number; state: Record<string, unknown> }> {
    if (!this.d.gate) throw new Error("TYPESAFE_API_KEY is not set: cannot gate");
    const built = this.build(shotId);
    const { shot, project, characters, references, previous, rules } = this.ctx(shotId);
    const checks = this.codeChecks(shotId);
    if (!built.ok) checks.push({ rule: "BUILD", severity: "block", ok: false, detail: built.reason });
    const state = buildGateState({ shot, previous, characters, references, rules, styleGuideEn: project.style_guide_en, promptFinal: shot.prompt_final });
    const res = await this.d.gate(state, GATE_QUESTIONS);
    const evaluation = evaluateGate(res.answers, checks, shot);
    const confidences: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(evaluation.outcomes)) confidences[k] = v.confidence;
    this.d.repo.saveGateResult({ shot_id: shot.id, jev_model: res.model, answers_json: JSON.stringify(res.answers), confidence_json: JSON.stringify(confidences), code_checks_json: JSON.stringify(checks), verdict: evaluation.verdict });
    this.d.repo.addCost("jev", `gate:${shot.id}`, 0, res.usage.input_tokens + res.usage.output_tokens);
    this.d.repo.updateShot(shot.id, { status: "gated" });
    this.d.log("gate", { shot: shot.id, verdict: evaluation.verdict, latencyMs: res.latencyMs, reasons: evaluation.reasons });
    return { evaluation, model: res.model, latencyMs: res.latencyMs, state };
  }

  /** Yellow: the text model corrects only the affected fields, then the gate runs again (spec §5). */
  async reviewFix(shotId: number): Promise<Shot> {
    const { shot, project, previous } = this.ctx(shotId);
    const last = this.d.repo.latestGate(shot.id);
    const findings: string[] = [];
    if (last) {
      const answers = JSON.parse(last.answers_json) as Record<string, { type: string; noul?: number; score?: number; choice?: string }>;
      for (const [k, a] of Object.entries(answers)) findings.push(`${k}: ${a.type === "noul" ? `p(yes)=${a.noul?.toFixed(2)}` : a.type === "score" ? `score=${a.score?.toFixed(2)}` : `choice=${a.choice}`}`);
      for (const c of JSON.parse(last.code_checks_json) as CodeCheck[]) if (!c.ok) findings.push(`code ${c.rule}: ${c.detail}`);
    }
    const r = await this.text().reviewFix({
      styleGuideEn: project.style_guide_en, characters: this.d.repo.characters(project.id).map((c) => ({ name: c.name, fixed_attributes_en: c.fixed_attributes_en, variable_attributes: c.variable_attributes })),
      previous: previous ? { seq: previous.seq, shot_size: previous.shot_size, camera_move: previous.camera_move, lighting: previous.lighting, action_physical_en: previous.action_physical_en, transition_in: previous.transition_in } : undefined,
      beatDe: shot.beat_de, engine: shot.engine, workflow: shot.workflow, vocabulary: this.d.vocabulary,
      current: { shot_size: shot.shot_size, camera_move: shot.camera_move, lens_note: shot.lens_note, lighting: shot.lighting, composition: shot.composition, action_physical_en: shot.action_physical_en, action_physical_de: shot.action_physical_de },
      gateFindings: findings,
    });
    this.logText(shot.id, "review_fix", r);
    const patch: Partial<Shot> = {};
    for (const [k, v] of Object.entries(r.value)) if (typeof v === "string" && v.trim()) (patch as Record<string, unknown>)[k] = v;
    this.d.repo.updateShot(shot.id, { ...patch, status: "claude" });
    return this.d.repo.shot(shot.id)!;
  }

  /** POST /video/quote with the exact body (spec §7.1). A consent demand is returned, not resolved. */
  async quote(shotId: number, consent?: unknown): Promise<{ job: Job; result: Awaited<ReturnType<VeniceClient["quote"]>>; request: VeniceVideoRequest }> {
    if (!this.d.venice) throw new Error("VENICE_API_KEY is not set: cannot quote");
    const { shot } = this.ctx(shotId);
    const gate = this.d.repo.latestGate(shot.id);
    if (!gate || gate.verdict !== "green") throw new Error("the gate is not green: no quote");
    const built = this.build(shotId);
    if (!built.ok) throw new Error(built.reason);
    const result = await this.d.venice.quote(built.request, consent);
    const job = this.d.repo.createJob({ shot_id: shot.id, venice_model: built.request.model, request_json: JSON.stringify({ ...built.request, ...(consent ? { consent } : {}) }), quote_usd: result.ok === true ? result.quoteUsd : null });
    if (result.ok !== true) this.d.repo.updateJob(job.id, { status: "kind" in result ? "needs_consent" : "quote_failed", error_json: JSON.stringify("kind" in result ? result.raw : result.error) });
    return { job: this.d.repo.job(job.id)!, result, request: built.request };
  }

  /** The user's click. Without it no queue call ever happens. */
  approve(jobId: number): Job {
    const job = this.d.repo.job(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    if (job.quote_usd === null) throw new Error("no quote on this job: nothing to approve");
    this.d.repo.updateJob(job.id, { approved_at: Date.now(), status: "approved" });
    this.d.repo.updateShot(job.shot_id, { status: "approved" });
    return this.d.repo.job(job.id)!;
  }

  async queue(jobId: number): Promise<Job> {
    if (!this.d.venice) throw new Error("VENICE_API_KEY is not set");
    const job = this.d.repo.job(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    if (!job.approved_at) throw new Error("job not approved: the app never sends without approval");
    const req = JSON.parse(job.request_json) as VeniceVideoRequest & { consent?: unknown };
    const r = await this.d.venice.queue(req, req.consent);
    if (r.ok !== true) {
      this.d.repo.updateJob(job.id, { status: "kind" in r ? "needs_consent" : "failed", error_json: JSON.stringify("kind" in r ? r.raw : r.error) });
      if (!("kind" in r)) this.d.repo.updateShot(job.shot_id, { status: "failed" });
      return this.d.repo.job(job.id)!;
    }
    this.d.repo.updateJob(job.id, { queue_id: r.queueId, status: "queued" });
    this.d.repo.updateShot(job.shot_id, { status: "queued" });
    if (job.quote_usd !== null) this.d.repo.addCost("venice", `job:${job.id}`, job.quote_usd, 0);
    return this.d.repo.job(job.id)!;
  }

  /** Poll until the clip is there, download it, mark done and open the review (spec §7.4-5). `once` asks Venice a single time (the UI's poll button). */
  async poll(jobId: number, opts: { maxWaitMs?: number; once?: boolean } = {}): Promise<{ job: Job; review?: Review }> {
    if (!this.d.venice) throw new Error("VENICE_API_KEY is not set");
    const job = this.d.repo.job(jobId);
    if (!job?.queue_id) throw new Error("job has no queue id");
    if (job.status === "done" || job.status === "failed") return { job };
    const shot = this.d.repo.shot(job.shot_id)!;
    const r = opts.once
      ? await this.d.venice.retrieve(job.queue_id)
      : await this.d.venice.waitFor(job.queue_id, { ...(opts.maxWaitMs !== undefined ? { maxWaitMs: opts.maxWaitMs } : {}), onPoll: (x, n) => this.d.log("poll", { job: job.id, n, state: x.state }) });
    if (r.state === "failed") { this.d.repo.updateJob(job.id, { status: "failed", error_json: JSON.stringify(r.error), finished_at: Date.now() }); this.d.repo.updateShot(shot.id, { status: "failed" }); return { job: this.d.repo.job(job.id)! }; }
    if (r.state === "pending") return { job: this.d.repo.job(job.id)! };
    const outDir = join(this.d.dataDir, String(shot.project_id), "outputs", String(shot.id));
    const path = await this.d.venice.download(r.downloadUrl, outDir, outputFileName(shot.seq, job.queue_id));
    this.d.repo.updateJob(job.id, { status: "done", download_url: r.downloadUrl, output_path: path, finished_at: Date.now() });
    this.d.repo.updateShot(shot.id, { status: "done" });
    const review = await this.openReview(job.id).catch((err: unknown) => { this.d.log("review setup failed", { err: err instanceof Error ? err.message : String(err) }); return undefined; });
    return { job: this.d.repo.job(job.id)!, ...(review ? { review } : {}) };
  }

  /** Frames, comparison image, checklist (spec §8). Status -> review. */
  async openReview(jobId: number): Promise<Review> {
    const job = this.d.repo.job(jobId);
    if (!job?.output_path) throw new Error("job has no output");
    const shot = this.d.repo.shot(job.shot_id)!;
    const framesDir = join(this.d.dataDir, String(shot.project_id), "frames", String(shot.id));
    mkdirSync(framesDir, { recursive: true });
    // Without ffmpeg the review still opens: no frames, no comparison, the clip itself and the checklist remain.
    const frames = await extractFrames(job.output_path, framesDir, this.d.tools ?? {}).catch((err: unknown) => { this.d.log("frame extraction failed", { err: err instanceof Error ? err.message : String(err) }); return [] as string[]; });
    const identity = this.d.repo.shotReferences(shot.id).find((r) => r.role === "identity" && r.reference.kind === "image")?.reference.path;
    const compare = await compareImage(identity, frames, join(framesDir, "compare.png"), this.d.tools?.ffmpeg ?? "ffmpeg").catch(() => undefined);
    const checklist = checklistFrom(this.d.repo.rules(shot.project_id));
    const review = this.d.repo.createReview({ shot_id: shot.id, job_id: job.id, frame_paths_json: JSON.stringify(frames), compare_image_path: compare ?? null, checklist_json: JSON.stringify(checklist), verdict: null, notes: "", vision_json: null });
    this.d.repo.updateShot(shot.id, { status: "review" });
    return review;
  }

  /** The user's verdict. Fail sends the card back to draft with the note; an optional new rule joins the bible from now on. */
  verdict(reviewId: number, verdict: "pass" | "fail", notes: string, checklist: readonly { rule: string; pass: boolean | null }[], newRule?: { text_de: string; text_en: string; severity: Rule["severity"] }): Review {
    const review = this.d.repo.review(reviewId);
    if (!review) throw new Error(`review ${reviewId} not found`);
    const items = (JSON.parse(review.checklist_json) as { rule: string; text_de: string; text_en: string; pass: boolean | null }[]).map((it) => ({ ...it, pass: checklist.find((c) => c.rule === it.rule)?.pass ?? it.pass }));
    this.d.repo.updateReview(review.id, { verdict, notes, checklist_json: JSON.stringify(items) });
    const shot = this.d.repo.shot(review.shot_id)!;
    if (verdict === "fail") {
      this.d.repo.updateShot(shot.id, { status: "draft", review_note: notes });
      if (newRule && newRule.text_de.trim()) this.d.repo.addRule(shot.project_id, { ...newRule, check_type: "jev", origin: `review:${shot.id}` });
    }
    return this.d.repo.review(review.id)!;
  }
}
