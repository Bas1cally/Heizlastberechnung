# Dependencies

Every version below was resolved against the npm registry and installed, not
recalled. Every API claim was read from the installed package's type
declarations or compiled output. Nothing here is from memory.

Verified on 2026-09-19.

## Pinned versions

Exact versions, no ranges, so a reinstall cannot change behaviour silently.

| Package | Version | Role |
| --- | --- | --- |
| `@polymarket/client` | 0.10.0 | Polymarket TypeScript client (the current unified SDK) |
| `@typesafe-ai/sdk` | 0.6.0 | System One / Jev client |
| `viem` | 2.56.8 | Direct Polygon interaction |
| `ws` | 8.21.3 | WebSocket transport |
| `zod` | 4.6.5 | Runtime validation (also the client's own dependency, `^4.3.6`) |
| `typescript` | 7.0.2 | Compiler |
| `vitest` | 5.0.1 | Tests |
| `tsx` | 4.23.13 | Running TypeScript entrypoints |
| `@types/node` | 26.6.2 | |
| `@types/ws` | 8.18.1 | |

Package manager: `pnpm@10.33.0`, declared in `packageManager`.

## Node.js 24 is required

`@polymarket/client@0.10.0` declares `engines.node: ">=24"`. This is not
advisory — it is the floor for the whole project, and `engines.node` here is
set to `>=24` to match.

`.npmrc` sets `engine-strict=false` so the repository can still be typechecked
and unit-tested on Node 22, which is what the environment these files were
written in provides. **Running the bot needs Node 24.** Check with
`node --version` before `pnpm bot:observe`.

## Why not `better-sqlite3`

Node 24 ships `node:sqlite` in core. Since Node 24 is already the floor, the
native dependency buys nothing and costs a compiler toolchain on every machine
that clones this repo. Persistence targets `node:sqlite` behind the repository
interfaces in `src/persistence/`, so PostgreSQL remains a later swap.

## Which Polymarket package

- **`@polymarket/client@0.10.0`** — used. Repository
  `github.com/Polymarket/ts-sdk`, MIT. Depends on `@polymarket/bindings@0.10.0`
  and `@polymarket/types@0.2.0`, both pulled in transitively.
- **`@polymarket/clob-client@5.8.1`** — *not* used. This is the older
  standalone CLOB client the project brief rules out.
- `@polymarket/sdk@8.0.1` is the proxy-wallet helper, a different concern.

## Verified API surface

Read from the installed declarations, with the file each claim came from.

**WebSocket market data** — `@polymarket/bindings/dist/subscriptions/index.d.ts`

Subscription topics are `market`, `user` and `comments`. The `market` topic
carries a `book` event whose payload (after the schema's transform) is
camelCased:

```
conditionId, market, assetId, tokenId,
bids[{price, size}], asks[{price, size}],
minOrderSize, tickSize, negRisk, lastTradePrice,
hash?, timestamp?
```

`price` and `size` arrive as decimal **strings**, not numbers. They are parsed
once at the feed boundary; nothing downstream sees a string price.

**Order types** — all four required by the brief exist: `GTC`, `GTD`, `FAK`,
`FOK`.

**CTF operations** — `@polymarket/client/dist/index.d.ts` exports call builders
for the merge and redeem paths the inventory engine needs:

```
ctfSplitPositionCall, ctfMergePositionsCall, ctfRedeemPositionsCall,
routerSplitCall, routerMergeCall, routerRedeemCall,
erc20ApprovalCall, erc1155ApprovalForAllCall
```

Each returns a `TransactionCall`; signing and submission stay with viem.

**Market discovery** — `@polymarket/bindings/dist/gamma/index.d.ts` exposes
`slug`, `conditionId`, `clobTokenIds`, `startDate`, `endDate`, `active`,
`closed`, `negRisk`, `seriesSlug`, `gameStartTime`. That is enough to find the
current BTC 5-minute market and map it to its two token ids.

**Jev** — `@typesafe-ai/sdk@0.6.0`, confirmed against a live response:

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
```

Answers are `{type:"noul", noul}`, `{type:"choice", choice, confidence,
probabilities}`, `{type:"score", score, confidence, legend, probabilities}`,
wrapped in `{model, answers, usage}`. A score is a number and may fall between
rubric levels. Two models were listed on the account: `jev-latest` and
`jev-preview`; `jev-latest` resolved to `jev-1.13.0`.

## Not verified here

The build environment's egress policy refuses `clob.polymarket.com`,
`gamma-api.polymarket.com`, `ws-subscriptions-clob.polymarket.com`,
`data-api.polymarket.com`, `polygon-rpc.com` and `api.typesafe.ai` — every
one returns a 403 to CONNECT. The npm registry is reachable, which is how the
SDKs above were inspected.

Consequences, stated plainly:

- Request and response **shapes** come from shipped type declarations and are
  trustworthy.
- **Live behaviour** — actual WS framing, reconnect semantics, rate limits,
  order ACK timing, real latency — is unverified here and must be confirmed on
  a machine with network access before any mode beyond `observe` is trusted.
- Unit tests cover the deterministic maths and run anywhere. Integration tests
  against live endpoints must be run by the operator.
