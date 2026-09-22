import { existsSync, readFileSync } from "node:fs";

/**
 * A STOP file at the repository root ends the operation: every bot script
 * checks it first and idles forever instead of running, so windows left
 * open under `pnpm auto` cost nothing (no feeds, no Jev calls, no sync).
 * The auto runner pulls the file with the next update, so a push of it
 * stops runners nobody can reach.
 */
export async function haltIfStopped(): Promise<void> {
  if (!existsSync("STOP")) return;
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "STOP file present: operation ended, idling", note: readFileSync("STOP", "utf8").split("\n")[0] }) + "\n");
  await new Promise(() => { /* never resolves; Ctrl+C ends the window */ });
}
