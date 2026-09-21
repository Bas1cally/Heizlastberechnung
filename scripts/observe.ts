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
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  await current?.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

while (!shuttingDown) {
  const market = await findCurrentMarket(client as unknown as DiscoveryClient, cfg.discovery, clock.wall());
  if (!market) {
    log.warn("no BTC 5-minute market found; retrying in 10s (check `pnpm discover` and MARKET_* settings)");
    await new Promise((r) => setTimeout(r, 10_000));
    continue;
  }
  const waitMs = market.openedAtMs - clock.wall();
  if (waitMs > 0) {
    log.info("next market not open yet", { slug: market.slug, opensInS: Math.round(waitMs / 1000) });
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 30_000)));
    continue;
  }

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
