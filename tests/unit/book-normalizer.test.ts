import { describe, expect, it } from "vitest";
import { applyLevelChange, normalizeBook, parseLevels } from "../../src/feeds/book-normalizer.js";

describe("normalizeBook", () => {
  it("re-sorts the CLOB REST order (bids ascending, asks descending) into walk order", () => {
    const book = normalizeBook({
      assetId: "up",
      bids: [{ price: "0.980", size: "10" }, { price: "0.990", size: "5" }],
      asks: [{ price: "0.995", size: "7" }, { price: "0.991", size: "3" }],
      receivedAtMs: 1,
    });
    expect(book.bids.map((l) => l.price)).toEqual([0.99, 0.98]);
    expect(book.asks.map((l) => l.price)).toEqual([0.991, 0.995]);
  });

  it("converts decimal strings to numbers exactly once at the boundary", () => {
    const [l] = parseLevels([{ price: "0.003", size: "700" }]);
    expect(l).toEqual({ price: 0.003, size: 700 });
    expect(typeof l!.price).toBe("number");
  });

  it("drops levels that cannot be a binary price or have no size", () => {
    const levels = parseLevels([
      { price: "1.5", size: "1" },
      { price: "-0.1", size: "1" },
      { price: "abc", size: "1" },
      { price: "0.5", size: "0" },
      { price: "0.5", size: "2" },
    ]);
    expect(levels).toEqual([{ price: 0.5, size: 2 }]);
  });
});

describe("applyLevelChange", () => {
  const base = normalizeBook({
    assetId: "up",
    bids: [{ price: "0.98", size: "10" }],
    asks: [{ price: "0.99", size: "5" }, { price: "0.995", size: "7" }],
    receivedAtMs: 1,
  });

  it("upserts an ask and keeps ascending order", () => {
    const next = applyLevelChange(base, "SELL", 0.992, 4, 2);
    expect(next.asks.map((l) => [l.price, l.size])).toEqual([[0.99, 5], [0.992, 4], [0.995, 7]]);
    expect(next.receivedAtMs).toBe(2);
  });

  it("removes a level on size zero", () => {
    const next = applyLevelChange(base, "SELL", 0.99, 0, 2);
    expect(next.asks.map((l) => l.price)).toEqual([0.995]);
  });

  it("does not touch the other side", () => {
    const next = applyLevelChange(base, "BUY", 0.985, 3, 2);
    expect(next.asks).toEqual(base.asks);
    expect(next.bids.map((l) => l.price)).toEqual([0.985, 0.98]);
  });
});
