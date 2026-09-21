import type { ChoiceResponse, ScoreResponse, Usage } from "@typesafe-ai/sdk";

export const ACTIONS = [
  "BUY_UP",
  "BUY_DOWN",
  "BUY_PAIR",
  "ADD_COMPLEMENT",
  "HOLD",
  "CANCEL",
  "ABSTAIN",
] as const;
export type Action = (typeof ACTIONS)[number];

export const URGENCIES = [
  "PASSIVE",
  "NORMAL",
  "URGENT",
  "IMMEDIATE",
  "DO_NOT_TRADE",
] as const;
export type Urgency = (typeof URGENCIES)[number];

/** The compact snapshot Jev sees. Serializable, auditable, reproducible. */
export interface JevInputState {
  readonly market: {
    readonly secondsRemaining: number;
    readonly settlementStartPrice: number;
    readonly settlementCurrentPrice: number;
    readonly distanceUsd: number;
    readonly distanceBps: number;
    /** Chainlink spot; the TWAP the market settles on lags it. */
    readonly spotPrice: number;
    /** (spot - settlementCurrent) / settlementCurrent in bps: where the TWAP is being pulled. */
    readonly spotVsTwapBps: number;
    /**
     * Measured base rate: in the recorded markets, the share of the time a
     * lead of this size with this much time left was still the winning side
     * at settlement. null when fewer than 20 samples exist for the bucket.
     */
    readonly leadHeldRate: number | null;
    readonly leadHeldSamples: number;
  };
  readonly movement: {
    readonly return1s: number;
    readonly return3s: number;
    readonly return5s: number;
    readonly return10s: number;
    readonly return30s: number;
    readonly realizedVol5s: number;
    readonly realizedVol10s: number;
    readonly realizedVol30s: number;
  };
  readonly orderbook: {
    readonly upBid: number;
    readonly upAsk: number;
    readonly downBid: number;
    readonly downAsk: number;
    readonly upDepth: number;
    readonly downDepth: number;
    readonly pairAskCost: number;
    readonly pairExecutableQty: number;
    readonly pairEdge: number;
    readonly upSpread: number;
    readonly downSpread: number;
    readonly imbalanceUp: number;
    readonly imbalanceDown: number;
  };
  readonly inventory: {
    readonly upShares: number;
    readonly downShares: number;
    readonly avgUpEntry: number;
    readonly avgDownEntry: number;
    readonly pairedShares: number;
    readonly unpairedUpShares: number;
    readonly unpairedDownShares: number;
    readonly pnlIfUp: number;
    readonly pnlIfDown: number;
    readonly guaranteedPairPnl: number;
  };
  readonly dataQuality: {
    readonly chainlinkAgeMs: number;
    readonly bookAgeMs: number;
  };
}

/** Everything Jev returned. Distributions are kept in full - discarding them
 *  would make the calibration analysis in docs/JEV_DECISIONS.md impossible. */
export interface JevAnswers {
  readonly action: ChoiceResponse;
  readonly settlement_direction: ChoiceResponse;
  readonly market_mispricing: ChoiceResponse;
  readonly inventory_action: ChoiceResponse;
  readonly execution_urgency: ChoiceResponse;
  readonly winner_confidence: ScoreResponse;
  readonly reversal_risk: ScoreResponse;
  readonly adverse_selection_risk: ScoreResponse;
}

export type RiskGateResult = "APPROVED" | "REJECTED";

/** The audit record required by section 23 of the brief. */
export interface DecisionRecord {
  readonly decisionId: string;
  readonly marketId: string;
  readonly stateVersion: bigint;
  readonly timestampMs: number;
  readonly state: JevInputState;
  readonly answers: JevAnswers;
  readonly jevLatencyMs: number;
  readonly model: string;
  readonly usage: Usage;
  readonly requestedAction: Action;
  readonly riskGateResult: RiskGateResult;
  readonly riskGateReason?: string;
  readonly resultingOrders: readonly string[];
}
