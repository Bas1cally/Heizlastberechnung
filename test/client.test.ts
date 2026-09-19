import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiError,
  ConfigError,
  DecisionsClient,
  NetworkError,
  configFromEnv,
  noul,
} from "../src/index.js";
import type { ClientConfig } from "../src/index.js";

const questions = { is_urgent: noul({ instructions: "urgent?" }) };

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function clientWith(
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<ClientConfig> = {},
): DecisionsClient {
  return new DecisionsClient(
    configFromEnv(
      {},
      { apiKey: "test-key", maxRetries: 2, timeoutMs: 5000, fetch: fetchImpl, ...overrides },
    ),
  );
}

test("sends model, state and questions to the decisions endpoint", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const client = clientWith(async (url, init) => {
    seen = { url: String(url), init: init as RequestInit };
    return ok({ is_urgent: { probability: 0.7 } });
  });

  await client.decide("payouts have failed", questions);

  assert.ok(seen);
  assert.equal(seen.url, "https://api.typesafe.ai/api/v1/decisions");
  assert.equal(seen.init.method, "POST");
  const headers = seen.init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer test-key");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(seen.init.body)), {
    model: "jev-latest",
    state: "payouts have failed",
    questions: { is_urgent: { instructions: "urgent?", type: "noul" } },
  });
});

test("returns answers typed by the question that produced them", async () => {
  const client = clientWith(async () => ok({ is_urgent: { probability: 0.7 } }));
  const answers = await client.decide("s", questions);
  // .probability resolves without a cast because the question is a noul.
  assert.equal(answers.is_urgent.probability, 0.7);
});

test("retries a rate limit and then succeeds", async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls++;
    if (calls < 3) return new Response("slow down", { status: 429 });
    return ok({ is_urgent: { probability: 0.2 } });
  });

  const answers = await client.decide("s", questions);
  assert.equal(calls, 3);
  assert.equal(answers.is_urgent.probability, 0.2);
});

test("does not retry a bad request", async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls++;
    return new Response("bad question", { status: 400 });
  });

  await assert.rejects(client.decide("s", questions), ApiError);
  assert.equal(calls, 1, "a 400 must not be retried");
});

test("surfaces the status and body of a failed request", async () => {
  const client = clientWith(
    async () => new Response("invalid key", { status: 401 }),
    { maxRetries: 0 },
  );
  await assert.rejects(client.decide("s", questions), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 401);
    assert.match(err.message, /invalid key/);
    return true;
  });
});

test("refuses to run without an API key", () => {
  assert.throws(() => configFromEnv({}), ConfigError);
});

test("refuses an empty question set before making a request", async () => {
  let called = false;
  const client = clientWith(async () => {
    called = true;
    return ok({});
  });
  await assert.rejects(client.decide("s", {}), ConfigError);
  assert.equal(called, false);
});

test("honours a configured base URL", async () => {
  let url = "";
  const client = clientWith(
    async (u) => {
      url = String(u);
      return ok({ is_urgent: { probability: 0.1 } });
    },
    { baseUrl: "https://api.venice.ai/" },
  );
  await client.decide("s", questions);
  assert.equal(url, "https://api.venice.ai/api/v1/decisions");
});

test("reports an unreachable host as a NetworkError, not a raw failure", async () => {
  const client = clientWith(async () => {
    throw new TypeError("fetch failed", { cause: new Error("tunnel refused") });
  }, { maxRetries: 0 });

  await assert.rejects(client.decide("s", questions), (err: unknown) => {
    assert.ok(err instanceof NetworkError, "expected a NetworkError");
    assert.match(err.message, /could not reach https:\/\/api\.typesafe\.ai/);
    assert.match(err.message, /tunnel refused/);
    // The point of the message: a blocked tunnel is not a credentials problem.
    assert.match(err.message, /credentials were not sent/);
    return true;
  });
});

test("does not disguise an HTTP error as a network error", async () => {
  const client = clientWith(
    async () => new Response("nope", { status: 403 }),
    { maxRetries: 0 },
  );
  await assert.rejects(client.decide("s", questions), ApiError);
});

test("reports an exhausted retry budget as a NetworkError", async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls++;
    return new Response("busy", { status: 503 });
  });
  await assert.rejects(client.decide("s", questions), ApiError);
  assert.equal(calls, 3, "should have used the full retry budget");
});
