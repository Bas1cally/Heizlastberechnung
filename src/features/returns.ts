/**
 * Price history window and return features.
 *
 * Returns are in basis points of simple return, so a value of 18.2 reads as
 * "+1.82 bps". Nothing here is annualised: the horizon is minutes.
 */
export interface Tick {
  readonly ts: number;
  readonly price: number;
}

export class PriceWindow {
  private readonly ticks: Tick[] = [];

  constructor(private readonly retainMs: number) {}

  push(tick: Tick): void {
    const last = this.ticks[this.ticks.length - 1];
    if (last && tick.ts < last.ts) return; // out-of-order: drop, never rewrite history
    this.ticks.push(tick);
    const cutoff = tick.ts - this.retainMs;
    let drop = 0;
    while (drop < this.ticks.length - 1 && this.ticks[drop + 1]!.ts <= cutoff) drop++;
    if (drop > 0) this.ticks.splice(0, drop);
  }

  latest(): Tick | undefined {
    return this.ticks[this.ticks.length - 1];
  }

  /** Last tick at or before `ts`, or undefined when history does not reach. */
  at(ts: number): Tick | undefined {
    let best: Tick | undefined;
    for (const t of this.ticks) {
      if (t.ts <= ts) best = t;
      else break;
    }
    return best;
  }

  since(ts: number): readonly Tick[] {
    return this.ticks.filter((t) => t.ts >= ts);
  }

  size(): number {
    return this.ticks.length;
  }
}

/** Simple return over `windowMs` ending at the latest tick, in bps. 0 when unknown. */
export function returnBps(window: PriceWindow, windowMs: number): number {
  const now = window.latest();
  if (!now) return 0;
  const then = window.at(now.ts - windowMs);
  if (!then || then.price <= 0) return 0;
  return ((now.price - then.price) / then.price) * 10_000;
}

export function distanceBps(start: number, current: number): number {
  return start > 0 ? ((current - start) / start) * 10_000 : 0;
}
