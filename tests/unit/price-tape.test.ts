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

describe("PriceTape as a subscription source", () => {
  it("fans the tape's ticks out to a subscriber as Chainlink events and ends the stream on close", async () => {
    const tape = new PriceTape({ symbol: "btc/usd", spotSubscribe: async () => ({ close: async () => {}, async *[Symbol.asyncIterator]() {} }), mono: () => 0, wall: () => 0, log: createLogger({ level: "error", write: () => {} }) });
    expect(tape.hasTwap()).toBe(false);
    const sub = await tape.subscribeFn("spot")(["btc/usd"]);
    const got: number[] = [];
    const reader = (async () => { for await (const ev of sub) got.push(Number(ev.payload.value)); })();
    tape.push("spot", { ts: 1, price: 100, receivedAtMs: 0 });
    tape.push("twap", { ts: 1, price: 999, receivedAtMs: 0 }); // other stream: not ours
    tape.push("spot", { ts: 2, price: 101, receivedAtMs: 0 });
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toEqual([100, 101]);
    await sub.close();
    await reader;
    tape.push("spot", { ts: 3, price: 102, receivedAtMs: 0 });
    expect(got).toEqual([100, 101]);
  });
});
