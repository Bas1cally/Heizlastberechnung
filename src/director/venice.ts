import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DOCUMENTED_ENGINES, normalizeVeniceModel, type EngineSpec } from "./engines.js";
import type { VeniceVideoRequest } from "./prompt-builder.js";

/**
 * Venice REST (spec §7): quote -> approve (user click, never here) -> queue
 * -> poll retrieve -> download at once (the url is short-lived) -> optional
 * delete. A 409 needs_consent on faces returns the attestation without a
 * charge; the caller shows it, the user confirms, the request is repeated
 * with the consent object.
 *
 * Endpoint paths and field names live in ENDPOINTS so they can be corrected
 * from the live API without touching logic (the docs were unreachable when
 * this was written; `pnpm director:probe` records real responses).
 */
export const ENDPOINTS = {
  base: "https://api.venice.ai/api/v1",
  models: "/models",
  quote: "/video/quote",
  queue: "/video/queue",
  retrieve: "/video/retrieve",
  delete: "/video/delete",
} as const;

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string>; body?: unknown; headers: { get(name: string): string | null } }>;

export interface ConsentRequired { readonly ok: false; readonly kind: "needs_consent"; readonly consent: unknown; readonly raw: unknown }
export type QuoteResult = { ok: true; quoteUsd: number; raw: unknown } | { ok: false; error: unknown; status: number } | ConsentRequired;
export type QueueResult = { ok: true; queueId: string; raw: unknown } | { ok: false; error: unknown; status: number } | ConsentRequired;
export type RetrieveResult = { state: "pending"; raw: unknown } | { state: "done"; downloadUrl: string; raw: unknown } | { state: "failed"; error: unknown; raw: unknown };

export interface VeniceOptions {
  readonly apiKey: string;
  readonly fetch?: FetchLike;
  readonly base?: string;
  /** How a local reference file is put on the wire: a public URL from a host the user runs, or base64 (the default). */
  readonly referenceUrl?: (path: string) => string;
  readonly sleep?: (ms: number) => Promise<void>;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".wav": "audio/wav", ".mp3": "audio/mpeg" };

export class VeniceClient {
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  constructor(private readonly o: VeniceOptions) {
    this.fetchImpl = o.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
    this.base = o.base ?? ENDPOINTS.base;
  }

  private headers(): Record<string, string> { return { Authorization: `Bearer ${this.o.apiKey}`, "Content-Type": "application/json" }; }

