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
  liveTradingEnabled: true,
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
      liveTradingEnabled: false,
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

describe("live trading gate", () => {
  it("rejects any order when live trading is disabled", () => {
    expect(verdict({ liveTradingEnabled: false })).toEqual({
      result: "REJECTED",
      reason: "LIVE_TRADING_DISABLED",
    });
  });

  it("is the default posture, so observe mode can never place an order", () => {
    for (const action of ["BUY_UP", "BUY_DOWN", "BUY_PAIR", "ADD_COMPLEMENT"] as const) {
      expect(verdict({ action, liveTradingEnabled: false }).result).toBe("REJECTED");
    }
  });
});

describe("risk-reducing actions", () => {
  it("lets HOLD and ABSTAIN through even when limits are breached", () => {
    for (const action of ["HOLD", "ABSTAIN"] as const) {
      expect(verdict({ action, totalExposureUsd: 1e9, liveTradingEnabled: false }))
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
