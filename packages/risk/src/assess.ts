// Pre-trade risk assessment from Nansen wallet segments. The policy is plain deterministic code (no LLM).
//
// Flow:
// 1. Ask Nansen for each wallet segment (in parallel, cached, inside a credit budget).
// 2. Turn each answer into a RiskSignal with an impact from -1 (against the trade) to +1 (with the trade).
// 3. score = 100 * sum(weight * impact) / max(sum(weight), MIN_WEIGHT) + risk points (concentration, trader record).
// 4. Map the score to a decision, a leverage cap, a size multiplier, a stop-loss and a margin buffer (POLICY below).
import type { z } from "zod";
import {
  createNansenClient, FlowIntelligenceSchema, HoldersSchema, NansenError, PnlSummarySchema, PositionIntelligenceSchema,
  SmartMoneyPerpTradesSchema, CREDIT_COST, type NansenClient, type NansenClientOptions, type ResponseCache,
} from "./client";
import { marketProfile, type MarketProfile } from "./markets";

export type Segment = "smart_money" | "whales" | "exchanges" | "fresh_wallets" | "top_holders" | "public_figures" | "concentration" | "trader";
export type Side = "long" | "short";

export interface RiskSignal {
  id: string;
  segment: Segment;
  /** Plain English, for example "Smart money sold 4.2M USD of ETH in 24h". */
  label: string;
  value: number;
  unit: string;
  window: string;
  direction: "with_trade" | "against_trade" | "neutral";
  /** Weight of this signal in the score. For risk points (concentration, trader) it is points / 100. */
  weight: number;
  /** Strength relative to the trade side: -1 strongly against .. +1 strongly with it. */
  impact: number;
  /** Nansen endpoint path. */
  source: string;
}

export interface RiskVerdict {
  market: string;
  side: Side;
  asOf: string;
  /** false when there is no key, Nansen is down, or Nansen has no coverage for the market. */
  dataAvailable: boolean;
  /** -100 (strongly against the trade) .. +100 (strongly with it). */
  score: number;
  level: "low" | "medium" | "high" | "extreme";
  decision: "allow" | "reduce" | "block";
  adjusted: {
    maxLeverage: number;
    /** 0..1, applied to the margin. */
    sizeMultiplier: number;
    requireStopLoss: boolean;
    stopLossDistancePct: number | null;
    /** Extra collateral, in % of the margin, at the same position size. */
    extraMarginPct: number;
  };
  /** What the verdict changed vs the request, in plain English. */
  changes: string[];
  reasons: string[];
  signals: RiskSignal[];
  creditsUsed: number;
  /** true when every Nansen answer came from the cache. */
  cached: boolean;
}

export interface AssessInput {
  apiKey?: string;
  market: string;
  side: Side;
  leverage: number;
  marginUsd: number;
  marketMaxLeverage: number;
  /** Wallet address for trader-profile signals (Monad PnL). */
  trader?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  /** Credit budget for one assessment. Cached answers are free. Default 15. */
  maxCredits?: number;
  /** Advanced: a ready client (tests, a shared client). */
  client?: NansenClient;
  /** Advanced: client options other than the key and fetch. */
  clientOptions?: Partial<Omit<NansenClientOptions, "apiKey" | "fetch">> & { cache?: ResponseCache };
}

// ── Policy constants (exported so the README, the UI and tests show the same numbers) ──

export const POLICY = {
  blockAtOrBelow: -60,
  reduceAtOrBelow: -25,
  allowAsRequestedAtOrAbove: 25,
  /** In the reduce band: leverage cap = max(1, floor(marketMax / 3)). */
  reduceLeverageDivisor: 3,
  reduceSizeMultiplier: 0.5,
  reduceExtraMarginPct: 25,
  /** In the neutral band, a stop is required above this leverage. */
  neutralStopAboveLeverage: 5,
  neutralExtraMarginPct: 10,
  noDataMaxLeverage: 3,
  /** Stop distance = min(cap, share * liquidation distance), liquidation distance about 100 / leverage %. */
  stopShareOfLiqDistance: 0.5,
  tightStopCapPct: 3,
  normalStopCapPct: 5,
  minStopPct: 0.5,
  /** The weighted average divides by at least this much weight, so that one small signal cannot swing the score. */
  minWeight: 0.6,
  defaultMaxCredits: 15,
} as const;

