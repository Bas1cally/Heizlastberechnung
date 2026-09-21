import { describe, expect, it, vi } from "vitest";
import { MarketObserver } from "../../src/app/observer.js";
import { createClock } from "../../src/feeds/clock.js";
import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";
import { findCurrentMarket, type DiscoveryClient } from "../../src/market/market-discovery.js";
import { answersFor, bookStream, identityFor, priceStream, quietLog, scriptedJev, stream, testConfig } from "./helpers.js";
import type { MarketWsEvent } from "../../src/feeds/polymarket-ws.js";

/** Polymarket API failures (brief §41): the process records them and keeps going; it never invents data. */
describe("Polymarket API errors", () => {
  it("discovery propagates a transport error instead of returning a fake market", async () => {
    const client = { listMarkets: vi.fn(() => ({ firstPage: async () => { throw new Error("TransportError: fetch failed"); } })) } as unknown as DiscoveryClient;
    await expect(findCurrentMarket(client, Date.now(), 300)).rejects.toThrow(/TransportError/);
  });

  it("a subscribe failure and a dropped stream are recorded as errors; the observer reconnects and keeps deciding", async () => {
    const cfg = testConfig();
    const db = openDatabase(":memory:");
    const repo = new DecisionRepository(db);
    const clock = createClock();
    const market = identityFor(clock.wall(), 3_500);
    repo.upsertMarket(market, clock.wall());
    const jev = scriptedJev(() => answersFor("HOLD", "NORMAL"));

    // First subscribe rejects (API outage), the second stream dies after two books, the third is healthy.
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error("TransportError: 503 from ws-subscriptions");
      if (calls === 2) return stream<MarketWsEvent>(async (_e, n) => { if (n >= 2) throw new Error("socket closed"); return n === 0 ? { type: "book", payload: { assetId: "UP", bids: [{ price: "0.44", size: "100" }], asks: [{ price: "0.45", size: "100" }] } } : { type: "book", payload: { assetId: "DOWN", bids: [{ price: "0.55", size: "100" }], asks: [{ price: "0.56", size: "100" }] } }; });
      return bookStream({ everyMs: 50 })();
    };
    const observer = new MarketObserver({
      cfg, log: quietLog(), clock, repo, jevCall: jev.call,
      marketSubscribe: flaky, chainlinkSubscribe: priceStream((t) => 85_000 + t / 10), chainlinkTwapSubscribe: priceStream((t) => 85_000 + t / 20),
    }, market);
    await observer.run(0);

    const errors = db.all<{ component: string; message: string }>(`SELECT component, message FROM errors ORDER BY ts_ms`);
    expect(errors.filter((e) => e.component === "market-ws").map((e) => e.message)).toEqual(expect.arrayContaining([expect.stringMatching(/503/), expect.stringMatching(/socket closed/)]));
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(observer.decisionCount()).toBeGreaterThan(0);
    // Nothing was fabricated: every recorded book came from a stream event.
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM orderbook_snapshots`)!.n).toBeGreaterThan(0);
  }, 15_000);

  it("a silent market feed trips the kill switch on book staleness and blocks buys, while HOLDs still pass", async () => {
    const cfg = testConfig();
    const db = openDatabase(":memory:");
    const repo = new DecisionRepository(db);
    const clock = createClock();
    const market = identityFor(clock.wall(), 4_000);
    repo.upsertMarket(market, clock.wall());
    const jev = scriptedJev((s, n) => (n % 2 === 0 ? answersFor("BUY_UP", "IMMEDIATE") : answersFor("HOLD", "NORMAL")));
    // Two books, then the socket goes quiet but stays open: the classic stale-feed failure.
    const quiet = async () => stream<MarketWsEvent>(async (_e, n) => {
      if (n === 0) return { type: "book", payload: { assetId: "UP", bids: [{ price: "0.44", size: "100" }], asks: [{ price: "0.45", size: "100" }] } };
      if (n === 1) return { type: "book", payload: { assetId: "DOWN", bids: [{ price: "0.55", size: "100" }], asks: [{ price: "0.56", size: "100" }] } };
      await new Promise((r) => setTimeout(r, 60_000).unref()); return undefined;
    });
    const approvedBuyAt: number[] = [];
    const startedAt = clock.wall();
    const observer = new MarketObserver({
      cfg, log: quietLog(), clock, repo, jevCall: jev.call,
      marketSubscribe: quiet, chainlinkSubscribe: priceStream((t) => 85_000 + t / 10), chainlinkTwapSubscribe: priceStream((t) => 85_000 + t / 20),
      executionMode: "simulated", onApproved: (d) => { if (d.requestedAction === "BUY_UP") approvedBuyAt.push(d.timestampMs - startedAt); },
    }, market);
    await observer.run(0);
    const verdicts = db.all<{ requested_action: string; risk_result: string; risk_reason: string | null }>(`SELECT requested_action, risk_result, risk_reason FROM jev_answers`);
    const buys = verdicts.filter((v) => v.requested_action === "BUY_UP");
    // Whatever slipped through in the first second, once the book was older than the limit every buy was refused.
    expect(buys.length).toBeGreaterThan(0);
    expect(buys.some((v) => v.risk_result === "REJECTED" && (v.risk_reason === "STALE_ORDERBOOK" || v.risk_reason === "KILL_SWITCH"))).toBe(true);
    expect(verdicts.filter((v) => v.requested_action === "HOLD").every((v) => v.risk_result === "APPROVED")).toBe(true);
    // Buys approved while the book was fresh are fine; none after it went stale (limit 1 s, plus scheduling slack).
    expect(approvedBuyAt.every((t) => t < cfg.limits.maxOrderbookAgeMs + 500)).toBe(true);
    expect(buys.filter((v) => v.risk_result === "APPROVED").length).toBe(approvedBuyAt.length);
  }, 15_000);
});
