import type { OpenPreview, PerplMarket } from "@app/perpl";
import type { RiskVerdict } from "../src/lib/risk";

export const ETH: PerplMarket = {
  id: 20, symbol: "ETH", isOpen: true, priceDecimals: 2, sizeDecimals: 4, minSize: 0.0001, maxLeverage: 12, maintenanceMargin: 0.04,
  takerFee: 0.000345, makerFee: 0.000045, markPx: 2500, oraclePx: 2500, lastPx: 2500, bidPx: 2499.5, askPx: 2500.5, change24hPct: 1,
  fundingRate: 0.00001, fundingIntervalSec: 2571, openInterestUsd: 1e6, dayVolumeUsd: 5e6, orderTtlBlocks: 300, asOf: "2026-10-13T00:00:00.000Z",
};

export function preview(over: Partial<OpenPreview> = {}): OpenPreview {
  return {
    market: ETH, isLong: true, orderKind: "market", size: 0.016, lotLNS: 160n, leverage: 2, estEntryPx: 2500.5, limitPx: 2512.5,
    notionalUsd: 40, marginUsd: 20, estFeeUsd: 0.0138, estLiquidationPx: 1300, distanceToLiquidation: 0.48, warnings: [], ...over,
  };
}

export function verdict(over: Omit<Partial<RiskVerdict>, "adjusted"> & { adjusted?: Partial<RiskVerdict["adjusted"]> } = {}): RiskVerdict {
  const { adjusted, ...rest } = over;
  return {
    dataAvailable: true, score: 40, level: "medium", decision: "allow",
    adjusted: { maxLeverage: 12, sizeMultiplier: 1, requireStopLoss: false, stopLossDistancePct: null, extraMarginPct: 0, ...adjusted },
    changes: [], reasons: [], signals: [], ...rest,
  };
}
