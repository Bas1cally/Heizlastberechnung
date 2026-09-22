import { type Card, deckWithout, rankOf, suitOf } from "./cards.js";

/**
 * Seven-card hand evaluator and exact-enough equity by Monte Carlo. The
 * score orders hands: category * 16^5 + five kicker ranks. Categories:
 * 8 straight flush, 7 quads, 6 full house, 5 flush, 4 straight, 3 trips,
 * 2 two pair, 1 pair, 0 high card.
 */
export const CATEGORY = ["high card", "pair", "two pair", "trips", "straight", "flush", "full house", "quads", "straight flush"] as const;

/** Top card of the highest straight in a 13-bit rank mask, or -1. The wheel (A-5) has top 3. */
function straightTop(mask: number): number {
  const m = (mask << 1) | ((mask >> 12) & 1); // bit 0 = ace as low
  for (let top = 13; top >= 4; top--) if (((m >> (top - 4)) & 0x1f) === 0x1f) return top - 1;
  return -1;
}

const score = (cat: number, k: readonly number[]) => { let s = cat; for (let i = 0; i < 5; i++) s = s * 16 + (k[i] ?? 0); return s; };
const topBits = (mask: number, n: number, skip = -1): number[] => { const out: number[] = []; for (let r = 12; r >= 0 && out.length < n; r--) if ((mask >> r) & 1 && r !== skip) out.push(r); return out; };

export function evaluate(cards: readonly Card[]): number {
  const counts = new Array<number>(13).fill(0);
  const suitMask = [0, 0, 0, 0], suitCount = [0, 0, 0, 0];
  let all = 0;
  for (const c of cards) { const r = rankOf(c), s = suitOf(c); counts[r]!++; suitMask[s]! |= 1 << r; suitCount[s]!++; all |= 1 << r; }
  const fs = suitCount.findIndex((n) => n >= 5);
  if (fs >= 0) { const sf = straightTop(suitMask[fs]!); if (sf >= 0) return score(8, [sf]); }
  const byCount = (n: number) => { const out: number[] = []; for (let r = 12; r >= 0; r--) if (counts[r]! >= n) out.push(r); return out; };
  const quads = byCount(4);
  if (quads.length) return score(7, [quads[0]!, topBits(all, 1, quads[0]!)[0]!]);
  const trips = byCount(3);
  if (trips.length) { const pairRank = byCount(2).find((r) => r !== trips[0]); if (pairRank !== undefined) return score(6, [trips[0]!, pairRank]); }
  if (fs >= 0) return score(5, topBits(suitMask[fs]!, 5));
  const st = straightTop(all);
  if (st >= 0) return score(4, [st]);
  if (trips.length) { const k = topBits(all, 3, trips[0]!).slice(0, 2); return score(3, [trips[0]!, ...k]); }
  const pairs = byCount(2);
  if (pairs.length >= 2) { const [a, b] = pairs as [number, number]; const k = topBits(all & ~(1 << a) & ~(1 << b), 1); return score(2, [a, b, ...k]); }
  if (pairs.length === 1) return score(1, [pairs[0]!, ...topBits(all, 3, pairs[0]!)]);
  return score(0, topBits(all, 5));
}
export const categoryOf = (s: number) => CATEGORY[Math.floor(s / 16 ** 5)]!;

/**
 * Probability that `hand` wins at showdown against `opponents` random hands,
 * with the missing board cards dealt at random; a split pot counts as the
 * share won. Standard error is about 0.5 / sqrt(iterations).
 */
export function equity(hand: readonly Card[], board: readonly Card[], opts: { opponents?: number; iterations?: number; random?: () => number } = {}): number {
  const opp = opts.opponents ?? 1, n = opts.iterations ?? 20_000, rnd = opts.random ?? Math.random;
  const deck = deckWithout([...hand, ...board]);
  const need = 5 - board.length + 2 * opp;
  const mine = [...hand, ...board];
  let won = 0;
  const b = new Array<Card>(5), work = deck.slice();
  for (let it = 0; it < n; it++) {
    for (let i = 0; i < need; i++) { const j = i + Math.floor(rnd() * (work.length - i)); const t = work[i]!; work[i] = work[j]!; work[j] = t; }
    let k = 0;
    for (let i = 0; i < 5 - board.length; i++) b[i] = work[k++]!;
    const extra = b.slice(0, 5 - board.length);
    const me = evaluate([...mine, ...extra]);
    let best = me, tied = 1, beaten = false;
    for (let o = 0; o < opp; o++) {
      const v = evaluate([work[k++]!, work[k++]!, ...board, ...extra]);
      if (v > best) { beaten = true; break; }
      if (v === best) tied++;
    }
    if (!beaten) won += 1 / tied;
  }
  return won / n;
}

/** Calling is right when the win chance beats the price: bet / (pot + bet). */
export const breakEven = (pot: number, bet: number) => bet / (pot + bet);
/** EV of calling in chips, `pot` already holding the opponent's bet; showdown with no more betting. Folding is 0. */
export const callEv = (eq: number, pot: number, bet: number) => eq * pot - (1 - eq) * bet;
