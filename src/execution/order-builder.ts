import type { Action, Urgency } from "../jev/decision-types.js";
import type { MarketState } from "../market/market-state.js";
import type { OrderBook } from "../market/types.js";
import { bestAsk, depth } from "../features/orderbook.js";
import { styleFor, type OrderStyle, type UrgencyMap } from "./order-types.js";

/** What Jev decided, translated into something a book can receive. */
export interface OrderIntent {
  readonly side: "UP" | "DOWN";
  readonly assetId: string;
  /** Limit price. */
  readonly price: number;
  readonly size: number;
  readonly style: OrderStyle;
  /** Why this size: the binding constraint. */
  readonly sizedBy: "max_order" | "depth" | "complement" | "pair" | "risk";
  /** This leg pairs unpaired inventory into sets (a hedge). Engines keep such a bid resting until the close: re-placing it forfeits its queue position. */
  readonly completesSet?: boolean;
}

export interface SizingLimits {
  readonly maxOrderSizeShares: number;
  /** Remaining USD allowance under the exposure limits. */
  readonly riskAllowanceUsd: number;
  readonly tickSize: number;
  readonly minOrderSize: number;
  /**
   * Most a complete set may cost. A pair bought for at most 1.00 merges back
   * to 1.00, so the unpaired leg was free; above it, the hedge locks in a
   * loss. Default 1.00.
   */
  readonly maxPairCost?: number;
}

/** Depth-weighted quantity obtainable at or below `limit`. */
function obtainable(book: OrderBook, limit: number): number {
  return book.asks.filter((l) => l.price <= limit + 1e-12).reduce((s, l) => s + l.size, 0);
}

const roundTick = (p: number, tick: number) => Math.round(p / tick) * tick;

/**
 * Deterministic sizing (brief §9): size = min(configured maximum, target,
 * depth, risk allowance). The direction comes from Jev and is never changed
 * here; a decision that needs no order returns undefined.
 */
export function buildOrders(
  action: Action,
  urgency: Urgency,
  state: MarketState,
  limits: SizingLimits,
  map?: UrgencyMap,
): OrderIntent[] {
  const style = styleFor(urgency, map);
  if (!style || !state.upBook || !state.downBook) return [];

  const maxPair = limits.maxPairCost ?? 1.0;
  const leg = (side: "UP" | "DOWN", target: number, sizedBy: OrderIntent["sizedBy"], priceCap?: number): OrderIntent | undefined => {
    const book = side === "UP" ? state.upBook! : state.downBook!;
    const touch = bestAsk(book);
    // No ask at all (the usual shape of the leader's book late in a market):
    // only a capped leg can be priced, as a bid resting at its cap.
    if (touch === undefined && priceCap === undefined) return undefined;
    let price = touch === undefined ? 1 : Math.min(0.999, Math.max(0.001, roundTick(touch + style.aggressionTicks * limits.tickSize, limits.tickSize)));
    // A hedge above its cap would pay more than 1.00 for the pair: rest at the cap instead of crossing.
    if (priceCap !== undefined) {
      const cap = Math.floor(priceCap / limits.tickSize + 1e-9) * limits.tickSize;
      if (cap < limits.tickSize) return undefined;
      price = Math.min(price, Number(cap.toFixed(6)));
    }
    const resting = touch === undefined || price < touch - 1e-12;
    // A marketable leg takes what is offered at or under its price; a resting bid takes nothing from the ask side, so depth does not size it.
    const byDepth = resting ? Number.POSITIVE_INFINITY : obtainable(book, price);
    const byRisk = price > 0 ? limits.riskAllowanceUsd / price : 0;
    const candidates: [number, OrderIntent["sizedBy"]][] = [
      [limits.maxOrderSizeShares, "max_order"], [target, sizedBy], [byDepth, "depth"], [byRisk, "risk"],
    ];
    const [size, by] = candidates.reduce((a, b) => (b[0] < a[0] ? b : a));
    const rounded = Math.floor(size);
    if (rounded < limits.minOrderSize) return undefined;
    // Resting below the touch is a GTC bid whatever the urgency said: FOK/FAK at a price nobody offers fills nothing.
    const effectiveStyle = resting && (style.type === "FOK" || style.type === "FAK") ? { ...style, type: "GTC" as const, ttlMs: style.ttlMs ?? 20_000 } : style;
    return { side, assetId: side === "UP" ? state.identity.upAssetId : state.identity.downAssetId, price: Number(price.toFixed(4)), size: rounded, style: effectiveStyle, sizedBy: by, ...(priceCap !== undefined && sizedBy !== "pair" ? { completesSet: true } : {}) };
  };

  const inv = state.inventory;
  // Buying the side opposite to unpaired inventory completes sets: those may
  // never cost more than maxPair in total, whatever the action was called.
  const capUp = inv.unpairedDownShares > 0 ? maxPair - inv.avgDownEntry : undefined;
  const capDown = inv.unpairedUpShares > 0 ? maxPair - inv.avgUpEntry : undefined;
  switch (action) {
    case "BUY_UP": return [leg("UP", limits.maxOrderSizeShares, "max_order", capUp)].filter((x): x is OrderIntent => !!x);
    case "BUY_DOWN": return [leg("DOWN", limits.maxOrderSizeShares, "max_order", capDown)].filter((x): x is OrderIntent => !!x);
    case "BUY_PAIR": {
      // Both legs at the same size, or neither: a half-filled pair is a directional bet.
      // The set may cost at most maxPair in total: any slack under it is split
      // between the legs as aggression room, none at all is bought at the touch.
      const upTouch = bestAsk(state.upBook), downTouch = bestAsk(state.downBook);
      if (upTouch === undefined || downTouch === undefined) return [];
      // Opening a set outright needs it to cost less than it merges back to; at 1.00 it is churn.
      const openingCap = maxPair - 0.01;
      if (upTouch + downTouch > openingCap + 1e-9) return [];
      const slack = (openingCap - upTouch - downTouch) / 2;
      const up = leg("UP", limits.maxOrderSizeShares, "pair", upTouch + slack);
      const down = leg("DOWN", limits.maxOrderSizeShares, "pair", downTouch + slack);
      if (!up || !down) return [];
      const size = Math.min(up.size, down.size);
      return [{ ...up, size, sizedBy: "pair" }, { ...down, size, sizedBy: "pair" }];
    }
    case "ADD_COMPLEMENT": {
      // Buy the opposite of whatever is unpaired, to match it into pairs, at a
      // price that keeps the pair at or under maxPairCost (the tail was bought
      // at avgEntry; the hedge may cost at most maxPair - avgEntry).
      if (inv.unpairedUpShares > 0) return [leg("DOWN", inv.unpairedUpShares, "complement", maxPair - inv.avgUpEntry)].filter((x): x is OrderIntent => !!x);
      if (inv.unpairedDownShares > 0) return [leg("UP", inv.unpairedDownShares, "complement", maxPair - inv.avgDownEntry)].filter((x): x is OrderIntent => !!x);
      return [];
    }
    default:
      return [];
  }
}
