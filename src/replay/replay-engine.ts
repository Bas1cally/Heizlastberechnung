import { createHash } from "node:crypto";
import type { Db } from "../persistence/database.js";
import type { DecisionRepository } from "../persistence/repositories/decisions.js";
import type { MarketIdentity } from "../market/market-state.js";
import { MarketStateStore } from "../market/market-state.js";
import { computeInventory, EMPTY_POSITION } from "../inventory/accounting.js";
import { PriceWindow } from "../features/returns.js";
import { normalizeBook } from "../feeds/book-normalizer.js";
import { buildJevState, canonicalJson } from "../jev/state-builder.js";
import { DEFAULT_MATERIAL, materialChange } from "../jev/material-change.js";
import type { JevAnswers, JevInputState } from "../jev/decision-types.js";
import type { Decision } from "../jev/decision-engine.js";
import { QUESTIONS } from "../jev/questions.js";
import type { JevCall } from "../jev/decision-engine.js";
import { evaluateRisk } from "../risk/risk-gate.js";
import type { RiskLimits } from "../risk/limits.js";

/**
 * Causal replay (brief §24, §25).
 *
 * Recorded ticks and book snapshots are merged into one time-ordered stream
 * and fed through the same state store, feature builder and material-change
 * gate the live observer uses. At recorded time t, the state contains only
 * events received at or before t; nothing later is visible.
 *
 * Jev answers are looked up by the SHA-256 of the canonical state in the
 * source database's cache first, so re-running a replay costs nothing until
 * the state differs. `freshJev` bypasses the cache.
 */
export interface ReplayEvent {
  readonly atMs: number;
  readonly kind: "tick" | "book";
  readonly price?: number;
  readonly tsMs?: number;
  readonly assetId?: string;
  readonly bids?: readonly { price: number; size: number }[];
  readonly asks?: readonly { price: number; size: number }[];
}

export function loadReplayEvents(db: Db, marketId: string): ReplayEvent[] {
  const ticks = db.all<{ ts_ms: number; received_at_ms: number; price: number }>(
    `SELECT ts_ms, received_at_ms, price FROM ticks WHERE market_id = ? AND source = 'chainlink'`, [marketId]);
  const books = db.all<{ asset_id: string; received_at_ms: number; bids_json: string; asks_json: string }>(
    `SELECT asset_id, received_at_ms, bids_json, asks_json FROM orderbook_snapshots WHERE market_id = ?`, [marketId]);
  const events: ReplayEvent[] = [
    ...ticks.map((t): ReplayEvent => ({ atMs: t.received_at_ms, kind: "tick", price: t.price, tsMs: t.ts_ms })),
    ...books.map((b): ReplayEvent => ({ atMs: b.received_at_ms, kind: "book", assetId: b.asset_id, bids: JSON.parse(b.bids_json), asks: JSON.parse(b.asks_json) })),
  ];
  // Stable, causal order: by receive time, ticks before books at equal times.
  return events.sort((a, b) => a.atMs - b.atMs || (a.kind === "tick" ? -1 : 1));
}

export function loadMarketIdentity(db: Db, marketId: string): MarketIdentity | undefined {
  const m = db.get<{ market_id: string; condition_id: string; slug: string; question: string; up_asset_id: string; down_asset_id: string; opened_at_ms: number; closes_at_ms: number; tick_size: number | null; min_order_size: number | null }>(
    `SELECT * FROM markets WHERE market_id = ?`, [marketId]);
  if (!m) return undefined;
  return { marketId: m.market_id, conditionId: m.condition_id, slug: m.slug, question: m.question, upAssetId: m.up_asset_id, downAssetId: m.down_asset_id,
    openedAtMs: m.opened_at_ms, closesAtMs: m.closes_at_ms, tickSize: m.tick_size ?? undefined, minOrderSize: m.min_order_size ?? undefined };
}

export interface ReplayOptions {
  readonly identity: MarketIdentity;
  readonly events: readonly ReplayEvent[];
  readonly limits: RiskLimits;
  readonly heartbeatMs: number;
  readonly minIntervalMs: number;
  /** Cache lookup in the source database. */
  readonly cached: (inputHash: string) => { answers: string; model: string; latencyMs: number } | undefined;
  readonly call: JevCall | undefined;
  readonly freshJev: boolean;
  readonly out: DecisionRepository;
  readonly onDecision?: (d: Decision, cacheHit: boolean) => void;
}

export interface ReplayResult {
  readonly events: number;
  readonly decisions: number;
  readonly cacheHits: number;
  readonly jevCalls: number;
  readonly skippedNoJev: number;
}

