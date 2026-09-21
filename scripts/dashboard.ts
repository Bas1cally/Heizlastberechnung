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
// Execution records live in the main database, grouped by mode ("paper" from
// pnpm bot:paper, "live" once it exists). The recorded-book backtest writes
// its own database; it is shown as a third, clearly separate tab when present.
const backtestPath = opt("backtest") ?? "data/backtest.sqlite";
const backtest = existsSync(backtestPath) ? openDatabase(backtestPath) : undefined;
startDashboard(openDatabase(cfg.databaseUrl), port, (m) => console.log(m), backtest);
