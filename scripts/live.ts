/**
 * Phase 5: LIMITED LIVE (brief §40). Real orders, real money.
 *
 *   ENABLE_LIVE_TRADING=true in .env  AND  --mode live  AND  POLYMARKET_PRIVATE_KEY
 *   pnpm auto -- live            (or: tsx scripts/live.ts --mode live)
 *
 * Same pipeline as paper, with src/execution/live-engine.ts in place of the
 * simulation: approved decisions are signed and posted through the SDK,
 * resting orders are polled and expired, matched shares are merged, and the
 * winning side is redeemed once the official resolution is known. Limits are
 * the LIVE_* caps (default 5 shares per order, 10 USD per market, 20 USD in
 * total, 10 USD daily loss). The kill switch cancels every resting order and
 * blocks new ones; an inventory mismatch against the exchange is a hard
 * fault that only an operator resume clears. Nothing is ever sold at market
 * to "get flat".
 */
import { createPublicClient, createSecureClient } from "@polymarket/client";
import { privateKey } from "@polymarket/client/viem";
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { createLogger } from "../src/observability/logger.js";
import { teeSink } from "../src/observability/file-sink.js";
import { spawn } from "node:child_process";
import { createClock } from "../src/feeds/clock.js";
import { createJevCall } from "../src/jev/client.js";
import { openDatabase } from "../src/persistence/database.js";
import { DecisionRepository } from "../src/persistence/repositories/decisions.js";
import { findCurrentMarket, type DiscoveryClient } from "../src/market/market-discovery.js";
import { nextWindow, windowAt } from "../src/market/window.js";
import { chainlinkSubscribe, chainlinkTwapSubscribe, marketSubscribe, type RealtimeClientLike } from "../src/feeds/sdk-subscriptions.js";
import { MarketObserver } from "../src/app/observer.js";
import { PriceTape } from "../src/feeds/price-tape.js";
import { createUpdateCheck, EXIT_UPDATE } from "../src/app/self-update.js";
import { buildHoldRateTable, type HoldRateTable } from "../src/analytics/hold-rate.js";
import { LiveEngine, type LiveClientLike } from "../src/execution/live-engine.js";
import type { MarketIdentity } from "../src/market/market-state.js";

loadEnvFile();
const cfg = loadConfig();
const log = createLogger({ level: (process.env["LOG_LEVEL"] as never) ?? "info", write: teeSink("logs/live.log") });

// Every gate, spelled out. Any one missing and this process ends before a client exists.
if (!cfg.typesafeApiKey) { log.error("TYPESAFE_API_KEY is not set"); process.exit(1); }
if (!cfg.liveTradingEnabled || cfg.mode !== "live") {
  log.error("live needs BOTH ENABLE_LIVE_TRADING=true in .env AND --mode live on the command line", { mode: cfg.mode, enableLiveTrading: cfg.liveTradingEnabled });
  process.exit(1);
}
const pk = process.env["POLYMARKET_PRIVATE_KEY"]?.trim();
if (!pk) { log.error("POLYMARKET_PRIVATE_KEY is not set"); process.exit(1); }

const syncChild = process.argv.includes("--no-sync") ? undefined
  : spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/sync.ts", "--every", process.env["SYNC_EVERY_MIN"] ?? "15"], { stdio: "ignore", env: process.env });
syncChild?.on("exit", (code) => log.warn("sync loop exited", { code }));

const clock = createClock();
const publicClient = createPublicClient();
const wallet = process.env["POLYMARKET_DEPOSIT_WALLET"]?.trim();
const secure = await createSecureClient({ signer: privateKey(pk), ...(wallet ? { wallet } : {}) });
// The engine sees exactly the calls it needs (verified in the SDK types); see live-engine.ts.
const liveClient = secure as unknown as LiveClientLike;

// Trading approvals (collateral and conditional-token allowances) must exist before the first order.
try {
  const approvals = await (secure as unknown as { fetchTradingApprovalsState(): Promise<{ isFullyApproved: boolean; missing: unknown }> }).fetchTradingApprovalsState();
  if (!approvals.isFullyApproved) {
    log.warn("trading approvals missing; setting them up (one-time on-chain approvals through the relayer)", { missing: approvals.missing });
    await (secure as unknown as { setupTradingApprovals(): Promise<void> }).setupTradingApprovals();
    log.info("trading approvals set up");
  }
} catch (err) {
  log.error("could not verify trading approvals; refusing to trade", { err });
  process.exit(1);
}

