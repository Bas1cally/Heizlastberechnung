import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adviceFrom, adviseAugmentWithJev, adviseAugmentWithText, adviseWithJev, adviseWithText, augmentStat, buildAugmentQuestions, buildQuestions, buildState, compKey, unitsToBuy, type Answers, type AugmentAnswers } from "../../../src/tft/advisor.js";
import { ffmpegArgs } from "../../../src/tft/capture.js";
import { ensureMeta, loadCachedMeta } from "../../../src/tft/meta.js";
import { createTftApi, overlayText } from "../../../src/tft/server.js";
import { TftStore } from "../../../src/tft/store.js";
import { BoardReadSchema, type BoardRead, type Meta } from "../../../src/tft/types.js";
import { fingerprint, readBoard } from "../../../src/tft/vision.js";
import { openDatabase } from "../../../src/persistence/database.js";
import type { FetchLike } from "../../../src/director/venice.js";

const meta: Meta = { set: "Set 16", patch: "16.3", sources: ["a"], augments: [{ name: "Pandora's Items", avg_place: 4.1, tier: "A", note: "flexible items" }, { name: "Cybernetic Uplink", avg_place: 4.6, tier: "B", note: "" }], comps: [
  { name: "Star Guardian Reroll", tier: "S", core_units: ["Syndra", "Ahri", "Neeko"], carries: ["Syndra"], key_items: ["Shojin"], augments: [], playstyle: "slow roll at 6", when_to_play: "early Syndra 2" },
  { name: "Duelist Yasuo", tier: "A", core_units: ["Yasuo", "Yone", "Kai'Sa"], carries: ["Yone"], key_items: ["Titan's"], augments: [], playstyle: "fast 8", when_to_play: "" },
] };
const read: BoardRead = BoardReadSchema.parse({ stage: "3-2", gold: 34, level: 6, hp: 78, shop: ["Syndra", "Garen", "", "Yone", "Ahri"], board: [{ name: "Syndra", stars: 2, items: ["Shojin"] }, { name: "Neeko", stars: 1, items: [] }], bench: [{ name: "Ahri", stars: 1 }], augments: ["Pandora's Items"], phase: "planning", confidence: 0.8 });

function fakeChat(reply: (body: Record<string, unknown>, n: number) => { status: number; body: unknown }) {
  const bodies: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_url, init) => { const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>; bodies.push(body); const r = reply(body, bodies.length); const text = JSON.stringify(r.body); return { status: r.status, ok: r.status < 300, json: async () => r.body, text: async () => text, headers: { get: () => null } }; };
  return { fetch, bodies };
}
const completion = (content: unknown) => ({ status: 200, body: { model: "m", choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 1500, completion_tokens: 120 } } });

describe("tft vision", () => {
  it("sends the screenshot as an image part with a JSON schema and validates the reading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tft-")); const img = join(dir, "s.jpg"); writeFileSync(img, Buffer.from("jpegbytes"));
    const { fetch, bodies } = fakeChat(() => completion({ stage: "2-1", gold: 12, level: 4, hp: 100, shop: ["Ahri", "", "Garen", "Yone", "Syndra"], board: [{ name: "Syndra", stars: 1, items: [] }], bench: [], augments: [], item_bench: ["B.F. Sword"], phase: "planning", confidence: 0.7 }));
    const r = await readBoard(img, { apiKey: "k", model: "qwen-3-8-flash", fetch });
    expect(r.value.shop).toHaveLength(5);
    expect(r.value.board[0]?.name).toBe("Syndra");
    const user = (bodies[0]!["messages"] as { content: unknown }[])[1]!.content as { type: string; image_url?: { url: string } }[];
    expect(user[1]?.type).toBe("image_url");
    expect(user[1]?.image_url?.url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(bodies[0]!["reasoning_effort"]).toBe("none");
    expect((bodies[0]!["response_format"] as { type: string }).type).toBe("json_schema");
  });
  it("fingerprint ignores order on board and bench but not the shop", () => {
    const a = fingerprint(read);
    expect(fingerprint({ ...read, board: [...read.board].reverse() })).toBe(a);
    expect(fingerprint({ ...read, shop: [...read.shop].reverse() })).not.toBe(a);
    expect(fingerprint({ ...read, gold: 35 })).not.toBe(a);
  });
  it("ffmpeg capture grabs the game window, a monitor region, or the desktop, scaled to the width", () => {
    const a = ffmpegArgs("C:\\x\\s.jpg", 1600, 85);
    expect(a).toContain("gdigrab");
    expect(a).toContain("scale=1600:-2");
    expect(a[a.length - 1]).toBe("C:\\x\\s.jpg");
    expect(ffmpegArgs("o.jpg", 1600, 85, { kind: "window", title: "League of Legends (TM) Client" })).toContain("title=League of Legends (TM) Client");
    const r = ffmpegArgs("o.jpg", 1600, 85, { kind: "region", x: 0, y: 0, w: 2560, h: 1440 });
    expect(r.slice(r.indexOf("-offset_x"), r.indexOf("-offset_x") + 6)).toEqual(["-offset_x", "0", "-offset_y", "0", "-video_size", "2560x1440"]);
  });
});

