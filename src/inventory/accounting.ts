/**
 * Inventory accounting.
 *
 * This is trading state, not bookkeeping done after the fact: the bot may not
 * add a position without already knowing what it is worth under both
 * settlement outcomes. Every field here is derived, so it cannot drift from
 * the share counts it came from.
 */

export interface Position {
  readonly upShares: number;
  readonly downShares: number;
  /** Average entry price per UP share. Ignored when upShares is 0. */
  readonly avgUpEntry: number;
  /** Average entry price per DOWN share. Ignored when downShares is 0. */
  readonly avgDownEntry: number;
}

export interface InventoryAccounting {
  readonly upShares: number;
  readonly downShares: number;
  readonly avgUpEntry: number;
  readonly avgDownEntry: number;

  /** Always min(upShares, downShares). */
  readonly pairedShares: number;
  readonly unpairedUpShares: number;
  readonly unpairedDownShares: number;

  readonly totalCost: number;

  /** Collateral recoverable by merging the matched shares, at 1.00 each. */
  readonly mergeableCollateral: number;

  readonly worstCaseSettlementValue: number;
  readonly bestCaseSettlementValue: number;

  readonly pnlIfUp: number;
  readonly pnlIfDown: number;

  /** Profit already locked in on matched shares, independent of the outcome. */
  readonly guaranteedPairPnl: number;
}

/** Winning shares settle at 1.00, losing shares at 0. */
const SETTLEMENT_VALUE = 1;

export function computeInventory(position: Position): InventoryAccounting {
  const upShares = Math.max(0, position.upShares);
  const downShares = Math.max(0, position.downShares);
  const avgUpEntry = upShares > 0 ? position.avgUpEntry : 0;
  const avgDownEntry = downShares > 0 ? position.avgDownEntry : 0;

  const pairedShares = Math.min(upShares, downShares);
  const totalCost = upShares * avgUpEntry + downShares * avgDownEntry;

  // Only the winning side pays out, so each outcome's value is that side's
  // share count. Cost is already sunk against both.
  const valueIfUp = upShares * SETTLEMENT_VALUE;
  const valueIfDown = downShares * SETTLEMENT_VALUE;

  return {
    upShares,
    downShares,
    avgUpEntry,
    avgDownEntry,

    pairedShares,
    unpairedUpShares: upShares - pairedShares,
    unpairedDownShares: downShares - pairedShares,

    totalCost,
    mergeableCollateral: pairedShares * SETTLEMENT_VALUE,

    worstCaseSettlementValue: Math.min(valueIfUp, valueIfDown),
    bestCaseSettlementValue: Math.max(valueIfUp, valueIfDown),

    pnlIfUp: valueIfUp - totalCost,
    pnlIfDown: valueIfDown - totalCost,

    // A matched pair costs avgUp + avgDown and redeems for 1.00.
    guaranteedPairPnl:
      pairedShares * (SETTLEMENT_VALUE - avgUpEntry - avgDownEntry),
  };
}

/** Fold a fill into a position, updating the weighted average entry. */
export function applyFill(
  position: Position,
  side: "UP" | "DOWN",
  shares: number,
  price: number,
): Position {
  if (!(shares > 0)) return position;

  if (side === "UP") {
    const total = position.upShares + shares;
    return {
      ...position,
      upShares: total,
      avgUpEntry: (position.upShares * position.avgUpEntry + shares * price) / total,
    };
  }
  const total = position.downShares + shares;
  return {
    ...position,
    downShares: total,
    avgDownEntry:
      (position.downShares * position.avgDownEntry + shares * price) / total,
  };
}

/**
 * Remove `shares` from each side after a merge.
 *
 * Average entry prices are deliberately unchanged: merging removes matched
 * shares at their existing basis, so the remaining shares keep theirs.
 */
export function applyMerge(position: Position, shares: number): Position {
  const merged = Math.min(shares, position.upShares, position.downShares);
  if (!(merged > 0)) return position;
  return {
    ...position,
    upShares: position.upShares - merged,
    downShares: position.downShares - merged,
  };
}

export const EMPTY_POSITION: Position = {
  upShares: 0,
  downShares: 0,
  avgUpEntry: 0,
  avgDownEntry: 0,
};
