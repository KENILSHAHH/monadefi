import { getMarket, getPosition } from "@app/perpl";
import { CommandError, type CommandIO, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { isTruthyFlag, optional, parseMarket, parseOptionalPositive, parsePercent } from "../../lib/args";
import { closePosition, type CloseResult } from "../../lib/close";
import { getConfig, slippageBps } from "../../lib/config";
import { num } from "../../lib/format";
import { signerAddress, toCommandError, usePerpl, type Ctx } from "../../lib/host";
import { bool, slippageInput, text } from "../../lib/inputs";
import { monitorPosition } from "../../lib/risk";
import { protectStep, tightenStop, tightenTo, type ProtectCheck, type ProtectState } from "../../lib/strategy";

const inputs = {
  market: text("market", "Perpl market symbol of the open position", true),
  stop: text("stop", "Stop price: close when the mark crosses it"),
  trailing: text("trailing", "Trailing stop distance from the best mark seen, for example 3%"),
  tp: text("tp", "Take-profit price: close when the mark reaches it"),
  interval: text("interval", "Seconds between price checks (default 5, minimum 2)"),
  "nansen-every": text("nansen-every", "Minutes between Nansen position checks (default 5)"),
  "max-checks": text("max-checks", "Stop after this many checks (default: run until Ctrl-C)"),
  "slippage-bps": slippageInput,
  "watch-only": bool("watch-only", "Print triggers but never send the close"),
};

export interface ProtectItem { at: string; markPx: number; check: ProtectCheck; nansen?: { action: string; reason: string } }
interface Result {
  market: string; side: string; checks: number; stoppedBy: "trigger" | "nansen_exit" | "signal" | "max_checks" | "position_gone";
  trigger?: string; lastMarkPx?: number; finalStop: number | null; close?: CloseResult;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

export default class MonadefiProtect extends PluginCommand<Result, ProtectItem> {
  static override description = "Foreground stop / trailing stop / take-profit watcher for a Perpl position. Polls the mark price and Nansen, and closes through Agent Wallet signing when a level hits. Ctrl-C stops it.";
  static override examples = [
    "<%= config.bin %> monadefi protect --market ETH --stop 2300",
    "<%= config.bin %> monadefi protect --market ETH --stop 2300 --trailing 3% --tp 2700",
    "<%= config.bin %> monadefi protect --market BTC --trailing 2% --interval 3 --json",
  ];
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "monadefi:protect";

  async execute(io: CommandIO<ProtectItem>): Promise<Result> {
    try {
      const f = await io.resolveInputs(inputs);
      const ctx = this.ctx as unknown as Ctx;
      await usePerpl(ctx);
      const address = signerAddress(ctx);
      const m = await getMarket(parseMarket(f.market));
      const stopPx = parseOptionalPositive("stop", f.stop);
      const trailing = optional(f.trailing) ? parsePercent("trailing", f.trailing) : undefined;
      const tpPx = parseOptionalPositive("tp", f.tp);
      if (stopPx === undefined && trailing === undefined && tpPx === undefined) throw new CommandError("MISSING_FLAG", "Give at least one of --stop, --trailing or --tp.", "Example: mm monadefi protect --market ETH --stop 2300 --trailing 3%");
      const intervalMs = (parseOptionalPositive("interval", f.interval, { min: 2, max: 3600 }) ?? 5) * 1000;
      const nansenMs = (parseOptionalPositive("nansen-every", f["nansen-every"], { min: 1, max: 1440 }) ?? 5) * 60_000;
      const maxChecks = parseOptionalPositive("max-checks", f["max-checks"]);
      const slip = slippageBps(optional(f["slippage-bps"]) ?? "100");
      const watchOnly = isTruthyFlag(f["watch-only"]);

      const start = await getPosition(address, m.id);
      if (!start) throw new CommandError("POSITION_NOT_FOUND", `No open ${m.symbol} position on Perpl.`, "Open one with: mm monadefi open-perpl ...");
      const long = start.side === "long";
      if (stopPx !== undefined && (long ? stopPx >= start.markPx : stopPx <= start.markPx)) throw new CommandError("INVALID_INPUT", `The ${start.side} stop ${stopPx} is already crossed (mark ${start.markPx}).`, `Close now with: mm monadefi close-perpl --market ${m.symbol}`);
      if (stopPx !== undefined && start.liquidationPx !== null && (long ? stopPx <= start.liquidationPx : stopPx >= start.liquidationPx)) io.emit(`warning: the stop ${stopPx} is past the liquidation price ${num(start.liquidationPx)}. Liquidation comes first.`);
      if (tpPx !== undefined && (long ? tpPx <= start.markPx : tpPx >= start.markPx)) throw new CommandError("INVALID_INPUT", `The ${start.side} take-profit ${tpPx} is already reached (mark ${start.markPx}).`, `Close now with: mm monadefi close-perpl --market ${m.symbol}`);

      let state: ProtectState = { side: start.side, stopPx, trailing, tpPx };
      const apiKey = getConfig("nansen-key");
      let lastNansen = 0;
      let checks = 0;
      let lastMark: number | undefined;
      io.emit(`Protecting ${start.side} ${start.size} ${m.symbol} (entry ${num(start.entryPx)}, liq ${num(start.liquidationPx)}). stop ${stopPx ?? "-"} trailing ${trailing ? `${trailing * 100}%` : "-"} tp ${tpPx ?? "-"}. Nansen ${apiKey ? `every ${nansenMs / 60_000} min` : "off (no key)"}. Ctrl-C stops.`);

      while (!io.signal.aborted) {
        if (maxChecks !== undefined && checks >= maxChecks) return { market: m.symbol, side: start.side, checks, stoppedBy: "max_checks", lastMarkPx: lastMark, finalStop: protectStep(state, lastMark ?? start.markPx).check.effectiveStop };
        let pos;
        try {
          pos = await getPosition(address, m.id);
        } catch (err) {
          io.emit(`read failed, retrying: ${err instanceof Error ? err.message : err}`);
          await sleep(intervalMs, io.signal);
          continue;
        }
        if (!pos || pos.side !== start.side) {
          io.emit(`The ${m.symbol} ${start.side} is no longer open. The watcher stops.`);
          return { market: m.symbol, side: start.side, checks, stoppedBy: "position_gone", lastMarkPx: lastMark, finalStop: null };
        }
        checks++;
        lastMark = pos.markPx;
        let nansen: ProtectItem["nansen"];
        if (apiKey && Date.now() - lastNansen >= nansenMs) {
          lastNansen = Date.now();
          const v = await monitorPosition({ apiKey, market: m.symbol, side: pos.side, entryPx: pos.entryPx, markPx: pos.markPx, sizeUsd: pos.notionalUsd, leverage: pos.leverage, marketMaxLeverage: m.maxLeverage, trader: address });
          nansen = { action: v.action, reason: v.reason };
          // tighten_stop: use the engine's stop when it gives one, else move halfway to the mark. Never loosen.
          if (v.action === "tighten_stop") state = v.stopPx !== undefined ? tightenTo(state, v.stopPx, pos.markPx) : tightenStop(state, pos.markPx);
          if (v.action === "reduce") io.emit(`Nansen suggests closing ${Math.round((v.reduceFraction ?? 0.5) * 100)}%: mm monadefi close-perpl --market ${m.symbol} --fraction ${v.reduceFraction ?? 0.5}`);
        }
        const step = protectStep(state, pos.markPx);
        state = step.state;
        let check = step.check;
        if (check.action === "hold" && nansen?.action === "exit") check = { ...check, action: "close", trigger: "nansen_exit", reason: `Nansen says exit: ${nansen.reason}` };
        const item: ProtectItem = { at: new Date().toISOString(), markPx: pos.markPx, check, ...(nansen ? { nansen } : {}) };
        io.emit(`${item.at}  mark ${num(pos.markPx)}  stop ${num(check.effectiveStop)}  ${check.action.toUpperCase()}  ${check.reason}${nansen ? `  | Nansen: ${nansen.action} ${nansen.reason}` : ""}`);
        if (!io.isInteractive) io.yield(item);
        if (check.action === "close") {
          if (watchOnly) {
            io.emit("watch-only: no close sent.");
            return { market: m.symbol, side: start.side, checks, stoppedBy: check.trigger === "nansen_exit" ? "nansen_exit" : "trigger", trigger: check.trigger, lastMarkPx: pos.markPx, finalStop: check.effectiveStop };
          }
          const close = await closePosition({ ctx, io, commandId: this.pluginCommandId, market: m.symbol, fraction: 1, slippageBps: slip });
          return { market: m.symbol, side: start.side, checks, stoppedBy: check.trigger === "nansen_exit" ? "nansen_exit" : "trigger", trigger: check.trigger, lastMarkPx: pos.markPx, finalStop: check.effectiveStop, close };
        }
        await sleep(intervalMs, io.signal);
      }
      return { market: m.symbol, side: start.side, checks, stoppedBy: "signal", lastMarkPx: lastMark, finalStop: protectStep(state, lastMark ?? start.markPx).check.effectiveStop };
    } catch (err) {
      throw toCommandError(err);
    }
  }

  override successHint(d: Result): string {
    if (d.close) return `Closed by ${d.trigger}: ${d.close.status}${d.close.pending?.pollingId ? ` (approve: mm wallet requests watch ${d.close.pending.pollingId})` : ""}.`;
    return `Watcher stopped (${d.stoppedBy}) after ${d.checks} checks. The position is NOT protected while the watcher is off.`;
  }
}
