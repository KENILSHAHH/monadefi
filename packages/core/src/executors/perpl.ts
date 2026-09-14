// Perpl actions from the wallet of the user on Monad. Each action is built from live data when it runs, then sent with
// sendTransactions (through the gas sponsor when it is on, so the approval, the deposit and the order land as one transaction).
// Perpl finds the account from msg.sender, so the wallet of the user is the trader in every case.
import { parseEventLogs, type Address } from "viem";
import type { EvmTx } from "../adapters/evm";
import * as perpl from "../adapters/perpl";
import { perplAbi } from "@app/perpl";
import { sql } from "../db";
import { publicClient } from "../wallet";
import { sendTransactions } from "./evm";

export type PerplOp =
  | { op: "open"; market: string; side: "long" | "short"; leverage: number; marginUsd?: number; sizeUsd?: number; size?: number; orderKind: "market" | "limit"; limitPx?: number; postOnly?: boolean; slippageBps?: number; expiryBlocks?: number }
  | { op: "close"; market: string; fraction: number; orderKind: "market" | "limit"; limitPx?: number; slippageBps?: number }
  | { op: "cancel"; market: string; orderId: number }
  | { op: "modify"; market: string; orderId: number; limitPx: number; size: number }
  | { op: "margin"; market: string; action: "add" | "remove"; usd: number }
  | { op: "deposit"; usd: number }
  | { op: "withdraw"; usd: number };

export interface BuiltPerpl { txs: EvmTx[]; summary: string; markPx: number | null; depositUsd: number }

