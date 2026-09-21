import { describe, expect, it, vi } from "vitest";
import { DEFAULT_KILL_THRESHOLDS, KillSwitch, isHardReason } from "../../src/risk/kill-switch.js";

const healthy = (nowMono: number) => ({ nowMono, chainlinkAgeMs: 500, marketWsAgeMs: 200, clockDriftMs: 10, dailyPnlUsd: 0 });
const make = () => {
  const onTrip = vi.fn(); const onClear = vi.fn();
  const ks = new KillSwitch({ ...DEFAULT_KILL_THRESHOLDS, recoveryMs: 1_000 }, { onTrip, onClear });
  // past warm-up
  ks.evaluate(healthy(0)); ks.evaluate(healthy(20_000));
  return { ks, onTrip, onClear };
};

describe("KillSwitch", () => {
  it("is quiet while everything is healthy", () => {
    const { ks, onTrip } = make();
    expect(ks.evaluate(healthy(21_000)).tripped).toBe(false);
    expect(onTrip).not.toHaveBeenCalled();
  });

  it("trips on a stale feed, holds while stale, and clears after recovery", () => {
    const { ks, onTrip, onClear } = make();
    const s = ks.evaluate({ ...healthy(21_000), chainlinkAgeMs: 15_000 });
    expect(s).toMatchObject({ tripped: true, reasons: ["CHAINLINK_STALE"], hard: false });
    expect(onTrip).toHaveBeenCalledTimes(1);
    ks.evaluate({ ...healthy(21_500), chainlinkAgeMs: 15_500 });
    expect(onTrip).toHaveBeenCalledTimes(1); // no re-trip while it holds
    ks.evaluate(healthy(22_000));
    expect(ks.state().tripped).toBe(true); // healthy, but not for long enough
    ks.evaluate(healthy(23_100));
    expect(ks.state().tripped).toBe(false);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("does not trip on feed age during the first 15 seconds", () => {
    const ks = new KillSwitch({ ...DEFAULT_KILL_THRESHOLDS });
    expect(ks.evaluate({ nowMono: 0, chainlinkAgeMs: Infinity, marketWsAgeMs: Infinity, clockDriftMs: NaN, dailyPnlUsd: 0 }).tripped).toBe(false);
    expect(ks.evaluate({ nowMono: 14_000, chainlinkAgeMs: Infinity, marketWsAgeMs: Infinity, clockDriftMs: NaN, dailyPnlUsd: 0 }).tripped).toBe(false);
    expect(ks.evaluate({ nowMono: 16_000, chainlinkAgeMs: Infinity, marketWsAgeMs: Infinity, clockDriftMs: NaN, dailyPnlUsd: 0 }).tripped).toBe(true);
  });

  it("latches hard reasons until resumed, even when feeds are healthy", () => {
    const { ks, onClear } = make();
    ks.evaluate({ ...healthy(21_000), dailyPnlUsd: -60 });
    expect(ks.state()).toMatchObject({ tripped: true, reasons: ["DAILY_LOSS"], hard: true });
    ks.evaluate(healthy(100_000));
    expect(ks.state().tripped).toBe(true);
    expect(onClear).not.toHaveBeenCalled();
    ks.resume();
    expect(ks.state().tripped).toBe(false);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("counts consecutive Jev failures and resets on success", () => {
    const { ks } = make();
    for (let i = 0; i < 4; i++) ks.jevFailed("JEV_TIMEOUT", 21_000 + i);
    expect(ks.state().tripped).toBe(false);
    ks.jevSucceeded();
    for (let i = 0; i < 4; i++) ks.jevFailed("JEV_TIMEOUT", 22_000 + i);
    expect(ks.state().tripped).toBe(false);
    ks.jevFailed("JEV_UNAVAILABLE", 23_000);
    expect(ks.state().reasons).toEqual(["JEV_UNAVAILABLE"]);
  });

  it("trips on an API error burst inside the window only", () => {
    const { ks } = make();
    for (let i = 0; i < 9; i++) ks.apiError(21_000 + i * 1000);
    expect(ks.state().tripped).toBe(false);
    ks.apiError(200_000); // far outside the window: old errors have aged out
    expect(ks.state().tripped).toBe(false);
    for (let i = 0; i < 10; i++) ks.apiError(300_000 + i * 100);
    expect(ks.state().reasons).toEqual(["POLYMARKET_API_ERRORS"]);
  });

  it("manual and hard faults fire onTrip even when already tripped", () => {
    const { ks, onTrip } = make();
    ks.evaluate({ ...healthy(21_000), chainlinkAgeMs: 99_999 });
    ks.hardFault("INVENTORY_MISMATCH", 21_500);
    expect(onTrip).toHaveBeenCalledTimes(2);
    expect(ks.state().hard).toBe(true);
    expect(isHardReason("MANUAL")).toBe(true);
    expect(isHardReason("MARKET_WS_STALE")).toBe(false);
  });
});
