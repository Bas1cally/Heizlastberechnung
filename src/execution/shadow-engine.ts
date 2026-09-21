import type { OrderIntent } from "./order-builder.js";
import type { OrderBook } from "../market/types.js";
import { fillMarketable, isMarketable, type FillParams, type FillResult } from "../replay/paper-fill-model.js";

/**
 * Shadow execution (brief §39): connect like live, build and SIGN the real
 * order, and stop immediately before submission. What gets measured is
 * whether the edge survives the real path: signal time, Jev response,
 * signing time, expected execution price at decision, and what the book
 * actually did before the hypothetical ACK.
 *
 * The signer is injected so this engine never touches the SDK directly and
 * can be driven in tests. Whatever implements it must not submit anything.
 */
export interface SignedOrderLike {
  readonly tokenId: string;
  readonly side: string;
  readonly makerAmount: string;
  readonly takerAmount: string;
  readonly orderType: string;
  readonly signature: string;
}

export interface OrderSigner {
  /** Signs but never posts. Throws on signing failure. */
  sign(intent: OrderIntent): Promise<SignedOrderLike>;
}

export interface ShadowStamps {
  readonly decisionMono: number;
  readonly signingStartedMono: number;
  readonly signingCompletedMono: number;
  /** When a real submission would have been ACKed: signing done + assumed submit-to-ack. */
  readonly hypotheticalAckMono: number;
}

export interface ShadowRecord {
  readonly decisionId: string;
  readonly intent: OrderIntent;
  readonly signed: SignedOrderLike | undefined;
  readonly signError: string | undefined;
  readonly stamps: ShadowStamps;
  /** Best ask when the order was built. */
  readonly expectedPrice: number;
  /** Best ask at the hypothetical ACK, once observed. */
  readonly priceAtAck: number | undefined;
  readonly movedAgainstBps: number | undefined;
  readonly hypotheticalFill: FillResult | undefined;
}

export interface ShadowEngineOptions {
  readonly signer: OrderSigner;
  readonly mono: () => number;
  /** Assumed submit-to-ACK time; measured properly only in live mode. */
  readonly assumedSubmitToAckMs: number;
  readonly fill: FillParams;
  readonly onRecord: (r: ShadowRecord) => void;
}

interface Pending {
  readonly base: Omit<ShadowRecord, "priceAtAck" | "movedAgainstBps" | "hypotheticalFill">;
}

export class ShadowEngine {
  private readonly pending: Pending[] = [];

  constructor(private readonly opts: ShadowEngineOptions) {}

  /** Called on an APPROVED decision with the orders it implies and the book they were built on. */
  async submit(decisionId: string, intents: readonly OrderIntent[], bookFor: (assetId: string) => OrderBook | undefined, decisionMono: number): Promise<void> {
    for (const intent of intents) {
      const book = bookFor(intent.assetId);
      const expectedPrice = book?.asks[0]?.price ?? NaN;
      const signingStartedMono = this.opts.mono();
      let signed: SignedOrderLike | undefined;
      let signError: string | undefined;
      try {
        signed = await this.opts.signer.sign(intent);
      } catch (err) {
        signError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
      const signingCompletedMono = this.opts.mono();
      // Signed and stopped. Nothing is posted, in any configuration.
      this.pending.push({
        base: {
          decisionId, intent, signed, signError,
          stamps: { decisionMono, signingStartedMono, signingCompletedMono, hypotheticalAckMono: signingCompletedMono + this.opts.assumedSubmitToAckMs },
          expectedPrice,
        },
      });
    }
  }

  /** Feed every book update; pending orders resolve once the hypothetical ACK time has passed. */
  onBook(book: OrderBook, nowMono: number): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (p.base.intent.assetId !== book.assetId || nowMono < p.base.stamps.hypotheticalAckMono) continue;
      this.pending.splice(i, 1);
      const priceAtAck = book.asks[0]?.price;
      const moved = priceAtAck !== undefined && Number.isFinite(p.base.expectedPrice) && p.base.expectedPrice > 0
        ? ((priceAtAck - p.base.expectedPrice) / p.base.expectedPrice) * 10_000
        : undefined;
      const fill = p.base.signed && isMarketable(p.base.intent, book) ? fillMarketable(p.base.intent, book, this.opts.fill) : p.base.signed ? { status: "RESTING" as const, filledQty: 0, avgPrice: 0, fee: 0, reason: "would rest on the book" } : undefined;
      this.opts.onRecord({ ...p.base, priceAtAck, movedAgainstBps: moved, hypotheticalFill: fill });
    }
  }

  /** Resolve whatever is still pending with the last known book (market closed). */
  flush(bookFor: (assetId: string) => OrderBook | undefined): void {
    for (const p of this.pending.splice(0)) {
      const book = bookFor(p.base.intent.assetId);
      this.opts.onRecord({ ...p.base, priceAtAck: book?.asks[0]?.price, movedAgainstBps: undefined, hypotheticalFill: undefined });
    }
  }

  pendingCount(): number {
    return this.pending.length;
  }
}
