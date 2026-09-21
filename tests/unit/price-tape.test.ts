import { describe, expect, it } from "vitest";
import { PriceTape } from "../../src/feeds/price-tape.js";
import { createLogger } from "../../src/observability/logger.js";

const silent = async () => ({ close: async () => {}, async *[Symbol.asyncIterator]() { await new Promise(() => {}); } });
const log = createLogger({ level: "error", write: () => {} });

describe("PriceTape", () => {
  it("hands out the first tick at or after the open, per stream", () => {
    let now = 0;
    const tape = new PriceTape({ symbol: "btc/usd", spotSubscribe: silent as never, twapSubscribe: silent as never, mono: () => now, wall: () => now, log });
    tape.push("twap", { ts: 999_000, price: 100, receivedAtMs: 999_000 });
    tape.push("twap", { ts: 1_000_000, price: 101, receivedAtMs: 1_000_050 });
    tape.push("twap", { ts: 1_001_000, price: 102, receivedAtMs: 1_001_050 });
    tape.push("spot", { ts: 1_000_400, price: 101.5, receivedAtMs: 1_000_400 });
    const s = tape.startAt(1_000_000);
    expect(s.twap).toMatchObject({ ts: 1_000_000, price: 101 });
    expect(s.spot).toMatchObject({ ts: 1_000_400, price: 101.5 });
    expect(tape.startAt(2_000_000)).toEqual({ twap: undefined, spot: undefined });
  });

  it("waits briefly for the open-second tick and gives up after the deadline", async () => {
    let now = 0;
    const tape = new PriceTape({ symbol: "btc/usd", spotSubscribe: silent as never, twapSubscribe: silent as never, mono: () => now, wall: () => now, log });
    setTimeout(() => { now = 200; tape.push("twap", { ts: 5_000, price: 7, receivedAtMs: 5_000 }); }, 150);
    const s = await tape.waitForStart(5_000, 1_000);
    expect(s.twap?.price).toBe(7);
    now = 0;
    const t2 = new PriceTape({ symbol: "btc/usd", spotSubscribe: silent as never, twapSubscribe: silent as never, mono: () => { now += 300; return now; }, wall: () => now, log });
    expect((await t2.waitForStart(5_000, 500)).twap).toBeUndefined();
  });
});
