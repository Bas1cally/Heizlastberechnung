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

## State versioning: raw and material

Every mutation bumps `stateVersion` — on a live market that is ~1000 per
second, so no decision could ever match it. The version decisions are checked
against is `materialVersion`, which bumps only when the Jev-visible snapshot
changed materially (`jev/material-change.ts`): a quote moved, the pair cost or
executable size moved past a threshold, the settlement distance moved ≥0.5 bp,
the remaining-time bucket changed, inventory changed, data went stale or
recovered — or a heartbeat elapsed. Both versions are stored with every
decision.

```
decisionMaterialVersion !== currentMaterialVersion  ->  REJECT("STALE_DECISION")
```

Checked first in `risk/risk-gate.ts`, before any other limit. Three in-flight
requests can return out of order; only the newest material state is ever
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

## Replay

`pnpm replay` merges recorded Chainlink ticks and book snapshots into one
time-ordered stream and drives it through the same state store, feature
builder and material-change gate as the live observer. At recorded time t the
state holds only events received at or before t. Jev answers are looked up by
the SHA-256 of the canonical state in the source database's cache; `--jev`
calls Jev for states not cached, `--fresh-jev` ignores the cache. Replay output
goes to `data/replay.sqlite`, never into the live database.

Book snapshots are recorded at most every 500 ms per asset, so replay sees
quotes at that resolution. That is enough for calibration and for a paper fill
model that reasons about depth; it is not tick-accurate microstructure.

## Calibration

`pnpm calibrate` joins every decision to its market's outcome — the feed's
`market_resolved` event when present, otherwise derived from the recorded
ticks (first at or after open vs last before close, tie = UP) — and reports
predicted vs observed by confidence bucket and by time bucket, Brier score,
and a *naive* gross edge: buy Jev's favoured side at the executable ask on
every decision, no fees, fills or slippage. That number is an upper bound and
is labelled as such in the output.
