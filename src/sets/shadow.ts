// Shadow session for a SETS leader: the genome trades live market data on paper, no orders.
// Two books run side by side on the same session:
//   "Stunde"  SETS' own GridBot on hourly candles, exactly as its backtests book it.
//   "Minute"  the same decisions, but grid fills, stop and take-profit are checked on every
//             1-minute candle, so the order inside an hour is what actually happened.
// The gap between the two shows how much the hourly booking flatters (or hurts) the result.
import { FEE, GridBot, signal, type BotEvent, type Genome } from "../../vendor/sets/bot.js";
import { makeSeries, type Candle, type Series } from "../../vendor/sets/series.js";

export interface Minute { t: number; open: number; high: number; low: number; close: number } // t: unix seconds of the open

export interface BookSummary { ret: number; trades: number; wins: number; maxDD: number; exposure: number; open: boolean }

export class ShadowCore {
  readonly hourly: Candle[];
  readonly hourBot: GridBot;
  readonly minuteBot: GridBot;
  private S: Series;
  private minuteIdx = 0;
  firstOpen = 0;
  lastClose = 0;

  /** `history`: closed hourly candles up to the session start. `sessionStart`: unix seconds, a full hour. */
  constructor(readonly genome: Genome, history: readonly Candle[], readonly sessionStart: number, cash = 10_000) {
    if (sessionStart % 3600 !== 0) throw new Error("sessionStart must be a full hour");
    this.hourly = [...history];
    this.S = makeSeries(this.hourly);
    this.hourBot = new GridBot(genome, cash);
    this.minuteBot = new GridBot(genome, cash);
  }

  get lastHour(): number { return this.hourly.length ? this.hourly[this.hourly.length - 1]![0] : 0; }

  /** A newly closed hourly candle. Hours inside the session are booked by the hourly engine. */
  addHour(c: Candle): BotEvent[] {
    if (c[0] <= this.lastHour) return [];
    this.hourly.push(c);
    this.S = makeSeries(this.hourly);
    if (c[0] < this.sessionStart) return [];
    return this.hourBot.step(this.S, this.S.n - 1);
  }

  /**
   * A closed 1-minute candle. At the first minute of an hour the entry decision needs the
   * hour that just closed; if it has not arrived yet, returns null and the caller retries.
   */
  addMinute(m: Minute): BotEvent[] | null {
    if (m.t < this.sessionStart) return [];
    const bot = this.minuteBot, g = this.genome, ev: BotEvent[] = [];
    if (!bot.inPos && m.t % 3600 === 0) {
      if (this.lastHour < m.t - 3600) return null;
      const j = this.hourly.findIndex((c) => c[0] === m.t - 3600);
      if (j >= 0 && signal(g, this.S, j).ok) bot._open(m.open, this.minuteIdx, ev);
    }
    if (!this.firstOpen) this.firstOpen = m.open;
    if (bot.inPos) {
      // Same order as SETS inside one candle: grid fills, then stop, then take-profit.
      for (const L of bot.levels) if (!L.filled && m.low <= L.price) bot._fill(L, L.price, this.minuteIdx, ev);
      bot.tp = bot.avg * (1 + g.tp);
      if (m.low <= bot.stop) bot._close(bot.stop, this.minuteIdx, "STOP", ev);
      else if (m.high >= bot.tp) bot._close(bot.tp, this.minuteIdx, "TP", ev);
    }
    const eq = bot.equity(m.close);
    bot.peak = Math.max(bot.peak, eq);
    bot.maxDD = Math.max(bot.maxDD, 1 - eq / bot.peak);
    bot.bars++; if (bot.inPos) bot.exposed++;
    this.minuteIdx++;
    this.lastClose = m.close;
    return ev;
  }

  /** Summary with any open position marked at the last price (not closed: the session may go on). */
  summary(which: "hour" | "minute"): BookSummary {
    const bot = which === "hour" ? this.hourBot : this.minuteBot;
    const price = which === "hour" ? (this.hourly[this.hourly.length - 1]?.[4] ?? 0) : this.lastClose;
    const t = bot.trades;
    return {
      ret: (bot.cash + (bot.inPos ? bot.qty * price * (1 - FEE) : 0)) / bot.start - 1,
      trades: t.length, wins: t.filter((x) => x.pnl > 0).length, maxDD: bot.maxDD,
      exposure: bot.bars ? bot.exposed / bot.bars : 0, open: bot.inPos,
    };
  }

  /** Buy and hold over the minutes seen so far. */
  holdReturn(): number { return this.firstOpen ? this.lastClose / this.firstOpen - 1 : 0; }
}