  /** GET /models, normalised into engine specs; the documented Seedance ids are always present. */
  async listEngines(): Promise<{ engines: EngineSpec[]; raw: unknown }> {
    const r = await this.fetchImpl(`${this.base}${ENDPOINTS.models}`, { headers: this.headers() });
    const raw = await r.json();
    const items = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown })?.data) ? (raw as { data: unknown[] }).data : Array.isArray((raw as { models?: unknown })?.models) ? (raw as { models: unknown[] }).models : [];
    const engines = new Map<string, EngineSpec>(DOCUMENTED_ENGINES.map((e) => [e.id, e]));
    for (const it of items) { const spec = normalizeVeniceModel(it as Record<string, unknown>); if (spec) engines.set(spec.id, spec); }
    return { engines: [...engines.values()], raw };
  }

  /** The request body exactly as sent: references resolved to URLs or base64 data, consent attached when given. */
  wireBody(req: VeniceVideoRequest, consent?: unknown): Record<string, unknown> {
    const toUrl = (p: string) => this.o.referenceUrl ? this.o.referenceUrl(p) : `data:${MIME[extname(p).toLowerCase()] ?? "application/octet-stream"};base64,${readFileSync(p).toString("base64")}`;
    const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, duration: req.duration, aspect_ratio: req.aspect_ratio, resolution: req.resolution };
    if (req.negative_prompt) body["negative_prompt"] = req.negative_prompt;
    if (req.seed !== undefined) body["seed"] = req.seed;
    if (req.reference_images?.length) body["reference_image_urls"] = req.reference_images.map((r) => toUrl(r.path));
    if (req.reference_videos?.length) { body["reference_video_urls"] = req.reference_videos.map((r) => toUrl(r.path)); body["reference_video_total_duration"] = req.reference_video_total_duration ?? 0; }
    if (req.reference_audio?.length) body["reference_audio_urls"] = req.reference_audio.map((r) => toUrl(r.path));
    if (consent) body["consent"] = consent;
    return body;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    const r = await this.fetchImpl(`${this.base}${path}`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    const text = await r.text();
    let json: unknown; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { status: r.status, json };
  }

  private consentOf(status: number, json: unknown): ConsentRequired | undefined {
    const j = json as { error?: unknown; code?: unknown; consent?: unknown; detail?: unknown };
    const marker = JSON.stringify(json ?? "").includes("needs_consent");
    if (status === 409 && (marker || j.consent)) return { ok: false, kind: "needs_consent", consent: j.consent ?? (j.detail as { consent?: unknown })?.consent ?? json, raw: json };
    return undefined;
  }

  async quote(req: VeniceVideoRequest, consent?: unknown): Promise<QuoteResult> {
    const { status, json } = await this.post(ENDPOINTS.quote, this.wireBody(req, consent));
    const c = this.consentOf(status, json); if (c) return c;
    if (status < 200 || status >= 300) return { ok: false, error: json, status };
    const j = json as Record<string, unknown>;
    const usd = Number(j["quote_usd"] ?? j["price_usd"] ?? j["usd"] ?? j["cost"] ?? (j["quote"] as Record<string, unknown> | undefined)?.["usd"] ?? Number.NaN);
    if (!Number.isFinite(usd)) return { ok: false, error: { message: "quote without a recognisable USD field", body: json }, status };
    return { ok: true, quoteUsd: usd, raw: json };
  }

  async queue(req: VeniceVideoRequest, consent?: unknown): Promise<QueueResult> {
    const { status, json } = await this.post(ENDPOINTS.queue, this.wireBody(req, consent));
    const c = this.consentOf(status, json); if (c) return c;
    if (status < 200 || status >= 300) return { ok: false, error: json, status };
    const j = json as Record<string, unknown>;
    const id = String(j["queue_id"] ?? j["id"] ?? j["job_id"] ?? "");
    if (!id) return { ok: false, error: { message: "queue response without an id", body: json }, status };
    return { ok: true, queueId: id, raw: json };
  }

  async retrieve(queueId: string): Promise<RetrieveResult> {
    const r = await this.fetchImpl(`${this.base}${ENDPOINTS.retrieve}?queue_id=${encodeURIComponent(queueId)}`, { headers: this.headers() });
    const text = await r.text();
    let json: unknown; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (r.status < 200 || r.status >= 300) return { state: "failed", error: json, raw: json };
    const j = json as Record<string, unknown>;
    const state = String(j["status"] ?? j["state"] ?? "").toLowerCase();
    const url = j["download_url"] ?? j["url"] ?? (j["output"] as Record<string, unknown> | undefined)?.["url"];
    if (typeof url === "string" && url) return { state: "done", downloadUrl: url, raw: json };
    if (/fail|error|cancel/.test(state)) return { state: "failed", error: j["error"] ?? json, raw: json };
    return { state: "pending", raw: json };
  }

  /** Poll with backoff 5 s -> 30 s until done or failed (spec §7). */
  async waitFor(queueId: string, opts: { maxWaitMs?: number; onPoll?: (r: RetrieveResult, n: number) => void } = {}): Promise<RetrieveResult> {
    const sleep = this.o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (opts.maxWaitMs ?? 30 * 60_000);
    let delay = 5_000, n = 0;
    for (;;) {
      const r = await this.retrieve(queueId);
      opts.onPoll?.(r, ++n);
      if (r.state !== "pending") return r;
      if (Date.now() >= deadline) return { state: "failed", error: { message: "timed out waiting for the job" }, raw: r.raw };
      await sleep(delay);
      delay = Math.min(30_000, Math.round(delay * 1.5));
    }
  }

  /** Download at once, with retries; the url is short-lived. */
  async download(url: string, outDir: string, fileName: string, retries = 3): Promise<string> {
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, fileName);
    let lastErr: unknown;
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await this.fetchImpl(url);
        if (!r.ok) throw new Error(`download ${r.status}`);
        const body = r.body as unknown;
        if (body && typeof (body as { getReader?: unknown }).getReader === "function") await pipeline(Readable.fromWeb(body as never), createWriteStream(out));
        else if (body && typeof (body as { pipe?: unknown }).pipe === "function") await pipeline(body as NodeJS.ReadableStream, createWriteStream(out));
        else { const text = await r.text(); await pipeline(Readable.from([text]), createWriteStream(out)); }
        if (existsSync(out)) return out;
      } catch (err) { lastErr = err; await (this.o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(1_000 * (i + 1)); }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async delete(queueId: string): Promise<boolean> {
    try { const r = await this.fetchImpl(`${this.base}${ENDPOINTS.delete}?queue_id=${encodeURIComponent(queueId)}`, { method: "DELETE", headers: this.headers() }); return r.ok; } catch { return false; }
  }
}

export const outputFileName = (shotSeq: number, queueId: string, ext = ".mp4") => `shot-${String(shotSeq).padStart(3, "0")}-${basename(queueId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}${ext}`;
