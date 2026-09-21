/**
 * Phase 4: shadow execution (brief §39). Everything the live path does -
 * discovery, feeds, Jev, risk gate, order construction, SIGNING - and stops
 * immediately before submission. Measures whether the edge survives the
 * real path.
 *
 *   pnpm bot:shadow
 *
 * Needs POLYMARKET_PRIVATE_KEY (for signing) and TYPESAFE_API_KEY. Never
 * calls postOrder: the signer it builds has no reference to it.
 */
import { createPublicClient, createSecureClient } from "@polymarket/client";
import { privateKey } from "@polymarket/client/viem";
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
import { ShadowEngine } from "../src/execution/shadow-engine.js";
import { sdkSigner, signingSurface } from "../src/execution/sdk-signer.js";
import { buildOrders } from "../src/execution/order-builder.js";
import { DEFAULT_FILL_PARAMS } from "../src/replay/paper-fill-model.js";
import type { Urgency } from "../src/jev/decision-types.js";

loadEnvFile();
const cfg = loadConfig();
const log = createLogger({ level: (process.env["LOG_LEVEL"] as never) ?? "info" });

if (!cfg.typesafeApiKey) { log.error("TYPESAFE_API_KEY is not set"); process.exit(1); }
if (cfg.mode === "live") { log.error("bot:shadow refuses --mode live; use bot:live once it exists"); process.exit(1); }
const pk = process.env["POLYMARKET_PRIVATE_KEY"]?.trim();
if (!pk) { log.error("POLYMARKET_PRIVATE_KEY is not set; shadow mode signs real orders and needs a key"); process.exit(1); }

const clock = createClock();
const publicClient = createPublicClient();
const tape = new PriceTape({
  symbol: cfg.chainlinkSymbol, spotSubscribe: chainlinkSubscribe(publicClient as unknown as RealtimeClientLike), twapSubscribe: chainlinkTwapSubscribe(publicClient as unknown as RealtimeClientLike, cfg.chainlinkTwapSeconds),
  mono: clock.mono, wall: clock.wall, log: log.child({ feed: "tape" }),
});
tape.start();
const startPriceFor = async (openedAtMs: number) => {
  const s = await tape.waitForStart(openedAtMs);
  return s.twap ? { price: s.twap.price, ts: s.twap.ts, source: `chainlink-twap${cfg.chainlinkTwapSeconds}` } : undefined;
};
const wallet = process.env["POLYMARKET_DEPOSIT_WALLET"]?.trim();
const secure = await createSecureClient({ signer: privateKey(pk), ...(wallet ? { wallet } : {}) });
// The signer is built from the two signing methods only; postOrder is never referenced.
const signer = sdkSigner(signingSurface(secure));
const repo = new DecisionRepository(openDatabase(cfg.databaseUrl));
const jevCall = createJevCall({ apiKey: cfg.typesafeApiKey, model: cfg.typesafeModel, timeoutMs: 5_000 });

log.info("shadow starting", { db: cfg.databaseUrl, model: cfg.typesafeModel ?? "jev-latest", wallet: wallet ?? "(deposit wallet derived from signer)" });

