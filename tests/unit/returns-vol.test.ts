import { describe, expect, it } from "vitest";
import { PriceWindow, distanceBps, returnBps } from "../../src/features/returns.js";
import { realizedVolBps } from "../../src/features/volatility.js";

const fill = (w: PriceWindow, prices: number[], stepMs = 1000) =>
  prices.forEach((p, i) => w.push({ ts: i * stepMs, price: p }));

describe("PriceWindow", () => {
  it("drops history older than the retention", () => {
    const w = new PriceWindow(5_000);
    fill(w, [1, 2, 3, 4, 5, 6, 7, 8]);
    expect(w.size()).toBeLessThanOrEqual(6);
    expect(w.latest()?.price).toBe(8);
  });

  it("ignores an out-of-order tick rather than rewriting history", () => {
    const w = new PriceWindow(60_000);
    w.push({ ts: 10, price: 100 });
    w.push({ ts: 5, price: 50 });
    expect(w.latest()).toEqual({ ts: 10, price: 100 });
  });

  it("finds the last tick at or before a time", () => {
    const w = new PriceWindow(60_000);
    fill(w, [100, 101, 102]);
    expect(w.at(1500)?.price).toBe(101);
    expect(w.at(-1)).toBeUndefined();
  });
});

describe("returnBps", () => {
  it("measures simple return over the window in bps", () => {
    const w = new PriceWindow(60_000);
    fill(w, [100_000, 100_050, 100_100]);
    // 100000 -> 100100 over 2s = +10 bps
    expect(returnBps(w, 2_000)).toBeCloseTo(10, 6);
  });

  it("is 0, not NaN, when history is too short", () => {
    const w = new PriceWindow(60_000);
    w.push({ ts: 0, price: 100 });
    expect(returnBps(w, 5_000)).toBe(0);
    expect(returnBps(new PriceWindow(1), 1)).toBe(0);
  });
});

describe("realizedVolBps", () => {
  it("is 0 for a flat series and positive for a noisy one", () => {
    const flat = new PriceWindow(60_000);
    fill(flat, [100, 100, 100, 100, 100]);
    expect(realizedVolBps(flat, 10_000)).toBe(0);

    const noisy = new PriceWindow(60_000);
    fill(noisy, [100, 101, 100, 101, 100, 101]);
    expect(realizedVolBps(noisy, 10_000)).toBeGreaterThan(50);
  });

  it("needs at least three ticks", () => {
    const w = new PriceWindow(60_000);
    fill(w, [100, 105]);
    expect(realizedVolBps(w, 10_000)).toBe(0);
  });
});

describe("distanceBps", () => {
  it("is signed relative to the start price", () => {
    expect(distanceBps(100_000, 100_182)).toBeCloseTo(18.2, 6);
    expect(distanceBps(100_000, 99_900)).toBeCloseTo(-10, 6);
    expect(distanceBps(0, 5)).toBe(0);
  });
});
