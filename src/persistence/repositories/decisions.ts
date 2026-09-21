import type { Db } from "../database.js";
import type { Decision } from "../../jev/decision-engine.js";
import type { RiskVerdict } from "../../risk/risk-gate.js";
import type { LatencyBreakdown } from "../../analytics/latency.js";
import type { MarketIdentity } from "../../market/market-state.js";

export class DecisionRepository {
  constructor(private readonly db: Db) {}

  upsertMarket(m: MarketIdentity, nowMs: number): void {
    this.db.run(
      `INSERT INTO markets (market_id, condition_id, slug, question, up_asset_id, down_asset_id, opened_at_ms, closes_at_ms, tick_size, min_order_size, first_seen_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(market_id) DO NOTHING`,
      [m.marketId, m.conditionId, m.slug, m.question, m.upAssetId, m.downAssetId, m.openedAtMs, m.closesAtMs, m.tickSize ?? null, m.minOrderSize ?? null, nowMs],
    );
  }

  markResolved(marketId: string, outcome: string): void {
    this.db.run(`UPDATE markets SET resolved_outcome = ? WHERE market_id = ?`, [outcome, marketId]);
  }

  /** The audit record: request, full answers, risk verdict. One transaction. */
  saveDecision(d: Decision, risk: RiskVerdict): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO jev_requests (decision_id, market_id, state_version, input_hash, timestamp_ms, state_json, model, input_tokens, output_tokens, jev_latency_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [d.decisionId, d.marketId, d.stateVersion.toString(), d.inputHash, d.timestampMs, JSON.stringify(d.state), d.model, d.usage.input_tokens, d.usage.output_tokens, d.jevLatencyMs],
      );
      this.db.run(
        `INSERT INTO jev_answers (decision_id, answers_json, requested_action, risk_result, risk_reason) VALUES (?,?,?,?,?)`,
        [d.decisionId, JSON.stringify(d.answers), d.requestedAction, risk.result, risk.result === "REJECTED" ? risk.reason : null],
      );
      this.db.run(
        `INSERT INTO jev_cache (input_hash, model, request_json, response_json, timestamp_ms, latency_ms) VALUES (?,?,?,?,?,?)
         ON CONFLICT(input_hash) DO NOTHING`,
        [d.inputHash, d.model, JSON.stringify(d.state), JSON.stringify(d.answers), d.timestampMs, d.jevLatencyMs],
      );
    });
  }

  cachedAnswers(inputHash: string): { answers: string; model: string; latencyMs: number } | undefined {
    const row = this.db.get<{ response_json: string; model: string; latency_ms: number }>(
      `SELECT response_json, model, latency_ms FROM jev_cache WHERE input_hash = ?`, [inputHash]);
    return row ? { answers: row.response_json, model: row.model, latencyMs: row.latency_ms } : undefined;
  }

  saveLatency(marketId: string, decisionId: string | null, tsMs: number, b: LatencyBreakdown): void {
    this.db.run(
      `INSERT INTO latency_measurements (decision_id, market_id, ts_ms, feed_to_state_ms, state_to_jev_ms, jev_ms, jev_to_submit_ms, submit_to_ack_ms, feed_to_ack_ms)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [decisionId, marketId, tsMs, b.feed_to_state_ms ?? null, b.state_to_jev_ms ?? null, b.jev_ms ?? null, b.jev_to_submit_ms ?? null, b.submit_to_ack_ms ?? null, b.feed_to_ack_ms ?? null],
    );
  }

  saveTick(marketId: string, source: string, tsMs: number, receivedAtMs: number, price: number): void {
    this.db.run(`INSERT INTO ticks (market_id, source, ts_ms, received_at_ms, price) VALUES (?,?,?,?,?)`, [marketId, source, tsMs, receivedAtMs, price]);
  }

  saveBook(marketId: string, assetId: string, receivedAtMs: number, bids: unknown, asks: unknown): void {
    this.db.run(`INSERT INTO orderbook_snapshots (market_id, asset_id, received_at_ms, bids_json, asks_json) VALUES (?,?,?,?,?)`,
      [marketId, assetId, receivedAtMs, JSON.stringify(bids), JSON.stringify(asks)]);
  }

  saveError(component: string, message: string, marketId: string | null, tsMs: number, details?: unknown): void {
    this.db.run(`INSERT INTO errors (ts_ms, market_id, component, message, details_json) VALUES (?,?,?,?,?)`,
      [tsMs, marketId, component, message, details === undefined ? null : JSON.stringify(details)]);
  }

  /** "Why did the bot do this?" - the exact stored record for one decision. */
  explain(decisionId: string): { request: Record<string, unknown>; answers: Record<string, unknown> } | undefined {
    const row = this.db.get<{ state_json: string; answers_json: string; requested_action: string; risk_result: string; risk_reason: string | null; state_version: string; model: string; jev_latency_ms: number; timestamp_ms: number }>(
      `SELECT r.state_json, a.answers_json, a.requested_action, a.risk_result, a.risk_reason, r.state_version, r.model, r.jev_latency_ms, r.timestamp_ms
       FROM jev_requests r JOIN jev_answers a USING (decision_id) WHERE r.decision_id = ?`, [decisionId]);
    if (!row) return undefined;
    return {
      request: { stateVersion: row.state_version, model: row.model, jevLatencyMs: row.jev_latency_ms, timestampMs: row.timestamp_ms, state: JSON.parse(row.state_json) },
      answers: { ...JSON.parse(row.answers_json), requestedAction: row.requested_action, risk: { result: row.risk_result, reason: row.risk_reason } },
    };
  }

  countDecisions(): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jev_requests`)?.n ?? 0;
  }
}
