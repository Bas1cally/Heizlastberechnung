import type { Db } from "../persistence/database.js";
import { percentiles } from "./latency.js";

/**
 * Phase 1 acceptance (brief §36), checked against the database rather than
 * asserted: 24 h of unattended runtime, websocket reconnection, stale-state
 * protection, every Jev decision stored, latency statistics generated.
 * Each criterion reports PASS, FAIL or INSUFFICIENT DATA with the numbers
 * it was judged on.
 */
export interface Criterion {
  readonly name: string;
  readonly status: "PASS" | "FAIL" | "INSUFFICIENT";
  readonly detail: string;
  readonly numbers: Record<string, number | null>;
}

export interface AcceptanceReport {
  readonly generatedAt: string;
  readonly overall: "PASS" | "FAIL" | "INSUFFICIENT";
  readonly criteria: Criterion[];
}

const H = 3_600_000;

export function acceptanceReport(db: Db, nowMs: number, requiredHours = 24): AcceptanceReport {
  const criteria: Criterion[] = [];

  // 1. Unattended runtime: span of recorded ticks, and the largest gap in them.
  //    A gap over 60 s means the process was down (market rollover takes < 20 s).
  const tickTs = db.all<{ t: number }>(`SELECT received_at_ms AS t FROM ticks ORDER BY received_at_ms`).map((r) => r.t);
  let maxGap = 0, gaps = 0, downtime = 0;
  for (let i = 1; i < tickTs.length; i++) { const g = tickTs[i]! - tickTs[i - 1]!; if (g > maxGap) maxGap = g; if (g > 60_000) { gaps++; downtime += g; } }
  const spanMs = tickTs.length ? tickTs[tickTs.length - 1]! - tickTs[0]! : 0;
  const longestContinuous = (() => { let best = 0, start = tickTs[0] ?? 0; for (let i = 1; i < tickTs.length; i++) { if (tickTs[i]! - tickTs[i - 1]! > 60_000) { best = Math.max(best, tickTs[i - 1]! - start); start = tickTs[i]!; } } return tickTs.length ? Math.max(best, tickTs[tickTs.length - 1]! - start) : 0; })();
  criteria.push({
    name: `${requiredHours} h unattended runtime`,
    status: longestContinuous >= requiredHours * H ? "PASS" : spanMs >= requiredHours * H ? "FAIL" : "INSUFFICIENT",
    detail: `recorded span ${(spanMs / H).toFixed(1)} h, longest continuous stretch ${(longestContinuous / H).toFixed(1)} h, ${gaps} outage(s) over 60 s totalling ${(downtime / 60_000).toFixed(1)} min, largest gap ${(maxGap / 1000).toFixed(0)} s`,
    numbers: { spanHours: spanMs / H, longestContinuousHours: longestContinuous / H, outages: gaps, downtimeMinutes: downtime / 60_000, maxGapSeconds: maxGap / 1000 },
  });

  // 2. Websocket reconnection: stream errors were recorded AND data kept flowing afterwards.
  const wsErrors = db.all<{ ts_ms: number; component: string }>(`SELECT ts_ms, component FROM errors WHERE component IN ('market-ws','chainlink-ws','chainlink-twap-ws') ORDER BY ts_ms`);
  const recovered = wsErrors.filter((e) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ticks WHERE received_at_ms > ? AND received_at_ms < ?`, [e.ts_ms, e.ts_ms + 120_000])?.n ?? 0).length;
  criteria.push({
    name: "websocket reconnection",
    status: wsErrors.length === 0 ? "INSUFFICIENT" : recovered === wsErrors.length ? "PASS" : "FAIL",
    detail: wsErrors.length === 0 ? "no stream error occurred yet, so reconnection was never exercised live (covered by tests only)" : `${wsErrors.length} stream error(s), data resumed within 2 min after ${recovered} of them`,
    numbers: { streamErrors: wsErrors.length, recovered },
  });

  // 3. Stale-state protection: stale decisions exist and none of them was approved.
  const stale = db.get<{ n: number; approved: number }>(`SELECT COUNT(*) AS n, SUM(risk_result = 'APPROVED') AS approved FROM jev_answers WHERE risk_reason IN ('STALE_DECISION','STALE_CHAINLINK','STALE_ORDERBOOK','JEV_TOO_SLOW')`);
  const buys = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jev_answers WHERE requested_action LIKE 'BUY%' OR requested_action = 'ADD_COMPLEMENT'`)?.n ?? 0;
  const staleBuys = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jev_answers WHERE risk_reason = 'STALE_DECISION'`)?.n ?? 0;
  criteria.push({
    name: "stale-state protection",
    status: (stale?.n ?? 0) === 0 ? "INSUFFICIENT" : (stale?.approved ?? 0) === 0 ? "PASS" : "FAIL",
    detail: `${stale?.n ?? 0} decision(s) rejected for staleness, ${stale?.approved ?? 0} approved despite it; ${staleBuys} of ${buys} buy decision(s) were stale at validation`,
    numbers: { staleRejections: stale?.n ?? 0, staleApproved: stale?.approved ?? 0, buys, staleBuys, staleBuyShare: buys ? staleBuys / buys : null },
  });

  // 4. Every Jev decision stored: request, answer and latency rows line up.
  const req = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jev_requests`)?.n ?? 0;
  const ans = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jev_answers`)?.n ?? 0;
  const lat = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM latency_measurements WHERE decision_id IS NOT NULL`)?.n ?? 0;
  const jevErrors = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM errors WHERE component = 'jev'`)?.n ?? 0;
  criteria.push({
    name: "every Jev decision stored",
    status: req === 0 ? "INSUFFICIENT" : req === ans && lat === req ? "PASS" : "FAIL",
    detail: `${req} request(s), ${ans} answer(s), ${lat} latency row(s), ${jevErrors} failed call(s) recorded as errors`,
    numbers: { requests: req, answers: ans, latencyRows: lat, jevErrors, errorRate: req + jevErrors ? jevErrors / (req + jevErrors) : null },
  });

  // 5. Latency statistics: enough samples for the percentiles to mean something.
  const jev = db.all<{ ms: number }>(`SELECT jev_latency_ms AS ms FROM jev_requests`).map((r) => r.ms);
  const p = percentiles(jev);
  criteria.push({
    name: "latency statistics generated",
    status: p.count >= 100 ? "PASS" : p.count > 0 ? "INSUFFICIENT" : "INSUFFICIENT",
    detail: p.count ? `${p.count} samples: Jev p50 ${p.p50.toFixed(0)} ms, p95 ${p.p95.toFixed(0)} ms, p99 ${p.p99.toFixed(0)} ms, max ${p.max.toFixed(0)} ms` : "no decisions yet",
    numbers: { samples: p.count, p50: p.count ? p.p50 : null, p95: p.count ? p.p95 : null, p99: p.count ? p.p99 : null, max: p.count ? p.max : null },
  });

  // 6. Nothing submitted: no order in a mode other than the simulations, and no live records at all.
  const live = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE mode NOT IN ('paper','backtest','shadow')`)?.n ?? 0;
  criteria.push({ name: "no order submitted", status: live === 0 ? "PASS" : "FAIL", detail: live === 0 ? "no order outside simulation modes" : `${live} order(s) outside simulation modes`, numbers: { nonSimulatedOrders: live } });

  const overall = criteria.some((c) => c.status === "FAIL") ? "FAIL" : criteria.some((c) => c.status === "INSUFFICIENT") ? "INSUFFICIENT" : "PASS";
  return { generatedAt: new Date(nowMs).toISOString(), overall, criteria };
}
