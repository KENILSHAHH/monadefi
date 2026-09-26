// Aurora Intents (built on NEAR Intents / 1Click). Docs: https://docs.intents.aurora.dev (llms.txt lists every page).
// Three products are used here:
// - Swap API (https://intents-api.aurora.dev/api/...): a quote gives a one-time deposit address; 1Click swaps and delivers.
// - Persistent deposit addresses (same host): one reusable address per user and chain. Creation is limited to
//   organisations Aurora approved; other keys get 403.
// - Intents Connect (https://intents-connect-api.aurora.dev/api/v1): the user signs one message, deposits, and an
//   intermediary account on Monad runs our calls (deposit-and-execute). We use it for USDC -> AUSD on Curve, paid to the user.
// The API key goes in the URL path (Swap API) or the x-api-key header (Intents Connect). Aurora says it is not confidential,
// but this module never puts it in an error message or a log.
import { createPublicClient, http, isAddress, parseAbi, type Address } from "viem";
import { HttpError } from "./http";

export const AURORA_API = "https://intents-api.aurora.dev/api";
/** The public 1Click API. It accepts dry quotes without a key. Use it only to check request shapes. */
export const ONECLICK_PUBLIC_API = "https://1click.chaindefuser.com/v0";
export const CONNECT_API = "https://intents-connect-api.aurora.dev/api/v1";

/** Monad facts. Asset ids from GET /api/tokens (checked 2026-10-13). Curve pool checked on chain the same day. */
export const MONAD = {
  chain: "monad",
  chainId: 143,
  MON_ASSET: "nep245:v2_1.omni.hot.tg:143_11111111111111111111",
  USDC_ASSET: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
  USDT0_ASSET: "nep245:v2_1.omni.hot.tg:143_4EJiJxSALvGoTZbnc8K7Ft9533et",
  USDC: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address,
  AUSD: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as Address,
  /** Curve stableswap-ng pool. coins(0) = AUSD, coins(1) = USDC, coins(2) = USDT0. Fee 0.005 %. */
  CURVE_POOL: "0x942644106b073e30d72c2c5d7529d5c296ea91ab" as Address,
  CURVE_USDC_INDEX: 1,
  CURVE_AUSD_INDEX: 0,
} as const;

/** 1Click chain codes, with a display name. `evm` chains share one address format with Monad. */
export const CHAINS: Record<string, { name: string; evm: boolean; chainId?: number }> = {
  eth: { name: "Ethereum", evm: true, chainId: 1 },
  base: { name: "Base", evm: true, chainId: 8453 },
  arb: { name: "Arbitrum", evm: true, chainId: 42161 },
  op: { name: "Optimism", evm: true, chainId: 10 },
  pol: { name: "Polygon", evm: true, chainId: 137 },
  bsc: { name: "BNB Chain", evm: true, chainId: 56 },
  avax: { name: "Avalanche", evm: true, chainId: 43114 },
  gnosis: { name: "Gnosis", evm: true, chainId: 100 },
  bera: { name: "Berachain", evm: true, chainId: 80094 },
  scroll: { name: "Scroll", evm: true, chainId: 534352 },
  xlayer: { name: "X Layer", evm: true, chainId: 196 },
  plasma: { name: "Plasma", evm: true, chainId: 9745 },
  abs: { name: "Abstract", evm: true, chainId: 2741 },
  hood: { name: "Robinhood Chain", evm: true },
  adi: { name: "ADI", evm: true },
  monad: { name: "Monad", evm: true, chainId: 143 },
  sol: { name: "Solana", evm: false },
  btc: { name: "Bitcoin", evm: false },
  near: { name: "NEAR", evm: false },
  tron: { name: "Tron", evm: false },
  ton: { name: "TON", evm: false },
  sui: { name: "Sui", evm: false },
  aptos: { name: "Aptos", evm: false },
  stellar: { name: "Stellar", evm: false },
  xrp: { name: "XRP Ledger", evm: false },
  doge: { name: "Dogecoin", evm: false },
  ltc: { name: "Litecoin", evm: false },
  bch: { name: "Bitcoin Cash", evm: false },
  zec: { name: "Zcash", evm: false },
  dash: { name: "Dash", evm: false },
  cardano: { name: "Cardano", evm: false },
  starknet: { name: "Starknet", evm: false },
  aleo: { name: "Aleo", evm: false },
  hypercore: { name: "Hyperliquid", evm: false },
  movement: { name: "Movement", evm: false },
  fogo: { name: "Fogo", evm: false },
  qtc: { name: "QTC", evm: false },
};

