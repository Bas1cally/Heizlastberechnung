/** Hard limits. Every one of these can only ever cause a REJECT. */
export interface RiskLimits {
  readonly maxMarketExposureUsd: number;
  readonly maxTotalExposureUsd: number;
  readonly maxUnpairedExposureUsd: number;
  readonly maxOrderSizeShares: number;
  readonly maxOpenOrders: number;
  readonly maxDailyLossUsd: number;
  readonly maxConsecutiveErrors: number;
  readonly maxChainlinkAgeMs: number;
  readonly maxOrderbookAgeMs: number;
  readonly minSecondsRemaining: number;
  readonly minMarketLiquidityShares: number;
  readonly maxSpread: number;
  readonly maxJevLatencyMs: number;
  /** A directional buy must be priced at least this far under the measured win probability of its side. */
  readonly minMeasuredEdge: number;
  /** Up to this price a buy with its hedge on the book is a free option and exempt from the edge rule. */
  readonly maxFreeTailPrice: number;
  /**
   * Whether a directional buy above the free-tail price may go out at all.
   * Default false: measured over 302 such fills (21/22 Sep), the side Jev
   * bought won 21.5% of the time, the market's price said 28.8%, the
   * hold-rate table said 45.8%. A table of a few hundred markets does not
   * out-measure a liquid market's price, and the buys were adversely
   * selected on top. True only for a deliberate experiment.
   */
  readonly allowDirectionalBuys: boolean;
}

/** Deliberately tight. Phase 1 never trades, so these only need to be safe. */
export const DEFAULT_LIMITS: RiskLimits = {
  maxMarketExposureUsd: 100,
  maxTotalExposureUsd: 250,
  maxUnpairedExposureUsd: 50,
  maxOrderSizeShares: 100,
  maxOpenOrders: 4,
  maxDailyLossUsd: 50,
  maxConsecutiveErrors: 3,
  maxChainlinkAgeMs: 2_000,
  maxOrderbookAgeMs: 1_000,
  minSecondsRemaining: 2,
  minMarketLiquidityShares: 50,
  maxSpread: 0.05,
  maxJevLatencyMs: 750,
  minMeasuredEdge: 0.02,
  maxFreeTailPrice: 0.05,
  allowDirectionalBuys: false,
};
