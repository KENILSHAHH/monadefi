// The adapter with a stubbed engine: normalization, failure handling, monitor mapping.
import { afterEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  POLICY: { noDataMaxLeverage: 3, minStopPct: 0.5, tightStopCapPct: 3, stopShareOfLiqDistance: 0.5 },
  assessTrade: vi.fn(async (_i: unknown): Promise<unknown> => ({})),
  monitorPosition: vi.fn(async (_i: unknown): Promise<unknown> => ({})),
  applyVerdict: vi.fn(),
}));
vi.mock("../src/lib/riskEngine", () => engine);

const { assessTrade, monitorPosition, noDataVerdict } = await import("../src/lib/risk");
const input = { market: "ETH", side: "long" as const, leverage: 5, marginUsd: 20, marketMaxLeverage: 12 };
const pos = { market: "ETH", side: "long" as const, entryPx: 2500, markPx: 2600, sizeUsd: 100, leverage: 2, marketMaxLeverage: 12 };

afterEach(() => vi.clearAllMocks());

describe("risk adapter (stubbed engine)", () => {
  it("normalizes a verdict and clamps leverage to the market", async () => {
    engine.assessTrade.mockResolvedValueOnce({ dataAvailable: true, score: -30, level: "high", decision: "reduce", adjusted: { maxLeverage: 30, sizeMultiplier: 1.5, requireStopLoss: true, stopLossDistancePct: 3, extraMarginPct: 25 }, changes: ["x"], reasons: ["smart money selling"], signals: [{ id: "a", segment: "smart_money" }] });
    const v = await assessTrade({ ...input, apiKey: "k" });
    expect(v.adjusted).toEqual({ maxLeverage: 12, sizeMultiplier: 1, requireStopLoss: true, stopLossDistancePct: 3, extraMarginPct: 25 });
    expect(v.decision).toBe("reduce");
    expect(engine.assessTrade).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "k", market: "ETH", leverage: 5, marketMaxLeverage: 12 }));
  });

  it("keeps maxLeverage 0 on a block", async () => {
    engine.assessTrade.mockResolvedValueOnce({ dataAvailable: true, score: -80, level: "extreme", decision: "block", adjusted: { maxLeverage: 0, sizeMultiplier: 0, requireStopLoss: true, stopLossDistancePct: null, extraMarginPct: 0 } });
    const v = await assessTrade({ ...input, apiKey: "k" });
    expect(v.decision).toBe("block");
    expect(v.adjusted.maxLeverage).toBe(0);
  });

  it("falls back to the no-data policy and hides the key when the engine throws", async () => {
    engine.assessTrade.mockRejectedValueOnce(new Error("401 for key secret-k"));
    const v = await assessTrade({ ...input, apiKey: "secret-k" });
    expect(v).toMatchObject({ dataAvailable: false, decision: "reduce", adjusted: { maxLeverage: 3, requireStopLoss: true, stopLossDistancePct: 3 } });
    expect(v.reasons.join(" ")).not.toContain("secret-k");
    expect(noDataVerdict({ leverage: 2, marketMaxLeverage: 12 }, "x").adjusted.maxLeverage).toBe(2);
  });

  it("maps monitor results and never calls Nansen without a key", async () => {
    expect((await monitorPosition({ ...pos })).action).toBe("hold");
    expect(engine.monitorPosition).not.toHaveBeenCalled();
    engine.monitorPosition.mockResolvedValueOnce({ action: "tighten_stop", reason: "turning", stopPx: 2548, verdict: { dataAvailable: true, score: -30 } });
    expect(await monitorPosition({ ...pos, apiKey: "k" })).toMatchObject({ action: "tighten_stop", stopPx: 2548, score: -30, dataAvailable: true });
    engine.monitorPosition.mockResolvedValueOnce({ action: "panic", reason: "?" });
    expect((await monitorPosition({ ...pos, apiKey: "k" })).action).toBe("hold");
  });
});
