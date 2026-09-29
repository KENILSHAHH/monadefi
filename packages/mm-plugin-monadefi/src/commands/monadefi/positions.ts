import { getAccount, walletAusd, type PerplPosition } from "@app/perpl";
import { type CommandIO, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { optional, parseMarket } from "../../lib/args";
import { num, pct, table, usd } from "../../lib/format";
import { resolveAddress, toCommandError, usePerpl, type Ctx } from "../../lib/host";
import { addressInput, text } from "../../lib/inputs";

const inputs = { address: addressInput, market: text("market", "Only this market") };

interface Result {
  address: string;
  readVia: "agent-wallet" | "public-rpc";
  account: { exists: boolean; accountId: number | null; balanceAusd: number; lockedAusd: number; freeAusd: number; frozen: boolean };
  walletAusd: number;
  positions: (PerplPosition & { distanceToLiquidationPct: number | null })[];
}

export default class MonadefiPositions extends PluginCommand<Result> {
  static override description = "Show the Perpl account (AUSD free and locked) and open positions with liquidation price and distance.";
  static override examples = ["<%= config.bin %> monadefi positions", "<%= config.bin %> monadefi positions --json", "<%= config.bin %> monadefi positions --address 0xabc... --json"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "monadefi:positions";

  async execute(io: CommandIO): Promise<Result> {
    try {
      const { address: rawAddr, market } = await io.resolveInputs(inputs);
      const ctx = this.ctx as unknown as Ctx;
      const address = resolveAddress(ctx, rawAddr);
      const { source } = await usePerpl(ctx);
      const only = optional(market) ? parseMarket(market) : undefined;
      const [acct, inWallet] = await Promise.all([getAccount(address, only), walletAusd(address)]);
      const positions = acct.positions.map((p) => ({ ...p, distanceToLiquidationPct: p.distanceToLiquidation === null ? null : p.distanceToLiquidation * 100 }));
      io.emit(`Perpl account of ${address} (read via ${source})`);
      io.emit(acct.accountId === null ? "No Perpl account yet. The first deposit (at least 10 AUSD) opens it." : `AUSD balance ${usd(acct.balanceUsd)}  locked ${usd(acct.lockedUsd)}  free ${usd(acct.freeUsd)}${acct.frozen ? "  FROZEN" : ""}`);
      io.emit(`AUSD in the wallet on Monad: ${usd(inWallet)}`);
      if (positions.length) {
        io.emit(table(
          ["MARKET", "SIDE", "SIZE", "ENTRY", "MARK", "LEV", "MARGIN", "UPNL", "LIQ PX", "TO LIQ"],
          positions.map((p) => [p.market, p.side, num(p.size, 6), num(p.entryPx, 4), num(p.markPx, 4), `${num(p.leverage, 2)}x`, usd(p.marginUsd), usd(p.unrealizedPnl), num(p.liquidationPx, 4), pct(p.distanceToLiquidation)]),
        ));
      } else io.emit("No open positions.");
      return {
        address, readVia: source,
        account: { exists: acct.accountId !== null, accountId: acct.accountId, balanceAusd: acct.balanceUsd, lockedAusd: acct.lockedUsd, freeAusd: acct.freeUsd, frozen: acct.frozen },
        walletAusd: inWallet, positions,
      };
    } catch (err) {
      throw toCommandError(err);
    }
  }

  override successHint(d: Result): string {
    const near = d.positions.filter((p) => p.distanceToLiquidation !== null && p.distanceToLiquidation < 0.1);
    if (near.length) return `${near.map((p) => p.market).join(", ")} within 10% of liquidation. Consider: mm monadefi rebalance --risk conservative`;
    return `${d.positions.length} open position(s), ${d.account.freeAusd.toFixed(2)} AUSD free.`;
  }
}
