import type { Genome, Metrics } from "./bot.js";
import type { Series } from "./series.js";
export interface Gene { key: keyof Genome; label: string; min: number; max: number; int?: boolean; fmt: (v: number) => string }
export const GENES: readonly Gene[];
export function randomGenome(r: () => number): Genome;
export function crossover(a: Genome, b: Genome, r: () => number): Genome;
export function mutate(g: Genome, r: () => number, p?: number, scale?: number): { genome: Genome; changed: string[] };
export function fitness(m: Metrics): number;
export function passesGate(m: Metrics): boolean;
export interface Individual { id: number; genome: Genome; parents: number[]; changed: string[]; gen: number; train: Metrics; val: Metrics; fit: number; pass: boolean }
export interface EvolutionOptions { seed?: number; pop?: number; elite?: number; immigrants?: number; split?: number; warmup?: number }
export class Evolution {
  constructor(series: Series, options?: EvolutionOptions);
  s: Series; seed: number; r: () => number;
  trainFrom: number; split: number; valFrom: number; valTo: number;
  gen: number; tested: number; pop: Individual[]; leader: Individual | null;
  step(): unknown;
  byId(id: number): Individual | undefined;
}
