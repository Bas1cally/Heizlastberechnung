# typesafe-decisions

A small, typed client for TypeSafe's System One decisions API, plus a worked
example. Code owns the workflow; the model supplies judgments where ordinary
code has no semantic understanding.

Fresh start — the repository previously held unrelated documents and its GitHub
name still reflects that. Nothing from it is used here.

## Quick start

```bash
npm install
cp .env.example .env     # fill in TYPESAFE_API_KEY
npm test                 # 20 tests, no network needed
npm run triage -- --dry-run
```

## What is in here

| Path | Purpose |
| --- | --- |
| `src/typesafe/types.ts` | The three primitives (noul / choice / score) and the typed answers they map to |
| `src/typesafe/client.ts` | HTTP client: auth, timeouts, retry on 429/5xx, no retry on 4xx |
| `src/typesafe/decode.ts` | **The one unverified file** — turns a raw response into typed answers |
| `src/typesafe/policy.ts` | Thresholds and weighting, kept out of the questions |
| `src/example/triage.ts` | Four independent judgments over one support message, in a single request |

## The part worth knowing

Answers are typed by the question that produced them, so this is a compile
error rather than a runtime surprise:

```ts
const answers = await client.decide(state, {
  is_urgent: noul({ instructions: "Does this need urgent attention?" }),
  topic: choice({ instructions: "Which area?", criteria: ["payouts", "other"] }),
});

answers.is_urgent.probability   // ok — noul returns a probability
answers.is_urgent.value         // compile error — a noul has no value
answers.topic.value             // ok — choice returns the selected option
```

A noul returns the **probability of yes**, not a boolean and not an intensity.
`0.5` means yes and no are about equally likely — the case a human should see.
That is why thresholds live in `policy.ts` and not in the questions: changing
one is a code change with no new inference.

## Unverified contract

`decode.ts` is the only file that assumes anything about the **response** shape,
and that assumption has not been checked against the live documentation.
`docs.typesafe.ai`, `typesafe.ai` and `api.typesafe.ai` were all blocked by the
egress policy of the environment this was written in, and the installed skill
package ships no API specification.

So `decode.ts` accepts several plausible field spellings (`probability`, `p`,
`yes_probability`, a bare number; answers at the top level or nested under
`answers` / `decisions` / `results` / `data`) instead of committing to one.
When it cannot find a usable field it throws a `DecodeError` naming the
question and showing what it received, rather than defaulting to a number that
would quietly be wrong.

**After the first real response:** keep the spelling that is actually used,
delete the rest, and tighten the tests in `test/decode.test.ts`. No other file
needs to change.

The **request** shape is not guessed — it mirrors the call this project started
from (`model` / `state` / `questions[id]{type,instructions}`).

`TYPESAFE_BASE_URL` is configurable for the same reason: the correct host was
not confirmable here. It defaults to `https://api.typesafe.ai`.

## Running behind a proxy

Node's built-in `fetch` ignores `HTTPS_PROXY` unless you opt in:

```bash
NODE_USE_ENV_PROXY=1 npm run triage
```

## Cost

Every question costs tokens, including speculative ones that turn out not to be
needed. Batching independent questions into one request saves round trips, not
tokens. Measure real request budgets and end-to-end latency against your own
traffic before assuming a free tier covers it.

## Keys

The key is read from the environment in `configFromEnv` and is never logged or
serialised. In a web app, call the API from the server only — never ship the
key to a browser. `.env` is gitignored.
