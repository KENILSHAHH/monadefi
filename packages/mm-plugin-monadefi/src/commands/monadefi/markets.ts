import { findMarkets, type PerplMarket } from "@app/perpl";
import { type CommandIO, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { optional } from "../../lib/args";
import { compactUsd, num, table } from "../../lib/format";
import { toCommandError, usePerpl } from "../../lib/host";
import { text } from "../../lib/inputs";

const inputs = { market: text("market", "Filter by market symbol (for example ETH)") };

interface MarketRow {
  symbol: string; id: number; markPx: number; oraclePx: number; maxLeverage: number;
  fundingRatePct: number; fundingIntervalMin: number; fundingAprPct: number; change24hPct: number;
  dayVolumeUsd: number; openInterestUsd: number; takerFeeBps: number; makerFeeBps: number; minSize: number;
}
interface Result { venue: "perpl"; chainId: 143; asOf: string; markets: MarketRow[] }

const r = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

export const marketRow = (m: PerplMarket): MarketRow => ({
  symbol: m.symbol, id: m.id, markPx: m.markPx, oraclePx: m.oraclePx, maxLeverage: m.maxLeverage,
  fundingRatePct: r(m.fundingRate * 100, 6), fundingIntervalMin: Math.round(m.fundingIntervalSec / 60),
  // Funding APR from the per-interval rate. The interval is in seconds of the market config.
  fundingAprPct: r(m.fundingIntervalSec > 0 ? m.fundingRate * (365 * 24 * 3600 / m.fundingIntervalSec) * 100 : 0, 4),
  change24hPct: r(m.change24hPct, 4), dayVolumeUsd: m.dayVolumeUsd, openInterestUsd: m.openInterestUsd,
  takerFeeBps: r(m.takerFee * 10_000, 4), makerFeeBps: r(m.makerFee * 10_000, 4), minSize: m.minSize,
});

export default class MonadefiMarkets extends PluginCommand<Result> {
  static override description = "List Perpl perpetual markets on Monad: mark price, max leverage, funding and 24h volume.";
  static override examples = ["<%= config.bin %> monadefi markets", "<%= config.bin %> monadefi markets --market ETH --json"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "monadefi:markets";

  async execute(io: CommandIO): Promise<Result> {
    try {
      const { market } = await io.resolveInputs(inputs);
      await usePerpl(null); // Public market data only: no wallet access is needed.
      const list = (await findMarkets(optional(market))).sort((a, b) => b.dayVolumeUsd - a.dayVolumeUsd);
      const markets = list.map(marketRow);
      io.emit(table(
        ["MARKET", "MARK", "MAX LEV", "FUNDING/INT", "FUNDING APR", "24H", "24H VOL", "OPEN INT"],
        markets.map((m) => [m.symbol, num(m.markPx, 4), `${m.maxLeverage}x`, `${num(m.fundingRatePct, 4)}%`, `${num(m.fundingAprPct, 2)}%`, `${num(m.change24hPct, 2)}%`, compactUsd(m.dayVolumeUsd), compactUsd(m.openInterestUsd)]),
      ));
      return { venue: "perpl", chainId: 143, asOf: new Date().toISOString(), markets };
    } catch (err) {
      throw toCommandError(err);
    }
  }

  override successHint(d: Result): string {
    return `${d.markets.length} Perpl markets. Next: mm monadefi risk --market ${d.markets[0]?.symbol ?? "ETH"} --side long --leverage 2 --margin 20`;
  }
}
