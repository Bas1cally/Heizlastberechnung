// Walk-forward test of the SETS engine: evolve and gate on the past, then trade the next
// month the evolution never saw. Slide one month and repeat. Nothing of SETS is changed;
// the only additions are the untouched test window, baselines, and a cautious fill variant.
import { backtest, GridBot, FAMILIES, signal, type BotEvent, type Genome, type Metrics } from "../../vendor/sets/bot.js";
import { Evolution, passesGate, randomGenome } from "../../vendor/sets/evolution.js";
import { mulberry32 } from "../../vendor/sets/rng.js";
import { makeSeries, type Candle, type Series } from "../../vendor/sets/series.js";

/**
 * SETS books a grid fill and the take-profit in the same hourly bar, which assumes the
 * low came before the high. This variant does not let a bar that added grid fills also
 * take profit in that bar. Everything else is SETS' own GridBot.
 */
export class CautiousBot extends GridBot {
  // GridBot.step line for line, except for the one condition marked below.
  override step(s: Series, i: number): BotEvent[] {
    const ev: BotEvent[] = [], g = this.g;
    if (!this.inPos && i > 0) {
      const sig = signal(g, s, i - 1);
      if (sig.ok) this._open(s.open[i]!, i, ev);
    }
    if (this.inPos) {
      // The entry fill at the open does not count: everything after the open may still reach the target.
      const filledBefore = this.levels.filter((L) => L.filled).length;
      for (const L of this.levels) if (!L.filled && s.low[i]! <= L.price) this._fill(L, L.price, i, ev);
      const added = this.levels.filter((L) => L.filled).length - filledBefore;
      this.tp = this.avg * (1 + g.tp);
      if (s.low[i]! <= this.stop) this._close(this.stop, i, "STOP", ev);
      else if (added === 0 && s.high[i]! >= this.tp) this._close(this.tp, i, "TP", ev); // the change
    }
    const eq = this.equity(s.close[i]!);
    this.peak = Math.max(this.peak, eq);
    this.maxDD = Math.max(this.maxDD, 1 - eq / this.peak);
    this.bars++; if (this.inPos) this.exposed++;
    return ev;
  }
}

export function cautiousBacktest(genome: Genome, s: Series, from: number, to: number): Metrics {
  const bot = new CautiousBot(genome);
  for (let i = from; i < to; i++) bot.step(s, i);
  bot.flatten(s, to - 1);
  return bot.metrics();
}

export interface WalkOptions { warm: number; train: number; gate: number; test: number; stepH: number; seeds: number[]; generations: number; randoms: number }
export const WALK_DEFAULTS: WalkOptions = { warm: 200, train: 1440, gate: 720, test: 720, stepH: 720, seeds: [1, 2, 3], generations: 50, randoms: 300 };

export interface WindowResult {
  testFrom: number; // unix seconds of the first test hour
  bh: number; bhDD: number;
  /** Mean over seeds; a seed without a leader stays flat (0), as SETS would. */
  sets: number; setsCautious: number; setsDD: number; exposure: number; leaders: number;
  random: number | null; families: string[];
}

export function bhStats(s: Series, from: number, to: number): { ret: number; dd: number } {
  // Measured on hourly closes, the same way SETS measures its own drawdown.
  let pk = s.open[from]!, dd = 0;
  for (let i = from; i < to; i++) { pk = Math.max(pk, s.close[i]!); dd = Math.max(dd, 1 - s.close[i]! / pk); }
  return { ret: s.close[to - 1]! / s.open[from]! - 1, dd };
}

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