const tape = new PriceTape({
  symbol: cfg.chainlinkSymbol, spotSubscribe: chainlinkSubscribe(publicClient as unknown as RealtimeClientLike), twapSubscribe: chainlinkTwapSubscribe(publicClient as unknown as RealtimeClientLike, cfg.chainlinkTwapSeconds),
  mono: clock.mono, wall: clock.wall, log: log.child({ feed: "tape" }),
});
tape.start();
const updateCheck = createUpdateCheck();
let holdTable: HoldRateTable | undefined;
const refreshHoldTable = () => {
  try { holdTable = buildHoldRateTable(db, clock.wall()); log.info("hold-rate table", { markets: holdTable.markets, cells: holdTable.toJSON().cells.length }); }
  catch (err) { log.warn("hold-rate table failed; feature stays null", { err }); }
};
const maybeRestartForUpdate = async () => {
  const u = updateCheck(clock.mono());
  if (u.error) log.debug("update check failed", { error: u.error });
  if (!u.available) return;
  if (process.env["AUTO_RESTART"] !== "1") { log.warn("newer version on the remote; restart the bot (or run it under pnpm auto)", { local: u.local, remote: u.remote }); return; }
  if (pending.length > 0) { log.info("newer version available; restarting after the open redemptions are done", { pending: pending.length }); return; }
  log.info("newer version on the remote; exiting for restart", { local: u.local, remote: u.remote });
  syncChild?.kill();
  await tape.stop().catch(() => undefined);
  process.exit(EXIT_UPDATE);
};
const startPriceFor = (openedAtMs: number) => tape.waitForStart(openedAtMs, 12_000)
  .then((s) => (s.twap ? { price: s.twap.price, ts: s.twap.ts, source: `chainlink-twap${cfg.chainlinkTwapSeconds}` } : undefined));
const db = openDatabase(cfg.databaseUrl);
const repo = new DecisionRepository(db);
const jevCall = createJevCall({ apiKey: cfg.typesafeApiKey, model: cfg.typesafeModel, timeoutMs: 5_000 });

/** Realised live PnL since UTC midnight, for the daily-loss limit. */
const dailyPnlUsd = () => {
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  try {
    return db.all<{ pnl_json: string }>(`SELECT pnl_json FROM pnl_snapshots WHERE mode = 'live' AND ts_ms >= ?`, [midnight.getTime()])
      .reduce((s, r) => s + ((JSON.parse(r.pnl_json) as { netPnl?: number }).netPnl ?? 0), 0);
  } catch { return 0; }
};

log.warn("LIVE TRADING STARTING - real orders will be placed", { limits: cfg.liveLimits, db: cfg.databaseUrl, model: cfg.typesafeModel ?? "jev-latest", wallet: wallet ?? "(derived from signer)", dailyPnlSoFar: dailyPnlUsd() });

/** Markets whose position still waits for the official resolution and redemption. */
const pending: { market: MarketIdentity; engine: LiveEngine }[] = [];
type ResolutionRow = { conditionId?: string; status: string; payouts?: [string, string] };
const officialOutcome = async (m: MarketIdentity): Promise<"UP" | "DOWN" | undefined> => {
  const rows = (await (publicClient as unknown as { fetchResolutions(r: { conditionIds: string[] }): Promise<ResolutionRow[]> }).fetchResolutions({ conditionIds: [m.conditionId] }));
  const r = rows.find((x) => x.conditionId?.toLowerCase() === m.conditionId.toLowerCase());
  if (!r || r.status !== "resolved" || !r.payouts) return undefined;
  const [up, down] = r.payouts.map(Number);
  return up! > down! ? "UP" : down! > up! ? "DOWN" : undefined;
};
const sweepRedemptions = async () => {
  for (const p of [...pending]) {
    try {
      const outcome = await officialOutcome(p.market);
      if (!outcome) continue;
      repo.markResolved(p.market.marketId, outcome === "UP" ? "Up" : "Down");
      db.run(`UPDATE markets SET resolved_source = 'official' WHERE market_id = ?`, [p.market.marketId]);
      const s = await p.engine.redeem(outcome);
      if (s.settled) { pending.splice(pending.indexOf(p), 1); log.info("redeemed", { slug: p.market.slug, outcome, netPnl: s.netPnl, dailyPnl: dailyPnlUsd() }); }
    } catch (err) {
      log.warn("redemption sweep failed for a market; will retry", { slug: p.market.slug, err });
    }
  }
};

let current: MarketObserver | undefined;
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) { log.warn("forced exit"); process.exit(130); }
  shuttingDown = true;
  syncChild?.kill();
  log.info("shutting down: cancelling resting orders - press Ctrl+C again to force", { signal, pendingRedemptions: pending.length });
  setTimeout(() => { log.warn("shutdown timed out, exiting"); process.exit(0); }, 8_000).unref();
  try { await currentEngine?.cancelAll("shutdown"); await current?.stop(); await tape.stop(); } catch (err) { log.warn("stop failed", { err }); }
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
let currentEngine: LiveEngine | undefined;

