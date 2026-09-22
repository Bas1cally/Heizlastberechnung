import { describe, expect, it } from "vitest";
import { ClaudeCalls, usdFor } from "../../../src/director/claude.js";
import { vocabulary } from "./helpers.js";

/** A stand-in for the SDK: records the request, answers with a parsed object. */
function fakeClient(parsed: unknown) {
  const requests: Record<string, unknown>[] = [];
  const client = { messages: { parse: async (req: Record<string, unknown>) => { requests.push(req); return { parsed_output: parsed, usage: { input_tokens: 812, output_tokens: 140 }, model: "claude-test", stop_reason: "end_turn" }; } } };
  return { client: client as never, requests };
}
const draft = { shot_size: "medium close-up", camera_move: "slow push-in", lens_note: "", lighting: "soft window light", composition: "centered", action_physical_en: "Mara lifts the cup.", action_physical_de: "Mara hebt die Tasse.", engine_recommendation: "seedance-2-0-reference-to-video", duration_s_recommendation: 5, references_needed: [{ character: "Mara", role: "identity" }] };

describe("claude calls", () => {
  it("draft: one user message, no history, structured output, token counts returned", async () => {
    const { client, requests } = fakeClient(draft);
    const c = new ClaudeCalls({ model: "claude-opus-5", client });
    const r = await c.draft({ styleGuideEn: "Muted.", characters: [{ name: "Mara", fixed_attributes_en: "red hair", variable_attributes: "" }], previous: undefined, beatDe: "Mara hebt die Tasse.", engine: "seedance-2-0-reference-to-video", workflow: "r2v_reference", vocabulary });
    expect(r.value.shot_size).toBe("medium close-up");
    expect(r.usage).toEqual({ input_tokens: 812, output_tokens: 140, model: "claude-test" });
    const req = requests[0]!;
    expect(req["model"]).toBe("claude-opus-5");
    expect(req["max_tokens"]).toBe(800);
    expect((req["messages"] as unknown[]).length).toBe(1);
    expect(JSON.stringify(req)).not.toMatch(/history|earlier|previous answers/i);
    expect((req["output_config"] as { format: unknown }).format).toBeTruthy();
  });

  it("review_fix passes the current fields and the findings; translate uses temperature 0", async () => {
    const { client, requests } = fakeClient({ camera_move: "dolly in" });
    const c = new ClaudeCalls({ model: "m", client });
    const r = await c.reviewFix({ styleGuideEn: "", characters: [], previous: undefined, beatDe: "b", engine: "e", workflow: "t2v", vocabulary, current: { shot_size: "wide shot", camera_move: "moves", lens_note: "", lighting: "", composition: "", action_physical_en: "x", action_physical_de: "x" }, gateFindings: ["q3_camera_move: p(yes)=0.20"] });
    expect(r.value).toEqual({ camera_move: "dolly in" });
    const content = JSON.parse((requests[0]!["messages"] as { content: string }[])[0]!.content) as Record<string, unknown>;
    expect(content["gate_findings"]).toEqual(["q3_camera_move: p(yes)=0.20"]);
    expect((content["current_fields"] as { camera_move: string }).camera_move).toBe("moves");
    const t = fakeClient({ text_en: "Red hair." });
    const tr = await new ClaudeCalls({ model: "m", client: t.client }).translate("Rote Haare.");
    expect(tr.value).toBe("Red hair.");
    expect(t.requests[0]!["temperature"]).toBe(0);
  });

  it("an unparsable answer is an error, not a silent empty card", async () => {
    const { client } = fakeClient(null);
    await expect(new ClaudeCalls({ model: "m", client }).translate("x")).rejects.toThrow(/no parsable output/);
  });

  it("usdFor prices per million tokens", () => {
    expect(usdFor({ input_tokens: 1_000_000, output_tokens: 0 }, { inPerM: 15, outPerM: 75 })).toBe(15);
    expect(usdFor({ input_tokens: 2000, output_tokens: 800 }, { inPerM: 15, outPerM: 75 })).toBeCloseTo(0.09);
  });
});
