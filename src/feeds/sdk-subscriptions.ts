import type { ChainlinkSubscribeFn } from "./chainlink-feed.js";
import type { SubscribeFn } from "./polymarket-ws.js";

/**
 * Bridges the SDK's `client.subscribe([...])` (verified in
 * @polymarket/client types-*.d.ts: returns AsyncIterable + close()) to the
 * narrow subscribe functions the feeds consume. The client is typed loosely
 * on purpose: only `subscribe` is used, and the real event union is far wider
 * than the handful of event types the feeds act on.
 */
export interface RealtimeClientLike {
  subscribe(specs: readonly Record<string, unknown>[]): Promise<AsyncIterable<unknown> & { close(): Promise<void> }>;
}

export function marketSubscribe(client: RealtimeClientLike): SubscribeFn {
  return async (assetIds) => {
    const handle = await client.subscribe([{ topic: "market", assetIds: [...assetIds], customFeatureEnabled: true }]);
    return {
      close: () => handle.close(),
      async *[Symbol.asyncIterator]() {
        for await (const ev of handle) yield ev as never;
      },
    };
  };
}

export function chainlinkSubscribe(client: RealtimeClientLike): ChainlinkSubscribeFn {
  return async (symbols) => {
    const handle = await client.subscribe([{ topic: "prices.crypto.chainlink", symbols: [...symbols] }]);
    return {
      close: () => handle.close(),
      async *[Symbol.asyncIterator]() {
        for await (const ev of handle) yield ev as never;
      },
    };
  };
}
