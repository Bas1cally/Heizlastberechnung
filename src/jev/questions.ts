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
    "Given the settlement state, market prices, time remaining, market dynamics and the existing inventory, what is the best immediate action? The economics that matter: a complete set (one UP plus one DOWN share) always merges back to exactly 1.00, so a pair bought for 1.00 or less costs nothing. Buying the trailing side (`tailAsk`, usually 0.01-0.02 late in the market) and later pairing it with the leading side at no more than `hedgePriceCap` is therefore a free option on a late reversal: if the lead reverses before the hedge, the tail pays 1.00; if not, the pair is merged at no cost. The hedge is only possible while the leader is offered at or under the cap (`hedgeAvailable`, `leaderAskDepth`); once the leader's ask side empties, an unpaired tail can no longer be hedged and expires worthless if the lead holds. `leadHeldRate` is the measured chance the lead holds. Two things this does not mean: early in the market both sides trade near 0.50, so buying either is a plain directional bet that only `leadHeldRate` and the movement evidence can justify, not a cheap option; and a set that costs 1.00 or more earns nothing at all. The trailing side is a tail worth holding as an option only when `tailAsk` is a few cents (about 0.05 or less), i.e. when the market already treats the outcome as decided.",
    {
      BUY_UP: "Buy UP: as the likely winner, or as the cheap trailing side to hold as a reversal option and pair later.",
      BUY_DOWN: "Buy DOWN: as the likely winner, or as the cheap trailing side to hold as a reversal option and pair later.",
      BUY_PAIR: "Buy both outcomes together as a complete set, only when the set costs at most 1.00.",
      ADD_COMPLEMENT:
        "Hold unpaired shares and buy the opposite outcome now, at no more than hedgePriceCap, to lock the pair in while the leader is still offered.",
      HOLD: "Keep the current position and open orders unchanged.",
      CANCEL: "Withdraw resting orders without opening anything new.",
      ABSTAIN:
        "Take no position: the state is unclear, stale, or not worth the risk.",
    },
  ),

  settlement_direction: choice(
    "At settlement, will the market resolve UP or DOWN? The settlement price is the 60-second Chainlink TWAP of BTC/USD (`settlementCurrentPrice`), compared with its value at the start of the window (`settlementStartPrice`). `spotPrice` leads the TWAP; `spotVsTwapBps` shows where the TWAP is being pulled in the seconds remaining. `leadHeldRate` is measured, not guessed: in the recorded markets, the fraction of the time a lead of this size with this much time left was still the winning side at settlement (`leadHeldSamples` observations; null when too few). Anchor on it: with no further evidence, the probability of the leading side IS `leadHeldRate`, and the rest is UNRESOLVED or the other side. Move away from the anchor only as far as the momentum and spot-vs-TWAP evidence justifies. Recorded answers of 0.95 and above for a lead of 1-2 bps with minutes left were right little more than half the time; do not repeat that.",
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
      PAIR: "Match unpaired shares by buying the opposite outcome at no more than hedgePriceCap, so the set cost nothing.",
      MERGE: "Convert matched shares back into collateral now: every merged pair returns exactly 1.00.",
      REDUCE_RISK: "Cut exposure: the downside under one outcome is too large.",
    },
  ),

  // Whether to trade is the `action` question's job. This one only says
  // HOW an order should reach the book. It used to offer DO_NOT_TRADE as a
  // fifth option; being the one "no" against four flavours of "yes" it won
  // the plurality on every single buy signal (236 of 236 recorded), so no
  // order was ever built. A judgment cannot see the other answers, so the
  // veto must not live here.
  execution_urgency: choice(
    "If the chosen action places an order, how should it reach the book? Answer as if the order will be sent; whether to send one at all is decided by the action question, not here.",
    {
      PASSIVE: "Rest on the book and wait for the market to come to the order.",
      NORMAL: "A limit order at a controlled price; some waiting is acceptable.",
      URGENT: "Cross the spread if needed; the opportunity is decaying.",
      IMMEDIATE:
        "Fill now or not at all; waiting destroys the value of the trade.",
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
