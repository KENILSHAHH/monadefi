/**
 * "Deposit from MetaMask": the pure part. No window, no React. The tests cover this file.
 *
 * Security rules (see the deposit screen):
 * - MetaMask signs only plain transfer transactions: an ERC-20 `transfer(to, amount)` or a native value transfer.
 *   No approvals, no typed data, no permits, no personal_sign.
 * - The destination is the user's Mona-DeFi wallet (Monad path) or the Aurora deposit address from our API.
 */
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import type { AuroraChain, AuroraToken } from "../api/types";

// ── EIP-1193 ─────────────────────────────────────────────────────────────────

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  isMetaMask?: boolean;
}

// ── Monad ────────────────────────────────────────────────────────────────────

export const MONAD_CHAIN_ID = 143;
export const MONAD_EXPLORER = "https://monadscan.com";
export const MONAD_ADD_CHAIN = {
  chainId: "0x8f",
  chainName: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: ["https://rpc.monad.xyz"],
  blockExplorerUrls: [MONAD_EXPLORER],
} as const;

export interface MonadToken {
  symbol: "AUSD" | "USDC" | "USDT0" | "MON";
  /** null: the native coin (MON). */
  address: Address | null;
  decimals: number;
}

export const MONAD_TOKENS: readonly MonadToken[] = [
  { symbol: "AUSD", address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", decimals: 6 },
  { symbol: "USDC", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6 },
  { symbol: "USDT0", address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", decimals: 6 },
  { symbol: "MON", address: null, decimals: 18 },
];

/** MON that "Max" keeps for gas. */
export const MON_GAS_RESERVE = parseUnits("0.01", 18);

export const monadTxUrl = (hash: string) => `${MONAD_EXPLORER}/tx/${hash}`;
export const toHexChainId = (id: number) => `0x${id.toString(16)}`;

// ── Amounts ──────────────────────────────────────────────────────────────────

export type AmountResult = { ok: true; value: bigint } | { ok: false; error: string };

/**
 * Parse a typed amount into base units. Accepts "12", "12.5", ".5", "12." and "12,5" (one comma as the decimal mark).
 * Rejects thousands separators, signs, exponents, zero and more decimals than the token has.
 */
export function parseTokenAmount(input: string, decimals: number): AmountResult {
  let t = input.trim();
  if (!t) return { ok: false, error: "Enter an amount." };
  if (!t.includes(".") && (t.match(/,/g) ?? []).length === 1) t = t.replace(",", ".");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return { ok: false, error: "Enter a number, for example 25 or 25.5." };
  const frac = t.split(".")[1] ?? "";
  if (frac.length > decimals) return { ok: false, error: `Use ${decimals} decimals or fewer.` };
  const value = parseUnits(t.endsWith(".") ? t.slice(0, -1) || "0" : t.startsWith(".") ? `0${t}` : t, decimals);
  if (value <= 0n) return { ok: false, error: "Enter an amount above zero." };
  return { ok: true, value };
}

/** The "Max" amount. For the native coin keep `reserve` for gas. Never below zero. */
export function maxSendable(balance: bigint, native: boolean, reserve: bigint = MON_GAS_RESERVE): bigint {
  const v = native ? balance - reserve : balance;
  return v > 0n ? v : 0n;
}

/** Base units to the text for the amount field, with no trailing zeros. */
export const amountText = (value: bigint, decimals: number) => formatUnits(value, decimals);

// ── Transactions ─────────────────────────────────────────────────────────────

export interface TransferTx {
  from: Address;
  to: Address;
  value: Hex;
  data?: Hex;
}

/**
 * The only transaction that MetaMask signs in this flow.
 * - ERC-20: `to` is the token contract, `data` is transfer(recipient, amount), `value` is 0.
 * - Native: `to` is the recipient, `value` is the amount, no data.
 */
export function buildTransferTx(a: { from: string; recipient: string; amount: bigint; token: Address | null }): TransferTx {
  if (!isAddress(a.from)) throw new Error("The MetaMask account is not a valid address.");
  if (!isAddress(a.recipient)) throw new Error("The destination is not a valid address.");
  if (a.amount <= 0n) throw new Error("Enter an amount above zero.");
  const from = getAddress(a.from);
  const recipient = getAddress(a.recipient);
  if (a.token === null) return { from, to: recipient, value: "0x" + a.amount.toString(16) as Hex };
  if (!isAddress(a.token)) throw new Error("The token contract is not a valid address.");
  return {
    from,
    to: getAddress(a.token),
    value: "0x0",
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, a.amount] }),
  };
}

