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

**Realtime client API** — `@polymarket/client/dist/types-*.d.ts`

`createPublicClient()` needs no credentials. `client.subscribe([...specs])`
returns `AsyncIterable<Event> & { close(): Promise<void> }`; the feeds
iterate it with `for await`. Specs used:

```
{ topic: 'market', assetIds: [...], customFeatureEnabled: true }
{ topic: 'prices.crypto.chainlink', symbols: ['btc/usd'] }
```

With `customFeatureEnabled` the market stream additionally emits
`best_bid_ask`, `new_market` and `market_resolved`. The realtime endpoints in
the compiled client are `wss://ws-subscriptions-clob.polymarket.com/ws/market`
and `wss://ws-live-data.polymarket.com`.

**Settlement price** — the `prices.crypto.chainlink` topic delivers
`{ symbol, timestamp (epoch ms), value (decimal string or number) }`. A
`prices.crypto.chainlink.twap` topic exists with `windowSeconds: 30 | 60`.
Observe mode therefore needs no Polygon RPC.

**Market discovery** — `client.listEvents({ titleSearch, tagSlug, slug,
closed, pageSize, order, ascending, ... })` returns `Paginated<Event[]>` with
`firstPage()` → `{ items, hasMore, nextCursor }`. A Gamma market carries `id`,
`conditionId`, `slug`, `question`, `outcomes: string[]`, `clobTokenIds`,
`startDate`/`endDate` (ISO), `active`, `closed`, `orderPriceMinTickSize`,
`orderMinSize`. `listMarkets` and `listSeries` exist with similar filters.

**CLOB order book (REST)** — `client.fetchOrderBook({ assetId })`. Its type
states: *bids ascending (lowest first), asks descending (highest first)* —
the reverse of walk order. `src/feeds/book-normalizer.ts` always re-sorts.

**WebSocket market data** — `@polymarket/bindings/dist/subscriptions/index.d.ts`

The `market` topic carries a `book` event whose payload (after the schema's
transform) is camelCased:

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

## Confirmed on a live run (2026-09-21, `pnpm discover`)

- **Slug pattern**: `btc-updown-5m-<unix seconds of window start>`, e.g.
  `btc-updown-5m-1766162100` = "December 19, 11:35AM-11:40AM ET". The
  current market is computed from the clock (`src/market/window.ts`) and
  fetched with `client.listMarkets({ slug: [slug] })`. A title search returns
  stale and unrelated markets (hourly candles, daily) and is not used.
- **Outcome shape**: `client.listMarkets` returns the *transformed* Market:
  `outcomes: { yes: { label: "Up", tokenId }, no: { label: "Down", tokenId } }`,
  `state: { active, closed, acceptingOrders, negRisk, startDate?, endDate? }`,
  `trading: { minimumOrderSize, minimumTickSize }`, `resolution: { source }`.
  The flat `clobTokenIds` / `outcomes: string[]` fields belong to the raw
  schema and are not present on this object.
- **Resolution rule** (from the market description): "resolve to Up if the
  Bitcoin price at the end of the time range is **greater than or equal to**
  the price at the beginning" — a tie resolves UP. The `settlement_direction`
  question states this.

## Assumptions that only the observer can confirm

- `book` is a full snapshot and `price_change` carries level deltas with
  `size: "0"` meaning removal. Standard CLOB semantics, matches the shapes.
- The settlement start price is the first Chainlink value seen at or after
  the window's open second. The description's full text names the exact
  source and timing; confirm on the first observed market.

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
