import type { MarketState } from "../market/market-state.js";
import type { JevInputState } from "./decision-types.js";
import { bestAsk, bestBid, depth, imbalance, spread } from "../features/orderbook.js";
import { computePairCost } from "../features/pair-cost.js";
import { distanceBps, returnBps, type PriceWindow } from "../features/returns.js";
import { realizedVolBps } from "../features/volatility.js";

export interface StateBuilderInput {
  readonly state: MarketState;
  readonly prices: PriceWindow;
  readonly chainlinkAgeMs: number;
  readonly bookAgeMs: number;
  /** Size the pair cost is evaluated at. */
  readonly pairQty: number;
  readonly feePerSet?: number;
  /** Empirical hold rate lookup (analytics/hold-rate.ts); absent means the feature is null. */
  readonly holdRate?: ((distanceBps: number, secondsRemaining: number) => { rate: number; samples: number } | undefined) | undefined;
}

const r = (n: number, d = 6) => (Number.isFinite(n) ? Number(n.toFixed(d)) : 0);

/**
 * Turns the canonical state into the compact snapshot Jev sees. Everything
 * here is arithmetic that has already been done; this function only selects
 * and rounds so the payload is small, stable and reproducible.
 */
export function buildJevState(input: StateBuilderInput): JevInputState {
  const { state, prices, pairQty, feePerSet = 0 } = input;
  const up = state.upBook;
  const down = state.downBook;

  const upBid = up ? (bestBid(up) ?? 0) : 0;
  const upAsk = up ? (bestAsk(up) ?? 1) : 1;
  const downBid = down ? (bestBid(down) ?? 0) : 0;
  const downAsk = down ? (bestAsk(down) ?? 1) : 1;

  const pair = computePairCost({ upAsks: up?.asks ?? [], downAsks: down?.asks ?? [], requestedQty: pairQty, feePerSet });

  const start = state.settlementStartPrice ?? 0;
  const current = state.settlementCurrentPrice ?? start;
  const spot = state.spotPrice ?? current;
  const held = input.holdRate?.(distanceBps(start, current), state.secondsRemaining);
  const leader: "UP" | "DOWN" | null = up && down ? (upAsk >= downAsk ? "UP" : "DOWN") : null;
  const inv0 = state.inventory;
  const hedgeCap = inv0.unpairedUpShares > 0 ? 1 - inv0.avgUpEntry : inv0.unpairedDownShares > 0 ? 1 - inv0.avgDownEntry : null;
  const hedgeAsk = inv0.unpairedUpShares > 0 ? downAsk : inv0.unpairedDownShares > 0 ? upAsk : undefined;

  return {
    market: {
      secondsRemaining: r(state.secondsRemaining, 1),
      settlementStartPrice: r(start, 2),
      settlementCurrentPrice: r(current, 2),
      distanceUsd: r(current - start, 2),
      distanceBps: r(distanceBps(start, current), 2),
      spotPrice: r(spot, 2),
      spotVsTwapBps: r(distanceBps(current, spot), 2),
      leadHeldRate: held ? r(held.rate, 3) : null,
      leadHeldSamples: held?.samples ?? 0,
    },
    movement: {
      return1s: r(returnBps(prices, 1_000), 2),
      return3s: r(returnBps(prices, 3_000), 2),
      return5s: r(returnBps(prices, 5_000), 2),
      return10s: r(returnBps(prices, 10_000), 2),
      return30s: r(returnBps(prices, 30_000), 2),
      realizedVol5s: r(realizedVolBps(prices, 5_000), 2),
      realizedVol10s: r(realizedVolBps(prices, 10_000), 2),
      realizedVol30s: r(realizedVolBps(prices, 30_000), 2),
    },
    orderbook: {
      upBid: r(upBid, 4), upAsk: r(upAsk, 4), downBid: r(downBid, 4), downAsk: r(downAsk, 4),
      upDepth: r(up ? depth(up.asks) : 0, 2),
      downDepth: r(down ? depth(down.asks) : 0, 2),
      pairAskCost: r(pair.pairVWAP, 5),
      pairExecutableQty: r(pair.pairExecutableQty, 2),
      pairEdge: r(pair.pairEdge, 5),
      upSpread: r(up ? (spread(up) ?? 0) : 0, 4),
      downSpread: r(down ? (spread(down) ?? 0) : 0, 4),
      imbalanceUp: r(up ? imbalance(up) : 0, 3),
      imbalanceDown: r(down ? imbalance(down) : 0, 3),
      leader, leaderAsk: r(leader === "UP" ? upAsk : leader === "DOWN" ? downAsk : 0, 4),
      leaderAskDepth: r(leader === "UP" ? (up ? depth(up.asks) : 0) : leader === "DOWN" ? (down ? depth(down.asks) : 0) : 0, 2),
      tailAsk: r(leader === "UP" ? downAsk : leader === "DOWN" ? upAsk : 0, 4),
      tailAskDepth: r(leader === "UP" ? (down ? depth(down.asks) : 0) : leader === "DOWN" ? (up ? depth(up.asks) : 0) : 0, 2),
    },
    inventory: {
      upShares: r(state.inventory.upShares, 2),
      downShares: r(state.inventory.downShares, 2),
      avgUpEntry: r(state.inventory.avgUpEntry, 4),
      avgDownEntry: r(state.inventory.avgDownEntry, 4),
      pairedShares: r(state.inventory.pairedShares, 2),
      unpairedUpShares: r(state.inventory.unpairedUpShares, 2),
      unpairedDownShares: r(state.inventory.unpairedDownShares, 2),
      pnlIfUp: r(state.inventory.pnlIfUp, 2),
      pnlIfDown: r(state.inventory.pnlIfDown, 2),
      guaranteedPairPnl: r(state.inventory.guaranteedPairPnl, 2),
      hedgePriceCap: hedgeCap === null ? null : r(hedgeCap, 4),
      hedgeAvailable: hedgeCap !== null && hedgeAsk !== undefined && hedgeAsk <= hedgeCap + 1e-9,
    },
    dataQuality: {
      chainlinkAgeMs: Math.round(Number.isFinite(input.chainlinkAgeMs) ? input.chainlinkAgeMs : 1e9),
      bookAgeMs: Math.round(Number.isFinite(input.bookAgeMs) ? input.bookAgeMs : 1e9),
    },
  };
}

/** Stable JSON: sorted keys, so equal states hash equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
