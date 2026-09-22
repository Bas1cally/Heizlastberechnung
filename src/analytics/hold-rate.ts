import type { Db } from "../persistence/database.js";
import { TIME_BUCKETS } from "./calibration.js";
import { deriveOutcome, outcomeFromLabel } from "./outcomes.js";

/**
 * Empirical base rate of a lead holding to settlement: over the recorded,
 * resolved markets, how often a settlement-price lead of |d| bps with t
 * seconds left was still the winning side at the close. Pure counting over
 * the data we recorded; it is passed to Jev as a feature (data, not
 * intent) so its probabilities can rest on measured frequencies instead of
 * intuition about how far BTC moves in a minute.
 */
export const DISTANCE_BUCKETS: readonly { label: string; lo: number; hi: number }[] = [
  { label: "0-1bps", lo: 0, hi: 1 }, { label: "1-2.5bps", lo: 1, hi: 2.5 }, { label: "2.5-5bps", lo: 2.5, hi: 5 }, { label: "5-10bps", lo: 5, hi: 10 },
  { label: "10-20bps", lo: 10, hi: 20 }, { label: "20-50bps", lo: 20, hi: 50 }, { label: "50bps+", lo: 50, hi: Infinity },
];

export interface HoldCell { readonly distance: string; readonly time: string; readonly spot: SpotSide; readonly n: number; readonly held: number; readonly markets: number; readonly rate: number | null }

/**
 * Whether spot is on the leader's side of the TWAP. The TWAP lags spot by
 * up to a minute, so a lead on the TWAP with spot already back across it
 * is a different situation from a lead spot is still extending; a marginal
 * over both is what the market's price already knows better (measured
 * 2026-09-22: buys at 0.26-0.31 "under" a 0.40 marginal, 92 markets, -848).
 */
export type SpotSide = "agrees" | "disagrees";
export const SPOT_SIDES: readonly SpotSide[] = ["agrees", "disagrees"];
export function spotSideOf(distanceBps: number, spotVsTwapBps: number): SpotSide {
  if (distanceBps === 0 || spotVsTwapBps === 0) return "agrees";
  return Math.sign(distanceBps) === Math.sign(spotVsTwapBps) ? "agrees" : "disagrees";
}

/**
 * `samples` is the number of MARKETS behind the rate: the per-second
 * samples of one market are not independent (a lead that holds at 280 s
 * left almost always holds at 279 s too), so a standard error from the
 * seconds count is fiction. Observed 2026-09-21: 0.551 from 2,913 seconds
 * of 70 markets looked precise to a cent and lost 177 USD in one market.
 */
export interface HoldRateEstimate { readonly rate: number; readonly samples: number; readonly seconds: number; readonly bucket: string }

export class HoldRateTable {
  private readonly cells = new Map<string, { n: number; held: number; markets: number }>();
  readonly markets: number;

  constructor(cells: readonly { distance: string; time: string; spot?: SpotSide; n: number; held: number; markets?: number }[], markets: number) {
    for (const c of cells) this.cells.set(`${c.distance}|${c.time}|${c.spot ?? "agrees"}`, { n: c.n, held: c.held, markets: c.markets ?? 0 });
    this.markets = markets;
  }

  static bucketFor(distanceBps: number, secondsRemaining: number, spotVsTwapBps = 0): { distance: string; time: string; spot: SpotSide } | undefined {
    const a = Math.abs(distanceBps);
    const d = DISTANCE_BUCKETS.find((b) => a >= b.lo && a < b.hi);
    const t = TIME_BUCKETS.find((b) => secondsRemaining >= b.lo && secondsRemaining < b.hi);
    return d && t ? { distance: d.label, time: t.label, spot: spotSideOf(distanceBps, spotVsTwapBps) } : undefined;
  }

  /** Undefined below `minSeconds` per-second samples or `minMarkets` distinct markets: a rate from a handful of markets is noise dressed as a number. */
  estimate(distanceBps: number, secondsRemaining: number, spotVsTwapBps = 0, minSeconds = 20, minMarkets = 5): HoldRateEstimate | undefined {
    const b = HoldRateTable.bucketFor(distanceBps, secondsRemaining, spotVsTwapBps);
    if (!b) return undefined;
    const c = this.cells.get(`${b.distance}|${b.time}|${b.spot}`);
    if (!c || c.n < minSeconds || c.markets < minMarkets) return undefined;
    return { rate: c.held / c.n, samples: c.markets, seconds: c.n, bucket: `${b.distance} @ ${b.time} (spot ${b.spot})` };
  }

