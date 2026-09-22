import { z } from "zod";
import { DraftSchema, ReviewFixSchema, TranslationSchema, DRAFT_SYSTEM, TRANSLATE_SYSTEM, type ClaudeResult, type Draft, type DraftInput, type ReviewFix, type ReviewFixInput, type TextCalls } from "./claude.js";
import { ENDPOINTS, type FetchLike } from "./venice.js";

/**
 * The same three calls as ClaudeCalls, served by a text model on Venice
 * (OpenAI-compatible chat completions with a JSON schema response format,
 * `supportsResponseSchema` in Venice's model list). Same contracts: one
 * user message built from card fields, no history, strict JSON out. Billed
 * on the Venice account, so the ledger books it as "venice".
 */
export interface VeniceTextOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly fetch?: FetchLike;
  readonly base?: string;
  /** Sent as `reasoning_effort` when set; a 400 retries once without it (not every model takes the field). */
  readonly reasoningEffort?: string | undefined;
}

/** OpenAI-style response_format. No `strict`: review_fix has optional fields, and the answer is validated with zod anyway. */
export const toSchema = (name: string, schema: z.ZodType) => { const { $schema: _drop, ...json } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>; void _drop; return { type: "json_schema", json_schema: { name, schema: json } }; };

export type ChatContent = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
export interface ChatJsonOptions<T> {
  readonly apiKey: string; readonly model: string; readonly purpose: string;
  readonly system: string; readonly user: ChatContent; readonly schema: z.ZodType<T>;
  readonly maxTokens: number; readonly temperature?: number;
  /** Sent as `reasoning_effort`; dropped once on a 400. */
  readonly reasoningEffort?: string | undefined;
  /** Extra top-level fields (e.g. venice_parameters); dropped together with reasoning_effort on a 400. */
  readonly extra?: Record<string, unknown> | undefined;
  readonly fetch?: FetchLike | undefined; readonly base?: string | undefined;
}

/**
 * One chat completion on Venice with a JSON-schema answer, validated with zod. Shared by the
 * director's text calls and the TFT advisor. Returns tokens from `usage` so the caller can book them.
 */
export async function chatJson<T>(o: ChatJsonOptions<T>): Promise<ClaudeResult<T>> {
  const fetchImpl = o.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
  const base = o.base ?? ENDPOINTS.base;
  const body: Record<string, unknown> = { model: o.model, messages: [{ role: "system", content: o.system }, { role: "user", content: o.user }], max_completion_tokens: o.maxTokens, temperature: o.temperature ?? 0.2, response_format: toSchema(o.purpose, o.schema), ...(o.extra ?? {}) };
  if (o.reasoningEffort) body["reasoning_effort"] = o.reasoningEffort;
  const post = async (b: Record<string, unknown>) => {
    const r = await fetchImpl(`${base}${ENDPOINTS.chat}`, { method: "POST", headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const text = await r.text();
    let json: unknown; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { status: r.status, json };
  };
  let r = await post(body);
  if (r.status === 400 && (body["reasoning_effort"] || o.extra)) { delete body["reasoning_effort"]; for (const k of Object.keys(o.extra ?? {})) delete body[k]; r = await post(body); }
  if (r.status < 200 || r.status >= 300) throw new Error(`${o.purpose}: Venice ${r.status}: ${JSON.stringify(r.json).slice(0, 400)}`);
  const j = r.json as { choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
  const choice = j.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? "").join("") : "";
  let parsed: unknown;
  try { parsed = JSON.parse(stripFences(text)); } catch { throw new Error(`${o.purpose}: no parsable JSON (finish_reason ${choice?.finish_reason ?? "?"}): ${text.slice(0, 200)}`); }
  const value = o.schema.safeParse(parsed);
  if (!value.success) throw new Error(`${o.purpose}: answer does not match the schema: ${value.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const usage = { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0, model: j.model ?? o.model };
  return { value: value.data, usage, request: body, response: value.data };
}


export class VeniceTextCalls implements TextCalls {
  readonly provider = "venice" as const;
  readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  constructor(private readonly o: VeniceTextOptions) {
    this.model = o.model;
    this.fetchImpl = o.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
    this.base = o.base ?? ENDPOINTS.base;
  }

  private complete<T>(purpose: string, system: string, user: string, schema: z.ZodType<T>, maxTokens: number, temperature: number): Promise<ClaudeResult<T>> {
    return chatJson({ apiKey: this.o.apiKey, model: this.model, purpose, system, user, schema, maxTokens, temperature, reasoningEffort: this.o.reasoningEffort, fetch: this.fetchImpl, base: this.base });
  }

  draft(i: DraftInput): Promise<ClaudeResult<Draft>> {
    return this.complete("draft", DRAFT_SYSTEM, JSON.stringify({ style_guide_en: i.styleGuideEn, characters: i.characters, previous_shot: i.previous ?? null, beat_de: i.beatDe, engine: i.engine, workflow: i.workflow, vocabulary: i.vocabulary }), DraftSchema, 800, 0.2);
  }
  reviewFix(i: ReviewFixInput): Promise<ClaudeResult<ReviewFix>> {
    return this.complete("review_fix", `${DRAFT_SYSTEM} Return only the fields that must change to resolve the findings; leave the others out.`, JSON.stringify({ style_guide_en: i.styleGuideEn, characters: i.characters, previous_shot: i.previous ?? null, beat_de: i.beatDe, engine: i.engine, workflow: i.workflow, vocabulary: i.vocabulary, current_fields: i.current, gate_findings: i.gateFindings }), ReviewFixSchema, 800, 0.2);
  }
  async translate(textDe: string): Promise<ClaudeResult<string>> {
    const r = await this.complete("translate", TRANSLATE_SYSTEM, textDe, TranslationSchema, 1200, 0);
    return { ...r, value: r.value.text_en };
  }
}

const stripFences = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

/** USD per million tokens of one text model, from Venice's model list (`model_spec.pricing.input/output.usd`). */
export async function veniceTextPricing(apiKey: string, model: string, fetchImpl: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>, base = ENDPOINTS.base): Promise<{ inPerM: number; outPerM: number } | undefined> {
  const r = await fetchImpl(`${base}${ENDPOINTS.models}?type=text`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const j = (await r.json()) as { data?: { id?: string; model_spec?: { pricing?: { input?: { usd?: number }; output?: { usd?: number } } } }[] };
  const m = j.data?.find((x) => x.id === model);
  const inPerM = m?.model_spec?.pricing?.input?.usd, outPerM = m?.model_spec?.pricing?.output?.usd;
  return typeof inPerM === "number" && typeof outPerM === "number" ? { inPerM, outPerM } : undefined;
}
