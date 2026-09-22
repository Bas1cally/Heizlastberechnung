import { openDatabase, type Db } from "../persistence/database.js";
import type { Advice, BoardRead } from "./types.js";

/** Every reading and every piece of advice, so the recognition rate and the advice can be checked afterwards. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tft_reading (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, screenshot TEXT NOT NULL, read_json TEXT NOT NULL, fingerprint TEXT NOT NULL, model TEXT NOT NULL, latency_ms INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tft_advice (id INTEGER PRIMARY KEY AUTOINCREMENT, reading_id INTEGER NOT NULL, ts INTEGER NOT NULL, advice_json TEXT NOT NULL, source TEXT NOT NULL, model TEXT NOT NULL, latency_ms INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tft_reading_ts ON tft_reading(ts);
CREATE TABLE IF NOT EXISTS tft_error (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
`;

export interface ReadingRow { id: number; ts: number; screenshot: string; read_json: string; fingerprint: string; model: string; latency_ms: number; input_tokens: number; output_tokens: number }
export interface AdviceRow { id: number; reading_id: number; ts: number; advice_json: string; source: string; model: string; latency_ms: number; input_tokens: number; output_tokens: number }

export class TftStore {
  constructor(readonly db: Db, readonly now: () => number = () => Date.now()) { for (const s of SCHEMA.split(";").map((x) => x.trim()).filter(Boolean)) db.run(s); }
  static open(path: string): TftStore { return new TftStore(openDatabase(path)); }
  addReading(screenshot: string, read: BoardRead, fingerprint: string, model: string, latencyMs: number, usage: { input_tokens: number; output_tokens: number }): ReadingRow {
    this.db.run(`INSERT INTO tft_reading (ts, screenshot, read_json, fingerprint, model, latency_ms, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?)`, [this.now(), screenshot, JSON.stringify(read), fingerprint, model, latencyMs, usage.input_tokens, usage.output_tokens]);
    return this.db.get<ReadingRow>(`SELECT * FROM tft_reading ORDER BY id DESC LIMIT 1`)!;
  }
  addAdvice(readingId: number, advice: Advice, usage: { input_tokens: number; output_tokens: number }): AdviceRow {
    this.db.run(`INSERT INTO tft_advice (reading_id, ts, advice_json, source, model, latency_ms, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?)`, [readingId, this.now(), JSON.stringify(advice), advice.source, advice.model, advice.latencyMs, usage.input_tokens, usage.output_tokens]);
    return this.db.get<AdviceRow>(`SELECT * FROM tft_advice ORDER BY id DESC LIMIT 1`)!;
  }
  addError(message: string): void {
    const kind = / 402:|Insufficient/i.test(message) ? "venice_no_credit" : / 429:/.test(message) ? "venice_overloaded" : /screenshot failed/.test(message) ? "screenshot" : /finish_reason length/.test(message) ? "token_limit" : /schema|parsable/.test(message) ? "bad_answer" : /no answer within|fetch failed/.test(message) ? "network" : "other";
    this.db.run(`INSERT INTO tft_error (ts, kind, message) VALUES (?,?,?)`, [this.now(), kind, message.slice(0, 500)]);
  }
  readingsSince(ts: number): ReadingRow[] { return this.db.all<ReadingRow>(`SELECT * FROM tft_reading WHERE ts >= ? ORDER BY ts`, [ts]); }
  adviceSince(ts: number): AdviceRow[] { return this.db.all<AdviceRow>(`SELECT * FROM tft_advice WHERE ts >= ? ORDER BY ts`, [ts]); }
  errorsSince(ts: number): { kind: string; n: number; example: string }[] { return this.db.all(`SELECT kind, COUNT(*) AS n, MAX(message) AS example FROM tft_error WHERE ts >= ? GROUP BY kind ORDER BY n DESC`, [ts]); }
  /** When the game last left the screen (desktop, client, loading): advice from before that belongs to an old game. */
  lastBoundary(): number {
    const rows = this.db.all<{ ts: number; read_json: string }>(`SELECT ts, read_json FROM tft_reading ORDER BY id DESC LIMIT 200`);
    const hit = rows.find((r) => { try { const p = (JSON.parse(r.read_json) as { phase?: string }).phase; return p === "not_tft" || p === "loading"; } catch { return false; } });
    return hit?.ts ?? 0;
  }
  lastReading(): ReadingRow | undefined { return this.db.get<ReadingRow>(`SELECT * FROM tft_reading ORDER BY id DESC LIMIT 1`); }
  lastAdvice(): AdviceRow | undefined { return this.db.get<AdviceRow>(`SELECT * FROM tft_advice ORDER BY id DESC LIMIT 1`); }
  totals(): { readings: number; advices: number; readTokens: number; adviceTokens: number } {
    const r = this.db.get<{ n: number; t: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens + output_tokens),0) AS t FROM tft_reading`)!;
    const a = this.db.get<{ n: number; t: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens + output_tokens),0) AS t FROM tft_advice`)!;
    return { readings: r.n, advices: a.n, readTokens: r.t, adviceTokens: a.t };
  }
}
