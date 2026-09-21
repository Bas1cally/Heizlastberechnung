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
}

export interface SizingLimits {
  readonly maxOrderSizeShares: number;
  /** Remaining USD allowance under the exposure limits. */
  readonly riskAllowanceUsd: number;
  readonly tickSize: number;
  readonly minOrderSize: number;
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

  const leg = (side: "UP" | "DOWN", target: number, sizedBy: OrderIntent["sizedBy"]): OrderIntent | undefined => {
    const book = side === "UP" ? state.upBook! : state.downBook!;
    const touch = bestAsk(book);
    if (touch === undefined) return undefined;
    const price = Math.min(0.999, Math.max(0.001, roundTick(touch + style.aggressionTicks * limits.tickSize, limits.tickSize)));
    const byDepth = style.aggressionTicks < 0 ? depth(book.asks) : obtainable(book, price);
    const byRisk = price > 0 ? limits.riskAllowanceUsd / price : 0;
    const candidates: [number, OrderIntent["sizedBy"]][] = [
      [limits.maxOrderSizeShares, "max_order"], [target, sizedBy], [byDepth, "depth"], [byRisk, "risk"],
    ];
    const [size, by] = candidates.reduce((a, b) => (b[0] < a[0] ? b : a));
    const rounded = Math.floor(size);
    if (rounded < limits.minOrderSize) return undefined;
    return { side, assetId: side === "UP" ? state.identity.upAssetId : state.identity.downAssetId, price: Number(price.toFixed(4)), size: rounded, style, sizedBy: by };
  };

  const inv = state.inventory;
  switch (action) {
    case "BUY_UP": return [leg("UP", limits.maxOrderSizeShares, "max_order")].filter((x): x is OrderIntent => !!x);
    case "BUY_DOWN": return [leg("DOWN", limits.maxOrderSizeShares, "max_order")].filter((x): x is OrderIntent => !!x);
    case "BUY_PAIR": {
      // Both legs at the same size, or neither: a half-filled pair is a directional bet.
      const up = leg("UP", limits.maxOrderSizeShares, "pair");
      const down = leg("DOWN", limits.maxOrderSizeShares, "pair");
      if (!up || !down) return [];
      const size = Math.min(up.size, down.size);
      return [{ ...up, size, sizedBy: "pair" }, { ...down, size, sizedBy: "pair" }];
    }
    case "ADD_COMPLEMENT": {
      // Buy the opposite of whatever is unpaired, to match it into pairs.
      if (inv.unpairedUpShares > 0) return [leg("DOWN", inv.unpairedUpShares, "complement")].filter((x): x is OrderIntent => !!x);
      if (inv.unpairedDownShares > 0) return [leg("UP", inv.unpairedDownShares, "complement")].filter((x): x is OrderIntent => !!x);
      return [];
    }
    default:
      return [];
  }
}
