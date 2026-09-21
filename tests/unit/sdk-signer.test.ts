import { describe, expect, it, vi } from "vitest";
import { sdkSigner } from "../../src/execution/sdk-signer.js";
import type { OrderIntent } from "../../src/execution/order-builder.js";

const signed = { tokenId: "t", side: "BUY", makerAmount: "1", takerAmount: "1", orderType: "GTC", signature: "0x" };
const intent = (type: "GTC" | "FAK" | "FOK", postOnly = false): OrderIntent =>
  ({ side: "UP", assetId: "UP", price: 0.45, size: 40, style: { type, aggressionTicks: 0, postOnly }, sizedBy: "max_order" });

describe("sdkSigner", () => {
  it("signs resting orders as limit orders with the exact price and size", async () => {
    const client = { createLimitOrder: vi.fn(async () => signed), createMarketOrder: vi.fn(async () => signed) };
    await sdkSigner(client).sign(intent("GTC", true));
    expect(client.createLimitOrder).toHaveBeenCalledWith({ assetId: "UP", price: 0.45, size: 40, side: "BUY", postOnly: true });
    expect(client.createMarketOrder).not.toHaveBeenCalled();
  });

  it("signs FAK/FOK as market buys with collateral amount and a max price", async () => {
    const client = { createLimitOrder: vi.fn(async () => signed), createMarketOrder: vi.fn(async () => signed) };
    await sdkSigner(client).sign(intent("FOK"));
    expect(client.createMarketOrder).toHaveBeenCalledWith({ assetId: "UP", amount: 18, maxSpend: 18, maxPrice: 0.45, side: "BUY", orderType: "FOK" });
  });

  it("has no path to submission", () => {
    const client = { createLimitOrder: vi.fn(async () => signed), createMarketOrder: vi.fn(async () => signed), postOrder: vi.fn() };
    const s = sdkSigner(client);
    expect(Object.keys(s)).toEqual(["sign"]);
    expect(client.postOrder).not.toHaveBeenCalled();
  });
});
