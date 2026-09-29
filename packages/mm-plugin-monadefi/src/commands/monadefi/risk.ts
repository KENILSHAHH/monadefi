import { getMarket } from "@app/perpl";
import { type CommandIO, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { optional, parseLeverage, parseMarket, parsePositive, parseSide, parseAddress } from "../../lib/args";
import { getConfig } from "../../lib/config";
import { num } from "../../lib/format";
import { selectedAddress, toCommandError, usePerpl, type Ctx } from "../../lib/host";
import { text } from "../../lib/inputs";
import { applyRisk, type RiskApplied } from "../../lib/orders";
import { assessTrade, type RiskSignal, type RiskVerdict } from "../../lib/risk";

const inputs = {
  market: text("market", "Perpl market symbol, for example ETH", true),
  side: text("side", "long or short", true),
  leverage: text("leverage", "Leverage, for example 5", true),
  margin: text("margin", "Margin in AUSD (USD)", true),
  stop: text("stop", "Planned stop price (optional)"),
  address: text("address", "Trader address for wallet-level Nansen signals (default: the selected wallet)"),
};

interface Result {
  market: string; side: string; requested: { leverage: number; marginUsd: number; notionalUsd: number; stopPx?: number };
  markPx: number; marketMaxLeverage: number; verdict: RiskVerdict; segments: Record<string, RiskSignal[]>; wouldApply: RiskApplied & { notionalUsd: number };
}

export function groupSignals(signals: RiskSignal[]): Record<string, RiskSignal[]> {
  const out: Record<string, RiskSignal[]> = {};
  for (const s of signals) (out[String(s.segment ?? "general")] ??= []).push(s);
  return out;
}

export default class MonadefiRisk extends PluginCommand<Result> {
  static override description = "Nansen risk verdict for a planned Perpl trade: score, segments, and what the plugin would change (leverage, size, stop).";
  static override examples = ["<%= config.bin %> monadefi risk --market ETH --side long --leverage 5 --margin 20", "<%= config.bin %> monadefi risk --market BTC --side short --leverage 3 --margin 50 --json"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "monadefi:risk";

  async execute(io: CommandIO): Promise<Result> {
    try {
      const f = await io.resolveInputs(inputs);
      const ctx = this.ctx as unknown as Ctx;
      await usePerpl(ctx);
      const m = await getMarket(parseMarket(f.market));
      const side = parseSide(f.side);
      const leverage = parseLeverage(f.leverage, m.maxLeverage);
      const marginUsd = parsePositive("margin", f.margin);
      const stopPx = optional(f.stop) ? parsePositive("stop", f.stop) : undefined;
      let trader: string | undefined = optional(f.address) ? parseAddress(f.address) : undefined;
      if (!trader) {
        try {
          trader = selectedAddress(ctx.walletStateManager.read());
        } catch {
          trader = undefined;
        }
      }
      const verdict = await assessTrade({ apiKey: getConfig("nansen-key"), market: m.symbol, side, leverage, marginUsd, marketMaxLeverage: m.maxLeverage, trader });
      const entry = side === "long" ? m.askPx || m.markPx : m.bidPx || m.markPx;
      const applied = applyRisk({ leverage, marginUsd, stopPx }, verdict, { entryPx: entry, side });
      const segments = groupSignals(verdict.signals);
      io.emit(`Nansen verdict for ${side} ${m.symbol} ${leverage}x, ${marginUsd} AUSD margin (mark ${num(m.markPx)}):`);
      io.emit(`  data: ${verdict.dataAvailable ? "yes" : "no"}   score: ${verdict.score}   level: ${verdict.level}   decision: ${verdict.decision.toUpperCase()}`);
      for (const r of verdict.reasons) io.emit(`  reason: ${r}`);
      for (const [seg, list] of Object.entries(segments)) {
        io.emit(`  [${seg}]`);
        for (const x of list) io.emit(`    ${x.label ?? x.name ?? x.id}: ${typeof x.value === "number" ? num(x.value, 3) : String(x.value ?? "-")}${x.unit ? ` ${x.unit}` : ""}${x.window ? ` (${x.window})` : ""}  ${x.direction ?? ""}${typeof x.impact === "number" ? ` impact ${num(x.impact, 2)}` : ""}`);
      }
      if (applied.blocked) io.emit("  open-perpl would REFUSE this trade (override needs --ignore-risk --yes).");
      else if (applied.changes.length) for (const c of applied.changes) io.emit(`  change: ${c}`);
      else io.emit("  open-perpl would send it unchanged.");
      return {
        market: m.symbol, side, requested: { leverage, marginUsd, notionalUsd: leverage * marginUsd, ...(stopPx ? { stopPx } : {}) },
        markPx: m.markPx, marketMaxLeverage: m.maxLeverage, verdict, segments, wouldApply: { ...applied, notionalUsd: applied.leverage * applied.marginUsd },
      };
    } catch (err) {
      throw toCommandError(err);
    }
  }

  override successHint(d: Result): string {
    if (d.wouldApply.blocked) return "Blocked by Nansen. Do not open this trade.";
    return `Decision ${d.verdict.decision}: ${d.wouldApply.leverage}x, ${d.wouldApply.marginUsd} AUSD${d.wouldApply.stopPx ? `, stop ${d.wouldApply.stopPx}` : ""}. Open with: mm monadefi open-perpl --market ${d.market} --side ${d.side} --leverage ${d.requested.leverage} --margin ${d.requested.marginUsd}`;
  }
}
