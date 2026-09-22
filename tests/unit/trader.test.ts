import { describe, expect, it } from "vitest";
import { analyzeTrader, type ActivityRow } from "../../src/analytics/trader.js";
import { parseSlug } from "../../src/market/window.js";

const open = 1_790_000_000; // seconds
const slug = `btc-updown-5m-${open}`;
const at = (secBeforeClose: number) => (open + 300 - secBeforeClose) * 1000;
const row = (o: Partial<ActivityRow>): ActivityRow => ({ type: "TRADE", conditionId: "c", slug, outcome: "Up", side: "BUY", price: 0.98, shares: 100, amount: 98, tsMs: at(60), txHash: "0x1", ...o });

describe("analyzeTrader", () => {
  it("reconstructs the Animal00 pattern from activity rows: winner at .98, tail at .01, merge, redeem", () => {
    const rows: ActivityRow[] = [
      row({ price: 0.98, shares: 100, amount: 98, tsMs: at(70), txHash: "0xa" }),                       // winner
      row({ outcome: "Down", price: 0.01, shares: 60, amount: 0.6, tsMs: at(40), txHash: "0xb" }),     // tail
      { type: "MERGE", conditionId: "c", slug, outcome: null, side: null, price: null, shares: null, amount: 60, tsMs: at(20), txHash: "0xc" },
      { type: "REDEEM", conditionId: "c", slug, outcome: null, side: null, price: null, shares: null, amount: 40, tsMs: at(-600), txHash: "0xd" },
      { type: "TRADE", conditionId: "z", slug: "some-other-market", outcome: "Yes", side: "BUY", price: 0.5, shares: 10, amount: 5, tsMs: at(0), txHash: "0xe" },
    ];
    const r = analyzeTrader(rows, (s) => { const p = parseSlug(s); return p ? { openedAtMs: p.openedAtMs, closesAtMs: p.closesAtMs } : undefined; }, () => "Up");
    expect(r.btcMarkets).toBe(1);
    expect(r.otherMarkets).toBe(1);
    expect(r.buys).toBe(2); expect(r.merges).toBe(1); expect(r.redeems).toBe(1);
    expect(r.marketsBothSides).toBe(1); expect(r.marketsWithMerge).toBe(1);
    const m = r.perMarket[0]!;
    expect(m.netUsd).toBeCloseTo(40 + 60 - 98.6, 9);           // paid 98.60, got 60 back from the merge and 40 from the winner
    expect(m.buys.map((b) => b.secondsBeforeClose)).toEqual([70, 40]);
    expect(m.buys.map((b) => b.won)).toEqual([true, false]);
    expect(r.buyPriceBuckets.find((b) => b.bucket === "0.98-0.99")!.trades).toBe(1);
    expect(r.buyPriceBuckets.find((b) => b.bucket === "0.00-0.02")!.wonRate).toBe(0);
    expect(r.buyTimeBuckets.find((b) => b.bucket === "120-60s")!.trades).toBe(1);
    expect(r.buyTimeBuckets.find((b) => b.bucket === "60-30s")!.trades).toBe(1);
    expect(r.settledMarkets).toBe(1);
    expect(r.wins).toBe(1);
  });

  it("infers the winner from a redemption when only one side was bought and no resolution is recorded", () => {
    const r = analyzeTrader([row({}), { type: "REDEEM", conditionId: "c", slug, outcome: null, side: null, price: null, shares: null, amount: 100, tsMs: at(-900), txHash: "0xr" }],
      (s) => { const p = parseSlug(s); return p ? { openedAtMs: p.openedAtMs, closesAtMs: p.closesAtMs } : undefined; }, () => undefined);
    expect(r.perMarket[0]!.outcome).toBe("UP");
    expect(r.perMarket[0]!.buys[0]!.won).toBe(true);
    expect(r.netCashUsd).toBeCloseTo(2, 9);
  });

  it("counts a tail that never came back as lost once the market has been closed for two hours, never before", () => {
    const tail = row({ price: 0.01, shares: 1000, amount: 10, outcome: "Up" });
    const closesAt = parseSlug(slug)!.closesAtMs;
    const early = analyzeTrader([tail], (s) => { const p = parseSlug(s); return p ? { openedAtMs: p.openedAtMs, closesAtMs: p.closesAtMs } : undefined; }, () => undefined, closesAt + 10 * 60_000);
    expect(early.settledMarkets).toBe(0);
    const late = analyzeTrader([tail], (s) => { const p = parseSlug(s); return p ? { openedAtMs: p.openedAtMs, closesAtMs: p.closesAtMs } : undefined; }, () => undefined, closesAt + 3 * 3_600_000);
    expect(late.settledMarkets).toBe(1);
    expect(late.netCashUsd).toBeCloseTo(-10, 9);
    expect(late.losses).toBe(1);
  });
});
