import { choice, type ChoiceQuestion } from "@typesafe-ai/sdk";

/**
 * Logical consistency across Polymarket's long tail. Two markets can be
 * related by their questions alone: "X by October" implies "X by December",
 * "BTC above 100k on the 31st" implies "BTC above 90k on the 31st", two
 * candidates for one seat exclude each other. Prices then have to obey an
 * order (P(A) <= P(B), P(A) + P(B) <= 1, P(A) = P(B)), and in thin markets
 * they often do not. Recognising the relation is a judgment over text, a
 * cheap one per pair, which is what Jev is for; checking the prices is
 * arithmetic; the payoff, where one exists, is a complete set of positions
 * that pays at least 1.00 whatever happens, not a forecast.
 */
export interface ScanMarket {
  readonly id: string;
  readonly slug: string;
  readonly question: string;
  readonly description: string;
  readonly eventSlug: string | null;
  readonly eventTitle: string | null;
  readonly endDate: string | null;
  readonly negRisk: boolean;
  readonly yesTokenId: string | null;
  readonly noTokenId: string | null;
  /** YES side, from the market's own numbers. */
  readonly yesPrice: number | null;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly liquidity: number;
  readonly volume24h: number;
  readonly feesEnabled: boolean | null;
}

export type Relation = "A_IMPLIES_B" | "B_IMPLIES_A" | "EQUIVALENT" | "EXCLUSIVE" | "UNRELATED" | "UNSURE";
export const RELATIONS: readonly Relation[] = ["A_IMPLIES_B", "B_IMPLIES_A", "EQUIVALENT", "EXCLUSIVE", "UNRELATED", "UNSURE"];

export const RELATION_QUESTION: ChoiceQuestion = choice(
  "Two prediction markets, A and B, each resolving YES or NO by its own rules. Decide the LOGICAL relation between the events 'A resolves YES' and 'B resolves YES', from the questions and rules alone, never from how likely either is. A_IMPLIES_B: whenever A resolves YES, B must resolve YES (a stricter condition implies a looser one: a higher threshold implies a lower one on the same date, an earlier deadline implies a later one for the same event, a specific outcome implies the category it belongs to). B_IMPLIES_A: the reverse. EQUIVALENT: they resolve the same way in every case. EXCLUSIVE: they cannot both resolve YES (two different winners of the same single seat, two different exact values of one quantity). UNRELATED: neither constrains the other, or the resolution sources or dates differ in a way that breaks the constraint. UNSURE: the texts leave it open. Be strict: a relation must hold under the resolution rules in every case, not merely usually.",
  {
    A_IMPLIES_B: "A YES forces B YES in every case.",
    B_IMPLIES_A: "B YES forces A YES in every case.",
    EQUIVALENT: "A and B always resolve the same way.",
    EXCLUSIVE: "A and B cannot both resolve YES.",
    UNRELATED: "No constraint between them.",
    UNSURE: "Cannot tell from the texts.",
  },
);

const STOP = new Set("the a an of in on at to by for and or is will be with from as this that than more less over under above below before after between into during until vs v yes no market who what when where which does do did has have had it its their there here about any all not".split(" "));

export function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9$%.]+/g, " ").split(" ").map((t) => t.replace(/^[.$]+|[.$]+$/g, "")).filter((t) => t.length >= 2 && !STOP.has(t));
}

export interface Candidate { readonly a: ScanMarket; readonly b: ScanMarket; readonly why: string; readonly shared: number }

/**
 * Deterministic candidate pairs, cheap enough for thousands of markets:
 * markets in one event (ladders of thresholds and dates live there), and
 * cross-event pairs sharing rare tokens (an entity, a quantity), best few
 * per market. Mutually exclusive outcomes of a negRisk event are the
 * exchange's own constraint and skipped.
 */
export function candidatePairs(markets: readonly ScanMarket[], opts: { perMarket?: number; maxEvent?: number; rareDf?: number } = {}): Candidate[] {
  const perMarket = opts.perMarket ?? 5, maxEvent = opts.maxEvent ?? 60, rareDf = opts.rareDf ?? Math.max(3, Math.floor(markets.length * 0.02));
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const key = (a: ScanMarket, b: ScanMarket) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
  const push = (a: ScanMarket, b: ScanMarket, why: string, shared: number) => {
    const k = key(a, b);
    if (a.id === b.id || seen.has(k)) return;
    if (a.eventSlug && a.eventSlug === b.eventSlug && (a.negRisk || b.negRisk)) return; // outcomes of one negRisk event: the exchange's own constraint
    seen.add(k); out.push({ a, b, why, shared });
  };
  // Same event.
  const byEvent = new Map<string, ScanMarket[]>();
  for (const m of markets) if (m.eventSlug) { const arr = byEvent.get(m.eventSlug) ?? []; arr.push(m); byEvent.set(m.eventSlug, arr); }
  for (const arr of byEvent.values()) {
    if (arr.length < 2 || arr.length > maxEvent || arr.some((m) => m.negRisk)) continue;
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) push(arr[i]!, arr[j]!, "same event", 0);
  }
  // Rare shared tokens across events.
  const df = new Map<string, number>();
  const toks = markets.map((m) => new Set(tokens(m.question)));
  for (const s of toks) for (const t of s) df.set(t, (df.get(t) ?? 0) + 1);
  const index = new Map<string, number[]>();
  toks.forEach((s, i) => { for (const t of s) if ((df.get(t) ?? 0) <= rareDf) { const arr = index.get(t) ?? []; arr.push(i); index.set(t, arr); } });
  toks.forEach((s, i) => {
    const score = new Map<number, number>();
    for (const t of s) for (const j of index.get(t) ?? []) if (j !== i) score.set(j, (score.get(j) ?? 0) + 1);
    [...score.entries()].filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1]).slice(0, perMarket).forEach(([j, n]) => push(markets[i]!, markets[j]!, "shared rare tokens", n));
  });
  return out;
}