let current: MarketObserver | undefined;
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) { process.exit(130); }
  shuttingDown = true;
  log.info("shutting down - press Ctrl+C again to force", { signal });
  setTimeout(() => process.exit(0), 3_000).unref();
  try { await current?.stop(); await tape.stop(); } catch { /* exiting anyway */ }
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
    found = await findCurrentMarket(publicClient as unknown as DiscoveryClient, now, cfg.marketDurationSeconds);
  } catch (err) {
    log.error("market discovery failed; retrying in 5s", { err });
    try { repo.saveError("discovery", err instanceof Error ? `${err.name}: ${err.message}` : String(err), null, now); repo.heartbeat("shadow", { phase: "waiting", market: "discovery-error", decisions: 0, killed: false }, now); } catch { /* db unavailable; keep going */ }
    await new Promise((r) => setTimeout(r, 5_000));
    continue;
  }
  if (!found) {
    const untilNext = Math.max(1_000, Math.min(5_000, nextWindow(now, cfg.marketDurationSeconds).openedAtMs - now));
    log.warn("current window not tradable; waiting", { slug: windowAt(now, cfg.marketDurationSeconds).slug, retryInS: Math.round(untilNext / 1000) });
    await new Promise((r) => setTimeout(r, untilNext));
    continue;
  }
  const market = found.identity;
  const mlog = log.child({ market: market.slug, mode: "shadow" });
  let shadowRecords = 0;

  const engine = new ShadowEngine({
    signer, mono: clock.mono, assumedSubmitToAckMs: 150, fill: DEFAULT_FILL_PARAMS,
    onRecord: (r) => {
      shadowRecords++;
      repo.saveShadowOrder(market.marketId, clock.wall(), {
        decisionId: r.decisionId, side: r.intent.side, assetId: r.intent.assetId, orderType: r.intent.style.type, price: r.intent.price, size: r.intent.size,
        signed: !!r.signed, signError: r.signError, signingMs: r.stamps.signingCompletedMono - r.stamps.signingStartedMono, expectedPrice: r.expectedPrice,
        priceAtAck: r.priceAtAck, movedAgainstBps: r.movedAgainstBps, status: r.hypotheticalFill?.status, filled: r.hypotheticalFill?.filledQty, avgPrice: r.hypotheticalFill?.avgPrice,
      });
      mlog.info("shadow order", {
        decisionId: r.decisionId, side: r.intent.side, type: r.intent.style.type, price: r.intent.price, size: r.intent.size,
        signed: !!r.signed, signError: r.signError, signingMs: Number((r.stamps.signingCompletedMono - r.stamps.signingStartedMono).toFixed(1)),
        expectedPrice: r.expectedPrice, priceAtAck: r.priceAtAck, movedAgainstBps: r.movedAgainstBps === undefined ? undefined : Number(r.movedAgainstBps.toFixed(1)),
        wouldHave: r.hypotheticalFill?.status, filled: r.hypotheticalFill?.filledQty, at: r.hypotheticalFill?.avgPrice,
      });
    },
  });

  log.info("shadowing market", { slug: market.slug, closesInS: Math.round((market.closesAtMs - clock.wall()) / 1000) });
  current = new MarketObserver(
    {
      cfg, log: mlog, clock, repo, jevCall,
      marketSubscribe: marketSubscribe(publicClient as unknown as RealtimeClientLike),
      chainlinkSubscribe: chainlinkSubscribe(publicClient as unknown as RealtimeClientLike),
      chainlinkTwapSubscribe: chainlinkTwapSubscribe(publicClient as unknown as RealtimeClientLike, cfg.chainlinkTwapSeconds),
      settlementStart: await startPriceFor(market.openedAtMs),
      executionMode: "simulated",
      processName: "shadow",
      onKill: (state) => { mlog.error("kill: no further orders will be signed", { reasons: state.reasons }); engine.flush(() => undefined); },
      onBookUpdate: (book, nowMono) => engine.onBook(book, nowMono),
      onApproved: (d, snap, decisionMono) => {
        const inv = snap.inventory;
        const allowance = Math.max(0, Math.min(cfg.limits.maxMarketExposureUsd - inv.totalCost, cfg.limits.maxTotalExposureUsd - inv.totalCost));
        const intents = buildOrders(d.requestedAction, d.answers.execution_urgency.choice as Urgency, snap, {
          maxOrderSizeShares: cfg.limits.maxOrderSizeShares, riskAllowanceUsd: allowance, tickSize: market.tickSize ?? 0.001, minOrderSize: market.minOrderSize ?? 5,
        });
        if (intents.length === 0) return;
        return engine.submit(d.decisionId, intents, (assetId) => (assetId === market.upAssetId ? snap.upBook : snap.downBook), decisionMono);
      },
    },
    market,
  );
  try {
    await current.run();
  } catch (err) {
    log.error("market run failed; moving on", { err });
    try { repo.saveError("observer", err instanceof Error ? `${err.name}: ${err.message}` : String(err), market.marketId, clock.wall()); } catch { /* keep going */ }
    await current.stop().catch(() => undefined);
  }
  engine.flush((assetId) => (assetId === market.upAssetId ? undefined : undefined));
  log.info("market finished", { slug: market.slug, decisions: current.decisionCount(), shadowOrders: shadowRecords, latency: current.latencyReport() });
  current = undefined;
}
