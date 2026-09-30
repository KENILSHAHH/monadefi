import { describe, expect, it } from "vitest";
import { planRebalance, protectStep, targetLeverage, tightenStop, tightenTo, type ProtectState } from "../src/lib/strategy";
import { verdict } from "./fixtures";

describe("protect", () => {
  it("holds above a long stop and closes at it", () => {
    const s: ProtectState = { side: "long", stopPx: 2300 };
    expect(protectStep(s, 2400).check.action).toBe("hold");
    const hit = protectStep(s, 2299).check;
    expect(hit).toMatchObject({ action: "close", trigger: "stop" });
  });

  it("moves a trailing stop up with the peak and never down", () => {
    let s: ProtectState = { side: "long", trailing: 0.03 };
    s = protectStep(s, 2500).state;
    s = protectStep(s, 2600).state;
    const down = protectStep(s, 2560);
    expect(down.check.action).toBe("hold");
    expect(down.check.effectiveStop).toBeCloseTo(2522);
    expect(down.state.peakPx).toBe(2600);
    expect(protectStep(down.state, 2521).check).toMatchObject({ action: "close", trigger: "trailing" });
  });

  it("uses the tighter of the fixed and the trailing stop", () => {
    const s = protectStep({ side: "long", stopPx: 2450, trailing: 0.1 }, 2500);
    expect(s.check.effectiveStop).toBe(2450);
  });

  it("mirrors the rules for a short, with take-profit", () => {
    const s: ProtectState = { side: "short", stopPx: 2600, tpPx: 2300, trailing: 0.02 };
    expect(protectStep(s, 2500).check.action).toBe("hold");
    expect(protectStep(s, 2601).check).toMatchObject({ action: "close", trigger: "stop" });
    expect(protectStep(s, 2299).check).toMatchObject({ action: "close", trigger: "take_profit" });
    const after = protectStep(protectStep(s, 2400).state, 2449);
    expect(after.check).toMatchObject({ action: "close", trigger: "trailing" });
  });

  it("moves the stop to the Nansen level only when it is tighter and below the mark", () => {
    expect(tightenTo({ side: "long", stopPx: 2300 }, 2400, 2500).stopPx).toBe(2400);
    expect(tightenTo({ side: "long", stopPx: 2450 }, 2400, 2500).stopPx).toBe(2450);
    expect(tightenTo({ side: "long", stopPx: 2300 }, 2600, 2500).stopPx).toBe(2300);
    expect(tightenTo({ side: "short" }, 2600, 2500).stopPx).toBe(2600);
  });

  it("tightens a stop halfway to the mark and never loosens it", () => {
    expect(tightenStop({ side: "long", stopPx: 2300 }, 2500).stopPx).toBe(2400);
    expect(tightenStop({ side: "short", stopPx: 2700 }, 2500).stopPx).toBe(2600);
  });
});

describe("rebalance", () => {
  it("takes the lowest of profile, market and Nansen caps", () => {
    expect(targetLeverage("aggressive", 12)).toBe(5);
    expect(targetLeverage("aggressive", 3)).toBe(3);
    expect(targetLeverage("balanced", 12, verdict({ adjusted: { maxLeverage: 2 } }))).toBe(2);
    expect(targetLeverage("balanced", 12, verdict({ decision: "reduce", adjusted: { maxLeverage: 4 } }))).toBe(3);
    expect(targetLeverage("aggressive", 12, verdict({ dataAvailable: false, decision: "reduce", adjusted: { maxLeverage: 3 } }))).toBe(3);
    expect(targetLeverage("balanced", 12, verdict({ decision: "block", adjusted: { maxLeverage: 0 } }))).toBe(3);
  });

  const pos = { market: "ETH", side: "long" as const, size: 0.04, markPx: 2500, marginUsd: 20, leverage: 5, marketMaxLeverage: 12 };

  it("adds margin when there is enough AUSD", () => {
    const p = planRebalance(pos, 2, 100);
    expect(p.action).toBe("add_margin");
    expect(p.addMarginUsd).toBe(30);
  });

  it("closes part and adds the freed margin when AUSD is short", () => {
    const p = planRebalance(pos, 2, 10);
    // N = 50, need = 30, f = (30 - 10) / 50 = 0.4; add = 10 + 0.4 * 20 = 18
    expect(p.action).toBe("reduce_and_add");
    expect(p.reduceFraction).toBeCloseTo(0.4);
    expect(p.addMarginUsd).toBeCloseTo(18);
    // The rest: size 0.024 -> notional 60, margin 12 + 18 = 30 -> 2x.
    expect((0.04 * (1 - p.reduceFraction) * 2500) / (20 * (1 - p.reduceFraction) + p.addMarginUsd)).toBeCloseTo(2);
  });

  it("never adds risk to an under-levered position", () => {
    expect(planRebalance({ ...pos, leverage: 1.5 }, 2, 100).action).toBe("none");
  });

  it("exits when Nansen blocks the side", () => {
    expect(planRebalance(pos, 2, 100, verdict({ decision: "block" }))).toMatchObject({ action: "exit", reduceFraction: 1 });
  });
});
