// Genetic search over grid-DCA configs.
// Train window: fitness. Out-of-sample window: the gate that decides who may trade.

import { backtest, FAMILIES } from './bot.js';
import { mulberry32, gauss } from './rng.js';

export const GENES = [
  { key: 'family', label: 'FAMILY', min: 0, max: 3, int: true, fmt: (v) => FAMILIES[v] },
  { key: 'lookback', label: 'LOOKBACK', min: 10, max: 200, int: true, fmt: (v) => v + ' h' },
  { key: 'entryZ', label: 'ENTRY Z', min: 0.2, max: 2.5, fmt: (v) => v.toFixed(2) + 'σ' },
  { key: 'levels', label: 'GRID LEVELS', min: 2, max: 8, int: true, fmt: (v) => String(v) },
  { key: 'spacing', label: 'SPACING', min: 0.003, max: 0.03, fmt: (v) => (v * 100).toFixed(2) + '%' },
  { key: 'mult', label: 'SIZE MULT', min: 1, max: 2, fmt: (v) => v.toFixed(2) + 'x' },
  { key: 'tp', label: 'TAKE PROFIT', min: 0.003, max: 0.04, fmt: (v) => (v * 100).toFixed(2) + '%' },
  { key: 'stop', label: 'STOP', min: 0.01, max: 0.12, fmt: (v) => (v * 100).toFixed(1) + '%' },
];

const fix = (G, v) => { v = Math.min(G.max, Math.max(G.min, v)); return G.int ? Math.round(v) : v; };

export function randomGenome(r) {
  const g = {};
  for (const G of GENES) g[G.key] = G.int ? Math.min(G.max, G.min + Math.floor(r() * (G.max - G.min + 1))) : G.min + r() * (G.max - G.min);
  return g;
}

export function crossover(a, b, r) {
  const g = {};
  for (const G of GENES) g[G.key] = r() < 0.5 ? a[G.key] : b[G.key];
  return g;
}

export function mutate(g, r, p = 0.18, scale = 0.12) {
  const out = { ...g }, changed = [];
  for (const G of GENES) {
    if (r() >= p) continue;
    if (G.key === 'family') { if (r() < 0.2) out.family = Math.floor(r() * 4); }
    else out[G.key] = fix(G, g[G.key] + gauss(r) * scale * (G.max - G.min));
    if (out[G.key] !== g[G.key]) changed.push(G.key);
  }
  return { genome: out, changed };
}

export function fitness(m) {
  // reward return, punish drawdown, demand enough trades to mean something
  return m.ret - 0.6 * m.maxDD - (m.trades < 4 ? 0.15 : 0);
}

export function passesGate(m) {
  return m.ret > 0.01 && m.maxDD < 0.1 && m.trades >= 3 && m.winRate >= 0.5;
}

const genomeKey = (g) => GENES.map((G) => (G.int ? g[G.key] : g[G.key].toFixed(5))).join('|');

export class Evolution {
  constructor(series, { seed = 2026, pop = 96, elite = 8, immigrants = 8, split = 0.7, warmup = 200 } = {}) {
    this.s = series;
    this.seed = seed;
    this.r = mulberry32(seed);
    this.N = pop; this.E = elite; this.I = immigrants;
    this.trainFrom = warmup;
    this.split = Math.floor(series.n * split);
    this.valFrom = this.split; this.valTo = series.n;
    this.gen = 0; this.nextId = 1;
    this.tested = 0; this.born = 0; this.killed = 0;
    this.history = [];
    this.leader = null;
    this.pop = [];
    for (let k = 0; k < this.N; k++) this.pop.push(this._make(randomGenome(this.r), [], []));
    this._rank();
    this._record([], [], this.pop.map((x) => x.id));
  }

  _make(genome, parents, changed) {
    const train = backtest(genome, this.s, this.trainFrom, this.split);
    const val = backtest(genome, this.s, this.valFrom, this.valTo);
    this.tested++; this.born++;
    return { id: this.nextId++, genome, parents, changed, gen: this.gen, train, val, fit: fitness(train), pass: passesGate(val) };
  }

  _rank() { this.pop.sort((a, b) => b.fit - a.fit); }

  _tournament(pool, k = 3) {
    let best = null;
    for (let i = 0; i < k; i++) { const c = pool[Math.floor(this.r() * pool.length)]; if (!best || c.fit > best.fit) best = c; }
    return best;
  }

  // Each family (species) gets a share of the offspring by rank, never less than ~12%,
  // so one lucky species cannot wipe out the others.
  _quotas(total) {
    const bestOf = [0, 1, 2, 3].map((f) => { const m = this.pop.find((x) => x.genome.family === f); return { f, fit: m ? m.fit : -9 }; });
    bestOf.sort((a, b) => b.fit - a.fit);
    const w = [0.4, 0.26, 0.2, 0.14], q = [0, 0, 0, 0];
    let left = total;
    bestOf.forEach((b, i) => { const n = i === 3 ? left : Math.round(total * w[i]); q[b.f] = n; left -= n; });
    return q;
  }

  // One generation. Returns a report the UI animates stage by stage.
  step() {
    this.gen++;
    // elites: the overall top plus the best of every species
    const keep = new Set(this.pop.slice(0, this.E - 4).map((x) => x.id));
    for (let f = 0; f < 4; f++) { const m = this.pop.find((x) => x.genome.family === f && !keep.has(x.id)); if (m) keep.add(m.id); }
    const elites = this.pop.filter((x) => keep.has(x.id));
    const immigrants = [], offspring = [];
    for (let k = 0; k < this.I; k++) immigrants.push(this._make(randomGenome(this.r), [], []));
    const quota = this._quotas(this.N - elites.length - immigrants.length);
    for (let f = 0; f < 4; f++) {
      const own = this.pop.filter((x) => x.genome.family === f), pool = own.length ? own : this.pop;
      for (let k = 0; k < quota[f]; k++) {
        const a = this._tournament(pool), b = this._tournament(this.r() < 0.8 ? pool : this.pop);
        const child = crossover(a.genome, b.genome, this.r);
        child.family = f;
        const m = mutate(child, this.r);
        offspring.push(this._make(m.genome, [a.id, b.id], m.changed));
      }
    }
    const died = this.pop.filter((x) => !keep.has(x.id)).map((x) => x.id);
    this.killed += died.length;
    this.pop = [...elites, ...offspring, ...immigrants];
    this._rank();
    return this._record(immigrants.map((x) => x.id), offspring.map((x) => x.id), died);
  }

  _record(immigrants, offspring, died) {
    const prev = this.leader;
    const survivors = this.pop.filter((x) => x.pass);
    let leader = survivors[0] || null; // best train fitness among those that passed OOS
    if (leader && prev && genomeKey(leader.genome) === genomeKey(prev.genome)) leader = prev; // a clone is not a promotion
    if (leader) this.leader = leader;
    const fits = this.pop.map((x) => x.fit);
    const rep = {
      gen: this.gen,
      best: fits[0], mean: fits.reduce((a, b) => a + b, 0) / fits.length,
      immigrants, offspring, died,
      survivors: survivors.length,
      leader: this.leader, promoted: !!leader && (!prev || prev.id !== leader.id),
      prevLeader: prev,
    };
    this.history.push({ gen: rep.gen, best: rep.best, mean: rep.mean, survivors: rep.survivors });
    this.last = rep;
    return rep;
  }

  byId(id) { return this.pop.find((x) => x.id === id); }
}
