import type { Action } from "../jev/decision-types.js";
import type { RiskLimits } from "./limits.js";

/**
 * The risk gate may veto a decision. It may never originate one, and it may
 * never turn a rejected decision into a different trade - a REJECT is the only
 * thing it can produce.
 */
export type RiskVerdict =
  | { readonly result: "APPROVED" }
  | { readonly result: "REJECTED"; readonly reason: RiskRejectReason };

export type RiskRejectReason =
  | "STALE_DECISION"
  | "STALE_CHAINLINK"
  | "STALE_ORDERBOOK"
  | "JEV_TOO_SLOW"
  | "TOO_CLOSE_TO_CLOSE"
  | "INSUFFICIENT_LIQUIDITY"
  | "SPREAD_TOO_WIDE"
  | "MARKET_EXPOSURE_EXCEEDED"
  | "TOTAL_EXPOSURE_EXCEEDED"
  | "UNPAIRED_EXPOSURE_EXCEEDED"
  | "ORDER_TOO_LARGE"
  | "TOO_MANY_OPEN_ORDERS"
  | "DAILY_LOSS_REACHED"
  | "ERROR_STREAK"
  | "LIVE_TRADING_DISABLED"
  /** Set by the observer, not the gate: the kill switch is tripped. */
  | "KILL_SWITCH";

export interface RiskContext {
  /** Version of the state the decision was made on. */
  readonly decisionStateVersion: bigint;
  /** Version of the state right now. */
  readonly currentStateVersion: bigint;

  readonly action: Action;
  readonly orderSizeShares: number;

  readonly secondsRemaining: number;
  readonly chainlinkAgeMs: number;
  readonly orderbookAgeMs: number;
  readonly jevLatencyMs: number;
  readonly marketLiquidityShares: number;
  readonly spread: number;

  readonly marketExposureUsd: number;
  readonly totalExposureUsd: number;
  readonly unpairedExposureUsd: number;
  readonly openOrders: number;
  readonly dailyPnlUsd: number;
  readonly consecutiveErrors: number;

  /**
   * none      - observe: nothing may be executed, simulated or otherwise
   * simulated - paper / shadow: orders are built and simulated, never sent
   * live      - real submission, only with ENABLE_LIVE_TRADING and --mode live
   */
  readonly executionMode: "none" | "simulated" | "live";
}

const APPROVED: RiskVerdict = { result: "APPROVED" };
const reject = (reason: RiskRejectReason): RiskVerdict => ({
  result: "REJECTED",
  reason,
});

/** Actions that never reach the book and so bypass the trading limits. */
const NON_TRADING: ReadonlySet<Action> = new Set<Action>(["HOLD", "ABSTAIN"]);

export function evaluateRisk(ctx: RiskContext, limits: RiskLimits): RiskVerdict {
  // HOLD and ABSTAIN create no order, so nothing below applies to them.
  if (NON_TRADING.has(ctx.action)) return APPROVED;

  if (ctx.consecutiveErrors >= limits.maxConsecutiveErrors) return reject("ERROR_STREAK");
  if (ctx.dailyPnlUsd <= -limits.maxDailyLossUsd) return reject("DAILY_LOSS_REACHED");

  // Data the decision rests on must be fresh - for a cancel as well, because
  // a state that cannot be trusted cannot justify any action.
  if (ctx.chainlinkAgeMs > limits.maxChainlinkAgeMs) return reject("STALE_CHAINLINK");
  if (ctx.orderbookAgeMs > limits.maxOrderbookAgeMs) return reject("STALE_ORDERBOOK");
  if (ctx.jevLatencyMs > limits.maxJevLatencyMs) return reject("JEV_TOO_SLOW");

  // Cancelling reduces risk; it is not order creation and exposure limits
  // must not block it.
  if (ctx.action === "CANCEL") return APPROVED;

  // Mandatory before order creation, and before every trading limit: a
  // decision made on an older material state must never reach the book,
  // however good it looked when it was made.
  if (ctx.decisionStateVersion !== ctx.currentStateVersion) {
    return reject("STALE_DECISION");
  }

  if (ctx.executionMode === "none") return reject("LIVE_TRADING_DISABLED");

  if (ctx.secondsRemaining < limits.minSecondsRemaining) return reject("TOO_CLOSE_TO_CLOSE");
  if (ctx.marketLiquidityShares < limits.minMarketLiquidityShares) {
    return reject("INSUFFICIENT_LIQUIDITY");
  }
  if (ctx.spread > limits.maxSpread) return reject("SPREAD_TOO_WIDE");

  if (ctx.orderSizeShares > limits.maxOrderSizeShares) return reject("ORDER_TOO_LARGE");
  if (ctx.openOrders >= limits.maxOpenOrders) return reject("TOO_MANY_OPEN_ORDERS");

  if (ctx.marketExposureUsd > limits.maxMarketExposureUsd) {
    return reject("MARKET_EXPOSURE_EXCEEDED");
  }
  if (ctx.totalExposureUsd > limits.maxTotalExposureUsd) {
    return reject("TOTAL_EXPOSURE_EXCEEDED");
  }
  if (ctx.unpairedExposureUsd > limits.maxUnpairedExposureUsd) {
    return reject("UNPAIRED_EXPOSURE_EXCEEDED");
  }

  return APPROVED;
}
