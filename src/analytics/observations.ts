import type { Db } from "../persistence/database.js";
import { directionalProbability } from "./edge-analysis.js";
import { deriveOutcome, outcomeFromLabel, type DerivedOutcome } from "./outcomes.js";
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

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One observation per decision on a market with a known outcome. */
export function loadObservations(db: Db, outcomes: readonly MarketOutcomeRow[]): Observation[] {
  const byMarket = new Map(outcomes.filter((o) => o.outcome).map((o) => [o.marketId, o.outcome!] as const));
  if (byMarket.size === 0) return [];
  const rows = db.all<{ decision_id: string; market_id: string; state_json: string; answers_json: string; requested_action: string }>(
    `SELECT r.decision_id, r.market_id, r.state_json, a.answers_json, a.requested_action FROM jev_requests r JOIN jev_answers a USING (decision_id)`);
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
      action: r.requested_action, marketId: r.market_id, decisionId: r.decision_id,
      distanceBps: num(state?.market?.distanceBps), realizedVol30s: num(state?.movement?.realizedVol30s), pairAskCost: num(state?.orderbook?.pairAskCost),
      actionConfidence: num(answers?.action?.confidence),
    });
  }
  return out.filter((o) => Number.isFinite(o.secondsRemaining) && Number.isFinite(o.upAsk) && Number.isFinite(o.downAsk));
}

/**
 * Cross-check of the outcome per market from every independent angle we
 * have: the feed's resolution, the TWAP derivation, the spot derivation, what
 * the market itself priced just before the close, and what Jev's last
 * decision implied. Disagreement between the TWAP derivation and the market
 * or Jev points at a start-price or timestamp problem, not at Jev.
 */
export interface MarketConsistencyRow {
  readonly slug: string;
  readonly feed: "UP" | "DOWN" | undefined;
  readonly twap: DerivedOutcome | undefined;
  readonly spot: DerivedOutcome | undefined;
  /** Seconds between the open and the first TWAP tick, and between the last TWAP tick before close and the close. */
  readonly twapFirstAfterOpenS: number | undefined;
  readonly twapLastBeforeCloseS: number | undefined;
  readonly twapTicks: number;
  /** UP mid price of the last book recorded before the close, and the implied outcome. */
  readonly marketUpMid: number | undefined;
  readonly marketImplied: "UP" | "DOWN" | undefined;
  readonly marketBookAgeS: number | undefined;
  /** Jev's last decision on the market: favoured side, its state's start/current settlement prices, distance, seconds remaining. */
  readonly jevFinal: { side: "UP" | "DOWN"; pUp: number; start: number; current: number; distanceBps: number; secondsRemaining: number; action: string } | undefined;
  readonly agree: boolean;
  readonly notes: string[];
}

