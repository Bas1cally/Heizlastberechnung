import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApi, HttpError } from "../../../src/director/server.js";
import { DirectorService } from "../../../src/director/service.js";
import { VeniceClient, type FetchLike } from "../../../src/director/venice.js";
import type { ClaudeCalls } from "../../../src/director/claude.js";
import { engines, greenAnswers, memRepo, pngFile, scriptedGate, tmpDir, vocabulary } from "./helpers.js";

/** Venice as a script: quote 0.37 USD, queue q-1, processing twice, then done with a download. */
function veniceScript(opts: { consentOnFirstQuote?: boolean } = {}) {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  let polls = 0, quotes = 0;
  const fetch: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api\/v1/, "");
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ path, ...(body ? { body } : {}) });
    const reply = (status: number, b: unknown) => ({ status, ok: status < 300, json: async () => b, text: async () => JSON.stringify(b), headers: { get: () => null } });
    if (path === "/video/quote") return opts.consentOnFirstQuote && ++quotes === 1 && !body?.["consent"] ? reply(409, { error: "needs_consent", consent: { type: "likeness" } }) : reply(200, { quote_usd: 0.37 });
    if (path === "/video/queue") return reply(200, { queue_id: "q-1" });
    if (path.startsWith("/video/retrieve")) return ++polls < 3 ? reply(200, { status: "processing" }) : reply(200, { status: "completed", download_url: "https://cdn.test/clip.mp4" });
    if (path === "/models") return reply(200, { data: [] });
    return reply(404, {});
  };
  return { fetch, calls };
}
const fakeClaude = (): ClaudeCalls => ({
  draft: async () => ({ value: { shot_size: "medium close-up", camera_move: "slow push-in", lens_note: "", lighting: "soft window light", composition: "centered", action_physical_en: "Mara lifts the cup with her right hand and drinks.", action_physical_de: "Mara hebt die Tasse und trinkt.", engine_recommendation: "seedance-2-0-reference-to-video", duration_s_recommendation: 5, references_needed: [] }, usage: { input_tokens: 900, output_tokens: 120, model: "claude-test" }, request: {}, response: {} }),
  reviewFix: async () => ({ value: { camera_move: "dolly in" }, usage: { input_tokens: 700, output_tokens: 20, model: "claude-test" }, request: {}, response: {} }),
  translate: async (t: string) => ({ value: ({ "Gedeckte Farben.": "Muted colours.", "rote Haare": "red hair" } as Record<string, string>)[t] ?? `translated ${t.length}`, usage: { input_tokens: 50, output_tokens: 10, model: "claude-test" }, request: {}, response: {} }),
}) as unknown as ClaudeCalls;

function setup(opts: { gateAnswers?: ReturnType<typeof greenAnswers>; consent?: boolean; download?: (url: string) => Buffer } = {}) {
  const repo = memRepo(); const dataDir = tmpDir();
  const venice = veniceScript({ ...(opts.consent ? { consentOnFirstQuote: true } : {}) });
  const gate = scriptedGate(opts.gateAnswers ?? greenAnswers());
  const client = new VeniceClient({ apiKey: "k", fetch: venice.fetch, sleep: async () => {} });
  // download is HTTP in production; here the "CDN" is a buffer.
  client.download = async (_url: string, outDir: string, name: string) => { const { mkdirSync, writeFileSync } = await import("node:fs"); mkdirSync(outDir, { recursive: true }); const p = join(outDir, name); writeFileSync(p, (opts.download ?? (() => Buffer.from("mp4")))(_url)); return p; };
  const logs: string[] = [];
  const service = new DirectorService({ repo, engines, vocabulary, claude: fakeClaude(), claudePrice: { inPerM: 15, outPerM: 75 }, gate: gate.call, venice: client, dataDir, tools: { ffmpeg: "/nonexistent/ffmpeg", ffprobe: "/nonexistent/ffprobe" }, log: (m) => logs.push(m) });
  const api = createApi({ repo, service, engines, vocabulary, dataDir, capabilities: { claude: true, gate: true, venice: true, ffmpeg: false }, log: (m) => logs.push(m) });
  return { repo, service, api, venice, gate, dataDir, logs };
}

