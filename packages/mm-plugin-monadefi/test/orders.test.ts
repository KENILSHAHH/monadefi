import { ORDER_TYPE, perplAbi } from "@app/perpl";
import { decodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { applyRisk, buildCloseOrder, buildOpenOrder, buildTakeProfitOrder, checkLevels, closeLots } from "../src/lib/orders";
import { ETH, preview, verdict } from "./fixtures";

const decode = (data: Hex) => {
  const d = decodeFunctionData({ abi: perplAbi, data });
  expect(d.functionName).toBe("execOrder");
  return (d.args as unknown as [Record<string, unknown>])[0];
};

describe("order building", () => {
  it("builds a market open as IOC at the worst price with leverage in hundredths", () => {
    const tx = buildOpenOrder(preview(), { headBlock: 1000n });
    const o = decode(tx.data);
    expect(tx.to).toBe("0x34B6552d57a35a1D042CcAe1951BD1C370112a6F");
    expect(o.perpId).toBe(20n);
    expect(o.orderType).toBe(ORDER_TYPE.OpenLong);
    expect(o.immediateOrCancel).toBe(true);
    expect(o.postOnly).toBe(false);
    expect(o.lotLNS).toBe(160n);
    expect(o.pricePNS).toBe(251250n);
    expect(o.leverageHdths).toBe(200n);
    expect(o.lastExecutionBlock).toBe(1300n);
    expect(o.expiryBlock).toBe(0n);
  });

  it("builds a post-only limit short", () => {
    const tx = buildOpenOrder(preview({ isLong: false, orderKind: "limit", limitPx: 2600, leverage: 3 }), { headBlock: 5n, postOnly: true });
    const o = decode(tx.data);
    expect(o.orderType).toBe(ORDER_TYPE.OpenShort);
    expect(o.immediateOrCancel).toBe(false);
    expect(o.postOnly).toBe(true);
    expect(o.pricePNS).toBe(260000n);
    expect(o.leverageHdths).toBe(300n);
  });

  it("refuses post-only on a market order", () => {
    expect(() => buildOpenOrder(preview(), { headBlock: 1n, postOnly: true })).toThrow(/--post-only needs --limit/);
  });

  it("never closes more than the position, and a full close uses the exact size", () => {
    expect(closeLots(ETH, 0.0163, 1)).toBe(163n);
    expect(closeLots(ETH, 0.0163, 0.5)).toBe(81n);
    expect(() => closeLots(ETH, 0.0001, 0.5)).toThrow(/smaller than the smallest/);
  });

  it("builds a reduce-only IOC close below mark for a long and above mark for a short", () => {
    const long = buildCloseOrder(ETH, { side: "long", size: 0.02 }, { fraction: 1, slippageBps: 100, headBlock: 10n });
    const ol = decode(long.tx.data);
    expect(ol.orderType).toBe(ORDER_TYPE.CloseLong);
    expect(ol.immediateOrCancel).toBe(true);
    expect(ol.lotLNS).toBe(200n);
    expect(long.px).toBeCloseTo(2475);
    const short = buildCloseOrder(ETH, { side: "short", size: 0.02 }, { fraction: 0.5, slippageBps: 100, headBlock: 10n });
    expect(decode(short.tx.data).orderType).toBe(ORDER_TYPE.CloseShort);
    expect(short.px).toBeCloseTo(2525);
    expect(short.lots).toBe(100n);
  });

  it("builds a resting reduce-only take-profit only on the right side of the book", () => {
    const tp = decode(buildTakeProfitOrder(ETH, "long", 160n, 2700, 1n).data);
    expect(tp.orderType).toBe(ORDER_TYPE.CloseLong);
    expect(tp.postOnly).toBe(true);
    expect(tp.immediateOrCancel).toBe(false);
    expect(() => buildTakeProfitOrder(ETH, "long", 160n, 2400, 1n)).toThrow(/above the best bid/);
    expect(() => buildTakeProfitOrder(ETH, "short", 160n, 2600, 1n)).toThrow(/below the best ask/);
  });

  it("checks stop and take-profit levels against entry and liquidation", () => {
    expect(checkLevels({ side: "long", entryPx: 2500, liquidationPx: 1300, stopPx: 2300, tpPx: 2700 })).toEqual([]);
    expect(() => checkLevels({ side: "long", entryPx: 2500, liquidationPx: 1300, stopPx: 2600 })).toThrow(/below the entry/);
    expect(() => checkLevels({ side: "long", entryPx: 2500, liquidationPx: 2350, stopPx: 2300 })).toThrow(/liquidated first/);
    expect(() => checkLevels({ side: "short", entryPx: 2500, liquidationPx: 3700, tpPx: 2600 })).toThrow(/below the entry/);
    expect(checkLevels({ side: "long", entryPx: 2500, liquidationPx: 2295, stopPx: 2300 })[0]).toMatch(/within 0.5%/);
  });
});

describe("risk application (engine applyVerdict)", () => {
  it("blocks when Nansen blocks", () => {
    const r = applyRisk({ leverage: 5, marginUsd: 20 }, verdict({ decision: "block", adjusted: { maxLeverage: 0, sizeMultiplier: 0 } }), { entryPx: 2500, side: "long" });
    expect(r.blocked).toBe(true);
  });

  it("leaves an allowed trade unchanged", () => {
    const r = applyRisk({ leverage: 5, marginUsd: 20 }, verdict(), { entryPx: 2500, side: "long" });
    expect(r).toMatchObject({ blocked: false, leverage: 5, marginUsd: 20, changes: [] });
  });

  it("lowers leverage to the Nansen cap and keeps the margin", () => {
    const r = applyRisk({ leverage: 5, marginUsd: 20 }, verdict({ decision: "reduce", adjusted: { maxLeverage: 3 } }), { entryPx: 2500, side: "long" });
    expect(r.leverage).toBe(3);
    expect(r.marginUsd).toBe(20);
    expect(r.changes[0]).toMatch(/Leverage 5x -> 3x/);
  });

  it("cuts the margin by the multiplier, then adds the buffer at the same position size", () => {
    const r = applyRisk({ leverage: 4, marginUsd: 20 }, verdict({ decision: "reduce", adjusted: { sizeMultiplier: 0.5, extraMarginPct: 25 } }), { entryPx: 2500, side: "long" });
    // margin 20 * 0.5 = 10, notional 40; buffer: margin 12.5, leverage 40 / 12.5 = 3.2
    expect(r.marginUsd).toBeCloseTo(12.5);
    expect(r.leverage).toBeCloseTo(3.2);
  });

  it("keeps leverage at 1x when the buffer would push it below", () => {
    const r = applyRisk({ leverage: 1, marginUsd: 10 }, verdict({ adjusted: { extraMarginPct: 10 } }), { entryPx: 2500, side: "long" });
    expect(r.leverage).toBe(1);
    expect(r.changes.join(" ")).toMatch(/1x, the Perpl minimum/);
  });

  it("adds a required stop, and keeps a user stop that is already tighter", () => {
    const v = verdict({ adjusted: { requireStopLoss: true, stopLossDistancePct: 4 } });
    expect(applyRisk({ leverage: 2, marginUsd: 20 }, v, { entryPx: 2500, side: "long" }).stopPx).toBeCloseTo(2400);
    expect(applyRisk({ leverage: 2, marginUsd: 20 }, v, { entryPx: 2500, side: "short" }).stopPx).toBeCloseTo(2600);
    expect(applyRisk({ leverage: 2, marginUsd: 20, stopPx: 2450 }, v, { entryPx: 2500, side: "long" }).stopPx).toBe(2450);
    expect(applyRisk({ leverage: 2, marginUsd: 20, stopPx: 2000 }, v, { entryPx: 2500, side: "long" }).stopPx).toBeCloseTo(2400);
  });
});
