import type { BookLevel, OrderBook } from "../market/types.js";

/**
 * The single place where string prices become numbers and level order is
 * fixed. The CLOB REST book returns bids ASCENDING (lowest first) and asks
 * DESCENDING (highest first) - the opposite of what a book walk needs. The WS
 * `book` event's order is not documented in the types at all. So: never trust
 * incoming order, always sort.
 */
export interface RawLevel {
  readonly price: string | number;
  readonly size: string | number;
}

export function parseLevels(raw: readonly RawLevel[]): BookLevel[] {
  const out: BookLevel[] = [];
  for (const l of raw) {
    const price = Number(l.price);
    const size = Number(l.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0 || price < 0 || price > 1) continue;
    out.push({ price, size });
  }
  return out;
}

export function normalizeBook(input: {
  assetId: string;
  bids: readonly RawLevel[];
  asks: readonly RawLevel[];
  receivedAtMs: number;
}): OrderBook {
  return {
    assetId: input.assetId,
    bids: parseLevels(input.bids).sort((a, b) => b.price - a.price),
    asks: parseLevels(input.asks).sort((a, b) => a.price - b.price),
    receivedAtMs: input.receivedAtMs,
  };
}

/** Apply one level change: size 0 removes, otherwise upsert. Keeps order. */
export function applyLevelChange(
  book: OrderBook,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  receivedAtMs: number,
): OrderBook {
  const isBid = side === "BUY";
  const levels = (isBid ? book.bids : book.asks).filter((l) => l.price !== price);
  if (size > 0) levels.push({ price, size });
  levels.sort(isBid ? (a, b) => b.price - a.price : (a, b) => a.price - b.price);
  return isBid
    ? { ...book, bids: levels, receivedAtMs }
    : { ...book, asks: levels, receivedAtMs };
}