export interface Violation {
  readonly relation: Relation;
  /** Constraint on YES probabilities, in words. */
  readonly constraint: string;
  /** How far the mid prices break the constraint, in price units; 0 when they obey it. */
  readonly midGap: number;
  /** What a taker could lock in per share right now, after crossing the spreads; <= 0 when nothing. */
  readonly executable: number;
  readonly trade: string;
}

const mid = (m: ScanMarket) => (m.bestBid !== null && m.bestAsk !== null ? (m.bestBid + m.bestAsk) / 2 : m.yesPrice);

/** The arithmetic. Every trade below is a set of positions that pays at least 1.00 in every outcome, so its edge is (1.00 - cost). */
export function checkPrices(relation: Relation, a: ScanMarket, b: ScanMarket): Violation | undefined {
  const pa = mid(a), pb = mid(b);
  if (pa === null || pb === null) return undefined;
  const bidA = a.bestBid ?? pa, askA = a.bestAsk ?? pa, bidB = b.bestBid ?? pb, askB = b.bestAsk ?? pb;
  const r = (x: number) => Number(x.toFixed(4));
  switch (relation) {
    case "A_IMPLIES_B":
      // P(A) <= P(B). Buy B YES and A NO: pays 1 (A true, B true), 2 (A false, B true), 1 (both false). Cost askB + (1 - bidA).
      return { relation, constraint: "P(A) <= P(B)", midGap: r(Math.max(0, pa - pb)), executable: r(bidA - askB), trade: `buy B YES at ${askB}, buy A NO at ${r(1 - bidA)}` };
    case "B_IMPLIES_A":
      return { relation, constraint: "P(B) <= P(A)", midGap: r(Math.max(0, pb - pa)), executable: r(bidB - askA), trade: `buy A YES at ${askA}, buy B NO at ${r(1 - bidB)}` };
    case "EQUIVALENT": {
      const ab = bidA - askB, ba = bidB - askA;
      return { relation, constraint: "P(A) = P(B)", midGap: r(Math.abs(pa - pb)), executable: r(Math.max(ab, ba)), trade: ab >= ba ? `buy B YES at ${askB}, buy A NO at ${r(1 - bidA)}` : `buy A YES at ${askA}, buy B NO at ${r(1 - bidB)}` };
    }
    case "EXCLUSIVE":
      // P(A) + P(B) <= 1. Buy NO on both: pays at least 1 (at most one can be YES). Cost (1 - bidA) + (1 - bidB).
      return { relation, constraint: "P(A) + P(B) <= 1", midGap: r(Math.max(0, pa + pb - 1)), executable: r(bidA + bidB - 1), trade: `buy A NO at ${r(1 - bidA)}, buy B NO at ${r(1 - bidB)}` };
    default:
      return undefined;
  }
}

export interface JudgedPair { readonly a: ScanMarket; readonly b: ScanMarket; readonly why: string; readonly relation: Relation; readonly confidence: number; readonly violation?: Violation | undefined }

export function renderReport(pairs: readonly JudgedPair[], meta: { markets: number; candidates: number; judged: number; generatedAt: string; feeNotes?: readonly string[] }): string {
  const rel = new Map<Relation, number>();
  for (const p of pairs) rel.set(p.relation, (rel.get(p.relation) ?? 0) + 1);
  const constrained = pairs.filter((p) => p.violation);
  const broken = constrained.filter((p) => p.violation!.midGap > 0.005).sort((x, y) => y.violation!.executable - x.violation!.executable);
  const executable = constrained.filter((p) => p.violation!.executable > 0.005).sort((x, y) => y.violation!.executable - x.violation!.executable);
  const lines: string[] = [];
  lines.push(`Consistency scan ${meta.generatedAt}`, `markets ${meta.markets}, candidate pairs ${meta.candidates}, judged ${meta.judged}`);
  lines.push(`relations: ${RELATIONS.map((r) => `${r} ${rel.get(r) ?? 0}`).join(", ")}`);
  lines.push(`constrained pairs ${constrained.length}, broken at mid (> 0.5 cent) ${broken.length}, executable after spreads (> 0.5 cent) ${executable.length}`);
  if (meta.feeNotes?.length) { lines.push("", "fees:"); for (const f of meta.feeNotes) lines.push(`  ${f}`); }
  const show = (title: string, xs: readonly JudgedPair[]) => {
    lines.push("", `${title}:`);
    if (!xs.length) lines.push("  none");
    for (const p of xs.slice(0, 40)) {
      const v = p.violation!;
      lines.push(`  ${v.executable >= 0 ? "+" : ""}${v.executable.toFixed(3)} exec | mid gap ${v.midGap.toFixed(3)} | ${p.relation} (${p.confidence.toFixed(2)}) | liq ${Math.round(p.a.liquidity)} / ${Math.round(p.b.liquidity)}`);
      lines.push(`      A: ${p.a.question}  [yes ${p.a.yesPrice ?? "?"}, bid ${p.a.bestBid ?? "?"}, ask ${p.a.bestAsk ?? "?"}]  ${p.a.slug}`);
      lines.push(`      B: ${p.b.question}  [yes ${p.b.yesPrice ?? "?"}, bid ${p.b.bestBid ?? "?"}, ask ${p.b.bestAsk ?? "?"}]  ${p.b.slug}`);
      lines.push(`      ${v.constraint}; ${v.trade}`);
    }
  };
  show("EXECUTABLE after spreads", executable);
  show("BROKEN at mid (top by executable)", broken.filter((p) => p.violation!.executable <= 0.005));
  return lines.join("\n") + "\n";
}
