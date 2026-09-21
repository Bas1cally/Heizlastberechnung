import type { Db } from "../persistence/database.js";
import { naiveEdge, TIME_BUCKETS, type EdgeRow, type Observation } from "./calibration.js";
import { percentiles, type Percentiles } from "./latency.js";

/**
 * Performance metrics beyond win rate (brief §26) over one execution mode
 * ("paper", "backtest", "live"), plus expected-value segmentation by the
 * dimensions the brief names. Every number is computed from persisted
 * records; nothing is estimated from a model of the strategy.
 */
export interface ExecutionMetrics {
  readonly mode: string;
  readonly settledMarkets: number;
  readonly netPnl: number;
  readonly grossPnl: number;
  readonly mergePnl: number;
  readonly settlementPnl: number;
  readonly fees: number;
  readonly gas: number;
  /** USD actually paid for shares (fills x price), the capital put at risk. */
  readonly deployedCapitalUsd: number;
  /** netPnl / deployed capital; null before any fill. */
  readonly returnOnDeployedCapital: number | null;
  readonly pnlPerMarket: number | null;
  readonly pnlPerFill: number | null;
  /** Jev calls on the settled markets, and net PnL per call. */
  readonly jevCalls: number;
  readonly pnlPerJevCall: number | null;
  readonly maxDrawdown: number;
  /** Largest total cost held at any inventory snapshot. */
  readonly worstCaseExposureUsd: number;
  readonly unpairedExposure: UnpairedExposure;
  readonly orders: number;
  readonly fills: number;
  readonly partials: number;
  readonly noFills: number;
  readonly cancelled: number;
  readonly fillRatio: number | null;
  readonly cancelRatio: number | null;
  /** Fills from resting (GTC) orders vs. from immediate (FAK/FOK) ones. */
  readonly makerFills: number;
  readonly takerFills: number;
  readonly makerTakerRatio: number | null;
  /** Token spend on the settled markets and its price at the configured rate. */
  readonly jevTokens: { input: number; output: number };
  readonly jevCostUsd: number;
  readonly usdPerMillionTokens: number;
  readonly netPnlAfterJevCost: number;
}

export interface UnpairedExposure {
  /** Total time, over all settled markets, with an unpaired position open. */
  readonly totalMs: number;
  readonly meanPerMarketMs: number | null;
  readonly maxMs: number;
  /** Share of the markets' open time spent unpaired. */
  readonly shareOfMarketTime: number | null;
}

interface PnlJson { netPnl: number; grossPnl: number; fees: number; gas: number; mergePnl: number; settlementPnl?: number }

