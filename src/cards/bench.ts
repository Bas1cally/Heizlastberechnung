import { choice, noul } from "@typesafe-ai/sdk";
import { z } from "zod";
import { chatJson } from "../director/text-venice.js";
import type { FetchLike } from "../director/venice.js";
import { type Card, cardStr, deckWithout, pick } from "./cards.js";
import { basicStrategy, randomHand, type BjAction, type BjHand } from "./blackjack.js";
import { breakEven, callEv, equity } from "./poker.js";

/**
 * Card benchmarks with an exactly known right answer (docs/CARDS.md):
 *   blackjack - the action against the basic-strategy chart
 *   equity    - the win probability against a Monte Carlo of 20,000 deals
 *   call      - fold or call against the pot odds with the exact equity
 * The same situations go to Jev and, optionally, to a text model on Venice.
 */
export const RULES = "6 decks, dealer stands on soft 17, double down allowed on any first two cards and after a split, no surrender, blackjack pays 3:2";

export const QUESTIONS = {
  blackjack: { action: choice(`Which action gives this blackjack hand the highest expected return? Rules: ${RULES}. These are the player's first two cards.`, { HIT: "Take one more card.", STAND: "Take no more cards.", DOUBLE: "Double the bet and take exactly one more card.", SPLIT: "Split the pair into two separate hands (only possible when both cards have the same value)." }) },
  equity: { win: noul("This hand wins at showdown against ONE opponent holding two random unknown cards, after the missing board cards are dealt at random (a split pot counts as half a win).") },
  call: { action: choice("Heads-up, facing a bet. If you call, all remaining board cards are dealt with no further betting and the best hand wins the pot. Folding loses nothing more. Which action has the higher expected value?", { FOLD: "Give up the hand; lose nothing more.", CALL: "Pay the bet; win the whole pot if the hand is best at showdown." }) },
} as const;

// ---- situations ----
export interface BjItem { kind: "blackjack"; hand: BjHand; truth: BjAction; state: Record<string, unknown> }
export interface EqItem { kind: "equity"; hand: Card[]; board: Card[]; truth: number; state: Record<string, unknown> }
export interface CallItem { kind: "call"; hand: Card[]; board: Card[]; pot: number; bet: number; eq: number; truth: "FOLD" | "CALL"; state: Record<string, unknown> }
export type Item = BjItem | EqItem | CallItem;

const STREET = ["preflop", "flop", "turn", "river"] as const;
const boardSize = { preflop: 0, flop: 3, turn: 4, river: 5 } as const;

export function blackjackItems(n: number, r: () => number): BjItem[] {
  return Array.from({ length: n }, () => {
    const hand = randomHand(r);
    return { kind: "blackjack", hand, truth: basicStrategy(hand), state: { game: "blackjack", rules: RULES, player_cards: hand.cards, player_total: hand.total, soft_total: hand.kind === "soft", pair: hand.kind === "pair", dealer_upcard: hand.dealer } };
  });
}

function deal(r: () => number): { hand: Card[]; board: Card[]; street: (typeof STREET)[number] } {
  const street = pick(STREET, r);
  const deck = deckWithout([]);
  for (let i = 0; i < 7; i++) { const j = i + Math.floor(r() * (deck.length - i)); [deck[i], deck[j]] = [deck[j]!, deck[i]!]; }
  return { hand: deck.slice(0, 2), board: deck.slice(2, 2 + boardSize[street]), street };
}

export function equityItems(n: number, r: () => number, iterations = 20_000): EqItem[] {
  return Array.from({ length: n }, () => {
    const { hand, board, street } = deal(r);
    return { kind: "equity", hand, board, truth: equity(hand, board, { iterations, random: r }), state: { game: "texas holdem", hand: hand.map(cardStr), board: board.map(cardStr), street, opponents: 1 } };
  });
}

/**
 * The bet is sized so the break-even equity lands near the hand's real
 * equity (± about 12 points): random bet sizes made "always call" right 79 %
 * of the time, which measures nothing. break-even = f / (1 + 2f) for a bet
 * of f times the pot, so f = be / (1 - 2 be).
 */