describe("tft meta", () => {
  it("fetches with web search on, caches, and serves the cache while fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tft-")); const cache = join(dir, "meta.json");
    const { fetch, bodies } = fakeChat(() => completion(meta));
    let now = 1_000_000;
    const a = await ensureMeta({ apiKey: "k", model: "kimi-k2-6", cachePath: cache, fetch, now: () => now });
    expect(a.fromCache).toBe(false);
    expect((bodies[0]!["venice_parameters"] as { enable_web_search: string }).enable_web_search).toBe("on");
    const b = await ensureMeta({ apiKey: "k", model: "kimi-k2-6", cachePath: cache, fetch, now: () => now + 3_600_000 });
    expect(b.fromCache).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(loadCachedMeta(cache, 1000, now + 5000)).toBeUndefined();
    const c = await ensureMeta({ apiKey: "k", model: "kimi-k2-6", cachePath: cache, fetch, now: () => now }, true);
    expect(c.fromCache).toBe(false);
  });
  it("drops venice_parameters once when the model rejects them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tft-"));
    const { fetch, bodies } = fakeChat((b) => (b["venice_parameters"] ? { status: 400, body: { error: "unknown" } } : completion(meta)));
    const m = await ensureMeta({ apiKey: "k", model: "x", cachePath: join(dir, "m.json"), fetch });
    expect(m.meta.comps).toHaveLength(2);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!["venice_parameters"]).toBeUndefined();
  });
});

describe("tft advisor", () => {
  it("builds a comp choice from the meta and an English state; Jev's answers become advice with shop buys", async () => {
    const q = buildQuestions(meta);
    expect(Object.keys(q.comp.criteria)).toEqual(["star_guardian_reroll", "duelist_yasuo"]);
    expect(compKey("Kai'Sa & Co.")).toBe("kai_sa_co");
    const state = buildState(read, meta);
    expect((state["comps"] as { key: string }[])[0]?.key).toBe("star_guardian_reroll");
    const answers: Answers = {
      comp: { type: "choice", choice: "star_guardian_reroll", confidence: 0.82, probabilities: { star_guardian_reroll: 0.82, duelist_yasuo: 0.18 } } as never,
      action: { type: "choice", choice: "BUY", confidence: 0.7, probabilities: { BUY: 0.7, ROLL: 0.2, LEVEL: 0.05, SAVE: 0.05 } } as never,
      on_track: { type: "noul", noul: 0.9 } as never,
      urgency: { type: "score", score: 0.3, confidence: 0.8, legend: {}, probabilities: {} } as never,
    };
    let seen: unknown;
    const r = await adviseWithJev(read, meta, async (state, questions) => { seen = { state, questions }; return { answers, model: "jev-x", usage: { input_tokens: 900, output_tokens: 8 } }; }, (() => { let t = 0; return () => (t += 120); })());
    expect(r.advice).toMatchObject({ comp: "Star Guardian Reroll", action: "BUY", buy: ["Syndra", "Ahri"], urgency: "low", onTrack: 0.9, source: "jev", latencyMs: 120 });
    expect(Object.keys((seen as { questions: object }).questions)).toEqual(["comp", "action", "on_track", "urgency"]);
    expect(adviceFrom({ ...answers, action: { ...answers.action, choice: "nonsense" } as never }, read, meta, "m", 1).action).toBe("SAVE");
    expect(unitsToBuy(read, undefined)).toEqual([]);
  });
  it("the text fallback answers the same questions as JSON", async () => {
    const { fetch, bodies } = fakeChat(() => completion({ comp_key: "duelist_yasuo", action: "LEVEL", on_track: 0.4, urgency: "medium", reason: "Yone in shop" }));
    const r = await adviseWithText(read, meta, { apiKey: "k", model: "kimi-k2-6", fetch });
    expect(r.advice).toMatchObject({ comp: "Duelist Yasuo", action: "LEVEL", buy: ["Yone"], source: "text", urgency: "medium" });
    const user = JSON.parse((bodies[0]!["messages"] as { content: string }[])[1]!.content) as { state: { gold: number }; questions: { comp: string } };
    expect(user.state.gold).toBe(34);
    expect(user.questions.comp).toMatch(/best target/);
  });
});

