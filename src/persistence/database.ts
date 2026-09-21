import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.js";

/**
 * Thin handle over node:sqlite. The repositories in ./repositories/ only use
 * `run`/`all`/`get`, so a PostgreSQL adapter can implement the same three.
 */
export interface Db {
  run(sql: string, params?: readonly unknown[]): void;
  get<T>(sql: string, params?: readonly unknown[]): T | undefined;
  all<T>(sql: string, params?: readonly unknown[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

type Param = null | number | bigint | string | Uint8Array;
const toParam = (v: unknown): Param => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string" || v instanceof Uint8Array) return v;
  return JSON.stringify(v);
};

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA_SQL);

  return {
    run: (sql, params = []) => { db.prepare(sql).run(...params.map(toParam)); },
    get: <T,>(sql: string, params: readonly unknown[] = []) => db.prepare(sql).get(...params.map(toParam)) as T | undefined,
    all: <T,>(sql: string, params: readonly unknown[] = []) => db.prepare(sql).all(...params.map(toParam)) as T[],
    transaction: (fn) => {
      db.exec("BEGIN");
      try { const out = fn(); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    close: () => db.close(),
  };
}
