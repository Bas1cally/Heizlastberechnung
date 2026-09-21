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
import { chainlinkSubscribe, marketSubscribe, type RealtimeClientLike } from "../src/feeds/sdk-subscriptions.js";
import { MarketObserver } from "../src/app/observer.js";

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
const repo = new DecisionRepository(openDatabase(cfg.databaseUrl));
const jevCall = createJevCall({ apiKey: cfg.typesafeApiKey, model: cfg.typesafeModel, timeoutMs: cfg.limits.maxJevLatencyMs * 2 });

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
  try { await current?.stop(); } catch (err) { log.warn("stop failed", { err }); }
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

while (!shuttingDown) {
  const now = clock.wall();
  const found = await findCurrentMarket(client as unknown as DiscoveryClient, now, cfg.marketDurationSeconds);
  if (!found) {
    // Not listed yet, closed, or not accepting orders: wait for the boundary
    // (or 5s, whichever is sooner) and look again.
    const w = windowAt(now, cfg.marketDurationSeconds);
    const untilNext = Math.max(1_000, Math.min(5_000, nextWindow(now, cfg.marketDurationSeconds).openedAtMs - now));
    log.warn("current window not tradable; waiting", { slug: w.slug, retryInS: Math.round(untilNext / 1000) });
    await new Promise((r) => setTimeout(r, untilNext));
    continue;
  }
  const market = found.identity;

  log.info("observing market", { slug: market.slug, closesInS: Math.round((market.closesAtMs - clock.wall()) / 1000), up: market.upAssetId, down: market.downAssetId });
  current = new MarketObserver(
    { cfg, log: log.child({ market: market.slug }), clock, repo, jevCall,
      marketSubscribe: marketSubscribe(client as unknown as RealtimeClientLike),
      chainlinkSubscribe: chainlinkSubscribe(client as unknown as RealtimeClientLike) },
    market,
  );
  await current.run();
  log.info("market finished", { slug: market.slug, decisions: current.decisionCount(), latency: current.latencyReport() });
  current = undefined;
}
