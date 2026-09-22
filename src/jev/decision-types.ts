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
    /** The market's open, epoch ms: identifies the market for per-market bookkeeping. Constant within a market. */
    readonly openedAtMs: number;
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
    /** The side the market prices as the likely winner (higher ask), and the other one. null before both books exist. */
    readonly leader: "UP" | "DOWN" | null;
    readonly leaderAsk: number;
    /** Shares offered on the leader's ask side; when this empties, no hedge is possible any more. */
    readonly leaderAskDepth: number;
    readonly tailAsk: number;
    readonly tailAskDepth: number;
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
    /**
     * Most the opposite side may cost per share so that pairing the unpaired
     * shares and merging costs nothing (1.00 minus the unpaired side's entry).
     * null when nothing is unpaired.
     */
    readonly hedgePriceCap: number | null;
    /** Whether the opposite side is currently offered at or below hedgePriceCap (it can be lifted at once). Late in a market the leader usually has no ask at all; the hedge is then a bid resting at the cap. */
    readonly hedgeAvailable: boolean;
    /** Orders of ours resting in the book or in flight. A hedge already resting must not be placed again. */
    readonly openOrders: number;
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
