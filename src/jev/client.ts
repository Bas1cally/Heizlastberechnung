import { APIUserAbortError, TypeSafeClient } from "@typesafe-ai/sdk";
import type { JevCall } from "./decision-engine.js";
import type { JevAnswers } from "./decision-types.js";

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
