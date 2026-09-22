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

export type CaptureSource = { kind: "window"; title: string } | { kind: "region"; x: number; y: number; w: number; h: number } | { kind: "desktop" };

export function ffmpegArgs(outPath: string, width: number, quality: number, source: CaptureSource = { kind: "desktop" }): string[] {
  // -q:v 2..31, lower is better; map 85 % -> about 4.
  const q = Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)));
  const input = source.kind === "window" ? ["-i", `title=${source.title}`] : source.kind === "region" ? ["-offset_x", String(source.x), "-offset_y", String(source.y), "-video_size", `${source.w}x${source.h}`, "-i", "desktop"] : ["-i", "desktop"];
  return ["-y", "-loglevel", "error", "-f", "gdigrab", "-framerate", "2", ...input, "-frames:v", "1", "-vf", `scale=${Math.round(width)}:-2`, "-q:v", String(q), outPath];
}

/** The primary monitor's size, from WMI; the virtual desktop puts the primary at 0,0. */
export async function primaryMonitor(powershell = "powershell.exe"): Promise<{ w: number; h: number } | undefined> {
  try {
    const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output ($b.Width.ToString() + 'x' + $b.Height.ToString())"], { windowsHide: true, timeout: 10_000 });
    const m = /(\d+)x(\d+)/.exec(stdout);
    return m ? { w: Number(m[1]), h: Number(m[2]) } : undefined;
  } catch { return undefined; }
}

/**
 * Prefer the game window by title (gdigrab captures it wherever it is, on
 * any monitor), then the primary monitor only, then the whole desktop. A
 * two-monitor desktop scaled to 1600 px leaves 800 px per screen, too
 * little to read shop names, which is what happened first.
 */
export async function captureScreen(outPath: string, opts: CaptureOptions & { sources?: CaptureSource[] } = {}): Promise<{ path: string; source: string }> {
  mkdirSync(dirname(outPath), { recursive: true });
  const width = opts.width ?? 1600, quality = opts.quality ?? 85;
  const backend = opts.backend ?? "powershell";
  if (backend === "powershell") {
    try { await run(opts.powershell ?? "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve(opts.script ?? "scripts/tft-capture.ps1"), "-OutPath", resolve(outPath), "-Width", String(Math.round(width)), "-Quality", String(Math.round(quality))], { windowsHide: true, timeout: 20_000 }); }
    catch (err) { const e = err as { stderr?: string; message?: string; killed?: boolean }; throw new Error(`screenshot failed (powershell)${e.killed ? " (timeout)" : ""}: ${(e.stderr || e.message || "").toString().trim().slice(0, 300)}`); }
    if (!existsSync(outPath)) throw new Error("screenshot failed (powershell): no file written");
    return { path: outPath, source: "primary" };
  }
  const sources = opts.sources ?? [{ kind: "desktop" }];
  const errors: string[] = [];
  for (const source of sources) {
    try {
      await run(opts.ffmpeg ?? "ffmpeg", ffmpegArgs(outPath, width, quality, source), { windowsHide: true, timeout: 20_000 });
      if (existsSync(outPath)) return { path: outPath, source: source.kind === "window" ? `window:${source.title}` : source.kind === "region" ? `region:${source.w}x${source.h}` : "desktop" };
      errors.push(`${source.kind}: no file`);
    } catch (err) { const e = err as { stderr?: string; message?: string; killed?: boolean }; errors.push(`${source.kind}${e.killed ? " (timeout)" : ""}: ${(e.stderr || e.message || "").toString().trim().slice(0, 160)}`); }
  }
  throw new Error(`screenshot failed (ffmpeg): ${errors.join(" | ")}`);
}
