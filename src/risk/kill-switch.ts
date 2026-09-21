/**
 * Kill switch (brief §16).
 *
 * Two classes of trigger. Transient ones - a stale feed, Jev unreachable -
 * latch while the condition holds and clear on their own once it has been
 * healthy for `recoveryMs`; otherwise a three-second socket hiccup would end
 * an overnight run. Hard ones - daily loss, reconciliation or wallet
 * mismatch, unexpected token ids, ACK inconsistency, manual - stay tripped
 * until an operator resumes.
 *
 * On trip the bot stops creating orders, cancels resting ones, reconciles,
 * persists state and logs the reason. It never liquidates at arbitrary
 * prices: an open position is held, not dumped into a book that may be the
 * reason the switch fired.
 */
export type KillReason =
  | "CHAINLINK_STALE"
  | "MARKET_WS_STALE"
  | "CLOCK_DRIFT"
  | "UNKNOWN_SETTLEMENT_CONFIG"
  | "JEV_UNAVAILABLE"
  | "JEV_TIMEOUT"
  | "JEV_INVALID"
  | "POLYMARKET_API_ERRORS"
  | "INVENTORY_MISMATCH"
  | "WALLET_MISMATCH"
  | "UNEXPECTED_TOKEN_IDS"
  | "ACK_INCONSISTENCY"
  | "DAILY_LOSS"
  | "MANUAL";

const HARD: ReadonlySet<KillReason> = new Set<KillReason>([
  "UNKNOWN_SETTLEMENT_CONFIG", "INVENTORY_MISMATCH", "WALLET_MISMATCH", "UNEXPECTED_TOKEN_IDS", "ACK_INCONSISTENCY", "DAILY_LOSS", "MANUAL",
]);

export const isHardReason = (r: KillReason): boolean => HARD.has(r);

export interface KillThresholds {
  readonly maxChainlinkAgeMs: number;
  readonly maxMarketWsAgeMs: number;
  readonly maxClockDriftMs: number;
  /** Consecutive Jev failures (unavailable / timeout / invalid) before tripping. */
  readonly maxJevFailures: number;
  /** Polymarket API errors inside the window before tripping. */
  readonly maxApiErrorsPerWindow: number;
  readonly apiErrorWindowMs: number;
  readonly maxDailyLossUsd: number;
  /** How long a transient condition must be healthy before the switch clears. */
  readonly recoveryMs: number;
}

export const DEFAULT_KILL_THRESHOLDS: KillThresholds = {
  maxChainlinkAgeMs: 10_000,
  maxMarketWsAgeMs: 10_000,
  maxClockDriftMs: 3_000,
  maxJevFailures: 5,
  maxApiErrorsPerWindow: 10,
  apiErrorWindowMs: 60_000,
  maxDailyLossUsd: 50,
  recoveryMs: 30_000,
};

/** What the monitor sees each evaluation. Ages are Infinity before first data. */
export interface HealthInput {
  readonly nowMono: number;
  readonly chainlinkAgeMs: number;
  readonly marketWsAgeMs: number;
  readonly clockDriftMs: number;
  readonly dailyPnlUsd: number;
}

export interface KillState {
  readonly tripped: boolean;
  readonly reasons: readonly KillReason[];
  readonly since: number | undefined;
  readonly hard: boolean;
}

export interface KillActions {
  onTrip(reasons: readonly KillReason[]): void;
  onClear(): void;
}

export class KillSwitch {
  private active = new Set<KillReason>();
  private since: number | undefined;
  private healthySince: number | undefined;
  private jevFailures = 0;
  private apiErrors: number[] = [];
  private startedMono: number | undefined;

  constructor(
    private readonly t: KillThresholds = DEFAULT_KILL_THRESHOLDS,
    private readonly actions: KillActions = { onTrip: () => {}, onClear: () => {} },
  ) {}

  state(): KillState {
    const reasons = [...this.active];
    return { tripped: reasons.length > 0, reasons, since: this.since, hard: reasons.some(isHardReason) };
  }

  /** Feed-independent events, counted by the caller as they happen. */
  jevFailed(kind: "JEV_UNAVAILABLE" | "JEV_TIMEOUT" | "JEV_INVALID", nowMono: number): void {
    this.jevFailures++;
    if (this.jevFailures >= this.t.maxJevFailures) this.trip(kind, nowMono);
  }
  jevSucceeded(): void {
    this.jevFailures = 0;
  }
  apiError(nowMono: number): void {
    this.apiErrors.push(nowMono);
    this.apiErrors = this.apiErrors.filter((t) => nowMono - t <= this.t.apiErrorWindowMs);
    if (this.apiErrors.length >= this.t.maxApiErrorsPerWindow) this.trip("POLYMARKET_API_ERRORS", nowMono);
  }
  hardFault(reason: Extract<KillReason, "INVENTORY_MISMATCH" | "WALLET_MISMATCH" | "UNEXPECTED_TOKEN_IDS" | "ACK_INCONSISTENCY" | "UNKNOWN_SETTLEMENT_CONFIG">, nowMono: number): void {
    this.trip(reason, nowMono);
  }
  manualKill(nowMono: number): void {
    this.trip("MANUAL", nowMono);
  }

  /** Operator resume: clears everything, including hard reasons. */
  resume(): void {
    if (this.active.size === 0) return;
    this.active.clear();
    this.since = undefined;
    this.healthySince = undefined;
    this.jevFailures = 0;
    this.apiErrors = [];
    this.actions.onClear();
  }

  /**
   * Evaluate the continuous conditions. Transient reasons are added while
   * their condition holds and removed after `recoveryMs` of health; hard
   * reasons are never removed here.
   */
  evaluate(h: HealthInput): KillState {
    this.startedMono ??= h.nowMono;
    const warmingUp = h.nowMono - this.startedMono < 15_000; // feeds need a moment after start
    const transient: Array<[KillReason, boolean]> = [
      ["CHAINLINK_STALE", !warmingUp && h.chainlinkAgeMs > this.t.maxChainlinkAgeMs],
      ["MARKET_WS_STALE", !warmingUp && h.marketWsAgeMs > this.t.maxMarketWsAgeMs],
      ["CLOCK_DRIFT", Number.isFinite(h.clockDriftMs) && Math.abs(h.clockDriftMs) > this.t.maxClockDriftMs],
    ];
    if (h.dailyPnlUsd <= -this.t.maxDailyLossUsd) this.trip("DAILY_LOSS", h.nowMono);

    let anyBad = false;
    for (const [reason, bad] of transient) {
      if (bad) { anyBad = true; this.trip(reason, h.nowMono); }
    }
    if (anyBad) {
      this.healthySince = undefined;
    } else if (this.active.size > 0 && ![...this.active].some(isHardReason)) {
      this.healthySince ??= h.nowMono;
      if (h.nowMono - this.healthySince >= this.t.recoveryMs) {
        this.active.clear();
        this.since = undefined;
        this.healthySince = undefined;
        this.actions.onClear();
      }
    }
    return this.state();
  }

  private trip(reason: KillReason, nowMono: number): void {
    const wasTripped = this.active.size > 0;
    if (this.active.has(reason)) return;
    this.active.add(reason);
    this.since ??= nowMono;
    this.healthySince = undefined;
    if (!wasTripped || isHardReason(reason)) this.actions.onTrip([...this.active]);
  }
}
