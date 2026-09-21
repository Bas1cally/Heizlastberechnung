/**
 * Probability calibration (brief §27) and naive edge segmentation (§28, §30).
 *
 * A model that says 0.99 must be right about 99% of the time at that level.
 * Directional accuracy alone says nothing: a 0.99 that resolves 90% of the
 * time loses money at those prices however often it is "right".
 */
export interface Observation {
  /** Jev's renormalised P(UP) at decision time. */
  readonly pUp: number;
  /** Mass on UNRESOLVED before renormalisation. */
  readonly unresolvedMass: number;
  readonly outcomeUp: boolean;
  readonly secondsRemaining: number;
  /** Executable ask for the UP and DOWN tokens at decision time. */
  readonly upAsk: number;
  readonly downAsk: number;
  readonly action: string;
  readonly marketId: string;
  /** Optional context for the EV segmentation (brief §26); absent on older records. */
  readonly distanceBps?: number | undefined;
  readonly realizedVol30s?: number | undefined;
  readonly pairAskCost?: number | undefined;
  /** Jev's confidence in the action it chose. */
  readonly actionConfidence?: number | undefined;
  readonly decisionId?: string | undefined;
}

/** Bucket edges from the brief, applied to max(p, 1-p) - the confidence in the favoured side. */
export const CONFIDENCE_BUCKETS: readonly { label: string; lo: number; hi: number }[] = [
  { label: "50-60%", lo: 0.5, hi: 0.6 },
  { label: "60-70%", lo: 0.6, hi: 0.7 },
  { label: "70-80%", lo: 0.7, hi: 0.8 },
  { label: "80-90%", lo: 0.8, hi: 0.9 },
  { label: "90-95%", lo: 0.9, hi: 0.95 },
  { label: "95-97.5%", lo: 0.95, hi: 0.975 },
  { label: "97.5-99%", lo: 0.975, hi: 0.99 },
  { label: "99%+", lo: 0.99, hi: 1.0000001 },
];

export const TIME_BUCKETS: readonly { label: string; lo: number; hi: number }[] = [
  { label: "300-120s", lo: 120, hi: Infinity },
  { label: "120-60s", lo: 60, hi: 120 },
  { label: "60-30s", lo: 30, hi: 60 },
  { label: "30-15s", lo: 15, hi: 30 },
  { label: "15-10s", lo: 10, hi: 15 },
  { label: "10-5s", lo: 5, hi: 10 },
  { label: "5-2s", lo: 2, hi: 5 },
  { label: "<2s", lo: -Infinity, hi: 2 },
];

export interface CalibrationRow {
  readonly bucket: string;
  readonly n: number;
  /** Mean predicted probability of the favoured side. */
  readonly predicted: number;
  /** Fraction of the time the favoured side won. */
  readonly observed: number;
  /** observed - predicted; negative means overconfident. */
  readonly calibrationError: number;
  readonly brier: number;
}

export function brierScore(obs: readonly Observation[]): number {
  if (obs.length === 0) return NaN;
  return obs.reduce((s, o) => s + (o.pUp - (o.outcomeUp ? 1 : 0)) ** 2, 0) / obs.length;
}

function summarise(bucket: string, obs: readonly Observation[]): CalibrationRow {
  const n = obs.length;
  if (n === 0) return { bucket, n: 0, predicted: NaN, observed: NaN, calibrationError: NaN, brier: NaN };
  const favouredUp = (o: Observation) => o.pUp >= 0.5;
  const predicted = obs.reduce((s, o) => s + Math.max(o.pUp, 1 - o.pUp), 0) / n;
  const observed = obs.filter((o) => favouredUp(o) === o.outcomeUp).length / n;
  return { bucket, n, predicted, observed, calibrationError: observed - predicted, brier: brierScore(obs) };
}

/** Calibration by confidence bucket, in the brief's segments. */
export function calibrationByConfidence(obs: readonly Observation[]): CalibrationRow[] {
  return CONFIDENCE_BUCKETS.map((b) =>
    summarise(b.label, obs.filter((o) => { const c = Math.max(o.pUp, 1 - o.pUp); return c >= b.lo && c < b.hi; })),
  );
}