export async function replayMarket(o: ReplayOptions): Promise<ReplayResult> {
  const store = new MarketStateStore(o.identity, computeInventory(EMPTY_POSITION));
  const prices = new PriceWindow(120_000);
  let lastJev: JevInputState | undefined;
  let lastSubmitAt = Number.NEGATIVE_INFINITY;
  let lastBookAt = Number.NEGATIVE_INFINITY;
  let lastTickAt = Number.NEGATIVE_INFINITY;
  let decisions = 0, cacheHits = 0, jevCalls = 0, skippedNoJev = 0;

  o.out.upsertMarket(o.identity, o.events[0]?.atMs ?? 0);

  for (const ev of o.events) {
    if (ev.kind === "tick") {
      prices.push({ ts: ev.tsMs!, price: ev.price! });
      store.setSettlementPrice(ev.price!, ev.tsMs!);
      lastTickAt = ev.atMs;
    } else {
      store.setBook(normalizeBook({ assetId: ev.assetId!, bids: ev.bids!, asks: ev.asks!, receivedAtMs: ev.atMs }));
      lastBookAt = ev.atMs;
    }

    const snap = store.snapshot(ev.atMs);
    if (!snap.upBook || !snap.downBook || snap.settlementCurrentPrice === undefined) continue;
    if (ev.atMs - lastSubmitAt < o.minIntervalMs) continue;

    const state = buildJevState({ state: snap, prices, chainlinkAgeMs: ev.atMs - lastTickAt, bookAgeMs: ev.atMs - lastBookAt, pairQty: o.limits.maxOrderSizeShares });
    const reason = materialChange(lastJev, state, ev.atMs - lastSubmitAt, { ...DEFAULT_MATERIAL, heartbeatMs: o.heartbeatMs });
    if (!reason) continue;
    lastJev = state;
    lastSubmitAt = ev.atMs;
    const materialVersion = store.markMaterial();
    const inputHash = createHash("sha256").update(canonicalJson(state)).digest("hex");

    let answers: JevAnswers | undefined;
    let model = "cache";
    let latencyMs = 0;
    let hit = false;
    const c = o.freshJev ? undefined : o.cached(inputHash);
    if (c) {
      answers = JSON.parse(c.answers); model = c.model; latencyMs = c.latencyMs; hit = true; cacheHits++;
    } else if (o.call) {
      const t0 = performance.now();
      const res = await o.call(state, QUESTIONS, new AbortController().signal);
      latencyMs = performance.now() - t0; answers = res.answers; model = res.model; jevCalls++;
    } else {
      skippedNoJev++;
      continue;
    }

    const d: Decision = {
      decisionId: `replay-${o.identity.marketId}-${materialVersion}`,
      marketId: o.identity.marketId,
      stateVersion: materialVersion,
      rawStateVersion: snap.stateVersion,
      materialReason: reason,
      packetReceivedMono: undefined,
      stateUpdatedMono: undefined,
      inputHash,
      requestedAtMono: 0, respondedAtMono: latencyMs, jevLatencyMs: latencyMs,
      timestampMs: ev.atMs,
      state, answers: answers!, model,
      usage: { input_tokens: 0, output_tokens: 0 },
      requestedAction: answers!.action.choice as Decision["requestedAction"],
    };
    // In replay the decision is evaluated against the state it was made on:
    // no latency has elapsed, so the version matches by construction. Fill
    // and latency realism belong to the paper layer, not here.
    const verdict = evaluateRisk({
      decisionStateVersion: materialVersion, currentStateVersion: materialVersion,
      action: d.requestedAction, orderSizeShares: o.limits.maxOrderSizeShares,
      secondsRemaining: snap.secondsRemaining, chainlinkAgeMs: ev.atMs - lastTickAt, orderbookAgeMs: ev.atMs - lastBookAt, jevLatencyMs: latencyMs,
      marketLiquidityShares: Math.min(snap.upBook.asks.reduce((s, l) => s + l.size, 0), snap.downBook.asks.reduce((s, l) => s + l.size, 0)),
      spread: Math.max(state.orderbook.upSpread, state.orderbook.downSpread),
      marketExposureUsd: 0, totalExposureUsd: 0, unpairedExposureUsd: 0, openOrders: 0, dailyPnlUsd: 0, consecutiveErrors: 0,
      liveTradingEnabled: false,
    }, o.limits);
    o.out.saveDecision(d, verdict);
    decisions++;
    o.onDecision?.(d, hit);
  }
  return { events: o.events.length, decisions, cacheHits, jevCalls, skippedNoJev };
}
