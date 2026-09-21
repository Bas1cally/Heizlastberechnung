import type { Db } from "../persistence/database.js";
import { directionalProbability } from "./edge-analysis.js";
import { deriveOutcome, outcomeFromLabel } from "./outcomes.js";
import type { Observation } from "./calibration.js";

export interface MarketOutcomeRow {
  readonly marketId: string;
  readonly slug: string;
  readonly openedAtMs: number;
  readonly closesAtMs: number;
  readonly outcome: "UP" | "DOWN" | undefined;
  readonly source: "feed" | "derived" | "none";
  readonly derivedStart: number | undefined;
  readonly derivedEnd: number | undefined;
  readonly decisions: number;
}

/** Outcome per market: the feed's resolution when present, else derived from ticks. */
export function loadMarketOutcomes(db: Db, nowMs: number): MarketOutcomeRow[] {
  const markets = db.all<{ market_id: string; slug: string; opened_at_ms: number; closes_at_ms: number; resolved_outcome: string | null }>(
    `SELECT market_id, slug, opened_at_ms, closes_at_ms, resolved_outcome FROM markets ORDER BY opened_at_ms`);
  return markets.map((m) => {
    // The markets settle on the 60 s TWAP; use that stream when it was recorded, else spot.
    const twap = db.all<{ ts_ms: number; price: number }>(
      `SELECT ts_ms, price FROM ticks WHERE market_id = ? AND source LIKE 'chainlink-twap%' ORDER BY ts_ms`, [m.market_id]);
    const ticks = (twap.length > 0 ? twap : db.all<{ ts_ms: number; price: number }>(
      `SELECT ts_ms, price FROM ticks WHERE market_id = ? AND source = 'chainlink' ORDER BY ts_ms`, [m.market_id]))
      .map((t) => ({ tsMs: t.ts_ms, price: t.price }));
    const derived = m.closes_at_ms <= nowMs ? deriveOutcome(ticks, m.opened_at_ms, m.closes_at_ms) : undefined;
    const fromFeed = outcomeFromLabel(m.resolved_outcome);
    const decisions = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jev_requests WHERE market_id = ?`, [m.market_id])?.n ?? 0;
    return {
      marketId: m.market_id, slug: m.slug, openedAtMs: m.opened_at_ms, closesAtMs: m.closes_at_ms,
      outcome: fromFeed ?? derived?.outcome,
      source: fromFeed ? "feed" : derived ? "derived" : "none",
      derivedStart: derived?.startPrice, derivedEnd: derived?.endPrice, decisions,
    };
  });
}

/** One observation per decision on a market with a known outcome. */
export function loadObservations(db: Db, outcomes: readonly MarketOutcomeRow[]): Observation[] {
  const byMarket = new Map(outcomes.filter((o) => o.outcome).map((o) => [o.marketId, o.outcome!] as const));
  if (byMarket.size === 0) return [];
  const rows = db.all<{ market_id: string; state_json: string; answers_json: string; requested_action: string }>(
    `SELECT r.market_id, r.state_json, a.answers_json, a.requested_action FROM jev_requests r JOIN jev_answers a USING (decision_id)`);
  const out: Observation[] = [];
  for (const r of rows) {
    const outcome = byMarket.get(r.market_id);
    if (!outcome) continue;
    const state = JSON.parse(r.state_json);
    const answers = JSON.parse(r.answers_json);
    const dir = answers?.settlement_direction;
    if (!dir?.probabilities) continue;
    const d = directionalProbability(dir);
    if (!d.usable) continue;
    out.push({
      pUp: d.pUp, unresolvedMass: d.unresolvedMass, outcomeUp: outcome === "UP",
      secondsRemaining: Number(state?.market?.secondsRemaining ?? NaN),
      upAsk: Number(state?.orderbook?.upAsk ?? NaN), downAsk: Number(state?.orderbook?.downAsk ?? NaN),
      action: r.requested_action, marketId: r.market_id,
    });
  }
  return out.filter((o) => Number.isFinite(o.secondsRemaining) && Number.isFinite(o.upAsk) && Number.isFinite(o.downAsk));
}
