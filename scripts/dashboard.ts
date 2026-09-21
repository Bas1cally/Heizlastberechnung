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
import { startDashboard } from "../src/app/dashboard-server.js";

loadEnvFile();
const cfg = loadConfig();
const i = process.argv.indexOf("--port");
const port = i >= 0 ? Number(process.argv[i + 1]) : 8787;
startDashboard(openDatabase(cfg.databaseUrl), port, (m) => console.log(m));
