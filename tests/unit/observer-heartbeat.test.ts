import { describe, expect, it } from "vitest";
import { MarketObserver } from "../../src/app/observer.js";
import { loadConfig } from "../../src/app/config.js";
import { createLogger } from "../../src/observability/logger.js";
import { createClock } from "../../src/feeds/clock.js";
import { openDatabase } from "../../src/persistence/database.js";
import { DecisionRepository } from "../../src/persistence/repositories/decisions.js";

/** A stream that delivers nothing and ends when closed. */
const silent = async () => {
  let end!: () => void; const closed = new Promise<void>((r) => (end = r));
  return { close: async () => end(), async *[Symbol.asyncIterator]() { await closed; } };
};

describe("observer housekeeping without feed events", () => {
  it("writes a heartbeat on the run loop even when no feed delivers anything", async () => {
    const db = openDatabase(":memory:");
    const repo = new DecisionRepository(db);
    const now = Date.now();
    const obs = new MarketObserver(
      {
        cfg: loadConfig({}, []), log: createLogger({ level: "error", write: () => {} }), clock: createClock(), repo,
        marketSubscribe: silent as never, chainlinkSubscribe: silent as never,
        jevCall: async () => { throw new Error("not called"); },
      },
      { marketId: "m", conditionId: "c", slug: "btc-updown-5m-1", question: "q", upAssetId: "UP", downAssetId: "DOWN", openedAtMs: now - 1000, closesAtMs: now + 700, tickSize: 0.001, minOrderSize: 5 },
    );
    await obs.run(0);
    const hb = repo.getControl("heartbeat:observer");
    expect(hb).toBeDefined();
    expect(JSON.parse(hb!.value)).toMatchObject({ phase: "observing", market: "btc-updown-5m-1" });
  }, 10_000);
});