  rows(): HoldCell[] {
    const out: HoldCell[] = [];
    for (const d of DISTANCE_BUCKETS) for (const t of TIME_BUCKETS) for (const s of SPOT_SIDES) {
      const c = this.cells.get(`${d.label}|${t.label}|${s}`);
      out.push({ distance: d.label, time: t.label, spot: s, n: c?.n ?? 0, held: c?.held ?? 0, markets: c?.markets ?? 0, rate: c && c.n > 0 ? c.held / c.n : null });
    }
    return out;
  }

  toJSON(): { markets: number; cells: HoldCell[] } { return { markets: this.markets, cells: this.rows().filter((r) => r.n > 0) }; }
}

/**
 * Builds the table from every resolved market that closed before `beforeMs`
 * (causal: a live bot only ever sees markets that were over when it looked),
 * sampling the settlement stream once per second, each sample tagged with
 * whether spot (the last spot tick at or before that second) was on the
 * leader's side of the TWAP. Outcome: the official one when recorded, else
 * derived from the same stream. A market without spot ticks counts as
 * "agrees" throughout.
 */
export function buildHoldRateTable(db: Db, beforeMs: number): HoldRateTable {
  const markets = db.all<{ market_id: string; opened_at_ms: number; closes_at_ms: number; resolved_outcome: string | null }>(
    `SELECT market_id, opened_at_ms, closes_at_ms, resolved_outcome FROM markets WHERE closes_at_ms <= ? ORDER BY opened_at_ms`, [beforeMs]);
  const cells = new Map<string, { n: number; held: number; ids: Set<string> }>();
  let used = 0;
  for (const m of markets) {
    const twap = db.all<{ ts_ms: number; price: number }>(`SELECT ts_ms, price FROM ticks WHERE source LIKE 'chainlink-twap%' AND ts_ms >= ? AND ts_ms < ? ORDER BY ts_ms`, [m.opened_at_ms, m.closes_at_ms]);
    const ticks = (twap.length ? twap : db.all<{ ts_ms: number; price: number }>(`SELECT ts_ms, price FROM ticks WHERE source = 'chainlink' AND ts_ms >= ? AND ts_ms < ? ORDER BY ts_ms`, [m.opened_at_ms, m.closes_at_ms])).map((t) => ({ tsMs: t.ts_ms, price: t.price }));
    if (ticks.length < 30) continue;
    const spots = twap.length ? db.all<{ ts_ms: number; price: number }>(`SELECT ts_ms, price FROM ticks WHERE source = 'chainlink' AND ts_ms >= ? AND ts_ms < ? ORDER BY ts_ms`, [m.opened_at_ms - 5_000, m.closes_at_ms]) : [];
    let si = 0;
    // Only markets whose recording starts at the open: a late start is a wrong anchor.
    if (ticks[0]!.tsMs - m.opened_at_ms > 2_000) continue;
    const outcome = outcomeFromLabel(m.resolved_outcome) ?? deriveOutcome(ticks, m.opened_at_ms, m.closes_at_ms)?.outcome;
    if (!outcome) continue;
    used++;
    const start = ticks[0]!.price;
    let lastSecond = -1;
    for (const t of ticks) {
      const sec = Math.floor((t.tsMs - m.opened_at_ms) / 1000);
      if (sec === lastSecond) continue;
      lastSecond = sec;
      const distanceBps = ((t.price - start) / start) * 10_000;
      const secondsRemaining = (m.closes_at_ms - t.tsMs) / 1000;
      while (si + 1 < spots.length && spots[si + 1]!.ts_ms <= t.tsMs) si++;
      const spot = spots.length && spots[si]!.ts_ms <= t.tsMs ? spots[si]!.price : t.price;
      const spotVsTwapBps = ((spot - t.price) / t.price) * 10_000;
      const b = HoldRateTable.bucketFor(distanceBps, secondsRemaining, spotVsTwapBps);
      if (!b) continue;
      const leading: "UP" | "DOWN" = distanceBps >= 0 ? "UP" : "DOWN";
      const key = `${b.distance}|${b.time}|${b.spot}`;
      const c = cells.get(key) ?? { n: 0, held: 0, ids: new Set<string>() };
      c.n++; if (leading === outcome) c.held++; c.ids.add(m.market_id);
      cells.set(key, c);
    }
  }
  return new HoldRateTable([...cells.entries()].map(([k, c]) => { const [distance, time, spot] = k.split("|") as [string, string, SpotSide]; return { distance, time, spot, n: c.n, held: c.held, markets: c.ids.size }; }), used);
}