export const WEIGHTS = {
  smPerpPositioning: 0.25,
  smPerpTrades: 0.15,
  smSpotFlow: 0.12,
  topPnlSpotFlow: 0.05,
  whalePerpPositioning: 0.1,
  whaleSpotFlow: 0.1,
  exchangeFlow: 0.15,
  publicFigurePerpPositioning: 0.05,
  publicFigureSpotFlow: 0.03,
  freshWalletFlow: 0.05,
  topHolderFlow: 0.08,
} as const;

/** Risk points added to the score (negative = more risk). */
export const RISK_POINTS = {
  concentration: [
    { atOrAbove: 0.7, points: -25 },
    { atOrAbove: 0.5, points: -15 },
    { atOrAbove: 0.35, points: -5 },
  ],
  traderPoor: -10,
  traderStrong: 5,
  traderMinTrades: 5,
} as const;

/** Below these sizes a segment is too thin to count. */
const MIN_POSITIONING_USD = 50_000;
const MIN_PERP_TRADES_USD = 25_000;

const CEX = /exchange|binance|coinbase|kraken|okx|bybit|bitget|kucoin|gate\.io|htx|huobi|upbit|bithumb|crypto\.com|mexc|bitfinex|gemini|bitstamp|hot wallet|deposit/i;

// ── Formatting ──

export function fmtUsd(v: number): string {
  const a = Math.abs(v);
  const sgn = v < 0 ? "-" : "";
  if (a >= 1e9) return `${sgn}${(a / 1e9).toFixed(2)}B USD`;
  if (a >= 1e6) return `${sgn}${(a / 1e6).toFixed(1)}M USD`;
  if (a >= 1e3) return `${sgn}${(a / 1e3).toFixed(0)}k USD`;
  return `${sgn}${a.toFixed(0)} USD`;
}
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmtLev = (v: number) => `${round(v, 2)}x`;

function direction(impact: number): RiskSignal["direction"] {
  if (impact > 0.1) return "with_trade";
  if (impact < -0.1) return "against_trade";
  return "neutral";
}

function signal(p: Omit<RiskSignal, "direction" | "impact"> & { impact: number }): RiskSignal {
  const impact = round(clamp(p.impact, -1, 1), 3);
  return { ...p, impact, direction: direction(impact) };
}

// ── Data collection ──

interface Call {
  path: string;
  body: Record<string, unknown>;
  schema: z.ZodType;
  /** Priority order inside the budget: lower first. */
  priority: number;
  build: (data: any) => RiskSignal[];
}

