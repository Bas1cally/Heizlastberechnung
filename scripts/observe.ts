/**
 * Phase 1: live observer. Discovers the current BTC 5-minute market, streams
 * its books and the Chainlink settlement price, sends material state changes
 * to Jev, records every decision and latency, and rolls to the next market.
 *
 *   pnpm bot:observe
 *
 * No order is ever built in this script, in any configuration.
 */
import { createPublicClient } from "@polymarket/client";
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { createLogger } from "../src/observability/logger.js";
import { createClock } from "../src/feeds/clock.js";
import { createJevCall } from "../src/jev/client.js";
import { openDatabase } from "../src/persistence/database.js";
import { DecisionRepository } from "../src/persistence/repositories/decisions.js";
import { findCurrentMarket, type DiscoveryClient } from "../src/market/market-discovery.js";
import { nextWindow, windowAt } from "../src/market/window.js";
import { chainlinkSubscribe, chainlinkTwapSubscribe, marketSubscribe, type RealtimeClientLike } from "../src/feeds/sdk-subscriptions.js";
import { MarketObserver } from "../src/app/observer.js";
import { PriceTape } from "../src/feeds/price-tape.js";

loadEnvFile();
const cfg = loadConfig();
const log = createLogger({ level: (process.env["LOG_LEVEL"] as never) ?? "info" });

if (!cfg.typesafeApiKey) {
  log.error("TYPESAFE_API_KEY is not set");
  process.exit(1);
}
if (cfg.mode !== "observe") {
  log.error(`bot:observe only runs in observe mode (got ${cfg.mode}); no other mode is implemented yet`);
  process.exit(1);
}

const clock = createClock();
const client = createPublicClient();
// Listens to the settlement streams for the whole process, so every market's
// start price is the tick AT its open second, not the first tick the market's
// own observer happens to see after discovery (src/feeds/price-tape.ts).
const tape = new PriceTape({
  symbol: cfg.chainlinkSymbol, spotSubscribe: chainlinkSubscribe(client as unknown as RealtimeClientLike), twapSubscribe: chainlinkTwapSubscribe(client as unknown as RealtimeClientLike, cfg.chainlinkTwapSeconds),
  mono: clock.mono, wall: clock.wall, log: log.child({ feed: "tape" }),
});
tape.start();
// Not awaited: the observer starts at once and takes the tape's value when it
// lands (the TWAP stream can lag the open by several seconds).
const startPriceFor = (openedAtMs: number) => tape.waitForStart(openedAtMs, 12_000)
  .then((s) => (s.twap ? { price: s.twap.price, ts: s.twap.ts, source: `chainlink-twap${cfg.chainlinkTwapSeconds}` } : undefined));
const repo = new DecisionRepository(openDatabase(cfg.databaseUrl));
const jevCall = createJevCall({ apiKey: cfg.typesafeApiKey, model: cfg.typesafeModel, timeoutMs: 5_000 });

log.info("observer starting", { mode: cfg.mode, liveTradingEnabled: cfg.liveTradingEnabled, db: cfg.databaseUrl, model: cfg.typesafeModel ?? "jev-latest" });

let current: MarketObserver | undefined;
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) {
    // Second signal: the operator means it. Do not wait for anything.
    log.warn("forced exit");
    process.exit(130);
  }
  shuttingDown = true;
  log.info("shutting down - press Ctrl+C again to force", { signal });
  // A socket that refuses to close must not keep the process alive.
  const deadline = setTimeout(() => { log.warn("shutdown timed out, exiting"); process.exit(0); }, 3_000);
  deadline.unref();
  try { await current?.stop(); await tape.stop(); } catch (err) { log.warn("stop failed", { err }); }
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

while (!shuttingDown) {
  const now = clock.wall();
  // A transport error here (a Gamma timeout, a DNS hiccup) is not a reason
  // to exit: log it, record it, wait, try again.
  let found: Awaited<ReturnType<typeof findCurrentMarket>>;
  try {
    found = await findCurrentMarket(client as unknown as DiscoveryClient, now, cfg.marketDurationSeconds);
  } catch (err) {
    log.error("market discovery failed; retrying in 5s", { err });
    try { repo.saveError("discovery", err instanceof Error ? `${err.name}: ${err.message}` : String(err), null, now); repo.heartbeat("observer", { phase: "waiting", market: "discovery-error", decisions: 0, killed: false }, now); } catch { /* db unavailable; keep going */ }
    await new Promise((r) => setTimeout(r, 5_000));
    continue;
  }
  if (!found) {
    // Not listed yet, closed, or not accepting orders: wait for the boundary
    // (or 5s, whichever is sooner) and look again.
    const w = windowAt(now, cfg.marketDurationSeconds);
    const untilNext = Math.max(1_000, Math.min(5_000, nextWindow(now, cfg.marketDurationSeconds).openedAtMs - now));
    log.warn("current window not tradable; waiting", { slug: w.slug, retryInS: Math.round(untilNext / 1000) });
    try { repo.heartbeat("observer", { phase: "waiting", market: w.slug, decisions: 0, killed: false }, now); } catch { /* dashboard only */ }
    await new Promise((r) => setTimeout(r, untilNext));
    continue;
  }
  const market = found.identity;

  log.info("observing market", { slug: market.slug, closesInS: Math.round((market.closesAtMs - clock.wall()) / 1000), up: market.upAssetId, down: market.downAssetId });
  current = new MarketObserver(
    { cfg, log: log.child({ market: market.slug }), clock, repo, jevCall,
      marketSubscribe: marketSubscribe(client as unknown as RealtimeClientLike),
      chainlinkSubscribe: chainlinkSubscribe(client as unknown as RealtimeClientLike),
      chainlinkTwapSubscribe: chainlinkTwapSubscribe(client as unknown as RealtimeClientLike, cfg.chainlinkTwapSeconds),
      settlementStart: startPriceFor(market.openedAtMs) },
    market,
  );
  try {
    await current.run();
  } catch (err) {
    log.error("market run failed; moving on", { err });
    try { repo.saveError("observer", err instanceof Error ? `${err.name}: ${err.message}` : String(err), market.marketId, clock.wall()); } catch { /* keep going */ }
    await current.stop().catch(() => undefined);
  }
  log.info("market finished", { slug: market.slug, decisions: current.decisionCount(), latency: current.latencyReport() });
  current = undefined;
}
