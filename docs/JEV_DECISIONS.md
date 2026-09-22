# Jev decisions

The question set lives in `src/jev/questions.ts`. All questions go out in one
request: they are independent judgments over the same state and cannot see one
another's answers, so splitting them would only add round trips.

## Primitive choice

| Question | Primitive | Why |
| --- | --- | --- |
| `action` | choice | Seven alternatives, not a scale |
| `settlement_direction` | choice | UP / DOWN / UNRESOLVED |
| `market_mispricing` | choice | Categorical |
| `inventory_action` | choice | Categorical |
| `execution_urgency` | choice | `DO_NOT_TRADE` is not a point on the urgency axis |
| `winner_confidence` | **score** | Ordered rubric |
| `reversal_risk` | **score** | Ordered rubric |
| `adverse_selection_risk` | **score** | Ordered rubric |

The brief lists the last three as label sets. They are sent as `score` instead,
because `VERY_LOW…VERY_HIGH` is a described dimension: as a `choice` the model
is told those labels are unrelated categories, which discards the ordering that
makes a threshold meaningful. A score also returns an expected value that may
fall between levels, which is what a threshold should read.

**To change this back**, swap the three `score(...)` calls for `choice(...)`
with the same labels. Nothing else depends on the primitive.

## Do not compare a three-way probability with a two-way price

`settlement_direction` has three outcomes; the UP token's price is a
probability over two. Using `probabilities.UP` directly against the price
compares different denominators — `UNRESOLVED` holds mass the market cannot
price, so every edge is biased downward by exactly that mass, worst early in
the market when `UNRESOLVED` is largest.

`analytics/edge-analysis.ts` renormalises over UP and DOWN and returns
`unresolvedMass` alongside, so a caller can stand down when the answer is
mostly "too early to call": a renormalised 0.5/0.5 from `0.02/0.02/0.96` is
arithmetically fine and strategically meaningless.

## Persist the whole distribution

Every decision stores the full `probabilities` map, not the top label. The
calibration work needs the distribution; a stored argmax cannot be
reconstructed into one.

## Calibration is the test that matters

Directional accuracy is not enough. For each bucket (50–60, 60–70, 70–80,
80–90, 90–95, 95–97.5, 97.5–99, 99+) record predicted probability, observed
frequency, sample size, Brier score and calibration error. A `P(UP) = 0.99`
that resolves UP 90% of the time is a losing strategy at those prices however
often it is "right".

Confidence on a choice or score summarises how concentrated the distribution
is. It is not a statement that the workflow is correct, and not permission to
act.

## Cost

Output tokens track the number of questions; input tokens track the state and
**the criteria text**, which is re-sent on every single request. Verbose rubric
descriptions are therefore a recurring cost, not a one-off. Measured on this
account: 1 short question ≈ 281 in / 23 out; 4 questions with full criteria ≈
609 in / 103 out.

## Benchmark (brief §13), measured 2026-09-21

`pnpm benchmark:jev -- --n 300 --repeat 10` on 300 recorded market states,
concurrency 4, model `jev-latest`:

| requests | success | p50 | p75 | p90 | p95 | p99 | max | throughput |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 300 | 300 (100%) | 279 ms | 296 ms | 315 ms | 338 ms | 686 ms | 752 ms | 13.8 req/s |

Stability on one state repeated 10 times: action HOLD 10/10, P(UP) variance
0, confidence variance 0.0013. Jev is deterministic enough that the input
hash cache is a faithful stand-in for a repeated call.

In the live observer the same model measured p50 330 ms, p95 633 ms and 26%
of calls above 500 ms over 4831 calls: the benchmark's parallel, back-to-back
requests are faster than the observer's one-at-a-time calls under real
network conditions. Both numbers matter; the observer's is the one that
decides staleness.

## First calibration read (2.2 h, 25 markets), and why it is not yet a read on Jev

With official outcomes, Jev's favoured side at the last decision was right in
18 of 25 markets. Every one of the 7 misses is a market whose start price
the observer took 15 s or more after the open (previous market's grace
period plus discovery), so the distance Jev saw was measured from the wrong
anchor. Calibration on those recordings measures our start price, not Jev.
`pnpm calibrate` therefore reports a separate table over markets whose
start came from the process-level tape; only that table is a statement
about Jev.

## Why no order was ever built (found 2026-09-21, 236 buy signals)

Every `BUY_*` answer came with `execution_urgency = DO_NOT_TRADE`, at
38-53% of the mass, never a majority. The five-way choice had one "no"
against four flavours of "yes": PASSIVE, NORMAL, URGENT and IMMEDIATE split
the "send it" mass four ways, so the single "do not send" won the plurality
every time, and `styleFor` turned every approved buy into no order.

