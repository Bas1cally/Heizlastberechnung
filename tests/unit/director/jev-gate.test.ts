import { describe, expect, it } from "vitest";
import { buildGateState, createGateCall, evaluateGate, GATE_QUESTIONS } from "../../../src/director/jev-gate.js";
import { SEED_RULES } from "../../../src/director/seed-rules.js";
import { greenAnswers, identityRef, mara, shotOf } from "./helpers.js";

const rules = SEED_RULES.map((r, i) => ({ id: i + 1, project_id: 1, code: r.code, text_de: r.text_de, text_en: r.text_en, severity: r.severity, check_type: r.check.join("+"), active: 1, origin: "seed" }));

describe("jev gate", () => {
  it("state is English, holds only the involved characters and the rules Jev checks, never history", () => {
    const other = { ...mara, id: 2, name: "Ben" };
    const state = buildGateState({ shot: shotOf({ prompt_final: "P" }), previous: shotOf({ id: 0, seq: 0 }), characters: [mara, other], references: [identityRef()], rules, styleGuideEn: "Muted.", promptFinal: "P" });
    expect((state["characters"] as { name: string }[]).map((c) => c.name)).toEqual(["Mara"]);
    expect((state["rules"] as { id: string }[]).map((r) => r.id)).toEqual(["R1", "R4", "R5"]);
    expect(state["previous_shot"]).toMatchObject({ seq: 0 });
    expect(JSON.stringify(state)).not.toMatch(/rote Haare|hebt die Tasse und trinkt/);
    expect(Object.keys(GATE_QUESTIONS)).toHaveLength(11);
  });

  it("all passed -> green", () => {
    const e = evaluateGate(greenAnswers(), [], shotOf());
    expect(e.verdict).toBe("green");
    expect(e.reasons).toEqual([]);
  });

  it("a missing camera move (R5 block violated) -> red, with the reason", () => {
    const e = evaluateGate(greenAnswers({ q3_camera_move: { type: "noul", noul: 0.2 } }), [], shotOf());
    expect(e.verdict).toBe("red");
    expect(e.reasons[0]).toMatch(/q3_camera_move violated \(R5, block/);
  });

  it("an unsure block question -> yellow; an unsure warn question stays green", () => {
    expect(evaluateGate(greenAnswers({ q2_physical_action: { type: "noul", noul: 0.6 } }), [], shotOf()).verdict).toBe("yellow");
    expect(evaluateGate(greenAnswers({ q9_engine_fit: { type: "noul", noul: 0.6 } }), [], shotOf()).verdict).toBe("green");
  });

  it("yes-polarity questions: a likely drift is a violation", () => {
    expect(evaluateGate(greenAnswers({ q5_character_drift: { type: "noul", noul: 0.9 } }), [], shotOf()).verdict).toBe("red");
    expect(evaluateGate(greenAnswers({ q8_frame_grab: { type: "noul", noul: 0.5 } }), [], shotOf()).verdict).toBe("yellow");
  });

  it("score and choice with confidence below 0.6 are unsure; the workflow choice must match the card", () => {
    const low = { ...greenAnswers().q10_action_clarity, confidence: 0.4 };
    expect(evaluateGate(greenAnswers({ q10_action_clarity: low }), [], shotOf()).verdict).toBe("green"); // warn rule
    const wrong = { ...greenAnswers().q11_workflow, choice: "extend" as never };
    expect(evaluateGate(greenAnswers({ q11_workflow: wrong }), [], shotOf()).verdict).toBe("red");
    expect(evaluateGate(greenAnswers({ q11_workflow: wrong }), [], shotOf({ workflow: "r2v_extend" })).verdict).toBe("green");
    expect(evaluateGate(greenAnswers({ q11_workflow: { ...greenAnswers().q11_workflow, choice: "none" as never } }), [], shotOf({ workflow: "t2v" })).verdict).toBe("green");
  });

  it("a failed code check with severity block -> red even when Jev passes everything", () => {
    const e = evaluateGate(greenAnswers(), [{ rule: "R1", severity: "block", ok: false, detail: "no identity reference for: Mara" }, { rule: "R9", severity: "warn", ok: false, detail: "1080p" }], shotOf());
    expect(e.verdict).toBe("red");
    expect(e.codeFailures).toHaveLength(2);
    expect(evaluateGate(greenAnswers(), [{ rule: "R9", severity: "warn", ok: false, detail: "1080p" }], shotOf()).verdict).toBe("green");
  });

  it("createGateCall sends state and all questions in one call and measures latency", async () => {
    let seen: unknown;
    let t = 0;
    const call = createGateCall({ systemOne: async (req) => { seen = req; return { answers: greenAnswers(), model: "jev-x", usage: { input_tokens: 700, output_tokens: 11 } }; } }, () => (t += 150));
    const r = await call({ a: 1 }, GATE_QUESTIONS);
    expect((seen as { state: unknown; questions: unknown }).state).toEqual({ a: 1 });
    expect(Object.keys((seen as { questions: object }).questions)).toHaveLength(11);
    expect(r.latencyMs).toBe(150);
    expect(r.model).toBe("jev-x");
  });
});
