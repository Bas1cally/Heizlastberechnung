import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Character, Shot } from "./types.js";
import type { Vocabulary } from "./vocabulary.js";

/**
 * The three Claude calls of spec §6, each with a strict input contract and
 * NO history: no system prompt with project history, no earlier answers.
 * Structured output through the SDK's Zod helper; token counts returned so
 * the caller logs them (claude_call, cost_ledger).
 */
export const DraftSchema = z.object({
  shot_size: z.string(), camera_move: z.string(), lens_note: z.string(), lighting: z.string(), composition: z.string(),
  action_physical_en: z.string(), action_physical_de: z.string(),
  engine_recommendation: z.string(), duration_s_recommendation: z.number(),
  references_needed: z.array(z.object({ character: z.string(), role: z.enum(["identity", "keyframe", "style", "motion", "audio"]) })),
});
export type Draft = z.infer<typeof DraftSchema>;

export const ReviewFixSchema = z.object({
  shot_size: z.string().optional(), camera_move: z.string().optional(), lens_note: z.string().optional(), lighting: z.string().optional(), composition: z.string().optional(),
  action_physical_en: z.string().optional(), action_physical_de: z.string().optional(),
});
export type ReviewFix = z.infer<typeof ReviewFixSchema>;

export const TranslationSchema = z.object({ text_en: z.string() });

export interface ClaudeUsage { input_tokens: number; output_tokens: number; model: string }
export interface ClaudeResult<T> { value: T; usage: ClaudeUsage; request: unknown; response: unknown }

export interface DraftInput {
  readonly styleGuideEn: string;
  readonly characters: readonly Pick<Character, "name" | "fixed_attributes_en" | "variable_attributes">[];
  readonly previous: Pick<Shot, "seq" | "shot_size" | "camera_move" | "lighting" | "action_physical_en" | "transition_in"> | undefined;
  readonly beatDe: string;
  readonly engine: string;
  readonly workflow: string;
  readonly vocabulary: Vocabulary;
}

export interface ReviewFixInput extends DraftInput {
  readonly current: Pick<Shot, "shot_size" | "camera_move" | "lens_note" | "lighting" | "composition" | "action_physical_en" | "action_physical_de">;
  readonly gateFindings: readonly string[];
}

export const DRAFT_SYSTEM = "You fill in the fields of one shot card for an AI video production. Output only the requested JSON fields. Use the film vocabulary given, never synonyms. The action must be physical, happen completely within the frame, and show its cause before its effect. Do not comment on the card's correctness or on rules; do not include prose.";

export const TRANSLATE_SYSTEM = "Translate the German text to precise, literal English for a film production database. Keep names, numbers and technical terms. Output only the translation.";

/** The three text-model calls of spec §6, whoever serves them (Anthropic directly, or a text model on Venice). */
export interface TextCalls {
  readonly provider: "anthropic" | "venice";
  readonly model: string;
  draft(i: DraftInput): Promise<ClaudeResult<Draft>>;
  reviewFix(i: ReviewFixInput): Promise<ClaudeResult<ReviewFix>>;
  translate(textDe: string): Promise<ClaudeResult<string>>;
}

export class ClaudeCalls implements TextCalls {
  readonly provider = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;
  constructor(private readonly opts: { apiKey?: string | undefined; model: string; client?: Anthropic }) {
    this.model = opts.model;
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async draft(i: DraftInput): Promise<ClaudeResult<Draft>> {
    const request = {
      model: this.opts.model, max_tokens: 800, temperature: 0.2, system: DRAFT_SYSTEM,
      messages: [{ role: "user" as const, content: JSON.stringify({ style_guide_en: i.styleGuideEn, characters: i.characters, previous_shot: i.previous ?? null, beat_de: i.beatDe, engine: i.engine, workflow: i.workflow, vocabulary: i.vocabulary }) }],
      output_config: { format: zodOutputFormat(DraftSchema) },
    };
    const res = await this.client.messages.parse(request);
    if (!res.parsed_output) throw new Error(`draft: no parsable output (stop_reason ${res.stop_reason})`);
    return { value: res.parsed_output, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, model: res.model }, request, response: res.parsed_output };
  }

  async reviewFix(i: ReviewFixInput): Promise<ClaudeResult<ReviewFix>> {
    const request = {
      model: this.opts.model, max_tokens: 800, temperature: 0.2, system: `${DRAFT_SYSTEM} Return only the fields that must change to resolve the findings; leave the others out.`,
      messages: [{ role: "user" as const, content: JSON.stringify({ style_guide_en: i.styleGuideEn, characters: i.characters, previous_shot: i.previous ?? null, beat_de: i.beatDe, engine: i.engine, workflow: i.workflow, vocabulary: i.vocabulary, current_fields: i.current, gate_findings: i.gateFindings }) }],
      output_config: { format: zodOutputFormat(ReviewFixSchema) },
    };
    const res = await this.client.messages.parse(request);
    if (!res.parsed_output) throw new Error(`review_fix: no parsable output (stop_reason ${res.stop_reason})`);
    return { value: res.parsed_output, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, model: res.model }, request, response: res.parsed_output };
  }

  async translate(textDe: string): Promise<ClaudeResult<string>> {
    const request = {
      model: this.opts.model, max_tokens: 1200, temperature: 0, system: TRANSLATE_SYSTEM,
      messages: [{ role: "user" as const, content: textDe }],
      output_config: { format: zodOutputFormat(TranslationSchema) },
    };
    const res = await this.client.messages.parse(request);
    if (!res.parsed_output) throw new Error(`translate: no parsable output (stop_reason ${res.stop_reason})`);
    return { value: res.parsed_output.text_en, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, model: res.model }, request, response: res.parsed_output };
  }
}

/** USD for a call, from the price table the caller keeps (per million tokens). */
export const usdFor = (u: { input_tokens: number; output_tokens: number }, price: { inPerM: number; outPerM: number }) => (u.input_tokens * price.inPerM + u.output_tokens * price.outPerM) / 1_000_000;
