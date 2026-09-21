/**
 * Settlement outcome of a 5-minute market from the recorded price stream.
 *
 * Rule (from the market description): UP if the price at the end of the
 * range is greater than or equal to the price at the beginning. The feed's
 * own `market_resolved` event is authoritative when present; this is the
 * fallback, and a cross-check for the start-price assumption.
 */
export interface PriceTick {
  readonly tsMs: number;
  readonly price: number;
}

export interface DerivedOutcome {
  readonly startPrice: number;
  readonly endPrice: number;
  readonly outcome: "UP" | "DOWN";
  readonly startTickTs: number;
  readonly endTickTs: number;
}

export function deriveOutcome(
  ticks: readonly PriceTick[],
  openedAtMs: number,
  closesAtMs: number,
): DerivedOutcome | undefined {
  let start: PriceTick | undefined;
  let end: PriceTick | undefined;
  for (const t of ticks) {
    if (t.tsMs >= openedAtMs && t.tsMs < closesAtMs) {
      if (!start || t.tsMs < start.tsMs) start = t;
      if (!end || t.tsMs > end.tsMs) end = t;
    }
  }
  if (!start || !end) return undefined;
  return {
    startPrice: start.price,
    endPrice: end.price,
    outcome: end.price >= start.price ? "UP" : "DOWN",
    startTickTs: start.tsMs,
    endTickTs: end.tsMs,
  };
}

/** Normalise the feed's winning outcome label to UP/DOWN, or undefined. */
export function outcomeFromLabel(label: string | null | undefined): "UP" | "DOWN" | undefined {
  const k = label?.trim().toLowerCase();
  if (k === "up" || k === "yes") return "UP";
  if (k === "down" || k === "no") return "DOWN";
  return undefined;
}
