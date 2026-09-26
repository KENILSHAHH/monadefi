// LI.FI, the routing API behind jumper.xyz. Docs: https://docs.li.fi/api-reference/introduction
// It swaps and routes any token on the supported EVM chains, and reads wallet balances. The agent wallet signs the transactions.
import { createPublicClient, defineChain, encodeFunctionData, erc20Abi, formatUnits, http, parseUnits, type Address, type Hex } from "viem";
import { getJson } from "./http";

const LIFI = "https://li.quest/v1";
const INTEGRATOR = "mona-defi";
const NATIVE = "0x0000000000000000000000000000000000000000";
/** Assets below this value are not shown. A route for them costs more than it moves. */
const MIN_ASSET_USD = 0.25;

interface LifiChain { id: number; name: string; coin: string; logoURI?: string; metamask: { rpcUrls: string[]; blockExplorerUrls: string[]; nativeCurrency: { name: string; symbol: string; decimals: number } } }
interface LifiBalance { address: string; symbol: string; decimals: number; amount: string; chainId: number; verificationStatus?: string }
interface LifiQuote {
  tool: string;
  estimate: { toAmount: string; toAmountMin: string; approvalAddress?: string; executionDuration?: number; gasCosts?: { amount: string; amountUSD?: string }[]; feeCosts?: { amountUSD?: string }[] };
  transactionRequest: { to: Address; data: Hex; value?: string; gasLimit?: string; gasPrice?: string; chainId: number };
}

export interface WalletAsset { chainId: number; chainName: string; symbol: string; token: string; decimals: number; amount: number; usd: number | null; native: boolean; logo: string | null; chainLogo: string | null }

let chainCache: { at: number; chains: Map<number, LifiChain> } | undefined;
async function chains(): Promise<Map<number, LifiChain>> {
  if (!chainCache || Date.now() - chainCache.at > 3_600_000) {
    const res = await getJson<{ chains: LifiChain[] }>(`${LIFI}/chains?chainTypes=EVM`);
    chainCache = { at: Date.now(), chains: new Map(res.chains.map((c) => [c.id, c])) };
  }
  return chainCache.chains;
}

async function viemChain(chainId: number) {
  const c = (await chains()).get(chainId);
  if (!c) throw new Error(`LI.FI does not support chain ${chainId}.`);
  return defineChain({ id: c.id, name: c.name, nativeCurrency: c.metamask.nativeCurrency, rpcUrls: { default: { http: c.metamask.rpcUrls } }, blockExplorers: { default: { name: "Explorer", url: c.metamask.blockExplorerUrls[0]?.replace(/\/$/, "") ?? "" } } });
}

/** Every token of the address that the LI.FI balance API reads, with a USD value. */
export async function walletAssets(address: string, minUsd = MIN_ASSET_USD): Promise<WalletAsset[]> {
  const [res, known] = await Promise.all([getJson<{ balances: Record<string, LifiBalance[]> }>(`${LIFI}/wallets/${address}/balances`), chains()]);
  const held = Object.values(res.balances).flat().filter((b) => BigInt(b.amount) > 0n && b.verificationStatus !== "unverified" && known.has(Number(b.chainId)));
  const assets = await Promise.all(
    held.slice(0, 40).map(async (b): Promise<WalletAsset> => {
      const amount = Number(formatUnits(BigInt(b.amount), Number(b.decimals)));
      const t = await getJson<{ priceUSD?: string; logoURI?: string }>(`${LIFI}/token?chain=${b.chainId}&token=${b.address}`).catch(() => null);
      const price = Number(t?.priceUSD ?? 0) || null;
      const chain = known.get(Number(b.chainId))!;
      return { chainId: chain.id, chainName: chain.name, symbol: b.symbol, token: b.address, decimals: Number(b.decimals), amount, usd: price === null ? null : amount * price, native: b.address === NATIVE, logo: t?.logoURI || null, chainLogo: chain.logoURI ?? null };
    }),
  );
  return assets.filter((a) => a.usd !== null && a.usd >= minUsd).sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0));
}

