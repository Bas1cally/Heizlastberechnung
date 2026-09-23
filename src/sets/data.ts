// Binance public klines for the SETS tests. No key, no account: market data only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Candle } from "../../vendor/sets/series.js";

const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];
const HOUR = 3_600_000;

/** Raw Binance kline: [openTime, open, high, low, close, volume, closeTime, ...] (strings for prices). */
type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

export interface Kline { openTime: number; open: number; high: number; low: number; close: number; volume: number; closeTime: number }

export type Fetcher = (url: string) => Promise<unknown>;

const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
};

/** Try each host in turn; the first that answers wins. */
export async function klines(path: string, fetcher: Fetcher = defaultFetcher): Promise<Kline[]> {
  let last: unknown;
  for (const host of HOSTS) {
    try {
      const raw = (await fetcher(host + path)) as RawKline[];
      return raw.map((k) => ({ openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], closeTime: k[6] }));
    } catch (e) { last = e; }
  }
  throw new Error(`Binance nicht erreichbar: ${last instanceof Error ? last.message : String(last)}`);
}

export const toCandle = (k: Kline): Candle => [Math.floor(k.openTime / 1000), k.open, k.high, k.low, k.close, Math.round(k.volume * 1000) / 1000];

/** Closed klines only: Binance returns the running candle last. */
export const closed = (ks: Kline[], now: number): Kline[] => ks.filter((k) => k.closeTime < now);

/**
 * The last `hours` closed hourly candles of `symbol`, cached in `file`. A cache that
 * already covers the range is only extended forward, so a rerun costs one or two requests.
 */
export async function hourlyHistory(opts: { symbol?: string; hours: number; file: string; now?: number; fetcher?: Fetcher; log?: (s: string) => void }): Promise<Candle[]> {
  const symbol = opts.symbol ?? "BTCUSDT", now = opts.now ?? Date.now(), log = opts.log ?? (() => {});
  let rows: Candle[] = existsSync(opts.file) ? (JSON.parse(readFileSync(opts.file, "utf8")) as Candle[]) : [];
  const wantFrom = Math.floor((now - opts.hours * HOUR) / HOUR) * HOUR;
  if (!rows.length || rows[0]![0] * 1000 > wantFrom + HOUR) {
    // (Re)load backwards from now in pages of 1000.
    rows = [];
    let end: number | undefined;
    while (rows.length < opts.hours) {
      const page = closed(await klines(`/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000${end === undefined ? "" : `&endTime=${end}`}`, opts.fetcher), now);
      if (!page.length) break;
      rows = [...page.map(toCandle), ...rows];
      end = page[0]!.openTime - 1;
      log(`  ${rows.length} Stunden geladen …`);
    }
  }
  // Extend forward from the last cached candle.
  for (;;) {
    const lastT = rows[rows.length - 1]![0] * 1000;
    const page = closed(await klines(`/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000&startTime=${lastT + HOUR}`, opts.fetcher), now);
    if (!page.length) break;
    rows.push(...page.map(toCandle));
    if (page.length < 1000) break;
  }
  // The cache keeps everything it has (a short shadow request must not shrink a 3-year cache).
  rows = dedupe(rows);
  mkdirSync(dirname(opts.file), { recursive: true });
  writeFileSync(opts.file, JSON.stringify(rows));
  return rows.slice(-opts.hours);
}

function dedupe(rows: Candle[]): Candle[] {
  const seen = new Set<number>(), out: Candle[] = [];
  for (const r of rows.sort((a, b) => a[0] - b[0])) if (!seen.has(r[0])) { seen.add(r[0]); out.push(r); }
  return out;
}

/** Hours missing between consecutive candles (Binance had a few maintenance gaps). */
export function gaps(rows: readonly Candle[]): number {
  let g = 0;
  for (let i = 1; i < rows.length; i++) g += Math.max(0, (rows[i]![0] - rows[i - 1]![0]) / 3600 - 1);
  return g;
}
