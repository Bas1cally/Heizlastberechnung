/**
 * Keeps a bot running and current, unattended:
 *
 *   pnpm auto              # paper
 *   pnpm auto -- observe   # or shadow
 *
 * Loop: pull the branch fast-forward (install dependencies if the lockfile
 * changed), start the bot, wait. The bot checks the remote every few
 * minutes and exits with code 75 between markets when a newer commit
 * exists; a crash restarts it after 10 s. Ctrl+C stops everything.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EXIT_UPDATE } from "../src/app/self-update.js";

const mode = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "paper";
const script = { observe: "scripts/observe.ts", paper: "scripts/paper.ts", shadow: "scripts/shadow.ts" }[mode];
if (!script) { console.error(`unknown bot '${mode}'; use observe, paper or shadow`); process.exit(1); }

const say = (msg: string) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg, auto: mode }) + "\n");
const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim();

function update(): void {
  try {
    const before = git(["rev-parse", "HEAD"]);
    git(["pull", "-q", "--ff-only"]);
    const after = git(["rev-parse", "HEAD"]);
    if (before === after) return;
    say(`updated ${before.slice(0, 7)} -> ${after.slice(0, 7)}`);
    const changed = git(["diff", "--name-only", before, after]).split("\n");
    if (changed.some((f) => f === "package.json" || f === "pnpm-lock.yaml")) {
      say("dependencies changed; running pnpm install");
      const r = spawnSync("pnpm", ["install", "--frozen-lockfile"], { stdio: "inherit", shell: true });
      if (r.status !== 0) say(`pnpm install exited with ${r.status}; continuing with what is installed`);
    }
  } catch (err) {
    say(`update failed (continuing with the current version): ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}

let child: ReturnType<typeof spawn> | undefined;
let stopping = false;
const stop = () => { stopping = true; child?.kill("SIGINT"); setTimeout(() => process.exit(0), 5_000).unref(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

while (!stopping) {
  update();
  say(`starting ${script}`);
  const code = await new Promise<number>((resolve) => {
    child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", script, ...process.argv.slice(3)], { stdio: "inherit", env: { ...process.env, AUTO_RESTART: "1" } });
    child.on("exit", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });
  child = undefined;
  if (stopping) break;
  if (code === EXIT_UPDATE) { say("bot asked for a restart to pick up the new version"); continue; }
  say(`bot exited with code ${code}; restarting in 10 s`);
  await new Promise((r) => setTimeout(r, 10_000));
}
