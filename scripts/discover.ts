/**
 * Shows the market for the current 5-minute window and the next one, exactly
 * as `client.listMarkets({ slug })` returns them - to confirm labels, timing,
 * tick size and the resolution rule before the observer depends on them.
 *
 *   pnpm discover
 */
import { createPublicClient } from "@polymarket/client";
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { fetchBySlug, mapOutcomes, toIdentity, type DiscoveryClient } from "../src/market/market-discovery.js";
import { nextWindow, windowAt } from "../src/market/window.js";

loadEnvFile();
const cfg = loadConfig();
const client = createPublicClient() as unknown as DiscoveryClient;
const now = Date.now();
const dur = cfg.marketDurationSeconds;

for (const [name, w] of [["current", windowAt(now, dur)], ["next", nextWindow(now, dur)]] as const) {
  console.log(`\n=== ${name} window: ${w.slug}  (${new Date(w.openedAtMs).toISOString()} -> ${new Date(w.closesAtMs).toISOString()}, closes in ${((w.closesAtMs - now) / 1000).toFixed(0)}s)`);
  const m = await fetchBySlug(client, w.slug);
  if (!m) { console.log("  not listed by Gamma (yet)"); continue; }
  const ids = mapOutcomes(m);
  const idn = toIdentity(m, dur);
  console.log(`  id/condition: ${m.id} / ${m.conditionId}`);
  console.log(`  question:     ${m.question ?? ""}`);
  console.log(`  outcomes:     yes=${JSON.stringify(m.outcomes.yes)}`);
  console.log(`                no =${JSON.stringify(m.outcomes.no)}`);
  console.log(`  mapping:      ${ids ? `UP=${ids.upAssetId.slice(0, 12)}… DOWN=${ids.downAssetId.slice(0, 12)}…` : "NOT MAPPED"}`);
  console.log(`  state:        ${JSON.stringify(m.state)}`);
  console.log(`  trading:      ${JSON.stringify(m.trading)}`);
  console.log(`  resolution:   ${JSON.stringify(m.resolution ?? null)}`);
  console.log(`  identity:     ${idn ? "OK" : "FAILED"}`);
  console.log(`  description:  ${(m.description ?? "").replace(/\s+/g, " ")}`);
}