export function callItems(n: number, r: () => number, iterations = 20_000): CallItem[] {
  const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  return Array.from({ length: n }, () => {
    // A heads-up hand above 50 % is always a call (break-even never exceeds 50 %); keep only a quarter of those.
    let d = deal(r), eq = equity(d.hand, d.board, { iterations: 2000, random: r });
    while (eq > 0.5 && r() > 0.25) { d = deal(r); eq = equity(d.hand, d.board, { iterations: 2000, random: r }); }
    const { hand, board, street } = d;
    eq = equity(hand, board, { iterations, random: r });
    const potBefore = 20 + Math.floor(r() * 180);
    const be = Math.min(0.45, Math.max(0.1, eq + 0.12 * gauss()));
    const bet = Math.max(1, Math.round(potBefore * (be / (1 - 2 * be))));
    const pot = potBefore + bet; // the pot already holds the opponent's bet
    return { kind: "call", hand, board, pot, bet, eq, truth: eq > breakEven(pot, bet) ? "CALL" : "FOLD", state: { game: "texas holdem", hand: hand.map(cardStr), board: board.map(cardStr), street, opponents: 1, pot_including_bet: pot, bet_to_call: bet } };
  });
}

// ---- askers ----
export interface Answer { value: string | number; ms: number; tokens: number; confidence?: number | undefined }
export interface Asker { readonly name: string; ask(item: Item): Promise<Answer> }

export interface JevClientLike { systemOne(req: { state: unknown; questions: unknown }, opts?: unknown): Promise<{ answers: unknown; model: string; usage: { input_tokens: number; output_tokens: number } }> }

export function jevAsker(client: JevClientLike, now: () => number = () => performance.now()): Asker {
  return {
    name: "jev",
    async ask(item) {
      const t0 = now();
      const r = await client.systemOne({ state: item.state, questions: QUESTIONS[item.kind] });
      const a = r.answers as Record<string, { choice?: string; confidence?: number; noul?: number }>;
      const tokens = r.usage.input_tokens + r.usage.output_tokens, ms = Math.round(now() - t0);
      if (item.kind === "equity") return { value: a["win"]!.noul!, ms, tokens };
      return { value: String(a["action"]!.choice), ms, tokens, confidence: a["action"]!.confidence };
    },
  };
}

const TEXT = {
  blackjack: z.object({ action: z.enum(["HIT", "STAND", "DOUBLE", "SPLIT"]) }),
  equity: z.object({ win_probability: z.number().min(0).max(1) }),
  call: z.object({ action: z.enum(["FOLD", "CALL"]) }),
};

export function textAsker(o: { apiKey: string; model: string; fetch?: FetchLike | undefined; reasoningEffort?: string | undefined }, now: () => number = () => performance.now()): Asker {
  return {
    name: `text:${o.model}`,
    async ask(item) {
      const t0 = now();
      const q = QUESTIONS[item.kind];
      const question = "action" in q ? `${q.action.instructions} Options: ${JSON.stringify(q.action.criteria)}` : q.win.instructions;
      const r = await chatJson({ apiKey: o.apiKey, model: o.model, purpose: `cards_${item.kind}`, system: "You answer one card-game question from the state given. Output only the JSON.", user: JSON.stringify({ state: item.state, question }), schema: TEXT[item.kind] as z.ZodType<Record<string, unknown>>, maxTokens: 3000, temperature: 0, reasoningEffort: o.reasoningEffort ?? "low", fetch: o.fetch, timeoutMs: 90_000 });
      const v = r.value as { action?: string; win_probability?: number };
      return { value: item.kind === "equity" ? v.win_probability! : v.action!, ms: Math.round(now() - t0), tokens: r.usage.input_tokens + r.usage.output_tokens };
    },
  };
}

// ---- running and scoring ----
export interface Result { item: Item; answer?: Answer; error?: string }