// ── /fund address ────────────────────────────────────────────────────────────

export type FundTarget = { ok: true; address: Address } | { ok: false; error: string };

/** Check the `to` query of /fund. Only one well-formed 0x address (EIP-55 checksum if mixed case). */
export function parseFundTarget(raw: string | string[] | undefined | null): FundTarget {
  const v = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  if (!v) return { ok: false, error: "This link has no destination address. Open the link from the Mona-DeFi app again." };
  const t = v.trim();
  if (!isAddress(t)) return { ok: false, error: "The address in this link is not valid. Do not send funds. Open the link from the Mona-DeFi app again." };
  if (/^0x0{40}$/i.test(t)) return { ok: false, error: "The address in this link is the zero address. Do not send funds." };
  return { ok: true, address: getAddress(t) };
}

// ── Links ────────────────────────────────────────────────────────────────────

/** The MetaMask app link that opens /fund?to=<address> in the MetaMask browser. The host comes from `origin`. */
export function metamaskDeepLink(origin: string, to: string): string {
  const host = origin.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
  return `https://metamask.app.link/dapp/${host}/fund?to=${encodeURIComponent(to)}`;
}

export const METAMASK_DOWNLOAD = "https://metamask.io/download";

/** A phone or tablet browser (iOS Safari, Android Chrome, iPadOS that reports a Mac). */
export function isPhoneUserAgent(ua: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return true;
  return /Macintosh/.test(ua) && maxTouchPoints > 1;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** The EIP-1193 error code, also when a wallet nests it (MetaMask mobile puts it in data.originalError). */
export function providerErrorCode(e: unknown): number | null {
  // -32603 (internal error) is a wrapper. A more exact code inside it wins.
  const codes: number[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur && typeof cur === "object"; depth++) {
    const o = cur as { code?: unknown; data?: { originalError?: unknown; code?: unknown }; cause?: unknown };
    if (typeof o.code === "number") codes.push(o.code);
    if (typeof o.data?.code === "number") codes.push(o.data.code);
    cur = o.data?.originalError ?? o.cause;
  }
  return codes.find((c) => c !== -32603) ?? codes[0] ?? null;
}

/** A plain sentence for an error from MetaMask. */
export function metamaskErrorMessage(e: unknown): string {
  switch (providerErrorCode(e)) {
    case 4001:
      return "You cancelled in MetaMask.";
    case 4100:
      return "MetaMask did not allow this request. Unlock MetaMask, connect this site and try again.";
    case 4200:
      return "MetaMask does not support this request.";
    case 4900:
    case 4901:
      return "MetaMask is not connected to the network. Check MetaMask and try again.";
    case 4902:
      return "This network is not in MetaMask. Add it in MetaMask and try again.";
    case -32002:
      return "A MetaMask request is already open. Open MetaMask to finish it.";
  }
  const msg = e instanceof Error ? e.message : typeof (e as { message?: unknown })?.message === "string" ? (e as { message: string }).message : "";
  if (/insufficient funds/i.test(msg)) return "The MetaMask account does not have enough funds for this amount and the gas.";
  if (/user (rejected|denied)/i.test(msg)) return "You cancelled in MetaMask.";
  return msg ? msg.split("\n")[0]! : "MetaMask returned an error. Try again.";
}

// ── Provider steps ───────────────────────────────────────────────────────────

export class FlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowError";
  }
}