The questions are independent judgments that cannot see one another, so a
veto in the urgency question is a second, uninformed vote on the action.
`DO_NOT_TRADE` is gone from the question (the type keeps the value so
recorded answers still parse); the urgency question now asks only how an
order should reach the book, given that the action question decided to
send one.

## Anchoring on the measured hold rate

With the start price fixed, over 13 markets and 3067 decisions Jev still
answered 0.95-0.99 for leads that the measured hold-rate table puts at
60-68% with minutes left; observed accuracy in those buckets was 47-68%.
The settlement question now tells Jev to anchor on `leadHeldRate` and move
only as far as the momentum and spot-vs-TWAP evidence justifies. Whether
that is enough is measured, not assumed: `pnpm calibrate` reports the
clean-subset calibration separately for markets after this change.

## The pattern as measured on wallet 0x55aeeb3e (Animal00), 14-21 Sep 2026

39,886 activity rows, 2,074 BTC 5-minute markets (every market), 37,849
buys, 1,534 merges, 259 redemptions, no sells. Per market, in this order:

1. 40-110 s before the close: ~1,000 shares of the *trailing* side at 0.01
   (10 USD).
2. 10-50 s before the close, sometimes after it: ~1,000 shares of the
   *leading* side at 0.99 (990 USD).
3. Merge 1,000 sets: 1,000 USD back. Net 0.00 to -0.11.

The set costs exactly 1.00, so the hedge is a free exit and the tail is a
free option on a reversal between step 1 and step 2. What it costs: tails
that could not be hedged because the leader's ask side had emptied (-10 USD
each). Net over 1,581 settled markets: +3,992 USD, +2.52 per market on
about 1,000 USD of working capital. **Wrong: see the correction of
22 Sep below; the true eight-day net is about -672 USD.**

The brief's description (accumulate the winner at 0.98-0.995, then add a
cheap complement, merge, retain excess winner) had the order reversed and
the economics wrong: the profit is not a percent on the winner, it is the
reversal option paid for by a hedge that costs nothing.

What changed in the bot: the order builder never pays more than 1.00 for a
set (`maxPairCost`) and caps a hedge at `1.00 - tail entry`, resting a GTC
at the cap when the leader asks more; the state carries `leader`,
`leaderAsk`, `leaderAskDepth`, `tailAsk`, `tailAskDepth`, `hedgePriceCap`
and `hedgeAvailable`; the action question explains the economics. Jev still
chooses when to buy the tail and when to hedge; nothing here is a rule.

## How the hedge really fills (measured 2026-09-21, first benchmark market)

The first benchmark market showed the copy holding for its whole window:
the tail was 0.01 from 65 s before the close, but the leader's ask side was
empty (recorded as 1.00 with depth 0) from the same moment, and the copy
only bought a tail with a hedge lifted at once. Cross-checking the
trader's 40 most recent 0.99 buys against our book snapshots at the same
second: 39 printed while that side had **no ask at all**. His hedge is a
bid resting at 0.99, filled in pieces (5, 10, 100, 307 shares) by holders
of the leader selling out. The 0.99 bid queue on that side grew from 8.7k
to 90k shares over the last 80 s of the market; price-time priority is
what decides whether such a bid fills before the close.

By tail timing (1,581 settled markets), hedge rate and net:

| tail bought | markets | hedged | net USD |
| --- | --- | --- | --- |
| 0-30 s before close | 289 | 74% | +604 |
| 30-60 s | 655 | 74% | +1,120 |
| 60-90 s | 557 | 75% | -1,160 |
| 90-120 s | 331 | 81% | -179 |
| 120-180 s | 225 | 85% | -505 |

The net difference between the buckets is a handful of large reversal
wins; the hedge rate barely moves. Not a rule; a reason to keep the window
as measured (median 64 s) and let the comparison decide.

First paper hour under the measured-edge gate (19:10-20:07Z): 15 settled
markets, -171 USD net; every loss an early (220-290 s left) directional buy
at 0.40-0.45 against a measured rate of 0.55-0.60 built from 60-80
markets, which is within the noise of that measurement. The gate now
requires the edge to clear two standard errors of the estimate
(docs/RISK.md). Jev's early calls stay recorded and calibrated either way;
paper-trading them was adding noise, not evidence.

Also found: two of the three runners never restarted onto the new commit,
because the update check compared the remote with the checkout's HEAD,
which the third runner's `pnpm auto` had already pulled. The check now
remembers the commit each process started on. And one runner's TWAP stream
went silent for a whole market without an error; the Chainlink feed now
closes and resubscribes a stream that is silent for 15 s.

