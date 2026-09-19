# typesafe-decisions

Support-triage example built on TypeSafe's System One API, using the official
`@typesafe-ai/sdk`. Code owns the workflow; the model supplies judgments where
ordinary code has no semantic understanding.

Fresh project — the repository previously held unrelated documents and its
GitHub name still reflects that. Nothing from it is used here.

## Quick start

```bash
npm install
cp .env.example .env     # fill in TYPESAFE_API_KEY
npm run check            # does the setup actually work?
```

`npm run check` is the one to run first. It tests three things in order, so a
failure points at exactly one of them:

1. a key is configured (no request made),
2. the API is reachable and the key is accepted (`models.list()` — costs no
   tokens),
3. a real judgment comes back (one noul — costs a few tokens).

```
  ok    API key is set
  ok    base URL https://api.typesafe.ai, default model jev-latest
  FAIL  reach and authenticate: The API was never reached.

This is not a credentials problem - the request did not complete, so the key
was never accepted or rejected. [...]
```

Then:

```bash
npm test                 # 26 tests, no network needed
npm run triage -- --dry-run
npm run triage           # sends the request
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/typesafe/env.ts` | Loads `.env` so the scripts work without shell setup |
| `src/check.ts` | The setup check described above |
| `src/typesafe/diagnose.ts` | Maps an SDK failure to a headline and a concrete next step |
| `src/typesafe/policy.ts` | Thresholds, weighting, and mapping a fractional score to its nearest rubric level |
| `src/example/triage.ts` | Four independent judgments over one support message, in a single request |
| `test/contract.test.ts` | Pins the API contract: endpoint, auth header, request and answer shapes |
| `test/policy.test.ts` | Threshold and weighting behaviour |
| `test/diagnose.test.ts` | That each failure mode reports the right cause |
| `test/env.test.ts` | `.env` parsing, including quotes and CRLF |

The client, question builders (`noul`, `choice`, `score`) and error types come
from the SDK; `src/index.ts` re-exports them next to the policy helpers so
application code has one import.

## The contract

Taken from the SDK's shipped type declarations and compiled client, pinned by
`test/contract.test.ts`, and **confirmed against a live response**: every field
below resolved as declared when the example ran for real.

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>

{ "model": "jev-latest", "state": …, "questions": { "<name>": { "type": …, … } } }
```

```jsonc
{
  "model": "jev-1",
  "answers": {
    "is_urgent":   { "type": "noul",   "noul": 0.87 },
    "topic":       { "type": "choice", "choice": "payouts", "confidence": 0.93,
                     "probabilities": { "payouts": 0.93, "other": 0.07 } },
    "frustration": { "type": "score",  "score": 1.6, "confidence": 0.55,
                     "legend": { "0": "calm", "1": "irritated", "2": "angry" },
                     "probabilities": { "0": 0.1, "1": 0.2, "2": 0.7 } }
  },
  "usage": { "input_tokens": 412, "output_tokens": 18 }
}
```

Three things that are easy to get wrong:

- **A noul answer is on `.noul`**, and it is the probability of yes — not a
  boolean and not an intensity. `0.5` means yes and no are about equally
  likely, which is why `policy.ts` routes that band to a human instead of
  picking a side.
- **A score is a number, not a label.** It is an expected value and may fall
  between rubric levels (`1.6` above), so use `.score` for ranking and
  thresholds and `nearestLevel()` only for display.
- **Score criteria are an ordered list**, indexed from zero, at least two
  entries. Choice criteria are labels mapped to descriptions (`null` leaves a
  label undescribed). Noul criteria describe the `true` and `false` outcomes.

## Errors

| Error | Meaning |
| --- | --- |
| `TypeSafeError` | Bad configuration or invalid questions. Nothing was sent. |
| `APIConnectionError` | The host was never reached. **Not a credentials problem.** |
| `APITimeoutError` | No response within the per-attempt timeout. |
| `APIError` (and `AuthenticationError`, `RateLimitError`, …) | The API answered and refused. Carries `status`. |

## Running behind a proxy

Node's built-in `fetch` ignores `HTTPS_PROXY` unless you opt in:

```bash
NODE_USE_ENV_PROXY=1 npm run triage
```

## Observed in practice

From a real run (`jev-latest` resolved to `jev-1.13.0`):

| Call | Questions | Input | Output |
| --- | --- | --- | --- |
| `npm run check` | 1 noul | 281 | 23 |
| `npm run triage` | 2 noul + 1 choice + 1 score | 609 | 103 |

Output tokens track the number of questions (roughly 25 each here). Input
tokens track the size of the state **and the criteria text** — verbose rubric
descriptions are paid for on every single call, not once.

Two models were listed on the account: `jev-latest` and `jev-preview`. The
response reports the model that actually served it, so log
`result.model` rather than assuming the alias.

## Cost

The response reports `usage.input_tokens` and `usage.output_tokens` — the
triage example prints them. Batching independent questions into one request
saves round trips, not tokens: every question is paid for, including
speculative ones whose branch is never used. Measure against your own traffic
before assuming a free tier covers it.

## Keys

The SDK reads `TYPESAFE_API_KEY` from the environment and redacts credential
headers from its logs. Call it from a server only; `dangerouslyAllowBrowser`
exists but exposes the key to page users. `.env` is gitignored.