export function walkForward(candles: readonly Candle[], o: WalkOptions = WALK_DEFAULTS, progress?: (done: number, total: number) => void): WindowResult[] {
  const S = makeSeries(candles), span = o.warm + o.train + o.gate;
  const starts: number[] = [];
  for (let s = 0; s + span + o.test <= candles.length; s += o.stepH) starts.push(s);
  const out: WindowResult[] = [];
  for (const [k, start] of starts.entries()) {
    const S1 = makeSeries(candles.slice(start, start + span));
    const testFrom = start + span, testTo = testFrom + o.test;
    const b = bhStats(S, testFrom, testTo);
    const rets: number[] = [], cautious: number[] = [], dds: number[] = [], exps: number[] = [], families: string[] = [];
    let leaders = 0, valFrom = 0, valTo = 0;
    for (const seed of o.seeds) {
      const e = new Evolution(S1, { seed, warmup: o.warm, split: (o.warm + o.train) / span });
      for (let g = 0; g < o.generations; g++) e.step();
      valFrom = e.valFrom; valTo = e.valTo;
      if (!e.leader) { rets.push(0); cautious.push(0); dds.push(0); exps.push(0); continue; }
      leaders++;
      const t = backtest(e.leader.genome, S, testFrom, testTo);
      rets.push(t.ret); dds.push(t.maxDD); exps.push(t.exposure);
      cautious.push(cautiousBacktest(e.leader.genome, S, testFrom, testTo).ret);
      families.push(FAMILIES[e.leader.genome.family] ?? "?");
    }
    // Baseline: random configs that pass the same gate, then trade the same test month.
    const r = mulberry32(1000 + k), rnd: number[] = [];
    for (let i = 0; i < o.randoms; i++) {
      const g = randomGenome(r);
      if (passesGate(backtest(g, S1, valFrom, valTo))) rnd.push(backtest(g, S, testFrom, testTo).ret);
    }
    out.push({ testFrom: candles[testFrom]![0], bh: b.ret, bhDD: b.dd, sets: mean(rets), setsCautious: mean(cautious), setsDD: mean(dds), exposure: mean(exps), leaders, random: rnd.length ? mean(rnd) : null, families });
    progress?.(k + 1, starts.length);
  }
  return out;
}

