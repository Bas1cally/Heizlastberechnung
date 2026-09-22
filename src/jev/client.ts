import { APIUserAbortError, TypeSafeClient, type ChoiceQuestion } from "@typesafe-ai/sdk";
import type { JevCall } from "./decision-engine.js";
import type { JevAnswers } from "./decision-types.js";

/** One focused choice question over a small state: the shape policy-animal-jev asks Jev at the two moments that matter. */
export interface FocusedAnswer {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Record<string, number>;
  readonly model: string;
  readonly usage: { input_tokens: number; output_tokens: number };
  readonly latencyMs: number;
}
export type FocusedAsk = (name: string, question: ChoiceQuestion, state: Record<string, unknown>, signal: AbortSignal) => Promise<FocusedAnswer>;

/**
 * Adapts the official SDK to the engine's `JevCall`. Cancellation goes
 * through the SDK's own `signal` option; an abort surfaces as
 * APIUserAbortError, which the engine treats as intentional.
 */
export function createJevCall(opts: { apiKey: string; model?: string | undefined; timeoutMs: number; retries?: number }): JevCall {
  const client = new TypeSafeClient({
    apiKey: opts.apiKey,
    ...(opts.model ? { defaultModel: opts.model } : {}),
    timeout: opts.timeoutMs,
    // Retrying a decision is wrong: by the time it retries the state is old.
    retry: { maxRetries: opts.retries ?? 0 },
    logLevel: "off",
  });

  return async (state, questions, signal) => {
    const res = await client.systemOne({ state: state as unknown as Record<string, never>, questions }, { signal });
    return { answers: res.answers as unknown as JevAnswers, model: res.model, usage: res.usage };
  };
}

export const isAbort = (err: unknown): boolean => err instanceof APIUserAbortError;

/** The same SDK client, asked one question at a time. */
export function createFocusedAsk(opts: { apiKey: string; model?: string | undefined; timeoutMs: number; now?: () => number }): FocusedAsk {
  const client = new TypeSafeClient({
    apiKey: opts.apiKey,
    ...(opts.model ? { defaultModel: opts.model } : {}),
    timeout: opts.timeoutMs,
    retry: { maxRetries: 0 },
    logLevel: "off",
  });
  const now = opts.now ?? (() => performance.now());
  return async (name, question, state, signal) => {
    const t0 = now();
    const res = await client.systemOne({ state: state as unknown as Record<string, never>, questions: { [name]: question } }, { signal });
    const a = res.answers[name] as unknown as { choice: string; confidence: number; probabilities: Record<string, number> };
    return { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, model: res.model, usage: res.usage, latencyMs: Math.round(now() - t0) };
  };
}
