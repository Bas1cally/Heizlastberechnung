import { execFileSync } from "node:child_process";

/** Exit code a bot uses to say "a newer commit is on the remote; restart me". */
export const EXIT_UPDATE = 75;

/**
 * Is there a newer commit on the remote than the one THIS PROCESS is running?
 * The running commit is read once, at creation: several runners share one
 * checkout, and once the first of them has pulled, the working tree's HEAD
 * already equals the remote while the others still execute the old code
 * (observed 2026-09-21: two of three runners never restarted). Fetches at
 * most every `minIntervalMs`; any git failure (no network, no git) answers
 * "no" and is logged by the caller, never thrown.
 */
export function createUpdateCheck(minIntervalMs = 5 * 60_000, git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).trim()) {
  let lastCheck = Number.NEGATIVE_INFINITY;
  let branch: string | undefined;
  let running: string | undefined;
  try { running = git(["rev-parse", "HEAD"]); } catch { /* answered below, on the first check */ }
  return (nowMono: number): { available: boolean; local?: string; remote?: string; error?: string } => {
    if (nowMono - lastCheck < minIntervalMs) return { available: false };
    lastCheck = nowMono;
    try {
      branch ??= git(["rev-parse", "--abbrev-ref", "HEAD"]);
      if (!branch || branch === "HEAD") return { available: false, error: "detached HEAD" };
      running ??= git(["rev-parse", "HEAD"]);
      git(["fetch", "-q", "origin", branch]);
      const remote = git(["rev-parse", `origin/${branch}`]);
      return { available: running !== remote, local: running.slice(0, 7), remote: remote.slice(0, 7) };
    } catch (err) {
      return { available: false, error: (err instanceof Error ? err.message.split("\n")[0] : String(err)) ?? "unknown" };
    }
  };
}
