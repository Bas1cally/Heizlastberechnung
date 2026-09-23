import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GridBot, type Genome } from "../../../vendor/sets/bot.js";
import { mulberry32 } from "../../../vendor/sets/rng.js";
import { makeSeries, type Candle } from "../../../vendor/sets/series.js";
import { closed, gaps, hourlyHistory } from "../../../src/sets/data.js";
import { ShadowCore } from "../../../src/sets/shadow.js";
import { CautiousBot, renderWalk, shuffledTape, walkForward } from "../../../src/sets/walk.js";

const HOUR = 3600;
const flat = (n: number, p = 100, t0 = 0): Candle[] => Array.from({ length: n }, (_, i) => [t0 + i * HOUR, p, p, p, p, 1]);
const walkTape = (n: number, seed = 1): Candle[] => {
  const r = mulberry32(seed), out: Candle[] = [];
  let p = 30_000;
  for (let i = 0; i < n; i++) {
    const o = p, c = o * (1 + (r() - 0.49) * 0.01), h = Math.max(o, c) * (1 + r() * 0.003), l = Math.min(o, c) * (1 - r() * 0.003);
    out.push([i * HOUR, o, h, l, c, 1]); p = c;
  }
  return out;
};
// Mean revert with a 5 h window: enters after a sharp drop.
const g: Genome = { family: 1, lookback: 5, entryZ: 1, levels: 3, spacing: 0.01, mult: 1, tp: 0.02, stop: 0.1 };

describe("sets: cautious fills", () => {
  it("does not take profit in the bar that added grid fills, SETS does", () => {
    const c = flat(30);
    c[21] = [21 * HOUR, 100, 110, 97.5, 100, 1]; // dips through L2 and L3, then far above the target
    c[22] = [22 * HOUR, 100, 110, 99, 105, 1];
    const s = makeSeries(c);
    const sets = new GridBot(g, 3000), cautious = new CautiousBot(g, 3000);
    sets._open(100, 20, []); cautious._open(100, 20, []);
    const a = sets.step(s, 21), b = cautious.step(s, 21);
    expect(a.map((e) => e.type)).toEqual(["BUY", "BUY", "TP"]);
    expect(b.map((e) => e.type)).toEqual(["BUY", "BUY"]);
    expect(cautious.step(s, 22).map((e) => e.type)).toEqual(["TP"]);
  });
});

describe("sets: walk-forward", () => {
  it("tests every window on hours the evolution never saw", () => {
    const tape = walkTape(2600);
    const o = { warm: 200, train: 700, gate: 400, test: 300, stepH: 300, seeds: [1], generations: 3, randoms: 20 };
    const w = walkForward(tape, o);
    expect(w.length).toBe(Math.floor((2600 - 1300 - 300) / 300) + 1);
    expect(w[0]!.testFrom).toBe(tape[1300]![0]);
    expect(w[1]!.testFrom - w[0]!.testFrom).toBe(300 * HOUR);
    for (const x of w) { expect(Number.isFinite(x.sets)).toBe(true); expect(x.bh).toBeCloseTo(0, 0); }
    expect(renderWalk(w, o)).toContain("SETS besser als BTC halten");
  });
});

describe("sets: control tape", () => {
  it("keeps every hour's return and the overall drift, only the order changes", () => {
    const tape = walkTape(500), mixed = shuffledTape(tape, 3);
    const rets = (c: Candle[]) => c.slice(1).map((x, i) => x[4] / c[i]![4]).sort((a, b) => a - b);
    expect(mixed).toHaveLength(500);
    expect(mixed[499]![4]).toBeCloseTo(tape[499]![4], 6);
    rets(mixed).forEach((r, i) => expect(r).toBeCloseTo(rets(tape)[i]!, 9));
    expect(mixed.map((c) => c[4])).not.toEqual(tape.map((c) => c[4]));
  });
});

