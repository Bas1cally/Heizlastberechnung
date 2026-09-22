import { describe, expect, it } from "vitest";
import { ENDPOINTS, outputFileName, VeniceClient, type FetchLike } from "../../../src/director/venice.js";
import { pngFile, tmpDir } from "./helpers.js";

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };
function fakeFetch(handler: (c: Call) => { status: number; body: unknown }): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const c = { url, ...(init ? { init } : {}) }; calls.push(c);
    const r = handler(c);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { status: r.status, ok: r.status < 300, json: async () => JSON.parse(text), text: async () => text, headers: { get: () => null } };
  };
  return { fetch, calls };
}
const req = { model: "seedance-2-0-reference-to-video-basic", prompt: "Refer to Mara in Image 1 to generate the shot.", duration: "5s", aspect_ratio: "16:9", resolution: "480p" };

describe("venice client", () => {
  it("quote: posts the exact body with the bearer key, parses the USD, keeps the raw answer", async () => {
    const dir = tmpDir(); const png = pngFile(dir);
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { quote_usd: 0.37, currency: "USD" } }));
    const client = new VeniceClient({ apiKey: "k", fetch });
    const r = await client.quote({ ...req, reference_images: [{ slot: "Image 1", role: "identity", path: png }] });
    expect(r).toMatchObject({ ok: true, quoteUsd: 0.37 });
    expect(calls[0]?.url).toBe(`${ENDPOINTS.base}${ENDPOINTS.quote}`);
    expect(calls[0]?.init?.headers?.["Authorization"]).toBe("Bearer k");
    const body = JSON.parse(calls[0]!.init!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({ model: req.model, prompt: req.prompt, duration: "5s", aspect_ratio: "16:9", resolution: "480p" });
    expect((body["reference_image_urls"] as string[])[0]).toMatch(/^data:image\/png;base64,/);
    expect(body["consent"]).toBeUndefined();
  });

  it("quote without a recognisable USD field and non-2xx answers are failures, not consent", async () => {
    const a = new VeniceClient({ apiKey: "k", fetch: fakeFetch(() => ({ status: 200, body: { hello: 1 } })).fetch });
    expect(await a.quote(req)).toMatchObject({ ok: false });
    const b = new VeniceClient({ apiKey: "k", fetch: fakeFetch(() => ({ status: 401, body: { error: "bad key" } })).fetch });
    expect(await b.quote(req)).toMatchObject({ ok: false, status: 401 });
  });

  it("409 needs_consent comes back as a consent demand; repeating with the consent attaches it to the body", async () => {
    const consent = { type: "likeness", text: "I have the right to use this face." };
    const { fetch, calls } = fakeFetch((c) => (c.init?.body?.includes('"consent"') ? { status: 200, body: { queue_id: "q-1" } } : { status: 409, body: { error: "needs_consent", consent } }));
    const client = new VeniceClient({ apiKey: "k", fetch });
    const first = await client.queue(req);
    expect(first).toMatchObject({ ok: false, kind: "needs_consent", consent });
    const second = await client.queue(req, consent);
    expect(second).toMatchObject({ ok: true, queueId: "q-1" });
    expect(JSON.parse(calls[1]!.init!.body!)["consent"]).toEqual(consent);
  });

  it("retrieve maps status words and download urls; waitFor backs off 5 s -> 30 s and stops on done", async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (++n < 4 ? { status: 200, body: { status: "processing" } } : { status: 200, body: { status: "completed", download_url: "https://x/clip.mp4" } }));
    const sleeps: number[] = [];
    const client = new VeniceClient({ apiKey: "k", fetch, sleep: async (ms) => { sleeps.push(ms); } });
    const r = await client.waitFor("q-1");
    expect(r).toMatchObject({ state: "done", downloadUrl: "https://x/clip.mp4" });
    expect(sleeps).toEqual([5000, 7500, 11250]);
    expect(calls[0]?.url).toBe(`${ENDPOINTS.base}${ENDPOINTS.retrieve}?queue_id=q-1`);
    const f = new VeniceClient({ apiKey: "k", fetch: fakeFetch(() => ({ status: 200, body: { status: "failed", error: "nsfw" } })).fetch });
    expect(await f.retrieve("q")).toMatchObject({ state: "failed", error: "nsfw" });
  });

  it("waitFor caps the delay at 30 s and gives up at the deadline", async () => {
    const sleeps: number[] = [];
    let now = 0;
    const client = new VeniceClient({ apiKey: "k", fetch: fakeFetch(() => ({ status: 200, body: { status: "queued" } })).fetch, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
    const realNow = Date.now; Date.now = () => now;
    try { expect((await client.waitFor("q", { maxWaitMs: 120_000 })).state).toBe("failed"); } finally { Date.now = realNow; }
    expect(Math.max(...sleeps)).toBe(30_000);
  });

  it("names outputs by sequence and queue id", () => {
    expect(outputFileName(3, "abc-123")).toBe("shot-003-abc-123.mp4");
    expect(outputFileName(12, "../x")).not.toContain("..");
  });
});

describe("venice quote as observed live", () => {
  it('parses {"quote": 0.44} and asks /models for video models', async () => {
    const { fetch, calls } = fakeFetch((c) => (c.url.includes("/models") ? { status: 200, body: { data: [] } } : { status: 200, body: { quote: 0.44 } }));
    const client = new VeniceClient({ apiKey: "k", fetch });
    expect(await client.quote(req)).toMatchObject({ ok: true, quoteUsd: 0.44 });
    await client.listEngines();
    expect(calls[1]?.url).toContain("/models?type=video");
  });
});
