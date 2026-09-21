import { choice, score } from "@typesafe-ai/sdk";

/**
 * The question set. All of it goes out in one request: the questions are
 * independent judgments over the same state and cannot see one another's
 * answers, so splitting them would only add round trips.
 *
 * Primitive choice, and why:
 *
 *   choice - genuinely categorical. The seven actions are alternatives, not
 *            points on a scale.
 *   score  - ordered rubrics. VERY_LOW..VERY_HIGH is a described dimension;
 *            sending it as a choice would tell the model that VERY_LOW and
 *            VERY_HIGH are unrelated labels and throw away the ordering that
 *            makes a threshold meaningful.
 *
 * Criteria text is paid for on every single request, so each description
 * earns its length by removing a real ambiguity.
 */
export const QUESTIONS = {
  action: choice(
    "Given the settlement state, market prices, time remaining, market dynamics and the existing inventory, what is the best immediate action?",
    {
      BUY_UP: "Open or extend a directional position in the UP outcome.",
      BUY_DOWN: "Open or extend a directional position in the DOWN outcome.",
      BUY_PAIR: "Buy both outcomes together as a complete set for the pair edge.",
      ADD_COMPLEMENT:
        "Hold significant inventory in one outcome and buy the cheap opposite outcome to match it into pairs.",
      HOLD: "Keep the current position and open orders unchanged.",
      CANCEL: "Withdraw resting orders without opening anything new.",
      ABSTAIN:
        "Take no position: the state is unclear, stale, or not worth the risk.",
    },
  ),

  settlement_direction: choice(
    "At settlement, will the market resolve UP or DOWN? The settlement price is the 60-second Chainlink TWAP of BTC/USD (`settlementCurrentPrice`), compared with its value at the start of the window (`settlementStartPrice`). `spotPrice` leads the TWAP; `spotVsTwapBps` shows where the TWAP is being pulled in the seconds remaining. `leadHeldRate` is measured, not guessed: in the recorded markets, the fraction of the time a lead of this size with this much time left was still the winning side at settlement (`leadHeldSamples` observations; null when too few). A lead of a few bps with minutes left is often overturned; treat the measured rate as the base rate and adjust from the momentum and spot-vs-TWAP evidence.",
    {
      UP: "The settlement price at close will be greater than or equal to the start price. An exact tie resolves UP.",
      DOWN: "The settlement price at close will be strictly below the start price.",
      UNRESOLVED:
        "Too close or too early to call: the outcome is not determined by the current state.",
    },
  ),

  market_mispricing: choice(
    "Relative to what the state implies is fair, what is mispriced right now?",
    {
      UP_UNDERVALUED: "The UP outcome trades below its fair value.",
      DOWN_UNDERVALUED: "The DOWN outcome trades below its fair value.",
      PAIR_UNDERVALUED:
        "A complete set costs meaningfully less than its 1.00 settlement value.",
      NONE: "Prices are close enough to fair that no edge is available.",
      UNCERTAIN: "The state does not support a judgment about fair value.",
    },
  ),

  inventory_action: choice(
    "What should happen to the current inventory, considering the pnl under both settlement outcomes?",
    {
      NONE: "Leave the inventory as it is.",
      ADD_UP: "Increase the UP holding.",
      ADD_DOWN: "Increase the DOWN holding.",
      PAIR: "Match unpaired shares by buying the opposite outcome.",
      MERGE: "Convert matched shares back into collateral.",
      REDUCE_RISK: "Cut exposure: the downside under one outcome is too large.",
    },
  ),

  execution_urgency: choice(
    "How urgently should the chosen action reach the book?",
    {
      PASSIVE: "Rest on the book and wait for the market to come to the order.",
      NORMAL: "A limit order at a controlled price; some waiting is acceptable.",
      URGENT: "Cross the spread if needed; the opportunity is decaying.",
      IMMEDIATE:
        "Fill now or not at all; waiting destroys the value of the trade.",
      DO_NOT_TRADE: "Send nothing to the book.",
    },
  ),

  winner_confidence: score(
    "How confident is the judgment about which outcome wins?",
    [
      "No basis to prefer either outcome.",
      "A weak lean that could be reversed by ordinary noise.",
      "A real lean, but well within the range of remaining movement.",
      "A strong lean: reversal needs an unusual move in the time left.",
      "Effectively decided by the remaining time and distance.",
    ],
  ),

  reversal_risk: score(
    "How likely is the currently leading outcome to be overturned before settlement?",
    [
      "Essentially impossible in the time remaining.",
      "Would need a move well beyond recent volatility.",
      "Plausible given recent volatility.",
      "A likely reversal on current movement.",
      "Reversal is already underway.",
    ],
  ),

  adverse_selection_risk: score(
    "How likely is it that whoever fills this order knows something the state does not show?",
    [
      "Deep, balanced book with no sign of informed flow.",
      "Ordinary two-sided activity.",
      "Thinning book or one-sided pressure.",
      "Quotes pulling away as the order would arrive.",
      "The available size looks like it is being offered because it is about to be wrong.",
    ],
  ),
} as const;
