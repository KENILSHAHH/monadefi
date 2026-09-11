// Continuous risk check for an open position. Call it from a loop (every 5-15 min: answers are cached that long).
// The result is a deterministic action the server can turn into a Perpl reduce-only close or a new stop.
import { assessTrade, POLICY, type AssessInput, type RiskSignal, type RiskVerdict, type Side } from "./assess";

export interface MonitorInput {
  apiKey?: string;
  market: string;
  side: Side;
  entryPx: number;
  markPx: number;
  sizeUsd: number;
  /** Current leverage of the position. Default 1. */
  leverage?: number;
  /** Perpl market maximum. Default 10. */
  marketMaxLeverage?: number;
  trader?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  /** Credit budget for one check. Default 2: perp positioning + spot flows only. */
  maxCredits?: number;
  client?: AssessInput["client"];
  clientOptions?: AssessInput["clientOptions"];
}

export interface MonitorResult {
  action: "hold" | "tighten_stop" | "reduce" | "exit";
  reason: string;
  signals: RiskSignal[];
  verdict: RiskVerdict;
  /** New stop price for "tighten_stop". */
  stopPx?: number;
  /** Share of the position to close for "reduce" (0..1). */
  reduceFraction?: number;
  /** Unlevered PnL of the position in %. */
  pnlPct: number;
}

export const MONITOR_POLICY = {
  exitAtOrBelow: POLICY.blockAtOrBelow,
  actAtOrBelow: POLICY.reduceAtOrBelow,
  reduceFraction: 0.5,
  defaultMaxCredits: 2,
  tightStopPct: 2,
} as const;

export async function monitorPosition(input: MonitorInput): Promise<MonitorResult> {
  const leverage = input.leverage && input.leverage > 0 ? input.leverage : 1;
  const verdict = await assessTrade({
    apiKey: input.apiKey, market: input.market, side: input.side, leverage, marginUsd: input.sizeUsd / leverage,
    marketMaxLeverage: input.marketMaxLeverage ?? 10, trader: input.trader, fetchImpl: input.fetchImpl, now: input.now,
    maxCredits: input.maxCredits ?? MONITOR_POLICY.defaultMaxCredits, client: input.client, clientOptions: input.clientOptions,
  });
  const long = input.side === "long";
  const pnlPct = Math.round(((long ? input.markPx - input.entryPx : input.entryPx - input.markPx) / input.entryPx) * 10_000) / 100;
  const against = verdict.signals.find((s) => s.direction === "against_trade" && s.weight > 0)?.label;
  const base = { signals: verdict.signals, verdict, pnlPct };

  if (!verdict.dataAvailable) {
    return { ...base, action: "hold", reason: `${verdict.reasons[0] ?? "Nansen data is not available"}. Keep the current stop.` };
  }
  if (verdict.score <= MONITOR_POLICY.exitAtOrBelow) {
    return { ...base, action: "exit", reason: `Nansen score ${verdict.score} is at or below ${MONITOR_POLICY.exitAtOrBelow}: ${against ?? "wallet segments turned against the position"}` };
  }
  if (verdict.score <= MONITOR_POLICY.actAtOrBelow) {
    if (pnlPct < 0) {
      return { ...base, action: "reduce", reduceFraction: MONITOR_POLICY.reduceFraction, reason: `Nansen score ${verdict.score} and the position is at ${pnlPct}%: close ${MONITOR_POLICY.reduceFraction * 100}%. ${against ?? ""}`.trim() };
    }
    // In profit: move the stop to the tighter of (break-even) and (mark minus a tight distance), never past the mark.
    const d = (verdict.adjusted.stopLossDistancePct ?? MONITOR_POLICY.tightStopPct) / 100;
    const trail = long ? input.markPx * (1 - d) : input.markPx * (1 + d);
    const stopPx = Number((long ? Math.max(input.entryPx, trail) : Math.min(input.entryPx, trail)).toPrecision(8));
    return { ...base, action: "tighten_stop", stopPx, reason: `Nansen score ${verdict.score} while the position is at +${pnlPct}%: move the stop to ${stopPx}. ${against ?? ""}`.trim() };
  }
  return { ...base, action: "hold", reason: `Nansen score ${verdict.score}: no change` };
}
