// Pure logic of `monadefi protect` (stop, trailing stop, take-profit) and `monadefi rebalance` (target leverage).
import type { EvmTx } from "@app/perpl";
import type { RiskProfile, Side } from "./args";
import type { RiskVerdict } from "./risk";
import type { IntentAction, PlannedTx } from "./types";

export const perplTx = (tx: EvmTx, action: IntentAction): PlannedTx => ({ chainId: 143, to: tx.to!, data: tx.data, value: tx.value || "0", description: tx.description, action });

// ── protect ────────────────────────────────────────────────────────────────

export interface ProtectState {
  side: Side;
  /** Fixed stop. Long: close at or below. Short: close at or above. */
  stopPx?: number;
  /** Trailing distance as a fraction (0.03 = 3%). */
  trailing?: number;
  tpPx?: number;
  /** Best price seen since the start: highest for a long, lowest for a short. */
  peakPx?: number;
}

export interface ProtectCheck { action: "hold" | "close"; reason: string; effectiveStop: number | null; peakPx: number | null; trigger?: "stop" | "trailing" | "take_profit" | "nansen_exit" }

/** One check at a mark price. Returns the new state and what to do. */
export function protectStep(s: ProtectState, markPx: number): { state: ProtectState; check: ProtectCheck } {
  const long = s.side === "long";
  const peak = s.peakPx === undefined ? markPx : long ? Math.max(s.peakPx, markPx) : Math.min(s.peakPx, markPx);
  const trailStop = s.trailing ? (long ? peak * (1 - s.trailing) : peak * (1 + s.trailing)) : undefined;
  const stops = [s.stopPx, trailStop].filter((x): x is number => x !== undefined);
  const effective = stops.length ? (long ? Math.max(...stops) : Math.min(...stops)) : null;
  const state = { ...s, peakPx: peak };
  if (s.tpPx !== undefined && (long ? markPx >= s.tpPx : markPx <= s.tpPx)) return { state, check: { action: "close", trigger: "take_profit", reason: `Mark ${markPx} reached the take-profit ${s.tpPx}.`, effectiveStop: effective, peakPx: peak } };
  if (effective !== null && (long ? markPx <= effective : markPx >= effective)) {
    const byTrail = trailStop !== undefined && effective === trailStop && (s.stopPx === undefined || trailStop !== s.stopPx);
    return { state, check: { action: "close", trigger: byTrail ? "trailing" : "stop", reason: `Mark ${markPx} crossed the ${byTrail ? `trailing stop ${round(effective)} (peak ${peak})` : `stop ${effective}`}.`, effectiveStop: effective, peakPx: peak } };
  }
  return { state, check: { action: "hold", reason: effective === null ? "No stop set; watching take-profit only." : `Mark ${markPx}, stop ${round(effective)}.`, effectiveStop: effective, peakPx: peak } };
}

/** "tighten_stop" from Nansen: move the fixed stop halfway to the mark price. Never loosens it. */
export function tightenStop(s: ProtectState, markPx: number): ProtectState {
  const long = s.side === "long";
  const current = s.stopPx ?? (long ? markPx * 0.95 : markPx * 1.05);
  const next = current + (markPx - current) / 2;
  return { ...s, stopPx: long ? Math.max(current, next) : Math.min(current, next) };
}

/** Move the fixed stop to `px` when that is tighter and still on the right side of the mark. */
export function tightenTo(s: ProtectState, px: number, markPx: number): ProtectState {
  const long = s.side === "long";
  if (long ? px >= markPx : px <= markPx) return s;
  if (s.stopPx === undefined) return { ...s, stopPx: px };
  return { ...s, stopPx: long ? Math.max(s.stopPx, px) : Math.min(s.stopPx, px) };
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

// ── rebalance ──────────────────────────────────────────────────────────────

/** Target leverage for each risk profile, before the Nansen cap and the market cap. */
export const PROFILE_LEVERAGE: Record<RiskProfile, number> = { conservative: 2, balanced: 3, aggressive: 5 };
/** Positions within this share above the target are left alone. */
export const REBALANCE_TOLERANCE = 0.05;

export interface RebalancePosition { market: string; side: Side; size: number; markPx: number; marginUsd: number; leverage: number; marketMaxLeverage: number }

export interface RebalancePlan {
  market: string;
  side: Side;
  currentLeverage: number;
  targetLeverage: number;
  action: "none" | "add_margin" | "reduce_and_add" | "exit";
  addMarginUsd: number;
  reduceFraction: number;
  reason: string;
}

/**
 * The lowest of: the profile leverage, the market maximum and the Nansen cap (adjusted.maxLeverage). The engine's cap
 * already holds its policy: lower on "reduce", 3x without data. It is never above the leverage it was asked about.
 */
export function targetLeverage(profile: RiskProfile, marketMax: number, verdict?: Pick<RiskVerdict, "adjusted" | "decision" | "dataAvailable">): number {
  let t = Math.min(PROFILE_LEVERAGE[profile], marketMax);
  if (verdict && verdict.decision !== "block" && verdict.adjusted.maxLeverage >= 1) t = Math.min(t, verdict.adjusted.maxLeverage);
  return Math.max(1, Math.floor(t * 100) / 100);
}

/**
 * Plan for one position. Rebalancing never adds risk: an under-levered position is left as is.
 * Over the target, with N = notional / target (the margin the target needs) and M the margin now:
 * - Add margin N - M when free AUSD in Perpl plus AUSD in the wallet (A) covers it.
 * - Else close a part f first. The close returns about f * M to the free balance, and the rest needs (1 - f) * (N - M):
 *     (1 - f) * (N - M) = A + f * M  ->  f = (N - M - A) / N
 *   then add the freed margin plus A. The command re-reads the account after the close and adds what is really free.
 */
export function planRebalance(p: RebalancePosition, target: number, availableUsd: number, verdict?: Pick<RiskVerdict, "decision" | "dataAvailable">): RebalancePlan {
  const base = { market: p.market, side: p.side, currentLeverage: round(p.leverage, 2), targetLeverage: target, addMarginUsd: 0, reduceFraction: 0 };
  if (verdict?.dataAvailable && verdict.decision === "block") return { ...base, action: "exit", reduceFraction: 1, reason: "Nansen blocks this side now: close the position." };
  const notional = p.size * p.markPx;
  if (p.leverage <= target * (1 + REBALANCE_TOLERANCE)) return { ...base, action: "none", reason: `Leverage ${round(p.leverage, 2)}x is at or below the target ${target}x.` };
  const N = notional / target;
  const need = N - p.marginUsd;
  const avail = Math.max(0, availableUsd);
  if (avail >= need) return { ...base, action: "add_margin", addMarginUsd: ceil2(need), reason: `Add ${ceil2(need)} AUSD of margin: ${round(p.leverage, 2)}x -> ${target}x.` };
  const fraction = Math.min(1, Math.ceil(((need - avail) / N) * 1000) / 1000);
  const add = Math.floor((avail + fraction * p.marginUsd) * 100) / 100;
  return { ...base, action: "reduce_and_add", reduceFraction: fraction, addMarginUsd: add, reason: `${round(avail, 2)} AUSD at hand, ${ceil2(need)} needed. Close ${round(fraction * 100, 1)}% of the position, then add about ${add} AUSD (freed margin plus free AUSD): ${round(p.leverage, 2)}x -> ${target}x.` };
}

const ceil2 = (n: number) => Math.ceil(n * 100) / 100;
