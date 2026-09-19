/** Build-time configuration. Expo inlines EXPO_PUBLIC_* values into the bundle. */
const trimSlash = (s: string) => s.replace(/\/+$/, "");

export const config = {
  apiUrl: trimSlash(process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8787"),
  rpId: process.env.EXPO_PUBLIC_RP_ID ?? "app.3-83-183-92.sslip.io",
  monadRpc: process.env.EXPO_PUBLIC_MONAD_RPC ?? "https://rpc.monad.xyz",
  chainId: 143,
  explorer: "https://monadscan.com",
  rpName: "Mona-DeFi",
  /** The signing key ends when the app stays in the background longer than this. */
  lockAfterMs: 5 * 60_000,
} as const;

/** Monad mainnet contracts used by the app (skills/perpl and skills/monad). */
export const CONTRACTS = {
  perplExchange: "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F",
  ausd: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
  usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
} as const;

export const txUrl = (hash: string) => `${config.explorer}/tx/${hash}`;
export const addressUrl = (address: string) => `${config.explorer}/address/${address}`;
