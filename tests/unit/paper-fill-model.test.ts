import { describe, expect, it } from "vitest";
import { DEFAULT_FILL_PARAMS, fillMarketable, fillResting, isMarketable, seededRandom } from "../../src/replay/paper-fill-model.js";
import { normalizeBook } from "../../src/feeds/book-normalizer.js";
import type { OrderIntent } from "../../src/execution/order-builder.js";

const book = (asks: [number, number][]) => normalizeBook({ assetId: "UP", bids: [], asks: asks.map(([price, size]) => ({ price, size })), receivedAtMs: 0 });
const order = (price: number, size: number, type: "GTC" | "GTD" | "FAK" | "FOK"): OrderIntent =>
  ({ side: "UP", assetId: "UP", price, size, style: { type, aggressionTicks: 0 }, sizedBy: "max_order" });
const p = { ...DEFAULT_FILL_PARAMS, slippage: 0 };

describe("marketable fills", () => {
  it("does not fill at the old price when the book moved away", () => {
    const r = fillMarketable(order(0.45, 50, "FAK"), book([[0.47, 100]]), p);
    expect(r.status).toBe("NO_FILL");
    expect(r.reason).toMatch(/moved away/);
  });

  it("fills partially when depth runs out and says so", () => {
    const r = fillMarketable(order(0.46, 100, "FAK"), book([[0.45, 30], [0.46, 20], [0.47, 500]]), p);
    expect(r.status).toBe("PARTIAL");
    expect(r.filledQty).toBe(50);
    expect(r.avgPrice).toBeCloseTo((30 * 0.45 + 20 * 0.46) / 50, 9);
  });

  it("FOK is all or nothing", () => {
    expect(fillMarketable(order(0.46, 100, "FOK"), book([[0.45, 30], [0.46, 20]]), p).status).toBe("NO_FILL");
    expect(fillMarketable(order(0.46, 50, "FOK"), book([[0.45, 30], [0.46, 20]]), p).status).toBe("FILLED");
  });

  it("charges slippage and taker fee", () => {
    const r = fillMarketable(order(0.5, 10, "FAK"), book([[0.45, 100]]), { ...p, slippage: 0.002, takerFee: 0.001 });
    expect(r.avgPrice).toBeCloseTo(0.452, 9);
    expect(r.fee).toBeCloseTo(0.01, 9);
  });
});

describe("resting fills", () => {
  const rand = seededRandom(42);

  it("fills when the market trades through the limit", () => {
    const r = fillResting(order(0.45, 20, "GTC"), [book([[0.46, 10]]), book([[0.449, 10]])], p, rand);
    expect(r.status).toBe("FILLED");
    expect(r.avgPrice).toBe(0.45);
  });

  it("never fills when never touched", () => {
    expect(fillResting(order(0.45, 20, "GTC"), [book([[0.46, 10]]), book([[0.47, 10]])], p, rand).status).toBe("NO_FILL");
  });

  it("fills a touched order only by the queue draw, reproducibly", () => {
    const touched = [book([[0.45, 10]])];
    const a = Array.from({ length: 200 }, (_, i) => fillResting(order(0.45, 20, "GTC"), touched, p, seededRandom(i)).status === "FILLED");
    const b = Array.from({ length: 200 }, (_, i) => fillResting(order(0.45, 20, "GTC"), touched, p, seededRandom(i)).status === "FILLED");
    expect(a).toEqual(b);
    const rate = a.filter(Boolean).length / a.length;
    expect(rate).toBeGreaterThan(0.2);
    expect(rate).toBeLessThan(0.5);
  });
});

describe("marketability", () => {
  it("treats FAK/FOK and limits at or through the ask as marketable", () => {
    const b = book([[0.45, 10]]);
    expect(isMarketable(order(0.44, 1, "GTC"), b)).toBe(false);
    expect(isMarketable(order(0.45, 1, "GTC"), b)).toBe(true);
    expect(isMarketable(order(0.40, 1, "FAK"), b)).toBe(true);
  });
});