/** Chains that the LI.FI balance API does not read: Monad (checked on 2026-10-13: a wallet with AUSD on Monad shows no Monad entry). */
export const RPC_READ_CHAINS = [143] as const;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const multicallAbi = [{ type: "function", name: "getEthBalance", stateMutability: "view", inputs: [{ name: "addr", type: "address" }], outputs: [{ type: "uint256" }] }] as const;
let listCache: Map<number, { at: number; tokens: { address: string; symbol: string; decimals: number; priceUSD?: string; logoURI?: string }[] }> = new Map();

/**
 * Every token of the address on `RPC_READ_CHAINS`, read with Multicall3 from the chain RPC.
 * The token list, the prices and the logos come from LI.FI (`GET /v1/tokens`).
 */
export async function rpcAssets(address: string, minUsd = MIN_ASSET_USD): Promise<WalletAsset[]> {
  const known = await chains();
  const perChain = await Promise.all(RPC_READ_CHAINS.map(async (chainId) => {
    const chain = known.get(chainId);
    if (!chain) return [];
    let list = listCache.get(chainId);
    if (!list || Date.now() - list.at > 600_000) {
      const res = await getJson<{ tokens: Record<string, { address: string; symbol: string; decimals: number; priceUSD?: string; logoURI?: string }[]> }>(`${LIFI}/tokens?chains=${chainId}`);
      list = { at: Date.now(), tokens: Object.values(res.tokens).flat() };
      listCache.set(chainId, list);
    }
    const client = createPublicClient({ transport: http(chain.metamask.rpcUrls[0]) });
    const results = await client.multicall({
      multicallAddress: MULTICALL3, allowFailure: true,
      contracts: list.tokens.map((t) => t.address === NATIVE
        ? { address: MULTICALL3, abi: multicallAbi, functionName: "getEthBalance" as const, args: [address as Address] }
        : { address: t.address as Address, abi: erc20Abi, functionName: "balanceOf" as const, args: [address as Address] }),
    });
    return list.tokens.flatMap((t, i): WalletAsset[] => {
      const r = results[i]!;
      if (r.status !== "success" || !(r.result as bigint)) return [];
      const amount = Number(formatUnits(r.result as bigint, t.decimals));
      const price = Number(t.priceUSD ?? 0) || null;
      const logo = t.logoURI && !t.logoURI.endsWith("unknown.svg") ? t.logoURI : null;
      return [{ chainId, chainName: chain.name, symbol: t.symbol, token: t.address, decimals: t.decimals, amount, usd: price === null ? null : amount * price, native: t.address === NATIVE, logo, chainLogo: chain.logoURI ?? null }];
    });
  }));
  return perChain.flat().filter((a) => a.usd !== null && a.usd >= minUsd).sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0));
}

/** `walletAssets` plus the chains that only an RPC read covers. A source that fails is left out; both failing gives null. */
export async function allWalletAssets(address: string, minUsd = MIN_ASSET_USD): Promise<WalletAsset[] | null> {
  const [lifi, rpc] = await Promise.all([walletAssets(address, minUsd).catch(() => null), rpcAssets(address, minUsd).catch(() => null)]);
  if (lifi === null && rpc === null) return null;
  const seen = new Set((rpc ?? []).map((a) => `${a.chainId}:${a.token.toLowerCase()}`));
  return [...(rpc ?? []), ...(lifi ?? []).filter((a) => !seen.has(`${a.chainId}:${a.token.toLowerCase()}`))].sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0));
}

/** The chain where the wallet acts: a token sent there is ready for a position. Other chains deposit through Aurora Intents. */
export const TRADING_DEPOSIT_CHAINS = [143] as const;

/** Tokens a user can deposit on each trading chain, by LI.FI symbol. AUSD on Monad is the Perpl collateral. */
export const TRADING_DEPOSIT_TOKENS: Record<number, readonly string[]> = {
  143: ["USDC", "native", "AUSD", "USDT0", "WETH"],
};

/**
 * A plain transfer of a listed token from an own wallet of the user to `toAddress`. The token is not converted.
 * The browser signs it. LI.FI resolves the symbol to its address and decimals on the chain.
 */
