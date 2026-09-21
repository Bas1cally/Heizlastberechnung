import type { PriceWindow } from "./returns.js";

/**
 * Realised volatility over `windowMs`: standard deviation of consecutive log
 * returns inside the window, in bps. Not annualised. 0 when fewer than three
 * ticks are available rather than NaN, so an empty window reads as "no
 * information" instead of poisoning every feature downstream.
 */
export function realizedVolBps(window: PriceWindow, windowMs: number): number {
  const latest = window.latest();
  if (!latest) return 0;
  const ticks = window.since(latest.ts - windowMs);
  if (ticks.length < 3) return 0;

  const rets: number[] = [];
  for (let i = 1; i < ticks.length; i++) {
    const a = ticks[i - 1]!.price;
    const b = ticks[i]!.price;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 2) return 0;

  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * 10_000;
}
