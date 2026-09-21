/**
 * Everything in one file: report, calibrate, analyze, acceptance, backtest
 * summary. Meant to be pasted somewhere as a whole.
 *
 *   pnpm summary
 *   pnpm summary | Set-Clipboard      (PowerShell)
 *
 * Writes reports/summary.txt as well.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const steps: [string, string[]][] = [
  ["resolve (official outcomes)", ["scripts/resolve.ts"]],
  ["report", ["scripts/report.ts"]],
  ["acceptance", ["scripts/acceptance.ts"]],
  ["calibrate", ["scripts/calibrate.ts"]],
  ["analyze (paper)", ["scripts/analyze.ts", "--records", "paper"]],
];
if (existsSync("data/backtest.sqlite")) steps.push(["analyze (backtest)", ["scripts/analyze.ts", "--records", "backtest"]]);

const out: string[] = [`# jev-btc-5m summary ${new Date().toISOString()}`, ""];
for (const [name, args] of steps) {
  out.push(`## ${name}`, "");
  try {
    out.push(execFileSync(process.execPath, [...process.execArgv, "node_modules/tsx/dist/cli.mjs", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env }).trimEnd());
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    out.push(`(failed) ${e.stderr?.trim() || e.message}`, e.stdout?.trimEnd() ?? "");
  }
  out.push("");
}
if (existsSync("reports/backtest-summary.json")) {
  const b = JSON.parse(readFileSync("reports/backtest-summary.json", "utf8")) as Record<string, unknown>;
  const { perMarket: _pm, ...rest } = b;
  out.push("## backtest-summary.json (without per-market rows)", "", JSON.stringify(rest, null, 2), "");
}
mkdirSync("reports", { recursive: true });
const text = out.join("\n");
writeFileSync("reports/summary.txt", text);
process.stdout.write(text + "\n");
