import { ChainlinkFeed, type ChainlinkSubscribeFn, type ChainlinkTick } from "./chainlink-feed.js";
import type { Logger } from "../observability/logger.js";

/**
 * A process-level tape of the settlement streams, independent of any market.
 *
 * The market's start price is the value AT the open second. A market
 * observer only exists once discovery has found the market, which is after
 * the open (and after the previous market's grace period): the first tick it
 * sees is late, and BTC moves several bps in those seconds. Every observer
 * therefore takes its start price from this tape, which was already
 * listening when the window opened.
 */
export interface TapeTick { readonly ts: number; readonly price: number; readonly receivedAtMs: number }

export interface StartPrices {
  readonly twap: TapeTick | undefined;
  readonly spot: TapeTick | undefined;
}

export interface PriceTapeOptions {
  readonly symbol: string;
  readonly spotSubscribe: ChainlinkSubscribeFn;
  readonly twapSubscribe?: ChainlinkSubscribeFn;
  readonly mono: () => number;
  readonly wall: () => number;
  readonly log: Logger;
  /** How much history to keep. Default 15 minutes. */
  readonly keepMs?: number;
  readonly onStreamError?: (source: "chainlink" | "chainlink-twap", reason: string) => void;
}

export class PriceTape {
  private readonly spot: ChainlinkFeed;
  private readonly twap: ChainlinkFeed | undefined;
  private readonly spotTicks: TapeTick[] = [];
  private readonly twapTicks: TapeTick[] = [];
  private readonly keepMs: number;

  constructor(private readonly o: PriceTapeOptions) {
    this.keepMs = o.keepMs ?? 15 * 60_000;
    const push = (arr: TapeTick[]) => (t: ChainlinkTick) => {
      arr.push({ ts: t.ts, price: t.price, receivedAtMs: o.wall() });
      const cutoff = o.wall() - this.keepMs;
      while (arr.length && arr[0]!.receivedAtMs < cutoff) arr.shift();
    };
    this.spot = new ChainlinkFeed({ symbol: o.symbol, subscribe: o.spotSubscribe, now: o.mono, log: o.log.child({ feed: "tape-spot" }), onTick: push(this.spotTicks), ...(o.onStreamError ? { onStreamError: (r: string) => o.onStreamError!("chainlink", r) } : {}) });
    this.twap = o.twapSubscribe
      ? new ChainlinkFeed({ symbol: o.symbol, subscribe: o.twapSubscribe, now: o.mono, log: o.log.child({ feed: "tape-twap" }), onTick: push(this.twapTicks), ...(o.onStreamError ? { onStreamError: (r: string) => o.onStreamError!("chainlink-twap", r) } : {}) })
      : undefined;
  }

  start(): void { this.spot.start(); this.twap?.start(); }
  async stop(): Promise<void> { await Promise.all([this.spot.stop(), this.twap?.stop()]); }

  /** Exposed for tests: feed ticks directly. */
  push(source: "spot" | "twap", tick: TapeTick): void { (source === "spot" ? this.spotTicks : this.twapTicks).push(tick); }

  /** First tick of each stream whose feed timestamp is at or after `openedAtMs`. */
  startAt(openedAtMs: number): StartPrices {
    const first = (arr: readonly TapeTick[]) => arr.find((t) => t.ts >= openedAtMs);
    return { twap: first(this.twapTicks), spot: first(this.spotTicks) };
  }

  /** Waits briefly for the open-second tick when the observer starts inside that same second. */
  async waitForStart(openedAtMs: number, maxWaitMs = 2_500, wantTwap = !!this.twap): Promise<StartPrices> {
    const deadline = this.o.mono() + maxWaitMs;
    for (;;) {
      const s = this.startAt(openedAtMs);
      if (wantTwap ? s.twap : s.spot) return s;
      if (this.o.mono() >= deadline) return s;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  ages(): { spotMs: number; twapMs: number } { return { spotMs: this.spot.ageMs(), twapMs: this.twap?.ageMs() ?? Number.POSITIVE_INFINITY }; }
}
