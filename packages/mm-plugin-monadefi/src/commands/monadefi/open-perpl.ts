import { fundingTxs, getMarket, getPosition, headBlock, previewOpen, toLNS, type PerplPosition } from "@app/perpl";
import { CommandError, type CommandIO, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { isTruthyFlag, optional, parseLeverage, parseMarket, parsePositive, parseSide } from "../../lib/args";
import { getConfig, slippageBps } from "../../lib/config";
import { readFills, type FillReport } from "../../lib/fills";
import { num, usd } from "../../lib/format";
import { executor, receiptLogs, signerAddress, toCommandError, usePerpl, type Ctx } from "../../lib/host";
import { bool, slippageInput, text } from "../../lib/inputs";
import { applyRisk, buildOpenOrder, buildTakeProfitOrder, checkLevels, RESTING_ORDER_BUFFER_USD } from "../../lib/orders";
import { assessTrade, type RiskVerdict } from "../../lib/risk";
import { sendPlanned } from "../../lib/send";
import { perplTx } from "../../lib/strategy";
import type { PlannedTx, SentTx } from "../../lib/types";

const inputs = {
  market: text("market", "Perpl market symbol, for example ETH", true),
  side: text("side", "long or short", true),
  leverage: text("leverage", "Leverage, from 1 to the market maximum", true),
  margin: text("margin", "Margin in AUSD (USD) to put in the position", true),
  limit: text("limit", "Limit price. Without it, the order is a market order (IOC at mark +/- slippage)"),
  "post-only": bool("post-only", "With --limit: rest on the book only, never take"),
  stop: text("stop", "Stop price. Kept by `mm monadefi protect` (Perpl has no native stop without its own API key)"),
  tp: text("tp", "Take-profit price. Placed as a native resting reduce-only order after the fill"),
  "slippage-bps": slippageInput,
  "ignore-risk": bool("ignore-risk", "Send even when Nansen blocks the trade (needs --yes)"),
  yes: bool("yes", "Confirm --ignore-risk"),
  "dry-run": bool("dry-run", "Build and show the plan, send nothing"),
};

interface Result {
  status: "dry_run" | "filled" | "partially_filled" | "resting" | "not_filled" | "pending";
  market: string; side: string; address: string;
  requested: { leverage: number; marginUsd: number; stopPx?: number; tpPx?: number };
  sent: { leverage: number; marginUsd: number; size: number; limitPx: number; orderKind: "market" | "limit" };
  risk: { decision: RiskVerdict["decision"]; dataAvailable: boolean; score: number; level: string; overridden: boolean; changes: string[]; reasons: string[] };
  preview: { estEntryPx: number; estLiquidationPx: number; distanceToLiquidationPct: number; estFeeUsd: number; notionalUsd: number; warnings: string[] };
  depositAusd: number;
  plan: { description: string; to: string }[];
  transactions: SentTx[];
  pending?: SentTx;
  fills?: FillReport;
  takeProfit?: { status: string; orderIds?: number[]; tx?: SentTx; note?: string };
  stop?: { px: number; protectCommand: string };
  positionAfter?: PerplPosition | null;
}

export default class MonadefiOpenPerpl extends PluginCommand<Result> {
  static override description = "Open a Perpl perp position on Monad after a Nansen risk check. Every transaction goes through Agent Wallet signing, policy and MFA.";
  static override examples = [
    "<%= config.bin %> monadefi open-perpl --market ETH --side long --leverage 2 --margin 20",
    "<%= config.bin %> monadefi open-perpl --market ETH --side long --leverage 2 --margin 20 --stop 2300 --tp 2700",
    "<%= config.bin %> monadefi open-perpl --market BTC --side short --leverage 3 --margin 25 --limit 125000 --post-only",
    "<%= config.bin %> monadefi open-perpl --market ETH --side long --leverage 2 --margin 20 --dry-run --json",
  ];
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "monadefi:open-perpl";

  async execute(io: CommandIO): Promise<Result> {
    try {
      const f = await io.resolveInputs(inputs);
      const ctx = this.ctx as unknown as Ctx;
      const { client } = await usePerpl(ctx);
      const address = signerAddress(ctx);
      const m = await getMarket(parseMarket(f.market));
      const side = parseSide(f.side);
      const isLong = side === "long";
      const leverage = parseLeverage(f.leverage, m.maxLeverage);
      const marginUsd = parsePositive("margin", f.margin);
      const limitPx = optional(f.limit) ? parsePositive("limit", f.limit) : undefined;
      const postOnly = isTruthyFlag(f["post-only"]);
      if (postOnly && limitPx === undefined) throw new CommandError("INVALID_INPUT", "--post-only needs --limit.", "Add --limit <price> or drop --post-only.");
      const stopPx = optional(f.stop) ? parsePositive("stop", f.stop) : undefined;
      const tpPx = optional(f.tp) ? parsePositive("tp", f.tp) : undefined;
      const slip = slippageBps(optional(f["slippage-bps"]));
      const ignoreRisk = isTruthyFlag(f["ignore-risk"]);
      const yes = isTruthyFlag(f.yes);
      const dryRun = isTruthyFlag(f["dry-run"]);

      // 1. Nansen check, applied before anything is built.
      const verdict = await assessTrade({ apiKey: getConfig("nansen-key"), market: m.symbol, side, leverage, marginUsd, marketMaxLeverage: m.maxLeverage, trader: address });
      const entryRef = limitPx ?? (isLong ? m.askPx || m.markPx : m.bidPx || m.markPx);
      let applied = applyRisk({ leverage, marginUsd, stopPx, tpPx }, verdict, { entryPx: entryRef, side });
      let overridden = false;
      if (applied.blocked) {
        const why = verdict.reasons.join(" ") || "Nansen blocks this trade.";
        if (!ignoreRisk) throw new CommandError("RISK_BLOCKED", `Nansen blocks this ${side} on ${m.symbol} (score ${verdict.score}, ${verdict.level}). ${why} Nothing was sent.`, `See: mm monadefi risk --market ${m.symbol} --side ${side} --leverage ${leverage} --margin ${marginUsd}`);
        if (!yes) throw new CommandError("CONFIRM_REQUIRED", "--ignore-risk sends a trade that Nansen blocks. It needs --yes as well.", "Add --yes to confirm, or drop --ignore-risk.");
        overridden = true;
        applied = { leverage, marginUsd, stopPx, tpPx, blocked: false, changes: ["Nansen block overridden by --ignore-risk --yes."] };
      }
      for (const c of applied.changes) io.emit(`risk: ${c}`);

      // 2. Size and price the order on live data.
      const preview = await previewOpen({ market: m.id, isLong, leverage: applied.leverage, marginUsd: applied.marginUsd, orderKind: limitPx ? "limit" : "market", limitPx, slippageBps: slip, postOnly });
      for (const w of checkLevels({ side, entryPx: preview.estEntryPx, liquidationPx: preview.estLiquidationPx, stopPx: applied.stopPx, tpPx: applied.tpPx })) preview.warnings.push(w);

      // 3. Funding (approve + createAccount/deposit when the Perpl account lacks free AUSD), then the order.
      const resting = !!limitPx || applied.tpPx !== undefined;
      const needed = preview.marginUsd + preview.estFeeUsd + (resting ? RESTING_ORDER_BUFFER_USD : 0);
      const fund = await fundingTxs(address, needed);
      const head = await headBlock();
      const order = buildOpenOrder(preview, { headBlock: head, postOnly });
      const plan: PlannedTx[] = [...fund.txs.map((t) => perplTx(t, "perps.deposit")), perplTx(order, "perps.open")];

      const base: Omit<Result, "status" | "transactions"> = {
        market: m.symbol, side, address,
        requested: { leverage, marginUsd, ...(stopPx ? { stopPx } : {}), ...(tpPx ? { tpPx } : {}) },
        sent: { leverage: preview.leverage, marginUsd: preview.marginUsd, size: preview.size, limitPx: preview.limitPx, orderKind: preview.orderKind },
        risk: { decision: verdict.decision, dataAvailable: verdict.dataAvailable, score: verdict.score, level: verdict.level, overridden, changes: applied.changes, reasons: verdict.reasons },
        preview: { estEntryPx: preview.estEntryPx, estLiquidationPx: preview.estLiquidationPx, distanceToLiquidationPct: preview.distanceToLiquidation * 100, estFeeUsd: preview.estFeeUsd, notionalUsd: preview.notionalUsd, warnings: preview.warnings },
        depositAusd: fund.depositUsd,
        plan: plan.map((t) => ({ description: t.description, to: t.to })),
        ...(applied.stopPx ? { stop: { px: applied.stopPx, protectCommand: `mm monadefi protect --market ${m.symbol} --stop ${applied.stopPx}${applied.tpPx ? ` --tp ${applied.tpPx}` : ""}` } } : {}),
      };
      io.emit(`Plan (${plan.length} transaction${plan.length > 1 ? "s" : ""} on Monad):`);
      plan.forEach((t, i) => io.emit(`  ${i + 1}. ${t.description}`));
      io.emit(`  est. entry ${num(preview.estEntryPx)}  liq ${num(preview.estLiquidationPx)} (${num(preview.distanceToLiquidation * 100, 2)}% away)  fee ${usd(preview.estFeeUsd, 4)}`);
      for (const w of preview.warnings) io.emit(`  warning: ${w}`);
      if (dryRun) return { ...base, status: "dry_run", transactions: [] };

      // 4. Send through the Agent Wallet executor (policy, simulation, Blockaid, MFA).
      const exec = await executor(ctx, io, this.pluginCommandId);
      const sent = await sendPlanned(exec, plan, { signal: io.signal, onStep: (s, i, n) => io.emit(`  [${i + 1}/${n}] ${s.status} ${s.hash ?? (s.pollingId ? `pollingId ${s.pollingId}` : "")}`) });
      if (!sent.complete) return { ...base, status: "pending", transactions: sent.sent, pending: sent.pending };

      // 5. Fills from the order receipt.
      const orderTx = sent.sent[sent.sent.length - 1]!;
      const rec = await receiptLogs(client, orderTx.hash!);
      const fills = readFills(m, rec.logs);
      let status: Result["status"] = limitPx && fills.filledSize === 0 ? (fills.restingOrderIds.length ? "resting" : "not_filled") : fills.filledSize === 0 ? "not_filled" : fills.notFilled > 0 ? "partially_filled" : "filled";
      if (fills.filledSize > 0) io.emit(`Filled ${num(fills.filledSize, 6)} ${m.symbol} at ${num(fills.avgFillPx)} (fee ${usd(fills.feeUsd, 4)})${fills.notFilled ? `, ${fills.notFilled} not filled` : ""}.`);
      else if (status === "resting") io.emit(`Limit order resting on the book (order id ${fills.restingOrderIds.join(", ")}).`);
      else io.emit("The order did not fill at an accepted price. Any deposit stays in the Perpl account as free AUSD.");

      // 6. Take-profit: a native resting reduce-only order for the filled size.
      let takeProfit: Result["takeProfit"];
      if (applied.tpPx !== undefined) {
        if (fills.filledSize > 0) {
          const fresh = await getMarket(m.id);
          const tp = buildTakeProfitOrder(fresh, side, toLNS(fresh, fills.filledSize), applied.tpPx, await headBlock());
          const tpSent = await sendPlanned(exec, [perplTx(tp, "perps.modify")], { signal: io.signal });
          if (tpSent.complete) {
            const tpFills = readFills(fresh, (await receiptLogs(client, tpSent.sent[0]!.hash!)).logs);
            takeProfit = { status: tpFills.restingOrderIds.length ? "resting" : "not_placed", orderIds: tpFills.restingOrderIds, tx: tpSent.sent[0] };
          } else takeProfit = { status: "pending", tx: tpSent.pending };
        } else takeProfit = { status: "skipped", note: "No fill yet, so no take-profit was placed. Place it after the fill, or use `mm monadefi protect --tp`." };
      }
      const positionAfter = await getPosition(address, m.id).catch(() => null);
      if (status === "resting" && positionAfter) status = "partially_filled";
      return { ...base, status, transactions: sent.sent, fills, ...(takeProfit ? { takeProfit } : {}), positionAfter };
    } catch (err) {
      throw toCommandError(err);
    }
  }

  override successHint(d: Result): string {
    if (d.status === "dry_run") return `Dry run: ${d.plan.length} transaction(s). Run again without --dry-run to send.`;
    if (d.status === "pending") return `Waiting for approval${d.pending?.pollingId ? `: mm wallet requests watch ${d.pending.pollingId}` : ""}. After approval, check "mm monadefi positions" before you run anything again: an approved order still executes.`;
    if (d.stop) return `Status ${d.status}. Keep the stop alive with: ${d.stop.protectCommand}`;
    return `Status ${d.status}. See it with: mm monadefi positions`;
  }
}
