import { applyMerge, computeInventory, type Position } from "./accounting.js";

/**
 * Merge and settlement economics (brief §20, §21), as pure functions so the
 * paper engine and the real adapters share one definition of "profit".
 */
export interface MergeResult {
  readonly quantity: number;
  readonly pairedCostBasis: number;
  readonly collateralReturned: number;
  readonly gas: number;
  readonly effectivePairPnl: number;
  readonly position: Position;
}

/** Merge up to `quantity` matched pairs back into collateral at 1.00 each. */
export function simulateMerge(position: Position, quantity: number, gas = 0): MergeResult | undefined {
  const inv = computeInventory(position);
  const q = Math.min(quantity, inv.pairedShares);
  if (!(q > 0)) return undefined;
  const pairedCostBasis = q * (inv.avgUpEntry + inv.avgDownEntry);
  const collateralReturned = q;
  return {
    quantity: q,
    pairedCostBasis,
    collateralReturned,
    gas,
    effectivePairPnl: collateralReturned - pairedCostBasis - gas,
    position: applyMerge(position, q),
  };
}

export interface SettlementResult {
  readonly outcome: "UP" | "DOWN";
  readonly winningShares: number;
  readonly grossPayout: number;
  readonly costBasis: number;
  readonly feesGas: number;
  readonly netPnl: number;
}

/** Redeem what is left after the market resolves. */
export function settle(position: Position, outcome: "UP" | "DOWN", feesGas = 0): SettlementResult {
  const inv = computeInventory(position);
  const winningShares = outcome === "UP" ? inv.upShares : inv.downShares;
  const grossPayout = winningShares;
  return {
    outcome,
    winningShares,
    grossPayout,
    costBasis: inv.totalCost,
    feesGas,
    netPnl: grossPayout - inv.totalCost - feesGas,
  };
}

export interface MarketPnl {
  readonly mergePnl: number;
  readonly settlementPnl: number;
  readonly fees: number;
  readonly gas: number;
  readonly netPnl: number;
  readonly grossPnl: number;
}

/** Combine merges and settlement into one per-market figure. */
export function marketPnl(merges: readonly MergeResult[], settlement: SettlementResult, fillFees: number): MarketPnl {
  const mergePnl = merges.reduce((s, m) => s + m.effectivePairPnl, 0);
  const gas = merges.reduce((s, m) => s + m.gas, 0) + settlement.feesGas;
  const grossPnl = merges.reduce((s, m) => s + (m.collateralReturned - m.pairedCostBasis), 0) + (settlement.grossPayout - settlement.costBasis);
  return { mergePnl, settlementPnl: settlement.netPnl, fees: fillFees, gas, grossPnl, netPnl: grossPnl - fillFees - gas };
}
