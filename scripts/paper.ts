/**
 * Phase 3: PAPER mode against LIVE order books (brief §14, §38).
 *
 * Everything the observer does - discovery, feeds, Jev, risk gate in
 * `simulated` mode - plus a simulated execution engine that turns approved
 * decisions into hypothetical orders, fills them against the real book that
 * arrives after the configured latency, tracks resting orders until traded
 * through or expired, feeds the simulated position back into the next state,
 * and settles at the real outcome.
 *
 *   pnpm bot:paper                       # latency 350 ms, seed 1
 *   pnpm bot:paper -- --latency 500 --seed 7
 *
 * Records land in the main database with mode "paper" (orders, fills,
 * inventory_snapshots, merges, redemptions, pnl_snapshots) and show up under
 * "Paper" in `pnpm dashboard`. No exchange client with a signer exists in
 * this process; nothing can be sent.
 */
import { createPublicClient } from "@polymarket/client";
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
import { PaperLiveEngine } from "../src/execution/paper-live-engine.js";
import { DEFAULT_FILL_PARAMS } from "../src/replay/paper-fill-model.js";

loadEnvFile();
const cfg = loadConfig();
const log = createLogger({ level: (process.env["LOG_LEVEL"] as never) ?? "info", write: teeSink("logs/paper.log") });
// Every 15 minutes the reports, a compact database export and the log tails
// are pushed to the git branch `reports` (scripts/sync.ts). --no-sync to skip.
const syncChild = process.argv.includes("--no-sync") ? undefined
  : spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/sync.ts", "--every", process.env["SYNC_EVERY_MIN"] ?? "15"], { stdio: "ignore", env: process.env });
syncChild?.on("exit", (code) => log.warn("sync loop exited", { code }));
const argv = process.argv.slice(2);
const opt = (n: string, d: number) => { const i = argv.indexOf(`--${n}`); const v = i >= 0 ? Number(argv[i + 1]) : d; return Number.isFinite(v) ? v : d; };
const latencyMs = opt("latency", Number(process.env["PAPER_LATENCY_MS"] ?? 350));
const seed = opt("seed", 1);

if (!cfg.typesafeApiKey) { log.error("TYPESAFE_API_KEY is not set"); process.exit(1); }
if (cfg.mode !== "observe" && cfg.mode !== "paper") {
  log.error(`bot:paper only runs in paper mode (got ${cfg.mode}); live execution does not exist`);
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
// Between markets: is there a newer commit? Under `pnpm auto` the bot then
// exits with code 75 and is restarted on the new version; standalone it only says so.
const updateCheck = createUpdateCheck();
// Measured base rates for Jev (analytics/hold-rate.ts), rebuilt from the
// database before each market so every market that is over counts.
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
  log.info("newer version on the remote; exiting for restart", { local: u.local, remote: u.remote });
  syncChild?.kill();
  await tape.stop().catch(() => undefined);
  process.exit(EXIT_UPDATE);
};
// Not awaited: the observer starts at once and takes the tape's value when it
// lands (the TWAP stream can lag the open by several seconds).
const startPriceFor = (openedAtMs: number) => tape.waitForStart(openedAtMs, 12_000)
  .then((s) => (s.twap ? { price: s.twap.price, ts: s.twap.ts, source: `chainlink-twap${cfg.chainlinkTwapSeconds}` } : undefined));
const db = openDatabase(cfg.databaseUrl);
const repo = new DecisionRepository(db);
const jevCall = createJevCall({ apiKey: cfg.typesafeApiKey, model: cfg.typesafeModel, timeoutMs: 5_000 });

log.info("paper starting", { mode: "paper", latencyMs, seed, fill: DEFAULT_FILL_PARAMS, limits: cfg.limits, db: cfg.databaseUrl, model: cfg.typesafeModel ?? "jev-latest" });

let current: MarketObserver | undefined;
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) { log.warn("forced exit"); process.exit(130); }
  shuttingDown = true;
  syncChild?.kill();
  log.info("shutting down - press Ctrl+C again to force", { signal });
  setTimeout(() => { log.warn("shutdown timed out, exiting"); process.exit(0); }, 3_000).unref();
  try { await current?.stop(); await tape.stop(); } catch (err) { log.warn("stop failed", { err }); }
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

