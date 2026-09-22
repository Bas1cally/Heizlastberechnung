# Risk

## The gate can only reject

`src/risk/risk-gate.ts` returns `APPROVED` or `REJECTED` with a reason. It
cannot originate a trade and cannot turn a rejected decision into a different
one. That asymmetry is the whole point: Jev owns intent, the gate owns safety.

## Order of checks

1. `HOLD` and `ABSTAIN` pass immediately; they create no order, so nothing
   below applies to them.
2. Error streak, daily loss.
3. Freshness: Chainlink age, orderbook age, Jev latency. Applies to `CANCEL`
   too — a state that cannot be trusted cannot justify any action.
4. `CANCEL` passes here — withdrawing an order reduces risk, so neither
   staleness nor exposure limits block it.
5. **`STALE_DECISION`** — a decision made on an older *material* version
   never reaches the book. Mandatory before order creation and before every
   trading limit. Observed live: ~33% of buy decisions were stale at ~300 ms
   Jev latency, which is a property of the market, not a bug.
6. `LIVE_TRADING_DISABLED` — the default. Every buy is rejected unless live
   trading is explicitly on.
7. Time to close, liquidity, spread, order size, open orders, then the three
   exposure limits.

## Measured edge (added 2026-09-21)

`NO_MEASURED_EDGE`: a directional buy (`BUY_UP` / `BUY_DOWN` that does not
complete a set against unpaired inventory) is refused when its ask is not at
least `minMeasuredEdge` (default 0.02) under the measured probability of
that side winning, taken from the hold-rate table for the current lead and
time left. The first paper hours showed Jev paying 0.45 for sides the
recordings put at 40%: the gate now says no to that, whatever the
judgment's confidence. Hedges need no edge (a set at or under 1.00 costs
nothing); opening a set outright needs it to cost at most 0.99. Without a
measurement for the bucket the rule does not apply.

The required edge is `max(minMeasuredEdge, 2 * sqrt(p(1-p)/n))`, n being
the markets behind the measurement: a hold rate of 0.55 from 70 markets
is 0.55 +- 0.12, and an "edge" inside that is the table's noise, not a
mispricing. Added after the first paper hour under the rule: nine markets,
-171 USD, all of it early directional buys at 0.40-0.45 against measured
rates of 0.55-0.60 from a few dozen samples.

The measurement is taken from the cell that matches the lead, the time
left AND whether spot is on the leader's side of the TWAP (added
2026-09-22): the TWAP lags spot by up to a minute, and a marginal over
"spot still extending the lead" and "spot already back across" is what the
market's own price knows better.

A tail at or under `maxFreeTailPrice` (0.05) is exempt: its downside is
its price, held by the unpaired-exposure limit, and the hedge that makes it
free is a bid resting at 1.00 minus the tail, not something that has to be
on the book at the moment of the buy (late in a market the leader has no
ask at all; the reference trader's hedges were maker fills, 39 of 40
checked).

## Defaults

In `src/risk/limits.ts`, deliberately small: 100 USD per market, 250 total,
50 unpaired, 100 shares per order, 4 open orders, 50 USD daily loss, 3
consecutive errors, 2 s Chainlink age, 1 s book age, 2 s minimum remaining,
50 shares minimum liquidity, 0.05 maximum spread, 750 ms maximum Jev latency.

Phase 1 never trades, so these only have to be safe, not optimal.

## Live trading is doubly gated

`ENABLE_LIVE_TRADING=true` **and** `--mode live`. Either missing and submission
is impossible. Completing a phase never auto-enables anything.

## Limited live (Phase 5, approved 2026-09-21)

`scripts/live.ts` (`pnpm auto -- live`) runs the same pipeline as paper with
`src/execution/live-engine.ts` in place of the simulation. What it does and
does not do:

- Runs under `liveLimits`: the simulation limits capped by `LIVE_*` (default
  5 shares per order, 10 USD per market, 20 USD in total, 10 USD unpaired,
  10 USD daily loss). The daily-loss limit reads today's realised live PnL.
- Signs and posts through the SDK; a rejected post is a recorded
  `REJECTED:<code>` order, never retried. "Not filled" codes are the
  market's answer; every other rejection or transport error counts toward
  the `POLYMARKET_API_ERRORS` kill reason.
- Resting orders are polled every second and cancelled at their TTL, at
  the close, on kill, on shutdown, and on a Jev `CANCEL`.
- Merges `min(up, down)` through the gasless relayer when Jev's inventory
  intent says MERGE; redeems the winner after the official resolution (the
  bot polls the resolution API between markets); both write the
  transaction hash.
- Every 30 s the position is compared with the exchange's positions API; a
  mismatch is `INVENTORY_MISMATCH`, a hard kill.
- Never sells. Nothing here can "get flat" at market; a wrong position is
  held to settlement and reported.
- Trading approvals (collateral / conditional-token allowances) are checked
  at start and set up once if missing.

## Kill switch

`src/risk/kill-switch.ts`, evaluated by the observer on every event.

**Transient reasons** latch while the condition holds and clear on their own
after 30 s of health: Chainlink stale (>10 s), market WS stale (>10 s), clock
drift beyond tolerance, Jev unavailable / timeout / invalid (5 consecutive),
Polymarket API errors (10 in 60 s). Without self-clearing, a three-second
socket hiccup would end an overnight run.

**Hard reasons** stay tripped until an operator resumes: daily loss reached,
inventory reconciliation mismatch, wallet balance mismatch, unexpected token
ids, order ACK inconsistency, unknown settlement configuration, manual kill.

While tripped, every decision that would create an order is recorded as
`REJECTED (KILL_SWITCH)`; HOLD and ABSTAIN pass. On trip the bot cancels
resting orders and reconciles (the `onKill` hook), persists the state to the
`control` table and the errors table, and logs. **It never liquidates at
arbitrary prices** — an unpaired position is held, not dumped into a book
that may be the reason the switch fired.

Operator control goes through the database, so it works from another
process: the dashboard's KILL / Resume buttons, or `pnpm kill` / `pnpm
resume`. The bot polls the control table once a second. Only a row whose
reasons include `MANUAL` is treated as an operator command: the bot writes
its own trips into the same row, and reading those back as manual would turn
every self-clearing trip into a hard one (a bug found by the Jev-failure
integration test, fixed in `observer.ts`).

## Known residual risks

- **Latency is unmeasured in production conditions.** A Jev call was observed
  at 91 ms on a normal connection. The decision-to-ACK path has not been
  measured end to end; whether an edge survives it is the question shadow mode
  exists to answer.
- **Calibration is unknown** until the replay and calibration reports exist.
- **The live SDK behaviour is unverified** — see `docs/DEPENDENCIES.md`.

## Shadow mode and the private key

Shadow mode needs `POLYMARKET_PRIVATE_KEY` because it signs real orders. It
cannot submit them: the signer is built from `createLimitOrder` and
`createMarketOrder` alone and never sees `postOrder`. `pnpm bot:shadow`
refuses `--mode live`. Live mode does not exist yet.
