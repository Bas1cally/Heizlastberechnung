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
