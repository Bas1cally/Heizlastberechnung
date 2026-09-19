/**
 * Turns an SDK failure into a headline and a concrete next step.
 *
 * The distinction that matters most: a request that never reached the API
 * cannot be a credentials problem, because the key was never sent. Those two
 * look identical in a stack trace and lead to very different debugging.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeError,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";

export interface Diagnosis {
  readonly headline: string;
  readonly remedy: string;
}

export function describeFailure(err: unknown): Diagnosis {
  // Subclasses first: APITimeoutError extends APIConnectionError, and the
  // status-specific errors all extend APIError.
  if (err instanceof APITimeoutError) {
    return {
      headline: `No response within ${err.timeoutMs} ms.`,
      remedy:
        "Raise `timeout` in the client config, or check whether the network path is slow. The key is not involved.",
    };
  }
  if (err instanceof APIConnectionError) {
    return {
      headline: "The API was never reached.",
      remedy:
        "This is not a credentials problem - the request did not complete, so the key was never accepted or rejected. " +
        "Check that the host is reachable from this machine. Behind a proxy, Node's fetch needs NODE_USE_ENV_PROXY=1, " +
        "and the host must be allowed by the proxy's policy.",
    };
  }
  if (err instanceof AuthenticationError) {
    return {
      headline: "The API rejected the key (401).",
      remedy: "Check TYPESAFE_API_KEY for a typo, and that the key is still active.",
    };
  }
  if (err instanceof PermissionDeniedError) {
    return {
      headline: "The key is valid but not allowed to do this (403).",
      remedy: "Check the account's plan and the permissions on this key.",
    };
  }
  if (err instanceof RateLimitError) {
    const wait =
      err.retryAfterMs === undefined
        ? "The server did not say how long to wait."
        : `The server asked to wait ${err.retryAfterMs} ms.`;
    return {
      headline: `Rate limited (429). ${wait}`,
      remedy:
        "The SDK already retries these. Persistent 429s mean the request rate is above the account's limit.",
    };
  }
  if (err instanceof UnprocessableEntityError) {
    return {
      headline: "The request was rejected as invalid (422).",
      remedy:
        "Check the question definitions: score criteria need at least two ordered entries, choice criteria need labels.",
    };
  }
  if (err instanceof APIError) {
    return {
      headline: `The API returned HTTP ${err.status}.`,
      remedy: `Response body: ${JSON.stringify(err.body ?? "").slice(0, 300)}`,
    };
  }
  if (err instanceof APIUserAbortError) {
    return {
      headline: "The request was cancelled by the caller.",
      remedy: "An AbortSignal fired. Nothing is wrong with the configuration.",
    };
  }
  if (err instanceof TypeSafeError) {
    return {
      headline: `Configuration or input problem: ${err.message}`,
      remedy: "Nothing was sent. Fix the configuration or the questions and try again.",
    };
  }
  return {
    headline: `Unexpected failure: ${String(err)}`,
    remedy: "This is not an error the SDK raises; check the stack trace.",
  };
}
