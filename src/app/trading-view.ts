import type { Db } from "../persistence/database.js";

/**
 * Trading state for the dashboard. Execution records are grouped by `mode`:
 * "paper" (simulated against live books, main database), "backtest"
 * (simulated over recorded books, data/backtest.sqlite) and "live" once it
 * exists. Simulated and real money never add up in one number.
 */
export interface TradingSummary {
  readonly mode: string;
  readonly settledMarkets: number;
  readonly wins: number;
  readonly losses: number;
  readonly netPnl: number;
  readonly grossPnl: number;
  readonly fees: number;
  readonly gas: number;
  readonly mergePnl: number;
  readonly bestMarket: number | null;
  readonly worstMarket: number | null;
  readonly maxDrawdown: number;
  readonly orders: number;
  readonly fills: number;
  readonly partials: number;
  readonly noFills: number;
  readonly fillRatio: number | null;
  readonly volumeUsd: number;
  readonly curve: { t: number; pnl: number; slug: string }[];
  readonly perMarket: { slug: string; closesAtMs: number; outcome: string | null; netPnl: number; orders: number; fills: number }[];
  readonly recentFills: { tsMs: number; slug: string; side: string; price: number; size: number; fee: number; orderType: string }[];
  readonly openPosition: { slug: string; upShares: number; downShares: number; pairedShares: number; totalCost: number; pnlIfUp: number; pnlIfDown: number } | null;
}

export function collectTrading(db: Db, mode: string): TradingSummary | null {
  const has = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE mode = ?`, [mode])?.n ?? 0;
  const settled = db.all<{ market_id: string; slug: string; closes_at_ms: number; resolved: string | null; pnl_json: string }>(
    `SELECT p.market_id, m.slug, m.closes_at_ms, m.resolved_outcome AS resolved, p.pnl_json
     FROM pnl_snapshots p JOIN markets m USING (market_id) WHERE p.mode = ? ORDER BY m.closes_at_ms`, [mode]);
  if (has === 0 && settled.length === 0) return null;

  const orderStats = db.all<{ market_id: string; orders: number; fills: number; partials: number; nofills: number }>(
    `SELECT market_id, COUNT(*) AS orders,
            SUM(CASE WHEN status='FILLED' THEN 1 ELSE 0 END) AS fills,
            SUM(CASE WHEN status='PARTIAL' THEN 1 ELSE 0 END) AS partials,
            SUM(CASE WHEN status='NO_FILL' THEN 1 ELSE 0 END) AS nofills
     FROM orders WHERE mode = ? GROUP BY market_id`, [mode]);
  const byMarket = new Map(orderStats.map((o) => [o.market_id, o]));
  const volume = db.get<{ v: number }>(`SELECT COALESCE(SUM(price * size), 0) AS v FROM fills WHERE mode = ?`, [mode])?.v ?? 0;

  let cum = 0, peak = 0, maxDd = 0, gross = 0, fees = 0, gas = 0, merge = 0, wins = 0, losses = 0;
  const curve: TradingSummary["curve"] = [];
  const perMarket: TradingSummary["perMarket"] = [];
  for (const s of settled) {
    const pnl = JSON.parse(s.pnl_json) as { netPnl: number; grossPnl: number; fees: number; gas: number; mergePnl: number };
    cum += pnl.netPnl; gross += pnl.grossPnl; fees += pnl.fees; gas += pnl.gas; merge += pnl.mergePnl;
    if (pnl.netPnl > 0) wins++; else if (pnl.netPnl < 0) losses++;
    peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum);
    curve.push({ t: s.closes_at_ms, pnl: Number(cum.toFixed(4)), slug: s.slug });
    const o = byMarket.get(s.market_id);
    perMarket.push({ slug: s.slug, closesAtMs: s.closes_at_ms, outcome: s.resolved, netPnl: Number(pnl.netPnl.toFixed(4)), orders: o?.orders ?? 0, fills: (o?.fills ?? 0) + (o?.partials ?? 0) });
  }
  const totals = orderStats.reduce((a, o) => ({ orders: a.orders + o.orders, fills: a.fills + o.fills, partials: a.partials + o.partials, nofills: a.nofills + o.nofills }), { orders: 0, fills: 0, partials: 0, nofills: 0 });
  const recentFills = db.all<{ ts_ms: number; slug: string; side: string; price: number; size: number; fee: number; order_type: string }>(
    `SELECT f.ts_ms, m.slug, f.side, f.price, f.size, f.fee, o.order_type FROM fills f JOIN orders o USING (order_id) JOIN markets m ON m.market_id = f.market_id WHERE f.mode = ? ORDER BY f.ts_ms DESC LIMIT 20`, [mode])
    .map((f) => ({ tsMs: f.ts_ms, slug: f.slug, side: f.side, price: f.price, size: f.size, fee: f.fee, orderType: f.order_type }));
  const open = db.get<{ slug: string; inventory_json: string }>(
    `SELECT m.slug, i.inventory_json FROM inventory_snapshots i JOIN markets m USING (market_id) WHERE i.mode = ? AND m.closes_at_ms > ? ORDER BY i.ts_ms DESC LIMIT 1`, [mode, Date.now()]);
  const inv = open ? (JSON.parse(open.inventory_json) as { upShares: number; downShares: number; pairedShares: number; totalCost: number; pnlIfUp: number; pnlIfDown: number }) : null;

  const netByMarket = perMarket.map((m) => m.netPnl);
  return {
    mode, settledMarkets: settled.length, wins, losses,
    netPnl: Number(cum.toFixed(4)), grossPnl: Number(gross.toFixed(4)), fees: Number(fees.toFixed(4)), gas: Number(gas.toFixed(4)), mergePnl: Number(merge.toFixed(4)),
    bestMarket: netByMarket.length ? Math.max(...netByMarket) : null, worstMarket: netByMarket.length ? Math.min(...netByMarket) : null,
    maxDrawdown: Number(maxDd.toFixed(4)),
    orders: totals.orders, fills: totals.fills, partials: totals.partials, noFills: totals.nofills,
    fillRatio: totals.orders ? (totals.fills + totals.partials) / totals.orders : null,
    volumeUsd: Number(volume.toFixed(2)),
    curve, perMarket: perMarket.slice(-40).reverse(), recentFills,
    openPosition: open && inv ? { slug: open.slug, ...inv } : null,
  };
}