export function marketConsistency(db: Db, nowMs: number): MarketConsistencyRow[] {
  const markets = db.all<{ market_id: string; slug: string; opened_at_ms: number; closes_at_ms: number; resolved_outcome: string | null; up_asset_id: string }>(
    `SELECT market_id, slug, opened_at_ms, closes_at_ms, resolved_outcome, up_asset_id FROM markets WHERE closes_at_ms <= ? ORDER BY opened_at_ms`, [nowMs]);
  return markets.map((m) => {
    const load = (where: string) => db.all<{ ts_ms: number; price: number }>(`SELECT ts_ms, price FROM ticks WHERE market_id = ? AND ${where} ORDER BY ts_ms`, [m.market_id]).map((t) => ({ tsMs: t.ts_ms, price: t.price }));
    const twapTicks = load(`source LIKE 'chainlink-twap%'`);
    const spotTicks = load(`source = 'chainlink'`);
    const twap = deriveOutcome(twapTicks, m.opened_at_ms, m.closes_at_ms);
    const spot = deriveOutcome(spotTicks, m.opened_at_ms, m.closes_at_ms);
    const book = db.get<{ received_at_ms: number; bids_json: string; asks_json: string }>(
      `SELECT received_at_ms, bids_json, asks_json FROM orderbook_snapshots WHERE market_id = ? AND asset_id = ? AND received_at_ms < ? ORDER BY received_at_ms DESC LIMIT 1`, [m.market_id, m.up_asset_id, m.closes_at_ms]);
    let marketUpMid: number | undefined;
    if (book) {
      const bids = JSON.parse(book.bids_json) as { price: number }[];
      const asks = JSON.parse(book.asks_json) as { price: number }[];
      const bid = bids.length ? Math.max(...bids.map((l) => l.price)) : undefined;
      const ask = asks.length ? Math.min(...asks.map((l) => l.price)) : undefined;
      marketUpMid = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : bid ?? ask;
    }
    const last = db.get<{ state_json: string; answers_json: string; requested_action: string }>(
      `SELECT r.state_json, a.answers_json, a.requested_action FROM jev_requests r JOIN jev_answers a USING (decision_id) WHERE r.market_id = ? ORDER BY r.timestamp_ms DESC LIMIT 1`, [m.market_id]);
    let jevFinal: MarketConsistencyRow["jevFinal"];
    if (last) {
      const st = JSON.parse(last.state_json) as { market?: { settlementStartPrice?: number; settlementCurrentPrice?: number; distanceBps?: number; secondsRemaining?: number } };
      const an = JSON.parse(last.answers_json) as { settlement_direction?: { probabilities?: Record<string, number> } };
      const d = an.settlement_direction?.probabilities ? directionalProbability(an.settlement_direction as never) : undefined;
      if (d?.usable) jevFinal = { side: d.pUp >= 0.5 ? "UP" : "DOWN", pUp: d.pUp, start: st.market?.settlementStartPrice ?? NaN, current: st.market?.settlementCurrentPrice ?? NaN, distanceBps: st.market?.distanceBps ?? NaN, secondsRemaining: st.market?.secondsRemaining ?? NaN, action: last.requested_action };
    }
    const feed = outcomeFromLabel(m.resolved_outcome);
    const marketImplied = marketUpMid === undefined ? undefined : marketUpMid >= 0.5 ? "UP" : "DOWN";
    const reference = feed ?? twap?.outcome ?? spot?.outcome;
    const notes: string[] = [];
    if (feed && twap && feed !== twap.outcome) notes.push(`feed ${feed} vs TWAP-derived ${twap.outcome}`);
    if (twap && spot && twap.outcome !== spot.outcome) notes.push(`TWAP-derived ${twap.outcome} vs spot-derived ${spot.outcome}`);
    if (reference && marketImplied && reference !== marketImplied) notes.push(`derived ${reference} vs market ${marketImplied} (UP mid ${marketUpMid!.toFixed(3)})`);
    if (reference && jevFinal && reference !== jevFinal.side) notes.push(`derived ${reference} vs Jev ${jevFinal.side} at ${jevFinal.secondsRemaining}s (distance ${jevFinal.distanceBps} bps)`);
    if (twap && jevFinal && Number.isFinite(jevFinal.start) && Math.abs(twap.startPrice - jevFinal.start) > 0.5) notes.push(`start price: derived ${twap.startPrice} vs Jev's state ${jevFinal.start}`);
    if (twap && jevFinal && Number.isFinite(jevFinal.current) && Math.abs(twap.endPrice - jevFinal.current) > 0.5) notes.push(`end price: derived ${twap.endPrice} vs Jev's last state ${jevFinal.current}`);
    if (!twap) notes.push("no TWAP ticks inside the window");
    const first = twapTicks.find((t) => t.tsMs >= m.opened_at_ms);
    const lastBefore = [...twapTicks].reverse().find((t) => t.tsMs < m.closes_at_ms);
    return {
      slug: m.slug, feed, twap, spot,
      twapFirstAfterOpenS: first ? (first.tsMs - m.opened_at_ms) / 1000 : undefined,
      twapLastBeforeCloseS: lastBefore ? (m.closes_at_ms - lastBefore.tsMs) / 1000 : undefined,
      twapTicks: twapTicks.length,
      marketUpMid, marketImplied, marketBookAgeS: book ? (m.closes_at_ms - book.received_at_ms) / 1000 : undefined,
      jevFinal, agree: notes.length === 0, notes,
    };
  });
}
