import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Appends log lines to a file next to stdout, rotating once to `<file>.1`
 * when the file passes `maxBytes`. Synchronous on purpose: a log line that
 * is lost because the process died is exactly the line we needed.
 */
export function fileSink(path: string, maxBytes = 20 * 1024 * 1024): (line: string) => void {
  mkdirSync(dirname(path), { recursive: true });
  let size = (() => { try { return statSync(path).size; } catch { return 0; } })();
  return (line: string) => {
    try {
      if (size > maxBytes) { try { renameSync(path, `${path}.1`); } catch { /* keep appending */ } size = 0; }
      appendFileSync(path, line + "\n");
      size += line.length + 1;
    } catch { /* logging must never take the process down */ }
  };
}

/** Writes to stdout and to the file. */
export function teeSink(path: string): (line: string) => void {
  const file = fileSink(path);
  return (line) => { process.stdout.write(line + "\n"); file(line); };
}
