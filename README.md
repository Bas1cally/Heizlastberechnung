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
| `pnpm discover`, `pnpm bot:observe` | `scripts/` |
| 100+ unit tests, no network needed | `pnpm test` |

| Next | |
| --- | --- |
| Confirm discovery pattern and WS semantics on a live run | `pnpm discover`, `pnpm bot:observe` |
| Jev benchmark (`scripts/benchmark-jev.ts`) | latency + stability over recorded states |
| Replay engine, paper fill model, calibration reports | `src/replay/`, `src/analytics/` |

## Requirements

**Node.js 24 or newer.** `@polymarket/client@0.10.0` requires it. Check with
`node --version` first — this is the most likely reason a fresh clone fails.

```bash
pnpm install
cp .env.example .env    # fill in TYPESAFE_API_KEY
pnpm test               # unit tests, no network
pnpm discover           # what Gamma returns for the discovery query - confirm slug/labels
pnpm bot:observe        # Phase 1 observer; never submits an order
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