What changed: the market channel's `last_trade_price` events are recorded
(`trades` table) and the paper engine fills a resting bid as a maker,
behind the bids that were at its price or better when it was placed, from
taker sells at or through its price. The order builder prices a capped
leg against an empty ask side as a bid at the cap; a hedge rests until the
close instead of 20 s (re-placing it would forfeit its queue position);
the Jev state carries `openOrders`; the measured-edge exemption for a tail
no longer requires the hedge to be offered at that moment. Whether the
taker-side assumption behind `side` holds is checked on the first synced
export: SELL prints at 0.99 on the leader in the last minute, and paper
hedges filling from them.

Night of 21/22 Sep, 22 markets of the copy with hedges placed: 2 hedge
fills. Two reasons, both measured against the trader's fills on the same
markets: (1) tails at 0.02 put the hedge at 0.98, a tick below the 0.99
level where every bid and every taker sell is; he pays 0.01 and bids 0.99
without exception, so the copy now takes tails at 0.01 only. (2) The paper
queue counted the bids in the first book after the latency as ahead of us;
the 0.99 level fills with thousands of shares within a second of the ask
emptying, so bids that came after ours were counted ahead. In one market
we bid at 0.99 six seconds before his tail with nobody at the level and
still "never filled" while he took 1,000 shares from 1,440 of sells. The
queue is now the book at decision time. Where the level already held 10k
when we decided, we are behind, and that is the honest measurement of a
copy with a one-second decision loop against his bot.

01:47Z, 20 more markets with tails at 0.01 and hedges at 0.99: the
trader hedged 15 of them, the copy 4 to 7. The flow that fills a 0.99
bid is not only sells of that token: Polymarket's CLOB matches a bid for
DOWN at 0.99 against a bid for UP at 0.01 by minting the set, so every
tail buyer fills a hedger. Measured after our placements: 26.5k shares of
same-side sells, 58.8k of complementary buys, his fills 14.6k. The paper
engine now counts both kinds of flow; the reference trader's fills are
the check for the next stretch.

