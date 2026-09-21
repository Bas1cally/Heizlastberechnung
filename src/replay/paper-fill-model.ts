import type { OrderBook } from "../market/types.js";
import type { OrderIntent } from "../execution/order-builder.js";
import { executeAgainst } from "../features/orderbook.js";

/**
 * Paper fill model (brief §38). Never pretends every touched limit fills.
 *
 * The order is evaluated against the book as it stands after `latencyMs`
 * (the caller passes the later snapshot), so a quote that moved away during
 * the decision-to-submit path is a missed fill, not a fill at the old price.
 *
 * Marketable orders (FAK/FOK, or a limit at/through the ask) take depth at or
 * below the limit. A resting limit fills only if a later book trades through
 * it; touching without trading through fills with `queueFillProbability`,
 * decided by a seeded generator so a replay is reproducible.
 */
export interface FillParams {
  /** Extra adverse price per share on marketable fills, in price units. */
  readonly slippage: number;
  /** Chance a resting order at the touch gets filled when only touched, 0..1. */
  readonly queueFillProbability: number;
  /** Taker fee per share, in collateral units. */
  readonly takerFee: number;
  readonly makerFee: number;
}

export const DEFAULT_FILL_PARAMS: FillParams = { slippage: 0.001, queueFillProbability: 0.35, takerFee: 0, makerFee: 0 };

export type FillStatus = "FILLED" | "PARTIAL" | "NO_FILL" | "RESTING";

export interface FillResult {
  readonly status: FillStatus;
  readonly filledQty: number;
  readonly avgPrice: number;
  readonly fee: number;
  readonly reason: string;
}

/** Deterministic PRNG (mulberry32) so a replay is reproducible for a seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NONE = (reason: string): FillResult => ({ status: "NO_FILL", filledQty: 0, avgPrice: 0, fee: 0, reason });

/** Marketable evaluation against the book at arrival time. */
export function fillMarketable(order: OrderIntent, bookAtArrival: OrderBook, p: FillParams): FillResult {
  const reachable = bookAtArrival.asks.filter((l) => l.price <= order.price + 1e-12);
  if (reachable.length === 0) return NONE("book moved away before arrival");
  const exec = executeAgainst(reachable, order.size);
  if (exec.filledQty <= 0) return NONE("no depth at or below limit");
  if (order.style.type === "FOK" && exec.exhausted) return NONE("FOK: insufficient depth for full size");
  const avgPrice = Math.min(0.999, exec.vwap + p.slippage);
  return {
    status: exec.exhausted ? "PARTIAL" : "FILLED",
    filledQty: exec.filledQty,
    avgPrice,
    fee: exec.filledQty * p.takerFee,
    reason: exec.exhausted ? "partial: depth exhausted" : "taken at arrival",
  };
}

/**
 * Resting evaluation: given the books seen while the order rested. Fills if
 * any later ask trades through the limit; with probability
 * `queueFillProbability` if only touched; otherwise expires unfilled.
 */
export function fillResting(order: OrderIntent, laterBooks: readonly OrderBook[], p: FillParams, rand: () => number): FillResult {
  let touched = false;
  for (const b of laterBooks) {
    const ask = b.asks[0]?.price;
    if (ask === undefined) continue;
    if (ask < order.price - 1e-12) {
      return { status: "FILLED", filledQty: order.size, avgPrice: order.price, fee: order.size * p.makerFee, reason: "market traded through the limit" };
    }
    if (Math.abs(ask - order.price) < 1e-12) touched = true;
  }
  if (touched && rand() < p.queueFillProbability) {
    return { status: "FILLED", filledQty: order.size, avgPrice: order.price, fee: order.size * p.makerFee, reason: "touched; filled by queue draw" };
  }
  return { status: touched ? "NO_FILL" : "NO_FILL", filledQty: 0, avgPrice: 0, fee: 0, reason: touched ? "touched; queue draw missed" : "never touched" };
}

/** Is this order marketable against the book it was built on? */
export function isMarketable(order: OrderIntent, bookAtBuild: OrderBook): boolean {
  const ask = bookAtBuild.asks[0]?.price;
  return order.style.type === "FAK" || order.style.type === "FOK" || (ask !== undefined && order.price >= ask - 1e-12);
}
