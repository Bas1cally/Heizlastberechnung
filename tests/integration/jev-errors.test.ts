import { describe, expect, it } from "vitest";
import { APITimeoutError, APIConnectionError } from "@typesafe-ai/sdk";
import { MarketObserver } from "../../src/app/observer.js";
import { createClock } from "../../src/feeds/clock.js";
import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";
import { DEFAULT_KILL_THRESHOLDS } from "../../src/risk/kill-switch.js";
import type { JevCall } from "../../src/jev/decision-engine.js";
import { answersFor, bookStream, identityFor, priceStream, quietLog, scriptedJev, testConfig } from "./helpers.js";

/** Jev timeouts and API errors (brief §41): counted, recorded, and after enough of them the kill switch blocks buys. */
describe("Jev failures", () => {
  const runWith = async (failing: (n: number) => Error | undefined, closesInMs = 4_000) => {
    const cfg = testConfig();
    const db = openDatabase(":memory:");
    const repo = new DecisionRepository(db);
    const clock = createClock();
    const market = identityFor(clock.wall(), closesInMs);
    repo.upsertMarket(market, clock.wall());
    let n = 0;
    const inner = scriptedJev(() => answersFor("BUY_UP", "IMMEDIATE"));
    const call: JevCall = async (state) => { const err = failing(n++); if (err) throw err; return inner.call(state); };
    const kills: string[][] = [];
    const observer = new MarketObserver({
      cfg, log: quietLog(), clock, repo, jevCall: call,
      marketSubscribe: bookStream({ everyMs: 50 }), chainlinkSubscribe: priceStream((t) => 85_000 + t / 10), chainlinkTwapSubscribe: priceStream((t) => 85_000 + t / 20),
      executionMode: "simulated", onKill: (s) => { kills.push([...s.reasons]); },
    }, market);
    await observer.run(0);
    return { db, repo, observer, kills, calls: n };
  };

  it("a timeout streak trips JEV_TIMEOUT; every failure is in the error log; buys are refused, holds are not", async () => {
    const limit = DEFAULT_KILL_THRESHOLDS.maxJevFailures;
    const { db, repo, kills, calls } = await runWith((n) => (n < limit ? new APITimeoutError(5_000) : undefined));
    expect(calls).toBeGreaterThan(limit);
    expect(kills[0]).toEqual(["JEV_TIMEOUT"]);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM errors WHERE component = 'jev'`)!.n).toBe(limit);
    expect(JSON.parse(repo.getControl("kill")!.value)).toMatchObject({ tripped: true, reasons: ["JEV_TIMEOUT"], hard: false });
    // Jev answered again afterwards; those decisions are stored, and the gate refused the buys while the switch is tripped.
    const verdicts = db.all<{ risk_result: string; risk_reason: string | null }>(`SELECT risk_result, risk_reason FROM jev_answers`);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((v) => v.risk_result === "REJECTED" && v.risk_reason === "KILL_SWITCH")).toBe(true);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM orders`)!.n).toBe(0);
  }, 15_000);

  it("a connection error is JEV_UNAVAILABLE, anything else JEV_INVALID; isolated failures do not trip anything", async () => {
    const a = await runWith((n) => (n === 0 ? new APIConnectionError("ECONNRESET") : n === 2 ? new Error("malformed answer") : undefined), 2_500);
    expect(a.kills).toEqual([]);
    expect(a.db.all<{ message: string }>(`SELECT message FROM errors WHERE component = 'jev' ORDER BY ts_ms`).map((e) => e.message)).toEqual(["ECONNRESET", "malformed answer"]);
    expect(a.repo.getControl("kill")).toBeUndefined();
    expect(a.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jev_answers WHERE risk_result = 'APPROVED'`)!.n).toBeGreaterThan(0);

    const b = await runWith((n) => (n < DEFAULT_KILL_THRESHOLDS.maxJevFailures ? new APIConnectionError("down") : undefined), 2_500);
    expect(b.kills[0]).toEqual(["JEV_UNAVAILABLE"]);
    const c = await runWith((n) => (n < DEFAULT_KILL_THRESHOLDS.maxJevFailures ? new Error("bad json") : undefined), 2_500);
    expect(c.kills[0]).toEqual(["JEV_INVALID"]);
  }, 20_000);
});