async function greenShot(s: ReturnType<typeof setup>) {
  const p = s.api.createProject({ name: "Film", style_guide_de: "Gedeckte Farben." });
  const c = s.api.createCharacter(p.id, { name: "Mara", fixed_attributes_de: "rote Haare" });
  const png = readFileSync(pngFile(s.dataDir, "src.png"));
  const ref = s.api.addReference(p.id, new URLSearchParams({ name: "mara.png", kind: "image", role: "identity", character_id: String(c.id) }), png);
  const shot = s.api.createShot(p.id, { beat_de: "Mara hebt die Tasse.", workflow: "r2v_reference" });
  s.api.setShotReferences(shot.id, [{ reference_id: ref.id, slot: "Image 1", role: "identity", subject_label: "Mara" }]);
  await s.api.draft(shot.id);
  const gated = await s.api.gate(shot.id);
  return { p, c, ref, shot: s.repo.shot(shot.id)!, gated };
}

describe("director service through the api", () => {
  it("draft -> build -> gate: Claude fills the fields, the prompt is deterministic, Jev sees English only, costs are booked", async () => {
    const s = setup();
    const { p, shot, gated } = await greenShot(s);
    expect(s.repo.project(p.id)?.style_guide_en).toBe("Muted colours.");
    expect(shot.status).toBe("gated");
    expect(shot.prompt_final).toMatch(/^Refer to Mara in Image 1 to generate the shot\. Medium close-up\. Slow push-in\. Mara lifts the cup/);
    expect(gated.gate_run.evaluation.verdict).toBe("green");
    const state = s.gate.states[0]!;
    expect(JSON.stringify(state)).not.toMatch(/Gedeckte Farben|rote Haare/);
    expect((state["characters"] as { name: string }[]).map((c) => c.name)).toEqual(["Mara"]);
    const costs = Object.fromEntries(s.repo.costs().map((c) => [c.kind, c]));
    expect(costs["claude"]?.n).toBe(3); // 2 translations + draft
    expect(costs["jev"]?.n).toBe(1);
    expect(s.api.state().costs.length).toBe(2);
    // the same card builds the same prompt again
    expect(s.api.build(shot.id).result).toMatchObject({ ok: true, prompt: shot.prompt_final });
  });

  it("no quote without a green gate; a red gate names the reason", async () => {
    const s = setup({ gateAnswers: greenAnswers({ q3_camera_move: { type: "noul", noul: 0.1 } }) });
    const { shot, gated } = await greenShot(s);
    expect(gated.gate_run.evaluation.verdict).toBe("red");
    await expect(s.api.quote(shot.id, {})).rejects.toThrow(/not green/);
  });

  it("yellow: Claude corrects only the flagged fields and the card goes back to claude for another gate", async () => {
    const s = setup({ gateAnswers: greenAnswers({ q2_physical_action: { type: "noul", noul: 0.6 } }) });
    const { shot } = await greenShot(s);
    expect(s.repo.latestGate(shot.id)?.verdict).toBe("yellow");
    const fixed = await s.api.reviewFix(shot.id);
    expect(fixed.shot.camera_move).toBe("dolly in");
    expect(fixed.shot.shot_size).toBe("medium close-up");
    expect(fixed.shot.status).toBe("claude");
  });

  it("quote -> approve -> queue -> poll -> done -> review; nothing reaches /video/queue before the click", async () => {
    const s = setup();
    const { shot } = await greenShot(s);
    const q = await s.api.quote(shot.id, {});
    expect(q.result).toMatchObject({ ok: true, quoteUsd: 0.37 });
    expect(q.job.status).toBe("quoted");
    expect(q.job.quote_usd).toBe(0.37);
    const sent = JSON.parse(q.job.request_json) as Record<string, unknown>;
    expect(sent["prompt"]).toBe(shot.prompt_final);
    await expect(s.api.queue(q.job.id)).rejects.toThrow(/not approved/);
    expect(s.venice.calls.some((c) => c.path === "/video/queue")).toBe(false);
    const approved = s.api.approve(q.job.id);
    expect(approved.approved_at).not.toBeNull();
    expect(s.repo.shot(shot.id)?.status).toBe("approved");
    const queued = await s.api.queue(q.job.id);
    expect(queued).toMatchObject({ status: "queued", queue_id: "q-1" });
    expect(s.venice.calls.filter((c) => c.path === "/video/queue")).toHaveLength(1);
    expect(s.venice.calls.find((c) => c.path === "/video/queue")?.body?.["prompt"]).toBe(shot.prompt_final);
    // the UI polls once per click: two pending answers, then done
    expect((await s.api.poll(q.job.id)).job.status).toBe("queued");
    expect((await s.api.poll(q.job.id)).job.status).toBe("queued");
    const done = await s.api.poll(q.job.id);
    expect(done.job.status).toBe("done");
    expect(done.job.output_path && existsSync(done.job.output_path)).toBe(true);
    expect(done.job.download_url).toBe("https://cdn.test/clip.mp4");
    // ffmpeg is absent here: the review still opens, with no frames and no comparison
    expect(done.review?.id).toBeTruthy();
    expect(s.repo.shot(shot.id)?.status).toBe("review");
    const costs = Object.fromEntries(s.repo.costs().map((c) => [c.kind, c]));
    expect(costs["venice"]?.usd).toBeCloseTo(0.37);
    // a further poll on a finished job is a no-op
    expect((await s.api.poll(q.job.id)).job.status).toBe("done");
    expect(s.api.jobs()).toHaveLength(1);
  });

  it("409 needs_consent on the quote: the job waits for the consent, the repeat carries it", async () => {
    const s = setup({ consent: true });
    const { shot } = await greenShot(s);
    const first = await s.api.quote(shot.id, {});
    expect(first.result).toMatchObject({ ok: false, kind: "needs_consent" });
    expect(first.job.status).toBe("needs_consent");
    expect(() => s.api.approve(first.job.id)).toThrow(/no quote/);
    const second = await s.api.quote(shot.id, { consent: { type: "likeness", accepted: true } });
    expect(second.result).toMatchObject({ ok: true });
    expect((JSON.parse(second.job.request_json) as { consent: unknown }).consent).toEqual({ type: "likeness", accepted: true });
  });

  it("review fail sends the card back to draft with the note and adds the new rule for the next gate", async () => {
    const s = setup();
    const { p, shot } = await greenShot(s);
    const q = await s.api.quote(shot.id, {}); s.api.approve(q.job.id); await s.api.queue(q.job.id);
    let r = await s.api.poll(q.job.id); r = await s.api.poll(q.job.id); r = await s.api.poll(q.job.id);
    const review = s.api.review(r.review!.id);
    expect(review.checklist.map((c: { rule: string }) => c.rule)).toEqual(["R6", "R7", "R8"]);
    const out = s.api.verdict(review.id, { verdict: "fail", notes: "Narbe fehlt", checklist: [{ rule: "R7", pass: false }], new_rule: { text_de: "Narbe links sichtbar.", text_en: "Scar on the left brow visible.", severity: "block" } });
    expect(out.verdict).toBe("fail");
    expect(s.repo.shot(shot.id)).toMatchObject({ status: "draft", review_note: "Narbe fehlt" });
    const rule = s.repo.rules(p.id).find((x) => x.origin === `review:${shot.id}`);
    expect(rule?.text_en).toBe("Scar on the left brow visible.");
    expect(JSON.parse(s.repo.review(review.id)!.checklist_json).find((c: { rule: string }) => c.rule === "R7").pass).toBe(false);
    // the next gate state carries the new rule
    await s.api.gate(shot.id);
    expect((s.gate.states[1]!["rules"] as { id: string }[]).map((x) => x.id)).toContain(rule!.code);
  });

  it("uploads land under data/<project>/refs and only files under data/ are served", async () => {
    const s = setup();
    const p = s.api.createProject({ name: "F" });
    const ref = s.api.addReference(p.id, new URLSearchParams({ name: "x.png", kind: "image", role: "style" }), Buffer.from("png-bytes"));
    expect(ref.path.startsWith(join(s.dataDir, String(p.id), "refs"))).toBe(true);
    expect(s.api.filePath(ref.path)).toBe(ref.path);
    expect(() => s.api.filePath("/etc/passwd")).toThrow(HttpError);
    expect(() => s.api.filePath("../../etc/passwd")).toThrow(HttpError);
    expect(() => s.api.addReference(p.id, new URLSearchParams({ name: "x.png", kind: "gif", role: "style" }), Buffer.from("x"))).toThrow(/kind/);
  });
});
