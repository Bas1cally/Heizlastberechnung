/**
 * Pins the API contract as the official SDK implements it.
 *
 * These were written against @typesafe-ai/sdk's shipped type declarations and
 * compiled client, not guessed. If a future SDK version changes the endpoint,
 * the auth header or an answer field, these fail loudly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";

const questions = {
  is_urgent: noul("Does this need urgent attention?"),
  topic: choice("Which area?", { payouts: null, other: null }),
  frustration: score("How frustrated?", ["calm", "irritated", "angry"]),
} as const;

/** A response in the shape SystemOneResult declares. */
const body = {
  model: "jev-1",
  answers: {
    is_urgent: { type: "noul", noul: 0.87 },
    topic: {
      type: "choice",
      choice: "payouts",
      confidence: 0.93,
      probabilities: { payouts: 0.93, other: 0.07 },
    },
    frustration: {
      type: "score",
      score: 1.6,
      confidence: 0.55,
      legend: { 0: "calm", 1: "irritated", 2: "angry" },
      probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
    },
  },
  usage: { input_tokens: 412, output_tokens: 18 },
};

function clientWith(
  capture: (url: string, init?: RequestInit) => void,
  response: () => Response,
): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: "test-key",
    retry: { maxRetries: 0 },
    fetch: async (url, init) => {
      capture(String(url), init);
      return response();
    },
  });
}

const ok = () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

test("posts to /v1/systemone with a bearer token", async () => {
  let url = "";
  let init: RequestInit | undefined;
  const client = clientWith(
    (u, i) => {
      url = u;
      init = i;
    },
    ok,
  );

  await client.systemOne({ state: "payouts have failed", questions });

  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(init?.method, "POST");
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("authorization"), "Bearer test-key");
});

test("sends state, questions and the resolved model", async () => {
  let init: RequestInit | undefined;
  const client = clientWith((_u, i) => {
    init = i;
  }, ok);

  await client.systemOne({ state: "s", questions });

  const sent = JSON.parse(String(init?.body));
  assert.equal(sent.state, "s");
  assert.equal(sent.model, "jev-latest", "defaults to jev-latest");
  // noul() omits `criteria` entirely when none is given - it does not send null.
  assert.deepEqual(sent.questions.is_urgent, {
    type: "noul",
    instructions: "Does this need urgent attention?",
  });
  assert.deepEqual(sent.questions.frustration.criteria, [
    "calm",
    "irritated",
    "angry",
  ]);
});

test("answers carry the fields the SDK declares", async () => {
  const client = clientWith(() => {}, ok);
  const { answers, usage, model } = await client.systemOne({
    state: "s",
    questions,
  });

  assert.equal(model, "jev-1");
  // A noul answer is on `.noul` - not `.probability`, not a boolean.
  assert.equal(answers.is_urgent.noul, 0.87);
  assert.equal(answers.topic.choice, "payouts");
  assert.equal(answers.topic.probabilities.payouts, 0.93);
  // A score is a NUMBER and may fall between rubric levels.
  assert.equal(answers.frustration.score, 1.6);
  assert.equal(answers.frustration.legend[2], "angry");
  assert.deepEqual(usage, { input_tokens: 412, output_tokens: 18 });
});

test("a rejected request surfaces as an APIError with its status", async () => {
  const client = clientWith(
    () => {},
    () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 }),
  );
  await assert.rejects(client.systemOne({ state: "s", questions }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(String((err as { status?: number }).status ?? ""), /401/);
    return true;
  });
});

test("an empty question set is rejected before any request", () => {
  let called = false;
  const client = clientWith(() => {
    called = true;
  }, ok);
  // The SDK validates synchronously, so this throws rather than rejecting.
  assert.throws(
    () => client.systemOne({ state: "s", questions: {} }),
    /At least one question is required/,
  );
  assert.equal(called, false, "no request should be attempted");
});
