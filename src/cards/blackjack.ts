import { pick } from "./cards.js";

/**
 * Basic strategy for 4-8 decks, dealer stands on soft 17, double on any
 * first two cards, double after split, no surrender. Standard published
 * chart. D = double else hit, Ds = double else stand; on the first two
 * cards both mean DOUBLE.
 */
export type BjAction = "HIT" | "STAND" | "DOUBLE" | "SPLIT";
export type BjKind = "hard" | "soft" | "pair";
export interface BjHand { kind: BjKind; cards: string[]; total: number; dealer: string }

const UP = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "A"] as const;
const upIdx = (u: string) => UP.indexOf((["J", "Q", "K", "T"].includes(u) ? "10" : u) as (typeof UP)[number]);
const val = (c: string) => (c === "A" ? 11 : ["10", "J", "Q", "K", "T"].includes(c) ? 10 : Number(c));

// rows: dealer 2..A
const HARD: Record<number, string> = { 8: "HHHHHHHHHH", 9: "HDDDDHHHHH", 10: "DDDDDDDDHH", 11: "DDDDDDDDDH", 12: "HHSSSHHHHH", 13: "SSSSSHHHHH", 14: "SSSSSHHHHH", 15: "SSSSSHHHHH", 16: "SSSSSHHHHH", 17: "SSSSSSSSSS" };
const SOFT: Record<number, string> = { 13: "HHHDDHHHHH", 14: "HHHDDHHHHH", 15: "HHDDDHHHHH", 16: "HHDDDHHHHH", 17: "HDDDDHHHHH", 18: "SDDDDSSHHH", 19: "SSSSSSSSSS", 20: "SSSSSSSSSS" };
const PAIR: Record<string, string> = { "2": "PPPPPPHHHH", "3": "PPPPPPHHHH", "4": "HHHPPHHHHH", "5": "DDDDDDDDHH", "6": "PPPPPHHHHH", "7": "PPPPPPHHHH", "8": "PPPPPPPPPP", "9": "PPPPPSPPSS", "10": "SSSSSSSSSS", "A": "PPPPPPPPPP" };
// soft 18 (A,7) vs 3-6 is "Ds" in the chart: double on two cards; written as D above.

const ACT: Record<string, BjAction> = { H: "HIT", S: "STAND", D: "DOUBLE", P: "SPLIT" };

export function basicStrategy(h: BjHand): BjAction {
  const i = upIdx(h.dealer);
  if (i < 0) throw new Error(`bad upcard ${h.dealer}`);
  if (h.kind === "pair") { const r = h.cards[0] === "A" ? "A" : String(val(h.cards[0]!)); return ACT[PAIR[r]![i]!]!; }
  if (h.kind === "soft") return ACT[SOFT[h.total]![i]!]!;
  const row = HARD[Math.min(17, Math.max(8, h.total))]!;
  return ACT[row[i]!]!;
}

/** A random first-two-card situation, uniform over the chart's cells. */
export function randomHand(r: () => number): BjHand {
  const tens = ["10", "J", "Q", "K"];
  const up = pick(UP, r); const dealer = up === "10" ? pick(tens, r) : up;
  const cell = Math.floor(r() * (15 + 8 + 10));
  if (cell < 15) {
    const total = 5 + cell; // 5..19 from two different non-ace values
    const opts: [number, number][] = [];
    for (let a = 2; a <= 10; a++) { const b = total - a; if (b > a && b <= 10) opts.push([a, b]); }
    const [a, b] = pick(opts, r);
    const name = (v: number) => (v === 10 ? pick(tens, r) : String(v));
    return { kind: "hard", cards: [name(a), name(b)], total, dealer };
  }
  if (cell < 23) { const x = cell - 15 + 2; return { kind: "soft", cards: ["A", x === 10 ? pick(tens, r) : String(x)], total: 11 + x, dealer }; }
  const p = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "A"][cell - 23]!;
  const c = p === "10" ? pick(tens, r) : p;
  return { kind: "pair", cards: [c, c], total: p === "A" ? 12 : 2 * val(p), dealer };
}
