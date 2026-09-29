// Adapter for @app/risk (the Nansen risk engine). Commands use only this file, so the engine can change behind it.
// Engine facts (packages/risk/src/assess.ts and monitor.ts):
// - score is -100 (strongly against the trade) .. +100 (strongly with it). decision allow | reduce | block.
// - adjusted.stopLossDistancePct and extraMarginPct are percents (3 = 3%).
// - Without a Nansen key (or without data) the engine itself returns dataAvailable = false, decision "reduce",
//   leverage capped at POLICY.noDataMaxLeverage (3x) and a required tight stop. The plugin keeps that policy.
// - monitorPosition({ market, side, entryPx, markPx, sizeUsd, leverage, marketMaxLeverage, trader }) returns
//   { action: hold | tighten_stop | reduce | exit, reason, stopPx?, reduceFraction? }.
import type { Side } from "./args";
import * as engine from "./riskEngine";

export type RiskDecision = "allow" | "reduce" | "block";
export type MonitorAction = "hold" | "tighten_stop" | "reduce" | "exit";

export interface RiskAdjusted {
  maxLeverage: number;
  /** 0..1, applied to the margin. */
  sizeMultiplier: number;
  requireStopLoss: boolean;
  /** Distance of the required stop from entry, in percent (3 = 3%). */
  stopLossDistancePct: number | null;
  /** Extra collateral in percent of the margin, at the same position size. */
  extraMarginPct: number;
}

export interface RiskSignal { id?: string; segment?: string; label?: string; name?: string; value?: unknown; unit?: string; window?: string; direction?: string; weight?: number; impact?: number; source?: string; note?: string; [k: string]: unknown }

export interface RiskVerdict {
  dataAvailable: boolean;
  score: number;
  level: string;
  decision: RiskDecision;
  adjusted: RiskAdjusted;
  changes: string[];
  reasons: string[];
  signals: RiskSignal[];
  side?: Side;
  creditsUsed?: number;
  cached?: boolean;
}

export interface AssessInput { apiKey?: string; market: string; side: Side; leverage: number; marginUsd: number; marketMaxLeverage: number; trader?: string }
export interface MonitorInput {
  apiKey?: string; market: string; side: Side; entryPx: number; markPx: number; sizeUsd: number; leverage: number; marketMaxLeverage: number; trader?: string;
}
export interface MonitorOutcome { action: MonitorAction; reason: string; dataAvailable: boolean; score?: number; stopPx?: number; reduceFraction?: number }

/** The verdict when the engine itself cannot run: the engine's no-data policy, rebuilt locally (cap 3x, tight stop). */
export function noDataVerdict(input: Pick<AssessInput, "leverage" | "marketMaxLeverage">, reason: string): RiskVerdict {
  const cap = engine.POLICY?.noDataMaxLeverage ?? 3;
  const lev = Math.min(input.leverage, input.marketMaxLeverage, cap);
  const liqPct = 100 / Math.max(1, lev);
  const stop = Math.round(Math.max(engine.POLICY?.minStopPct ?? 0.5, Math.min(engine.POLICY?.tightStopCapPct ?? 3, (engine.POLICY?.stopShareOfLiqDistance ?? 0.5) * liqPct)) * 10) / 10;
  return {
    dataAvailable: false, score: 0, level: "high", decision: "reduce",
    adjusted: { maxLeverage: lev, sizeMultiplier: 1, requireStopLoss: true, stopLossDistancePct: stop, extraMarginPct: 0 },
    changes: [], reasons: [reason], signals: [],
  };
}

function normalize(v: Partial<RiskVerdict> | null | undefined, input: AssessInput): RiskVerdict {
  if (!v || typeof v !== "object") return noDataVerdict(input, "The risk engine returned no verdict.");
  const a: Partial<RiskAdjusted> = v.adjusted ?? {};
  const decision: RiskDecision = v.decision === "block" || v.decision === "reduce" ? v.decision : "allow";
  const maxLev = Number.isFinite(a.maxLeverage) ? Number(a.maxLeverage) : input.marketMaxLeverage;
  return {
    ...v,
    dataAvailable: !!v.dataAvailable,
    score: Number.isFinite(v.score) ? Number(v.score) : 0,
    level: typeof v.level === "string" ? v.level : "unknown",
    decision,
    adjusted: {
      // The engine sends 0 on a block. Never above the market maximum.
      maxLeverage: Math.min(Math.max(decision === "block" ? 0 : 1, maxLev), input.marketMaxLeverage),
      sizeMultiplier: Number.isFinite(a.sizeMultiplier) ? Math.max(0, Math.min(1, Number(a.sizeMultiplier))) : 1,
      requireStopLoss: !!a.requireStopLoss,
      stopLossDistancePct: a.stopLossDistancePct === null || a.stopLossDistancePct === undefined || !Number.isFinite(a.stopLossDistancePct) ? null : Number(a.stopLossDistancePct),
      extraMarginPct: Number.isFinite(a.extraMarginPct) ? Math.max(0, Number(a.extraMarginPct)) : 0,
    },
    changes: Array.isArray(v.changes) ? v.changes.map(String) : [],
    reasons: Array.isArray(v.reasons) ? v.reasons.map(String) : [],
    signals: Array.isArray(v.signals) ? (v.signals as RiskSignal[]) : [],
  };
}

/** Nansen verdict. The engine runs with or without a key (without one it returns its no-data policy, with no network call). */
export async function assessTrade(input: AssessInput): Promise<RiskVerdict> {
  try {
    const v = await engine.assessTrade({ ...input, apiKey: input.apiKey || undefined });
    const out = normalize(v as unknown as Partial<RiskVerdict>, input);
    if (!input.apiKey) out.reasons = [...out.reasons, "Set NANSEN_API_KEY or run `mm monadefi config set nansen-key` for smart-money checks."];
    return out;
  } catch (err) {
    return noDataVerdict(input, `Nansen check failed: ${redact(err, input.apiKey)}. No Nansen data was used.`);
  }
}

export async function monitorPosition(input: MonitorInput): Promise<MonitorOutcome> {
  if (!input.apiKey) return { action: "hold", reason: "No Nansen key: price rules only.", dataAvailable: false };
  try {
    const r = await engine.monitorPosition(input);
    const action: MonitorAction = r && ["hold", "tighten_stop", "reduce", "exit"].includes(r.action) ? r.action : "hold";
    return {
      action, reason: String(r?.reason ?? ""), dataAvailable: !!r?.verdict?.dataAvailable, score: r?.verdict?.score,
      ...(Number.isFinite(r?.stopPx) ? { stopPx: Number(r.stopPx) } : {}),
      ...(Number.isFinite(r?.reduceFraction) ? { reduceFraction: Number(r.reduceFraction) } : {}),
    };
  } catch (err) {
    return { action: "hold", reason: `Nansen check failed: ${redact(err, input.apiKey)}`, dataAvailable: false };
  }
}

/** An error message with the key removed, in case an upstream error echoes it. */
export function redact(err: unknown, secret?: string): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (secret) msg = msg.split(secret).join("***");
  return msg.slice(0, 300);
}