export function executionMetrics(db: Db, mode: string, usdPerMillionTokens = 0): ExecutionMetrics | null {
  const settled = db.all<{ market_id: string; opened_at_ms: number; closes_at_ms: number; pnl_json: string; ts_ms: number }>(
    `SELECT p.market_id, m.opened_at_ms, m.closes_at_ms, p.pnl_json, p.ts_ms FROM pnl_snapshots p JOIN markets m USING (market_id) WHERE p.mode = ? ORDER BY m.closes_at_ms`, [mode]);
  const orders = db.get<{ n: number; filled: number; partial: number; nofill: number; cancelled: number }>(
    `SELECT COUNT(*) AS n, SUM(status='FILLED') AS filled, SUM(status='PARTIAL') AS partial, SUM(status='NO_FILL') AS nofill, SUM(status='CANCELLED') AS cancelled FROM orders WHERE mode = ?`, [mode]);
  if (settled.length === 0 && (orders?.n ?? 0) === 0) return null;

  let cum = 0, peak = 0, maxDd = 0;
  const sums = { netPnl: 0, grossPnl: 0, fees: 0, gas: 0, mergePnl: 0, settlementPnl: 0 };
  for (const s of settled) {
    const p = JSON.parse(s.pnl_json) as PnlJson;
    sums.netPnl += p.netPnl; sums.grossPnl += p.grossPnl; sums.fees += p.fees; sums.gas += p.gas; sums.mergePnl += p.mergePnl;
    sums.settlementPnl += p.settlementPnl ?? p.grossPnl - p.mergePnl;
    cum += p.netPnl; peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum);
  }
  const marketIds = settled.map((s) => s.market_id);
  const inList = marketIds.length ? `(${marketIds.map(() => "?").join(",")})` : "('')";

  const fills = db.get<{ n: number; usd: number; maker: number; taker: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(f.price * f.size), 0) AS usd,
            COALESCE(SUM(CASE WHEN o.order_type = 'GTC' THEN 1 ELSE 0 END), 0) AS maker,
            COALESCE(SUM(CASE WHEN o.order_type IN ('FAK','FOK') THEN 1 ELSE 0 END), 0) AS taker
     FROM fills f JOIN orders o USING (order_id) WHERE f.mode = ?`, [mode]);
  const jev = db.get<{ n: number; i: number; o: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM jev_requests WHERE market_id IN ${inList}`, marketIds);
  const worst = db.get<{ v: number | null }>(`SELECT MAX(json_extract(inventory_json, '$.totalCost')) AS v FROM inventory_snapshots WHERE mode = ?`, [mode])?.v ?? 0;

  const jevTokens = { input: jev?.i ?? 0, output: jev?.o ?? 0 };
  const jevCostUsd = ((jevTokens.input + jevTokens.output) / 1_000_000) * usdPerMillionTokens;
  const nFills = fills?.n ?? 0;
  const nOrders = orders?.n ?? 0;
  const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

  return {
    mode, settledMarkets: settled.length, ...sums,
    deployedCapitalUsd: fills?.usd ?? 0,
    returnOnDeployedCapital: ratio(sums.netPnl, fills?.usd ?? 0),
    pnlPerMarket: ratio(sums.netPnl, settled.length),
    pnlPerFill: ratio(sums.netPnl, nFills),
    jevCalls: jev?.n ?? 0, pnlPerJevCall: ratio(sums.netPnl, jev?.n ?? 0),
    maxDrawdown: maxDd, worstCaseExposureUsd: worst,
    unpairedExposure: unpairedExposure(db, mode, settled.map((s) => ({ marketId: s.market_id, openedAtMs: s.opened_at_ms, closesAtMs: s.closes_at_ms, settledAtMs: s.ts_ms }))),
    orders: nOrders, fills: orders?.filled ?? 0, partials: orders?.partial ?? 0, noFills: orders?.nofill ?? 0, cancelled: orders?.cancelled ?? 0,
    fillRatio: ratio((orders?.filled ?? 0) + (orders?.partial ?? 0), nOrders),
    cancelRatio: ratio(orders?.cancelled ?? 0, nOrders),
    makerFills: fills?.maker ?? 0, takerFills: fills?.taker ?? 0,
    makerTakerRatio: ratio(fills?.maker ?? 0, fills?.taker ?? 0),
    jevTokens, jevCostUsd, usdPerMillionTokens,
    netPnlAfterJevCost: sums.netPnl - jevCostUsd,
  };
}

/**
 * Time with an unpaired position, from the inventory snapshots: each snapshot
 * holds until the next one, the last until settlement (or the market close
 * when no settlement time exists).
 */
export function unpairedExposure(db: Db, mode: string, markets: readonly { marketId: string; openedAtMs: number; closesAtMs: number; settledAtMs?: number }[]): UnpairedExposure {
  let total = 0, max = 0, marketTime = 0;
  for (const m of markets) {
    const snaps = db.all<{ ts_ms: number; inventory_json: string }>(`SELECT ts_ms, inventory_json FROM inventory_snapshots WHERE market_id = ? AND mode = ? ORDER BY ts_ms`, [m.marketId, mode]);
    const end = Math.max(m.closesAtMs, m.settledAtMs ?? 0);
    marketTime += Math.max(0, m.closesAtMs - m.openedAtMs);
    let ms = 0;
    for (let i = 0; i < snaps.length; i++) {
      const inv = JSON.parse(snaps[i]!.inventory_json) as { unpairedUpShares?: number; unpairedDownShares?: number };
      const unpaired = (inv.unpairedUpShares ?? 0) > 0 || (inv.unpairedDownShares ?? 0) > 0;
      if (!unpaired) continue;
      const until = i + 1 < snaps.length ? snaps[i + 1]!.ts_ms : end;
      ms += Math.max(0, until - snaps[i]!.ts_ms);
    }
    total += ms; max = Math.max(max, ms);
  }
  return { totalMs: total, meanPerMarketMs: markets.length ? total / markets.length : null, maxMs: max, shareOfMarketTime: marketTime > 0 ? total / marketTime : null };
}

