// Read what a Perpl transaction did from its receipt logs.
import { PERPL_EXCHANGE, perplAbi, type PerplMarket } from "@app/perpl";
import { parseEventLogs, type Log } from "viem";

export interface FillReport {
  events: string[];
  filledSize: number;
  avgFillPx: number | null;
  feeUsd: number;
  notFilled: number;
  restingOrderIds: number[];
  postFailed: boolean;
}

export function readFills(m: PerplMarket, logs: readonly Log[]): FillReport {
  const own = logs.filter((l) => l.address?.toLowerCase() === PERPL_EXCHANGE.toLowerCase());
  const events = parseEventLogs({ abi: perplAbi, logs: own as Log[], strict: false });
  const scale = (v: bigint | undefined, d: number) => Number(v ?? 0n) / 10 ** d;
  const fills = events.filter((e) => e.eventName === "TakerOrderFilledV2").map((e) => e.args as { entryPricePNS: bigint; lotLNS: bigint; feeCNS: bigint });
  const filledSize = fills.reduce((s, f) => s + scale(f.lotLNS, m.sizeDecimals), 0);
  const notional = fills.reduce((s, f) => s + scale(f.entryPricePNS, m.priceDecimals) * scale(f.lotLNS, m.sizeDecimals), 0);
  const ioc = events.find((e) => e.eventName === "ImmediateOrCancelExecuted")?.args as { unmatchedLotLNS: bigint } | undefined;
  const placed = events.filter((e) => e.eventName === "OrderPlaced").map((e) => Number((e.args as { orderId: bigint }).orderId)).filter((id) => id > 0);
  return {
    events: events.map((e) => e.eventName ?? "unknown"),
    filledSize,
    avgFillPx: filledSize > 0 ? notional / filledSize : null,
    feeUsd: fills.reduce((s, f) => s + scale(f.feeCNS, 6), 0),
    notFilled: ioc ? scale(ioc.unmatchedLotLNS, m.sizeDecimals) : 0,
    restingOrderIds: placed,
    postFailed: events.some((e) => e.eventName === "OrderPostFailed"),
  };
}
