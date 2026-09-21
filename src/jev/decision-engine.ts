import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "../observability/logger.js";
import type { Action, JevAnswers, JevInputState } from "./decision-types.js";
import { canonicalJson } from "./state-builder.js";
import { QUESTIONS } from "./questions.js";

/** The one call into Jev. Injected so the engine is testable without the SDK. */
export type JevCall = (
  state: JevInputState,
  questions: typeof QUESTIONS,
  signal: AbortSignal,
) => Promise<{ answers: JevAnswers; model: string; usage: { input_tokens: number; output_tokens: number } }>;

export interface Decision {
  readonly decisionId: string;
  readonly marketId: string;
  /** Material version the decision was made on; the risk gate compares this. */
  readonly stateVersion: bigint;
  readonly rawStateVersion: bigint;
  readonly materialReason: string;
  /** Monotonic stamps of the packet and state update this decision was made on. */
  readonly packetReceivedMono: number | undefined;
  readonly stateUpdatedMono: number | undefined;
  readonly inputHash: string;
  readonly requestedAtMono: number;
  readonly respondedAtMono: number;
  readonly jevLatencyMs: number;
  readonly timestampMs: number;
  readonly state: JevInputState;
  readonly answers: JevAnswers;
  readonly model: string;
  readonly usage: { input_tokens: number; output_tokens: number };
  readonly requestedAction: Action;
}

export interface DecisionEngineOptions {
  readonly call: JevCall;
  readonly mono: () => number;
  readonly wall: () => number;
  readonly log: Logger;
  /** Burst window: requests inside it collapse into one with the newest state. */
  readonly coalesceMs: number;
  /** Floor between consecutive requests. */
  readonly minIntervalMs: number;
  readonly onDecision: (d: Decision) => void;
  readonly onError: (err: unknown, stateVersion: bigint) => void;
  readonly timer?: (fn: () => void, ms: number) => unknown;
}

interface Pending {
  marketId: string;
  stateVersion: bigint;
  rawStateVersion: bigint;
  materialReason: string;
  packetReceivedMono?: number | undefined;
  stateUpdatedMono?: number | undefined;
  state: JevInputState;
}

/**
 * Decides when Jev is called and guarantees only the newest state can ever
 * produce a decision:
 *
 *  - bursts are coalesced: the newest snapshot wins, older ones are dropped
 *  - an in-flight request is aborted when a newer state is submitted
 *  - a response for a superseded state is discarded even if abort was late
 */
export class DecisionEngine {
  private pending: Pending | undefined;
  private timer: unknown;
  private inflight: { version: bigint; controller: AbortController } | undefined;
  private lastRequestMono = Number.NEGATIVE_INFINITY;
  private latestSubmitted = -1n;

  constructor(private readonly opts: DecisionEngineOptions) {}

  submit(marketId: string, stateVersion: bigint, state: JevInputState, meta: { rawStateVersion: bigint; materialReason: string; packetReceivedMono?: number | undefined; stateUpdatedMono?: number | undefined } = { rawStateVersion: stateVersion, materialReason: "unspecified" }): void {
    if (stateVersion <= this.latestSubmitted) return;
    this.latestSubmitted = stateVersion;
    this.pending = { marketId, stateVersion, state, ...meta };

    if (this.timer !== undefined) return; // a flush is already scheduled; it will take the newest
    const sinceLast = this.opts.mono() - this.lastRequestMono;
    const wait = Math.max(this.opts.coalesceMs, this.opts.minIntervalMs - sinceLast);
    const schedule = this.opts.timer ?? setTimeout;
    this.timer = schedule(() => {
      this.timer = undefined;
      this.flush();
    }, Math.max(0, wait));
  }

  private flush(): void {
    const p = this.pending;
    this.pending = undefined;
    if (!p) return;

    if (this.inflight) {
      this.inflight.controller.abort();
      this.inflight = undefined;
    }

    const controller = new AbortController();
    this.inflight = { version: p.stateVersion, controller };
    this.lastRequestMono = this.opts.mono();
    const requestedAtMono = this.lastRequestMono;
    const inputHash = createHash("sha256").update(canonicalJson(p.state)).digest("hex");

    // Invoked synchronously so the latency stamp sits right before the request,
    // but guarded: a throw inside `call` must reach onError, not escape the
    // timer callback and take the process down.
    let request: ReturnType<JevCall>;
    try {
      request = Promise.resolve(this.opts.call(p.state, QUESTIONS, controller.signal));
    } catch (err) {
      this.inflight = undefined;
      this.opts.onError(err, p.stateVersion);
      return;
    }
    request
      .then((res) => {
        if (this.inflight?.version !== p.stateVersion) return; // superseded: discard
        this.inflight = undefined;
        const respondedAtMono = this.opts.mono();
        this.opts.onDecision({
          decisionId: randomUUID(),
          marketId: p.marketId,
          stateVersion: p.stateVersion,
          rawStateVersion: p.rawStateVersion,
          materialReason: p.materialReason,
          packetReceivedMono: p.packetReceivedMono,
          stateUpdatedMono: p.stateUpdatedMono,
          inputHash,
          requestedAtMono,
          respondedAtMono,
          jevLatencyMs: respondedAtMono - requestedAtMono,
          timestampMs: this.opts.wall(),
          state: p.state,
          answers: res.answers,
          model: res.model,
          usage: res.usage,
          requestedAction: res.answers.action.choice as Action,
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return; // we cancelled it on purpose
        if (this.inflight?.version === p.stateVersion) this.inflight = undefined;
        this.opts.onError(err, p.stateVersion);
      });
  }

  hasInflight(): boolean {
    return this.inflight !== undefined;
  }
}