/* ---------- Expected value segmentation (brief §26, §30) ---------- */

export interface Bucket { readonly label: string; readonly lo: number; readonly hi: number }

export const DISTANCE_BPS_BUCKETS: readonly Bucket[] = [
  { label: "0-1bps", lo: 0, hi: 1 }, { label: "1-2.5bps", lo: 1, hi: 2.5 }, { label: "2.5-5bps", lo: 2.5, hi: 5 }, { label: "5-10bps", lo: 5, hi: 10 },
  { label: "10-20bps", lo: 10, hi: 20 }, { label: "20-50bps", lo: 20, hi: 50 }, { label: "50bps+", lo: 50, hi: Infinity },
];
/** Realised 30 s volatility in bps, as `realizedVolBps` reports it. */
export const VOL_BUCKETS: readonly Bucket[] = [
  { label: "<2bps", lo: -Infinity, hi: 2 }, { label: "2-5bps", lo: 2, hi: 5 }, { label: "5-10bps", lo: 5, hi: 10 },
  { label: "10-20bps", lo: 10, hi: 20 }, { label: "20-50bps", lo: 20, hi: 50 }, { label: "50bps+", lo: 50, hi: Infinity },
];
export const PAIR_COST_BUCKETS: readonly Bucket[] = [
  { label: "<0.98", lo: -Infinity, hi: 0.98 }, { label: "0.98-0.99", lo: 0.98, hi: 0.99 }, { label: "0.99-1.00", lo: 0.99, hi: 1.0 },
  { label: "1.00-1.01", lo: 1.0, hi: 1.01 }, { label: "1.01-1.03", lo: 1.01, hi: 1.03 }, { label: "1.03+", lo: 1.03, hi: Infinity },
];
export const ACTION_CONFIDENCE_BUCKETS: readonly Bucket[] = [
  { label: "<0.5", lo: -Infinity, hi: 0.5 }, { label: "0.5-0.7", lo: 0.5, hi: 0.7 }, { label: "0.7-0.9", lo: 0.7, hi: 0.9 }, { label: "0.9-0.99", lo: 0.9, hi: 0.99 }, { label: "0.99+", lo: 0.99, hi: Infinity },
];

function edgeSummary(bucket: string, obs: readonly Observation[]): EdgeRow {
  const n = obs.length;
  if (n === 0) return { bucket, n: 0, meanAsk: NaN, meanJevEdge: NaN, meanPnl: NaN, winRate: NaN };
  const e = obs.map(naiveEdge);
  return { bucket, n, meanAsk: e.reduce((s, x) => s + x.ask, 0) / n, meanJevEdge: e.reduce((s, x) => s + x.jevEdge, 0) / n, meanPnl: e.reduce((s, x) => s + x.pnl, 0) / n, winRate: e.filter((x) => x.pnl > 0).length / n };
}

/** Naive EV in numeric buckets of `value`; observations without the value are counted under "unknown". */
export function edgeByNumeric(obs: readonly Observation[], buckets: readonly Bucket[], value: (o: Observation) => number | undefined): EdgeRow[] {
  const rows = buckets.map((b) => edgeSummary(b.label, obs.filter((o) => { const v = value(o); return v !== undefined && v >= b.lo && v < b.hi; })));
  const unknown = obs.filter((o) => value(o) === undefined);
  return unknown.length ? [...rows, edgeSummary("unknown", unknown)] : rows;
}

export function edgeByAction(obs: readonly Observation[]): EdgeRow[] {
  const actions = [...new Set(obs.map((o) => o.action))].sort();
  return actions.map((a) => edgeSummary(a, obs.filter((o) => o.action === a)));
}

export interface EvSegments {
  readonly byDistanceBps: EdgeRow[];
  readonly byVolatility: EdgeRow[];
  readonly byJevConfidence: EdgeRow[];
  readonly byAction: EdgeRow[];
  readonly byPairCost: EdgeRow[];
}

