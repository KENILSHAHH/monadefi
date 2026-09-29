// Order building and risk application. Pure functions over market data, so the tests run without a chain.
import { ORDER_TYPE, ORDER_VALID_BLOCKS, execOrderTx, toLNS, toPNS, type EvmTx, type OpenPreview, type PerplMarket, type PerplPosition } from "@app/perpl";
import { InputError, type Side } from "./args";
import type { RiskVerdict } from "./risk";
import { applyVerdict } from "./riskEngine";

export interface TradeRequest { leverage: number; marginUsd: number; stopPx?: number; tpPx?: number }

export interface RiskApplied {
  leverage: number;
  marginUsd: number;
  stopPx?: number;
  tpPx?: number;
  blocked: boolean;
  changes: string[];
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Apply a Nansen verdict with the engine's own applyVerdict (@app/risk), so the plugin, the server and the app agree:
 * - leverage goes down to adjusted.maxLeverage;
 * - the margin is multiplied by sizeMultiplier;
 * - extraMarginPct adds collateral at the same position size (margin x (1 + e), leverage / (1 + e));
 * - a required stop is set at stopLossDistancePct from entry when the user stop is missing or looser.
 * The plugin adds one rule: leverage never goes below 1x (Perpl's minimum).
 */
export function applyRisk(req: TradeRequest, verdict: RiskVerdict, ctx: { entryPx: number; side: Side }): RiskApplied {
  const r = applyVerdict(
    { leverage: req.leverage, marginUsd: req.marginUsd, stopLossPx: req.stopPx ?? null },
    { market: "", asOf: "", creditsUsed: 0, cached: false, ...verdict, side: ctx.side } as unknown as Parameters<typeof applyVerdict>[1],
    { entryPx: ctx.entryPx },
  );
  if (r.blocked) return { ...req, blocked: true, changes: r.changes };
  const changes = [...r.changes];
  let leverage = r.order.leverage;
  let marginUsd = r.order.marginUsd;
  if (leverage < 1) {
    const notional = marginUsd * leverage;
    leverage = 1;
    marginUsd = round(notional, 6);
    changes.push("Leverage kept at 1x, the Perpl minimum: the margin buffer is not possible below 1x.");
  }
  return { leverage, marginUsd, stopPx: r.order.stopLossPx ?? undefined, tpPx: req.tpPx, blocked: false, changes };
}

/** Checks of the stop and take-profit levels against entry and liquidation. Returns warnings; throws on a level that cannot work. */
export function checkLevels(args: { side: Side; entryPx: number; liquidationPx: number; stopPx?: number; tpPx?: number }): string[] {
  const { side, entryPx, liquidationPx, stopPx, tpPx } = args;
  const long = side === "long";
  const warnings: string[] = [];
  if (stopPx !== undefined) {
    if (long ? stopPx >= entryPx : stopPx <= entryPx) throw new InputError(`A ${side} stop must be ${long ? "below" : "above"} the entry price (${round(entryPx, 4)}). Got ${stopPx}.`);
    if (long ? stopPx <= liquidationPx : stopPx >= liquidationPx) throw new InputError(`The stop ${stopPx} is past the estimated liquidation price ${round(liquidationPx, 4)}: the position would be liquidated first. Use a stop ${long ? "above" : "below"} ${round(liquidationPx, 4)} or lower the leverage.`);
    const gap = Math.abs(stopPx - liquidationPx) / entryPx;
    if (gap < 0.005) warnings.push(`The stop is within 0.5% of the liquidation price. A fast move can liquidate before the watcher closes.`);
  }
  if (tpPx !== undefined && (long ? tpPx <= entryPx : tpPx >= entryPx)) throw new InputError(`A ${side} take-profit must be ${long ? "above" : "below"} the entry price (${round(entryPx, 4)}). Got ${tpPx}.`);
  return warnings;
}

/** The opening order from a previewOpen() result. A market order is IOC at the worst accepted price. */
export function buildOpenOrder(p: OpenPreview, opts: { headBlock: bigint; postOnly?: boolean; expiryBlocks?: number }): EvmTx {
  const isMarket = p.orderKind === "market";
  if (opts.postOnly && isMarket) throw new InputError("--post-only needs --limit.");
  return execOrderTx({
    perpId: BigInt(p.market.id),
    orderType: p.isLong ? ORDER_TYPE.OpenLong : ORDER_TYPE.OpenShort,
    pricePNS: toPNS(p.market, p.limitPx),
    lotLNS: p.lotLNS,
    immediateOrCancel: isMarket,
    postOnly: !isMarket && !!opts.postOnly,
    leverageHdths: BigInt(Math.round(p.leverage * 100)),
    expiryBlock: !isMarket && opts.expiryBlocks ? opts.headBlock + BigInt(opts.expiryBlocks) : 0n,
    lastExecutionBlock: opts.headBlock + ORDER_VALID_BLOCKS,
  }, `${isMarket ? "Open" : "Place a limit order to open"} a ${p.leverage}x ${p.isLong ? "long" : "short"} of ${p.size} ${p.market.symbol} on Perpl${isMarket ? "" : ` at ${p.limitPx}`}`);
}

/** Lots to close. A full close uses the exact position size: a close larger than the position reverts. */
export function closeLots(m: PerplMarket, positionSize: number, fraction: number): bigint {
  const posLots = toLNS(m, positionSize);
  if (posLots < 1n) throw new InputError(`The ${m.symbol} position is smaller than one lot.`);
  const lots = fraction >= 0.9999 ? posLots : toLNS(m, positionSize * fraction);
  if (lots < 1n) throw new InputError(`That part (${fraction}) is smaller than the smallest ${m.symbol} order (${m.minSize}).`);
  return lots > posLots ? posLots : lots;
}

/** A reduce-only market close (IOC at mark +/- slippage). */
export function buildCloseOrder(m: PerplMarket, pos: Pick<PerplPosition, "side" | "size">, opts: { fraction: number; slippageBps: number; headBlock: bigint; markPx?: number }): { tx: EvmTx; lots: bigint; px: number } {
  const lots = closeLots(m, pos.size, opts.fraction);
  const isLong = pos.side === "long";
  const mark = opts.markPx ?? m.markPx;
  if (!(mark > 0)) throw new InputError(`No mark price for ${m.symbol}.`);
  const slip = opts.slippageBps / 10_000;
  const px = isLong ? mark * (1 - slip) : mark * (1 + slip);
  const size = Number(lots) / 10 ** m.sizeDecimals;
  const tx = execOrderTx({
    perpId: BigInt(m.id), orderType: isLong ? ORDER_TYPE.CloseLong : ORDER_TYPE.CloseShort, pricePNS: toPNS(m, px), lotLNS: lots,
    immediateOrCancel: true, lastExecutionBlock: opts.headBlock + ORDER_VALID_BLOCKS,
  }, `Close ${opts.fraction >= 0.9999 ? "all" : `${round(opts.fraction * 100, 1)}%`} (${size} ${m.symbol}) of the ${m.symbol} ${pos.side} on Perpl`);
  return { tx, lots, px };
}

/**
 * A take-profit as a native resting reduce-only order: CloseLong above the bid for a long, CloseShort below the ask for a short.
 * It is post-only, so it never trades at once. It needs some free AUSD in the account for the recycle fee.
 */
export function buildTakeProfitOrder(m: PerplMarket, side: Side, lots: bigint, tpPx: number, headBlock: bigint): EvmTx {
  const long = side === "long";
  if (long ? tpPx <= m.bidPx : tpPx >= m.askPx) throw new InputError(`A ${side} take-profit must be ${long ? "above the best bid" : "below the best ask"} (${long ? m.bidPx : m.askPx}). Got ${tpPx}.`);
  if (lots < 1n) throw new InputError("The take-profit size is below one lot.");
  return execOrderTx({
    perpId: BigInt(m.id), orderType: long ? ORDER_TYPE.CloseLong : ORDER_TYPE.CloseShort, pricePNS: toPNS(m, tpPx), lotLNS: lots,
    postOnly: true, lastExecutionBlock: headBlock + ORDER_VALID_BLOCKS,
  }, `Take profit: ${long ? "sell" : "buy"} ${Number(lots) / 10 ** m.sizeDecimals} ${m.symbol} at ${tpPx} on Perpl (resting, reduce-only)`);
}

/** Free AUSD kept in the account so a resting order can pay the recycle fee. */
export const RESTING_ORDER_BUFFER_USD = 1;
