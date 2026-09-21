import type { Urgency } from "../jev/decision-types.js";

/** The CLOB order types, all four confirmed in @polymarket/types. */
export type OrderType = "GTC" | "GTD" | "FAK" | "FOK";

export interface OrderStyle {
  readonly type: OrderType;
  /** How far past the touch the limit may go, in price units. 0 = at the touch. */
  readonly aggressionTicks: number;
  /** For GTD: lifetime in ms. */
  readonly ttlMs?: number;
}

/**
 * Jev selects urgency; order mechanics map it to an order style (brief §17).
 * Configurable, and deliberately not clever: it never changes the side.
 */
export type UrgencyMap = Readonly<Record<Exclude<Urgency, "DO_NOT_TRADE">, OrderStyle>>;

export const DEFAULT_URGENCY_MAP: UrgencyMap = {
  PASSIVE: { type: "GTD", aggressionTicks: -1, ttlMs: 20_000 }, // rest one tick inside the touch
  NORMAL: { type: "GTC", aggressionTicks: 0 },                  // at the touch
  URGENT: { type: "FAK", aggressionTicks: 2 },                  // cross up to two ticks
  IMMEDIATE: { type: "FOK", aggressionTicks: 5 },               // fill now or not at all
};

export function styleFor(urgency: Urgency, map: UrgencyMap = DEFAULT_URGENCY_MAP): OrderStyle | undefined {
  return urgency === "DO_NOT_TRADE" ? undefined : map[urgency];
}
