import type { JevInputState } from "./decision-types.js";

/**
 * Decides whether a new snapshot differs enough from the last one Jev saw to
 * be worth a request (brief §10). Every WebSocket frame bumps the raw state
 * version; only these changes bump the *material* version that decisions are
 * checked against.
 */
export interface MaterialThresholds {
  /** Settlement distance change, in bps. */
  readonly distanceBps: number;
  /** Complete-set cost change, in price units. */
  readonly pairCost: number;
  /** Change in executable pair quantity, in shares. */
  readonly pairQty: number;
  /** Heartbeat: re-evaluate after this long even if nothing else moved. */
  readonly heartbeatMs: number;
}

export const DEFAULT_MATERIAL: MaterialThresholds = {
  distanceBps: 0.5,
  pairCost: 0.002,
  pairQty: 25,
  heartbeatMs: 5_000,
};

/** Remaining-time buckets from brief §30; crossing one is material. */
export function timeBucket(secondsRemaining: number): number {
  const edges = [120, 60, 30, 15, 10, 5, 2];
  for (let i = 0; i < edges.length; i++) if (secondsRemaining >= edges[i]!) return i;
  return edges.length;
}

export type MaterialReason =
  | "first"
  | "heartbeat"
  | "quote"
  | "pair"
  | "settlement"
  | "spot"
  | "time_bucket"
  | "inventory"
  | "data_quality";

export function materialChange(
  prev: JevInputState | undefined,
  next: JevInputState,
  elapsedMs: number,
  t: MaterialThresholds = DEFAULT_MATERIAL,
): MaterialReason | undefined {
  if (!prev) return "first";

  const a = prev.orderbook;
  const b = next.orderbook;
  if (a.upBid !== b.upBid || a.upAsk !== b.upAsk || a.downBid !== b.downBid || a.downAsk !== b.downAsk) return "quote";
  if (Math.abs(a.pairAskCost - b.pairAskCost) >= t.pairCost || Math.abs(a.pairExecutableQty - b.pairExecutableQty) >= t.pairQty) return "pair";

  if (Math.abs(prev.market.distanceBps - next.market.distanceBps) >= t.distanceBps) return "settlement";
  // Spot leads the TWAP; a spot move changes where settlement is heading.
  if (Math.abs(prev.market.spotVsTwapBps - next.market.spotVsTwapBps) >= t.distanceBps) return "spot";
  if (timeBucket(prev.market.secondsRemaining) !== timeBucket(next.market.secondsRemaining)) return "time_bucket";

  const i = prev.inventory;
  const j = next.inventory;
  if (i.upShares !== j.upShares || i.downShares !== j.downShares) return "inventory";

  // Data going stale (or recovering) changes what Jev should do with it.
  const staleBefore = prev.dataQuality.chainlinkAgeMs > 2_000 || prev.dataQuality.bookAgeMs > 1_000;
  const staleNow = next.dataQuality.chainlinkAgeMs > 2_000 || next.dataQuality.bookAgeMs > 1_000;
  if (staleBefore !== staleNow) return "data_quality";

  if (elapsedMs >= t.heartbeatMs) return "heartbeat";
  return undefined;
}
