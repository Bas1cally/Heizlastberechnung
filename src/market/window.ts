/**
 * BTC 5-minute markets are slugged `btc-updown-5m-<unix seconds of window start>`
 * (observed live: 1766162100 -> "December 19, 11:35AM-11:40AM ET"). The
 * current market is therefore a function of the clock, not of a search.
 */
export const SLUG_PREFIX = "btc-updown-5m-";

export interface Window {
  readonly startSec: number;
  readonly openedAtMs: number;
  readonly closesAtMs: number;
  readonly slug: string;
}

export function windowAt(nowMs: number, durationSeconds = 300): Window {
  const startSec = Math.floor(nowMs / 1000 / durationSeconds) * durationSeconds;
  return {
    startSec,
    openedAtMs: startSec * 1000,
    closesAtMs: (startSec + durationSeconds) * 1000,
    slug: `${SLUG_PREFIX}${startSec}`,
  };
}

export function nextWindow(nowMs: number, durationSeconds = 300): Window {
  return windowAt(windowAt(nowMs, durationSeconds).closesAtMs, durationSeconds);
}

/** Parse a slug back into its window; undefined when it is not a 5-minute slug. */
export function parseSlug(slug: string, durationSeconds = 300): Window | undefined {
  if (!slug.startsWith(SLUG_PREFIX)) return undefined;
  const startSec = Number(slug.slice(SLUG_PREFIX.length));
  if (!Number.isInteger(startSec) || startSec <= 0) return undefined;
  return { startSec, openedAtMs: startSec * 1000, closesAtMs: (startSec + durationSeconds) * 1000, slug };
}
