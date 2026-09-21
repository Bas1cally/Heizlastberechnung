/**
 * Two clocks, kept apart on purpose.
 *
 * `mono()` is monotonic and drives every latency measurement. `wall()` is the
 * system clock and drives seconds-to-expiry. The system clock can jump; a
 * latency measured across such a jump would be garbage, and an expiry computed
 * from a wrong wall clock is worse than garbage. So drift against feed
 * timestamps is tracked, and past a tolerance the bot fails closed.
 */
export interface Clock {
  mono(): number;
  wall(): number;
  /** Record a server/feed timestamp observed "now". */
  observeServerTime(serverMs: number): void;
  /** Smoothed local-minus-server offset in ms; NaN until observed. */
  driftMs(): number;
  withinTolerance(maxAbsDriftMs: number): boolean;
}

export function createClock(opts: { mono?: () => number; wall?: () => number; alpha?: number } = {}): Clock {
  const mono = opts.mono ?? (() => performance.now());
  const wall = opts.wall ?? (() => Date.now());
  const alpha = opts.alpha ?? 0.2;
  let drift = Number.NaN;

  return {
    mono,
    wall,
    observeServerTime(serverMs) {
      const sample = wall() - serverMs;
      drift = Number.isNaN(drift) ? sample : drift + alpha * (sample - drift);
    },
    driftMs: () => drift,
    withinTolerance(max) {
      return Number.isNaN(drift) ? true : Math.abs(drift) <= max;
    },
  };
}
