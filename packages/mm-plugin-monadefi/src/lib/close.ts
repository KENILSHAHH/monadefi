// Close all or part of a Perpl position. Shared by close-perpl, protect and rebalance.
import { getMarket, getPosition, headBlock, type PerplPosition } from "@app/perpl";
import { CommandError, type CommandIO } from "@metamask/agent-wallet/plugin";
import { readFills, type FillReport } from "./fills";
import { num, usd } from "./format";
import { executor, receiptLogs, signerAddress, usePerpl, type Ctx } from "./host";
import { buildCloseOrder } from "./orders";
import { sendPlanned } from "./send";
import { perplTx } from "./strategy";
import type { SentTx } from "./types";

export interface CloseResult {
  status: "dry_run" | "closed" | "reduced" | "not_filled" | "pending";
  market: string; side: string; fraction: number; size: number; worstPx: number;
  positionBefore: PerplPosition; positionAfter?: PerplPosition | null;
  transactions: SentTx[]; pending?: SentTx; fills?: FillReport;
}

export async function closePosition(args: { ctx: Ctx; io: CommandIO; commandId: string; market: string; fraction: number; slippageBps: number; dryRun?: boolean }): Promise<CloseResult> {
  const { client } = await usePerpl(args.ctx);
  const address = signerAddress(args.ctx);
  const m = await getMarket(args.market);
  const pos = await getPosition(address, m.id);
  if (!pos) throw new CommandError("POSITION_NOT_FOUND", `No open ${m.symbol} position on Perpl for ${address}.`, "See: mm monadefi positions");
  const { tx, px, lots } = buildCloseOrder(m, pos, { fraction: args.fraction, slippageBps: args.slippageBps, headBlock: await headBlock() });
  const size = Number(lots) / 10 ** m.sizeDecimals;
  args.io.emit(`${tx.description} (worst price ${num(px)}, mark ${num(m.markPx)}, uPnL ${usd(pos.unrealizedPnl)})`);
  const base = { market: m.symbol, side: pos.side, fraction: args.fraction, size, worstPx: px, positionBefore: pos };
  if (args.dryRun) return { ...base, status: "dry_run", transactions: [] };
  const exec = await executor(args.ctx, args.io, args.commandId);
  const sent = await sendPlanned(exec, [perplTx(tx, "perps.close")], { signal: args.io.signal });
  if (!sent.complete) return { ...base, status: "pending", transactions: [], pending: sent.pending };
  const fills = readFills(m, (await receiptLogs(client, sent.sent[0]!.hash!)).logs);
  const after = await getPosition(address, m.id).catch(() => null);
  const status = fills.filledSize === 0 ? "not_filled" : after ? "reduced" : "closed";
  args.io.emit(status === "not_filled" ? "The close did not fill at an accepted price. Try a larger --slippage-bps." : `Closed ${num(fills.filledSize, 6)} ${m.symbol} at ${num(fills.avgFillPx)} (fee ${usd(fills.feeUsd, 4)}).`);
  return { ...base, status, transactions: sent.sent, fills, positionAfter: after };
}

