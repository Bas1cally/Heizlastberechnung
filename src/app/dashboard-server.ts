import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Db } from "../persistence/database.js";
import { DecisionRepository } from "../persistence/repositories/decisions.js";
import { percentiles } from "../analytics/latency.js";
import { directionalProbability } from "../analytics/edge-analysis.js";
import { collectTrading } from "./trading-view.js";
import { loadMarketOutcomes, loadObservations } from "../analytics/observations.js";
import { brierScore, calibrationByConfidence } from "../analytics/calibration.js";

/** Jev's P(UP) against the market's UP ask over one market - the picture that answers "does Jev know something". */
function timelineFor(db: Db, marketId: string): { t: number; pUp: number; upAsk: number; s: number; action: string }[] {
  const rows = db.all<{ timestamp_ms: number; state_json: string; answers_json: string; requested_action: string }>(
    `SELECT r.timestamp_ms, r.state_json, a.answers_json, a.requested_action FROM jev_requests r JOIN jev_answers a USING (decision_id) WHERE r.market_id = ? ORDER BY r.timestamp_ms LIMIT 600`, [marketId]);
  const out: { t: number; pUp: number; upAsk: number; s: number; action: string }[] = [];
  for (const r of rows) {
    const s = JSON.parse(r.state_json); const a = JSON.parse(r.answers_json);
    if (!a.settlement_direction) continue;
    const dir = directionalProbability(a.settlement_direction);
    out.push({ t: r.timestamp_ms, pUp: Number(dir.pUp.toFixed(4)), upAsk: Number(s.orderbook?.upAsk ?? NaN), s: Number(s.market?.secondsRemaining ?? NaN), action: r.requested_action });
  }
  return out;
}

let calCache: { at: number; value: unknown } | undefined;
/** Calibration summary, recomputed at most once a minute - it walks every resolved market. */
function calibrationSummary(db: Db, nowMs: number): unknown {
  if (calCache && nowMs - calCache.at < 60_000) return calCache.value;
  let value: unknown = null;
  try {
    const outcomes = loadMarketOutcomes(db, nowMs);
    const obs = loadObservations(db, outcomes);
    const resolved = outcomes.filter((o) => o.outcome).length;
    value = obs.length === 0 ? { resolved, observations: 0 } : {
      resolved, observations: obs.length,
      brier: Number(brierScore(obs).toFixed(4)),
      accuracy: Number((obs.filter((o) => (o.pUp >= 0.5) === o.outcomeUp).length / obs.length).toFixed(4)),
      upShare: Number((outcomes.filter((o) => o.outcome === "UP").length / Math.max(1, resolved)).toFixed(3)),
      buckets: calibrationByConfidence(obs).filter((r) => r.n > 0).map((r) => ({ bucket: r.bucket, n: r.n, predicted: Number(r.predicted.toFixed(3)), observed: Number(r.observed.toFixed(3)) })),
    };
  } catch { value = null; }
  calCache = { at: nowMs, value };
  return value;
}

/**
 * A small read-mostly dashboard over the bot's database. Runs as its own
 * process; the only writes it makes are operator controls (kill / resume),
 * which the bot polls from the `control` table.
 */
