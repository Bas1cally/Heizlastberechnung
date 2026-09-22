import { loadConfig } from "../../src/app/config.js";
import { createLogger } from "../../src/observability/logger.js";
import type { MarketWsEvent } from "../../src/feeds/polymarket-ws.js";
import type { ChainlinkEvent } from "../../src/feeds/chainlink-feed.js";
import type { JevAnswers, JevInputState } from "../../src/jev/decision-types.js";
import type { MarketIdentity } from "../../src/market/market-state.js";

export const quietLog = () => createLogger({ level: "error", write: () => {} });

/** Config for a fast test market: low limits, no request floor, no warm-up surprises. */
export const testConfig = () => {
  const cfg = loadConfig({
    TYPESAFE_API_KEY: "test", MAX_MARKET_EXPOSURE_USD: "100", MAX_TOTAL_EXPOSURE_USD: "100", MAX_UNPAIRED_EXPOSURE_USD: "100",
    JEV_MIN_INTERVAL_MS: "100", JEV_COALESCE_MS: "5", JEV_HEARTBEAT_MS: "400",
  }, []);
  // The scripted Jev of these tests buys directionally; the default gate refuses that (limits.ts), so it is enabled here on purpose.
  return { ...cfg, limits: { ...cfg.limits, maxOrderSizeShares: 10, minMarketLiquidityShares: 10, allowDirectionalBuys: true } };
};

export function identityFor(now: number, closesInMs: number): MarketIdentity {
  const openedAt = now - 1_000;
  return { marketId: "m-int", conditionId: "0xcond", slug: `btc-updown-5m-${Math.floor(openedAt / 1000)}`, question: "BTC up or down?", upAssetId: "UP", downAssetId: "DOWN", openedAtMs: openedAt, closesAtMs: now + closesInMs, tickSize: 0.01, minOrderSize: 5 };
}

/**
 * A scripted stream: `script` is called on each pull with the elapsed ms and
 * returns the next event (after a wait) or `undefined` to end the stream.
 * `close()` ends it early, the way the SDK's handle does.
 */
export function stream<T>(script: (elapsedMs: number, n: number) => Promise<T | undefined>) {
  let closed = false;
  const started = Date.now();
  return {
    close: async () => { closed = true; },
    async *[Symbol.asyncIterator]() {
      for (let n = 0; !closed; n++) {
        const ev = await script(Date.now() - started, n);
        if (ev === undefined || closed) return;
        yield ev;
      }
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const bookEvent = (assetId: string, bid: number, ask: number, size = 100): MarketWsEvent => ({
  type: "book", payload: { assetId, bids: [{ price: String(bid), size: String(size) }], asks: [{ price: String(ask), size: String(size) }] },
});
export const resolvedEvent = (winningOutcome: string): MarketWsEvent => ({ type: "market_resolved", payload: { conditionId: "0xcond", winningOutcome } });
export const chainlinkEvent = (value: number): ChainlinkEvent => ({ type: "update", payload: { symbol: "btc/usd", timestamp: Date.now(), value } });

/** Book stream: both sides every `everyMs`, optionally a resolution at `resolveAtMs`, then silence until closed. */
export function bookStream(o: { everyMs?: number; upAsk?: number; downAsk?: number; resolveAtMs?: number; winner?: string; failFirst?: boolean } = {}) {
  let calls = 0;
  let resolved = false;
  return async () => {
    calls++;
    if (o.failFirst && calls === 1) throw new Error("TransportError: fetch failed (simulated Polymarket outage)");
    return stream<MarketWsEvent>(async (elapsed, n) => {
      if (o.resolveAtMs !== undefined && elapsed >= o.resolveAtMs && !resolved) { resolved = true; return resolvedEvent(o.winner ?? "Up"); }
      if (n > 0) await sleep(o.everyMs ?? 100);
      const upAsk = o.upAsk ?? 0.45, downAsk = o.downAsk ?? 0.56;
      return n % 2 === 0 ? bookEvent("UP", upAsk - 0.01, upAsk) : bookEvent("DOWN", downAsk - 0.01, downAsk);
    });
  };
}

/** Price stream: one tick every `everyMs`, price path from `priceAt(elapsed)`. */
export function priceStream(priceAt: (elapsedMs: number) => number, everyMs = 100) {
  return async () => stream<ChainlinkEvent>(async (elapsed, n) => { if (n > 0) await sleep(everyMs); return chainlinkEvent(priceAt(elapsed)); });
}

const choice = (c: string, probabilities: Record<string, number>, confidence = 0.9) => ({ type: "choice", choice: c, confidence, probabilities });
const score = (s: number) => ({ type: "score", score: s, confidence: 0.8, legend: {}, probabilities: {} });
export const answersFor = (action: string, urgency = "IMMEDIATE", inventory = "NONE", pUp = 0.8): JevAnswers => ({
  action: choice(action, { [action]: 1 }), settlement_direction: choice(pUp >= 0.5 ? "UP" : "DOWN", { UP: pUp, DOWN: 1 - pUp - 0.05, UNRESOLVED: 0.05 }),
  market_mispricing: choice("NONE", { NONE: 1 }), inventory_action: choice(inventory, { [inventory]: 1 }), execution_urgency: choice(urgency, { [urgency]: 1 }),
  winner_confidence: score(3), reversal_risk: score(1), adverse_selection_risk: score(1),
}) as unknown as JevAnswers;

/** A deterministic stand-in for Jev: a pure function of the state. */
export const scriptedJev = (script: (state: JevInputState, n: number) => JevAnswers) => {
  let n = 0;
  const seen: JevInputState[] = [];
  const call = async (state: JevInputState) => { seen.push(state); return { answers: script(state, n++), model: "scripted", usage: { input_tokens: 10, output_tokens: 2 } }; };
  return { call, seen };
};
