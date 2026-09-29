import { type CommandIO, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { isTruthyFlag, optional, parseFraction, parseMarket } from "../../lib/args";
import { closePosition, type CloseResult as Result } from "../../lib/close";
import { slippageBps } from "../../lib/config";
import { toCommandError, type Ctx } from "../../lib/host";
import { bool, slippageInput, text } from "../../lib/inputs";

const inputs = {
  market: text("market", "Perpl market symbol, for example ETH", true),
  fraction: text("fraction", "Part to close: 0.5 or 50% (default 1 = all)"),
  "slippage-bps": slippageInput,
  "dry-run": bool("dry-run", "Build and show the order, send nothing"),
};

export default class MonadefiClosePerpl extends PluginCommand<Result> {
  static override description = "Close all or part of a Perpl position with a reduce-only market order, through Agent Wallet signing.";
  static override examples = ["<%= config.bin %> monadefi close-perpl --market ETH", "<%= config.bin %> monadefi close-perpl --market ETH --fraction 0.5", "<%= config.bin %> monadefi close-perpl --market BTC --fraction 25% --dry-run --json"];
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "monadefi:close-perpl";

  async execute(io: CommandIO): Promise<Result> {
    try {
      const f = await io.resolveInputs(inputs);
      return await closePosition({ ctx: this.ctx as unknown as Ctx, io, commandId: this.pluginCommandId, market: parseMarket(f.market), fraction: parseFraction(optional(f.fraction)), slippageBps: slippageBps(optional(f["slippage-bps"])), dryRun: isTruthyFlag(f["dry-run"]) });
    } catch (err) {
      throw toCommandError(err);
    }
  }

  override successHint(d: Result): string {
    if (d.status === "pending") return `Waiting for approval${d.pending?.pollingId ? `: mm wallet requests watch ${d.pending.pollingId}` : ""}.`;
    return `Status ${d.status}. See: mm monadefi positions`;
  }
}
