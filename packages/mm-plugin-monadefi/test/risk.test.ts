// The adapter with the real @app/risk engine. No key and a failing fetch: no network is used.
import { afterEach, describe, expect, it, vi } from "vitest";
import { assessTrade } from "../src/lib/risk";

afterEach(() => vi.unstubAllGlobals());

describe("risk adapter (real engine)", () => {
  it("applies the engine's no-data policy without a key: cap 3x and a tight stop", async () => {
    const v = await assessTrade({ market: "ETH", side: "long", leverage: 5, marginUsd: 20, marketMaxLeverage: 12 });
    expect(v.dataAvailable).toBe(false);
    expect(v.decision).toBe("reduce");
    expect(v.adjusted.maxLeverage).toBe(3);
    expect(v.adjusted.requireStopLoss).toBe(true);
    expect(v.adjusted.stopLossDistancePct).toBe(3);
    expect(v.reasons.join(" ")).toMatch(/nansen-key/);
  });

  it("returns no-data when Nansen answers with errors, and does not leak the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 })));
    const v = await assessTrade({ apiKey: "nk-secret-zzz", market: "ETH", side: "short", leverage: 2, marginUsd: 20, marketMaxLeverage: 12 });
    expect(v.dataAvailable).toBe(false);
    expect(JSON.stringify(v)).not.toContain("nk-secret-zzz");
  });
});
