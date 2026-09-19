import assert from "node:assert/strict";
import { test } from "node:test";
import { band, weightedScore } from "../src/index.js";
import type { NoulAnswer } from "../src/index.js";

const p = (probability: number): NoulAnswer => ({ type: "noul", probability });
const thresholds = { act: 0.8, review: 0.45 };

test("bands a probability into act, review and ignore", () => {
  assert.equal(band(p(0.95), thresholds), "act");
  assert.equal(band(p(0.8), thresholds), "act");
  assert.equal(band(p(0.5), thresholds), "review");
  assert.equal(band(p(0.44), thresholds), "ignore");
});

test("an uncertain answer lands in review, not in a coin flip", () => {
  assert.equal(band(p(0.5), thresholds), "review");
});

test("rejects thresholds that are the wrong way round", () => {
  assert.throws(() => band(p(0.5), { act: 0.3, review: 0.7 }), RangeError);
});

test("weights compensating signals", () => {
  const combined = weightedScore([
    { answer: p(1), weight: 3 },
    { answer: p(0), weight: 1 },
  ]);
  assert.equal(combined, 0.75);
});

test("refuses a zero total weight", () => {
  assert.throws(() => weightedScore([{ answer: p(1), weight: 0 }]), RangeError);
});
