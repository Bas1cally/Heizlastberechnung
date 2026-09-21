/**
 * Phase 1 acceptance check (brief §36) against the database.
 *
 *   pnpm acceptance                 # requires 24 h
 *   pnpm acceptance -- --hours 8
 *
 * Writes reports/acceptance.json. PASS / FAIL / INSUFFICIENT per criterion.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { openDatabase } from "../src/persistence/database.js";
import { acceptanceReport } from "../src/analytics/acceptance.js";

loadEnvFile();
const cfg = loadConfig();
const i = process.argv.indexOf("--hours");
const hours = i >= 0 ? Number(process.argv[i + 1]) : 24;
const r = acceptanceReport(openDatabase(cfg.databaseUrl), Date.now(), hours);
mkdirSync("reports", { recursive: true });
writeFileSync("reports/acceptance.json", JSON.stringify(r, null, 2));
console.log(`phase 1 acceptance: ${r.overall}\n`);
for (const c of r.criteria) console.log(`  ${c.status.padEnd(12)} ${c.name}\n               ${c.detail}`);
console.log("\nwritten: reports/acceptance.json");
