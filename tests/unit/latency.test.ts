import { describe, expect, it } from "vitest";
import { LatencyTracker, breakdown, percentiles } from "../../src/analytics/latency.js";

describe("percentiles", () => {
  it("uses nearest rank and reports max and mean", () => {
    const p = percentiles([5, 1, 4, 2, 3, 100]);
    expect(p.count).toBe(6);
    expect(p.p50).toBe(3);
    expect(p.p90).toBe(100);
    expect(p.max).toBe(100);
    expect(p.mean).toBeCloseTo(19.1667, 3);
  });
  it("never invents a zero for an empty set", () => {
    const p = percentiles([]);
    expect(p.count).toBe(0);
    expect(Number.isNaN(p.p50)).toBe(true);
  });
  it("ignores non-finite samples", () => {
    expect(percentiles([1, NaN, Infinity, 3]).count).toBe(2);
  });
});

describe("breakdown", () => {
  it("only reports stages that happened", () => {
    const b = breakdown({ packetReceived: 0, stateUpdated: 2, jevRequestStarted: 3, jevResponseReceived: 94 });
    expect(b).toEqual({ feed_to_state_ms: 2, state_to_jev_ms: 1, jev_ms: 91, jev_to_submit_ms: undefined, submit_to_ack_ms: undefined, feed_to_ack_ms: undefined });
  });
});

describe("LatencyTracker", () => {
  it("aggregates per stage and bounds memory", () => {
    const t = new LatencyTracker(3);
    for (let i = 1; i <= 5; i++) t.record({ jev_ms: i });
    const r = t.report();
    expect(r["jev_ms"]!.count).toBe(3);
    expect(r["jev_ms"]!.max).toBe(5);
    expect(r["feed_to_state_ms"]).toBeUndefined();
  });
});

describe("breakdown with unstamped stages", () => {
  it("treats NaN stamps as not having happened", () => {
    const b = breakdown({ packetReceived: Number.NaN, stateUpdated: 5, jevRequestStarted: 6, jevResponseReceived: 90 });
    expect(b.feed_to_state_ms).toBeUndefined();
    expect(b.jev_ms).toBe(84);
  });
});
