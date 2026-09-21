import type { OrderIntent } from "./order-builder.js";
import type { OrderSigner, SignedOrderLike } from "./shadow-engine.js";

/**
 * Maps an OrderIntent onto the SDK's signing calls (verified in
 * @polymarket/client types: createLimitOrder / createMarketOrder return a
 * SignedOrder and do not submit; postOrder submits).
 *
 * The client is typed as the two methods used, so this adapter never has a
 * handle to postOrder. A signer built from it cannot submit by construction.
 */
export interface SigningClientLike {
  createLimitOrder(req: { assetId: string; price: number; size: number; side: "BUY" | "SELL"; postOnly?: boolean }): Promise<SignedOrderLike>;
  createMarketOrder(req: { assetId: string; amount: number; maxSpend: number; maxPrice: number; side: "BUY"; orderType: "FAK" | "FOK" }): Promise<SignedOrderLike>;
}

export function sdkSigner(client: SigningClientLike): OrderSigner {
  return {
    async sign(intent: OrderIntent): Promise<SignedOrderLike> {
      const side = "BUY"; // the bot only ever buys outcome tokens; merging and redemption return collateral
      if (intent.style.type === "FAK" || intent.style.type === "FOK") {
        // Market buy: `amount` is USD notional before fees, `maxSpend` caps the
        // all-in spend including fees (the SDK trims the amount to fit), and
        // `maxPrice` is the worst acceptable price per share.
        const notional = Number((intent.price * intent.size).toFixed(6));
        return client.createMarketOrder({
          assetId: intent.assetId,
          amount: notional,
          maxSpend: notional,
          maxPrice: intent.price,
          side,
          orderType: intent.style.type,
        });
      }
      return client.createLimitOrder({
        assetId: intent.assetId,
        price: intent.price,
        size: intent.size,
        side,
        ...(intent.style.postOnly ? { postOnly: true } : {}),
      });
    },
  };
}

/** Narrow a full SDK secure client down to the signing surface. */
export function signingSurface(client: { createLimitOrder: (...a: never[]) => unknown; createMarketOrder: (...a: never[]) => unknown }): SigningClientLike {
  return {
    createLimitOrder: (req) => (client.createLimitOrder as unknown as (r: unknown) => Promise<SignedOrderLike>)(req),
    createMarketOrder: (req) => (client.createMarketOrder as unknown as (r: unknown) => Promise<SignedOrderLike>)(req),
  };
}
