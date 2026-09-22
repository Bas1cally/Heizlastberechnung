import { openDatabase, type Db } from "../persistence/database.js";
import type { Advice, BoardRead } from "./types.js";

/** Every reading and every piece of advice, so the recognition rate and the advice can be checked afterwards. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tft_reading (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, screenshot TEXT NOT NULL, read_json TEXT NOT NULL, fingerprint TEXT NOT NULL, model TEXT NOT NULL, latency_ms INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tft_advice (id INTEGER PRIMARY KEY AUTOINCREMENT, reading_id INTEGER NOT NULL, ts INTEGER NOT NULL, advice_json TEXT NOT NULL, source TEXT NOT NULL, model TEXT NOT NULL, latency_ms INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tft_reading_ts ON tft_reading(ts);
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
  lastReading(): ReadingRow | undefined { return this.db.get<ReadingRow>(`SELECT * FROM tft_reading ORDER BY id DESC LIMIT 1`); }
  lastAdvice(): AdviceRow | undefined { return this.db.get<AdviceRow>(`SELECT * FROM tft_advice ORDER BY id DESC LIMIT 1`); }
  totals(): { readings: number; advices: number; readTokens: number; adviceTokens: number } {
    const r = this.db.get<{ n: number; t: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens + output_tokens),0) AS t FROM tft_reading`)!;
    const a = this.db.get<{ n: number; t: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens + output_tokens),0) AS t FROM tft_advice`)!;
    return { readings: r.n, advices: a.n, readTokens: r.t, adviceTokens: a.t };
  }
}