while (!shuttingDown) {
  await sweepRedemptions();
  await maybeRestartForUpdate();
  refreshHoldTable();
  const now = clock.wall();
  let found: Awaited<ReturnType<typeof findCurrentMarket>>;
  try {
    found = await findCurrentMarket(publicClient as unknown as DiscoveryClient, now, cfg.marketDurationSeconds);
  } catch (err) {
    log.error("market discovery failed; retrying in 5s", { err });
    try { repo.saveError("discovery", err instanceof Error ? `${err.name}: ${err.message}` : String(err), null, now); repo.heartbeat("live", { phase: "waiting", market: "discovery-error", decisions: 0, killed: false }, now); } catch { /* keep going */ }
    await new Promise((r) => setTimeout(r, 5_000));
    continue;
  }
  if (!found) {
    const w = windowAt(now, cfg.marketDurationSeconds);
    const untilNext = Math.max(1_000, Math.min(5_000, nextWindow(now, cfg.marketDurationSeconds).openedAtMs - now));
    log.warn("current window not tradable; waiting", { slug: w.slug, retryInS: Math.round(untilNext / 1000) });
    try { repo.heartbeat("live", { phase: "waiting", market: w.slug, decisions: 0, killed: false }, now); } catch { /* dashboard only */ }
    await new Promise((r) => setTimeout(r, untilNext));
    continue;
  }
  const market = found.identity;
  const mlog = log.child({ market: market.slug, mode: "live" });

  const engine = new LiveEngine({
    market, limits: cfg.liveLimits, client: liveClient, mono: clock.mono, wall: clock.wall, db,
    onInventory: (inv, open) => { current?.setInventory(inv); current?.setOpenOrderCount(open); },
    onApiError: (what, err) => { current?.apiError(); try { repo.saveError(`exchange:${what}`, err instanceof Error ? `${err.name}: ${err.message}` : JSON.stringify(err), market.marketId, clock.wall()); } catch { /* keep going */ } },
    log: (level, msg, fields) => mlog[level](msg, fields),
  });
  currentEngine = engine;

  log.warn("LIVE market", { slug: market.slug, closesInS: Math.round((market.closesAtMs - clock.wall()) / 1000), up: market.upAssetId, down: market.downAssetId, limits: cfg.liveLimits });
  current = new MarketObserver(
    {
      cfg: { ...cfg, limits: cfg.liveLimits }, log: mlog, clock, repo, jevCall,
      marketSubscribe: marketSubscribe(publicClient as unknown as RealtimeClientLike),
      chainlinkSubscribe: tape.subscribeFn("spot"),
      ...(tape.hasTwap() ? { chainlinkTwapSubscribe: tape.subscribeFn("twap") } : {}),
      settlementStart: startPriceFor(market.openedAtMs),
      holdRate: (d, t, s) => holdTable?.estimate(d, t, s),
      dailyPnlUsd,
      executionMode: "live",
      processName: "live",
      onKill: (state) => { mlog.error("KILL: cancelling every resting order, accepting nothing new", { reasons: state.reasons }); return engine.kill(); },
      onKillCleared: () => { mlog.warn("kill cleared: live orders may be placed again"); engine.resume(); },
      onApproved: (d, snap, decisionMono) => engine.onApproved(d, snap, decisionMono),
    },
    market,
  );
  const ticker = setInterval(() => { void engine.tick(clock.mono()); }, 500);
  // The exchange's view of the position is the truth; a disagreement stops trading until an operator looks.
  const reconciler = setInterval(() => {
    void engine.reconcile().then((r) => { if (!r.ok) { current?.hardFault("INVENTORY_MISMATCH"); mlog.error("INVENTORY MISMATCH - hard kill", { detail: r.detail }); } });
  }, 30_000);
  try {
    await current.run();
  } catch (err) {
    log.error("market run failed; moving on", { err });
    try { repo.saveError("observer", err instanceof Error ? `${err.name}: ${err.message}` : String(err), market.marketId, clock.wall()); } catch { /* keep going */ }
    await current.stop().catch(() => undefined);
  } finally {
    clearInterval(ticker);
    clearInterval(reconciler);
  }
  await engine.cancelAll("market closed");
  const s = engine.summary();
  if (engine.hasPosition()) { pending.push({ market, engine }); mlog.info("position waits for the official resolution", { position: s.position }); }
  log.info("market finished", { slug: market.slug, decisions: current.decisionCount(), orders: s.orders, rejected: s.rejected, fills: s.fills, cancelled: s.cancelled, merges: s.merges, position: s.position, latency: current.latencyReport() });
  current = undefined;
  currentEngine = undefined;
}
