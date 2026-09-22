import { describe, expect, it } from "vitest";
import { candidatePairs, checkPrices, RELATION_QUESTION, renderReport, tokens, type ScanMarket } from "../../src/analytics/consistency.js";

const mk = (o: Partial<ScanMarket> & { id: string; question: string }): ScanMarket => ({
  slug: o.id, description: "", eventSlug: null, eventTitle: null, endDate: "2026-12-31T00:00:00Z", negRisk: false, yesTokenId: null, noTokenId: null,
  yesPrice: 0.5, bestBid: 0.49, bestAsk: 0.51, liquidity: 1000, volume24h: 100, feesEnabled: false, ...o,
});

describe("consistency: candidates", () => {
  it("pairs markets of one event, and cross-event markets sharing rare tokens; skips negRisk events", () => {
    const ms = [
      mk({ id: "1", question: "Will Bitcoin be above $100,000 on December 31?", eventSlug: "btc-dec" }),
      mk({ id: "2", question: "Will Bitcoin be above $90,000 on December 31?", eventSlug: "btc-dec" }),
      mk({ id: "3", question: "Will Bitcoin be above $100,000 on October 31?", eventSlug: "btc-oct" }),
      mk({ id: "4", question: "Will the Fed cut rates in November?", eventSlug: "fed" }),
      mk({ id: "5", question: "Will Alice win the mayoral race?", eventSlug: "mayor", negRisk: true }),
      mk({ id: "6", question: "Will Bob win the mayoral race?", eventSlug: "mayor", negRisk: true }),
      mk({ id: "7", question: "Will the Fed cut rates in December?", eventSlug: "fed2" }),
    ];
    const c = candidatePairs(ms, { rareDf: 3 });
    const keys = c.map((p) => [p.a.id, p.b.id].sort().join("-"));
    expect(keys).toContain("1-2"); // same event
    expect(keys).toContain("1-3"); // shares bitcoin, 100, 000, 31
    expect(keys).toContain("4-7"); // shares fed, cut, rates
    expect(keys).not.toContain("5-6"); // negRisk: the exchange's own constraint
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("tokenises numbers and words, drops stop words", () => {
    expect(tokens("Will BTC be above $100k on Dec 31?")).toEqual(["btc", "100k", "dec", "31"]);
  });
});

describe("consistency: prices", () => {
  const a = mk({ id: "a", question: "A", yesPrice: 0.60, bestBid: 0.59, bestAsk: 0.61 });
  const b = mk({ id: "b", question: "B", yesPrice: 0.50, bestBid: 0.49, bestAsk: 0.51 });

  it("A implies B demands P(A) <= P(B); the executable edge is bid(A) - ask(B)", () => {
    const v = checkPrices("A_IMPLIES_B", a, b)!;
    expect(v.midGap).toBeCloseTo(0.10, 9);
    expect(v.executable).toBeCloseTo(0.59 - 0.51, 9);
    expect(v.trade).toContain("buy B YES at 0.51");
    expect(checkPrices("B_IMPLIES_A", a, b)!.midGap).toBe(0);
    expect(checkPrices("B_IMPLIES_A", a, b)!.executable).toBeCloseTo(0.49 - 0.61, 9);
  });

  it("exclusive demands P(A) + P(B) <= 1; buying NO on both pays at least 1", () => {
    const c = mk({ id: "c", question: "C", yesPrice: 0.55, bestBid: 0.54, bestAsk: 0.56 });
    const v = checkPrices("EXCLUSIVE", a, c)!;
    expect(v.midGap).toBeCloseTo(0.15, 9);
    expect(v.executable).toBeCloseTo(0.59 + 0.54 - 1, 9);
  });

  it("equivalent takes the better of the two directions; unrelated and unsure give nothing", () => {
    expect(checkPrices("EQUIVALENT", a, b)!.executable).toBeCloseTo(0.08, 9);
    expect(checkPrices("UNRELATED", a, b)).toBeUndefined();
    expect(checkPrices("UNSURE", a, b)).toBeUndefined();
  });

  it("falls back to the market's own YES price without a book", () => {
    const x = mk({ id: "x", question: "X", yesPrice: 0.7, bestBid: null, bestAsk: null });
    const y = mk({ id: "y", question: "Y", yesPrice: 0.6, bestBid: null, bestAsk: null });
    expect(checkPrices("A_IMPLIES_B", x, y)!.midGap).toBeCloseTo(0.1, 9);
  });
});

describe("consistency: report", () => {
  it("counts relations and lists executable and broken pairs", () => {
    const a = mk({ id: "a", question: "A", yesPrice: 0.60, bestBid: 0.59, bestAsk: 0.61 });
    const b = mk({ id: "b", question: "B", yesPrice: 0.50, bestBid: 0.49, bestAsk: 0.51 });
    const txt = renderReport([
      { a, b, why: "same event", relation: "A_IMPLIES_B", confidence: 0.9, violation: checkPrices("A_IMPLIES_B", a, b) },
      { a, b, why: "same event", relation: "UNRELATED", confidence: 0.8 },
    ], { markets: 2, candidates: 2, judged: 2, generatedAt: "now", feeNotes: ["fees: none"] });
    expect(txt).toContain("A_IMPLIES_B 1");
    expect(txt).toContain("executable after spreads (> 0.5 cent) 1");
    expect(txt).toContain("+0.080 exec");
    expect(txt).toContain("fees: none");
    expect(Object.keys(RELATION_QUESTION.criteria)).toHaveLength(6);
  });
});