/** Build the transactions of a Perpl action for this moment. Checks that do not need a transaction run here too. */
export async function buildPerpl(address: Address, a: PerplOp): Promise<BuiltPerpl> {
  const head = await perpl.headBlock();
  const lastExecutionBlock = head + perpl.ORDER_VALID_BLOCKS;
  switch (a.op) {
    case "open": {
      const isLong = a.side === "long";
      const p = await perpl.previewOpen({ market: a.market, isLong, leverage: a.leverage, marginUsd: a.marginUsd, sizeUsd: a.sizeUsd, size: a.size, orderKind: a.orderKind, limitPx: a.limitPx, slippageBps: a.slippageBps, postOnly: a.postOnly });
      // The margin and the fee come from the free balance of the account. A deposit from the wallet fills a gap.
      const fund = await perpl.fundingTxs(address, p.marginUsd + p.estFeeUsd);
      const order = perpl.execOrderTx({
        perpId: BigInt(p.market.id), orderType: isLong ? perpl.ORDER_TYPE.OpenLong : perpl.ORDER_TYPE.OpenShort, pricePNS: perpl.toPNS(p.market, p.limitPx), lotLNS: p.lotLNS,
        immediateOrCancel: a.orderKind === "market", postOnly: a.orderKind === "limit" && !!a.postOnly, leverageHdths: BigInt(Math.round(a.leverage * 100)),
        expiryBlock: a.orderKind === "limit" && a.expiryBlocks ? head + BigInt(a.expiryBlocks) : 0n, lastExecutionBlock,
      }, `${a.orderKind === "market" ? "Open" : "Place a limit order to open"} a ${a.leverage}x ${a.side} of ${p.size} ${p.market.symbol} on Perpl`);
      return { txs: [...fund.txs, order], summary: order.description, markPx: p.market.markPx, depositUsd: fund.depositUsd };
    }
    case "close": {
      const m = await perpl.getMarket(a.market);
      const pos = await perpl.getPosition(address, m.id);
      if (!pos) throw new Error(`No open ${m.symbol} position on Perpl.`);
      const full = a.fraction >= 0.9999;
      const posLots = perpl.toLNS(m, pos.size);
      // A close larger than the position reverts on-chain, so a full close uses the exact size.
      const lots = full ? posLots : perpl.toLNS(m, pos.size * a.fraction);
      if (lots < 1n) throw new Error(`That part is smaller than the smallest ${m.symbol} order (${m.minSize}).`);
      const isLong = pos.side === "long";
      const slip = Math.min(a.slippageBps ?? perpl.DEFAULT_SLIPPAGE_BPS, perpl.MAX_SLIPPAGE_BPS) / 10_000;
      const px = a.orderKind === "limit" ? a.limitPx! : isLong ? m.markPx * (1 - slip) : m.markPx * (1 + slip);
      // A resting order needs some free AUSD in the account (else InsuficientFundsForRecycleFee). A small deposit fills it.
      let fund: { txs: EvmTx[]; depositUsd: number } = { txs: [], depositUsd: 0 };
      if (a.orderKind === "limit") {
        // A resting close is a take-profit. One on the wrong side of the book would fill at once.
        if (isLong ? px <= m.bidPx : px >= m.askPx) throw new Error(`A resting close of a ${pos.side} must be ${isLong ? "above the best bid" : "below the best ask"} (${isLong ? m.bidPx : m.askPx}). Use a market close to close now.`);
        try {
          fund = await perpl.fundingTxs(address, 0.01);
        } catch (err) {
          throw new Error(`A resting take-profit needs some free AUSD in the Perpl account. ${err instanceof Error ? err.message : err} Or set the take-profit as a server job (native=false).`);
        }
      }
      const tx = perpl.execOrderTx({
        perpId: BigInt(m.id), orderType: isLong ? perpl.ORDER_TYPE.CloseLong : perpl.ORDER_TYPE.CloseShort, pricePNS: perpl.toPNS(m, px), lotLNS: lots,
        immediateOrCancel: a.orderKind === "market", lastExecutionBlock,
      }, a.orderKind === "market" ? `Close ${full ? "all" : `${Math.round(a.fraction * 100)}%`} of the ${m.symbol} ${pos.side} on Perpl` : `Take profit: sell ${Number(lots) / 10 ** m.sizeDecimals} ${m.symbol} at ${px} on Perpl`);
      return { txs: [...fund.txs, tx], summary: tx.description, markPx: m.markPx, depositUsd: fund.depositUsd };
    }
    case "cancel": {
      const m = await perpl.getMarket(a.market);
      const tx = perpl.execOrderTx({ perpId: BigInt(m.id), orderType: perpl.ORDER_TYPE.Cancel, orderId: BigInt(a.orderId), lastExecutionBlock }, `Cancel Perpl order ${a.orderId} on ${m.symbol}`);
      return { txs: [tx], summary: tx.description, markPx: m.markPx, depositUsd: 0 };
    }
    case "modify": {
      const m = await perpl.getMarket(a.market);
      const lots = perpl.toLNS(m, a.size);
      if (lots < 1n) throw new Error(`The size is below the smallest ${m.symbol} order (${m.minSize}).`);
      // Always an explicit size: a Change with size 0 does not keep the old size exactly.
      const tx = perpl.execOrderTx({ perpId: BigInt(m.id), orderType: perpl.ORDER_TYPE.Change, orderId: BigInt(a.orderId), pricePNS: perpl.toPNS(m, a.limitPx), lotLNS: lots, lastExecutionBlock }, `Change Perpl order ${a.orderId} on ${m.symbol} to ${a.size} at ${a.limitPx}`);
      return { txs: [tx], summary: tx.description, markPx: m.markPx, depositUsd: 0 };
    }
    case "margin": {
      const m = await perpl.getMarket(a.market);
      const pos = await perpl.getPosition(address, m.id);
      if (!pos) throw new Error(`No open ${m.symbol} position on Perpl.`);
      if (a.action === "remove") {
        const tx = perpl.removeMarginTx(m, a.usd);
        return { txs: [tx], summary: `${tx.description}. A Perpl keeper applies it within about 2 minutes, or declines it when the position would be unsafe.`, markPx: m.markPx, depositUsd: 0 };
      }
      const fund = await perpl.fundingTxs(address, a.usd);
      const tx = perpl.addMarginTx(m, a.usd);
      return { txs: [...fund.txs, tx], summary: tx.description, markPx: m.markPx, depositUsd: fund.depositUsd };
    }
    case "deposit": {
      const acct = await perpl.getAccount(address);
      const fund = await perpl.fundingTxs(address, acct.freeUsd + a.usd);
      if (fund.depositUsd - a.usd > 0.01) throw new Error(`A Perpl deposit is at least ${fund.depositUsd} AUSD.`);
      return { txs: fund.txs, summary: `Deposit ${fund.depositUsd} AUSD from the wallet into Perpl`, markPx: null, depositUsd: fund.depositUsd };
    }
    case "withdraw": {
      const acct = await perpl.getAccount(address);
      if (acct.accountId === null) throw new Error("The wallet has no Perpl account.");
      if (a.usd > acct.freeUsd + 1e-6) throw new Error(`Only ${acct.freeUsd.toFixed(2)} AUSD is free in Perpl (the rest is in positions or held by orders). Close or reduce a position, or cancel orders, first.`);
      const tx = perpl.withdrawTx(a.usd);
      return { txs: [tx], summary: tx.description, markPx: null, depositUsd: 0 };
    }
  }
}