let marketIndex = 0;
while (!shuttingDown) {
  await maybeRestartForUpdate();
  refreshHoldTable();
  const now = clock.wall();
  let found: Awaited<ReturnType<typeof findCurrentMarket>>;
  try {
    found = await findCurrentMarket(client as unknown as DiscoveryClient, now, cfg.marketDurationSeconds);
  } catch (err) {
    log.error("market discovery failed; retrying in 5s", { err });
    try { repo.saveError("discovery", err instanceof Error ? `${err.name}: ${err.message}` : String(err), null, now); repo.heartbeat("paper", { phase: "waiting", market: "discovery-error", decisions: 0, killed: false }, now); } catch { /* db unavailable; keep going */ }
    await new Promise((r) => setTimeout(r, 5_000));
    continue;
  }
  if (!found) {
    const w = windowAt(now, cfg.marketDurationSeconds);
    const untilNext = Math.max(1_000, Math.min(5_000, nextWindow(now, cfg.marketDurationSeconds).openedAtMs - now));
    log.warn("current window not tradable; waiting", { slug: w.slug, retryInS: Math.round(untilNext / 1000) });
    try { repo.heartbeat("paper", { phase: "waiting", market: w.slug, decisions: 0, killed: false }, now); } catch { /* dashboard only */ }
    await new Promise((r) => setTimeout(r, untilNext));
    continue;
  }
  const market = found.identity;
  const mlog = log.child({ market: market.slug, mode: "paper" });
  marketIndex++;

  // One engine per market; the position never carries over (each market settles).
  const engine = new PaperLiveEngine({
    market, limits: cfg.limits, latencyMs, fill: DEFAULT_FILL_PARAMS, seed: seed * 1_000_003 + marketIndex,
    mono: clock.mono, wall: clock.wall, db,
    onInventory: (inv, open) => { current?.setInventory(inv); current?.setOpenOrderCount(open); },
    log: (msg, fields) => mlog.info(msg, fields),
  });

  log.info("paper trading market", { slug: market.slug, closesInS: Math.round((market.closesAtMs - clock.wall()) / 1000), up: market.upAssetId, down: market.downAssetId });
  current = new MarketObserver(
    {
      cfg, log: mlog, clock, repo, jevCall,
      marketSubscribe: marketSubscribe(client as unknown as RealtimeClientLike),
      chainlinkSubscribe: chainlinkSubscribe(client as unknown as RealtimeClientLike),
      chainlinkTwapSubscribe: chainlinkTwapSubscribe(client as unknown as RealtimeClientLike, cfg.chainlinkTwapSeconds),
      settlementStart: startPriceFor(market.openedAtMs),
      holdRate: (d, t) => holdTable?.estimate(d, t),
      executionMode: "simulated",
      processName: "paper",
      onKill: (state) => { mlog.error("kill: cancelling resting paper orders, no new ones", { reasons: state.reasons }); engine.kill(); },
      onKillCleared: () => { mlog.warn("kill cleared: paper orders may be built again"); engine.resume(); },
      onBookUpdate: (book, nowMono) => engine.onBook(book, nowMono),
      onApproved: (d, snap, decisionMono) => engine.onApproved(d, snap, decisionMono),
      onResolved: (outcome) => {
        if (!outcome) return;
        const s = engine.settleAt(outcome, clock.mono());
        mlog.info("paper settled on feed resolution", { outcome, netPnl: s.netPnl });
      },
    },
    market,
  );
  // Resting orders expire on a timer, not only on book events.
  const ticker = setInterval(() => engine.tick(clock.mono()), 250);
  try {
    await current.run();
  } catch (err) {
    log.error("market run failed; moving on", { err });
    try { repo.saveError("observer", err instanceof Error ? `${err.name}: ${err.message}` : String(err), market.marketId, clock.wall()); } catch { /* keep going */ }
    await current.stop().catch(() => undefined);
  } finally {
    clearInterval(ticker);
  }
  // No market_resolved event inside the grace period: settle on the observed
  // rule (60 s TWAP at close >= TWAP at open -> UP). Recorded as "derived".
  if (!engine.summary().settled) {
    const { start, current: end } = current.settlementNow();
    if (start !== undefined && end !== undefined) {
      const outcome = end >= start ? "UP" : "DOWN";
      const s = engine.settleAt(outcome, clock.mono());
      mlog.warn("paper settled on derived outcome (no resolution event)", { outcome, start, end, netPnl: s.netPnl });
    } else {
      engine.cancelAll("market ended without settlement data");
      mlog.error("cannot settle: no settlement prices recorded; position left unsettled", { position: engine.summary().position });
    }
  }
  const s = engine.summary();
  log.info("market finished", { slug: market.slug, decisions: current.decisionCount(), orders: s.orders, fills: s.fills, partials: s.partials, noFills: s.noFills, cancelled: s.cancelled, merges: s.merges, outcome: s.outcome, netPnl: s.netPnl, latency: current.latencyReport() });
  current = undefined;
}