describe("sets: shadow session", () => {
  const history = (): Candle[] => {
    const c = flat(30);
    c[29] = [29 * HOUR, 100, 100, 94, 95, 1]; // sharp drop in the last hour: z far below −1
    return c;
  };
  const start = 30 * HOUR;

  it("enters at the first minute of the hour, fills and takes profit minute by minute", () => {
    const core = new ShadowCore(g, history(), start, 3000);
    const m = (k: number, o: number, h: number, l: number, cl: number) => ({ t: start + k * 60, open: o, high: h, low: l, close: cl });
    expect(core.addMinute(m(0, 95, 95, 95, 95))!.map((e) => e.type)).toEqual(["BUY"]);
    expect(core.addMinute(m(1, 95, 95, 94, 94))!.map((e) => e.type)).toEqual(["BUY"]); // L2 at 94.05
    const tp = core.addMinute(m(2, 94, 98, 94, 98))!;
    expect(tp.map((e) => e.type)).toEqual(["TP"]);
    expect(core.summary("minute").trades).toBe(1);
    expect(core.summary("minute").ret).toBeGreaterThan(0);
  });

  it("waits for the hour that decides the entry", () => {
    const core = new ShadowCore(g, history().slice(0, 29), start, 3000);
    expect(core.addMinute({ t: start, open: 95, high: 95, low: 95, close: 95 })).toBeNull();
    core.addHour(history()[29]!);
    expect(core.addMinute({ t: start, open: 95, high: 95, low: 95, close: 95 })!.map((e) => e.type)).toEqual(["BUY"]);
  });

  it("books the same hour on the hourly engine as SETS would", () => {
    const core = new ShadowCore(g, history(), start, 3000);
    const ev = core.addHour([start, 95, 98, 94, 97, 1]);
    expect(ev.map((e) => e.type)).toEqual(["BUY", "BUY", "TP"]); // same-bar fill and profit, as in SETS
  });
});

describe("sets: data", () => {
  it("loads backwards in pages, keeps closed candles only, extends forward from the cache", async () => {
    let now = 5000 * HOUR * 1000 + 30 * 60_000; // half past the hour: the running candle must be dropped
    const kline = (t: number) => [t, "1", "2", "0.5", "1.5", "10", t + HOUR * 1000 - 1];
    let calls = 0;
    const fetcher = async (url: string) => {
      calls++;
      const q = new URL(url).searchParams, limit = Number(q.get("limit"));
      const last = Math.floor(now / (HOUR * 1000)) * HOUR * 1000; // the running hour
      if (q.get("startTime")) { const s = Number(q.get("startTime")); const out = []; for (let t = s; t <= last && out.length < limit; t += HOUR * 1000) out.push(kline(t)); return out; }
      const end = q.get("endTime") ? Math.floor(Number(q.get("endTime")) / (HOUR * 1000)) * HOUR * 1000 : last;
      const out = []; for (let t = end - (limit - 1) * HOUR * 1000; t <= end; t += HOUR * 1000) out.push(kline(t));
      return out;
    };
    const file = join(mkdtempSync(join(tmpdir(), "sets-")), "c.json");
    const rows = await hourlyHistory({ hours: 2500, file, now, fetcher });
    expect(rows.length).toBe(2500);
    expect(rows[rows.length - 1]![0]).toBe(4999 * HOUR); // the running hour 5000 is not included
    expect(gaps(rows)).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(2999); // three pages, all kept
    calls = 0; now += 2 * HOUR * 1000;
    const again = await hourlyHistory({ hours: 2500, file, now, fetcher });
    expect(calls).toBe(1);
    expect(again[again.length - 1]![0]).toBe(5001 * HOUR);
    expect(await hourlyHistory({ hours: 100, file, now, fetcher })).toHaveLength(100);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(3001); // a short request keeps the long cache
    expect(closed([{ openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: 10 }], 5)).toEqual([]);
  });
});