describe("tft store and server", () => {
  it("keeps readings and advice; the api renders three overlay lines", () => {
    const store = new TftStore(openDatabase(":memory:"), () => 42);
    const api = createTftApi({ store, meta: () => meta, status: () => ({ vision: "v" }), log: () => {} });
    expect(api.advice().line1).toContain("warte");
    const reading = store.addReading("/shots/1.jpg", read, fingerprint(read), "qwen", 800, { input_tokens: 1500, output_tokens: 100 });
    expect(api.advice().line1).toBe("Stage 3-2 · 34 Gold · Lvl 6");
    store.addAdvice(reading.id, { comp: "Star Guardian Reroll", compKey: "star_guardian_reroll", action: "ROLL", buy: ["Syndra"], urgency: "high", onTrack: 0.7, confidence: 0.8, reasons: [], source: "jev", model: "jev", latencyMs: 300 }, { input_tokens: 900, output_tokens: 8 });
    const a = api.advice();
    expect(a.line1).toBe("Star Guardian Reroll (80%)");
    expect(a.line2).toBe("Rollen: Syndra");
    expect(a.line3).toContain("Druck high");
    expect(a.totals).toEqual({ readings: 1, advices: 1, readTokens: 1600, adviceTokens: 908 });
    expect(overlayText(undefined, { ...read, phase: "not_tft" }).line2).toBe("Kein TFT im Bild");
  });
});

describe("tft augment choice", () => {
  const offered: BoardRead = { ...read, phase: "augment_choice", augment_options: ["Pandora's Items", "Cybernetic Uplink", "Fresh Idea"] };
  it("builds one choice over the offered cards with the patch statistic, and Jev's pick becomes overlay text", async () => {
    const q = buildAugmentQuestions(offered, meta);
    expect(Object.keys(q.augment.criteria)).toEqual(["opt1_pandora_s_items", "opt2_cybernetic_uplink", "opt3_fresh_idea"]);
    expect(q.augment.criteria["opt1_pandora_s_items"]).toContain("avg placement 4.1");
    expect(q.augment.criteria["opt3_fresh_idea"]).toContain("no statistic");
    expect(augmentStat("pandoras items", meta.augments)?.avg_place).toBe(4.1);
    const answers: AugmentAnswers = {
      augment: { type: "choice", choice: "opt1_pandora_s_items", confidence: 0.77, probabilities: { opt1_pandora_s_items: 0.77, opt2_cybernetic_uplink: 0.15, opt3_fresh_idea: 0.08 } } as never,
      comp: { type: "choice", choice: "star_guardian_reroll", confidence: 0.8, probabilities: { star_guardian_reroll: 0.8, duelist_yasuo: 0.2 } } as never,
    };
    const r = await adviseAugmentWithJev(offered, meta, async () => ({ answers, model: "jev", usage: { input_tokens: 700, output_tokens: 4 } }));
    expect(r.advice.augment).toMatchObject({ pick: "Pandora's Items", options: offered.augment_options });
    expect(r.advice.augment?.why).toContain("Pandora's Items 77%");
    expect(r.advice.comp).toBe("Star Guardian Reroll");
    expect(overlayText(r.advice, offered).line1).toBe("Augment: Pandora's Items");
    expect(overlayText(r.advice, offered).line2).toBe("dann Star Guardian Reroll");
    expect(fingerprint(offered)).not.toBe(fingerprint(read));
  });
  it("the text fallback picks by option key", async () => {
    const { fetch } = fakeChat(() => completion({ augment_key: "opt2_cybernetic_uplink", comp_key: "duelist_yasuo", reason: "tempo" }));
    const r = await adviseAugmentWithText(offered, meta, { apiKey: "k", model: "m", fetch });
    expect(r.advice.augment?.pick).toBe("Cybernetic Uplink");
    expect(r.advice.augment?.why).toContain("Ø Platz 4.6");
    expect(r.advice.comp).toBe("Duelist Yasuo");
  });
  it("a cached meta without augment statistics is refetched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tft-")); const cache = join(dir, "meta.json");
    writeFileSync(cache, JSON.stringify({ fetchedAt: 5, meta: { ...meta, augments: [] } }));
    expect(loadCachedMeta(cache, 1e12, 10)).toBeUndefined();
    writeFileSync(cache, JSON.stringify({ fetchedAt: 5, meta }));
    expect(loadCachedMeta(cache, 1e12, 10)?.meta.augments).toHaveLength(2);
  });
});