const pct = (x: number, d = 1): string => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)} %`;
const compound = (xs: number[]): number => xs.reduce((a, x) => a * (1 + x), 1) - 1;
const median = (xs: number[]): number => { const b = [...xs].sort((x, y) => x - y); return b.length ? b[b.length >> 1]! : 0; };
const month = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

export function renderWalk(w: WindowResult[], o: WalkOptions = WALK_DEFAULTS): string {
  const L: string[] = [];
  L.push(`SETS Walk-Forward: ${w.length} Testmonate, je ${o.train / 24} Tage Lernen, ${o.gate / 24} Tage Gate, dann ${o.test / 24} Tage ungesehen handeln.`);
  L.push(`${o.seeds.length} Seeds je Monat, ${o.generations} Generationen. Ohne Sieger bleibt SETS flach (0 %).`);
  L.push("");
  L.push("Start       BTC halten      SETS   vorsichtig   Zufall  investiert  Arten");
  for (const x of w) {
    L.push(`${month(x.testFrom)}  ${pct(x.bh).padStart(9)}  ${pct(x.sets).padStart(9)}  ${pct(x.setsCautious).padStart(9)}  ${(x.random === null ? "–" : pct(x.random)).padStart(9)}  ${`${Math.round(x.exposure * 100)} %`.padStart(8)}   ${x.families.join(", ") || "kein Sieger"}`);
  }
  const bh = w.map((x) => x.bh), sets = w.map((x) => x.sets), cau = w.map((x) => x.setsCautious);
  const exposureMatched = w.map((x) => x.exposure * x.bh);
  const up = w.filter((x) => x.bh > 0), down = w.filter((x) => x.bh <= 0);
  L.push("");
  L.push("== Ergebnis ==");
  L.push(`Alle Monate hintereinander:  BTC halten ${pct(compound(bh))} · SETS ${pct(compound(sets))} · SETS vorsichtig ${pct(compound(cau))}`);
  L.push(`Median je Monat:             BTC halten ${pct(median(bh))} · SETS ${pct(median(sets))} · vorsichtig ${pct(median(cau))}`);
  L.push(`SETS besser als BTC halten:  ${w.filter((x) => x.sets > x.bh).length} von ${w.length} Monaten`);
  L.push(`SETS besser als gleich viel BTC gehalten (Investitionsgrad × BTC): ${w.filter((x, i) => x.sets > exposureMatched[i]!).length} von ${w.length}`);
  L.push(`SETS im Minus:               ${w.filter((x) => x.sets < 0).length} von ${w.length} Monaten, schlechtester ${pct(Math.min(...sets))}`);
  const rnd = w.filter((x) => x.random !== null);
  L.push(`SETS besser als Zufall mit Gate: ${rnd.filter((x) => x.sets > x.random!).length} von ${rnd.length} Monaten (Mittel SETS ${pct(mean(rnd.map((x) => x.sets)))}, Zufall ${pct(mean(rnd.map((x) => x.random!)))})`);
  L.push(`In steigenden Monaten (${up.length}): BTC ${pct(mean(up.map((x) => x.bh)))}, SETS ${pct(mean(up.map((x) => x.sets)))} im Mittel`);
  L.push(`In fallenden Monaten (${down.length}): BTC ${pct(mean(down.map((x) => x.bh)))}, SETS ${pct(mean(down.map((x) => x.sets)))} im Mittel`);
  L.push(`Mittlerer Drawdown im Testmonat: BTC ${pct(mean(w.map((x) => x.bhDD)))}, SETS ${pct(mean(w.map((x) => x.setsDD)))}`);
  L.push("");
  L.push("Lesehilfe: \"vorsichtig\" verbietet Nachkauf und Take-Profit in derselben Stunde. Liegt SETS deutlich darüber,");
  L.push("stammt ein Teil des Gewinns aus der günstigen Annahme über die Reihenfolge innerhalb der Kerze.");
  return L.join("\n");
}

/**
 * Control tape: the same hours in random order, each keeping its own open/high/low/close
 * shape relative to the previous close. Same return distribution and drift, but trends,
 * mean reversion and volatility clusters are gone. A strategy that earns just as much
 * here has not found anything in the market.
 */
export function shuffledTape(candles: readonly Candle[], seed: number): Candle[] {
  const r = mulberry32(seed), n = candles.length, idx = Array.from({ length: n - 1 }, (_, k) => k + 1);
  for (let k = idx.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [idx[k], idx[j]] = [idx[j]!, idx[k]!]; }
  const out: Candle[] = [[...candles[0]!]];
  let pc = candles[0]![4];
  for (let k = 0; k < idx.length; k++) {
    const c = candles[idx[k]!]!, f = pc / candles[idx[k]! - 1]![4];
    out.push([candles[k + 1]![0], c[1] * f, c[2] * f, c[3] * f, c[4] * f, c[5]]);
    pc = c[4] * f;
  }
  return out;
}

export function renderControl(real: WindowResult[], control: WindowResult[]): string {
  const line = (name: string, w: WindowResult[]): string =>
    `${name}  BTC halten ${pct(compound(w.map((x) => x.bh)))} · SETS ${pct(compound(w.map((x) => x.sets)))} · vorsichtig ${pct(compound(w.map((x) => x.setsCautious)))} · SETS schlägt Halten in ${w.filter((x) => x.sets > x.bh).length}/${w.length}`;
  return [
    "== Kontrolle: dieselben Stunden, zufällig gemischt (keine Marktstruktur mehr) ==",
    line("echte Kurse:     ", real),
    line("gemischte Kurse: ", control),
    "Verdient SETS auf den gemischten Kursen ähnlich viel, stammt der Gewinn nicht aus erkannten Mustern,",
    "sondern aus der Buchung innerhalb der Stundenkerze oder aus dem Grundtrend.",
  ].join("\n");
}