interface Collected {
  signals: RiskSignal[];
  credits: number;
  calls: number;
  cachedCalls: number;
  notes: string[];
  errors: NansenError[];
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function planCalls(p: MarketProfile, side: Side, trader: string | undefined, now: Date): Call[] {
  const dir = side === "long" ? 1 : -1;
  const sym = p.symbol;
  const calls: Call[] = [];

  // 1. Hyperliquid perp positioning by cohort (1 credit).
  calls.push({
    path: "/tgm/position-intelligence",
    body: { token_address: p.hlSymbol },
    schema: PositionIntelligenceSchema,
    priority: 1,
    build: (d: z.infer<typeof PositionIntelligenceSchema>) => {
      const row = d.data[0];
      if (!row) return [];
      const out: RiskSignal[] = [];
      const cohorts = [
        { key: "smart_trader", id: "sm_perp_positioning", segment: "smart_money" as const, who: "Smart money perp traders", w: WEIGHTS.smPerpPositioning },
        { key: "whale", id: "whale_perp_positioning", segment: "whales" as const, who: "Whales", w: WEIGHTS.whalePerpPositioning },
        { key: "public_figure", id: "public_figure_perp_positioning", segment: "public_figures" as const, who: "Public figures", w: WEIGHTS.publicFigurePerpPositioning },
      ];
      for (const c of cohorts) {
        const L = Math.abs(Number((row as any)[`${c.key}_longs_usd`] ?? 0));
        const S = Math.abs(Number((row as any)[`${c.key}_shorts_usd`] ?? 0));
        const total = L + S;
        if (!(total >= MIN_POSITIONING_USD)) continue;
        const imb = (L - S) / total;
        const pctLong = Math.round((L / total) * 100);
        out.push(signal({
          id: c.id, segment: c.segment, weight: c.w, impact: imb * dir,
          label: `${c.who} on Hyperliquid hold ${fmtUsd(L)} long vs ${fmtUsd(S)} short ${sym} (${pctLong}% long)`,
          value: round(imb * 100, 1), unit: "% net long", window: "open positions", source: "/tgm/position-intelligence",
        }));
      }
      return out;
    },
  });

  // 2. Spot flows by segment, 24h (1 credit).
  if (p.spot) {
    const spot = p.spot;
    const scale = p.flowScaleUsd;
    calls.push({
      path: "/tgm/flow-intelligence",
      body: { chain: spot.chain, token_address: spot.tokenAddress, timeframe: "1d" },
      schema: FlowIntelligenceSchema,
      priority: 2,
      build: (d: z.infer<typeof FlowIntelligenceSchema>) => {
        const row = d.data[0];
        if (!row) return [];
        const out: RiskSignal[] = [];
        const what = spot.description;
        const flow = (id: string, segment: Segment, who: string, v: number | null | undefined, w: number) => {
          if (v == null || !Number.isFinite(v)) return;
          const verb = v >= 0 ? "bought a net" : "sold a net";
          out.push(signal({
            id, segment, weight: w, impact: Math.tanh(v / scale) * dir,
            label: `${who} ${verb} ${fmtUsd(Math.abs(v))} of ${what} in 24h`,
            value: round(v, 0), unit: "USD", window: "24h", source: "/tgm/flow-intelligence",
          }));
        };
        flow("sm_spot_flow_24h", "smart_money", "Smart money (Smart Traders)", row.smart_trader_net_flow_usd, WEIGHTS.smSpotFlow);
        flow("top_pnl_spot_flow_24h", "smart_money", "Top PnL traders", row.top_pnl_net_flow_usd, WEIGHTS.topPnlSpotFlow);
        flow("whale_spot_flow_24h", "whales", "Whales", row.whale_net_flow_usd, WEIGHTS.whaleSpotFlow);
        flow("public_figure_spot_flow_24h", "public_figures", "Public figures", row.public_figure_net_flow_usd, WEIGHTS.publicFigureSpotFlow);
        const ex = row.exchange_net_flow_usd;
        if (ex != null && Number.isFinite(ex)) {
          // Positive exchange net flow = deposits to exchanges = sell pressure (bearish).
          out.push(signal({
            id: "exchange_flow_24h", segment: "exchanges", weight: WEIGHTS.exchangeFlow, impact: -Math.tanh(ex / scale) * dir,
            label: ex >= 0
              ? `Exchanges received a net ${fmtUsd(ex)} of ${what} in 24h (sell pressure)`
              : `Exchanges sent out a net ${fmtUsd(-ex)} of ${what} in 24h (withdrawals, less sell pressure)`,
            value: round(ex, 0), unit: "USD", window: "24h", source: "/tgm/flow-intelligence",
          }));
        }
        const fr = row.fresh_wallets_net_flow_usd;
        if (fr != null && Number.isFinite(fr)) {
          // Fresh-wallet activity is treated as a risk (crowding, sybil or airdrop flow), whichever the trade side.
          const mag = Math.min(1, Math.abs(fr) / scale);
          out.push(signal({
            id: "fresh_wallet_flow_24h", segment: "fresh_wallets", weight: WEIGHTS.freshWalletFlow, impact: -mag,
            label: `Fresh wallets ${fr >= 0 ? "bought" : "sold"} a net ${fmtUsd(Math.abs(fr))} of ${what} in 24h${mag > 0.3 ? " (new-wallet activity adds volatility risk)" : ""}`,
            value: round(fr, 0), unit: "USD", window: "24h", source: "/tgm/flow-intelligence",
          }));
        }
        return out;
      },
    });
  }

  // 3. Trader record on Monad, 30 days (1 credit).
  if (trader) {
    const from = new Date(now.getTime() - 30 * 86_400_000);
    calls.push({
      path: "/profiler/address/pnl-summary",
      body: { wallet_address: trader, chain: "monad", date: { from: isoDate(from), to: isoDate(now) } },
      schema: PnlSummarySchema,
      priority: 3,
      build: (d: z.infer<typeof PnlSummarySchema>) => {
        const trades = Number(d.traded_times ?? 0);
        const win = d.win_rate == null ? null : Number(d.win_rate) > 1 ? Number(d.win_rate) / 100 : Number(d.win_rate);
        const pnl = Number(d.realized_pnl_usd ?? 0);
        if (trades < RISK_POINTS.traderMinTrades || win == null) {
          return [signal({ id: "trader_record_30d", segment: "trader", weight: 0, impact: 0, label: `The trader wallet has ${trades} trades on Monad in 30 days: too few to judge`, value: trades, unit: "trades", window: "30d", source: "/profiler/address/pnl-summary" })];
        }
        const winPct = Math.round(win * 100);
        if (win < 0.35 && pnl < 0) {
          return [signal({ id: "trader_record_30d", segment: "trader", weight: Math.abs(RISK_POINTS.traderPoor) / 100, impact: -1, label: `The trader wallet won ${winPct}% of ${trades} trades on Monad in 30 days and lost ${fmtUsd(-pnl)}`, value: winPct, unit: "% win rate", window: "30d", source: "/profiler/address/pnl-summary" })];
        }
        if (win >= 0.55 && pnl > 0) {
          return [signal({ id: "trader_record_30d", segment: "trader", weight: RISK_POINTS.traderStrong / 100, impact: 1, label: `The trader wallet won ${winPct}% of ${trades} trades on Monad in 30 days and made ${fmtUsd(pnl)}`, value: winPct, unit: "% win rate", window: "30d", source: "/profiler/address/pnl-summary" })];
        }
        return [signal({ id: "trader_record_30d", segment: "trader", weight: 0, impact: 0, label: `The trader wallet won ${winPct}% of ${trades} trades on Monad in 30 days (realized ${fmtUsd(pnl)})`, value: winPct, unit: "% win rate", window: "30d", source: "/profiler/address/pnl-summary" })];
      },
    });
  }

  // 4. Smart money perp trades on Hyperliquid, 24h (5 credits).
  calls.push({
    path: "/smart-money/perp-trades",
    body: { filters: { token_symbol: p.hlSymbol }, lookback_hours: 24, pagination: { page: 1, per_page: 100 }, order_by: [{ field: "value_usd", direction: "DESC" }] },
    schema: SmartMoneyPerpTradesSchema,
    priority: 4,
    build: (d: z.infer<typeof SmartMoneyPerpTradesSchema>) => {
      let buy = 0, sell = 0, n = 0;
      for (const t of d.data) {
        if (t.token_symbol && t.token_symbol.toUpperCase() !== p.hlSymbol.toUpperCase()) continue;
        const v = Math.abs(Number(t.value_usd ?? 0));
        const a = (t.action ?? "").toLowerCase();
        if (a.startsWith("buy")) buy += v;
        else if (a.startsWith("sell")) sell += v;
        else continue;
        n++;
      }
      const total = buy + sell;
      if (total < MIN_PERP_TRADES_USD) return [];
      const imb = (buy - sell) / total;
      return [signal({
        id: "sm_perp_trades_24h", segment: "smart_money", weight: WEIGHTS.smPerpTrades, impact: imb * dir,
        label: `Smart money perp trades on ${sym} in 24h: ${fmtUsd(buy)} buy-side vs ${fmtUsd(sell)} sell-side (${n} largest trades)`,
        value: round(imb * 100, 1), unit: "% net buy", window: "24h", source: "/smart-money/perp-trades",
      })];
    },
  });

  // 5. Top holders: concentration and their 24h balance change (5 credits). Only for tokens where it means something.
  if (p.spot && p.concentration && !(p.spot.native && p.spot.chain === "solana")) {
    const spot = p.spot;
    calls.push({
      path: "/tgm/holders",
      body: {
        chain: spot.chain, token_address: spot.tokenAddress, aggregate_by_entity: false, label_type: "all_holders", premium_labels: false,
        pagination: { page: 1, per_page: 20 }, order_by: [{ field: "value_usd", direction: "DESC" }],
      },
      schema: HoldersSchema,
      priority: 5,
      build: (d: z.infer<typeof HoldersSchema>) => {
        const rows = d.data.filter((h) => !CEX.test(h.address_label ?? ""));
        const top = rows.slice(0, 10);
        if (!top.length) return [];
        const raw = top.map((h) => Number(h.ownership_percentage ?? 0));
        // Nansen gives a 0..1 fraction. Accept a 0..100 percent too.
        const asFraction = raw.some((v) => v > 1) ? raw.map((v) => v / 100) : raw;
        const share = asFraction.reduce((a, b) => a + b, 0);
        const out: RiskSignal[] = [];
        const tier = RISK_POINTS.concentration.find((t) => share >= t.atOrAbove);
        const pts = tier?.points ?? 0;
        out.push(signal({
          id: "top10_concentration", segment: "concentration", weight: Math.abs(pts) / 100, impact: pts < 0 ? -1 : 0,
          label: `The top 10 non-exchange holders own ${round(share * 100, 1)}% of ${spot.description}${pts < 0 ? " (concentrated supply, dump risk)" : ""}`,
          value: round(share * 100, 1), unit: "% of supply", window: "now", source: "/tgm/holders",
        }));
        let change = 0;
        for (const h of top) {
          const amt = Number(h.token_amount ?? 0), val = Number(h.value_usd ?? 0), ch = Number(h.balance_change_24h ?? 0);
          if (amt > 0 && Number.isFinite(ch)) change += ch * (val / amt);
        }
        out.push(signal({
          id: "top_holder_flow_24h", segment: "top_holders", weight: WEIGHTS.topHolderFlow, impact: Math.tanh(change / p.flowScaleUsd) * dir,
          label: `The top 10 holders ${change >= 0 ? "added" : "removed"} ${fmtUsd(Math.abs(change))} of ${spot.description} in 24h`,
          value: round(change, 0), unit: "USD", window: "24h", source: "/tgm/holders",
        }));
        return out;
      },
    });
  }
  return calls.sort((a, b) => a.priority - b.priority);
}

async function collect(client: NansenClient, calls: Call[], maxCredits: number): Promise<Collected> {
  const res: Collected = { signals: [], credits: 0, calls: 0, cachedCalls: 0, notes: [], errors: [] };
  let planned = 0;
  const chosen: Call[] = [];
  for (const c of calls) {
    const cost = CREDIT_COST[c.path] ?? 1;
    if (planned + cost > maxCredits) {
      res.notes.push(`Skipped Nansen ${c.path} (${cost} credits) to stay inside the budget of ${maxCredits} credits`);
      continue;
    }
    planned += cost;
    chosen.push(c);
  }
  const results = await Promise.allSettled(chosen.map((c) => client.post(c.path, c.body, c.schema)));
  results.forEach((r, i) => {
    const c = chosen[i]!;
    if (r.status === "fulfilled") {
      res.calls++;
      res.credits += r.value.credits;
      if (r.value.cached) res.cachedCalls++;
      try {
        res.signals.push(...c.build(r.value.data));
      } catch (e) {
        res.notes.push(`Could not read Nansen ${c.path}: ${(e as Error).message}`);
      }
    } else {
      const e = r.reason instanceof NansenError ? r.reason : new NansenError(String((r.reason as Error)?.message ?? r.reason), 0, "unknown", c.path);
      res.errors.push(e);
      res.notes.push(e.message);
    }
  });
  return res;
}

// ── Policy ──

export function scoreSignals(signals: RiskSignal[]): { score: number; directionalWeight: number } {
  const directional = signals.filter((s) => s.segment !== "concentration" && s.segment !== "trader");
  const points = signals.filter((s) => s.segment === "concentration" || s.segment === "trader");
  const wSum = directional.reduce((a, s) => a + s.weight, 0);
  const weighted = directional.reduce((a, s) => a + s.weight * s.impact, 0);
  const base = wSum > 0 ? (100 * weighted) / Math.max(wSum, POLICY.minWeight) : 0;
  const pts = points.reduce((a, s) => a + s.weight * 100 * s.impact, 0);
  return { score: Math.round(clamp(base + pts, -100, 100)), directionalWeight: wSum };
}

export function stopDistancePct(leverage: number, tight: boolean): number {
  const liq = 100 / Math.max(1, leverage);
  const cap = tight ? POLICY.tightStopCapPct : POLICY.normalStopCapPct;
  return round(Math.max(POLICY.minStopPct, Math.min(cap, POLICY.stopShareOfLiqDistance * liq)), 1);
}

/** The strongest signal against the trade, as a short reason. */
export function mainAgainst(signals: RiskSignal[]): string | undefined {
  const s = signals.filter((x) => x.impact < 0 && x.weight > 0).sort((a, b) => a.weight * a.impact - b.weight * b.impact)[0];
  return s?.label;
}

export function decide(score: number, dataAvailable: boolean, req: { leverage: number; marketMaxLeverage: number }): Pick<RiskVerdict, "level" | "decision" | "adjusted"> {
  const reqLev = Math.min(req.leverage, req.marketMaxLeverage);
  if (!dataAvailable) {
    const lev = Math.min(reqLev, POLICY.noDataMaxLeverage);
    return { level: "high", decision: "reduce", adjusted: { maxLeverage: lev, sizeMultiplier: 1, requireStopLoss: true, stopLossDistancePct: stopDistancePct(lev, true), extraMarginPct: 0 } };
  }
  if (score <= POLICY.blockAtOrBelow) {
    return { level: "extreme", decision: "block", adjusted: { maxLeverage: 0, sizeMultiplier: 0, requireStopLoss: true, stopLossDistancePct: null, extraMarginPct: 0 } };
  }
  if (score <= POLICY.reduceAtOrBelow) {
    const lev = Math.min(reqLev, Math.max(1, Math.floor(req.marketMaxLeverage / POLICY.reduceLeverageDivisor)));
    return { level: "high", decision: "reduce", adjusted: { maxLeverage: lev, sizeMultiplier: POLICY.reduceSizeMultiplier, requireStopLoss: true, stopLossDistancePct: stopDistancePct(lev, true), extraMarginPct: POLICY.reduceExtraMarginPct } };
  }
  if (score < POLICY.allowAsRequestedAtOrAbove) {
    const needStop = reqLev > POLICY.neutralStopAboveLeverage;
    return { level: "medium", decision: "allow", adjusted: { maxLeverage: reqLev, sizeMultiplier: 1, requireStopLoss: needStop, stopLossDistancePct: needStop ? stopDistancePct(reqLev, false) : null, extraMarginPct: needStop ? POLICY.neutralExtraMarginPct : 0 } };
  }
  return { level: "low", decision: "allow", adjusted: { maxLeverage: reqLev, sizeMultiplier: 1, requireStopLoss: false, stopLossDistancePct: null, extraMarginPct: 0 } };
}

function describeChanges(v: Pick<RiskVerdict, "decision" | "adjusted" | "score" | "dataAvailable">, req: { leverage: number; marginUsd: number; marketMaxLeverage: number }, why: string): string[] {
  const out: string[] = [];
  if (v.decision === "block") {
    out.push(`Trade blocked (Nansen score ${v.score}): ${why}`);
    return out;
  }
  if (req.leverage > req.marketMaxLeverage) out.push(`Leverage ${fmtLev(req.leverage)} -> ${fmtLev(req.marketMaxLeverage)}: the Perpl market maximum is ${fmtLev(req.marketMaxLeverage)}`);
  const from = Math.min(req.leverage, req.marketMaxLeverage);
  const a = v.adjusted;
  if (a.maxLeverage < from) out.push(`Leverage ${fmtLev(from)} -> ${fmtLev(a.maxLeverage)}: ${why}`);
  if (a.sizeMultiplier < 1) out.push(`Margin ${round(req.marginUsd)} USD -> ${round(req.marginUsd * a.sizeMultiplier)} USD (size x${a.sizeMultiplier}): ${why}`);
  if (a.extraMarginPct > 0) out.push(`Add a ${a.extraMarginPct}% margin buffer at the same position size (liquidation further away): ${why}`);
  if (a.requireStopLoss && a.stopLossDistancePct != null) out.push(`Stop-loss required at ${a.stopLossDistancePct}% from entry: ${why}`);
  return out;
}

export async function assessTrade(input: AssessInput): Promise<RiskVerdict> {
  const now = input.now ?? new Date();
  const profile = marketProfile(input.market);
  const req = { leverage: input.leverage, marginUsd: input.marginUsd, marketMaxLeverage: input.marketMaxLeverage };
  const base = { market: profile.symbol, side: input.side, asOf: now.toISOString() };

  const fallback = (reason: string, extra: { signals?: RiskSignal[]; notes?: string[]; credits?: number; cached?: boolean } = {}): RiskVerdict => {
    const d = decide(0, false, req);
    const v = { ...base, dataAvailable: false, score: 0, ...d };
    return {
      ...v,
      changes: describeChanges(v, req, reason),
      reasons: [reason, ...(extra.notes ?? [])],
      signals: extra.signals ?? [],
      creditsUsed: extra.credits ?? 0,
      cached: extra.cached ?? false,
    };
  };

  if (!input.client && !input.apiKey) return fallback("Nansen data is not available: no Nansen API key is set");

  const client = input.client ?? createNansenClient({ apiKey: input.apiKey!, fetch: input.fetchImpl, ...input.clientOptions });
  const calls = planCalls(profile, input.side, input.trader, now);
  const got = await collect(client, calls, input.maxCredits ?? POLICY.defaultMaxCredits);
  const allCached = got.calls > 0 && got.cachedCalls === got.calls;
  const { score, directionalWeight } = scoreSignals(got.signals);

  if (directionalWeight <= 0) {
    const why = got.errors.length
      ? `Nansen data is not available (${got.errors[0]!.status ? `HTTP ${got.errors[0]!.status}${got.errors[0]!.code ? " " + got.errors[0]!.code : ""}` : got.errors[0]!.code ?? "error"})`
      : `Nansen data is not available: no wallet-segment data for ${profile.symbol}`;
    return fallback(why, { signals: got.signals, notes: got.notes, credits: got.credits, cached: allCached });
  }

  const d = decide(score, true, req);
  const v = { ...base, dataAvailable: true, score, ...d };
  const why = mainAgainst(got.signals) ?? `the Nansen score is ${score}`;
  const sorted = [...got.signals].sort((a, b) => Math.abs(b.weight * b.impact) - Math.abs(a.weight * a.impact));
  const reasons = [
    `Nansen score ${score} for a ${profile.symbol} ${input.side} (${got.signals.length} signals, ${got.credits} credits${allCached ? ", from cache" : ""})`,
    ...sorted.filter((s) => s.direction !== "neutral").map((s) => `${s.direction === "with_trade" ? "For" : "Against"}: ${s.label}`),
    ...got.notes,
  ];
  if (profile.note) reasons.push(`Coverage: ${profile.note}`);
  return { ...v, changes: describeChanges(v, req, why), reasons, signals: sorted, creditsUsed: got.credits, cached: allCached };
}

// ── Apply a verdict to an order ──

export function applyVerdict<T extends { leverage: number; marginUsd: number; stopLossPx?: number | null }>(
  order: T,
  verdict: RiskVerdict,
  ctx: { entryPx: number },
): { order: T & { stopLossPx?: number | null }; changes: string[]; blocked: boolean } {
  const why = verdict.dataAvailable ? (mainAgainst(verdict.signals) ?? `the Nansen score is ${verdict.score}`) : (verdict.reasons[0] ?? "Nansen data is not available");
  if (verdict.decision === "block") {
    return { order, changes: [`Trade blocked (Nansen score ${verdict.score}): ${why}`], blocked: true };
  }
  const a = verdict.adjusted;
  const changes: string[] = [];
  let lev = Math.min(order.leverage, a.maxLeverage);
  let margin = order.marginUsd * a.sizeMultiplier;
  if (lev < order.leverage) changes.push(`Leverage ${fmtLev(order.leverage)} -> ${fmtLev(lev)}: ${why}`);
  if (a.sizeMultiplier < 1) changes.push(`Margin ${round(order.marginUsd)} USD -> ${round(margin)} USD (size x${a.sizeMultiplier}): ${why}`);
  if (a.extraMarginPct > 0) {
    // Same notional, more collateral: margin x (1 + e), leverage / (1 + e). Perpl applies leverage to the whole position.
    const e = a.extraMarginPct / 100;
    const notional = margin * lev;
    const newMargin = round(margin * (1 + e));
    const newLev = Math.floor((notional / newMargin) * 100) / 100;
    changes.push(`Margin buffer +${a.extraMarginPct}%: margin ${round(margin)} USD -> ${newMargin} USD and leverage ${fmtLev(lev)} -> ${fmtLev(newLev)} at the same ${round(notional)} USD position: ${why}`);
    margin = newMargin;
    lev = newLev;
  }
  let stop = order.stopLossPx ?? null;
  if (a.requireStopLoss && a.stopLossDistancePct != null && ctx.entryPx > 0) {
    const dpc = a.stopLossDistancePct / 100;
    const wanted = verdict.side === "long" ? ctx.entryPx * (1 - dpc) : ctx.entryPx * (1 + dpc);
    const looser = stop == null || (verdict.side === "long" ? stop < wanted : stop > wanted);
    if (looser) {
      const px = Number(wanted.toPrecision(8));
      changes.push(stop == null
        ? `Stop-loss set at ${px} (${a.stopLossDistancePct}% ${verdict.side === "long" ? "below" : "above"} entry ${ctx.entryPx}): ${why}`
        : `Stop-loss ${stop} -> ${px} (${a.stopLossDistancePct}% from entry): ${why}`);
      stop = px;
    }
  }
  const out: T & { stopLossPx?: number | null } = { ...order, leverage: lev, marginUsd: round(margin), ...(stop != null || "stopLossPx" in order ? { stopLossPx: stop } : {}) };
  return { order: out, changes, blocked: false };
}
