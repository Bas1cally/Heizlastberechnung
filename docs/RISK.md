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

## Defaults

In `src/risk/limits.ts`, deliberately small: 100 USD per market, 250 total,
50 unpaired, 100 shares per order, 4 open orders, 50 USD daily loss, 3
consecutive errors, 2 s Chainlink age, 1 s book age, 2 s minimum remaining,
50 shares minimum liquidity, 0.05 maximum spread, 750 ms maximum Jev latency.

Phase 1 never trades, so these only have to be safe, not optimal.

## Live trading is doubly gated

`ENABLE_LIVE_TRADING=true` **and** `--mode live`. Either missing and submission
is impossible. Completing a phase never auto-enables anything.

## Kill switch

Stop new trading on: stale Chainlink, stale WS, clock drift, unknown settlement
configuration, Jev unavailable / timing out / returning something invalid,
Polymarket API errors over threshold, inventory mismatch, wallet balance
mismatch, unexpected token ids, order ACK inconsistency, daily loss reached,
manual kill.

On trigger: stop creating orders, cancel resting orders, reconcile positions,
persist state, log the reason. **Do not liquidate at arbitrary prices** — an
unpaired position is held, not dumped into a book that may be the reason the
switch fired.

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
