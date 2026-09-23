import type { Series } from "./series.js";
export interface Genome { family: number; lookback: number; entryZ: number; levels: number; spacing: number; mult: number; tp: number; stop: number }
export interface Metrics { ret: number; maxDD: number; trades: number; winRate: number; payoff: number; exposure: number }
export interface Level { name: string; price: number; usd: number; filled: boolean; t: number; fillPrice?: number }
export interface Trade { pnl: number; ret: number; bars: number; exit: string; i: number }
export type BotEvent =
  | { type: "BUY"; i: number; level: string; price: number; usd: number }
  | { type: "TP" | "STOP" | "EOD"; i: number; price: number; pnl: number };
export const FAMILIES: readonly string[];
export const FEE: number;
export function signal(g: Genome, s: Series, j: number): { ok: boolean; z: number; need?: string };
export class GridBot {
  constructor(genome: Genome, equity?: number);
  g: Genome; cash: number; start: number; qty: number; cost: number;
  levels: Level[]; tp: number; stop: number; trades: Trade[]; openedAt: number;
  peak: number; maxDD: number; bars: number; exposed: number;
  get inPos(): boolean;
  get avg(): number;
  equity(price: number): number;
  step(s: Series, i: number): BotEvent[];
  _open(price: number, i: number, ev: BotEvent[]): void;
  _fill(L: Level, price: number, i: number, ev: BotEvent[]): void;
  _close(price: number, i: number, why: "TP" | "STOP" | "EOD", ev: BotEvent[]): void;
  flatten(s: Series, i: number): void;
  metrics(): Metrics;
}
export function backtest(genome: Genome, s: Series, from: number, to: number): Metrics;
