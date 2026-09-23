// Long-only grid-DCA bot. The same class runs the backtests and the paper-trading replay,
// so what the dashboard shows is exactly what the fitness function measured.

import { rolling, zscore } from './series.js';

export const FAMILIES = ['MOMENTUM', 'MEAN REVERT', 'VOL BREAKOUT', 'RANGE GRID'];
export const FEE = 0.0004; // per fill, taker-like

// Entry signal decided on the close of bar j, executed at the open of bar j + 1.
export function signal(g, s, j) {
  if (j < g.lookback) return { ok: false, z: 0 };
  const z = zscore(s, g.lookback, j);
  switch (g.family) {
    case 0: return { ok: z > g.entryZ && s.close[j] > s.close[j - 1], z, need: `z > ${g.entryZ.toFixed(2)}` };
    case 1: return { ok: z < -g.entryZ, z, need: `z < −${g.entryZ.toFixed(2)}` };
    case 2: {
      const hh = rolling(s, g.lookback).hh[j];
      const lvl = hh * (1 + g.entryZ * 0.001);
      return { ok: s.close[j] > lvl, z, need: `close > ${Math.round(lvl)}` };
    }
    default: {
      const r = rolling(s, g.lookback), width = r.std[j] / r.mean[j];
      return { ok: Math.abs(z) < g.entryZ * 0.5 && width < 0.02, z, need: `|z| < ${(g.entryZ * 0.5).toFixed(2)}` };
    }
  }
}

export class GridBot {
  constructor(genome, equity = 10000) {
    this.g = genome;
    this.cash = equity;
    this.start = equity;
    this.qty = 0;
    this.cost = 0;         // total USD spent on the open position, fees included
    this.levels = [];      // {name, price, usd, filled, t}
    this.tp = 0; this.stop = 0;
    this.trades = [];      // closed round trips {pnl, ret, bars, exit}
    this.openedAt = -1;
    this.peak = equity; this.maxDD = 0;
    this.bars = 0; this.exposed = 0;
  }

  get inPos() { return this.qty > 0; }
  get avg() { return this.qty > 0 ? this.cost / this.qty : 0; }
  equity(price) { return this.cash + this.qty * price; }

  // Process bar i. Returns a list of events for logs / charts.
  step(s, i) {
    const ev = [];
    const g = this.g;
    if (!this.inPos && i > 0) {
      const sig = signal(g, s, i - 1);
      if (sig.ok) this._open(s.open[i], i, ev);
    }
    if (this.inPos) {
      // adverse-first ordering inside a bar: grid fills, then stop, then take-profit
      for (const L of this.levels) {
        if (!L.filled && s.low[i] <= L.price) this._fill(L, L.price, i, ev);
      }
      this.tp = this.avg * (1 + g.tp);
      if (s.low[i] <= this.stop) this._close(this.stop, i, 'STOP', ev);
      else if (s.high[i] >= this.tp) this._close(this.tp, i, 'TP', ev);
    }
    const eq = this.equity(s.close[i]);
    this.peak = Math.max(this.peak, eq);
    this.maxDD = Math.max(this.maxDD, 1 - eq / this.peak);
    this.bars++; if (this.inPos) this.exposed++;
    return ev;
  }

  _open(price, i, ev) {
    const g = this.g, eq = this.cash;
    let w = 0; for (let k = 0; k < g.levels; k++) w += Math.pow(g.mult, k);
    const base = eq / w;
    this.levels = [];
    for (let k = 0; k < g.levels; k++) {
      this.levels.push({ name: 'L' + (k + 1), price: price * (1 - g.spacing * k), usd: base * Math.pow(g.mult, k), filled: false, t: -1 });
    }
    this.stop = this.levels[this.levels.length - 1].price * (1 - g.stop);
    this.openedAt = i;
    this._fill(this.levels[0], price, i, ev);
  }

  _fill(L, price, i, ev) {
    const usd = Math.min(L.usd, this.cash);
    if (usd <= 0) return;
    this.cash -= usd;
    this.qty += (usd * (1 - FEE)) / price;
    this.cost += usd;
    L.filled = true; L.t = i; L.fillPrice = price;
    ev.push({ type: 'BUY', i, level: L.name, price, usd });
  }

  _close(price, i, why, ev) {
    const proceeds = this.qty * price * (1 - FEE);
    const pnl = proceeds - this.cost;
    this.trades.push({ pnl, ret: pnl / this.cost, bars: i - this.openedAt, exit: why, i });
    ev.push({ type: why, i, price, pnl });
    this.cash += proceeds;
    this.qty = 0; this.cost = 0; this.levels = []; this.tp = 0; this.stop = 0;
  }

  // Mark-to-market close at the end of a test window so open losses count.
  flatten(s, i) { if (this.inPos) this._close(s.close[i], i, 'EOD', []); }

  metrics() {
    const t = this.trades, wins = t.filter((x) => x.pnl > 0), losses = t.filter((x) => x.pnl <= 0);
    const avgWin = wins.length ? wins.reduce((a, x) => a + x.ret, 0) / wins.length : 0;
    const avgLoss = losses.length ? -losses.reduce((a, x) => a + x.ret, 0) / losses.length : 0;
    return {
      ret: this.cash / this.start - 1,
      maxDD: this.maxDD,
      trades: t.length,
      winRate: t.length ? wins.length / t.length : 0,
      payoff: avgLoss > 0 ? avgWin / avgLoss : wins.length ? 9.99 : 0,
      exposure: this.bars ? this.exposed / this.bars : 0,
    };
  }
}

export function backtest(genome, s, from, to) {
  const bot = new GridBot(genome);
  for (let i = from; i < to; i++) bot.step(s, i);
  bot.flatten(s, to - 1);
  return bot.metrics();
}
