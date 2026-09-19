import assert from "node:assert/strict";
import { test } from "node:test";
import { DecodeError, decodeAnswers } from "../src/index.js";
import { choice, noul, score } from "../src/index.js";

const noulQuestions = { is_urgent: noul({ instructions: "urgent?" }) };

test("accepts the documented probability field", () => {
  const answers = decodeAnswers(noulQuestions, {
    is_urgent: { probability: 0.82 },
  });
  assert.equal(answers["is_urgent"]?.type, "noul");
  assert.equal((answers["is_urgent"] as { probability: number }).probability, 0.82);
});

test("accepts alternative spellings while the contract is unverified", () => {
  for (const raw of [{ p: 0.4 }, { value: 0.4 }, { yes_probability: 0.4 }, 0.4]) {
    const answers = decodeAnswers(noulQuestions, { is_urgent: raw });
    assert.equal((answers["is_urgent"] as { probability: number }).probability, 0.4);
  }
});

test("finds answers however the response nests them", () => {
  for (const key of ["answers", "decisions", "results", "data"]) {
    const answers = decodeAnswers(noulQuestions, {
      [key]: { is_urgent: { probability: 0.1 } },
    });
    assert.equal((answers["is_urgent"] as { probability: number }).probability, 0.1);
  }
});

test("decodes choice and score with confidence and distribution", () => {
  const questions = {
    topic: choice({ instructions: "which area?", criteria: ["payouts", "other"] }),
    heat: score({ instructions: "how hot?", criteria: ["cold", "warm"] }),
  };
  const answers = decodeAnswers(questions, {
    topic: { value: "payouts", confidence: 0.91, distribution: { payouts: 0.91, other: 0.09 } },
    heat: { level: "warm", confidence: 0.6, probabilities: { cold: 0.4, warm: 0.6 } },
  });
  assert.equal((answers["topic"] as { value: string }).value, "payouts");
  assert.equal((answers["heat"] as { level: string }).level, "warm");
  assert.deepEqual((answers["heat"] as { distribution: unknown }).distribution, {
    cold: 0.4,
    warm: 0.6,
  });
});

test("rejects a probability outside 0..1 instead of passing it on", () => {
  assert.throws(
    () => decodeAnswers(noulQuestions, { is_urgent: { probability: 42 } }),
    DecodeError,
  );
});

test("names the question that is missing from the response", () => {
  assert.throws(
    () => decodeAnswers(noulQuestions, { something_else: { probability: 0.5 } }),
    (err: unknown) =>
      err instanceof DecodeError && err.message.includes("is_urgent"),
  );
});

test("reports an unusable answer shape rather than defaulting silently", () => {
  assert.throws(
    () => decodeAnswers(noulQuestions, { is_urgent: { no_useful_field: true } }),
    DecodeError,
  );
});
