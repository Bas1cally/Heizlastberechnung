import type { OrderBook } from "./types.js";
import type { InventoryAccounting } from "../inventory/accounting.js";

/** Identity of one BTC 5-minute market as discovered from Gamma. */
export interface MarketIdentity {
  readonly marketId: string;
  readonly conditionId: string;
  readonly slug: string;
  readonly question: string;
  readonly upAssetId: string;
  readonly downAssetId: string;
  readonly openedAtMs: number;
  readonly closesAtMs: number;
  readonly tickSize: number | undefined;
  readonly minOrderSize: number | undefined;
}

/** The canonical, versioned in-memory state for one market. */
export interface MarketState {
  readonly stateVersion: bigint;
  readonly identity: MarketIdentity;

  readonly nowMs: number;
  readonly secondsRemaining: number;

  readonly upBook: OrderBook | undefined;
  readonly downBook: OrderBook | undefined;

  readonly settlementStartPrice: number | undefined;
  readonly settlementCurrentPrice: number | undefined;
  readonly settlementUpdatedAtMs: number | undefined;

  readonly inventory: InventoryAccounting;
  readonly openOrderCount: number;
}

/**
 * Holds the mutable pieces and hands out immutable, versioned snapshots.
 * Every mutation bumps `stateVersion`; a decision made on an older version
 * is rejected by the risk gate before it can reach the book.
 */
export class MarketStateStore {
  private version = 0n;
  private upBook: OrderBook | undefined;
  private downBook: OrderBook | undefined;
  private startPrice: number | undefined;
  private currentPrice: number | undefined;
  private settlementAtMs: number | undefined;
  private openOrders = 0;

  constructor(
    readonly identity: MarketIdentity,
    private inventory: InventoryAccounting,
  ) {}

  get stateVersion(): bigint {
    return this.version;
  }

  private bump(): void {
    this.version += 1n;
  }

  setBook(book: OrderBook): boolean {
    if (book.assetId === this.identity.upAssetId) this.upBook = book;
    else if (book.assetId === this.identity.downAssetId) this.downBook = book;
    else return false;
    this.bump();
    return true;
  }

  /**
   * Record a settlement-feed price. The first price observed at or after the
   * market opened becomes the start price; that rule is an assumption about
   * how these markets resolve and must be confirmed against the market's
   * stated resolution source (see docs/DEPENDENCIES.md).
   */
  setSettlementPrice(price: number, atMs: number): void {
    if (this.startPrice === undefined && atMs >= this.identity.openedAtMs) this.startPrice = price;
    this.currentPrice = price;
    this.settlementAtMs = atMs;
    this.bump();
  }

  /** Explicit override when the true open price is known from elsewhere. */
  setSettlementStartPrice(price: number): void {
    this.startPrice = price;
    this.bump();
  }

  setInventory(inventory: InventoryAccounting): void {
    this.inventory = inventory;
    this.bump();
  }

  setOpenOrderCount(n: number): void {
    this.openOrders = n;
    this.bump();
  }

  snapshot(nowMs: number): MarketState {
    return {
      stateVersion: this.version,
      identity: this.identity,
      nowMs,
      secondsRemaining: Math.max(0, (this.identity.closesAtMs - nowMs) / 1000),
      upBook: this.upBook,
      downBook: this.downBook,
      settlementStartPrice: this.startPrice,
      settlementCurrentPrice: this.currentPrice,
      settlementUpdatedAtMs: this.settlementAtMs,
      inventory: this.inventory,
      openOrderCount: this.openOrders,
    };
  }
}
