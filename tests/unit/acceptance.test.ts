import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/persistence/database.js";
import { acceptanceReport } from "../../src/analytics/acceptance.js";

const H = 3_600_000;

describe("acceptanceReport", () => {
  it("is INSUFFICIENT on an empty database, never PASS", () => {
    const r = acceptanceReport(openDatabase(":memory:"), 0, 24);
    expect(r.overall).toBe("INSUFFICIENT");
    expect(r.criteria.find((c) => c.name === "no order submitted")!.status).toBe("PASS");
  });

  it("measures the longest continuous stretch, not the total span", () => {
    const db = openDatabase(":memory:");
    // 10 h of ticks, a 5 min outage, then 15 h: span 25 h but no 24 h stretch.
    let t = 0;
    const tick = (at: number) => db.run(`INSERT INTO ticks (market_id, source, ts_ms, received_at_ms, price) VALUES ('m','chainlink',?,?,1)`, [at, at]);
    for (; t < 10 * H; t += 30_000) tick(t);
    t += 5 * 60_000;
    for (const end = t + 15 * H; t < end; t += 30_000) tick(t);
    const r = acceptanceReport(db, t, 24);
    const c = r.criteria[0]!;
    expect(c.status).toBe("FAIL");
    expect(c.numbers["spanHours"]).toBeGreaterThan(24.9);
    expect(c.numbers["longestContinuousHours"]).toBeCloseTo(15, 1);
    expect(c.numbers["outages"]).toBe(1);
    expect(acceptanceReport(db, t, 12).criteria[0]!.status).toBe("PASS");
  });

  it("fails stale-state protection if a stale decision was ever approved, and decision storage if rows do not line up", () => {
    const db = openDatabase(":memory:");
    db.run(`INSERT INTO jev_requests (decision_id, market_id, state_version, input_hash, timestamp_ms, state_json, model, input_tokens, output_tokens, jev_latency_ms) VALUES ('d1','m','1','h',0,'{}','j',1,1,100)`);
    db.run(`INSERT INTO jev_answers (decision_id, answers_json, requested_action, risk_result, risk_reason) VALUES ('d1','{}','BUY_UP','APPROVED','STALE_DECISION')`);
    const r = acceptanceReport(db, 0, 24);
    expect(r.criteria.find((c) => c.name === "stale-state protection")!.status).toBe("FAIL");
    expect(r.criteria.find((c) => c.name === "every Jev decision stored")!.status).toBe("FAIL"); // no latency row
    expect(r.overall).toBe("FAIL");
  });
});
