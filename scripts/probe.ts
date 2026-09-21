/**
 * Feed probe: subscribe to the current market's books and the Chainlink
 * price stream for a short while and print every raw event, unfiltered.
 * The fastest way to see what actually arrives on the socket.
 *
 *   pnpm probe            # 20 seconds
 *   pnpm probe -- --seconds 60
 */
import { createPublicClient } from "@polymarket/client";
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { findCurrentMarket, type DiscoveryClient } from "../src/market/market-discovery.js";

loadEnvFile();
const cfg = loadConfig();
const i = process.argv.indexOf("--seconds");
const SECONDS = i >= 0 ? Number(process.argv[i + 1]) : 20;

const client = createPublicClient();
const found = await findCurrentMarket(client as unknown as DiscoveryClient, Date.now(), cfg.marketDurationSeconds);
if (!found) { console.log("no tradable market for the current window"); process.exit(1); }
const m = found.identity;
console.log(`market ${m.slug}  UP=${m.upAssetId.slice(0, 10)}…  DOWN=${m.downAssetId.slice(0, 10)}…  closes in ${((m.closesAtMs - Date.now()) / 1000).toFixed(0)}s\n`);

const brief = (v: unknown): string => {
  const s = JSON.stringify(v, (_k, x) => (Array.isArray(x) && x.length > 3 ? [...x.slice(0, 3), `…+${x.length - 3}`] : x));
  return s.length > 400 ? s.slice(0, 400) + "…" : s;
};

async function watch(name: string, specs: Record<string, unknown>[]) {
  const counts: Record<string, number> = {};
  const t0 = Date.now();
  try {
    console.log(`[${name}] subscribing: ${JSON.stringify(specs)}`);
    const handle = await client.subscribe(specs as never);
    console.log(`[${name}] subscribed after ${Date.now() - t0}ms`);
    const stop = setTimeout(() => void handle.close(), SECONDS * 1000);
    for await (const ev of handle as AsyncIterable<Record<string, unknown>>) {
      const key = `${String(ev["topic"])}/${String(ev["type"])}`;
      counts[key] = (counts[key] ?? 0) + 1;
      if (counts[key] <= 2) console.log(`[${name}] +${Date.now() - t0}ms ${key}: ${brief(ev["payload"] ?? ev)}`);
    }
    clearTimeout(stop);
    console.log(`[${name}] stream ended after ${Date.now() - t0}ms`);
  } catch (err) {
    console.log(`[${name}] ERROR after ${Date.now() - t0}ms: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
  console.log(`[${name}] event counts: ${JSON.stringify(counts)}\n`);
}

await Promise.all([
  watch("market", [{ topic: "market", assetIds: [m.upAssetId, m.downAssetId], customFeatureEnabled: true }]),
  watch("chainlink", [{ topic: "prices.crypto.chainlink", symbols: [cfg.chainlinkSymbol] }]),
  watch("chainlink-all", [{ topic: "prices.crypto.chainlink" }]),
  watch("twap60", [{ topic: "prices.crypto.chainlink.twap", windowSeconds: 60, symbols: [cfg.chainlinkSymbol] }]),
]);
process.exit(0);
