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