/** The order ids that the server placed, so open orders can be listed: the contract has no list for one account. */
async function rememberOrders(userId: string, address: string, marketId: number, orderIds: number[]) {
  for (const id of orderIds)
    await sql()`insert into perpl_orders (user_id, address, market_id, order_id) values (${userId}, ${address.toLowerCase()}, ${marketId}, ${id})
      on conflict (address, market_id, order_id) do update set created_at = now()`;
}

/** Resting orders of the wallet that the server placed. Orders that are gone (filled or cancelled) are forgotten. */
export async function openOrders(address: Address) {
  const acct = await perpl.getAccountInfo(address);
  if (!acct) return { orders: [], note: "No Perpl account." };
  const rows = await sql()<{ market_id: number; order_id: number }[]>`select market_id, order_id from perpl_orders where address = ${address.toLowerCase()}`;
  const live = await perpl.readOrders(Number(acct.accountId), rows.map((r) => ({ marketId: r.market_id, orderId: r.order_id })));
  for (const r of rows) if (!live.some((o) => o.marketId === r.market_id && o.orderId === r.order_id)) await sql()`delete from perpl_orders where address = ${address.toLowerCase()} and market_id = ${r.market_id} and order_id = ${r.order_id}`;
  return { orders: live, note: "Orders placed by this app. Orders placed on the Perpl website are not listed here." };
}

