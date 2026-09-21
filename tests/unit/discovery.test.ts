import { describe, expect, it } from "vitest";
import { listCandidates, mapOutcomes, selectCurrent, toIdentity, type GammaMarketLike } from "../../src/market/market-discovery.js";

const T0 = Date.parse("2026-09-21T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const market = (over: Partial<GammaMarketLike> = {}): GammaMarketLike => ({
  id: "1", conditionId: "0xc", slug: "btc-updown-5m-1200", question: "Bitcoin Up or Down?",
  outcomes: ["Up", "Down"], clobTokenIds: ["tok-up", "tok-down"],
  startDate: iso(T0), endDate: iso(T0 + 300_000), active: true, closed: false,
  orderPriceMinTickSize: 0.001, orderMinSize: "5", ...over,
});

describe("mapOutcomes", () => {
  it("maps Up/Down labels regardless of order and case", () => {
    expect(mapOutcomes(market({ outcomes: ["DOWN", "up"], clobTokenIds: ["d", "u"] })))
      .toEqual({ upAssetId: "u", downAssetId: "d" });
  });
  it("refuses labels it does not recognise instead of guessing", () => {
    expect(mapOutcomes(market({ outcomes: ["Bull", "Bear"] }))).toBeUndefined();
    expect(mapOutcomes(market({ outcomes: ["Up"], clobTokenIds: ["u"] }))).toBeUndefined();
  });
});

describe("toIdentity", () => {
  it("anchors the 5-minute window on endDate when startDate is the listing time", () => {
    const listedEarly = market({ startDate: iso(T0 - 86_400_000) });
    const idn = toIdentity(listedEarly, 300)!;
    expect(idn.closesAtMs).toBe(T0 + 300_000);
    expect(idn.openedAtMs).toBe(T0);
  });
  it("keeps a plausible startDate", () => {
    expect(toIdentity(market(), 300)!.openedAtMs).toBe(T0);
  });
  it("needs a condition id and an end date", () => {
    expect(toIdentity(market({ conditionId: null }), 300)).toBeUndefined();
    expect(toIdentity(market({ endDate: null }), 300)).toBeUndefined();
  });
});

describe("selectCurrent", () => {
  const prev = market({ id: "p", slug: "prev", startDate: iso(T0 - 300_000), endDate: iso(T0) });
  const live = market({ id: "l", slug: "live" });
  const next = market({ id: "n", slug: "next", startDate: iso(T0 + 300_000), endDate: iso(T0 + 600_000) });

  it("prefers the market whose window contains now", () => {
    expect(selectCurrent([next, live, prev], T0 + 60_000, 300)?.slug).toBe("live");
  });
  it("falls back to the soonest future market between windows", () => {
    expect(selectCurrent([next, prev], T0 + 60_000, 300)?.slug).toBe("next");
  });
  it("never returns a closed or expired market", () => {
    expect(selectCurrent([prev, market({ closed: true })], T0 + 60_000, 300)).toBeUndefined();
  });
});

describe("listCandidates", () => {
  it("flattens markets across events and forwards the query", async () => {
    let seen: unknown;
    const client = {
      listEvents: (req: unknown) => {
        seen = req;
        return { firstPage: async () => ({ items: [{ id: "e", markets: [market(), market({ id: "2" })] }, { id: "f", markets: null }] }) };
      },
    };
    const out = await listCandidates(client, { titleSearch: "Bitcoin Up or Down", durationSeconds: 300 });
    expect(out.map((m) => m.id)).toEqual(["1", "2"]);
    expect(seen).toMatchObject({ titleSearch: "Bitcoin Up or Down", closed: false });
  });
});