export function evSegments(obs: readonly Observation[]): EvSegments {
  return {
    byDistanceBps: edgeByNumeric(obs, DISTANCE_BPS_BUCKETS, (o) => (o.distanceBps === undefined ? undefined : Math.abs(o.distanceBps))),
    byVolatility: edgeByNumeric(obs, VOL_BUCKETS, (o) => o.realizedVol30s),
    byJevConfidence: edgeByNumeric(obs, ACTION_CONFIDENCE_BUCKETS, (o) => o.actionConfidence),
    byAction: edgeByAction(obs),
    byPairCost: edgeByNumeric(obs, PAIR_COST_BUCKETS, (o) => o.pairAskCost),
  };
}

/* ---------- Realised PnL by time bucket (brief §30) ---------- */

export interface RealizedRow {
  readonly bucket: string;
  readonly fills: number;
  readonly shares: number;
  readonly costUsd: number;
  /** (payout - price) x size - fee, summed. Merges pay the same as settlement (1.00 per pair), so per-fill attribution is exact at zero gas. */
  readonly pnl: number;
  readonly pnlPerShare: number;
  readonly winRate: number;
}

/**
 * Realised PnL of every fill, attributed to the time-remaining bucket the
 * originating decision was made in. Needs the market outcome.
 */
export function realizedPnlByTime(db: Db, mode: string, outcomes: ReadonlyMap<string, "UP" | "DOWN">): RealizedRow[] {
  const rows = db.all<{ market_id: string; side: string; price: number; size: number; fee: number; state_json: string | null }>(
    `SELECT f.market_id, f.side, f.price, f.size, f.fee, r.state_json FROM fills f LEFT JOIN jev_requests r ON r.decision_id = f.decision_id WHERE f.mode = ?`, [mode]);
  const acc = new Map<string, { fills: number; shares: number; cost: number; pnl: number; wins: number }>();
  for (const r of rows) {
    const outcome = outcomes.get(r.market_id);
    if (!outcome) continue;
    const secs = r.state_json ? Number((JSON.parse(r.state_json) as { market?: { secondsRemaining?: number } }).market?.secondsRemaining) : NaN;
    const b = TIME_BUCKETS.find((x) => secs >= x.lo && secs < x.hi)?.label ?? "unknown";
    const pnl = ((r.side === outcome ? 1 : 0) - r.price) * r.size - r.fee;
    const a = acc.get(b) ?? { fills: 0, shares: 0, cost: 0, pnl: 0, wins: 0 };
    a.fills++; a.shares += r.size; a.cost += r.price * r.size; a.pnl += pnl; if (pnl > 0) a.wins++;
    acc.set(b, a);
  }
  const labels = [...TIME_BUCKETS.map((b) => b.label), "unknown"];
  return labels.filter((l) => acc.has(l)).map((l) => { const a = acc.get(l)!; return { bucket: l, fills: a.fills, shares: a.shares, costUsd: a.cost, pnl: a.pnl, pnlPerShare: a.shares > 0 ? a.pnl / a.shares : NaN, winRate: a.fills > 0 ? a.wins / a.fills : NaN }; });
}

/* ---------- Animal00-style inventory research (brief §19) ---------- */

export interface Animal00Report {
  readonly observations: number;
  /** States where the favoured side asks 0.98-0.995 and the complement asks <= 0.02. */
  readonly candidateStates: number;
  readonly candidateShare: number | null;
  /** How often the favoured side actually won in those states, vs. the mean ask paid. */
  readonly winnerAccuracy: number | null;
  readonly meanWinnerAsk: number | null;
  readonly meanComplementAsk: number | null;
  readonly meanPairCost: number | null;
  /** Pair cost below 1.00: buying both and merging locks a profit regardless of outcome. */
  readonly pairBelowParStates: number;
  readonly pairBelowParShare: number | null;
  readonly meanLockedPairPnlPerShare: number | null;
  /** Naive EV per share of holding the winner to settlement in those states. */
  readonly naiveWinnerPnlPerShare: number | null;
  /** EV per share of the full pattern: pair merged at par, excess winner retained. Equals winner EV minus complement cost when the complement is not merged. */
  readonly byTime: EdgeRow[];
  readonly actionMixInCandidates: Record<string, number>;
}

