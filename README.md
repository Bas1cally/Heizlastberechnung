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
| 51 unit tests | `pnpm test` |

| Next | |
| --- | --- |
| Market discovery, orderbook WS, settlement feed | `src/feeds/`, `src/market/` |
| Feature engine wiring, `pnpm bot:observe` | `scripts/observe.ts` |
| Persistence and decision audit | `src/persistence/` |
| Replay, paper fills, calibration | `src/replay/`, `src/analytics/` |

## Requirements

**Node.js 24 or newer.** `@polymarket/client@0.10.0` requires it. Check with
`node --version` first — this is the most likely reason a fresh clone fails.

```bash
pnpm install
cp .env.example .env    # fill in TYPESAFE_API_KEY
pnpm test
```

## Documentation

- `docs/DEPENDENCIES.md` — pinned versions, which APIs were verified from
  shipped type declarations, and what could not be verified.
- `docs/ARCHITECTURE.md` — data path, state versioning, when Jev is called.
- `docs/JEV_DECISIONS.md` — question design, the renormalisation trap,
  calibration.
- `docs/RISK.md` — limit order of evaluation, defaults, kill switch.
