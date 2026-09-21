import type { Urgency } from "../jev/decision-types.js";

/** The CLOB order types, all four confirmed in @polymarket/types. */
export type OrderType = "GTC" | "GTD" | "FAK" | "FOK";

export interface OrderStyle {
  readonly type: OrderType;
  /** How far past the touch the limit may go, in ticks. Negative rests inside the touch. */
  readonly aggressionTicks: number;
  /** How long we keep a resting order before cancelling it ourselves, in ms. */
  readonly ttlMs?: number;
  /** Reject rather than take if the order would cross (maker only). */
  readonly postOnly?: boolean;
}

/**
 * Jev selects urgency; order mechanics map it to an order style (brief §17).
 * Configurable, and deliberately not clever: it never changes the side.
 */
export type UrgencyMap = Readonly<Record<Exclude<Urgency, "DO_NOT_TRADE">, OrderStyle>>;

/**
 * GTD is not usable here: the SDK documents a minimum expiration of three
 * minutes, longer than most of a 5-minute market. Resting orders are GTC
 * with a lifetime we enforce ourselves by cancelling.
 */
export const DEFAULT_URGENCY_MAP: UrgencyMap = {
  PASSIVE: { type: "GTC", aggressionTicks: -1, ttlMs: 20_000, postOnly: true }, // rest one tick inside the touch
  NORMAL: { type: "GTC", aggressionTicks: 0, ttlMs: 10_000 },                   // at the touch
  URGENT: { type: "FAK", aggressionTicks: 2 },                                  // cross up to two ticks
  IMMEDIATE: { type: "FOK", aggressionTicks: 5 },                               // fill now or not at all
};

export function styleFor(urgency: Urgency, map: UrgencyMap = DEFAULT_URGENCY_MAP): OrderStyle | undefined {
  return urgency === "DO_NOT_TRADE" ? undefined : map[urgency];
}