export async function run(items: readonly Item[], asker: Asker, opts: { concurrency?: number; onProgress?: (done: number, total: number) => void; stopOn?: (err: string) => boolean } = {}): Promise<Result[]> {
  const out: Result[] = new Array(items.length);
  let next = 0, done = 0, stopped = false;
  const worker = async () => {
    while (!stopped && next < items.length) {
      const i = next++;
      try { out[i] = { item: items[i]!, answer: await asker.ask(items[i]!) }; }
      catch (err) { const m = err instanceof Error ? err.message : String(err); out[i] = { item: items[i]!, error: m }; if (opts.stopOn?.(m)) stopped = true; }
      opts.onProgress?.(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
  return out.filter(Boolean);
}

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

export function scoreBlackjack(results: readonly Result[]) {
  const ok = results.filter((r) => r.answer && r.item.kind === "blackjack") as (Result & { item: BjItem; answer: Answer })[];
  const right = ok.filter((r) => r.answer.value === r.item.truth);
  const byKind: Record<string, { n: number; right: number }> = {};
  for (const r of ok) { const k = r.item.hand.kind; byKind[k] ??= { n: 0, right: 0 }; byKind[k].n++; if (r.answer.value === r.item.truth) byKind[k].right++; }
  const mistakes = new Map<string, number>();
  for (const r of ok) if (r.answer.value !== r.item.truth) { const k = `${r.item.hand.kind} ${r.item.hand.kind === "pair" ? r.item.hand.cards.join(",") : r.item.hand.total} vs ${r.item.hand.dealer}: ${r.answer.value} statt ${r.item.truth}`; mistakes.set(k, (mistakes.get(k) ?? 0) + 1); }
  return { n: ok.length, errors: results.length - ok.length, accuracy: ok.length ? right.length / ok.length : 0, byKind, mistakes: [...mistakes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10), msMedian: median(ok.map((r) => r.answer.ms)) };
}

export function scoreEquity(results: readonly Result[]) {
  const ok = results.filter((r) => r.answer && r.item.kind === "equity") as (Result & { item: EqItem; answer: Answer })[];
  const d = ok.map((r) => Number(r.answer.value) - r.item.truth);
  const buckets = [0, 0.2, 0.4, 0.6, 0.8, 1.0001].slice(0, -1).map((lo, i, arr) => { const hi = i === arr.length - 1 ? 1.0001 : arr[i + 1]!; const xs = ok.filter((r) => Number(r.answer.value) >= lo && Number(r.answer.value) < hi); return { range: `${lo.toFixed(1)}-${Math.min(1, hi).toFixed(1)}`, n: xs.length, said: xs.length ? xs.reduce((s, r) => s + Number(r.answer.value), 0) / xs.length : 0, truth: xs.length ? xs.reduce((s, r) => s + r.item.truth, 0) / xs.length : 0 }; });
  const mx = ok.length ? ok.reduce((s, r) => s + Number(r.answer.value), 0) / ok.length : 0, my = ok.length ? ok.reduce((s, r) => s + r.item.truth, 0) / ok.length : 0;
  const cov = ok.reduce((s, r) => s + (Number(r.answer.value) - mx) * (r.item.truth - my), 0), vx = ok.reduce((s, r) => s + (Number(r.answer.value) - mx) ** 2, 0), vy = ok.reduce((s, r) => s + (r.item.truth - my) ** 2, 0);
  const byStreet: Record<string, { n: number; mae: number }> = {};
  for (const r of ok) { const k = String(r.item.state["street"]); byStreet[k] ??= { n: 0, mae: 0 }; byStreet[k].n++; byStreet[k].mae += Math.abs(Number(r.answer.value) - r.item.truth); }
  for (const v of Object.values(byStreet)) v.mae /= v.n;
  return { n: ok.length, errors: results.length - ok.length, mae: d.length ? d.reduce((s, x) => s + Math.abs(x), 0) / d.length : 0, bias: d.length ? d.reduce((s, x) => s + x, 0) / d.length : 0, within5: d.length ? d.filter((x) => Math.abs(x) <= 0.05).length / d.length : 0, correlation: vx && vy ? cov / Math.sqrt(vx * vy) : 0, buckets, byStreet, msMedian: median(ok.map((r) => r.answer.ms)) };
}

export function scoreCall(results: readonly Result[]) {
  const ok = results.filter((r) => r.answer && r.item.kind === "call") as (Result & { item: CallItem; answer: Answer })[];
  const lost = (r: (typeof ok)[number]) => { const best = Math.max(0, callEv(r.item.eq, r.item.pot, r.item.bet)); const chosen = r.answer.value === "CALL" ? callEv(r.item.eq, r.item.pot, r.item.bet) : 0; return (best - chosen) / r.item.pot; };
  const alwaysCall = ok.filter((r) => r.item.truth === "CALL").length;
  return { n: ok.length, errors: results.length - ok.length, accuracy: ok.length ? ok.filter((r) => r.answer.value === r.item.truth).length / ok.length : 0, evLostPerHandPctPot: ok.length ? (100 * ok.reduce((s, r) => s + lost(r), 0)) / ok.length : 0, calledWhenFold: ok.filter((r) => r.answer.value === "CALL" && r.item.truth === "FOLD").length, foldedWhenCall: ok.filter((r) => r.answer.value === "FOLD" && r.item.truth === "CALL").length, baselineAlwaysCall: ok.length ? alwaysCall / ok.length : 0, msMedian: median(ok.map((r) => r.answer.ms)) };
}

const pct = (x: number) => `${(100 * x).toFixed(1)} %`;
export function render(test: Item["kind"], asker: string, results: readonly Result[]): string {
  const firstErr = results.find((r) => r.error)?.error;
  const L = [`== ${test} · ${asker} ==`];
  if (test === "blackjack") {
    const s = scoreBlackjack(results);
    L.push(`Übereinstimmung mit der Tabelle: ${pct(s.accuracy)} von ${s.n} Händen (Median ${s.msMedian} ms)`);
    L.push(`  ${Object.entries(s.byKind).map(([k, v]) => `${k} ${pct(v.right / v.n)} (${v.n})`).join(" · ")}`);
    for (const [m, n] of s.mistakes) L.push(`  Fehler ${n}×: ${m}`);
  } else if (test === "equity") {
    const s = scoreEquity(results);
    L.push(`Mittlerer Fehler: ${(100 * s.mae).toFixed(1)} Prozentpunkte · Verzerrung ${s.bias >= 0 ? "+" : ""}${(100 * s.bias).toFixed(1)} · innerhalb 5 Punkte: ${pct(s.within5)} · Korrelation ${s.correlation.toFixed(2)} · ${s.n} Hände (Median ${s.msMedian} ms)`);
    L.push(`  nach Straße: ${Object.entries(s.byStreet).map(([k, v]) => `${k} ${(100 * v.mae).toFixed(1)} (${v.n})`).join(" · ")}`);
    for (const b of s.buckets.filter((b) => b.n)) L.push(`  gesagt ${b.range}: Ø gesagt ${pct(b.said)}, Ø wahr ${pct(b.truth)} (${b.n})`);
  } else {
    const s = scoreCall(results);
    L.push(`Richtig entschieden: ${pct(s.accuracy)} von ${s.n} (immer callen wäre ${pct(s.baselineAlwaysCall)}) · Median ${s.msMedian} ms`);
    L.push(`  verlorener Erwartungswert: ${s.evLostPerHandPctPot.toFixed(2)} % des Pots pro Hand · gecallt statt gefoldet ${s.calledWhenFold} · gefoldet statt gecallt ${s.foldedWhenCall}`);
  }
  const errs = results.filter((r) => r.error).length;
  if (errs) L.push(`  ${errs} Fehler, z. B. ${String(firstErr).slice(0, 160)}`);
  return L.join("\n");
}