export function collectState(db: Db, nowMs: number): Record<string, unknown> {
  const repo = new DecisionRepository(db);
  const hb = (c: string) => { const r = repo.getControl(`heartbeat:${c}`); return r ? { ...(JSON.parse(r.value) as object), ageS: Number(((nowMs - r.updatedMs) / 1000).toFixed(1)) } : null; };
  const kill = repo.getControl("kill");
  const last = db.get<{ decision_id: string; market_id: string; timestamp_ms: number; state_json: string; answers_json: string; requested_action: string; risk_result: string; risk_reason: string | null; jev_latency_ms: number; model: string; input_tokens: number; output_tokens: number; material_reason: string | null; slug: string }>(
    `SELECT r.decision_id, r.market_id, r.timestamp_ms, r.state_json, a.answers_json, a.requested_action, a.risk_result, a.risk_reason, r.jev_latency_ms, r.model, r.input_tokens, r.output_tokens, r.material_reason, m.slug
     FROM jev_requests r JOIN jev_answers a USING (decision_id) JOIN markets m USING (market_id) ORDER BY r.timestamp_ms DESC LIMIT 1`);
  const recent = (ms: number) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jev_requests WHERE timestamp_ms > ?`, [nowMs - ms])?.n ?? 0;
  const actions = db.all<{ a: string; n: number }>(`SELECT requested_action AS a, COUNT(*) AS n FROM jev_answers a JOIN jev_requests r USING (decision_id) WHERE r.timestamp_ms > ? GROUP BY 1 ORDER BY 2 DESC`, [nowMs - 3_600_000]);
  const risk = db.all<{ r: string; reason: string | null; n: number }>(`SELECT risk_result AS r, risk_reason AS reason, COUNT(*) AS n FROM jev_answers a JOIN jev_requests r USING (decision_id) WHERE r.timestamp_ms > ? GROUP BY 1,2 ORDER BY 3 DESC`, [nowMs - 3_600_000]);
  const jev = db.all<{ ms: number }>(`SELECT jev_latency_ms AS ms FROM jev_requests WHERE timestamp_ms > ?`, [nowMs - 3_600_000]).map((x) => x.ms);
  const tokens = db.get<{ i: number; o: number; n: number }>(`SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, COUNT(*) AS n FROM jev_requests`);
  const markets = db.get<{ n: number; resolved: number }>(`SELECT COUNT(*) AS n, SUM(CASE WHEN resolved_outcome IS NOT NULL THEN 1 ELSE 0 END) AS resolved FROM markets`);
  const ticks = db.get<{ last: number | null }>(`SELECT MAX(received_at_ms) AS last FROM ticks`);
  const books = db.get<{ last: number | null }>(`SELECT MAX(received_at_ms) AS last FROM orderbook_snapshots`);
  const errors = db.all<{ ts_ms: number; component: string; message: string }>(`SELECT ts_ms, component, message FROM errors ORDER BY ts_ms DESC LIMIT 8`);
  const shadow = db.get<{ n: number; fills: number; nofill: number }>(`SELECT COUNT(*) AS n, SUM(CASE WHEN hypothetical_status='FILLED' THEN 1 ELSE 0 END) AS fills, SUM(CASE WHEN hypothetical_status='NO_FILL' THEN 1 ELSE 0 END) AS nofill FROM shadow_orders`);
  const dayStart = new Date(nowMs); dayStart.setHours(0, 0, 0, 0);
  const today = db.get<{ i: number; o: number; n: number }>(`SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, COUNT(*) AS n FROM jev_requests WHERE timestamp_ms >= ?`, [dayStart.getTime()]);
  const usdPerM = Number(process.env["TYPESAFE_USD_PER_MTOKEN"] ?? "");
  const recentMarkets = db.all<{ slug: string; resolved_outcome: string | null; opened_at_ms: number; closes_at_ms: number; n: number }>(`SELECT m.slug, m.resolved_outcome, m.opened_at_ms, m.closes_at_ms, (SELECT COUNT(*) FROM jev_requests r WHERE r.market_id = m.market_id) AS n FROM markets m ORDER BY m.opened_at_ms DESC LIMIT 12`);

  let lastDecision: Record<string, unknown> | null = null;
  if (last) {
    const s = JSON.parse(last.state_json); const a = JSON.parse(last.answers_json);
    const dir = a.settlement_direction ? directionalProbability(a.settlement_direction) : null;
    const probs = a.action?.probabilities ? Object.entries(a.action.probabilities as Record<string, number>).sort((x, y) => y[1] - x[1]).slice(0, 3) : [];
    lastDecision = {
      slug: last.slug, at: last.timestamp_ms, ageS: Number(((nowMs - last.timestamp_ms) / 1000).toFixed(1)),
      secondsRemaining: s.market?.secondsRemaining, distanceBps: s.market?.distanceBps, settlementStart: s.market?.settlementStartPrice, settlementCurrent: s.market?.settlementCurrentPrice,
      upBid: s.orderbook?.upBid, upAsk: s.orderbook?.upAsk, downBid: s.orderbook?.downBid, downAsk: s.orderbook?.downAsk, pairAskCost: s.orderbook?.pairAskCost, pairEdge: s.orderbook?.pairEdge,
      inventory: s.inventory, pUp: dir?.pUp, pDown: dir?.pDown, unresolved: dir?.unresolvedMass,
      action: last.requested_action, actionProbs: probs, risk: last.risk_result, riskReason: last.risk_reason, jevMs: last.jev_latency_ms, model: last.model, tokens: [last.input_tokens, last.output_tokens], materialReason: last.material_reason,
    };
  }
  const liveMarket = db.get<{ market_id: string; slug: string; opened_at_ms: number; closes_at_ms: number }>(`SELECT market_id, slug, opened_at_ms, closes_at_ms FROM markets ORDER BY opened_at_ms DESC LIMIT 1`);
  return {
    now: nowMs,
    bot: { observer: hb("observer"), shadow: hb("shadow") },
    market: liveMarket ? { slug: liveMarket.slug, openedAtMs: liveMarket.opened_at_ms, closesAtMs: liveMarket.closes_at_ms, live: liveMarket.closes_at_ms > nowMs, timeline: timelineFor(db, liveMarket.market_id) } : null,
    today: { decisions: today?.n ?? 0, input: today?.i ?? 0, output: today?.o ?? 0, usd: Number.isFinite(usdPerM) && usdPerM > 0 ? Number((((today?.i ?? 0) + (today?.o ?? 0)) / 1e6 * usdPerM).toFixed(4)) : null },
    calibration: calibrationSummary(db, nowMs),
    kill: kill ? { ...(JSON.parse(kill.value) as object), updatedMs: kill.updatedMs } : { tripped: false },
    feeds: { chainlinkAgeS: ticks?.last ? Number((Math.max(0, nowMs - ticks.last) / 1000).toFixed(1)) : null, bookAgeS: books?.last ? Number((Math.max(0, nowMs - books.last) / 1000).toFixed(1)) : null },
    decisions: { total: tokens?.n ?? 0, lastMinute: recent(60_000), lastHour: recent(3_600_000) },
    tokens: { input: tokens?.i ?? 0, output: tokens?.o ?? 0 },
    markets: { total: markets?.n ?? 0, resolved: markets?.resolved ?? 0, recent: recentMarkets },
    jevLatencyHour: percentiles(jev),
    actionsHour: Object.fromEntries(actions.map((r) => [r.a, r.n])),
    riskHour: risk,
    shadow: shadow && shadow.n > 0 ? shadow : null,
    errors,
    lastDecision,
  };
}

import { HTML } from "./dashboard-html.js";

export function startDashboard(db: Db, port: number, log: (msg: string) => void, paperDb?: Db): () => void {
  const repo = new DecisionRepository(db);
  const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });

  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(HTML); return; }
      if (req.method === "GET" && url === "/api/state") {
        const state = collectState(db, Date.now());
        // Execution records, grouped by mode so simulated and real money never share a number.
        const trading = {
          paper: paperDb ? collectTrading(paperDb, "paper") : null,
          live: collectTrading(db, "live"),
        };
        return json(res, 200, { ...state, trading });
      }
      if (req.method === "POST" && url === "/api/kill") {
        const body = await readBody(req).then((b) => (b ? (JSON.parse(b) as { reason?: string }) : {}));
        repo.setControl("kill", JSON.stringify({ tripped: true, reasons: ["MANUAL"], hard: true, since: Date.now(), note: body.reason ?? "manual" }), Date.now());
        log(`KILL requested from dashboard: ${body.reason ?? "manual"}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url === "/api/resume") {
        repo.setControl("kill", JSON.stringify({ tripped: false, resumedAt: Date.now() }), Date.now());
        log("RESUME requested from dashboard");
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.listen(port, "127.0.0.1", () => log(`dashboard on http://127.0.0.1:${port}`));
  return () => server.close();
}
