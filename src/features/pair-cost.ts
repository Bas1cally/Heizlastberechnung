import type { BookLevel, OrderBook } from "../market/types.js";
import { depth, executeAgainst } from "./orderbook.js";

/**
 * Complete-set economics.
 *
 * The two outcomes of a binary market settle to a combined 1.00. Buying both
 * legs for less than that (after costs) is a profit that does not depend on
 * which side wins - but only at a size both books can actually fill.
 */
export interface PairCost {
  /** Shares for which BOTH legs are obtainable. */
  readonly pairExecutableQty: number;
  /** Depth-weighted cost of one complete set at that quantity. */
  readonly pairVWAP: number;
  /** Total cost of `pairExecutableQty` complete sets. */
  readonly totalCost: number;
  /** 1 - pairVWAP - fees, per set. Positive means a risk-free edge exists. */
  readonly pairEdge: number;
  /** True when the requested quantity exceeded one of the books. */
  readonly exhausted: boolean;
}

export interface PairCostInput {
  readonly upAsks: readonly BookLevel[];
  readonly downAsks: readonly BookLevel[];
  /** Shares of the complete set wanted. */
  readonly requestedQty: number;
  /** Per-set fee estimate in collateral units. */
  readonly feePerSet?: number;
}

/**
 * Cost of a complete set at a size both books can fill.
 *
 * The quantity is capped at the thinner side first, then both legs are priced
 * at that same quantity. Pricing each leg at its own maximum would describe a
 * trade that cannot be executed as a pair.
 */
export function computePairCost(input: PairCostInput): PairCost {
  const { upAsks, downAsks, requestedQty, feePerSet = 0 } = input;

  const available = Math.min(depth(upAsks), depth(downAsks));
  const qty = Math.min(requestedQty, available);

  if (!(qty > 0)) {
    return {
      pairExecutableQty: 0,
      pairVWAP: 0,
      totalCost: 0,
      pairEdge: 0,
      exhausted: requestedQty > 0,
    };
  }

  const up = executeAgainst(upAsks, qty);
  const down = executeAgainst(downAsks, qty);

  const pairVWAP = up.vwap + down.vwap;
  return {
    pairExecutableQty: qty,
    pairVWAP,
    totalCost: up.cost + down.cost,
    pairEdge: 1 - pairVWAP - feePerSet,
    exhausted: qty < requestedQty,
  };
}

/** Proceeds from selling a complete set into the bids, per set. */
export function pairBidValue(
  upBids: readonly BookLevel[],
  downBids: readonly BookLevel[],
  qty: number,
): number {
  const available = Math.min(depth(upBids), depth(downBids));
  const q = Math.min(qty, available);
  if (!(q > 0)) return 0;
  return executeAgainst(upBids, q).vwap + executeAgainst(downBids, q).vwap;
}

/** Convenience wrapper when both sides are full books. */
export function pairCostFromBooks(
  up: OrderBook,
  down: OrderBook,
  requestedQty: number,
  feePerSet = 0,
): PairCost {
  return computePairCost({
    upAsks: up.asks,
    downAsks: down.asks,
    requestedQty,
    feePerSet,
  });
}
