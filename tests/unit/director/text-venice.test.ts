import { describe, expect, it } from "vitest";
import { VeniceTextCalls, veniceTextPricing } from "../../../src/director/text-venice.js";
import type { FetchLike } from "../../../src/director/venice.js";
import { vocabulary } from "./helpers.js";

const draft = { shot_size: "medium close-up", camera_move: "slow push-in", lens_note: "", lighting: "soft window light", composition: "centered", action_physical_en: "Mara lifts the cup.", action_physical_de: "Mara hebt die Tasse.", engine_recommendation: "seedance-2-0-reference-to-video-basic", duration_s_recommendation: 5, references_needed: [] };

function fakeChat(reply: (body: Record<string, unknown>, n: number) => { status: number; body: unknown }) {
  const bodies: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>; bodies.push(body);
    const r = reply(body, bodies.length);
    const text = JSON.stringify(r.body);
    return { status: r.status, ok: r.status < 300, json: async () => r.body, text: async () => text, headers: { get: () => null } };
  };
  return { fetch, bodies };
}
const completion = (content: unknown, usage = { prompt_tokens: 640, completion_tokens: 90 }) => ({ status: 200, body: { model: "kimi-k2-6", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage } });

describe("venice text calls", () => {
  it("draft: system + one user message, JSON schema response format, reasoning effort, tokens from usage", async () => {
    const { fetch, bodies } = fakeChat(() => completion(draft));
    const c = new VeniceTextCalls({ apiKey: "k", model: "kimi-k2-6", fetch, reasoningEffort: "low" });
    const r = await c.draft({ styleGuideEn: "Muted.", characters: [], previous: undefined, beatDe: "Mara hebt die Tasse.", engine: "e", workflow: "r2v_reference", vocabulary });
    expect(r.value.camera_move).toBe("slow push-in");
    expect(r.usage).toEqual({ input_tokens: 640, output_tokens: 90, model: "kimi-k2-6" });
    const b = bodies[0]!;
    expect(b["model"]).toBe("kimi-k2-6");
    expect((b["messages"] as { role: string }[]).map((m) => m.role)).toEqual(["system", "user"]);
    expect(b["reasoning_effort"]).toBe("low");
    expect((b["response_format"] as { type: string; json_schema: { schema: { properties: object } } }).type).toBe("json_schema");
    expect(Object.keys((b["response_format"] as { json_schema: { schema: { properties: object } } }).json_schema.schema.properties)).toContain("action_physical_en");
    expect(b["max_completion_tokens"]).toBe(800);
    expect(c.provider).toBe("venice");
  });

  it("retries once without reasoning_effort when the model rejects it", async () => {
    const { fetch, bodies } = fakeChat((b) => (b["reasoning_effort"] ? { status: 400, body: { error: "unknown field reasoning_effort" } } : completion({ text_en: "Red hair." })));
    const c = new VeniceTextCalls({ apiKey: "k", model: "m", fetch, reasoningEffort: "low" });
    expect((await c.translate("Rote Haare.")).value).toBe("Red hair.");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!["reasoning_effort"]).toBeUndefined();
  });

  it("strips code fences, validates against the schema, and reports API errors with the body", async () => {
    const fenced = new VeniceTextCalls({ apiKey: "k", model: "m", fetch: fakeChat(() => completion("```json\n{\"camera_move\":\"dolly in\"}\n```")).fetch });
    const r = await fenced.reviewFix({ styleGuideEn: "", characters: [], previous: undefined, beatDe: "b", engine: "e", workflow: "t2v", vocabulary, current: { shot_size: "", camera_move: "", lens_note: "", lighting: "", composition: "", action_physical_en: "", action_physical_de: "" }, gateFindings: [] });
    expect(r.value).toEqual({ camera_move: "dolly in" });
    const wrong = new VeniceTextCalls({ apiKey: "k", model: "m", fetch: fakeChat(() => completion({ text_en: 5 })).fetch });
    await expect(wrong.translate("x")).rejects.toThrow(/schema.*Raw:/);
    // a wrong first answer gets one correction round that carries the rejection
    const fixed = fakeChat((b, n) => (n === 1 ? completion([{ nope: 1 }, { also: 2 }]) : completion({ text_en: "Second try." })));
    const c2 = new VeniceTextCalls({ apiKey: "k", model: "m", fetch: fixed.fetch });
    const r2 = await c2.translate("x");
    expect(r2.value).toBe("Second try.");
    expect(fixed.bodies).toHaveLength(2);
    expect(JSON.stringify(fixed.bodies[1]!["messages"])).toContain("Your answer was rejected");
    expect(r2.usage.input_tokens).toBe(1280);
    // a list whose element fits is accepted without a second call
    const listed = fakeChat(() => completion([{ text_en: "Listed." }]));
    expect((await new VeniceTextCalls({ apiKey: "k", model: "m", fetch: listed.fetch }).translate("x")).value).toBe("Listed.");
    expect(listed.bodies).toHaveLength(1);
    const down = new VeniceTextCalls({ apiKey: "k", model: "m", fetch: fakeChat(() => ({ status: 402, body: { error: "insufficient balance" } })).fetch });
    await expect(down.translate("x")).rejects.toThrow(/402.*insufficient balance/);
  });

  it("reads a model's USD prices from the model list", async () => {
    const fetch: FetchLike = async () => { const body = { data: [{ id: "kimi-k2-6", model_spec: { pricing: { input: { usd: 0.75 }, output: { usd: 3.5 } } } }] }; return { status: 200, ok: true, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } }; };
    expect(await veniceTextPricing("k", "kimi-k2-6", fetch)).toEqual({ inPerM: 0.75, outPerM: 3.5 });
    expect(await veniceTextPricing("k", "nope", fetch)).toBeUndefined();
  });
});
