/**
 * Latency stages of the decision-to-execution path, all on the monotonic
 * clock. A stage that has not happened is left undefined, never zero.
 */
export interface LatencyStamps {
  packetReceived?: number;
  stateUpdated?: number;
  jevRequestStarted?: number;
  jevResponseReceived?: number;
  decisionValidated?: number;
  signingStarted?: number;
  signingCompleted?: number;
  orderSubmitted?: number;
  ack?: number;
  fill?: number;
}

export interface LatencyBreakdown {
  feed_to_state_ms?: number | undefined;
  state_to_jev_ms?: number | undefined;
  jev_ms?: number | undefined;
  jev_to_submit_ms?: number | undefined;
  submit_to_ack_ms?: number | undefined;
  feed_to_ack_ms?: number | undefined;
}

const diff = (a?: number, b?: number) =>
  a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b) ? b - a : undefined;

export function breakdown(s: LatencyStamps): LatencyBreakdown {
  return {
    feed_to_state_ms: diff(s.packetReceived, s.stateUpdated),
    state_to_jev_ms: diff(s.stateUpdated, s.jevRequestStarted),
    jev_ms: diff(s.jevRequestStarted, s.jevResponseReceived),
    jev_to_submit_ms: diff(s.jevResponseReceived, s.orderSubmitted),
    submit_to_ack_ms: diff(s.orderSubmitted, s.ack),
    feed_to_ack_ms: diff(s.packetReceived, s.ack),
  };
}

export interface Percentiles {
  count: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentiles. Empty input yields all-NaN, never a fake zero. */
export function percentiles(values: readonly number[]): Percentiles {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return { count: 0, p50: NaN, p75: NaN, p90: NaN, p95: NaN, p99: NaN, max: NaN, mean: NaN };
  const at = (p: number) => xs[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))]!;
  return {
    count: n,
    p50: at(50), p75: at(75), p90: at(90), p95: at(95), p99: at(99),
    max: xs[n - 1]!,
    mean: xs.reduce((s, v) => s + v, 0) / n,
  };
}

/** Bounded reservoir of recent samples per stage, for live reporting. */
export class LatencyTracker {
  private readonly samples = new Map<keyof LatencyBreakdown, number[]>();
  constructor(private readonly capacity = 5_000) {}

  record(b: LatencyBreakdown): void {
    for (const [k, v] of Object.entries(b) as [keyof LatencyBreakdown, number | undefined][]) {
      if (v === undefined) continue;
      let arr = this.samples.get(k);
      if (!arr) this.samples.set(k, (arr = []));
      arr.push(v);
      if (arr.length > this.capacity) arr.splice(0, arr.length - this.capacity);
    }
  }

  report(): Record<string, Percentiles> {
    const out: Record<string, Percentiles> = {};
    for (const [k, v] of this.samples) out[k] = percentiles(v);
    return out;
  }
}