export function calibrationByTime(obs: readonly Observation[]): CalibrationRow[] {
  return TIME_BUCKETS.map((b) => summarise(b.label, obs.filter((o) => o.secondsRemaining >= b.lo && o.secondsRemaining < b.hi)));
}

/**
 * Naive gross edge of following Jev's favoured side at the executable ask:
 * profit is 1 - ask when right, -ask when wrong. No fees, no fills, no
 * slippage - an upper bound, never a forecast of realised PnL.
 */
export function naiveEdge(o: Observation): { side: "UP" | "DOWN"; ask: number; won: boolean; executable: boolean; pnl: number; jevEdge: number } {
  const side = o.pUp >= 0.5 ? "UP" : "DOWN";
  const ask = side === "UP" ? o.upAsk : o.downAsk;
  const won = side === "UP" ? o.outcomeUp : !o.outcomeUp;
  const p = side === "UP" ? o.pUp : 1 - o.pUp;
  // An empty ask side is recorded as 1.0 (nothing to buy); a zero is a
  // broken book. Neither is a price anyone could have paid.
  const executable = ask > 0 && ask < 1;
  return { side, ask, won, executable, pnl: executable ? (won ? 1 - ask : -ask) : NaN, jevEdge: p - ask };
}

export interface EdgeRow {
  readonly bucket: string;
  readonly n: number;
  /** How often Jev's favoured side actually won, over all n. */
  readonly accuracy: number;
  /** Observations with a payable ask (0 < ask < 1); the price columns below are over these only. */
  readonly executable: number;
  readonly meanAsk: number;
  readonly meanJevEdge: number;
  /** Mean naive gross pnl per share over executable observations. */
  readonly meanPnl: number;
  /** Share of executable observations with positive pnl. */
  readonly winRate: number;
}

export function edgeSummary(bucket: string, obs: readonly Observation[]): EdgeRow {
  const n = obs.length;
  if (n === 0) return { bucket, n: 0, accuracy: NaN, executable: 0, meanAsk: NaN, meanJevEdge: NaN, meanPnl: NaN, winRate: NaN };
  const e = obs.map(naiveEdge);
  const ex = e.filter((x) => x.executable);
  const m = ex.length;
  return {
    bucket, n,
    accuracy: e.filter((x) => x.won).length / n,
    executable: m,
    meanAsk: m ? ex.reduce((s, x) => s + x.ask, 0) / m : NaN,
    meanJevEdge: m ? ex.reduce((s, x) => s + x.jevEdge, 0) / m : NaN,
    meanPnl: m ? ex.reduce((s, x) => s + x.pnl, 0) / m : NaN,
    winRate: m ? ex.filter((x) => x.pnl > 0).length / m : NaN,
  };
}

export function edgeByTime(obs: readonly Observation[]): EdgeRow[] {
  return TIME_BUCKETS.map((b) => edgeSummary(b.label, obs.filter((o) => o.secondsRemaining >= b.lo && o.secondsRemaining < b.hi)));
}

export const PRICE_BUCKETS: readonly { label: string; lo: number; hi: number }[] = [
  { label: "0.00-0.10", lo: 0, hi: 0.1 }, { label: "0.10-0.30", lo: 0.1, hi: 0.3 }, { label: "0.30-0.50", lo: 0.3, hi: 0.5 },
  { label: "0.50-0.70", lo: 0.5, hi: 0.7 }, { label: "0.70-0.90", lo: 0.7, hi: 0.9 }, { label: "0.90-0.97", lo: 0.9, hi: 0.97 },
  { label: "0.97-0.995", lo: 0.97, hi: 0.995 }, { label: "0.995-1.00", lo: 0.995, hi: 1.0001 },
];

/** Segment by the ask actually payable for the favoured side. */
export function edgeByPrice(obs: readonly Observation[]): EdgeRow[] {
  return PRICE_BUCKETS.map((b) => edgeSummary(b.label, obs.filter((o) => { const a = naiveEdge(o).ask; return a >= b.lo && a < b.hi; })));
}

export function toCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]!);
  const fmt = (v: unknown) => (typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(5) : "") : String(v ?? ""));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => fmt(r[c])).join(","))].join("\n") + "\n";
}
