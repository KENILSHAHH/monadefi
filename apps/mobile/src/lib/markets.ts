import type { PerplMarket } from "./api/types";

/** Funding per interval → a yearly rate, so markets with other intervals compare. Positive: longs pay shorts. */
export const fundingApr = (m: Pick<PerplMarket, "fundingRate" | "fundingIntervalSec">) =>
  m.fundingIntervalSec > 0 ? m.fundingRate * ((365 * 86_400) / m.fundingIntervalSec) : 0;

/** Perpl minimum for a first deposit or a collateral deposit, in AUSD (skills/perpl). */
export const PERPL_MIN_DEPOSIT = 10;

/** Clamp leverage to 1..max in whole steps. Perpl silently uses the max above it, so the app never sends more. */
export function clampLeverage(lev: number, max: number): number {
  const m = Math.max(1, Math.floor(max));
  return Math.min(m, Math.max(1, Math.round(lev)));
}

/**
 * Rough isolated-margin liquidation price before the server preview: entry ∓ entry × (1/leverage − maintenance).
 * Only a hint on the ticket. The confirm sheet shows the server's number.
 */
export function roughLiquidation(entry: number, leverage: number, maintenance: number, side: "long" | "short"): number | null {
  if (!(entry > 0) || !(leverage >= 1)) return null;
  const move = entry * (1 / leverage - maintenance);
  if (move <= 0) return null;
  return side === "long" ? entry - move : entry + move;
}
