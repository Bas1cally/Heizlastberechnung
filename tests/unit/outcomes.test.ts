import { describe, expect, it } from "vitest";
import { deriveOutcome, outcomeFromLabel } from "../../src/analytics/outcomes.js";

describe("deriveOutcome", () => {
  const ticks = [
    { tsMs: 999_000, price: 85_000 },   // before open: ignored
    { tsMs: 1_000_000, price: 85_010 }, // open
    { tsMs: 1_150_000, price: 84_900 },
    { tsMs: 1_299_000, price: 85_010 }, // last before close: tie
    { tsMs: 1_300_000, price: 80_000 }, // at close: belongs to the next window
  ];

  it("uses the first tick at or after open and the last before close; a tie is UP", () => {
    const o = deriveOutcome(ticks, 1_000_000, 1_300_000)!;
    expect(o.startPrice).toBe(85_010);
    expect(o.endPrice).toBe(85_010);
    expect(o.outcome).toBe("UP");
  });

  it("resolves DOWN when the end is strictly lower", () => {
    const o = deriveOutcome(ticks.filter((t) => t.tsMs !== 1_299_000), 1_000_000, 1_300_000)!;
    expect(o.endPrice).toBe(84_900);
    expect(o.outcome).toBe("DOWN");
  });

  it("is undefined without ticks inside the window", () => {
    expect(deriveOutcome(ticks, 2_000_000, 2_300_000)).toBeUndefined();
  });
});

describe("outcomeFromLabel", () => {
  it("maps the feed's labels", () => {
    expect(outcomeFromLabel("Up")).toBe("UP");
    expect(outcomeFromLabel("down")).toBe("DOWN");
    expect(outcomeFromLabel(null)).toBeUndefined();
    expect(outcomeFromLabel("Over")).toBeUndefined();
  });
});

import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";
import { marketConsistency } from "../../src/analytics/observations.js";

describe("marketConsistency", () => {
  it("flags a market whose derived outcome contradicts the market's own final price and Jev's last read", () => {
    const db = openDatabase(":memory:");
    const repo = new DecisionRepository(db);
    repo.upsertMarket({ marketId: "m", conditionId: "c", slug: "btc-updown-5m-1000", question: "q", upAssetId: "U", downAssetId: "D", openedAtMs: 1_000_000, closesAtMs: 1_300_000, tickSize: 0.01, minOrderSize: 5 }, 0);
    // TWAP rises 100 -> 101: derived UP.
    repo.saveTick("m", "chainlink-twap60", 1_010_000, 1_010_000, 100);
    repo.saveTick("m", "chainlink-twap60", 1_290_000, 1_290_000, 101);
    // But the market priced UP at 0.05 just before the close, and Jev's last state says DOWN with a different start price.
    repo.saveBook("m", "U", 1_299_000, [{ price: 0.04, size: 10 }], [{ price: 0.06, size: 10 }]);
    db.run(`INSERT INTO jev_requests (decision_id, market_id, state_version, input_hash, timestamp_ms, state_json, model, input_tokens, output_tokens, jev_latency_ms) VALUES ('d','m','1','h',1_299_500,?, 'j',1,1,1)`,
      [JSON.stringify({ market: { settlementStartPrice: 102, settlementCurrentPrice: 101, distanceBps: -98, secondsRemaining: 0.5 } })]);
    db.run(`INSERT INTO jev_answers (decision_id, answers_json, requested_action, risk_result) VALUES ('d', ?, 'HOLD', 'APPROVED')`,
      [JSON.stringify({ settlement_direction: { type: "choice", choice: "DOWN", confidence: 0.99, probabilities: { UP: 0.01, DOWN: 0.98, UNRESOLVED: 0.01 } } })]);
    const [row] = marketConsistency(db, 2_000_000);
    expect(row!.twap?.outcome).toBe("UP");
    expect(row!.marketImplied).toBe("DOWN");
    expect(row!.jevFinal?.side).toBe("DOWN");
    expect(row!.agree).toBe(false);
    expect(row!.notes.join(" | ")).toMatch(/vs market DOWN/);
    expect(row!.notes.join(" | ")).toMatch(/vs Jev DOWN/);
    expect(row!.notes.join(" | ")).toMatch(/start price: derived 100 vs Jev's state 102/);
    expect(row!.twapFirstAfterOpenS).toBe(10);
    expect(row!.twapLastBeforeCloseS).toBe(10);
  });
});
