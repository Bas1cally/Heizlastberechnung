import { choice, noul, score, type ChoiceResponse, type NoulResponse, type ScoreResponse } from "@typesafe-ai/sdk";
import type { CodeCheck } from "./code-checks.js";
import type { Character, Reference, Rule, Shot, ShotReference, Verdict } from "./types.js";

/**
 * The Jev gate (spec §5): one call, all questions at once, English state,
 * the bible excerpt of the involved characters only. Thresholds per spec:
 * p >= 0.85 passed, p <= 0.35 violated, in between unsure; a score or
 * choice with confidence < 0.6 is unsure. One violated block rule -> red;
 * an unsure block rule -> yellow (Claude review, then Jev again); all
 * passed -> green.
 */
export const GATE_QUESTIONS = {
  q1_references: noul("Every character named in the shot has a reference with an assigned role."),
  q2_physical_action: noul("The action described happens physically and completely within the frame, with the cause shown before its effect."),
  q3_camera_move: noul("The prompt names a specific camera movement."),
  q4_shot_size: noul("The prompt names a specific shot size."),
  q5_character_drift: noul("The shot description contradicts a fixed attribute of a character in the bible."),
  q6_style_drift: noul("The shot's lighting or style contradicts the style guide."),
  q7_continuity: noul("The shot's opening state contradicts the previous shot's ending state."),
  q8_frame_grab: noul("The transition into this shot relies on a still frame taken from a previous clip."),
  q9_engine_fit: noul("The prompt uses vocabulary and structure appropriate for the selected engine and workflow."),
  q10_action_clarity: score("Overall clarity of the physical action for a video model.", ["weak: the action is vague, implied or off-screen", "adequate: the action is stated but its cause, effect or completion is thin", "strong: a concrete physical action, cause shown before effect, completed in frame"] as const),
  q11_workflow: choice("Which reference-to-video workflow does the prompt form imply?", { reference: "Generate from identity/style references.", edit: "Edit an existing clip.", extend: "Continue an existing clip.", stitch: "Join clips into one.", none: "No reference-to-video form." }),
};
export type GateQuestionKey = keyof typeof GATE_QUESTIONS;

/** Which questions guard which rule, and the polarity: `yes` means a yes answer is the violation. */
export const QUESTION_RULES: Record<GateQuestionKey, { rule: string; severity: "block" | "warn"; violatedWhen: "no" | "yes" | "score" | "choice" }> = {
  q1_references: { rule: "R1", severity: "block", violatedWhen: "no" },
  q2_physical_action: { rule: "R4", severity: "block", violatedWhen: "no" },
  q3_camera_move: { rule: "R5", severity: "block", violatedWhen: "no" },
  q4_shot_size: { rule: "R5", severity: "block", violatedWhen: "no" },
  q5_character_drift: { rule: "DRIFT", severity: "block", violatedWhen: "yes" },
  q6_style_drift: { rule: "DRIFT", severity: "block", violatedWhen: "yes" },
  q7_continuity: { rule: "CONTINUITY", severity: "block", violatedWhen: "yes" },
  q8_frame_grab: { rule: "R3", severity: "block", violatedWhen: "yes" },
  q9_engine_fit: { rule: "ENGINE", severity: "warn", violatedWhen: "no" },
  q10_action_clarity: { rule: "R4", severity: "warn", violatedWhen: "score" },
  q11_workflow: { rule: "WORKFLOW", severity: "block", violatedWhen: "choice" },
};

export interface GateStateInput {
  readonly shot: Shot;
  readonly previous: Shot | undefined;
  readonly characters: readonly Character[];
  readonly references: readonly (ShotReference & { reference: Reference })[];
  readonly rules: readonly Rule[];
  readonly styleGuideEn: string;
  readonly promptFinal: string;
}

/** The English state of spec §5; only the characters the shot involves. */
export function buildGateState(i: GateStateInput): Record<string, unknown> {
  const involvedIds = new Set(i.references.map((r) => r.reference.character_id).filter((x): x is number => x !== null));
  const text = `${i.shot.beat_de} ${i.shot.action_physical_en} ${i.shot.action_physical_de}`.toLowerCase();
  const involved = i.characters.filter((c) => involvedIds.has(c.id) || text.includes(c.name.toLowerCase()));
  return {
    style_guide: i.styleGuideEn,
    characters: involved.map((c) => ({ name: c.name, fixed_attributes_en: c.fixed_attributes_en, variable_attributes: c.variable_attributes })),
    rules: i.rules.filter((r) => /jev/.test(r.check_type) || r.origin.startsWith("review:")).map((r) => ({ id: r.code, text_en: r.text_en, severity: r.severity })),
    previous_shot: i.previous ? { seq: i.previous.seq, action_physical_en: i.previous.action_physical_en, camera_move: i.previous.camera_move, shot_size: i.previous.shot_size, lighting: i.previous.lighting, transition_out: i.shot.transition_in } : null,
    shot: {
      seq: i.shot.seq, beat: i.shot.beat_de, shot_size: i.shot.shot_size, camera_move: i.shot.camera_move, lighting: i.shot.lighting, composition: i.shot.composition,
      action_physical_en: i.shot.action_physical_en, duration_s: i.shot.duration_s, engine: i.shot.engine, workflow: i.shot.workflow, transition_in: i.shot.transition_in,
      references: i.references.map((r) => ({ slot: r.slot, role: r.role, character: i.characters.find((c) => c.id === r.reference.character_id)?.name ?? null, kind: r.reference.kind })),
    },
    prompt_final: i.promptFinal,
  };
}

