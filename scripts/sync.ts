/**
 * Publishes everything an analyst needs to the git branch `reports` of the
 * project's own remote, so nobody has to copy terminal output around:
 *
 *   reports/summary.txt + *.json + *.csv   (resolve, report, acceptance, calibrate, analyze)
 *   reports/export.sqlite.gz               (compact database copy, see src/persistence/export.ts)
 *   logs/*.tail.log                        (last 400 lines of each bot log)
 *   manifest.json
 *
 * The branch holds a single orphan commit that is force-pushed on every run,
 * so it never grows. Nothing here touches the working branch.
 *
 *   pnpm sync                # once
 *   pnpm sync -- --every 15  # every 15 minutes, forever (the bots start this themselves)
 *   pnpm sync -- --no-push   # build the tree and the commit, push nothing
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { loadEnvFile } from "../src/app/env.js";
import { loadConfig } from "../src/app/config.js";
import { exportCompact } from "../src/persistence/export.js";
import { fileSink } from "../src/observability/file-sink.js";

loadEnvFile();
const cfg = loadConfig();
const argv = process.argv.slice(2);
const everyIdx = argv.indexOf("--every");
const everyMin = everyIdx >= 0 ? Number(argv[everyIdx + 1]) : 0;
const SYNC_DIR = ".sync";
const logFile = fileSink("logs/sync.log");
const log = (msg: string, extra: Record<string, unknown> = {}) => { const line = JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }); logFile(line); process.stdout.write(line + "\n"); };
const git = (args: string[], cwd = SYNC_DIR) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// The consistency scan (scripts/scan.ts) runs from here, detached, so it needs
// no window of its own: started when no report exists or the last one is older
// than SCAN_EVERY_MIN (default 180; 0 disables), never two at once. Its output
// goes to logs/scan.log; the reports it writes are picked up by the next sync.
const scanEveryMin = Number(process.env["SCAN_EVERY_MIN"] ?? 180);
let scanChild: ChildProcess | undefined;
function maybeStartScan(): void {
  if (!(scanEveryMin > 0) || scanChild) return;
  const last = existsSync("reports/consistency.json") ? statSync("reports/consistency.json").mtimeMs : 0;
  if (Date.now() - last < scanEveryMin * 60_000) return;
  mkdirSync("logs", { recursive: true });
  const out = openSync("logs/scan.log", "a");
  scanChild = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/scan.ts"], { stdio: ["ignore", out, out], env: process.env });
  const started = Date.now();
  log("scan started", { pid: scanChild.pid });
  scanChild.on("exit", (code) => { log("scan finished", { code, tookMin: Math.round((Date.now() - started) / 60_000) }); scanChild = undefined; });
  scanChild.on("error", (err) => { log("scan failed to start", { err: err.message }); scanChild = undefined; });
}

const tsx = (script: string, args: string[] = []) => {
  const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", script, ...args], { encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ? "\n[stderr]\n" + r.stderr : ""}` };
};

function ensureRepo(remote: string): void {
  if (!existsSync(join(SYNC_DIR, ".git"))) {
    mkdirSync(SYNC_DIR, { recursive: true });
    git(["init", "-q"]);
    git(["remote", "add", "origin", remote]);
  } else {
    try { git(["remote", "set-url", "origin", remote]); } catch { /* fine */ }
  }
}

/**
 * With GITHUB_SYNC_TOKEN in .env (a fine-grained token with Contents:
 * read/write on this repository) the push goes straight to GitHub with that
 * token, bypassing the credential manager and whatever browser account it
 * picks. The token is passed on the command line of this one push and is
 * never written into any git config or log.
 */
