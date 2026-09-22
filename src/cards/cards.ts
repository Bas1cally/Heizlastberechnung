/**
 * Cards as numbers 0..51: rank = c >> 2 (0 = deuce .. 12 = ace), suit = c & 3.
 * Seeded randomness so a benchmark can be re-run on the same situations.
 */
export const RANKS = "23456789TJQKA";
export const SUITS = "cdhs";
export type Card = number;

export const rankOf = (c: Card) => c >> 2;
export const suitOf = (c: Card) => c & 3;
export const cardStr = (c: Card) => `${RANKS[rankOf(c)]}${SUITS[suitOf(c)]}`;
export function parseCard(s: string): Card {
  const r = RANKS.indexOf(s[0]!.toUpperCase()), u = SUITS.indexOf(s[1]!.toLowerCase());
  if (r < 0 || u < 0 || s.length !== 2) throw new Error(`bad card '${s}'`);
  return (r << 2) | u;
}
export const parseCards = (s: string) => s.trim() ? s.trim().split(/\s+/).map(parseCard) : [];

/** mulberry32: small, fast, good enough for sampling test situations. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const pick = <T>(xs: readonly T[], r: () => number): T => xs[Math.floor(r() * xs.length)]!;

export function deckWithout(known: readonly Card[]): Card[] {
  const used = new Set(known);
  const d: Card[] = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) d.push(c);
  return d;
}
