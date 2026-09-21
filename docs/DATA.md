# Data

What the bot records, where it comes from, how it is sampled, and what can
be rebuilt from it. Everything lives in one SQLite file (`DATABASE_URL`,
default `data/bot.sqlite`, WAL mode, `busy_timeout` 5 s so a dashboard and a
bot can share it). The schema is `src/persistence/schema.ts`; there are no
migrations yet, tables are created if missing.

## Sources

| Source | Transport | Used for | Recorded as |
| --- | --- | --- | --- |
| Gamma `listMarkets({ slug })` | HTTPS via `@polymarket/client` | discovering the current `btc-updown-5m-<unix>` market, token ids, tick size, min order size | `markets` |
| Market channel (`topic: market`) | SDK websocket | `book` snapshots, `price_change` deltas, `market_resolved` | `orderbook_snapshots`, `markets.resolved_outcome` |
| Chainlink spot (`prices.crypto.chainlink`, `btc/usd`) | SDK websocket, ~1 Hz | movement features (returns, realised vol), `spotVsTwapBps` | `ticks` with `source = 'chainlink'` |
| Chainlink 60 s TWAP (`prices.crypto.chainlink.twap`, `windowSeconds: 60`) | SDK websocket | **settlement quantity**: start price and current price, distance to strike | `ticks` with `source = 'chainlink-twap60'` |
| Jev / TypeSafe System One | HTTPS | the only source of trade intent | `jev_requests`, `jev_answers`, `jev_cache` |

Feed timestamps are milliseconds. Chainlink timestamps arrive rounded to the
second, so clock drift is measured from market-channel timestamps only, and
every row also carries `received_at_ms` (local wall clock at receipt).

The markets settle on the 60 s TWAP (`docs/DEPENDENCIES.md`), which lags
spot. Both are recorded so the lag itself is analysable.

## Tables

| Table | One row per | Written by | Notes |
| --- | --- | --- | --- |
| `markets` | market | discovery, resolution | timing comes from the slug; `resolved_outcome` is the feed's label (`Up`/`Down`) when a resolution event arrived |
| `ticks` | price update | observer | `source` distinguishes spot and TWAP |
| `orderbook_snapshots` | asset x 500 ms | observer | top 10 levels each side, always re-sorted (bids descending, asks ascending); the feed changes hundreds of times a second, one snapshot per asset per 500 ms is kept |
| `jev_requests` | Jev call | decision engine | full input state (`state_json`), `state_version` (material), `raw_state_version`, `material_reason`, tokens, latency |
| `jev_answers` | Jev call | risk gate | full answer distributions, requested action, verdict and reason |
| `jev_cache` | distinct input hash | decision engine | first answer per canonical state; replay uses it, `--fresh-jev` bypasses it |
| `latency_measurements` | decision | observer | stage breakdown on the monotonic clock; a stage that did not happen is NULL, never 0 |
| `orders`, `fills` | order / fill | paper, backtest, shadow, (live) | `mode` column separates simulated and real records; every order references its decision |
| `inventory_snapshots` | fill or merge | execution engines | full `InventoryAccounting` JSON, basis of unpaired-exposure duration |
| `merges`, `redemptions`, `pnl_snapshots` | merge / market settlement | execution engines | `tx_hash` NULL in simulation; `pnl_json` holds gross, merge, settlement, fees, gas, net |
| `shadow_orders` | signed-but-not-sent order | shadow engine | expected vs. hypothetical-ACK price, signing time |
| `control` | key | dashboard, CLI, bot | kill switch, resume, heartbeats (`heartbeat:<process>`) |
| `errors` | error | everything | component, message, market; discovery and feed failures land here instead of killing the process |

## Modes in one database

Execution records carry `mode`:

- `paper`: `pnpm bot:paper`, simulated against live books, main database.
- `backtest`: `pnpm backtest`, simulated over recorded books, written to
  `data/backtest.sqlite` so it can be deleted and regenerated at will.
- `live`: does not exist yet.

The dashboard and every report group by `mode`. Nothing adds simulated and
real money into one number.

## Outcomes

The feed's `market_resolved` label is authoritative. Without one (the event
often arrives after the observer has rolled to the next market), the outcome
is derived from the recorded TWAP stream: first tick at or after the open
vs. the last tick before the close, tie resolves UP. Reports say which of the
two they used (`source: "feed" | "derived"`). A recording without a TWAP
stream (before the settlement change) falls back to spot and is marked as
derived too.

## What can be rebuilt

- `pnpm replay`: the recorded ticks and books are replayed in receipt order
  through the same state store, feature engine, material-change gate and
  risk gate; Jev answers come from `jev_cache` by input hash. The same
  recording replayed twice yields byte-identical hashes and decisions
  (`tests/integration/replay-determinism.test.ts`).
- `pnpm backtest`: the same stream through the paper engine with a seeded
  queue draw, so two runs with the same seed give identical fills.
- `pnpm calibrate`, `pnpm analyze`: calibration, naive EV, §26 metrics,
  EV segmentation, Animal00 research and the latency report, all from the
  tables above. Outputs go to `reports/` (git-ignored).

## What is not recorded

- Every `price_change` delta: only the 500 ms snapshot cadence. A fill that
  would have happened inside that interval is invisible to the backtest.
- Trades on the exchange (`last_trade_price` events): not subscribed.
- Jev requests that were aborted because a newer state superseded them.
- Anything from a market whose discovery failed; the failure is in `errors`.

## Size

Observed: roughly 600 book rows and 600 tick rows per asset per 5-minute
market, one Jev row per material change (about 200 per market at current
settings). A day of observation is in the low hundreds of megabytes; vacuum
or archive `data/bot.sqlite` when it matters, with the bot stopped.
