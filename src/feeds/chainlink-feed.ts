import type { Logger } from "../observability/logger.js";

/**
 * Settlement price from Polymarket's realtime `prices.crypto.chainlink` topic
 * (declared in @polymarket/bindings subscriptions). Payload:
 * { symbol, timestamp (epoch ms), value (decimal string | number) }.
 *
 * This is the price stream Polymarket itself publishes for these markets. No
 * Polygon RPC is needed in observe mode.
 */
export interface ChainlinkTick {
  readonly symbol: string;
  readonly price: number;
  /** Feed timestamp (server), ms. */
  readonly ts: number;
  /** Local receive time, ms. */
  readonly receivedAtMs: number;
}

export interface ChainlinkEvent {
  readonly type: string;
  readonly timestamp?: number;
  readonly payload: { readonly symbol: string; readonly timestamp: number; readonly value: string | number };
}
export interface SubscriptionLike<T> extends AsyncIterable<T> {
  close(): Promise<void>;
}
export type ChainlinkSubscribeFn = (symbols: readonly string[]) => Promise<SubscriptionLike<ChainlinkEvent>>;

/**
 * Which Chainlink stream feeds what. The market rules (read from the live
 * market page) resolve on the 60-second TWAP of BTC/USD, so that stream is
 * the settlement price; the spot stream is for movement features only.
 */
export type ChainlinkSource = "chainlink" | "chainlink-twap60" | "chainlink-twap30";

export interface ChainlinkFeedOptions {
  readonly symbol: string;
  readonly subscribe: ChainlinkSubscribeFn;
  readonly onTick: (tick: ChainlinkTick) => void;
  readonly now: () => number;
  readonly log: Logger;
  /** Called whenever the stream ends or throws, before reconnecting. */
  readonly onStreamError?: (reason: string) => void;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  /**
   * A stream that stays open but goes silent for this long is closed and
   * resubscribed. Observed 2026-09-21: one runner's TWAP stream delivered
   * nothing for a whole market without ever erroring, and the kill switch
   * tripped on CHAINLINK_STALE while the other runners were fine. Default
   * 15 s (the price streams tick every second); 0 disables.
   */
  readonly staleReconnectMs?: number;
}

export class ChainlinkFeed {
  private last: ChainlinkTick | undefined;
  private stopped = false;
  private handle: SubscriptionLike<ChainlinkEvent> | undefined;
  private loop: Promise<void> | undefined;
  /** When the current stream last delivered any event, or was opened. */
  private lastEventMono = Number.NaN;
  private watchdog: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: ChainlinkFeedOptions) {}

  /**
   * Exposed for tests: true (and the stream is being closed for a reconnect)
   * when the open stream has been silent longer than `staleReconnectMs`.
   */
  checkStale(nowMono: number): boolean {
    const limit = this.opts.staleReconnectMs ?? 15_000;
    if (limit <= 0 || this.stopped || !this.handle || Number.isNaN(this.lastEventMono)) return false;
    if (nowMono - this.lastEventMono <= limit) return false;
    this.opts.log.warn("chainlink stream silent, reconnecting", { silentMs: Math.round(nowMono - this.lastEventMono) });
    this.opts.onStreamError?.(`silent for ${Math.round((nowMono - this.lastEventMono) / 1000)} s`);
    const h = this.handle;
    this.handle = undefined;
    this.lastEventMono = Number.NaN;
    void h.close().catch(() => undefined);
    return true;
  }

  latest(): ChainlinkTick | undefined {
    return this.last;
  }

  ageMs(): number {
    return this.last ? this.opts.now() - this.last.receivedAtMs : Number.POSITIVE_INFINITY;
  }

  start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    await this.handle?.close().catch(() => undefined);
    // If the transport does not end its iterator on close, do not hang forever.
    await Promise.race([this.loop, new Promise((r) => setTimeout(r, 2_000))]);
  }

  private async run(): Promise<void> {
    const base = this.opts.reconnectBaseMs ?? 250;
    const max = this.opts.reconnectMaxMs ?? 10_000;
    let attempt = 0;
    if ((this.opts.staleReconnectMs ?? 15_000) > 0) {
      this.watchdog = setInterval(() => this.checkStale(this.opts.now()), 1_000);
      this.watchdog.unref?.();
    }
    while (!this.stopped) {
      try {
        const handle = await this.opts.subscribe([this.opts.symbol]);
        this.handle = handle;
        this.lastEventMono = this.opts.now();
        attempt = 0;
        for await (const ev of handle) {
          if (this.stopped) break;
          this.lastEventMono = this.opts.now();
          this.dispatch(ev);
        }
        if (this.stopped) break;
        if (this.handle === handle) { this.opts.log.warn("chainlink ws ended, reconnecting"); this.opts.onStreamError?.("stream ended"); }
        // else: the watchdog closed it; already reported.
      } catch (err) {
        if (this.stopped) break;
        this.opts.log.warn("chainlink ws error, reconnecting", { err });
        this.opts.onStreamError?.(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      }
      if (this.stopped) break;
      attempt++;
      await new Promise((r) => setTimeout(r, Math.min(max, base * 2 ** Math.min(attempt, 8))));
    }
  }

  /** Exposed for tests. */
  dispatch(ev: ChainlinkEvent): void {
    const p = ev.payload;
    if (!p || p.symbol.toLowerCase() !== this.opts.symbol.toLowerCase()) return;
    const price = Number(p.value);
    if (!Number.isFinite(price) || price <= 0) return;
    const tick: ChainlinkTick = { symbol: p.symbol, price, ts: p.timestamp, receivedAtMs: this.opts.now() };
    if (this.last && tick.ts < this.last.ts) return; // never let an older sample overwrite a newer one
    this.last = tick;
    this.opts.onTick(tick);
  }
}
