import { liquidityFor } from "../../src/risk/risk-gate.js";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/risk/limits.js";
import { evaluateRisk, type RiskContext } from "../../src/risk/risk-gate.js";

const base: RiskContext = {
  decisionStateVersion: 42n,
  currentStateVersion: 42n,
  action: "BUY_UP",
  orderSizeShares: 10,
  secondsRemaining: 60,
  chainlinkAgeMs: 100,
  orderbookAgeMs: 50,
  jevLatencyMs: 90,
  marketLiquidityShares: 500,
  spread: 0.002,
  marketExposureUsd: 10,
  totalExposureUsd: 20,
  unpairedExposureUsd: 5,
  openOrders: 0,
  dailyPnlUsd: 0,
  consecutiveErrors: 0,
  executionMode: "live",
};

const verdict = (over: Partial<RiskContext>) =>
  evaluateRisk({ ...base, ...over }, DEFAULT_LIMITS);

describe("state version", () => {
  it("rejects a decision made on an older state", () => {
    expect(verdict({ decisionStateVersion: 41n })).toEqual({
      result: "REJECTED",
      reason: "STALE_DECISION",
    });
  });

  it("checks staleness before every trading limit", () => {
    // All trading limits are also violated; staleness must still be the reason.
    const v = verdict({
      decisionStateVersion: 1n,
      orderSizeShares: 1e9,
      totalExposureUsd: 1e9,
      openOrders: 99,
      executionMode: "none",
    });
    expect(v).toEqual({ result: "REJECTED", reason: "STALE_DECISION" });
  });

  it("does not apply staleness to HOLD, ABSTAIN or CANCEL - they create no order", () => {
    for (const action of ["HOLD", "ABSTAIN", "CANCEL"] as const) {
      expect(verdict({ action, decisionStateVersion: 1n })).toEqual({ result: "APPROVED" });
    }
  });

  it("approves a matching version", () => {
    expect(verdict({})).toEqual({ result: "APPROVED" });
  });
});

describe("freshness and latency", () => {
  it.each([
    ["STALE_CHAINLINK", { chainlinkAgeMs: DEFAULT_LIMITS.maxChainlinkAgeMs + 1 }],
    ["STALE_ORDERBOOK", { orderbookAgeMs: DEFAULT_LIMITS.maxOrderbookAgeMs + 1 }],
    ["JEV_TOO_SLOW", { jevLatencyMs: DEFAULT_LIMITS.maxJevLatencyMs + 1 }],
  ])("rejects with %s", (reason, over) => {
    expect(verdict(over as Partial<RiskContext>)).toEqual({
      result: "REJECTED",
      reason,
    });
  });
});

describe("trading limits", () => {
  it.each([
    ["TOO_CLOSE_TO_CLOSE", { secondsRemaining: 1 }],
    ["INSUFFICIENT_LIQUIDITY", { marketLiquidityShares: 10 }],
    ["SPREAD_TOO_WIDE", { spread: 0.2 }],
    ["ORDER_TOO_LARGE", { orderSizeShares: 1000 }],
    ["TOO_MANY_OPEN_ORDERS", { openOrders: DEFAULT_LIMITS.maxOpenOrders }],
    ["MARKET_EXPOSURE_EXCEEDED", { marketExposureUsd: 1000 }],
    ["TOTAL_EXPOSURE_EXCEEDED", { totalExposureUsd: 1000 }],
    ["UNPAIRED_EXPOSURE_EXCEEDED", { unpairedExposureUsd: 1000 }],
    ["DAILY_LOSS_REACHED", { dailyPnlUsd: -DEFAULT_LIMITS.maxDailyLossUsd }],
    ["ERROR_STREAK", { consecutiveErrors: DEFAULT_LIMITS.maxConsecutiveErrors }],
  ])("rejects with %s", (reason, over) => {
    expect(verdict(over as Partial<RiskContext>)).toEqual({
      result: "REJECTED",
      reason,
    });
  });
});

describe("execution mode gate", () => {
  it("rejects any order in observe mode", () => {
    expect(verdict({ executionMode: "none" })).toEqual({
      result: "REJECTED",
      reason: "LIVE_TRADING_DISABLED",
    });
  });

  it("is the default posture, so observe mode can never place an order", () => {
    for (const action of ["BUY_UP", "BUY_DOWN", "BUY_PAIR", "ADD_COMPLEMENT"] as const) {
      expect(verdict({ action, executionMode: "none" }).result).toBe("REJECTED");
    }
  });

  it("lets simulated execution through the same limits as live", () => {
    expect(verdict({ executionMode: "simulated" })).toEqual({ result: "APPROVED" });
    expect(verdict({ executionMode: "simulated", orderSizeShares: 1e9 }).result).toBe("REJECTED");
  });
});