/** eth_requestAccounts. Returns the first account. */
export async function connectAccount(p: Eip1193Provider): Promise<Address> {
  const accounts = (await p.request({ method: "eth_requestAccounts" })) as unknown;
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== "string" || !isAddress(first)) throw new FlowError("MetaMask returned no account.");
  return getAddress(first);
}

export async function currentChainId(p: Eip1193Provider): Promise<number> {
  const id = await p.request({ method: "eth_chainId" });
  return typeof id === "string" ? Number.parseInt(id, 16) : Number(id);
}

export interface AddChainParams {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: readonly string[];
  blockExplorerUrls?: readonly string[];
}

/**
 * wallet_switchEthereumChain. On 4902 (unknown chain) add it with `add`, if given; else ask the user to add it.
 * Then check eth_chainId: the transfer only goes out on the right chain.
 */
export async function switchChain(p: Eip1193Provider, chainId: number, add: AddChainParams | null, name: string): Promise<void> {
  const hex = toHexChainId(chainId);
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (providerErrorCode(e) !== 4902) throw e;
    if (!add) throw new FlowError(`${name} is not in MetaMask. Add the ${name} network in MetaMask, then try again.`);
    await p.request({ method: "wallet_addEthereumChain", params: [{ ...add, chainId: hex }] });
  }
  const now = await currentChainId(p);
  if (now !== chainId) throw new FlowError(`MetaMask is not on ${name}. Switch to ${name} in MetaMask and try again.`);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type ReceiptResult = { status: "success" | "reverted"; blockNumber: number | null } | { status: "timeout" };

