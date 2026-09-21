import { describe, expect, it } from "vitest";
import { fetchBySlug, findCurrentMarket, mapOutcomes, toIdentity, type GammaMarketLike } from "../../src/market/market-discovery.js";

// Shape as returned live by client.listMarkets (transformed Gamma Market).
const market = (over: Partial<GammaMarketLike> = {}): GammaMarketLike => ({
  id: "1", slug: "btc-updown-5m-1766162100", conditionId: "0xc", question: "Bitcoin Up or Down - December 19, 11:35AM-11:40AM ET",
  description: 'This market will resolve to "Up" if the Bitcoin price at the end ... greater than or equal to ...',
  state: { active: true, closed: false, acceptingOrders: true, negRisk: false },
  outcomes: { yes: { label: "Up", tokenId: "tok-up", price: "0.99" }, no: { label: "Down", tokenId: "tok-down", price: "0.01" } },
  trading: { minimumOrderSize: "5", minimumTickSize: 0.001 },
  resolution: { source: "Chainlink" },
  ...over,
});

describe("mapOutcomes (object form)", () => {
  it("maps yes/no entries by their labels, not by their keys", () => {
    expect(mapOutcomes(market())).toEqual({ upAssetId: "tok-up", downAssetId: "tok-down" });
    const swapped = market({ outcomes: { yes: { label: "Down", tokenId: "d" }, no: { label: "Up", tokenId: "u" } } });
    expect(mapOutcomes(swapped)).toEqual({ upAssetId: "u", downAssetId: "d" });
  });
  it("refuses unknown labels or missing token ids", () => {
    expect(mapOutcomes(market({ outcomes: { yes: { label: "Bull", tokenId: "a" }, no: { label: "Bear", tokenId: "b" } } }))).toBeUndefined();
    expect(mapOutcomes(market({ outcomes: { yes: { label: "Up", tokenId: null }, no: { label: "Down", tokenId: "b" } } }))).toBeUndefined();
  });
});

describe("toIdentity", () => {
  it("takes timing from the slug, which Gamma does not reliably provide", () => {
    const idn = toIdentity(market(), 300)!;
    expect(idn.openedAtMs).toBe(1766162100_000);
    expect(idn.closesAtMs).toBe(1766162400_000);
    expect(idn.tickSize).toBe(0.001);
    expect(idn.minOrderSize).toBe(5);
    expect(idn.conditionId).toBe("0xc");
  });
  it("falls back to state.endDate for a non-standard slug", () => {
    const idn = toIdentity(market({ slug: "custom", state: { endDate: "2026-01-01T00:05:00Z" } }), 300)!;
    expect(idn.closesAtMs).toBe(Date.parse("2026-01-01T00:05:00Z"));
    expect(idn.openedAtMs).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });
  it("needs a condition id", () => {
    expect(toIdentity(market({ conditionId: null }), 300)).toBeUndefined();
  });
});

const clientWith = (items: GammaMarketLike[], seen: unknown[] = []) => ({
  listMarkets: (req: unknown) => { seen.push(req); return { firstPage: async () => ({ items }) }; },
});

describe("findCurrentMarket", () => {
  const now = 1766162100_000 + 42_000;

  it("computes the slug from the clock and fetches exactly that market", async () => {
    const seen: unknown[] = [];
    const found = await findCurrentMarket(clientWith([market()], seen), now);
    expect(seen[0]).toMatchObject({ slug: ["btc-updown-5m-1766162100"] });
    expect(found?.identity.slug).toBe("btc-updown-5m-1766162100");
  });

  it("returns nothing when Gamma has not listed the window yet", async () => {
    expect(await findCurrentMarket(clientWith([]), now)).toBeUndefined();
  });

  it("refuses a closed market or one not accepting orders", async () => {
    expect(await findCurrentMarket(clientWith([market({ state: { closed: true } })]), now)).toBeUndefined();
    expect(await findCurrentMarket(clientWith([market({ state: { acceptingOrders: false } })]), now)).toBeUndefined();
  });

  it("prefers the exact slug when the page contains more than one market", async () => {
    const other = market({ id: "9", slug: "btc-updown-5m-1766162400" });
    const found = await fetchBySlug(clientWith([other, market()]), "btc-updown-5m-1766162100");
    expect(found?.id).toBe("1");
  });
});
