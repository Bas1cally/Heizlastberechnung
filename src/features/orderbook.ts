import type { BookLevel, Execution, OrderBook } from "../market/types.js";

/**
 * Walk one side of a book for `qty` shares and report what it really costs.
 *
 * Top of book is a quote for the size shown at that level, not for whatever
 * size you want. Using it for a larger order overstates the edge, which is
 * exactly the error that makes a pair trade look profitable when it is not.
 */
export function executeAgainst(
  levels: readonly BookLevel[],
  qty: number,
): Execution {
  if (!(qty > 0)) return { filledQty: 0, cost: 0, vwap: 0, exhausted: false };

  let remaining = qty;
  let cost = 0;
  let filled = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;
    cost += take * level.price;
    filled += take;
    remaining -= take;
  }

  return {
    filledQty: filled,
    cost,
    vwap: filled > 0 ? cost / filled : 0,
    exhausted: remaining > 1e-9,
  };
}

/** Total shares available across a side. */
export function depth(levels: readonly BookLevel[]): number {
  return levels.reduce((sum, l) => sum + l.size, 0);
}

export const bestBid = (book: OrderBook): number | undefined => book.bids[0]?.price;
export const bestAsk = (book: OrderBook): number | undefined => book.asks[0]?.price;

/** Ask minus bid, or undefined when either side is empty. */
export function spread(book: OrderBook): number | undefined {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  return bid === undefined || ask === undefined ? undefined : ask - bid;
}

/**
 * Book imbalance in [-1, 1]: +1 is all bid depth, -1 is all ask depth.
 *
 * Returns 0 for an empty book rather than NaN, so a dead book reads as
 * "no signal" instead of poisoning every downstream feature.
 */
export function imbalance(book: OrderBook): number {
  const bidDepth = depth(book.bids);
  const askDepth = depth(book.asks);
  const total = bidDepth + askDepth;
  return total > 0 ? (bidDepth - askDepth) / total : 0;
}
