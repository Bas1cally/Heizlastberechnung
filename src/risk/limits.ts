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
};
