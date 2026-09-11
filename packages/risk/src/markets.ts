// Maps each Perpl market to the data that Nansen can give about the same asset.
//
// Two kinds of data:
// - perp: Hyperliquid perps (Nansen "position-intelligence" and "smart-money/perp-trades"). The key is the Hyperliquid
//   symbol. All 11 Perpl markets are listed on Hyperliquid (checked with POST api.hyperliquid.xyz/info {"type":"meta"}
//   on 2026-10-13).
// - spot: one token on one chain (Nansen "tgm/flow-intelligence" and "tgm/holders"). Native coins use the Nansen
//   placeholder addresses from https://docs.nansen.ai/reference/native-tokens. Contract addresses were checked against
//   the CoinGecko coin pages (platforms field) on 2026-10-13.
//
// flowScaleUsd: the 24h net flow (USD) that counts as a "strong" signal for this asset. A flow of this size gives about
// 76% of the full signal (tanh(1)). These scales are product heuristics, not Nansen data. Tune them with real data.

export const EVM_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const SOLANA_NATIVE = "So11111111111111111111111111111111111111112";
export const NEAR_NATIVE = "native-token.near";

export interface SpotToken {
  /** Nansen chain value, for example "ethereum". */
  chain: string;
  /** Token address or Nansen native placeholder. */
  tokenAddress: string;
  /** Plain-English name of what this token is, for labels and the README. */
  description: string;
  native: boolean;
}

export interface MarketProfile {
  /** Perpl market symbol. */
  symbol: string;
  /** Hyperliquid perp symbol, for the Nansen perp endpoints. */
  hlSymbol: string;
  /** Spot token to study. null when Nansen has no chain for this asset. */
  spot: SpotToken | null;
  /** True when the top-holder share is meaningful (a contract token with a real supply, not BTC or ETH). */
  concentration: boolean;
  /** 24h net flow in USD that counts as a strong signal. Heuristic. */
  flowScaleUsd: number;
  /** Notes about coverage. */
  note?: string;
}

const M = 1_000_000;

export const MARKETS: Record<string, MarketProfile> = {
  BTC: {
    symbol: "BTC", hlSymbol: "BTC", concentration: false, flowScaleUsd: 10 * M,
    spot: { chain: "ethereum", tokenAddress: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", description: "WBTC on Ethereum", native: false },
    note: "Nansen Flow Intelligence does not support the bitcoin chain. WBTC flows are a proxy and are much smaller than BTC flows.",
  },
  ETH: {
    symbol: "ETH", hlSymbol: "ETH", concentration: false, flowScaleUsd: 25 * M,
    spot: { chain: "ethereum", tokenAddress: EVM_NATIVE, description: "native ETH on Ethereum", native: true },
    note: "Native-token flows come from an entity dataset. Nansen says they are directional, not exact.",
  },
  SOL: {
    symbol: "SOL", hlSymbol: "SOL", concentration: false, flowScaleUsd: 10 * M,
    spot: { chain: "solana", tokenAddress: SOLANA_NATIVE, description: "native SOL on Solana", native: true },
  },
  MON: {
    symbol: "MON", hlSymbol: "MON", concentration: false, flowScaleUsd: 2 * M,
    spot: { chain: "monad", tokenAddress: EVM_NATIVE, description: "native MON on Monad", native: true },
    note: "WMON is 0x3bd359c1119da7da1d913d1c4d2b7c461115433a on Monad. Native MON is used because most MON is not wrapped.",
  },
  HYPE: {
    symbol: "HYPE", hlSymbol: "HYPE", concentration: false, flowScaleUsd: 5 * M,
    spot: { chain: "hyperevm", tokenAddress: EVM_NATIVE, description: "native HYPE on HyperEVM", native: true },
    note: "HYPE on HyperCore (the Hyperliquid L1 spot book) is not in this flow data. Only HyperEVM flows are studied.",
  },
  ZEC: {
    symbol: "ZEC", hlSymbol: "ZEC", concentration: false, flowScaleUsd: 2 * M, spot: null,
    note: "Nansen has no Zcash chain. Only the Hyperliquid perp signals are used.",
  },
  LIT: {
    symbol: "LIT", hlSymbol: "LIT", concentration: true, flowScaleUsd: 1 * M,
    spot: { chain: "ethereum", tokenAddress: "0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2", description: "LIT (Lighter) on Ethereum", native: false },
  },
  VVV: {
    symbol: "VVV", hlSymbol: "VVV", concentration: true, flowScaleUsd: 0.5 * M,
    spot: { chain: "base", tokenAddress: "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf", description: "VVV (Venice) on Base", native: false },
  },
  PUMP: {
    symbol: "PUMP", hlSymbol: "PUMP", concentration: true, flowScaleUsd: 2 * M,
    spot: { chain: "solana", tokenAddress: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn", description: "PUMP (pump.fun) on Solana", native: false },
  },
  NEAR: {
    symbol: "NEAR", hlSymbol: "NEAR", concentration: false, flowScaleUsd: 2 * M,
    spot: { chain: "near", tokenAddress: NEAR_NATIVE, description: "native NEAR on NEAR", native: true },
  },
  UNI: {
    symbol: "UNI", hlSymbol: "UNI", concentration: true, flowScaleUsd: 2 * M,
    spot: { chain: "ethereum", tokenAddress: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", description: "UNI on Ethereum", native: false },
  },
};

/** Normalizes "eth", "ETH-PERP", "ETH/USD" or "ETHUSD" to "ETH". */
export function normalizeSymbol(market: string): string {
  return market.trim().toUpperCase().replace(/[-/ ]?(PERP|USDC|USDT|USD|AUSD)$/, "").replace(/[-/ ]+$/, "");
}

/**
 * The profile of a market. For a symbol that is not in the table, only the Hyperliquid perp signals are tried,
 * with the same symbol. There is no spot token and no concentration check.
 */
export function marketProfile(market: string): MarketProfile & { known: boolean } {
  const symbol = normalizeSymbol(market);
  const p = MARKETS[symbol];
  if (p) return { ...p, known: true };
  return { symbol, hlSymbol: symbol, spot: null, concentration: false, flowScaleUsd: 2 * M, known: false, note: "This market is not in the Nansen map. Only Hyperliquid perp signals are tried." };
}
