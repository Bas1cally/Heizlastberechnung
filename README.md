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
| Performance metrics beyond win rate, EV segmentation, Animal00 research, latency report | `src/analytics/metrics.ts`, `pnpm analyze` |
| Causal replay with Jev response cache (`--fresh-jev` to bypass) | `src/replay/`, `pnpm replay` |
| 200+ unit and integration tests, no network needed | `pnpm test` |

| Paper trading against live books: latency, resting orders, merge, settlement at the real outcome | `src/execution/paper-live-engine.ts`, `pnpm bot:paper` |
| Backtest over recorded books: same fill model, same mechanics | `src/replay/paper-engine.ts`, `pnpm backtest` |

| Shadow execution: real signing, no submission, book movement to hypothetical ACK | `src/execution/shadow-engine.ts`, `pnpm bot:shadow` |

| Kill switch: transient (self-clearing) and hard (operator resume) reasons, manual via dashboard/CLI | `src/risk/kill-switch.ts` |
| Dashboard: current market, last decision, feeds, latency, kill / resume | `pnpm dashboard` |

| Next | |
| --- | --- |
| Real execution, cancel management and merge/redeem adapters, behind `ENABLE_LIVE_TRADING` + `--mode live` — only after explicit approval (brief §40) | `src/execution/`, `src/inventory/` |

## Dashboard

`pnpm dashboard` serves a local page (127.0.0.1 only) for the operator, in
German: one status sentence, the current market with countdown, what Jev
thinks right now, feed health, Jev's P(Up) against the market's Up price over
the current market, the calibration grade, today's decisions and token spend,
the trading view (paper or live, never mixed), recent markets, messages, and
the emergency stop with a confirmation. Set `TYPESAFE_USD_PER_MTOKEN` in
`.env` to see an estimated daily cost. Polymarket fees on these markets were
observed to be zero (see `docs/DEPENDENCIES.md`); paper results assume that.

## Requirements

**Node.js 24 or newer.** `@polymarket/client@0.10.0` requires it. Check with
`node --version` first — this is the most likely reason a fresh clone fails.

```bash
pnpm install
cp .env.example .env    # fill in TYPESAFE_API_KEY
pnpm test               # unit tests, no network
pnpm discover           # the current and next 5-minute market as Gamma returns them
pnpm probe              # 20 s of raw feed events, unfiltered
pnpm auto               # run the paper bot unattended: pulls updates, restarts on new commits and after crashes (pnpm auto -- observe|shadow)
pnpm auto -- animal     # benchmark: the mechanical Animal00 copy in data/animal.sqlite (pnpm auto -- animalplus: with the measured improvements)
pnpm auto -- animaljev  # the copy as skeleton, Jev asked only at the two moments where a judgment exists (tail now/wait/skip; keep/pull the hedge bid)
pnpm scan               # consistency scan over all active markets: Jev judges the logical relation of candidate pairs, code checks the prices -> reports/consistency.{txt,json}
pnpm bot:observe        # Phase 1 observer; never submits an order
pnpm report             # what the observer recorded
pnpm calibrate          # calibration + naive edge reports from recorded outcomes
pnpm resolve            # backfill official outcomes from Polymarket's resolution API, cross-checked against the market's final price
pnpm acceptance         # Phase 1 acceptance (§36) PASS/FAIL/INSUFFICIENT per criterion -> reports/acceptance.json
pnpm summary            # report + acceptance + calibrate + analyze in one file (reports/summary.txt)
pnpm sync               # push reports, a compact DB export and log tails to the git branch `reports` (the bots run this every 15 min; --no-sync to skip)
pnpm analyze            # §26 metrics (ROC, PnL per fill / Jev call, unpaired time, maker/taker, cancel ratio, Jev cost), EV by distance/vol/confidence/action/pair cost, Animal00 research, reports/latency.json
pnpm replay             # causal replay of recorded markets (cached Jev answers)
pnpm bot:paper          # Phase 3: paper trading against LIVE books; simulated fills, real outcomes; never submits
pnpm backtest           # paper trading over RECORDED markets -> reports/backtest-summary.json
pnpm bot:shadow         # live path incl. signing, stops before submission (needs POLYMARKET_PRIVATE_KEY)
pnpm dashboard          # http://127.0.0.1:8787 - German operator view: status, current market, Jev vs market, calibration, trading, NOTAUS
pnpm kill / pnpm resume # operator kill switch from the command line
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
- `docs/DATA.md` — sources, tables, sampling, outcome derivation, what can
  be rebuilt from a recording and what is not recorded.