/** Run a Perpl action and report what happened, from the receipt events and the position after. */
export async function executePerpl(userId: string, address: Address, a: PerplOp, previewMarkPx?: number | null) {
  const built = await buildPerpl(address, a);
  // A market order built now uses the live price. When the price moved a lot since the user saw the card, stop.
  if (a.op === "open" && a.orderKind === "market" && previewMarkPx && built.markPx) {
    const moved = Math.abs(built.markPx - previewMarkPx) / previewMarkPx;
    if (moved > 0.02) throw new Error(`The price moved ${(moved * 100).toFixed(1)}% since the preview (${previewMarkPx} to ${built.markPx}). Nothing was sent. Ask again for a fresh preview.`);
  }
  const sent = await sendTransactions(userId, "monad", built.txs);
  const receipts = await Promise.all([...new Set(sent.map((s) => s.hash))].map((hash) => publicClient("monad").getTransactionReceipt({ hash: hash as `0x${string}` })));
  const events = parseEventLogs({ abi: perplAbi, logs: receipts.flatMap((r) => r.logs).filter((l) => l.address.toLowerCase() === perpl.PERPL_EXCHANGE.toLowerCase()) });
  const market = "market" in a ? await perpl.getMarket(a.market) : null;
  const scale = (v: bigint, d: number) => Number(v) / 10 ** d;
  const fills = events.filter((e) => e.eventName === "TakerOrderFilledV2").map((e) => e.args as { entryPricePNS: bigint; lotLNS: bigint; feeCNS: bigint });
  const filledSize = market ? fills.reduce((s, f) => s + scale(f.lotLNS, market.sizeDecimals), 0) : 0;
  const placed = events.filter((e) => e.eventName === "OrderPlaced").map((e) => Number((e.args as { orderId: bigint }).orderId)).filter((id) => id > 0);
  if (market && placed.length) await rememberOrders(userId, address, market.id, placed);
  const ioc = events.find((e) => e.eventName === "ImmediateOrCancelExecuted")?.args as { unmatchedLotLNS: bigint; totalLotLNS: bigint } | undefined;
  const result: Record<string, unknown> = {
    summary: built.summary,
    receipts: sent,
    explorer: sent[sent.length - 1]?.explorer,
    ...(built.depositUsd ? { depositedAusd: built.depositUsd } : {}),
    ...(market && fills.length ? {
      filledSize,
      avgFillPx: fills.reduce((s, f) => s + scale(f.entryPricePNS, market.priceDecimals) * scale(f.lotLNS, market.sizeDecimals), 0) / (filledSize || 1),
      feeUsd: fills.reduce((s, f) => s + scale(f.feeCNS, 6), 0),
    } : {}),
    ...(ioc && market && ioc.unmatchedLotLNS > 0n ? { notFilled: scale(ioc.unmatchedLotLNS, market.sizeDecimals), note: "Part of the order did not fill at an accepted price. Nothing rests on the book." } : {}),
    ...(placed.length ? { restingOrderIds: placed } : {}),
    events: events.map((e) => e.eventName),
  };
  if (market) result.positionAfter = await perpl.getPosition(address, market.id).catch(() => null);
  if (a.op === "deposit" || a.op === "withdraw") result.accountAfter = await perpl.getAccount(address).then((x) => ({ balanceUsd: x.balanceUsd, freeUsd: x.freeUsd })).catch(() => null);
  if (a.op === "open" && a.orderKind === "market" && fills.length === 0) throw new Error(`The order did not fill: no ${market?.symbol} liquidity at an accepted price. The deposit (if any) stays in the Perpl account. Receipt: ${result.explorer}`);
  return result;
}

/**
 * Stop-loss and take-profit as server jobs. Perpl has trigger orders only through its own API (an API key made on the Perpl
 * website), so the server watches the Perpl mark price and sends a reduce-only market close when it crosses the level.
 * A job closes only a position on the same side, and does nothing when that position is gone.
 */
export async function createExitJobs(userId: string, args: { market: string; side: "long" | "short"; stopLossPx?: number; takeProfitPx?: number; fraction?: number; days?: number }) {
  const { createJob } = await import("../jobs");
  const isLong = args.side === "long";
  const fraction = args.fraction ?? 1;
  const out: { kind: "stop_loss" | "take_profit"; jobId: string; fires: string }[] = [];
  for (const [kind, px] of [["stop_loss", args.stopLossPx], ["take_profit", args.takeProfitPx]] as const) {
    if (!px) continue;
    // A stop of a long fires below, a take-profit of a long above. The reverse for a short.
    const op = (kind === "stop_loss") === isLong ? "below" : "above";
    const job = await createJob(userId, {
      name: `${kind === "stop_loss" ? "Stop-loss" : "Take-profit"} ${args.market} ${args.side} at ${px}`,
      condition: { type: "price", asset: args.market, op, value: px },
      action: { type: "perpl", op: "close", market: args.market, fraction, side: args.side, slippageBps: 100 },
      days: args.days ?? 90,
    });
    out.push({ kind, jobId: job.id, fires: job.conditionText });
  }
  return out;
}
