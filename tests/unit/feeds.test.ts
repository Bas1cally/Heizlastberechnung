import { describe, expect, it, vi } from "vitest";
import { BookFeed, type MarketWsEvent } from "../../src/feeds/polymarket-ws.js";
import { ChainlinkFeed, type ChainlinkEvent } from "../../src/feeds/chainlink-feed.js";
import { createLogger } from "../../src/observability/logger.js";

const log = createLogger({ level: "error", write: () => {} });

/** An async iterable that yields scripted events, then ends (or throws). */
function scripted<T>(events: T[], opts: { throwAfter?: boolean } = {}) {
  return {
    close: async () => {},
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
      if (opts.throwAfter) throw new Error("socket closed");
    },
  };
}

const bookEvent = (assetId: string, asks: [string, string][]): MarketWsEvent => ({
  type: "book",
  payload: { assetId, bids: [], asks: asks.map(([price, size]) => ({ price, size })) },
});

describe("BookFeed", () => {
  it("applies a snapshot then deltas, and reports staleness", () => {
    let now = 1_000;
    const books: string[] = [];
    const feed = new BookFeed({
      assetIds: ["UP"], subscribe: async () => scripted([]), now: () => now, log,
      handlers: { onBook: (b) => books.push(b.asks.map((l) => `${l.price}x${l.size}`).join(",")) },
    });
    expect(feed.ageMs()).toBe(Number.POSITIVE_INFINITY);

    feed.dispatch(bookEvent("UP", [["0.995", "7"], ["0.990", "5"]]));
    expect(books.at(-1)).toBe("0.99x5,0.995x7");

    now = 1_050;
    feed.dispatch({ type: "price_change", payload: { changes: [{ assetId: "UP", price: "0.990", size: "0", side: "SELL" }] } });
    expect(books.at(-1)).toBe("0.995x7");
    expect(feed.ageMs()).toBe(0);
    now = 1_900;
    expect(feed.ageMs()).toBe(850);
  });

  it("ignores deltas for an asset without a snapshot", () => {
    const onBook = vi.fn();
    const feed = new BookFeed({ assetIds: ["UP"], subscribe: async () => scripted([]), now: () => 0, log, handlers: { onBook } });
    feed.dispatch({ type: "price_change", payload: { changes: [{ assetId: "UP", price: "0.5", size: "1", side: "BUY" }] } });
    expect(onBook).not.toHaveBeenCalled();
  });

  it("reconnects after the stream ends or throws", async () => {
    const subscribe = vi
      .fn()
      .mockResolvedValueOnce(scripted([bookEvent("UP", [["0.99", "1"]])], { throwAfter: true }))
      .mockResolvedValueOnce(scripted([bookEvent("UP", [["0.98", "1"]])]))
      .mockImplementation(async () => scripted<MarketWsEvent>([]));
    const reconnects: number[] = [];
    const seen: number[] = [];
    const feed = new BookFeed({
      assetIds: ["UP"], subscribe, now: () => 0, log, reconnectBaseMs: 1, reconnectMaxMs: 2,
      handlers: { onBook: (b) => seen.push(b.asks[0]!.price), onReconnect: (n) => reconnects.push(n) },
    });
    feed.start();
    await vi.waitFor(() => expect(seen).toEqual([0.99, 0.98]));
    await feed.stop();
    expect(reconnects[0]).toBe(1);
    expect(subscribe.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("ChainlinkFeed", () => {
  const ev = (value: string | number, ts: number, symbol = "btc/usd"): ChainlinkEvent => ({ type: "update", payload: { symbol, timestamp: ts, value } });

  it("parses decimal strings, filters by symbol and drops older samples", () => {
    const ticks: number[] = [];
    const feed = new ChainlinkFeed({ symbol: "btc/usd", subscribe: async () => scripted([]), onTick: (t) => ticks.push(t.price), now: () => 5, log });
    feed.dispatch(ev("100123.45", 10));
    feed.dispatch(ev(99_000, 9));            // older: ignored
    feed.dispatch(ev("1", 11, "eth/usd"));   // other symbol: ignored
    feed.dispatch(ev("nope", 12));           // unparsable: ignored
    feed.dispatch(ev(100_200, 12));
    expect(ticks).toEqual([100123.45, 100_200]);
    expect(feed.latest()?.ts).toBe(12);
  });

  it("measures age from local receive time", () => {
    let now = 0;
    const feed = new ChainlinkFeed({ symbol: "btc/usd", subscribe: async () => scripted([]), onTick: () => {}, now: () => now, log });
    expect(feed.ageMs()).toBe(Number.POSITIVE_INFINITY);
    feed.dispatch(ev(1, 1));
    now = 700;
    expect(feed.ageMs()).toBe(700);
  });
});

describe("BookFeed trades", () => {
  it("forwards last_trade_price as a numeric trade with the taker side, and drops unusable ones", () => {
    const trades: unknown[] = [];
    const feed = new BookFeed({ assetIds: ["UP"], subscribe: async () => scripted([]), now: () => 5, log, handlers: { onBook: () => {}, onTrade: (t) => trades.push(t) } });
    feed.dispatch({ type: "last_trade_price", payload: { assetId: "UP", price: "0.99", size: "307.5", side: "SELL", timestamp: 1789994438054 } });
    expect(trades).toEqual([{ assetId: "UP", price: 0.99, size: 307.5, side: "SELL", tsMs: 1789994438054 }]);
    feed.dispatch({ type: "last_trade_price", payload: { assetId: "UP", price: "0.99", size: null, side: "SELL" } });
    feed.dispatch({ type: "last_trade_price", payload: { assetId: "UP", price: "x", size: "1", side: "BUY" } });
    expect(trades).toHaveLength(1);
    expect(feed.ageMs()).toBe(0);
  });
});

describe("BookFeed server time", () => {
  it("forwards millisecond timestamps from market events for drift tracking", () => {
    const seen: number[] = [];
    const feed = new BookFeed({
      assetIds: ["UP"], subscribe: async () => scripted([]), now: () => 0, log,
      handlers: { onBook: () => {}, onServerTime: (ms) => seen.push(ms) },
    });
    feed.dispatch({ type: "book", payload: { assetId: "UP", bids: [], asks: [], timestamp: 1789994438054 } });
    feed.dispatch({ type: "price_change", payload: { priceChanges: [], timestamp: 1789994438086 } });
    feed.dispatch({ type: "book", payload: { assetId: "UP", bids: [], asks: [], timestamp: null } });
    expect(seen).toEqual([1789994438054, 1789994438086]);
  });
});
