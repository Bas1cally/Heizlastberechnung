import { z } from "zod";

/**
 * TFT advisor (docs/TFT.md): what a screenshot says, what the meta says, what
 * to do next. Everything the models return is validated against these schemas.
 */
export const UnitSchema = z.object({ name: z.string(), stars: z.number().int().min(1).max(4).default(1), items: z.array(z.string()).default([]) });
export const BoardReadSchema = z.object({
  stage: z.string().describe("e.g. 3-2; empty if not visible"),
  gold: z.number().int().min(0).default(0),
  level: z.number().int().min(0).max(10).default(0),
  hp: z.number().int().min(0).max(100).default(0),
  shop: z.array(z.string()).default([]).describe("the five shop champions left to right; empty strings for sold slots"),
  board: z.array(UnitSchema).default([]),
  bench: z.array(UnitSchema).default([]),
  augments: z.array(z.string()).default([]),
  item_bench: z.array(z.string()).default([]),
  phase: z.enum(["planning", "combat", "carousel", "augment_choice", "loading", "not_tft", "unknown"]).default("unknown"),
  confidence: z.number().min(0).max(1).default(0.5).describe("how sure the reader is about the names it wrote"),
});
export type BoardRead = z.infer<typeof BoardReadSchema>;

export const CompSchema = z.object({
  name: z.string(),
  tier: z.string().describe("S, A, B, C or similar"),
  core_units: z.array(z.string()),
  carries: z.array(z.string()).default([]),
  key_items: z.array(z.string()).default([]),
  augments: z.array(z.string()).default([]),
  playstyle: z.string().default("").describe("one sentence: tempo, fast 8, reroll, when to level"),
  when_to_play: z.string().default("").describe("one sentence: what early units, items or augments signal this comp"),
});
export const MetaSchema = z.object({ set: z.string().default(""), patch: z.string().default(""), comps: z.array(CompSchema).min(1), sources: z.array(z.string()).default([]) });
export type Comp = z.infer<typeof CompSchema>;
export type Meta = z.infer<typeof MetaSchema>;

export const ACTIONS = { ROLL: "Spend gold rerolling the shop now for the units the target comp needs.", LEVEL: "Buy experience now to reach the next level before rolling.", SAVE: "Do not spend: keep the gold for interest and the next stage.", BUY: "Buy the marked shop units and stop; no rolling, no levelling this round." } as const;
export type Action = keyof typeof ACTIONS;

export interface Advice {
  readonly comp: string;
  readonly compKey: string;
  readonly action: Action;
  readonly buy: string[];
  readonly urgency: "low" | "medium" | "high";
  readonly onTrack: number;
  readonly confidence: number;
  readonly reasons: string[];
  readonly source: "jev" | "text";
  readonly model: string;
  readonly latencyMs: number;
}
