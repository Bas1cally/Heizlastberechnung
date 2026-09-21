/**
 * Local dashboard over the bot's database. Read-mostly; the only writes are
 * the operator's kill / resume, which the bot polls from the control table.
 *
 *   pnpm dashboard            # http://127.0.0.1:8787
 *   pnpm dashboard -- --port 9000
 */
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { openDatabase } from "../src/persistence/database.js";
import { existsSync } from "node:fs";
import { startDashboard } from "../src/app/dashboard-server.js";

loadEnvFile();
const cfg = loadConfig();
const opt = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const port = Number(opt("port") ?? 8787);
// Execution records: the paper database when it exists, else the live database (mode "live").
const paperPath = opt("paper") ?? "data/paper.sqlite";
const paper = existsSync(paperPath) ? openDatabase(paperPath) : undefined;
startDashboard(openDatabase(cfg.databaseUrl), port, (m) => console.log(m), paper);
