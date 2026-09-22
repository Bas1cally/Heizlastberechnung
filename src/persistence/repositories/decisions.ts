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

  /** The tape's value overrides a provisional one set by the observer's own first tick. */
  setStartLag(marketId: string, lagMs: number, source: string, fromTape: boolean): void {
    if (fromTape) this.db.run(`UPDATE markets SET start_lag_ms = ?, start_source = ? WHERE market_id = ?`, [Math.round(lagMs), `${source}@tape`, marketId]);
    else this.db.run(`UPDATE markets SET start_lag_ms = ?, start_source = ? WHERE market_id = ? AND start_lag_ms IS NULL`, [Math.round(lagMs), source, marketId]);
  }

  markResolved(marketId: string, outcome: string): void {
    this.db.run(`UPDATE markets SET resolved_outcome = ? WHERE market_id = ?`, [outcome, marketId]);
  }

  /** The audit record: request, full answers, risk verdict. One transaction. */
  saveDecision(d: Decision, risk: RiskVerdict): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO jev_requests (decision_id, market_id, state_version, raw_state_version, material_reason, input_hash, timestamp_ms, state_json, model, input_tokens, output_tokens, jev_latency_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [d.decisionId, d.marketId, d.stateVersion.toString(), d.rawStateVersion.toString(), d.materialReason, d.inputHash, d.timestampMs, JSON.stringify(d.state), d.model, d.usage.input_tokens, d.usage.output_tokens, d.jevLatencyMs],
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

  /**
   * The answer Jev actually gave on this market closest to `atMs` (within
   * `toleranceMs`, never later than `atMs`). Replays of a live recording
   * rarely rebuild the exact state (books are sampled at 500 ms, timing
   * differs, inventory changes it), so the hash cache misses; the recorded
   * decision nearest in time is what Jev said at that moment.
   */
  recordedAnswersAt(marketId: string, atMs: number, toleranceMs = 2_000): { answers: string; model: string; latencyMs: number; decisionId: string; timestampMs: number } | undefined {
    const row = this.db.get<{ decision_id: string; answers_json: string; model: string; jev_latency_ms: number; timestamp_ms: number }>(
      `SELECT r.decision_id, a.answers_json, r.model, r.jev_latency_ms, r.timestamp_ms FROM jev_requests r JOIN jev_answers a USING (decision_id)
       WHERE r.market_id = ? AND r.timestamp_ms <= ? AND r.timestamp_ms >= ? ORDER BY r.timestamp_ms DESC LIMIT 1`, [marketId, atMs, atMs - toleranceMs]);
    return row ? { answers: row.answers_json, model: row.model, latencyMs: row.jev_latency_ms, decisionId: row.decision_id, timestampMs: row.timestamp_ms } : undefined;
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

  /** A match from the market channel; `side` is the taker's. */
  saveTrade(marketId: string, assetId: string, tsMs: number | undefined, receivedAtMs: number, price: number, size: number, side: "BUY" | "SELL", feeRateBps?: number): void {
    this.db.run(`INSERT INTO trades (market_id, asset_id, ts_ms, received_at_ms, price, size, side, fee_rate_bps) VALUES (?,?,?,?,?,?,?,?)`, [marketId, assetId, tsMs ?? null, receivedAtMs, price, size, side, feeRateBps ?? null]);
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

  saveShadowOrder(marketId: string, tsMs: number, r: {
    decisionId: string; side: string; assetId: string; orderType: string; price: number; size: number;
    signed: boolean; signError: string | undefined; signingMs: number; expectedPrice: number;
    priceAtAck: number | undefined; movedAgainstBps: number | undefined;
    status: string | undefined; filled: number | undefined; avgPrice: number | undefined;
  }): void {
    this.db.run(
      `INSERT INTO shadow_orders (decision_id, market_id, ts_ms, side, asset_id, order_type, price, size, signed, sign_error, signing_ms, expected_price, price_at_ack, moved_against_bps, hypothetical_status, hypothetical_filled, hypothetical_avg_price)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [r.decisionId, marketId, tsMs, r.side, r.assetId, r.orderType, r.price, r.size, r.signed ? 1 : 0, r.signError ?? null, r.signingMs,
       Number.isFinite(r.expectedPrice) ? r.expectedPrice : null, r.priceAtAck ?? null, r.movedAgainstBps ?? null, r.status ?? null, r.filled ?? null, r.avgPrice ?? null],
    );
  }

  /** Operator control shared between the bot and the dashboard through the database. */
  setControl(key: string, value: string, nowMs: number): void {
    this.db.run(`INSERT INTO control (key, value, updated_ms) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ms = excluded.updated_ms`, [key, value, nowMs]);
  }
  getControl(key: string): { value: string; updatedMs: number } | undefined {
    const row = this.db.get<{ value: string; updated_ms: number }>(`SELECT value, updated_ms FROM control WHERE key = ?`, [key]);
    return row ? { value: row.value, updatedMs: row.updated_ms } : undefined;
  }
  /** Heartbeat so the dashboard can tell a running bot from a dead one. */
  heartbeat(component: string, info: Record<string, unknown>, nowMs: number): void {
    this.setControl(`heartbeat:${component}`, JSON.stringify({ ...info, at: nowMs }), nowMs);
  }

  countDecisions(): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jev_requests`)?.n ?? 0;
  }
}
