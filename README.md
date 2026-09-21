# jev-btc-5m

Research system for binary BTC 5-minute prediction markets, built on one rule:
**Jev is the only component allowed to generate trade intent.** Everything else
is infrastructure — data, maths, state, safety, signing, accounting.

Live execution is disabled by default and cannot be enabled by accident.

## Status

Phase 1 groundwork. **No order path exists yet, in any mode.**

| Done | |
| --- | --- |
| SDK verification and pinned versions | `docs/DEPENDENCIES.md` |
| Complete-set economics at real depth | `src/features/pair-cost.ts` |
| Inventory accounting under both outcomes | `src/inventory/accounting.ts` |
| Probability-vs-price edge | `src/analytics/edge-analysis.ts` |
| Jev question set | `src/jev/questions.ts` |
| Hard risk gate incl. state-version staleness | `src/risk/risk-gate.ts` |
| Market discovery (Gamma), book + Chainlink feeds with reconnect | `src/market/`, `src/feeds/` |
| Versioned market state, feature engine, Jev state builder | `src/market/market-state.ts`, `src/jev/state-builder.ts` |
| Decision engine: coalescing, abort of superseded requests | `src/jev/decision-engine.ts` |
| SQLite audit trail (`node:sqlite`), Jev response cache, latency stages | `src/persistence/` |
| Phase 1 observer, confirmed live: 595 decisions / 3 markets / 0 errors | `scripts/observe.ts` |
| Calibration by confidence and time, naive edge by time and price | `src/analytics/calibration.ts`, `pnpm calibrate` |
| Causal replay with Jev response cache (`--fresh-jev` to bypass) | `src/replay/`, `pnpm replay` |
| 140+ unit tests, no network needed | `pnpm test` |

| Paper trading: order mechanics, fills with latency and queue draw, merge, settlement | `src/replay/paper-engine.ts`, `pnpm bot:paper` |

| Shadow execution: real signing, no submission, book movement to hypothetical ACK | `src/execution/shadow-engine.ts`, `pnpm bot:shadow` |

| Next | |
| --- | --- |
| Real execution, cancel management and merge/redeem adapters, behind `ENABLE_LIVE_TRADING` + `--mode live` | `src/execution/`, `src/inventory/` |
| Kill switch wiring (feed staleness, reconciliation, daily loss) | `src/risk/kill-switch.ts` |

## Requirements

**Node.js 24 or newer.** `@polymarket/client@0.10.0` requires it. Check with
`node --version` first — this is the most likely reason a fresh clone fails.

```bash
pnpm install
cp .env.example .env    # fill in TYPESAFE_API_KEY
pnpm test               # unit tests, no network
pnpm discover           # the current and next 5-minute market as Gamma returns them
pnpm probe              # 20 s of raw feed events, unfiltered
pnpm bot:observe        # Phase 1 observer; never submits an order
pnpm report             # what the observer recorded
pnpm calibrate          # calibration + naive edge reports from recorded outcomes
pnpm replay             # causal replay of recorded markets (cached Jev answers)
pnpm bot:paper          # paper trading over recorded markets -> reports/backtest-summary.json
pnpm bot:shadow         # live path incl. signing, stops before submission (needs POLYMARKET_PRIVATE_KEY)
pnpm benchmark:jev      # latency + stability over recorded states
```

`LOG_LEVEL=debug` for verbose JSON logs. Decisions, ticks, books and latency
land in `data/bot.sqlite` (override with `DATABASE_URL`).

## Documentation

- `docs/DEPENDENCIES.md` — pinned versions, which APIs were verified from
  shipped type declarations, and what could not be verified.
- `docs/ARCHITECTURE.md` — data path, state versioning, when Jev is called.
- `docs/JEV_DECISIONS.md` — question design, the renormalisation trap,
  calibration.
- `docs/RISK.md` — limit order of evaluation, defaults, kill switch.
