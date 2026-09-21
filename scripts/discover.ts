/**
 * Prints what Gamma returns for the configured discovery query, so the real
 * slug pattern, outcome labels and timing of BTC 5-minute markets can be
 * confirmed before anything depends on them.
 *
 *   pnpm discover
 *   MARKET_TITLE_SEARCH="Bitcoin Up or Down" pnpm discover
 */
import { createPublicClient } from "@polymarket/client";
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { listCandidates, mapOutcomes, selectCurrent, type DiscoveryClient } from "../src/market/market-discovery.js";

loadEnvFile();
const cfg = loadConfig();
const client = createPublicClient() as unknown as DiscoveryClient;

const q = { titleSearch: cfg.discovery.titleSearch, tagSlug: cfg.discovery.tagSlug, durationSeconds: cfg.discovery.durationSeconds };
console.log(`query: titleSearch=${JSON.stringify(q.titleSearch)} tagSlug=${q.tagSlug ?? "-"} duration=${q.durationSeconds}s\n`);

const candidates = await listCandidates(client, q);
console.log(`${candidates.length} market(s) returned\n`);
for (const m of candidates.slice(0, 25)) {
  const ids = mapOutcomes(m);
  console.log(`- ${m.slug ?? "(no slug)"}`);
  console.log(`    question:  ${m.question ?? ""}`);
  console.log(`    outcomes:  ${JSON.stringify(m.outcomes)}  -> ${ids ? "mapped UP/DOWN" : "NOT MAPPED"}`);
  console.log(`    tokens:    ${JSON.stringify(m.clobTokenIds)}`);
  console.log(`    start/end: ${m.startDate ?? "-"}  ->  ${m.endDate ?? "-"}`);
  console.log(`    active=${m.active} closed=${m.closed} tick=${m.orderPriceMinTickSize ?? "-"} minSize=${m.orderMinSize ?? "-"}`);
  if (m.description) console.log(`    desc:      ${m.description.replace(/\s+/g, " ").slice(0, 220)}`);
}
const now = Date.now();
const sel = selectCurrent(candidates, now, q.durationSeconds);
console.log(`\nselected now: ${sel ? `${sel.slug} closes in ${((sel.closesAtMs - now) / 1000).toFixed(0)}s` : "none"}`);
