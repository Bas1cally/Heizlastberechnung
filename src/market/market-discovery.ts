import type { MarketIdentity } from "./market-state.js";

/**
 * Finds the BTC 5-minute market that is live right now (or the next one).
 *
 * The Gamma client is injected as the narrow interface below, built from the
 * verified `listEvents`/`listMarkets` signatures. What is NOT verified here is
 * how these markets are titled, slugged and grouped, and what their outcome
 * labels are - `pnpm discover` prints candidates so that can be confirmed and
 * pinned via MARKET_* env vars.
 */
export interface GammaMarketLike {
  readonly id: string;
  readonly conditionId: string | null;
  readonly slug?: string | null;
  readonly question?: string | null;
  readonly outcomes: readonly string[];
  readonly clobTokenIds: readonly string[];
  readonly startDate?: string | null;
  readonly endDate?: string | null;
  readonly active?: boolean | null;
  readonly closed?: boolean | null;
  readonly orderPriceMinTickSize?: number | null;
  readonly orderMinSize?: string | null;
  readonly description?: string | null;
}

export interface GammaEventLike {
  readonly id: string;
  readonly slug?: string | null;
  readonly title?: string | null;
  readonly markets?: readonly GammaMarketLike[] | null;
}

export interface DiscoveryClient {
  listEvents(request: {
    titleSearch?: string;
    tagSlug?: string;
    slug?: string;
    closed?: boolean;
    pageSize?: number;
    order?: string;
    ascending?: boolean;
  }): { firstPage(): Promise<{ items: readonly GammaEventLike[] }> };
}

export interface DiscoveryQuery {
  readonly titleSearch: string;
  readonly tagSlug?: string | undefined;
  readonly durationSeconds: number;
}

const UP_LABELS = new Set(["up", "yes", "higher", "above"]);
const DOWN_LABELS = new Set(["down", "no", "lower", "below"]);

/** Map outcome labels to (up, down) token ids. Explicit, so a surprise label fails loudly. */
export function mapOutcomes(m: GammaMarketLike): { upAssetId: string; downAssetId: string } | undefined {
  if (m.outcomes.length !== 2 || m.clobTokenIds.length !== 2) return undefined;
  let up: string | undefined;
  let down: string | undefined;
  m.outcomes.forEach((label, i) => {
    const key = label.trim().toLowerCase();
    if (UP_LABELS.has(key)) up = m.clobTokenIds[i];
    else if (DOWN_LABELS.has(key)) down = m.clobTokenIds[i];
  });
  return up && down ? { upAssetId: up, downAssetId: down } : undefined;
}

export function toIdentity(m: GammaMarketLike, durationSeconds: number): MarketIdentity | undefined {
  const ids = mapOutcomes(m);
  if (!ids || !m.conditionId) return undefined;
  const closesAtMs = m.endDate ? Date.parse(m.endDate) : Number.NaN;
  if (!Number.isFinite(closesAtMs)) return undefined;
  const parsedStart = m.startDate ? Date.parse(m.startDate) : Number.NaN;
  // Gamma's startDate is when the market was listed, which for a 5-minute
  // market can be well before it opens. The window is anchored on endDate.
  const openedAtMs = Number.isFinite(parsedStart) && closesAtMs - parsedStart <= durationSeconds * 1000 * 1.5
    ? parsedStart
    : closesAtMs - durationSeconds * 1000;
  return {
    marketId: m.id,
    conditionId: m.conditionId,
    slug: m.slug ?? "",
    question: m.question ?? "",
    ...ids,
    openedAtMs,
    closesAtMs,
    tickSize: m.orderPriceMinTickSize ?? undefined,
    minOrderSize: m.orderMinSize ? Number(m.orderMinSize) : undefined,
  };
}

/** Candidate markets from a query, unfiltered - what `pnpm discover` prints. */
export async function listCandidates(client: DiscoveryClient, q: DiscoveryQuery): Promise<GammaMarketLike[]> {
  const page = await client
    .listEvents({
      titleSearch: q.titleSearch,
      ...(q.tagSlug ? { tagSlug: q.tagSlug } : {}),
      closed: false,
      pageSize: 50,
    })
    .firstPage();
  const out: GammaMarketLike[] = [];
  for (const ev of page.items) for (const m of ev.markets ?? []) out.push(m);
  return out;
}

/**
 * Pick the market whose window contains `nowMs`; if none, the soonest future
 * one. Returns undefined when nothing usable was found.
 */
export function selectCurrent(
  candidates: readonly GammaMarketLike[],
  nowMs: number,
  durationSeconds: number,
): MarketIdentity | undefined {
  const ids = candidates
    .filter((m) => !m.closed)
    .map((m) => toIdentity(m, durationSeconds))
    .filter((x): x is MarketIdentity => x !== undefined)
    .filter((x) => x.closesAtMs > nowMs)
    .sort((a, b) => a.closesAtMs - b.closesAtMs);
  return ids.find((x) => x.openedAtMs <= nowMs) ?? ids[0];
}

export async function findCurrentMarket(
  client: DiscoveryClient,
  q: DiscoveryQuery,
  nowMs: number,
): Promise<MarketIdentity | undefined> {
  return selectCurrent(await listCandidates(client, q), nowMs, q.durationSeconds);
}
