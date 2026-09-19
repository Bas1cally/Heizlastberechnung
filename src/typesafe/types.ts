/**
 * Question and answer shapes for the three System One primitives.
 *
 * The distinction that matters when picking one (see the typesafe-ai skill):
 *   noul   - whether a condition holds. Returns the probability of "yes".
 *            There is no separate confidence: 0.5 means yes and no are equally
 *            likely, NOT "medium intensity".
 *   choice - exactly one of a defined set. Confidence summarises how
 *            concentrated the distribution is across competing options.
 *   score  - position on an ordered, described dimension.
 */

/** Possible answers for a question. A bare string is fine for simple cases. */
export type Criteria =
  | string
  | readonly string[]
  | Readonly<Record<string, string>>;

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: Criteria;
}

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Criteria;
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  readonly criteria: Criteria;
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Question ids are for your code only; they are not sent to the model, so the
 *  instructions must carry the full meaning on their own. */
export type QuestionSet = Readonly<Record<string, Question>>;

export interface NoulAnswer {
  readonly type: "noul";
  /** Probability that the condition holds, 0..1. */
  readonly probability: number;
}

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly value: string;
  readonly confidence: number;
  readonly distribution: Readonly<Record<string, number>>;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly level: string;
  readonly confidence: number;
  readonly distribution: Readonly<Record<string, number>>;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type AnswerFor<Q extends Question> = Q["type"] extends "noul"
  ? NoulAnswer
  : Q["type"] extends "choice"
    ? ChoiceAnswer
    : Q["type"] extends "score"
      ? ScoreAnswer
      : never;

/** Maps a question set to its answers, so `answers.is_urgent.probability`
 *  type-checks without a cast. */
export type AnswersFor<QS extends QuestionSet> = {
  readonly [K in keyof QS]: AnswerFor<QS[K]>;
};

// Builders that keep the literal `type` so AnswersFor can discriminate.

export const noul = <const T extends Omit<NoulQuestion, "type">>(
  q: T,
): T & { type: "noul" } => ({ ...q, type: "noul" });

export const choice = <const T extends Omit<ChoiceQuestion, "type">>(
  q: T,
): T & { type: "choice" } => ({ ...q, type: "choice" });

export const score = <const T extends Omit<ScoreQuestion, "type">>(
  q: T,
): T & { type: "score" } => ({ ...q, type: "score" });
