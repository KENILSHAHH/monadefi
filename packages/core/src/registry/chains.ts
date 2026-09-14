import { config } from "../config";

export type ChainKey =
  | "ethereum"
  | "arbitrum"
  | "base"
  | "polygon"
  | "monad";

export interface ChainInfo {
  key: ChainKey;
  name: string;
  vm: "evm";
  chainId?: number;
  /** Chain id in the Relay API. Source: GET https://api.relay.link/chains (2026-10-11). */
  relayId: number;
  /** Chain name in https://yields.llama.fi/pools. */
  llamaName?: string;
  explorer: string;
  rpc: () => string;
  source: string;
}

export const CHAINS: Record<ChainKey, ChainInfo> = {
  ethereum: {
    key: "ethereum", name: "Ethereum", vm: "evm", chainId: 1, relayId: 1, llamaName: "Ethereum",
    explorer: "https://etherscan.io", rpc: () => config().RPC_ETHEREUM,
    source: "https://chainid.network/",
  },
  arbitrum: {
    key: "arbitrum", name: "Arbitrum One", vm: "evm", chainId: 42161, relayId: 42161, llamaName: "Arbitrum",
    explorer: "https://arbiscan.io", rpc: () => config().RPC_ARBITRUM,
    source: "https://docs.arbitrum.io/build-decentralized-apps/reference/node-providers",
  },
  base: {
    key: "base", name: "Base", vm: "evm", chainId: 8453, relayId: 8453, llamaName: "Base",
    explorer: "https://basescan.org", rpc: () => config().RPC_BASE,
    source: "https://docs.base.org/base-chain/quickstart/connecting-to-base",
  },


  polygon: {
    key: "polygon", name: "Polygon", vm: "evm", chainId: 137, relayId: 137, llamaName: "Polygon",
    explorer: "https://polygonscan.com", rpc: () => config().RPC_POLYGON,
    source: "https://docs.polygon.technology/pos/reference/rpc-endpoints/",
  },
  monad: {
    key: "monad", name: "Monad", vm: "evm", chainId: 143, relayId: 143, llamaName: "Monad",
    explorer: "https://monadscan.com", rpc: () => config().RPC_MONAD,
    source: "https://docs.monad.xyz/developer-essentials/network-information",
  },

};

export const CHAIN_KEYS = Object.keys(CHAINS) as [ChainKey, ...ChainKey[]];

/** Monad is where the product acts. These chains are only sources of funds that move into Monad. */
export const SOURCE_CHAINS = ["ethereum", "arbitrum", "base", "polygon"] as const satisfies readonly ChainKey[];

/**
 * Canonical USDC per chain. Sources:
 * - Circle: https://developers.circle.com/stablecoins/usdc-contract-addresses
 * - Monad: the LI.FI token list (GET https://li.quest/v1/tokens?chains=143, read on 2026-10-13).
 */
export const USDC: Partial<Record<ChainKey, { address: string; decimals: number }>> = {
  ethereum: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  arbitrum: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
  base: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  monad: { address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6 },
};
