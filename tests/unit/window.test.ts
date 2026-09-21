import { describe, expect, it } from "vitest";
import { nextWindow, parseSlug, windowAt } from "../../src/market/window.js";

describe("5-minute market windows", () => {
  it("reproduces the observed slug for a known window", () => {
    // 1766162100 = 2025-12-19T16:35:00Z = 11:35 ET, matches the live listing.
    const w = windowAt(Date.parse("2025-12-19T16:37:12Z"));
    expect(w.slug).toBe("btc-updown-5m-1766162100");
    expect(w.openedAtMs).toBe(1766162100_000);
    expect(w.closesAtMs).toBe(1766162400_000);
  });

  it("rolls exactly at the boundary", () => {
    const boundary = 1766162400_000;
    expect(windowAt(boundary - 1).slug).toBe("btc-updown-5m-1766162100");
    expect(windowAt(boundary).slug).toBe("btc-updown-5m-1766162400");
    expect(nextWindow(boundary - 1).slug).toBe("btc-updown-5m-1766162400");
  });

  it("parses its own slugs and rejects others", () => {
    expect(parseSlug("btc-updown-5m-1766162100")?.closesAtMs).toBe(1766162400_000);
    expect(parseSlug("bitcoin-up-or-down-september-21-2026-8am-et")).toBeUndefined();
    expect(parseSlug("btc-updown-5m-abc")).toBeUndefined();
  });
});