export function animal00(obs: readonly Observation[]): Animal00Report {
  const cand = obs.filter((o) => {
    const e = naiveEdge(o);
    const complement = e.side === "UP" ? o.downAsk : o.upAsk;
    return e.ask >= 0.98 && e.ask <= 0.995 && complement <= 0.02;
  });
  const n = cand.length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  const edges = cand.map(naiveEdge);
  const pairCosts = cand.map((o) => o.upAsk + o.downAsk);
  const belowPar = pairCosts.filter((c) => c < 1);
  const mix: Record<string, number> = {};
  for (const o of cand) mix[o.action] = (mix[o.action] ?? 0) + 1;
  return {
    observations: obs.length, candidateStates: n, candidateShare: obs.length ? n / obs.length : null,
    winnerAccuracy: n ? edges.filter((e) => e.pnl > 0).length / n : null,
    meanWinnerAsk: mean(edges.map((e) => e.ask)),
    meanComplementAsk: mean(cand.map((o, i) => (edges[i]!.side === "UP" ? o.downAsk : o.upAsk))),
    meanPairCost: mean(pairCosts),
    pairBelowParStates: belowPar.length, pairBelowParShare: n ? belowPar.length / n : null,
    meanLockedPairPnlPerShare: belowPar.length ? mean(belowPar.map((c) => 1 - c)) : null,
    naiveWinnerPnlPerShare: mean(edges.map((e) => e.pnl)),
    byTime: TIME_BUCKETS.map((b) => edgeSummary(b.label, cand.filter((o) => o.secondsRemaining >= b.lo && o.secondsRemaining < b.hi))),
    actionMixInCandidates: mix,
  };
}

/* ---------- Latency report (brief §12, §37) ---------- */

export interface LatencyReport {
  readonly generatedAt: string;
  readonly decisions: number;
  readonly jevLatencyMs: Percentiles;
  readonly stages: Record<string, Percentiles>;
  /** Share of decisions whose Jev latency exceeded each threshold. */
  readonly jevOver: Record<string, number | null>;
  readonly shadow: { orders: number; signingMs: Percentiles; movedAgainstBps: Percentiles } | null;
  readonly staleness: { buys: number; staleBuys: number; staleShare: number | null };
}

export function latencyReport(db: Db, nowIso: string): LatencyReport {
  const jev = db.all<{ ms: number }>(`SELECT jev_latency_ms AS ms FROM jev_requests`).map((r) => r.ms);
  const stageNames = ["feed_to_state_ms", "state_to_jev_ms", "jev_ms", "jev_to_submit_ms", "submit_to_ack_ms", "feed_to_ack_ms"];
  const stages: Record<string, Percentiles> = {};
  for (const s of stageNames) stages[s] = percentiles(db.all<{ v: number | null }>(`SELECT ${s} AS v FROM latency_measurements WHERE ${s} IS NOT NULL`).map((r) => r.v as number));
  const over = (t: number) => (jev.length ? jev.filter((v) => v > t).length / jev.length : null);
  const shadowN = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM shadow_orders`)?.n ?? 0;
  const buys = db.get<{ n: number; stale: number }>(`SELECT COUNT(*) AS n, SUM(risk_reason = 'STALE_DECISION') AS stale FROM jev_answers WHERE requested_action LIKE 'BUY%' OR requested_action = 'ADD_COMPLEMENT'`);
  return {
    generatedAt: nowIso, decisions: jev.length, jevLatencyMs: percentiles(jev), stages,
    jevOver: { "250ms": over(250), "500ms": over(500), "1000ms": over(1000), "2000ms": over(2000) },
    shadow: shadowN ? {
      orders: shadowN,
      signingMs: percentiles(db.all<{ v: number }>(`SELECT signing_ms AS v FROM shadow_orders`).map((r) => r.v)),
      movedAgainstBps: percentiles(db.all<{ v: number }>(`SELECT moved_against_bps AS v FROM shadow_orders WHERE moved_against_bps IS NOT NULL`).map((r) => r.v)),
    } : null,
    staleness: { buys: buys?.n ?? 0, staleBuys: buys?.stale ?? 0, staleShare: buys?.n ? (buys.stale ?? 0) / buys.n : null },
  };
}
