import { addMarginTx, fundingTxs, getAccount, getMarket, getPosition, walletAusd } from "@app/perpl";
import { type CommandIO, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { isTruthyFlag, optional, parseMarket, parseRiskProfile, type RiskProfile } from "../../lib/args";
import { closePosition } from "../../lib/close";
import { getConfig, slippageBps } from "../../lib/config";
import { num, table } from "../../lib/format";
import { executor, signerAddress, toCommandError, usePerpl, type Ctx } from "../../lib/host";
import { bool, slippageInput, text } from "../../lib/inputs";
import { assessTrade } from "../../lib/risk";
import { sendPlanned } from "../../lib/send";
import { perplTx, planRebalance, targetLeverage, type RebalancePlan } from "../../lib/strategy";
import type { SentTx } from "../../lib/types";

const inputs = {
  risk: text("risk", "Risk profile: conservative (2x), balanced (3x) or aggressive (5x), capped by Nansen and the market", true),
  market: text("market", "Only this market"),
  execute: bool("execute", "Send the transactions (default: dry run)"),
  "slippage-bps": slippageInput,
};

/** Perpl's minimum deposit. Wallet AUSD below it cannot be deposited. */
const MIN_DEPOSIT = 10;

interface PlanRow extends RebalancePlan { nansen: { decision: string; dataAvailable: boolean; score: number; reasons: string[] } }
interface Result {
  profile: RiskProfile; executed: boolean; address: string;
  funds: { freeAusd: number; walletAusd: number; usable: number };
  plans: PlanRow[];
  results: { market: string; action: string; status: string; transactions: SentTx[]; pollingId?: string; note?: string }[];
}

export default class MonadefiRebalance extends PluginCommand<Result> {
  static override description = "Bring each open Perpl position to the target leverage of a risk profile and the current Nansen verdict: add margin, or reduce size. Dry run unless --execute.";
  static override examples = ["<%= config.bin %> monadefi rebalance --risk conservative", "<%= config.bin %> monadefi rebalance --risk balanced --execute", "<%= config.bin %> monadefi rebalance --risk aggressive --market ETH --json"];
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "monadefi:rebalance";

  async execute(io: CommandIO): Promise<Result> {
    try {
      const f = await io.resolveInputs(inputs);
      const ctx = this.ctx as unknown as Ctx;
      await usePerpl(ctx);
      const address = signerAddress(ctx);
      const profile = parseRiskProfile(f.risk);
      const only = optional(f.market) ? parseMarket(f.market) : undefined;
      const doIt = isTruthyFlag(f.execute);
      const slip = slippageBps(optional(f["slippage-bps"]));
      const [acct, inWallet] = await Promise.all([getAccount(address, only), walletAusd(address)]);
      const usable = acct.freeUsd + (inWallet >= MIN_DEPOSIT ? inWallet / 1.01 : 0);
      const apiKey = getConfig("nansen-key");

      let pool = usable;
      const plans: PlanRow[] = [];
      for (const p of acct.positions) {
        const m = await getMarket(p.marketId);
        const v = await assessTrade({ apiKey, market: m.symbol, side: p.side, leverage: Math.max(1, Math.round(p.leverage * 100) / 100), marginUsd: p.marginUsd, marketMaxLeverage: m.maxLeverage, trader: address });
        const target = targetLeverage(profile, m.maxLeverage, v);
        const plan = planRebalance({ market: m.symbol, side: p.side, size: p.size, markPx: p.markPx, marginUsd: p.marginUsd, leverage: p.leverage, marketMaxLeverage: m.maxLeverage }, target, pool, v);
        if (plan.action === "add_margin") pool -= plan.addMarginUsd;
        if (plan.action === "reduce_and_add") pool = 0;
        plans.push({ ...plan, nansen: { decision: v.decision, dataAvailable: v.dataAvailable, score: v.score, reasons: v.reasons } });
      }
      io.emit(`Rebalance (${profile}) for ${address}. Free AUSD ${num(acct.freeUsd, 2)}, wallet AUSD ${num(inWallet, 2)}, usable ${num(usable, 2)}.`);
      io.emit(plans.length ? table(["MARKET", "SIDE", "LEV", "TARGET", "ACTION", "ADD", "CLOSE", "NANSEN"], plans.map((p) => [p.market, p.side, `${p.currentLeverage}x`, `${p.targetLeverage}x`, p.action, p.addMarginUsd ? num(p.addMarginUsd, 2) : "-", p.reduceFraction ? `${num(p.reduceFraction * 100, 1)}%` : "-", p.nansen.dataAvailable ? p.nansen.decision : "no data"])) : "No open positions.");
      for (const p of plans) io.emit(`  ${p.market}: ${p.reason}`);

      const results: Result["results"] = [];
      if (doIt) {
        const exec = await executor(ctx, io, this.pluginCommandId);
        for (const p of plans) {
          if (io.signal.aborted) break;
          if (p.action === "none") continue;
          if (p.action === "exit" || p.reduceFraction > 0) {
            const c = await closePosition({ ctx, io, commandId: this.pluginCommandId, market: p.market, fraction: p.action === "exit" ? 1 : p.reduceFraction, slippageBps: slip });
            results.push({ market: p.market, action: p.action === "exit" ? "close" : "reduce", status: c.status, transactions: c.transactions, ...(c.pending?.pollingId ? { pollingId: c.pending.pollingId } : {}) });
            if (c.status === "pending" || c.status === "not_filled" || p.action === "exit") continue;
          }
          // Re-read after any close: add what is really needed and really free.
          const m = await getMarket(p.market);
          const pos = await getPosition(address, m.id);
          if (!pos) continue;
          const need = Math.ceil((pos.size * pos.markPx / p.targetLeverage - pos.marginUsd) * 100) / 100;
          if (need < 0.01) continue;
          const [a2, w2] = await Promise.all([getAccount(address, m.id), walletAusd(address)]);
          const avail = a2.freeUsd + (w2 >= MIN_DEPOSIT ? w2 / 1.01 : 0);
          const add = Math.floor(Math.min(need, avail) * 100) / 100;
          if (add < 0.01) {
            results.push({ market: p.market, action: "add_margin", status: "skipped", transactions: [], note: "No usable AUSD left." });
            continue;
          }
          const fund = await fundingTxs(address, add);
          const txs = [...fund.txs.map((t) => perplTx(t, "perps.deposit")), perplTx(addMarginTx(m, add), "perps.modify")];
          const sent = await sendPlanned(exec, txs, { signal: io.signal });
          results.push({ market: p.market, action: "add_margin", status: sent.complete ? "done" : "pending", transactions: sent.sent, ...(sent.pending?.pollingId ? { pollingId: sent.pending.pollingId } : {}) });
          if (!sent.complete) break;
        }
      }
      return { profile, executed: doIt, address, funds: { freeAusd: acct.freeUsd, walletAusd: inWallet, usable }, plans, results };
    } catch (err) {
      throw toCommandError(err);
    }
  }

  override successHint(d: Result): string {
    const todo = d.plans.filter((p) => p.action !== "none").length;
    if (!d.executed) return todo ? `Dry run: ${todo} position(s) to change. Send with: mm monadefi rebalance --risk ${d.profile} --execute` : "All positions are at or below the target leverage.";
    const pend = d.results.find((r) => r.pollingId);
    return pend ? `Waiting for approval: mm wallet requests watch ${pend.pollingId}` : `${d.results.length} action(s) done. See: mm monadefi positions`;
  }
}
