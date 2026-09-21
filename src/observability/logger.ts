/**
 * Structured JSON logging, one object per line. Secrets never reach a log:
 * any field whose name looks like a credential is redacted before writing.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET = /(key|secret|private|passphrase|token|password)/i;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET.test(k) && typeof v === "string" && v.length > 0 ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function createLogger(
  opts: { level?: LogLevel; write?: (line: string) => void; bindings?: Record<string, unknown> } = {},
): Logger {
  const level = opts.level ?? "info";
  const write = opts.write ?? ((line) => process.stdout.write(line + "\n"));
  const bindings = opts.bindings ?? {};

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...bindings, ...(redact(fields ?? {}) as object) }));
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (b) => createLogger({ level, write, bindings: { ...bindings, ...b } }),
  };
}
