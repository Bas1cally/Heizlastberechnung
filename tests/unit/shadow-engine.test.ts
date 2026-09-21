import { describe, expect, it, vi } from "vitest";
import { ShadowEngine, type ShadowRecord } from "../../src/execution/shadow-engine.js";
import { DEFAULT_FILL_PARAMS } from "../../src/replay/paper-fill-model.js";
import { normalizeBook } from "../../src/feeds/book-normalizer.js";
import type { OrderIntent } from "../../src/execution/order-builder.js";

const book = (ask: number, at: number) => normalizeBook({ assetId: "UP", bids: [], asks: [{ price: ask, size: 100 }], receivedAtMs: at });
const intent = (price: number, type: "FOK" | "GTC" = "FOK"): OrderIntent => ({ side: "UP", assetId: "UP", price, size: 10, style: { type, aggressionTicks: 0 }, sizedBy: "max_order" });

function engine(signOk = true) {
  let now = 1000;
  const records: ShadowRecord[] = [];
  const sign = vi.fn(async (i: OrderIntent) => {
    now += 25; // signing takes 25 ms
    if (!signOk) throw new Error("no key");
    return { tokenId: i.assetId, side: "BUY", makerAmount: "1", takerAmount: "1", orderType: i.style.type, signature: "0xsig" };
  });
  const e = new ShadowEngine({ signer: { sign }, mono: () => now, assumedSubmitToAckMs: 100, fill: { ...DEFAULT_FILL_PARAMS, slippage: 0 }, onRecord: (r) => records.push(r) });
  return { e, records, sign, tick: (ms: number) => { now += ms; return now; } };
}

describe("ShadowEngine", () => {
  it("signs, never posts, and resolves against the book at the hypothetical ACK", async () => {
    const { e, records, sign, tick } = engine();
    await e.submit("d1", [intent(0.45)], () => book(0.45, 0), 1000);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(e.pendingCount()).toBe(1);

    e.onBook(book(0.46, 0), tick(50)); // before ACK time: still pending
    expect(records).toHaveLength(0);

    e.onBook(book(0.46, 0), tick(100)); // past ACK: book moved to .46
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.signed?.signature).toBe("0xsig");
    expect(r.expectedPrice).toBe(0.45);
    expect(r.priceAtAck).toBe(0.46);
    expect(r.movedAgainstBps).toBeCloseTo(222.2, 0);
    expect(r.hypotheticalFill?.status).toBe("NO_FILL"); // FOK at .45 cannot fill at .46
    expect(r.stamps.signingCompletedMono - r.stamps.signingStartedMono).toBe(25);
  });

  it("records a hypothetical fill when the book held", async () => {
    const { e, records, tick } = engine();
    await e.submit("d2", [intent(0.45)], () => book(0.45, 0), 1000);
    e.onBook(book(0.45, 0), tick(200));
    expect(records[0]!.hypotheticalFill).toMatchObject({ status: "FILLED", filledQty: 10, avgPrice: 0.45 });
    expect(records[0]!.movedAgainstBps).toBe(0);
  });

  it("keeps a signing failure as data rather than throwing", async () => {
    const { e, records, tick } = engine(false);
    await e.submit("d3", [intent(0.45)], () => book(0.45, 0), 1000);
    e.onBook(book(0.45, 0), tick(200));
    expect(records[0]!.signed).toBeUndefined();
    expect(records[0]!.signError).toMatch(/no key/);
    expect(records[0]!.hypotheticalFill).toBeUndefined();
  });

  it("marks a non-marketable order as resting and flushes leftovers at close", async () => {
    const { e, records, tick } = engine();
    await e.submit("d4", [intent(0.44, "GTC"), intent(0.45)], () => book(0.45, 0), 1000);
    e.onBook(book(0.45, 0), tick(200));
    expect(records.map((r) => r.hypotheticalFill?.status)).toEqual(["FILLED", "RESTING"]);
    await e.submit("d5", [intent(0.45)], () => book(0.45, 0), 2000);
    e.flush(() => book(0.47, 0));
    expect(records[2]!.priceAtAck).toBe(0.47);
    expect(e.pendingCount()).toBe(0);
  });
});
