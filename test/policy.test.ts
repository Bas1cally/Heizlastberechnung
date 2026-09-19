import assert from "node:assert/strict";
import { test } from "node:test";
import { band, nearestLevel, weightedScore } from "../src/index.js";
import type { NoulResponse, ScoreResponse } from "../src/index.js";

const p = (noul: number): NoulResponse => ({ type: "noul", noul });
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
  assert.equal(
    weightedScore([
      { answer: p(1), weight: 3 },
      { answer: p(0), weight: 1 },
    ]),
    0.75,
  );
});

test("refuses a zero total weight", () => {
  assert.throws(() => weightedScore([{ answer: p(1), weight: 0 }]), RangeError);
});

test("maps a fractional score to the nearest described level", () => {
  const answer = {
    type: "score",
    score: 1.6,
    confidence: 0.7,
    legend: { 0: "calm", 1: "irritated", 2: "angry" },
    probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
  } as unknown as ScoreResponse;
  // 1.6 is closer to 2 than to 1 - a score is an expected value and need not
  // land on a rubric level.
  assert.equal(nearestLevel(answer), "angry");
});
