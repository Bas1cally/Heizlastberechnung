/** Operator control from the command line: `pnpm kill` / `pnpm resume`. */
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { openDatabase } from "../src/persistence/database.js";
import { DecisionRepository } from "../src/persistence/repositories/decisions.js";

loadEnvFile();
const cfg = loadConfig();
const repo = new DecisionRepository(openDatabase(cfg.databaseUrl));
const cmd = process.argv[2];
if (cmd === "kill") {
  repo.setControl("kill", JSON.stringify({ tripped: true, reasons: ["MANUAL"], hard: true, since: Date.now(), note: process.argv.slice(3).join(" ") || "manual (cli)" }), Date.now());
  console.log("kill requested; the bot stops creating orders within a second");
} else if (cmd === "resume") {
  repo.setControl("kill", JSON.stringify({ tripped: false, resumedAt: Date.now() }), Date.now());
  console.log("resume requested");
} else {
  console.log(`state: ${repo.getControl("kill")?.value ?? "not set"}`);
}
