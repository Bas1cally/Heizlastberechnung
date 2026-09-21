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
  /** A directional buy priced above the measured probability of that side winning (limits.minMeasuredEdge). */
  | "NO_MEASURED_EDGE"
  /** Set by the observer, not the gate: the kill switch is tripped. */
  | "KILL_SWITCH";

export interface RiskContext {
  /** Version of the state the decision was made on. */
  readonly decisionStateVersion: bigint;
  /** Version of the state right now. */
  readonly currentStateVersion: bigint;

  readonly action: Action;
  readonly orderSizeShares: number;
  /**
   * For a directional buy: the price the order would pay and the measured
   * probability (hold-rate table) that the bought side wins. Undefined when
   * the buy completes a set against unpaired inventory (a hedge at no more
   * than 1.00 needs no edge) or when no measurement exists for the bucket.
   */
  readonly buyPrice?: number | undefined;
  readonly measuredWinProbability?: number | undefined;
  /** Samples behind measuredWinProbability; the required edge grows with its standard error. */
  readonly measuredSamples?: number | undefined;

  readonly secondsRemaining: number;
  readonly chainlinkAgeMs: number;
  readonly orderbookAgeMs: number;
  readonly jevLatencyMs: number;
  /**
   * Ask depth of the side(s) the action would buy. Late in a market the
   * winner's ask side empties while the loser's stays deep; judging a
   * one-sided buy on the thinner of the two sides would refuse every buy of
   * the still-available side and approve nothing.
   */
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

/** Ask depth relevant to an action: the side it buys, the thinner side for a pair, the complement's side. */
export function liquidityFor(action: Action, upAskDepth: number, downAskDepth: number, inventory?: { unpairedUpShares: number; unpairedDownShares: number }): number {
  switch (action) {
    case "BUY_UP": return upAskDepth;
    case "BUY_DOWN": return downAskDepth;
    case "BUY_PAIR": return Math.min(upAskDepth, downAskDepth);
    case "ADD_COMPLEMENT": return (inventory?.unpairedUpShares ?? 0) > 0 ? downAskDepth : (inventory?.unpairedDownShares ?? 0) > 0 ? upAskDepth : Math.min(upAskDepth, downAskDepth);
    default: return Math.max(upAskDepth, downAskDepth);
  }
}

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

  // Data over conviction: a directional buy must be priced at least
  // minMeasuredEdge under the measured chance of that side winning. Paying
  // 0.45 for a side the recordings say wins 40% of the time is a losing
  // trade however confident the judgment behind it.
  // A tail of a few cents with its hedge on the book is a free option (the set
  // can be completed at no more than 1.00), so it needs no edge of its own.
  // A tail at a few cents is a bounded option, not a bet: the downside is its
  // price (held by the unpaired-exposure limit), the hedge that makes it free
  // is a bid resting at 1.00 minus the tail, filled by holders selling out.
  const freeOption = ctx.buyPrice !== undefined && ctx.buyPrice <= limits.maxFreeTailPrice + 1e-9;
  if ((ctx.action === "BUY_UP" || ctx.action === "BUY_DOWN") && !freeOption && ctx.buyPrice !== undefined && ctx.measuredWinProbability !== undefined) {
    // The measurement is a sample rate: with n markets behind it, its standard
    // error is sqrt(p(1-p)/n). An "edge" inside two of those is the noise of
    // the table, not a mispricing (0.55 from 70 markets is 0.55 +- 0.12; the
    // first paper hours bought at 0.44 on exactly that and lost).
    const p = ctx.measuredWinProbability;
    const se = ctx.measuredSamples !== undefined && ctx.measuredSamples > 0 ? Math.sqrt((p * (1 - p)) / ctx.measuredSamples) : 0;
    const required = Math.max(limits.minMeasuredEdge, 2 * se);
    if (ctx.buyPrice > p - required + 1e-9) return reject("NO_MEASURED_EDGE");
  }

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