/**
 * EVM source chains of Intents Connect (https://docs.intents.aurora.dev/intents-connect/supported-chains.md).
 * On these chains the deposit can come from the same EOA that signs, so the user signs with the Monad wallet.
 */
export const CONNECT_EVM_SOURCES = ["eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "bera", "scroll", "xlayer", "plasma", "adi", "hood"] as const;

const CHAIN_ORDER = ["eth", "base", "arb", "sol", "btc", "bsc", "pol", "near", "op", "avax", "tron", "ton"];

// ---------- types ----------

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type SwapStatus = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";
export type ConnectStatus = "CREATED" | "DEPOSIT_PENDING" | "DEPOSIT_PROCESSING" | "OPERATION_PENDING" | "OPERATION_PROCESSING" | "SUCCESS" | "DEPOSIT_FAILED" | "OPERATION_FAILED" | "EXPIRED";
export const SWAP_STATUSES: readonly SwapStatus[] = ["KNOWN_DEPOSIT_TX", "PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"];

export interface AuroraToken { assetId: string; symbol: string; decimals: number; blockchain: string; price: number | null; contractAddress: string | null; volumeUsd?: number }
export interface ChainGroup { chain: string; name: string; evm: boolean; connect: boolean; tokens: AuroraToken[] }

export interface QuoteRequest {
  dry: boolean;
  swapType: SwapType;
  depositType: "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
  depositMode?: "SIMPLE" | "MEMO";
  amount: string;
  originAsset: string;
  destinationAsset: string;
  slippageTolerance: number;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
  deadline?: string;
  quoteWaitingTimeMs?: number;
  sessionId?: string;
  confidentiality?: "public" | "basic" | "advanced";
  connectedWallets?: string[];
}

export interface Quote {
  timeEstimate: number;
  deadline?: string;
  timeWhenInactive?: string;
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  maxAmountIn?: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  refundFee?: string;
  withdrawFee?: string;
}
export interface QuoteResponse { timestamp: string; signature: string; correlationId?: string; quoteRequest: QuoteRequest & { appFees?: { recipient: string; fee: number }[] }; quote: Quote }

export interface TxRef { hash: string; explorerUrl: string }
export interface SwapDetails {
  intentHashes: string[];
  nearTxHashes: string[];
  amountIn?: string; amountInFormatted?: string; amountInUsd?: string;
  amountOut?: string; amountOutFormatted?: string; amountOutUsd?: string;
  slippage?: number;
  originChainTxHashes: TxRef[];
  destinationChainTxHashes: TxRef[];
  refundedAmount?: string; refundedAmountFormatted?: string; refundedAmountUsd?: string; refundReason?: string;
  depositedAmount?: string; depositedAmountFormatted?: string; depositedAmountUsd?: string;
}
export interface StatusResponse { status: SwapStatus; correlationId?: string; updatedAt?: string; quoteResponse?: QuoteResponse; swapDetails?: SwapDetails }

export interface TransactionItem {
  originAsset: string; destinationAsset: string; depositAddress: string; depositMemo: string; recipient: string; status: SwapStatus;
  createdAt: string; amountIn: string; amountOut: string; amountInFormatted: string; amountOutFormatted: string; refundTo: string; refundReason: string;
  originChainTxHashes: string[]; destinationChainTxHashes: string[]; appFees: { fee: number; recipient: string }[];
}

export interface PersistentAddressRequest { recipient: string; sender: string; depositChain: string; destinationChain: string; destinationAsset: string; confidential?: boolean }
export interface PersistentAddressResponse { depositAddress: string; alreadyExists: boolean; memo?: string; correlationId?: string }
export interface PersistentDeposit { tx_hash: string; fromChain?: string | null; destinationChain?: string | null; asset_id: string | null; decimals: number | null; amount: string; from?: string; created_at: string; intents_account: string; deposit_address: string; recipient: string }

export interface ConnectStep { to: string; functionSignature: string; parameters: unknown[]; value: string; metadata?: Record<string, unknown> }
export interface ConnectExecution {
  id?: string;
  createdAt?: string;
  status: ConnectStatus;
  executionMode?: "quote_with_steps" | "steps_only";
  type?: "evm" | "solana";
  version?: string;
  metadata?: Record<string, unknown>;
  steps?: ConnectStep[];
  details?: {
    intermediaryAddress?: string; estimatedTime?: string; networkFee?: string; messageSigned?: boolean; messageToSign?: string;
    signingStandard?: string; payload?: { standard: string; payload_json: string; payload_bytes_base64: string };
  } & Record<string, unknown>;
  quote?: {
    amount?: string; amountIn?: string; amountInUsd?: string; amountOut?: string; amountOutUsd?: string; minAmountIn?: string | null; minAmountOut?: string;
    deadline?: string; depositAddress?: string; depositMemo?: string | null; originAsset?: string; destinationAsset?: string; recipient?: string; swapType?: string | null;
  } & Record<string, unknown>;
}

export interface AuroraOptions {
  /** Default: process.env.AURORA_API_KEY. */
  apiKey?: string;
  /** Default: global fetch. Tests pass a stub. */
  fetch?: typeof fetch;
  /** Default: setTimeout. Tests pass a fast one. */
  sleep?: (ms: number) => Promise<void>;
  /** Attempts for one request when Aurora answers 429. Default 3. */
  maxAttempts?: number;
  /** A Retry-After above this is not waited for: the call throws AuroraRateLimitError at once. Default 15 s. */
  maxWaitMs?: number;
  timeoutMs?: number;
  /** Dry quotes and the token list without a key go to the public 1Click API. Default true. */
  publicFallback?: boolean;
  /** Reads Curve get_dy on Monad. Tests pass a stub. */
  getDy?: (dx: bigint) => Promise<bigint>;
}

/** Aurora answered 429 and the wait is longer than `maxWaitMs`, or the attempts ran out. */
export class AuroraRateLimitError extends HttpError {
  constructor(url: string, body: string, public retryAfterMs: number) {
    super(url, 429, body);
  }
}

// ---------- HTTP ----------

const envKey = () => (process.env.AURORA_API_KEY ? process.env.AURORA_API_KEY : undefined);
const keyOf = (o: AuroraOptions) => o.apiKey ?? envKey();
const redact = (url: string, key?: string) => (key ? url.split(encodeURIComponent(key)).join("***").split(key).join("***") : url);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Seconds in Retry-After, or an HTTP date. Missing or bad gives 1 s. */
export function retryAfterMs(header: string | null): number {
  if (!header) return 1000;
  const s = Number(header);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 1000;
}

async function call<T>(url: string, init: RequestInit, o: AuroraOptions, key?: string): Promise<T> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  const attempts = o.maxAttempts ?? 3;
  const maxWait = o.maxWaitMs ?? 15_000;
  const shown = redact(url, key);
  for (let attempt = 1; ; attempt++) {
    const res = await f(url, { ...init, signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
    const text = await res.text();
    if (res.status === 429) {
      // Rejected requests still count toward the hourly limit, so honour Retry-After and add jitter.
      const wait = retryAfterMs(res.headers.get("retry-after"));
      if (attempt >= attempts || wait > maxWait) throw new AuroraRateLimitError(shown, redact(text, key), wait);
      await sleep(wait * 2 ** (attempt - 1) + Math.floor(Math.random() * 500));
      continue;
    }
    if (!res.ok) throw new HttpError(shown, res.status, redact(text, key));
    return (text ? JSON.parse(text) : null) as T;
  }
}

const json = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

function requireKey(o: AuroraOptions, what: string): string {
  const key = keyOf(o);
  if (!key) throw new Error(`${what} needs AURORA_API_KEY (create one at https://studio.aurora.dev).`);
  return key;
}
const auroraUrl = (path: string, key: string, query?: Record<string, string | number | undefined>) => {
  const q = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString() : "";
  return `${AURORA_API}/${path}/${encodeURIComponent(key)}${q ? `?${q}` : ""}`;
};

// ---------- Swap API ----------

interface RawToken { assetId: string; decimals: number; blockchain: string; symbol: string; price?: number; contractAddress?: string | null }
const tokenCache = new Map<string, { at: number; tokens: AuroraToken[] }>();
const TOKEN_TTL_MS = 5 * 60_000;

/** Every asset Aurora lists for the key (cached 5 minutes, as the rate-limit page advises). Without a key: the public 1Click list. */
export async function listTokens(o: AuroraOptions = {}): Promise<AuroraToken[]> {
  const key = keyOf(o);
  if (!key && o.publicFallback === false) requireKey(o, "The token list");
  const cacheKey = key ? `k:${key}` : "public";
  const hit = tokenCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.tokens;
  let raw: RawToken[];
  let volume = new Map<string, number>();
  if (key) {
    const res = await call<{ tokens: RawToken[]; asset_stats?: { token_id: string; volume_amount_usd: string }[] }>(auroraUrl("tokens", key), {}, o, key);
    raw = res.tokens;
    volume = new Map((res.asset_stats ?? []).map((s) => [s.token_id, Number(s.volume_amount_usd) || 0]));
  } else {
    raw = await call<RawToken[]>(`${ONECLICK_PUBLIC_API}/tokens`, {}, o);
  }
  const tokens = raw.map((t): AuroraToken => ({
    assetId: t.assetId, symbol: t.symbol, decimals: t.decimals, blockchain: t.blockchain, price: typeof t.price === "number" ? t.price : null,
    contractAddress: t.contractAddress || null, ...(volume.has(t.assetId) ? { volumeUsd: volume.get(t.assetId) } : {}),
  }));
  tokenCache.set(cacheKey, { at: Date.now(), tokens });
  return tokens;
}

/** Clears the token cache (tests). */
export function clearTokenCache() {
  tokenCache.clear();
}

const SYMBOL_ORDER = ["ETH", "SOL", "BTC", "BNB", "POL", "AVAX", "NEAR", "USDC", "USDT", "USDT0", "DAI"];
const rank = (list: string[], v: string) => { const i = list.indexOf(v); return i < 0 ? list.length : i; };

/** Origin assets grouped by chain for the deposit screen. Monad is left out: it is the destination. */
export function groupByChain(tokens: AuroraToken[]): ChainGroup[] {
  const groups = new Map<string, AuroraToken[]>();
  for (const t of tokens) {
    if (t.blockchain === MONAD.chain) continue;
    groups.set(t.blockchain, [...(groups.get(t.blockchain) ?? []), t]);
  }
  return [...groups.entries()]
    .map(([chain, list]): ChainGroup => ({
      chain,
      name: CHAINS[chain]?.name ?? chain,
      evm: CHAINS[chain]?.evm ?? false,
      connect: (CONNECT_EVM_SOURCES as readonly string[]).includes(chain),
      tokens: [...list].sort((a, b) => rank(SYMBOL_ORDER, a.symbol) - rank(SYMBOL_ORDER, b.symbol) || (b.volumeUsd ?? 0) - (a.volumeUsd ?? 0) || a.symbol.localeCompare(b.symbol)),
    }))
    .sort((a, b) => rank(CHAIN_ORDER, a.chain) - rank(CHAIN_ORDER, b.chain) || a.name.localeCompare(b.name));
}

export async function originAssetsByChain(o: AuroraOptions = {}): Promise<ChainGroup[]> {
  return groupByChain(await listTokens(o));
}

/**
 * POST /api/quote/{apiKey}. `dry: true` gives a price without a deposit address.
 * A dry quote without a key goes to the public 1Click API (shape checks only). A real quote needs the key.
 */
export async function quote(req: QuoteRequest, o: AuroraOptions = {}): Promise<QuoteResponse> {
  const key = keyOf(o);
  if (!key) {
    if (!req.dry || o.publicFallback === false) requireKey(o, "A quote with a deposit address");
    return call<QuoteResponse>(`${ONECLICK_PUBLIC_API}/quote`, json(req), o);
  }
  return call<QuoteResponse>(auroraUrl("quote", key), json(req), o, key);
}

/** POST /api/deposit/submit/{apiKey}. Optional: it tells 1Click about the deposit transaction so it checks it sooner. */
export async function submitDeposit(body: { txHash: string; depositAddress: string; memo?: string; nearSenderAccount?: string }, o: AuroraOptions = {}): Promise<StatusResponse> {
  const key = requireKey(o, "Submitting a deposit");
  return call<StatusResponse>(auroraUrl("deposit/submit", key), json(body), o, key);
}

/** GET /api/status/{apiKey}?depositAddress=. Poll every 5 to 10 s at most (Aurora rate-limit guidance). */
export async function status(depositAddress: string, memo?: string | null, o: AuroraOptions = {}): Promise<StatusResponse> {
  const key = requireKey(o, "A status check");
  return call<StatusResponse>(auroraUrl("status", key, { depositAddress, depositMemo: memo ?? undefined }), {}, o, key);
}

/** GET /api/transactions/{apiKey}. Without page/perPage the answer is a plain array. */
export async function transactions(q: { walletAddress?: string; numberOfTransactions?: number; lastDepositAddress?: string; lastDepositMemo?: string; direction?: "next" | "prev" } = {}, o: AuroraOptions = {}): Promise<TransactionItem[]> {
  const key = requireKey(o, "The transaction history");
  const res = await call<TransactionItem[] | { data: TransactionItem[] }>(auroraUrl("transactions", key, q), {}, o, key);
  return Array.isArray(res) ? res : res.data;
}

/** GET /api/incidents/{apiKey}: ongoing incidents by chain or asset. */
export async function incidents(o: AuroraOptions = {}): Promise<{ status: "operational" } | { status: "incidents"; incidents: { scopeType: string; scopeValue: string; direction?: string; publicDescription?: string }[] }> {
  const key = requireKey(o, "The incident list");
  return call(auroraUrl("incidents", key), {}, o, key);
}

// ---------- Persistent deposit addresses (Intents Deposits) ----------

/**
 * POST /api/persistent-deposit-address/{apiKey}. The same inputs always give the same address. It never expires.
 * All EVM chains share one address: pass depositChain "evm". Keys that Aurora did not approve get 403.
 */
export async function createPersistentAddress(req: PersistentAddressRequest, o: AuroraOptions = {}): Promise<PersistentAddressResponse> {
  const key = requireKey(o, "A persistent deposit address");
  return call<PersistentAddressResponse>(auroraUrl("persistent-deposit-address", key), json(req), o, key);
}

/** GET /api/persistent-deposit-status/{apiKey}: received deposits, completed payouts (`success`) or failed payouts. */
export async function persistentDepositStatus(q: { address: string; type: "received" | "success" | "failed"; limit?: number; offset?: number }, o: AuroraOptions = {}): Promise<PersistentDeposit[]> {
  const key = requireKey(o, "A persistent deposit status");
  return (await call<{ deposits: PersistentDeposit[] }>(auroraUrl("persistent-deposit-status", key, q), {}, o, key)).deposits;
}

/** GET /api/persistent-deposit-addresses/{apiKey}: the addresses made with this key. */
export async function listPersistentAddresses(q: { recipient?: string; sender?: string; depositChain?: string; recipientChain?: string; page?: number; perPage?: number } = {}, o: AuroraOptions = {}) {
  const key = requireKey(o, "The persistent address list");
  return call<{ data: { depositAddress: string; recipient: string; sender: string; depositChain: string; destinationSymbol: string; recipientChain: string; memo?: string; createdAt: string; lastTimeUsed: string }[]; total: number; page: number; totalPages: number }>(auroraUrl("persistent-deposit-addresses", key, q), {}, o, key);
}

// ---------- Intents Connect ----------

/** GET /executions/{wallet}/intermediary. No key. The EVM intermediary is the same on every EVM destination. */
export async function connectIntermediary(wallet: string, o: AuroraOptions = {}): Promise<{ evm: string; solana?: string; originAccount: string; originType: string }> {
  return (await call<{ result: { evm: string; solana?: string; originAccount: string; originType: string } }>(`${CONNECT_API}/executions/${wallet}/intermediary`, {}, o)).result;
}

export async function connectSupportedTokens(o: AuroraOptions = {}): Promise<{ in: AuroraToken[]; out: AuroraToken[] }> {
  return (await call<{ result: { in: AuroraToken[]; out: AuroraToken[] } }>(`${CONNECT_API}/supported_tokens`, {}, o)).result;
}

export interface ConnectCreateBody { version: "1.0"; type: "evm"; quote?: { originAsset: string; destinationAsset: string; amount: string; swapType: "EXACT_INPUT" | "EXACT_OUTPUT"; slippageTolerance?: number; deadline?: string; recipient?: string }; steps: ConnectStep[]; outOperation?: boolean; metadata?: Record<string, unknown>; dry: boolean }

/** POST /executions/{wallet}: a quote-backed execution (bridge-in). Needs x-api-key, dry or not. */
export async function connectCreate(wallet: string, body: ConnectCreateBody, o: AuroraOptions = {}): Promise<ConnectExecution> {
  const key = requireKey(o, "An Intents Connect execution");
  return (await call<{ result: ConnectExecution }>(`${CONNECT_API}/executions/${wallet}`, json(body, { "x-api-key": key }), o, key)).result;
}

/** POST /executions/{wallet}/steps: steps on funds the intermediary already holds. No key. */
export async function connectCreateSteps(wallet: string, body: { version: "1.0"; type: "evm"; destinationAsset: string; steps: ConnectStep[]; metadata?: Record<string, unknown>; dry: boolean }, o: AuroraOptions = {}): Promise<ConnectExecution> {
  return (await call<{ result: ConnectExecution }>(`${CONNECT_API}/executions/${wallet}/steps`, json(body), o)).result;
}

/** POST /executions/{wallet}/submit with the user's signature (`encodeErc191Signature`). */
export async function connectSubmitSignature(wallet: string, body: { executionId: string; signature: string; publicKey?: string }, o: AuroraOptions = {}): Promise<unknown> {
  return call(`${CONNECT_API}/executions/${wallet}/submit`, json(body), o);
}

/** GET /executions/{wallet}?id=&status=. */
export async function connectExecutions(wallet: string, q: { id?: string; status?: ConnectStatus[] } = {}, o: AuroraOptions = {}): Promise<ConnectExecution[]> {
  const p = new URLSearchParams();
  if (q.id) p.set("id", q.id);
  if (q.status?.length) p.set("status", q.status.join(","));
  const s = p.toString();
  return (await call<{ result: ConnectExecution[] | null }>(`${CONNECT_API}/executions/${wallet}${s ? `?${s}` : ""}`, {}, o)).result ?? [];
}

/** POST /executions/deposit/submit: records the deposit transaction and notifies 1Click. */
export async function connectSubmitDepositHash(body: { depositAddress: string; txHash: string; memo?: string }, o: AuroraOptions = {}): Promise<unknown> {
  return call(`${CONNECT_API}/executions/deposit/submit`, json(body), o);
}

/** DELETE /executions/{wallet}/{id}. The signature is over "delete_execution:<executionId>" (erc191 for an EVM wallet). */
export async function connectDeleteExecution(wallet: string, executionId: string, signature: string, o: AuroraOptions = {}): Promise<unknown> {
  return call(`${CONNECT_API}/executions/${wallet}/${executionId}`, { ...json({ signature }), method: "DELETE" }, o);
}

// ---------- Deposit-and-execute: USDC -> AUSD on Monad, paid to the user ----------

export const MIN_AMOUNT_OUT = "{MIN_AMOUNT_OUT}";

/**
 * The two calls the intermediary makes on Monad. {MIN_AMOUNT_OUT} is the USDC the bridge guarantees after the network fee.
 * Curve `exchange(i, j, dx, min_dy, receiver)` pays the AUSD straight to the user, so nothing stays in the intermediary.
 */
export function ausdSwapSteps(recipient: string, minAusdOut: bigint): ConnectStep[] {
  if (!isAddress(recipient)) throw new Error(`Not an EVM address: ${recipient}`);
  return [
    { to: MONAD.USDC, value: "0", functionSignature: "approve(address,uint256)", parameters: [MONAD.CURVE_POOL, MIN_AMOUNT_OUT], metadata: { name: "Approve USDC to Curve" } },
    {
      to: MONAD.CURVE_POOL, value: "0", functionSignature: "exchange(int128,int128,uint256,uint256,address)",
      parameters: [String(MONAD.CURVE_USDC_INDEX), String(MONAD.CURVE_AUSD_INDEX), MIN_AMOUNT_OUT, minAusdOut.toString(), recipient],
      metadata: { name: "Swap USDC to AUSD (Curve)", recipient },
    },
  ];
}

const curveAbi = parseAbi(["function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)"]);
/** Curve get_dy(USDC -> AUSD) on Monad. RPC_MONAD or the public RPC. */
export async function curveUsdcToAusd(dx: bigint): Promise<bigint> {
  const client = createPublicClient({ transport: http(process.env.RPC_MONAD || "https://rpc.monad.xyz") });
  return client.readContract({ address: MONAD.CURVE_POOL, abi: curveAbi, functionName: "get_dy", args: [BigInt(MONAD.CURVE_USDC_INDEX), BigInt(MONAD.CURVE_AUSD_INDEX), dx] });
}

export class QuoteMovedError extends Error {
  constructor(message: string, public execution: ConnectExecution) {
    super(message);
  }
}

export interface AusdPlan { execution: ConnectExecution; minUsdcOut: bigint; minAusdOut: bigint; networkFee: bigint; steps: ConnectStep[] }

/**
 * Builds and creates the Intents Connect execution that turns `originAsset` into AUSD at `wallet` on Monad.
 * 1. A dry create with the real steps (min_dy 0) gives the post-fee USDC minimum and the network fee.
 * 2. Curve get_dy of that minimum, less `swapSlippageBps`, is the AUSD minimum.
 * 3. The real create (dry: false) returns the payload the user signs and the deposit address.
 * `wallet` is the user's EVM address: it signs (erc191), it owns the intermediary, and it receives the AUSD.
 */
export async function planAusdExecution(args: { wallet: string; originAsset: string; amount: string; slippageBps?: number; swapSlippageBps?: number; deadline: string; metadata?: Record<string, unknown> }, o: AuroraOptions = {}): Promise<AusdPlan> {
  const getDy = o.getDy ?? curveUsdcToAusd;
  const swapSlip = BigInt(args.swapSlippageBps ?? 50);
  const quoteBody = { originAsset: args.originAsset, destinationAsset: MONAD.USDC_ASSET, amount: args.amount, swapType: "EXACT_INPUT" as const, slippageTolerance: args.slippageBps ?? 100, deadline: args.deadline };
  const metadata = { title: "Deposit to Perpl (AUSD on Monad)", intent: "monad_ausd_deposit", ...args.metadata };
  const dry = await connectCreate(args.wallet, { version: "1.0", type: "evm", quote: quoteBody, steps: ausdSwapSteps(args.wallet, 0n), metadata, dry: true }, o);
  if (!dry.details?.networkFee) throw new Error("Intents Connect did not estimate the network fee. Try again.");
  const minUsdcOut = BigInt(dry.quote?.minAmountOut ?? "0");
  if (minUsdcOut <= 0n) throw new Error("The amount is too small: nothing is left after the fees.");
  const minAusdOut = ((await getDy(minUsdcOut)) * (10_000n - swapSlip)) / 10_000n;
  const steps = ausdSwapSteps(args.wallet, minAusdOut);
  const execution = await connectCreate(args.wallet, { version: "1.0", type: "evm", quote: quoteBody, steps, metadata, dry: false }, o);
  const realMin = BigInt(execution.quote?.minAmountOut ?? "0");
  if (realMin < minUsdcOut && (await getDy(realMin)) < minAusdOut) {
    throw new QuoteMovedError("The quote got worse between the preview and the execution. Do not sign it. Ask for a new deposit.", execution);
  }
  return { execution, minUsdcOut, minAusdOut, networkFee: BigInt(dry.details.networkFee), steps };
}

/**
 * Recovery after OPERATION_FAILED: the USDC is in the user's intermediary on Monad. This steps-only execution sends
 * `usdcBalance` less the network fee to the wallet. The user signs it like a deposit execution. No key needed.
 */
export async function planIntermediaryRecovery(wallet: string, usdcBalance: bigint, o: AuroraOptions = {}): Promise<ConnectExecution> {
  const transfer = (amount: bigint): ConnectStep[] => [{ to: MONAD.USDC, value: "0", functionSignature: "transfer(address,uint256)", parameters: [wallet, amount.toString()], metadata: { name: "Return USDC to wallet" } }];
  const body = (amount: bigint, dry: boolean) => ({ version: "1.0" as const, type: "evm" as const, destinationAsset: MONAD.USDC_ASSET, steps: transfer(amount), metadata: { title: "Return USDC", intent: "intermediary_recovery" }, dry });
  const dry = await connectCreateSteps(wallet, body(usdcBalance, true), o);
  const fee = BigInt(dry.details?.networkFee ?? "0");
  if (usdcBalance <= fee) throw new Error("The intermediary balance does not cover the network fee.");
  return connectCreateSteps(wallet, body(usdcBalance - fee, false), o);
}

// ---------- signatures ----------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

/** personal_sign output (0x r||s||v, v 27/28 or 0/1) to the Intents Connect form "secp256k1:" + base58(r||s||v0/1). */
export function encodeErc191Signature(sigHex: string): string {
  const hex = sigHex.startsWith("0x") ? sigHex.slice(2) : sigHex;
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) throw new Error("The signature must be 65 bytes of hex.");
  const bytes = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  if (bytes[64]! >= 27) bytes[64] = bytes[64]! - 27;
  return `secp256k1:${base58(bytes)}`;
}

/** Fee facts for the UI. The integrator fee is set per key in the Aurora portal, not in the request. */
export function auroraFeeDisclosure() {
  const bps = Number(process.env.AURORA_FEE_BPS ?? 0) || 0;
  return {
    integratorFeeBps: bps,
    feeRecipient: process.env.AURORA_FEE_RECIPIENT || null,
    split: "60% integrator, 40% Aurora",
    auroraMinimumBps: { stable: 2, other: 10 },
    maxFeeBps: 500,
    note: "Aurora takes the fees from the swap. The quote amounts already include them.",
  };
}