export async function depositTransfer(args: { chainId: number; symbol: string; amount: string; toAddress: string }) {
  const chain = await viemChain(args.chainId);
  const token = await getJson<{ address: string; symbol: string; decimals: number }>(`${LIFI}/token?chain=${args.chainId}&token=${args.symbol === "native" ? NATIVE : args.symbol}`);
  const amount = parseUnits(args.amount, token.decimals);
  if (amount <= 0n) throw new Error("Enter an amount above zero.");
  const transaction =
    token.address === NATIVE
      ? { to: args.toAddress, data: "0x", value: `0x${amount.toString(16)}` }
      : { to: token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [args.toAddress as Address, amount] }), value: "0x0" };
  return { chainId: args.chainId, chainName: chain.name, symbol: token.symbol, approval: null, transaction, etaSeconds: null };
}

/** A token by symbol or address on a chain, from LI.FI. */
export async function resolveToken(chainId: number, token: string) {
  const t = await getJson<{ address: string; symbol: string; decimals: number; priceUSD?: string }>(`${LIFI}/token?chain=${chainId}&token=${token === "native" ? NATIVE : token}`);
  return { address: t.address as Address, symbol: t.symbol, decimals: t.decimals, priceUsd: Number(t.priceUSD ?? 0) || null };
}

/**
 * A swap on one chain or a route across chains for any token LI.FI knows (jumper.xyz routes), from `from` to `to`.
 * Returns the calls to send on the source chain: the approval when one is needed, then the route.
 */
/** `exchanges` limits the route to these LI.FI exchange keys (for example on a local fork, where a signed RFQ quote fails). */
export async function routeTransactions(args: { fromChainId: number; toChainId: number; fromToken: string; toToken: string; amount: string; from: string; to: string; slippage?: number; exchanges?: string[] }) {
  const [inTok, outTok] = await Promise.all([resolveToken(args.fromChainId, args.fromToken), resolveToken(args.toChainId, args.toToken)]);
  const amount = parseUnits(args.amount, inTok.decimals);
  if (amount <= 0n) throw new Error("The amount must be above zero.");
  const q = await getJson<LifiQuote>(`${LIFI}/quote?${new URLSearchParams({ fromChain: String(args.fromChainId), toChain: String(args.toChainId), fromToken: inTok.address, toToken: outTok.address, fromAmount: amount.toString(), fromAddress: args.from, toAddress: args.to, integrator: INTEGRATOR, slippage: String(args.slippage ?? 0.005), ...(args.exchanges ? { allowExchanges: args.exchanges.join(",") } : {}) })}`);
  const calls: { to: Address; data: Hex; value: string; description: string }[] = [];
  if (inTok.address !== NATIVE && q.estimate.approvalAddress) {
    const chain = await viemChain(args.fromChainId);
    const allowance = await createPublicClient({ chain, transport: http() }).readContract({ address: inTok.address, abi: erc20Abi, functionName: "allowance", args: [args.from as Address, q.estimate.approvalAddress as Address] });
    if (allowance < amount) calls.push({ to: inTok.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [q.estimate.approvalAddress as Address, amount] }), value: "0", description: `Approve ${inTok.symbol}` });
  }
  const outAmount = Number(formatUnits(BigInt(q.estimate.toAmount), outTok.decimals));
  calls.push({ to: q.transactionRequest.to, data: q.transactionRequest.data, value: BigInt(q.transactionRequest.value ?? 0).toString(), description: `${args.fromChainId === args.toChainId ? "Swap" : "Route"} ${args.amount} ${inTok.symbol} to about ${outAmount.toPrecision(6)} ${outTok.symbol} via ${q.tool}` });
  return { calls, tool: q.tool, inToken: inTok, outToken: outTok, outAmount, minOut: Number(formatUnits(BigInt(q.estimate.toAmountMin), outTok.decimals)), usdIn: inTok.priceUsd ? Number(args.amount) * inTok.priceUsd : null, etaSeconds: q.estimate.executionDuration ?? null };
}