Morning of 22 Sep, after 92 markets overnight (Jev -848 USD, copy -101 and
-99, the trader hedging 11-15 of 16 markets against the copy's 2-7):

- The hedge is placed the instant the tail fills, by the engine, when the
  decision's inventory intent is PAIR (`hedgeNow`): taken at once when the
  other side is offered under the cap, resting at 1.00 minus the fill price
  otherwise. Waiting for the next decision had put 10-25k shares ahead of
  the bid ("paper rest" logs the queue at placement).
- The copy buys one tail per market (the trader buys once; the copy had
  re-bought after every merge, up to six tails, six chances to lose one).
- The hold-rate cells are split by whether spot is on the leader's side
  of the TWAP. Jev's buys at 0.26-0.31 had passed the gate "under" a 0.40
  marginal that pooled both situations; the market's price already knew.
- One Chainlink socket per stream per process: the tape fans its ticks out
  to the observer (three runners had twelve subscriptions; one runner's
  streams went silent for whole markets while the others were fine).

## Correction: the reference trader is not profitable (2026-09-22, 06:50Z)

The "+3,992 USD over 1,580 settled markets" above was wrong. A market
counted as settled only when something came back (a merge or a
redemption) or when its outcome was known and every buy lost; outcomes
were known only for the markets we had recorded ourselves. A lost tail is
never redeemed and never merged, so about 500 of them, -4,314 USD, were
treated as "not settled yet" and left out. Recomputed from his raw
activity, per day (net = redemptions + merges - buys; maker rebates of
424 USD over the period not included):

| day | markets | unhedged tails | jackpots | net USD |
| --- | --- | --- | --- | --- |
| 09-14 | 157 | 15 | 3 | +775 |
| 09-15 | 288 | 55 | 0 | -997 |
| 09-16 | 297 | 59 | 0 | -710 |
| 09-17 | 287 | 68 | 2 | +719 |
| 09-18 | 288 | 88 | 2 | +611 |
| 09-19 | 263 | 66 | 0 | -3,409 |
| 09-20 | 288 | 67 | 1 | -6 |
| 09-21 | 288 | 84 | 2 | +585 |
| 09-22 (part) | 76 | 17 | 2 | +1,759 |
| total | 2,232 | 519 | 12 | **-672** |

By what he did in a market: tail hedged and merged, 1,652 markets, +1.74
each (+2,881); tail never hedged, 515 markets, -8.38 each (-4,314); tail
and hedge but no merge (the lead reversed after the hedge filled), 40
markets, -62 each (-2,463); the reversal jackpots, +3,185. He buys a
lottery ticket at 0.01 in every market and gets its price back in three
of four; the tickets he keeps pay off about once in a hundred markets;
over eight days that is a loss the size of his rebates. There is no edge
here to copy, and none for Jev to add to. The copy runs measure a
lottery.

## What the reference trader is actually doing (2026-09-22, 07:00Z)

The numbers only make sense as volume farming. Eight days: 1.2 million
USD of buys, every single 5-minute market around the clock, net cash -63
USD, maker rebates +424 USD. A tail at 0.01 plus a hedge at 0.99 merged
back to 1.00 is 1,000 USD of volume per market at a cost of zero when the
hedge fills, and three quarters of the time it does; the 0.99 bid is a
maker order, so the volume also earns rebates and whatever a future
Polymarket airdrop counts. The occasional reversal jackpot and the lost
tails are noise around that. The strategy is not a trading edge; it is
the cheapest known way to print maker volume. Nothing in it is a
judgment, so nothing in it is Jev's, and copying it only makes sense
with the same goal and the same colocation.

## The directional question, closed (2026-09-22)

302 directional fills by Jev between 21:45Z and 06:25Z, with the state at
each decision and the outcome:

| price bucket | fills | won | table said | market said |
| --- | --- | --- | --- | --- |
| ~0.1 | 36 | 0% | 21% | 7% |
| ~0.2 | 68 | 16% | 41% | 22% |
| ~0.3 | 110 | 25% | 48% | 31% |
| ~0.4 | 85 | 31% | 57% | 40% |
| all | 302 | 21.5% | 45.8% | 28.8% |

The market's price was the better estimate in every bucket; the hold-rate
table was off by 24 points; and the sides Jev picked did worse than the
price implied. Directional buys are off in the gate (docs/RISK.md).

Also from the same stretch: the copy's hedge, placed at the tail's fill,
still found 1,600 shares ahead of it (the tail's arrival takes the
latency, then the hedge goes out). It now goes out in the same instant as
the tail, from the decision's book, and is withdrawn or shrunk when the
tail's fill turns out smaller. And a tail intent the gate rejected used
to count as the market's one tail; the policies now count a tail when the
position or its order is seen.

## Jev where the judgment is (added 2026-09-22)

The overnight answer to §45 as originally framed is no: 92 markets, -848
USD, every loss a directional buy at 0.26-0.31 that the market priced
better than the hold-rate table. That framing put Jev in the seat of a
directional trader with a question set that rewards exactly that. The
sequence that made money has two judgments in it and nothing else:
whether to take the tail in this market, and whether to keep the hedge
bid while the lead reverses. `src/jev/policy-animal-jev.ts`
(`pnpm auto -- animaljev`, `data/animal-jev.sqlite`) is the copy's
skeleton with Jev asked ONE focused question at each of those moments:

- tail at 0.01 inside 180 s: TAKE_NOW / WAIT / SKIP;
- tail filled, hedge bid resting (placed by the engine the instant the
  tail filled): KEEP_BID / PULL_BID; once pulled: REBID / STAY_UNHEDGED;
  forced back with 8 s left.

The hedge placement is never Jev's: the 0.99 level fills within seconds of
opening and a judgment in that path can only lose the queue. Each answer
is recorded with its probabilities and latency (`answers_json.focused`);
the measurement is policy-animal-jev against policy-animal on the same
markets, and that difference is what Jev adds, nothing else.

## Benchmark: the mechanical copy runs beside Jev (added 2026-09-21)

`src/jev/policy-animal.ts` plays the measured pattern deterministically and
plugs in where Jev does (`pnpm auto -- animal`, `pnpm auto -- animalplus`).
Each runner has its own database (`data/animal.sqlite`,
`data/animal-plus.sqlite`), reads the hold-rate table from the main one, and
is exported by the Jev runner's sync as `reports/animal(-plus).sqlite.gz`.
The observer, gate, order builder, paper engine and analytics are the same
code; only the intent source differs, so the comparison is on identical
markets, identical books, identical fill model.

- `animal`: tail at <= 0.02 inside 110 s of the close; the hedge bid rests
  at 1.00 minus the tail at once, until it fills or the market closes;
  merge.
- `animal-plus`: the copy plus two measured changes. The hedge bid is
  pulled while spot is on the tail's side of the start price and more than
  12 s remain (his 21 large wins were tails that were *not* hedged when the
  reversal came). The tail is also taken earlier when `1 - leadHeldRate`
  exceeds its price by a cent (a 6% reversal rate is worth more than a
  0.02 tail).

What the comparison answers (§45): per market and per day, net PnL, tails
bought, hedges filled, sets merged, unhedged tails lost, reversal wins, for
`paper` (Jev), `animal` and `animal-plus` on the same markets. If Jev does
not beat the plain copy after the acceptance stretch, its timing adds
nothing measurable and the plain copy is the baseline any change must beat.
The policies are not strategy rules for the bot (§19): they are the
yardstick.