export type GateAnswers = { [K in GateQuestionKey]: K extends "q10_action_clarity" ? ScoreResponse : K extends "q11_workflow" ? ChoiceResponse : NoulResponse };
export type QuestionOutcome = "passed" | "violated" | "unsure";

export interface GateEvaluation {
  readonly verdict: Verdict;
  readonly outcomes: Record<GateQuestionKey, { outcome: QuestionOutcome; p: number; confidence: number | null; rule: string; severity: "block" | "warn" }>;
  readonly codeFailures: CodeCheck[];
  readonly reasons: string[];
}

const PASS = 0.85, FAIL = 0.35, MIN_CONF = 0.6;

export function evaluateGate(answers: GateAnswers, codeChecks: readonly CodeCheck[], shot: Shot): GateEvaluation {
  const outcomes = {} as GateEvaluation["outcomes"];
  const reasons: string[] = [];
  for (const key of Object.keys(GATE_QUESTIONS) as GateQuestionKey[]) {
    const meta = QUESTION_RULES[key];
    const a = answers[key];
    let outcome: QuestionOutcome, p: number, confidence: number | null = null;
    if (a.type === "noul") {
      p = a.noul;
      const pGood = meta.violatedWhen === "yes" ? 1 - p : p;
      outcome = pGood >= PASS ? "passed" : pGood <= FAIL ? "violated" : "unsure";
    } else if (a.type === "score") {
      p = a.score; confidence = a.confidence;
      outcome = a.confidence < MIN_CONF ? "unsure" : a.score >= 1.5 ? "passed" : a.score <= 0.5 ? "violated" : "unsure";
    } else {
      confidence = a.confidence; p = a.probabilities[a.choice as keyof typeof a.probabilities] as number;
      const implied = String(a.choice);
      const expected = shot.workflow.startsWith("r2v") ? shot.workflow.replace("r2v_", "") : "none";
      outcome = a.confidence < MIN_CONF ? "unsure" : implied === expected ? "passed" : "violated";
    }
    outcomes[key] = { outcome, p, confidence, rule: meta.rule, severity: meta.severity };
    if (outcome !== "passed") reasons.push(`${key} ${outcome} (${meta.rule}, ${meta.severity}, p=${p.toFixed(2)}${confidence !== null ? `, conf=${confidence.toFixed(2)}` : ""})`);
  }
  const codeFailures = codeChecks.filter((c) => !c.ok);
  for (const c of codeFailures) reasons.push(`code ${c.rule} ${c.severity}: ${c.detail}`);
  const blockViolated = codeFailures.some((c) => c.severity === "block") || Object.values(outcomes).some((o) => o.severity === "block" && o.outcome === "violated");
  const blockUnsure = Object.values(outcomes).some((o) => o.severity === "block" && o.outcome === "unsure");
  const verdict: Verdict = blockViolated ? "red" : blockUnsure ? "yellow" : "green";
  return { verdict, outcomes, codeFailures, reasons };
}

/** The one call: state + all questions, through the injected client (the SDK in production, a script in tests). */
export type GateCall = (state: Record<string, unknown>, questions: typeof GATE_QUESTIONS) => Promise<{ answers: GateAnswers; model: string; usage: { input_tokens: number; output_tokens: number }; latencyMs: number }>;

export function createGateCall(client: { systemOne(req: { state: unknown; questions: typeof GATE_QUESTIONS }, opts?: unknown): Promise<{ answers: unknown; model: string; usage: { input_tokens: number; output_tokens: number } }> }, now: () => number = () => performance.now()): GateCall {
  return async (state, questions) => {
    const t0 = now();
    const res = await client.systemOne({ state, questions });
    return { answers: res.answers as GateAnswers, model: res.model, usage: res.usage, latencyMs: Math.round(now() - t0) };
  };
}
