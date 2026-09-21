import { readFileSync } from "node:fs";

/** Parse .env text. Real environment variables always win over the file. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length > 1) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export function loadEnvFile(path = ".env"): void {
  let text: string;
  try {
    // Editors and PowerShell on Windows may write UTF-16 or a UTF-8 BOM.
    const buf = readFileSync(path);
    text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString("utf16le")
      : buf[0] === 0xfe && buf[1] === 0xff ? Buffer.from(buf.subarray(2)).swap16().toString("utf16le")
      : buf.toString("utf8").replace(/^\uFEFF/, "");
  } catch {
    return;
  }
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
