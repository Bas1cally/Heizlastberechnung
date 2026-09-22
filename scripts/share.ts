/**
 * Pushes the current reports to the branch `share` so they can be read
 * without copy and paste. One orphan commit, force-pushed: the branch never
 * grows. The repository is PUBLIC: only text reports and log tails go up
 * (keys never reach logs, see src/observability/logger.ts); screenshots only
 * with --bild, and then only the last game screenshot, never the desktop.
 *
 *   pnpm share            # TFT report, card results, vision comparison, log tails
 *   pnpm share -- --bild  # plus the latest TFT game screenshot
 *
 * Push auth like pnpm sync: GITHUB_SYNC_TOKEN from .env if set, else the
 * git credential manager.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "../src/app/env.js";
import { openDatabase } from "../src/persistence/database.js";

loadEnvFile();
const argv = process.argv.slice(2);
const DIR = ".share";
const git = (args: string[], cwd = DIR) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const say = (m: string) => console.log(m);

// A fresh TFT report first, so the pushed one is current.
if (existsSync("data/tft/tft.sqlite")) spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/tft-report.ts"], { stdio: "ignore", env: process.env });

const remote = git(["remote", "get-url", "origin"], ".");
if (!existsSync(join(DIR, ".git"))) { mkdirSync(DIR, { recursive: true }); git(["init", "-q"]); git(["remote", "add", "origin", remote]); }
for (const e of readdirSync(DIR)) if (e !== ".git") rmSync(join(DIR, e), { recursive: true, force: true });
mkdirSync(join(DIR, "reports"), { recursive: true }); mkdirSync(join(DIR, "logs"), { recursive: true });

const files: string[] = [];
if (existsSync("reports")) for (const f of readdirSync("reports")) if (/^(tft-|cards-|venice-probe).*\.(txt|json)$/.test(f)) { cpSync(join("reports", f), join(DIR, "reports", f)); files.push(`reports/${f}`); }
for (const f of ["data/tft/set.json", "data/tft/meta.json"]) if (existsSync(f)) { cpSync(f, join(DIR, "reports", f.split("/").pop()!.replace(".json", ".tft.json"))); files.push(f); }
for (const f of ["tft.log", "director.log"]) {
  const p = join("logs", f);
  if (!existsSync(p)) continue;
  writeFileSync(join(DIR, "logs", f.replace(".log", ".tail.log")), readFileSync(p, "utf8").split("\n").slice(-400).join("\n"));
  files.push(`logs/${f} (letzte 400 Zeilen)`);
}
if (argv.includes("--bild") && existsSync("data/tft/tft.sqlite")) {
  const db = openDatabase("data/tft/tft.sqlite");
  const rows = db.all<{ screenshot: string; read_json: string }>(`SELECT screenshot, read_json FROM tft_reading ORDER BY id DESC LIMIT 100`);
  const game = rows.find((r) => { const p = (JSON.parse(r.read_json) as { phase?: string }).phase; return p === "planning" || p === "augment_choice"; });
  if (game && existsSync(game.screenshot)) { cpSync(game.screenshot, join(DIR, "reports", "tft-last-game.jpg")); writeFileSync(join(DIR, "reports", "tft-last-game.read.json"), game.read_json); files.push("letzter Spiel-Screenshot mit Lesung"); }
}
writeFileSync(join(DIR, "README.md"), `# share\n\nMachine-written by \`pnpm share\` at ${new Date().toISOString()}. One orphan commit, force-pushed.\n\n${files.map((f) => `- ${f}`).join("\n")}\n`);

try { git(["checkout", "-q", "--orphan", "share-tmp"]); } catch { /* already */ }
git(["add", "-A"]);
git(["-c", "user.name=jev-bot", "-c", "user.email=jev-bot@localhost", "commit", "-q", "--allow-empty", "-m", `share ${new Date().toISOString()}`]);
git(["branch", "-M", "share"]);
const token = process.env["GITHUB_SYNC_TOKEN"]?.trim();
const m = remote.match(/^(?:https:\/\/(?:[^@]+@)?github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/);
const url = token && m ? `https://x-access-token:${token}@github.com/${m[1]}.git` : "origin";
try { git(["push", "-q", "--force", url, "share:share"]); }
catch (err) { const msg = (err instanceof Error ? err.message : String(err)).replace(/x-access-token:[^@]+@/g, "x-access-token:[redacted]@"); say(`Push fehlgeschlagen: ${msg.slice(0, 400)}`); process.exit(1); }
say(`Geteilt (Branch share):\n${files.map((f) => `  ${f}`).join("\n") || "  (nichts gefunden)"}\n\nSag Claude einfach: geteilt.`);
