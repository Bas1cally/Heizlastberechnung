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
