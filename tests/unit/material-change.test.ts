import { describe, expect, it } from "vitest";
import { materialChange, timeBucket } from "../../src/jev/material-change.js";
import type { JevInputState } from "../../src/jev/decision-types.js";

const base: JevInputState = {
  market: { secondsRemaining: 200, settlementStartPrice: 85000, settlementCurrentPrice: 85001, distanceUsd: 1, distanceBps: 0.12, spotPrice: 85003, spotVsTwapBps: 0.24, leadHeldRate: null, leadHeldSamples: 0 },
  movement: { return1s: 0, return3s: 0, return5s: 0, return10s: 0, return30s: 0, realizedVol5s: 0, realizedVol10s: 0, realizedVol30s: 0 },
  orderbook: { upBid: 0.45, upAsk: 0.46, downBid: 0.54, downAsk: 0.55, upDepth: 1000, downDepth: 1000, pairAskCost: 1.01, pairExecutableQty: 100, pairEdge: -0.01, upSpread: 0.01, downSpread: 0.01, imbalanceUp: 0, imbalanceDown: 0 },
  inventory: { upShares: 0, downShares: 0, avgUpEntry: 0, avgDownEntry: 0, pairedShares: 0, unpairedUpShares: 0, unpairedDownShares: 0, pnlIfUp: 0, pnlIfDown: 0, guaranteedPairPnl: 0 },
  dataQuality: { chainlinkAgeMs: 100, bookAgeMs: 20 },
};
const withOb = (ob: Partial<JevInputState["orderbook"]>): JevInputState => ({ ...base, orderbook: { ...base.orderbook, ...ob } });

describe("materialChange", () => {
  it("is always material the first time", () => {
    expect(materialChange(undefined, base, 0)).toBe("first");
  });

  it("ignores depth noise that does not move a quote", () => {
    expect(materialChange(base, withOb({ upDepth: 1234, imbalanceUp: 0.3 }), 100)).toBeUndefined();
  });

  it("fires on a quote change", () => {
    expect(materialChange(base, withOb({ upAsk: 0.47 }), 100)).toBe("quote");
  });

  it("fires on a pair cost or executable quantity change past the threshold", () => {
    expect(materialChange(base, withOb({ pairAskCost: 1.013 }), 100)).toBe("pair");
    expect(materialChange(base, withOb({ pairAskCost: 1.0105 }), 100)).toBeUndefined();
    expect(materialChange(base, withOb({ pairExecutableQty: 60 }), 100)).toBe("pair");
  });

  it("fires on settlement movement past half a bp, not on rounding jitter", () => {
    expect(materialChange(base, { ...base, market: { ...base.market, distanceBps: 0.8 } }, 100)).toBe("settlement");
    expect(materialChange(base, { ...base, market: { ...base.market, distanceBps: 0.3 } }, 100)).toBeUndefined();
  });

  it("fires when spot moves away from the TWAP, which is where settlement is heading", () => {
    expect(materialChange(base, { ...base, market: { ...base.market, spotVsTwapBps: 1.2 } }, 100)).toBe("spot");
    expect(materialChange(base, { ...base, market: { ...base.market, spotVsTwapBps: 0.5 } }, 100)).toBeUndefined();
  });

  it("fires when the remaining-time bucket changes", () => {
    expect(materialChange(base, { ...base, market: { ...base.market, secondsRemaining: 119 } }, 100)).toBe("time_bucket");
    expect(materialChange(base, { ...base, market: { ...base.market, secondsRemaining: 150 } }, 100)).toBeUndefined();
  });

  it("fires on inventory and on data going stale", () => {
    expect(materialChange(base, { ...base, inventory: { ...base.inventory, upShares: 10 } }, 100)).toBe("inventory");
    expect(materialChange(base, { ...base, dataQuality: { chainlinkAgeMs: 5000, bookAgeMs: 20 } }, 100)).toBe("data_quality");
  });

  it("heartbeats when nothing moved for long enough", () => {
    expect(materialChange(base, base, 4_999)).toBeUndefined();
    expect(materialChange(base, base, 5_000)).toBe("heartbeat");
  });
});

describe("timeBucket", () => {
  it("follows the brief's segments", () => {
    expect([300, 120, 119, 60, 59, 30, 15, 10, 5, 2, 1].map(timeBucket)).toEqual([0, 0, 1, 1, 2, 2, 3, 4, 5, 6, 7]);
  });
});
