# Architecture

## One source of trade intent

Jev decides *what to do*. Everything else is infrastructure. No other component
may originate a trade: no second model, no classifier, no threshold rule such
as "if TWAP > X then buy UP". The risk gate is the only component that can
overrule Jev, and it can only ever say no.

```
Chainlink / settlement feed ─┐
                             ├─> Market State ──> Feature Engine ──> JEV
Polymarket orderbook WS ─────┘        ^                               │
                                      │                               v
                                 Inventory <── Execution <── Risk Gate
```

Inventory feeds back into the state, so the next decision sees the position the
last one created. This system is stateful; a trade is never an isolated
prediction.

## What is computed before Jev is called

Everything that is arithmetic. Jev receives a clean snapshot and interprets it;
it never reconstructs basic maths from raw ticks.

| Computed deterministically | Module |
| --- | --- |
| Depth-weighted executable price | `features/orderbook.ts` |
| Complete-set cost, pair edge | `features/pair-cost.ts` |
| Returns, realised volatility | `features/returns.ts`, `features/volatility.ts` |
| Pairing, cost basis, pnl under both outcomes | `inventory/accounting.ts` |
| Probability-vs-price edge | `analytics/edge-analysis.ts` |

## State versioning

Every market state carries a monotonic `stateVersion: bigint`. Every decision
records the version it was made on. Before an order is created:

```
decisionStateVersion !== currentStateVersion  ->  REJECT("STALE_DECISION")
```

This is checked first in `risk/risk-gate.ts`, before any other limit, because
an out-of-date decision must not reach the book however good it looked. Three
in-flight requests can return out of order; only the newest state is ever
actionable.

## When Jev is called

Not on every WebSocket frame. On a material change: settlement value moves,
best bid or ask changes, pair cost changes, inventory changes, a fill arrives,
the remaining-time bucket changes, volatility regime shifts, a resting order
goes stale. Bursts within a few milliseconds are coalesced into one request
carrying the newest snapshot, and superseded in-flight requests are aborted.

## Modes

`observe` (default) computes and logs, places nothing. `paper` simulates fills
against live books including partial fills and queue uncertainty. `shadow`
builds and signs real orders and stops before submission. `live` requires both
`ENABLE_LIVE_TRADING=true` and `--mode live`; either one missing makes
submission impossible.

## Reading order

`docs/DEPENDENCIES.md` first — it records which SDK APIs were verified and
which were not. Then `docs/JEV_DECISIONS.md` for the question design, and
`docs/RISK.md` for the limits and kill switch.
