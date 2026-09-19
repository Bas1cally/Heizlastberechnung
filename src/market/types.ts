/** Shared market primitives. Prices are probabilities in [0,1]; sizes are shares. */

/** One price level of an order book side. Parsed at the feed boundary - the
 *  SDK delivers price and size as decimal strings, and nothing downstream of
 *  the feed is allowed to see a string price. */
export interface BookLevel {
  readonly price: number;
  readonly size: number;
}

/** Bids descending by price, asks ascending. Enforced by the feed parser. */
export interface BookSide {
  readonly levels: readonly BookLevel[];
}

export interface OrderBook {
  readonly assetId: string;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly receivedAtMs: number;
}

/** Result of walking one side of a book for a requested quantity. */
export interface Execution {
  /** Shares actually obtainable - less than requested when depth runs out. */
  readonly filledQty: number;
  /** Total cost (or proceeds) in collateral units. */
  readonly cost: number;
  /** Depth-weighted average price. NaN-free: 0 when nothing filled. */
  readonly vwap: number;
  /** True when the book ran out before the requested quantity was reached. */
  readonly exhausted: boolean;
}
