import { decodeAnswers } from "./decode.js";
import type { AnswersFor, QuestionSet } from "./types.js";

/** State handed to the model: a plain string, or named fields when the context
 *  has several parts (reference nested parts as `ticket.messages[0].text`). */
export type State = string | Readonly<Record<string, unknown>>;

export interface ClientConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /** Injection point for tests; defaults to global fetch. */
  readonly fetch: typeof globalThis.fetch;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`decisions API returned HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "ApiError";
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULTS = {
  baseUrl: "https://api.typesafe.ai",
  model: "jev-latest",
  timeoutMs: 30_000,
  maxRetries: 2,
} as const;

/**
 * Build a config from the environment.
 *
 * The key is read here and never logged or serialised, so it stays server-side.
 * In a web app, call this on the server only - never ship the key to a browser.
 */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<ClientConfig> = {},
): ClientConfig {
  const apiKey = overrides.apiKey ?? env["TYPESAFE_API_KEY"] ?? "";
  if (!apiKey) {
    throw new ConfigError(
      "TYPESAFE_API_KEY is not set. Copy .env.example to .env and fill it in.",
    );
  }
  return {
    apiKey,
    baseUrl: (
      overrides.baseUrl ??
      env["TYPESAFE_BASE_URL"] ??
      DEFAULTS.baseUrl
    ).replace(/\/+$/, ""),
    model: overrides.model ?? env["TYPESAFE_MODEL"] ?? DEFAULTS.model,
    timeoutMs: overrides.timeoutMs ?? DEFAULTS.timeoutMs,
    maxRetries: overrides.maxRetries ?? DEFAULTS.maxRetries,
    fetch: overrides.fetch ?? globalThis.fetch,
  };
}

/** The exact JSON sent to the API. Exported so a dry run can show it without
 *  making a request - useful when the host is unreachable. */
export function buildRequestBody(
  model: string,
  state: State,
  questions: QuestionSet,
): string {
  return JSON.stringify({ model, state, questions });
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DecisionsClient {
  constructor(private readonly config: ClientConfig) {}

  static fromEnv(overrides: Partial<ClientConfig> = {}): DecisionsClient {
    return new DecisionsClient(configFromEnv(process.env, overrides));
  }

  /**
   * Ask a set of independent questions about one state, in a single request.
   *
   * The questions cannot see one another's answers - they are judged in
   * parallel over the same state. That is the point: batch everything that
   * depends only on this state, and make a second call only when an answer is
   * needed to fetch new evidence or decide the next options.
   */
  async decide<QS extends QuestionSet>(
    state: State,
    questions: QS,
  ): Promise<AnswersFor<QS>> {
    if (Object.keys(questions).length === 0) {
      throw new ConfigError("decide() needs at least one question");
    }
    const body = buildRequestBody(this.config.model, state, questions);

    const payload = await this.post(body);
    return decodeAnswers(questions, payload) as AnswersFor<QS>;
  }

  private async post(body: string): Promise<unknown> {
    const url = `${this.config.baseUrl}/api/v1/decisions`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) await sleep(2 ** attempt * 250);

      const timeout = AbortSignal.timeout(this.config.timeoutMs);
      try {
        const response = await this.config.fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal: timeout,
        });

        if (response.ok) return await response.json();

        const text = await response.text().catch(() => "");
        const error = new ApiError(response.status, text);
        if (!RETRYABLE.has(response.status)) throw error;
        lastError = error;
      } catch (err) {
        // A non-retryable ApiError must not be swallowed by the retry loop.
        if (err instanceof ApiError && !RETRYABLE.has(err.status)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }
}
