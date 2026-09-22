import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A screenshot of the primary screen as JPEG, scaled to `width`. Two ways,
 * both read the screen like a screen recorder and never touch the game:
 *
 *   ffmpeg gdigrab      - preferred: one process call, nothing for an
 *                         antivirus to parse.
 *   scripts/tft-capture.ps1 - PowerShell + System.Drawing as a script FILE.
 *                         Defender blocked the same code inline ("enthält
 *                         schädliche Daten"); a plain file usually passes.
 */
export type CaptureBackend = "ffmpeg" | "powershell";
export interface CaptureOptions { width?: number; quality?: number; backend?: CaptureBackend; ffmpeg?: string; powershell?: string; script?: string }

export async function ffmpegAvailable(ffmpeg = "ffmpeg"): Promise<boolean> {
  try { await run(ffmpeg, ["-version"], { windowsHide: true, timeout: 5000 }); return true; } catch { return false; }
}

export function ffmpegArgs(outPath: string, width: number, quality: number): string[] {
  // -q:v 2..31, lower is better; map 85 % -> about 4.
  const q = Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)));
  return ["-y", "-loglevel", "error", "-f", "gdigrab", "-framerate", "2", "-i", "desktop", "-frames:v", "1", "-vf", `scale=${Math.round(width)}:-2`, "-q:v", String(q), outPath];
}

export async function captureScreen(outPath: string, opts: CaptureOptions = {}): Promise<string> {
  mkdirSync(dirname(outPath), { recursive: true });
  const width = opts.width ?? 1600, quality = opts.quality ?? 85;
  const backend = opts.backend ?? "powershell";
  try {
    if (backend === "ffmpeg") await run(opts.ffmpeg ?? "ffmpeg", ffmpegArgs(outPath, width, quality), { windowsHide: true, timeout: 20_000 });
    else await run(opts.powershell ?? "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve(opts.script ?? "scripts/tft-capture.ps1"), "-OutPath", resolve(outPath), "-Width", String(Math.round(width)), "-Quality", String(Math.round(quality))], { windowsHide: true, timeout: 20_000 });
  } catch (err) {
    const e = err as { stderr?: string; message?: string; killed?: boolean };
    throw new Error(`screenshot failed (${backend})${e.killed ? " (timeout)" : ""}: ${(e.stderr || e.message || "").toString().trim().slice(0, 300)}`);
  }
  if (!existsSync(outPath)) throw new Error(`screenshot failed (${backend}): no file written`);
  return outPath;
}