function pushUrl(remote: string): string {
  const token = process.env["GITHUB_SYNC_TOKEN"]?.trim();
  if (!token) return "origin";
  const m = remote.match(/^(?:https:\/\/(?:[^@]+@)?github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!m) return "origin";
  return `https://x-access-token:${token}@github.com/${m[1]}.git`;
}

async function once(): Promise<void> {
  const started = Date.now();
  const token = process.env["GITHUB_SYNC_TOKEN"]?.trim() ?? "";
  log("auth", { mode: token ? "token" : "credential manager", tokenLength: token.length, tokenPrefixOk: token.startsWith("github_pat_") || token.startsWith("ghp_"), envFile: existsSync(".env") ? "present" : "missing" });
  const remote = git(["remote", "get-url", "origin"], ".");
  ensureRepo(remote);
  // Fresh tree every time.
  for (const entry of readdirSync(SYNC_DIR)) if (entry !== ".git") rmSync(join(SYNC_DIR, entry), { recursive: true, force: true });
  mkdirSync(join(SYNC_DIR, "reports"), { recursive: true });
  mkdirSync(join(SYNC_DIR, "logs"), { recursive: true });

  // Reference traders (public wallets, TRADER_WALLETS in .env, default Animal00): a
  // few newest pages per sync keep their history current for the comparison.
  const wallets = (process.env["TRADER_WALLETS"] ?? "0x55aeeb3eb4e8cc0da6d9e4939caf533bf6c3f5df").split(",").map((w) => w.trim()).filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w));
  for (const w of wallets) {
    const r = tsx("scripts/trader.ts", [w, "--max-pages", "20"]);
    if (!r.ok) log("trader refresh failed", { wallet: w, tail: r.out.slice(-300) });
  }
  maybeStartScan();
  const summary = tsx("scripts/summary.ts");
  writeFileSync(join(SYNC_DIR, "reports", "summary.txt"), summary.out);
  if (existsSync("reports")) for (const f of readdirSync("reports")) if (/\.(json|csv|txt)$/.test(f)) cpSync(join("reports", f), join(SYNC_DIR, "reports", f));

  let tables: Record<string, number> = {};
  try {
    const tmp = join(SYNC_DIR, "export.sqlite");
    tables = exportCompact(cfg.databaseUrl, tmp, Date.now() - 36 * 3_600_000).tables;
    writeFileSync(join(SYNC_DIR, "reports", "export.sqlite.gz"), gzipSync(readFileSync(tmp)));
    rmSync(tmp, { force: true });
  } catch (err) { log("export failed", { err: err instanceof Error ? err.message : String(err) }); }
  for (const [file, name] of [["data/animal.sqlite", "animal"], ["data/animal-plus.sqlite", "animal-plus"], ["data/animal-jev.sqlite", "animal-jev"]] as const) {
    if (!existsSync(file)) continue;
    try {
      const tmp = join(SYNC_DIR, `${name}.sqlite`);
      exportCompact(file, tmp, Date.now() - 36 * 3_600_000);
      writeFileSync(join(SYNC_DIR, "reports", `${name}.sqlite.gz`), gzipSync(readFileSync(tmp)));
      rmSync(tmp, { force: true });
    } catch (err) { log("benchmark export failed", { file, err: err instanceof Error ? err.message : String(err) }); }
  }
  if (existsSync("data/backtest.sqlite")) {
    try { writeFileSync(join(SYNC_DIR, "reports", "backtest.sqlite.gz"), gzipSync(readFileSync("data/backtest.sqlite"))); } catch { /* optional */ }
  }

  if (existsSync("logs")) for (const f of readdirSync("logs")) {
    if (!f.endsWith(".log") || f === "sync.log") continue;
    const lines = readFileSync(join("logs", f), "utf8").split("\n");
    writeFileSync(join(SYNC_DIR, "logs", f.replace(/\.log$/, ".tail.log")), lines.slice(-400).join("\n"));
  }
  writeFileSync(join(SYNC_DIR, "manifest.json"), JSON.stringify({ syncedAt: new Date().toISOString(), database: cfg.databaseUrl, exportTables: tables, summaryOk: summary.ok, tookMs: Date.now() - started, node: process.version }, null, 2));
  writeFileSync(join(SYNC_DIR, "README.md"), "# reports\n\nMachine-written by `pnpm sync`. One orphan commit, force-pushed; do not base work on this branch.\n");

  // One orphan commit, force-pushed: the branch never grows.
  try { git(["checkout", "-q", "--orphan", "sync-tmp"]); } catch { /* already on it */ }
  git(["add", "-A"]);
  git(["-c", "user.name=jev-bot", "-c", "user.email=jev-bot@localhost", "commit", "-q", "--allow-empty", "-m", `sync ${new Date().toISOString()}`]);
  git(["branch", "-M", "reports"]);
  if (argv.includes("--no-push")) { log("built, not pushed (--no-push)", { dir: SYNC_DIR, tables }); return; }
  try {
    git(["push", "-q", "--force", pushUrl(remote), "reports:reports"]);
  } catch (err) {
    // Never let the token reach the log through git's error text.
    const msg = (err instanceof Error ? err.message : String(err)).replace(/x-access-token:[^@]+@/g, "x-access-token:[redacted]@");
    throw new Error(msg);
  }
  log("synced", { tookMs: Date.now() - started, summaryOk: summary.ok, tables, auth: process.env["GITHUB_SYNC_TOKEN"] ? "token" : "credential manager" });
}

for (;;) {
  try { await once(); } catch (err) { log("sync failed", { err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }); }
  if (!(everyMin > 0)) break;
  await new Promise((r) => setTimeout(r, everyMin * 60_000));
}
