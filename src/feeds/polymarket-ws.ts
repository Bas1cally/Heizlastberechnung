import type { OrderBook } from "../market/types.js";
import type { Logger } from "../observability/logger.js";
import { applyLevelChange, normalizeBook } from "./book-normalizer.js";

/**
 * Market-data subscription over the SDK's realtime channel.
 *
 * The SDK call is injected (`subscribe`) so the feed can be driven by a
 * scripted event stream in tests. Event shapes below are the transformed
 * payloads declared in @polymarket/bindings/dist/subscriptions/index.d.ts.
 *
 * Assumption, unverifiable from the types: a `book` event is a full snapshot
 * and `price_change` carries level deltas (size 0 = remove). That is standard
 * CLOB semantics and matches the payload shapes; confirm on first live run.
 */
export interface BookEvent {
  readonly type: "book";
  readonly payload: {
    readonly assetId: string;
    readonly bids: readonly { price: string; size: string }[];
    readonly asks: readonly { price: string; size: string }[];
    readonly timestamp?: number | null;
  };
}
export interface PriceChangeEvent {
  readonly type: "price_change";
  readonly payload: {
    readonly changes?: readonly { assetId: string; price: string; size: string; side: "BUY" | "SELL" }[];
    readonly priceChanges?: readonly { assetId: string; price: string; size: string; side: "BUY" | "SELL" }[];
    readonly timestamp?: number | null;
  };
}
export interface ResolvedEvent {
  readonly type: "market_resolved";
  readonly payload: { readonly conditionId: string; readonly winningAssetId?: string | null; readonly winningOutcome?: string | null };
}
export type MarketWsEvent = BookEvent | PriceChangeEvent | ResolvedEvent | { readonly type: string; readonly payload?: unknown };

export interface SubscriptionLike<T> extends AsyncIterable<T> {
  close(): Promise<void>;
}
export type SubscribeFn = (assetIds: readonly string[]) => Promise<SubscriptionLike<MarketWsEvent>>;

export interface BookFeedHandlers {
  onBook(book: OrderBook): void;
  onResolved?(ev: ResolvedEvent["payload"]): void;
  onReconnect?(attempt: number): void;
}

export interface BookFeedOptions {
  readonly assetIds: readonly string[];
  readonly subscribe: SubscribeFn;
  readonly handlers: BookFeedHandlers;
  readonly now: () => number;
  readonly log: Logger;
  /** Called whenever the stream ends or throws, before reconnecting. */
  readonly onStreamError?: (reason: string) => void;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
}

export class BookFeed {
  private books = new Map<string, OrderBook>();
  private lastMessageAtMs = Number.NaN;
  private stopped = false;
  private handle: SubscriptionLike<MarketWsEvent> | undefined;
  private loop: Promise<void> | undefined;

  constructor(private readonly opts: BookFeedOptions) {}

  /** ms since the last message; Infinity before the first. */
  ageMs(): number {
    return Number.isNaN(this.lastMessageAtMs) ? Number.POSITIVE_INFINITY : this.opts.now() - this.lastMessageAtMs;
  }

  book(assetId: string): OrderBook | undefined {
    return this.books.get(assetId);
  }

  start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.handle?.close().catch(() => undefined);
    await this.loop;
  }

  private async run(): Promise<void> {
    const base = this.opts.reconnectBaseMs ?? 250;
    const max = this.opts.reconnectMaxMs ?? 10_000;
    let attempt = 0;
    while (!this.stopped) {
      try {
        this.handle = await this.opts.subscribe(this.opts.assetIds);
        if (attempt > 0) this.opts.handlers.onReconnect?.(attempt);
        attempt = 0;
        for await (const ev of this.handle) {
          if (this.stopped) break;
          this.dispatch(ev);
        }
        if (!this.stopped) { this.opts.log.warn("market ws ended, reconnecting"); this.opts.onStreamError?.("stream ended"); }
      } catch (err) {
        if (this.stopped) break;
        this.opts.log.warn("market ws error, reconnecting", { err });
        this.opts.onStreamError?.(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      }
      if (this.stopped) break;
      attempt++;
      const delay = Math.min(max, base * 2 ** Math.min(attempt, 8));
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  /** Exposed for tests: feed one event as if it arrived from the socket. */
  dispatch(ev: MarketWsEvent): void {
    const now = this.opts.now();
    this.lastMessageAtMs = now;
    switch (ev.type) {
      case "book": {
        const p = (ev as BookEvent).payload;
        const book = normalizeBook({ assetId: p.assetId, bids: p.bids, asks: p.asks, receivedAtMs: now });
        this.books.set(p.assetId, book);
        this.opts.handlers.onBook(book);
        return;
      }
      case "price_change": {
        const p = (ev as PriceChangeEvent).payload;
        const changes = p.changes ?? p.priceChanges ?? [];
        const touched = new Set<string>();
        for (const c of changes) {
          const prev = this.books.get(c.assetId);
          if (!prev) continue; // no snapshot yet: deltas without a base are meaningless
          const next = applyLevelChange(prev, c.side, Number(c.price), Number(c.size), now);
          this.books.set(c.assetId, next);
          touched.add(c.assetId);
        }
        for (const id of touched) this.opts.handlers.onBook(this.books.get(id)!);
        return;
      }
      case "market_resolved":
        this.opts.handlers.onResolved?.((ev as ResolvedEvent).payload);
        return;
      default:
        return;
    }
  }
}
