/**
 * ============================ UNVERIFIED CONTRACT ============================
 * This is the ONLY file that assumes anything about the API's RESPONSE shape.
 *
 * The response format could not be checked against the live documentation:
 * docs.typesafe.ai, typesafe.ai and api.typesafe.ai are all blocked by the
 * egress policy of the environment this was written in, and the installed
 * skill package ships no API specification.
 *
 * So the decoders below accept several plausible field spellings instead of
 * guessing one. Once you have seen a real response, delete the alternatives
 * and keep the spelling that is actually used. Nothing else in the codebase
 * needs to change: everywhere else works against the types in ./types.ts.
 *
 * The REQUEST shape is not guessed - it mirrors the working call this project
 * started from (model / state / questions[id]{type,instructions}).
 * ============================================================================
 */

import type {
  Answer,
  ChoiceAnswer,
  NoulAnswer,
  Question,
  QuestionSet,
  ScoreAnswer,
} from "./types.js";

export class DecodeError extends Error {
  constructor(
    message: string,
    readonly received: unknown,
  ) {
    super(message);
    this.name = "DecodeError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** First candidate key present with a value of the wanted kind. */
function pick<T>(
  source: Record<string, unknown>,
  keys: readonly string[],
  guard: (v: unknown) => v is T,
): T | undefined {
  for (const key of keys) {
    const value = source[key];
    if (guard(value)) return value;
  }
  return undefined;
}

const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === "string";

function asDistribution(v: unknown): Record<string, number> {
  if (!isRecord(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) if (isNumber(n)) out[k] = n;
  return out;
}

function requireProbability(value: number, where: string): number {
  if (value < 0 || value > 1) {
    throw new DecodeError(
      `${where}: expected a probability in 0..1, got ${value}`,
      value,
    );
  }
  return value;
}

/** Locate the per-question answers object, wherever it is nested. */
export function unwrapAnswers(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new DecodeError("response body is not a JSON object", payload);
  }
  for (const key of ["answers", "questions", "decisions", "results", "data"]) {
    const nested = payload[key];
    if (isRecord(nested)) return nested;
  }
  // Otherwise assume the answers sit at the top level, keyed by question id.
  return payload;
}

function decodeOne(id: string, question: Question, raw: unknown): Answer {
  // A bare number for a noul is a plausible shorthand; accept it.
  if (question.type === "noul" && isNumber(raw)) {
    return {
      type: "noul",
      probability: requireProbability(raw, `question "${id}"`),
    } satisfies NoulAnswer;
  }

  if (!isRecord(raw)) {
    throw new DecodeError(
      `question "${id}": expected an object answer, got ${typeof raw}`,
      raw,
    );
  }

  const confidence = pick(raw, ["confidence", "certainty"], isNumber) ?? 0;
  const distribution = asDistribution(
    pick(raw, ["distribution", "probabilities", "scores"], isRecord),
  );

  switch (question.type) {
    case "noul": {
      const probability = pick(
        raw,
        ["probability", "p", "yes_probability", "value", "score"],
        isNumber,
      );
      if (probability === undefined) {
        throw new DecodeError(
          `question "${id}": no probability field found in noul answer`,
          raw,
        );
      }
      return {
        type: "noul",
        probability: requireProbability(probability, `question "${id}"`),
      } satisfies NoulAnswer;
    }
    case "choice": {
      const value = pick(
        raw,
        ["value", "choice", "selected", "answer", "option", "label"],
        isString,
      );
      if (value === undefined) {
        throw new DecodeError(
          `question "${id}": no selected option found in choice answer`,
          raw,
        );
      }
      return {
        type: "choice",
        value,
        confidence,
        distribution,
      } satisfies ChoiceAnswer;
    }
    case "score": {
      const level = pick(
        raw,
        ["level", "value", "label", "answer", "bucket"],
        isString,
      );
      if (level === undefined) {
        throw new DecodeError(
          `question "${id}": no level found in score answer`,
          raw,
        );
      }
      return {
        type: "score",
        level,
        confidence,
        distribution,
      } satisfies ScoreAnswer;
    }
  }
}

/** Decode a whole response against the question set that produced it. */
export function decodeAnswers(
  questions: QuestionSet,
  payload: unknown,
): Record<string, Answer> {
  const source = unwrapAnswers(payload);
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (!(id in source)) {
      throw new DecodeError(`question "${id}": missing from response`, source);
    }
    answers[id] = decodeOne(id, question, source[id]);
  }
  return answers;
}