describe("risk-reducing actions", () => {
  it("lets HOLD and ABSTAIN through even when limits are breached", () => {
    for (const action of ["HOLD", "ABSTAIN"] as const) {
      expect(verdict({ action, totalExposureUsd: 1e9, executionMode: "none" }))
        .toEqual({ result: "APPROVED" });
    }
  });

  it("still allows CANCEL when exposure limits are breached", () => {
    expect(verdict({ action: "CANCEL", totalExposureUsd: 1e9 })).toEqual({
      result: "APPROVED",
    });
  });

  it("blocks CANCEL on stale data, because the state is not trustworthy", () => {
    expect(verdict({ action: "CANCEL", chainlinkAgeMs: 999_999 })).toEqual({
      result: "REJECTED",
      reason: "STALE_CHAINLINK",
    });
  });
});

describe("the gate only ever rejects", () => {
  it("returns no action of its own", () => {
    const v = verdict({ action: "BUY_UP", spread: 0.9 });
    expect(Object.keys(v).sort()).toEqual(["reason", "result"]);
    expect(v.result).toBe("REJECTED");
  });
});

describe("liquidityFor", () => {
  it("judges a one-sided buy on the side it buys, a pair on the thinner side, a complement on the missing side", () => {
    expect(liquidityFor("BUY_DOWN", 0, 5000)).toBe(5000);   // winner's asks empty, loser's deep: buying DOWN is still possible
    expect(liquidityFor("BUY_UP", 0, 5000)).toBe(0);
    expect(liquidityFor("BUY_PAIR", 0, 5000)).toBe(0);
    expect(liquidityFor("ADD_COMPLEMENT", 100, 7, { unpairedUpShares: 10, unpairedDownShares: 0 })).toBe(7);
    expect(liquidityFor("ADD_COMPLEMENT", 100, 7, { unpairedUpShares: 0, unpairedDownShares: 10 })).toBe(100);
    expect(liquidityFor("HOLD", 0, 5000)).toBe(5000);
  });
});

describe("measured edge", () => {
  const base = { decisionStateVersion: 1n, currentStateVersion: 1n, orderSizeShares: 10, secondsRemaining: 100, chainlinkAgeMs: 100, orderbookAgeMs: 100, jevLatencyMs: 100, marketLiquidityShares: 1000, spread: 0.01, marketExposureUsd: 0, totalExposureUsd: 0, unpairedExposureUsd: 0, openOrders: 0, dailyPnlUsd: 0, consecutiveErrors: 0, executionMode: "simulated" as const };
  it("rejects a directional buy priced above the measured win probability minus the edge, and nothing else", () => {
    expect(evaluateRisk({ ...base, action: "BUY_UP", buyPrice: 0.45, measuredWinProbability: 0.4 }, DEFAULT_LIMITS)).toEqual({ result: "REJECTED", reason: "NO_MEASURED_EDGE" });
    expect(evaluateRisk({ ...base, action: "BUY_UP", buyPrice: 0.59, measuredWinProbability: 0.6 }, DEFAULT_LIMITS)).toEqual({ result: "REJECTED", reason: "NO_MEASURED_EDGE" }); // 0.01 under: less than the 0.02 edge
    expect(evaluateRisk({ ...base, action: "BUY_UP", buyPrice: 0.57, measuredWinProbability: 0.6 }, DEFAULT_LIMITS)).toEqual({ result: "APPROVED" });
    expect(evaluateRisk({ ...base, action: "BUY_DOWN", buyPrice: 0.01, measuredWinProbability: 0.05 }, DEFAULT_LIMITS)).toEqual({ result: "APPROVED" }); // a tail under its measured reversal chance
    expect(evaluateRisk({ ...base, action: "BUY_UP", buyPrice: 0.45 }, DEFAULT_LIMITS)).toEqual({ result: "APPROVED" }); // no measurement: no rule
    expect(evaluateRisk({ ...base, action: "ADD_COMPLEMENT", buyPrice: 0.99, measuredWinProbability: 0.5 }, DEFAULT_LIMITS)).toEqual({ result: "APPROVED" }); // hedges need no edge
    // A tail at a few cents is a bounded option (its hedge is a resting bid, not something on the book now), exempt even where the measured reversal rate is below its price.
    expect(evaluateRisk({ ...base, action: "BUY_DOWN", buyPrice: 0.01, measuredWinProbability: 0.005 }, DEFAULT_LIMITS)).toEqual({ result: "APPROVED" });
    expect(evaluateRisk({ ...base, action: "BUY_DOWN", buyPrice: 0.05, measuredWinProbability: 0.005 }, DEFAULT_LIMITS)).toEqual({ result: "APPROVED" });
    expect(evaluateRisk({ ...base, action: "BUY_DOWN", buyPrice: 0.06, measuredWinProbability: 0.005 }, DEFAULT_LIMITS)).toEqual({ result: "REJECTED", reason: "NO_MEASURED_EDGE" });
  });
});
