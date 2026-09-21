import type { MarketIdentity } from "./market-state.js";
import { parseSlug, windowAt, type Window } from "./window.js";

/**
 * Discovery for BTC 5-minute markets.
 *
 * Confirmed live (2026-09-21): markets are slugged
 * `btc-updown-5m-<unix seconds of window start>`, outcomes are an object
 * `{ yes: { label: "Up", tokenId }, no: { label: "Down", tokenId } }`, and a
 * title search returns stale and unrelated (hourly, daily) markets. So the
 * current market is computed from the clock and fetched by slug; nothing is
 * searched.
 *
 * The client interface below is the transformed `Market` shape returned by
 * `client.listMarkets({ slug: [...] })` (@polymarket/bindings gamma types).
 */
export interface GammaMarketLike {
  readonly id: string;
  readonly slug?: string | null;
  readonly conditionId: string | null;
  readonly question?: string | null;
  readonly description?: string | null;
  readonly state: {
    readonly active?: boolean | null;
    readonly closed?: boolean | null;
    readonly acceptingOrders?: boolean | null;
    readonly negRisk?: boolean | null;
    readonly startDate?: string | null;
    readonly endDate?: string | null;
  };
  readonly outcomes: {
    readonly yes: { readonly label: string; readonly tokenId: string | null; readonly price?: string | null };
    readonly no: { readonly label: string; readonly tokenId: string | null; readonly price?: string | null };
  };
  readonly trading: {
    readonly minimumOrderSize?: string | null;
    readonly minimumTickSize?: number | string | null;
  };
  readonly resolution?: { readonly source?: string | null } | null;
}

export interface DiscoveryClient {
  listMarkets(request: { slug?: string[]; pageSize?: number }): { firstPage(): Promise<{ items: readonly GammaMarketLike[] }> };
}

const UP_LABELS = new Set(["up", "yes", "higher", "above"]);
const DOWN_LABELS = new Set(["down", "no", "lower", "below"]);

/** Map outcome labels to (up, down) token ids. A surprise label fails loudly. */
export function mapOutcomes(m: GammaMarketLike): { upAssetId: string; downAssetId: string } | undefined {
  let up: string | undefined;
  let down: string | undefined;
  for (const o of [m.outcomes.yes, m.outcomes.no]) {
    if (!o?.tokenId) continue;
    const key = o.label.trim().toLowerCase();
    if (UP_LABELS.has(key)) up = o.tokenId;
    else if (DOWN_LABELS.has(key)) down = o.tokenId;
  }
  return up && down && up !== down ? { upAssetId: up, downAssetId: down } : undefined;
}

export function toIdentity(m: GammaMarketLike, durationSeconds: number): MarketIdentity | undefined {
  const ids = mapOutcomes(m);
  if (!ids || !m.conditionId || !m.slug) return undefined;

  // The slug is authoritative for timing. Gamma's dates are a fallback only.
  const w: Window | undefined = parseSlug(m.slug, durationSeconds);
  const closesAtMs = w?.closesAtMs ?? (m.state.endDate ? Date.parse(m.state.endDate) : Number.NaN);
  if (!Number.isFinite(closesAtMs)) return undefined;
  const openedAtMs = w?.openedAtMs ?? closesAtMs - durationSeconds * 1000;

  const tick = m.trading.minimumTickSize;
  const minSize = m.trading.minimumOrderSize;
  return {
    marketId: m.id,
    conditionId: m.conditionId,
    slug: m.slug,
    question: m.question ?? "",
    ...ids,
    openedAtMs,
    closesAtMs,
    tickSize: tick === null || tick === undefined ? undefined : Number(tick),
    minOrderSize: minSize === null || minSize === undefined ? undefined : Number(minSize),
  };
}

export async function fetchBySlug(client: DiscoveryClient, slug: string): Promise<GammaMarketLike | undefined> {
  const page = await client.listMarkets({ slug: [slug], pageSize: 5 }).firstPage();
  return page.items.find((m) => m.slug === slug) ?? page.items[0];
}

export interface Discovered {
  readonly identity: MarketIdentity;
  readonly raw: GammaMarketLike;
}

/**
 * The market for the window containing `nowMs`. Returns undefined when Gamma
 * does not list it (yet), or when it is closed / not accepting orders, so
 * the caller can wait for the next boundary instead of subscribing to a dead
 * market.
 */
export async function findCurrentMarket(
  client: DiscoveryClient,
  nowMs: number,
  durationSeconds = 300,
): Promise<Discovered | undefined> {
  const w = windowAt(nowMs, durationSeconds);
  const raw = await fetchBySlug(client, w.slug);
  if (!raw) return undefined;
  if (raw.state.closed === true || raw.state.acceptingOrders === false) return undefined;
  const identity = toIdentity(raw, durationSeconds);
  return identity ? { identity, raw } : undefined;
}
