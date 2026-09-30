import { describe, expect, it, vi } from "vitest";
import { AuroraClient, findToken, MONAD_USDC_ASSET, waitForSwap } from "../src/lib/aurora";

const KEY = "test-key-123";
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("Aurora Intents client", () => {
  it("posts a quote with the documented fields and the key as a path segment", async () => {
    const f = vi.fn(async () => ok({ quote: { depositAddress: "0xdep", amountIn: "50000000", amountOut: "49900000" }, quoteRequest: {} }));
    const c = new AuroraClient(KEY, f as unknown as typeof fetch);
    await c.quote({ originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", destinationAsset: MONAD_USDC_ASSET, amount: "50000000", slippageBps: 50, refundTo: "0xme", recipient: "0xme" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://intents-api.aurora.dev/api/quote/${KEY}`);
    expect(JSON.parse(String(init.body))).toEqual({
      dry: false, swapType: "EXACT_INPUT", depositType: "ORIGIN_CHAIN", originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      destinationAsset: MONAD_USDC_ASSET, amount: "50000000", slippageTolerance: 50, refundTo: "0xme", refundType: "ORIGIN_CHAIN", recipient: "0xme", recipientType: "DESTINATION_CHAIN",
    });
  });

  it("calls deposit/submit and status with the key in the path", async () => {
    const f = vi.fn(async () => ok({ status: "PROCESSING" }));
    const c = new AuroraClient(KEY, f as unknown as typeof fetch);
    await c.submitDeposit("0xhash", "0xdep");
    await c.status("0xdep");
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`https://intents-api.aurora.dev/api/deposit/submit/${KEY}`);
    expect((f.mock.calls[1] as unknown as [string])[0]).toBe(`https://intents-api.aurora.dev/api/status/${KEY}?depositAddress=0xdep`);
  });

  it("never puts the key in an error message", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ message: `bad key ${KEY}` }), { status: 404 }));
    const c = new AuroraClient(KEY, f as unknown as typeof fetch);
    await expect(c.status("0xdep")).rejects.toThrow(/bad key \*\*\*/);
  });

  it("finds the origin asset by chain code and symbol", () => {
    const tokens = [{ assetId: "a", decimals: 6, blockchain: "base", symbol: "USDC", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }, { assetId: "b", decimals: 6, blockchain: "arb", symbol: "USDC" }];
    expect(findToken(tokens, "base", "usdc").assetId).toBe("a");
    expect(() => findToken(tokens, "op", "USDC")).toThrow(/is on: base, arb/);
  });

  it("polls until a terminal status and reports each change, including a refund", async () => {
    const seq = ["PENDING_DEPOSIT", "PENDING_DEPOSIT", "PROCESSING", "REFUNDED"];
    const client = { status: vi.fn(async () => ({ status: seq.shift()!, swapDetails: { refundedAmountFormatted: "49.9", refundReason: "slippage" } })) };
    const changes: string[] = [];
    const r = await waitForSwap(client, "0xdep", { sleep: async () => {}, onChange: (s) => changes.push(s.status) });
    expect(r.status).toBe("REFUNDED");
    expect(r.swapDetails?.refundReason).toBe("slippage");
    expect(changes).toEqual(["PENDING_DEPOSIT", "PROCESSING", "REFUNDED"]);
  });
});
