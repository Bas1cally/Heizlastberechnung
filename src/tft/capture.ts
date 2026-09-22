import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A screenshot of the primary screen as JPEG, scaled to `width`, via
 * PowerShell and System.Drawing (nothing to install on Windows). Reads the
 * screen like any screen recorder would; it never touches the game process.
 */
export function captureScript(outPath: string, width: number, quality: number): string {
  const p = outPath.replace(/'/g, "''");
  return [
    "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing",
    "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    "$src=New-Object System.Drawing.Bitmap $b.Width,$b.Height",
    "$g=[System.Drawing.Graphics]::FromImage($src); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $g.Dispose()",
    `$w=${Math.round(width)}; $h=[int]($b.Height*$w/$b.Width)`,
    "$dst=New-Object System.Drawing.Bitmap $w,$h; $g2=[System.Drawing.Graphics]::FromImage($dst); $g2.InterpolationMode='HighQualityBicubic'; $g2.DrawImage($src,0,0,$w,$h); $g2.Dispose()",
    "$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
    "$ep=New-Object System.Drawing.Imaging.EncoderParameters 1",
    `$ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ${Math.round(quality)}`,
    `$dst.Save('${p}',$codec,$ep); $src.Dispose(); $dst.Dispose()`,
  ].join("; ");
}

export async function captureScreen(outPath: string, opts: { width?: number; quality?: number; powershell?: string } = {}): Promise<string> {
  mkdirSync(dirname(outPath), { recursive: true });
  const script = captureScript(outPath, opts.width ?? 1600, opts.quality ?? 85);
  await run(opts.powershell ?? "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, timeout: 15_000 });
  return outPath;
}