/** Poll eth_getTransactionReceipt every `intervalMs` up to `timeoutMs`. Read errors are retried. */
export async function waitForReceipt(
  p: Eip1193Provider,
  hash: string,
  o: { intervalMs?: number; timeoutMs?: number; wait?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<ReceiptResult> {
  const interval = o.intervalMs ?? 2_000;
  const timeout = o.timeoutMs ?? 120_000;
  const wait = o.wait ?? sleep;
  const now = o.now ?? Date.now;
  const end = now() + timeout;
  for (;;) {
    try {
      const r = (await p.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status?: string; blockNumber?: string } | null;
      if (r && r.status) {
        return { status: r.status === "0x1" ? "success" : "reverted", blockNumber: r.blockNumber ? Number.parseInt(r.blockNumber, 16) : null };
      }
    } catch {
      // A read error (rate limit, network): try again on the next tick.
    }
    if (now() + interval > end) return { status: "timeout" };
    await wait(interval);
  }
}

/** eth_sendTransaction with the plain transfer. Returns the hash. */
export async function sendTransfer(p: Eip1193Provider, tx: TransferTx): Promise<Hex> {
  const hash = await p.request({ method: "eth_sendTransaction", params: [tx] });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new FlowError("MetaMask returned no transaction hash.");
  return hash as Hex;
}

// ── Other chains (Aurora) ────────────────────────────────────────────────────

/** EVM source chains: chain id and native coin, by Aurora chain code (packages/core/src/adapters/aurora.ts CHAINS). */
export const EVM_CHAINS: Record<string, { chainId: number; native: string; explorer?: string }> = {
  eth: { chainId: 1, native: "ETH", explorer: "https://etherscan.io" },
  base: { chainId: 8453, native: "ETH", explorer: "https://basescan.org" },
  arb: { chainId: 42161, native: "ETH", explorer: "https://arbiscan.io" },
  op: { chainId: 10, native: "ETH", explorer: "https://optimistic.etherscan.io" },
  pol: { chainId: 137, native: "POL", explorer: "https://polygonscan.com" },
  bsc: { chainId: 56, native: "BNB", explorer: "https://bscscan.com" },
  avax: { chainId: 43114, native: "AVAX", explorer: "https://snowtrace.io" },
  gnosis: { chainId: 100, native: "XDAI", explorer: "https://gnosisscan.io" },
  bera: { chainId: 80094, native: "BERA", explorer: "https://berascan.com" },
  scroll: { chainId: 534352, native: "ETH", explorer: "https://scrollscan.com" },
  xlayer: { chainId: 196, native: "OKB" },
  plasma: { chainId: 9745, native: "XPL" },
  abs: { chainId: 2741, native: "ETH" },
};

export interface SourceChain {
  key: string;
  name: string;
  chainId: number;
  connect: boolean;
  /** Only when the API sends an RPC for the chain. Else the user adds the network in MetaMask. */
  add: AddChainParams | null;
  tokens: SourceToken[];
}

export interface SourceToken {
  assetId: string;
  symbol: string;
  decimals: number;
  /** null: the native coin of the chain. */
  contract: Address | null;
}

/**
 * The token as MetaMask sends it: an ERC-20 with a valid contract, or the native coin (no contract and the
 * symbol of the chain's coin). Anything else is left out: the app does not guess a contract.
 */
export function toSourceToken(t: AuroraToken, native: string | null): SourceToken | null {
  const c = t.contractAddress ?? null;
  if (c && isAddress(c)) return { assetId: t.assetId, symbol: t.symbol, decimals: t.decimals, contract: getAddress(c) };
  if (!c && native && t.symbol.toUpperCase() === native.toUpperCase()) return { assetId: t.assetId, symbol: t.symbol, decimals: t.decimals, contract: null };
  return null;
}

/** EVM chains from GET /deposit/aurora/assets that MetaMask can send from, with the tokens it can send. */
export function sourceChains(chains: AuroraChain[]): SourceChain[] {
  const out: SourceChain[] = [];
  for (const c of chains) {
    if (!c.evm || c.chain === "monad") continue;
    const known = EVM_CHAINS[c.chain];
    const chainId = c.chainId ?? known?.chainId;
    if (!chainId) continue;
    const native = c.nativeCurrency?.symbol ?? known?.native ?? null;
    const tokens = c.tokens.map((t) => toSourceToken(t, native)).filter((t): t is SourceToken => t !== null);
    if (!tokens.length) continue;
    const add: AddChainParams | null = c.rpcUrls?.length && c.nativeCurrency
      ? { chainId: toHexChainId(chainId), chainName: c.name, nativeCurrency: c.nativeCurrency, rpcUrls: c.rpcUrls, ...(c.blockExplorerUrls?.length ? { blockExplorerUrls: c.blockExplorerUrls } : {}) }
      : null;
    out.push({ key: c.chain, name: c.name, chainId, connect: c.connect, add, tokens });
  }
  return out;
}

/**
 * The amount to send to the Aurora deposit address. Aurora stores `amountIn` in base units.
 * Never send more than the user typed. If Aurora asks for less, send what Aurora asks for.
 */
export function auroraSendAmount(typed: bigint, amountIn: string | null): bigint {
  if (amountIn && /^\d+$/.test(amountIn)) {
    const v = BigInt(amountIn);
    if (v > typed) throw new FlowError("Aurora asks for more than you entered. Nothing was sent. Start a new deposit.");
    if (v > 0n) return v;
  }
  return typed;
}

/** Check the Aurora deposit before MetaMask sends to it. */
export function checkAuroraDestination(d: { depositAddress: string | null; depositMemo: string | null }): Address {
  if (!d.depositAddress || !isAddress(d.depositAddress)) throw new FlowError("Aurora gave no valid deposit address. Nothing was sent.");
  if (d.depositMemo) throw new FlowError("This deposit needs a memo. MetaMask cannot add it. Use the Any chain tab and send by hand.");
  return getAddress(d.depositAddress);
}
