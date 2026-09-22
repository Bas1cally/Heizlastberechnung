/**
 * Pushes the current reports to the branch `share` so they can be read
 * without copy and paste. One orphan commit, force-pushed: the branch never
 * grows. The repository is PUBLIC: text reports and log tails (keys never
 * reach logs, see src/observability/logger.ts) and the last five TFT GAME
 * screenshots with what was read in them; never a desktop screenshot.
 *
 *   pnpm share                 # reports, logs, last five game screenshots
 *   pnpm share -- --ohne-bild  # without screenshots
 *
 * Needs GITHUB_SYNC_TOKEN in .env (fine-grained, Contents read/write on this
 * repository). Without it the script stops instead of opening the git
 * credential manager's browser sign-in, which failed on this machine.
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
if (!argv.includes("--ohne-bild") && existsSync("data/tft/tft.sqlite")) {
  const db = openDatabase("data/tft/tft.sqlite");
  const rows = db.all<{ id: number; screenshot: string; read_json: string }>(`SELECT id, screenshot, read_json FROM tft_reading ORDER BY id DESC LIMIT 300`);
  const games = rows.filter((r) => { const p = (JSON.parse(r.read_json) as { phase?: string }).phase; return (p === "planning" || p === "augment_choice" || p === "combat" || p === "carousel") && existsSync(r.screenshot); }).slice(0, 5);
  mkdirSync(join(DIR, "shots"), { recursive: true });
  for (const g of games) { cpSync(g.screenshot, join(DIR, "shots", `reading-${g.id}.jpg`)); writeFileSync(join(DIR, "shots", `reading-${g.id}.json`), g.read_json); }
  if (games.length) files.push(`${games.length} Spiel-Screenshots mit Lesung`);
}
writeFileSync(join(DIR, "README.md"), `# share\n\nMachine-written by \`pnpm share\` at ${new Date().toISOString()}. One orphan commit, force-pushed.\n\n${files.map((f) => `- ${f}`).join("\n")}\n`);

try { git(["checkout", "-q", "--orphan", "share-tmp"]); } catch { /* already */ }
git(["add", "-A"]);
git(["-c", "user.name=jev-bot", "-c", "user.email=jev-bot@localhost", "commit", "-q", "--allow-empty", "-m", `share ${new Date().toISOString()}`]);
git(["branch", "-M", "share"]);
const token = process.env["GITHUB_SYNC_TOKEN"]?.trim();
if (!token) { say("Kein GITHUB_SYNC_TOKEN in der .env: nichts geteilt. Bericht stattdessen aus reports\\tft-report.txt kopieren."); process.exit(0); }
const m = remote.match(/^(?:https:\/\/(?:[^@]+@)?github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/);
const url = token && m ? `https://x-access-token:${token}@github.com/${m[1]}.git` : "origin";
try { git(["push", "-q", "--force", url, "share:share"]); }
catch (err) { const msg = (err instanceof Error ? err.message : String(err)).replace(/x-access-token:[^@]+@/g, "x-access-token:[redacted]@"); say(`Push fehlgeschlagen: ${msg.slice(0, 400)}`); process.exit(1); }
say(`Geteilt (Branch share):\n${files.map((f) => `  ${f}`).join("\n") || "  (nichts gefunden)"}\n\nSag Claude einfach: geteilt.`);
