import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import { describeFailure } from "../src/typesafe/diagnose.js";

const fromStatus = (status: number, body: unknown = {}) =>
  APIError.fromResponse(status, body, new Headers());

test("an unreachable API is not reported as a key problem", () => {
  const d = describeFailure(new APIConnectionError("fetch failed"));
  assert.match(d.headline, /never reached/i);
  assert.match(d.remedy, /not a credentials problem/i);
  assert.match(d.remedy, /NODE_USE_ENV_PROXY/);
});

test("a timeout is distinguished from a generic connection failure", () => {
  const d = describeFailure(new APITimeoutError(10_000));
  assert.match(d.headline, /10000 ms/);
  assert.match(d.remedy, /timeout/i);
});

test("a 401 points at the key", () => {
  const d = describeFailure(fromStatus(401));
  assert.match(d.headline, /401/);
  assert.match(d.remedy, /TYPESAFE_API_KEY/);
});

test("a 403 separates a valid key from an unauthorised one", () => {
  const d = describeFailure(fromStatus(403));
  assert.match(d.headline, /valid but not allowed/i);
});

test("a 429 reports the server's requested wait when it gives one", () => {
  const headers = new Headers({ "retry-after-ms": "1500" });
  const d = describeFailure(APIError.fromResponse(429, {}, headers));
  assert.match(d.headline, /429/);
  assert.match(d.headline, /1500 ms/);
});

test("a 422 points at the question definitions", () => {
  const d = describeFailure(fromStatus(422));
  assert.match(d.remedy, /score criteria/i);
});

test("an unmapped status still reports status and body", () => {
  const d = describeFailure(fromStatus(418, { detail: "teapot" }));
  assert.match(d.headline, /418/);
  assert.match(d.remedy, /teapot/);
});

test("a config error says nothing was sent", () => {
  const d = describeFailure(new TypeSafeError("At least one question is required."));
  assert.match(d.headline, /At least one question is required/);
  assert.match(d.remedy, /Nothing was sent/i);
});

test("a non-SDK error is not disguised as one", () => {
  const d = describeFailure(new Error("something else"));
  assert.match(d.headline, /Unexpected failure/);
});
