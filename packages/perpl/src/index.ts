// Perpl: a fully on-chain perpetuals order book (CLOB) on Monad. One Exchange contract holds every market, account and position.
// Docs:      https://docs.perpl.xyz (exchange, margin, fees, liquidation)
// API docs:  https://github.com/PerplFoundation/api-docs (REST and WebSocket)
// ABI:       https://github.com/PerplFoundation/dex-sdk (crates/sdk/abi/dex)
// Facts below were read from the docs, the public API and the mainnet contract on 2026-10-13.
//
// Units: CNS = collateral (AUSD, 6 decimals). PNS = price x 10^priceDecimals. LNS = size x 10^sizeDecimals (1 LNS is the
// smallest order). Hdths = hundredths (leverageHdths 500 = 5x). On-chain order types differ from the API ones (see ORDER_TYPE).
// Margin is isolated: each position has its own collateral, taken from the free balance of the account.
// This package has no database and no app config, so the API server, the MetaMask Agent Wallet plugin and the mobile app share it.
import { createPublicClient, defineChain, encodeFunctionData, erc20Abi, http, type Address, type Hex, type PublicClient } from "viem";
import { perplAbi } from "./abi";

export { perplAbi } from "./abi";

/** A transaction to send on Monad. The same shape as the EvmTx of the server. */
export interface EvmTx { to: Address | null; data: Hex; value: string; description: string }

export const monadChain = defineChain({
  id: 143, name: "Monad", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } }, blockExplorers: { default: { name: "Monadscan", url: "https://monadscan.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

let rpcUrl = "https://rpc.monad.xyz";
let apiBase = "https://app.perpl.xyz/api";
let cachedClient: PublicClient | undefined;

/** Set the Monad RPC and the Perpl API base. Call it once at start; the defaults are the public endpoints. */
export function configurePerpl(opts: { rpcUrl?: string; apiBase?: string; client?: PublicClient }) {
  if (opts.rpcUrl) rpcUrl = opts.rpcUrl;
  if (opts.apiBase) apiBase = opts.apiBase;
  cachedClient = opts.client;
}

const client = (): PublicClient => (cachedClient ??= createPublicClient({ chain: monadChain, transport: http(rpcUrl) }) as PublicClient);

async function getJson<T>(url: string, init: { timeoutMs?: number } = {}): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(init.timeoutMs ?? 15_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Perpl API ${res.status} for ${url.replace(apiBase, "")}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export const PERPL_EXCHANGE = "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F" as const;
/** The only collateral of Perpl. Source: getExchangeInfo() on the Exchange, and the Monad token list. */
export const AUSD = { address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as Address, decimals: 6, symbol: "AUSD" } as const;
export const PERPL_API = "https://app.perpl.xyz/api";
const api = () => apiBase;
export const PERPL_APP = "https://app.perpl.xyz";
export const MONAD_EXPLORER = "https://monadscan.com";

/** On-chain OrderDesc.orderType. The REST API uses these values plus 1. */
export const ORDER_TYPE = { OpenLong: 0, OpenShort: 1, CloseLong: 2, CloseShort: 3, Cancel: 4, AddCollateral: 5, Change: 6 } as const;
/** On-chain positionType. */
export const POSITION_TYPE = { Long: 0, Short: 1 } as const;
/** The contract caps one order at this many matches. 0 in OrderDesc means this default. */
const MAX_MATCHES = 0n;
/** Blocks a sent order stays valid (lastExecutionBlock). A Monad block is about 0.3 s, so 300 blocks is about 90 s. */
export const ORDER_VALID_BLOCKS = 300n;
/** Default and maximum price change accepted for a market order. */
export const DEFAULT_SLIPPAGE_BPS = 50;
export const MAX_SLIPPAGE_BPS = 300;

const ten = (n: number) => 10 ** n;

// ── Markets ────────────────────────────────────────────────────────────────

interface CtxMarket {
  id: number; perpetual_id: number; name: string; size_units: string; funding_interval_sec: number; order_ttl_blocks: number;
  order_max_market_slippage_bps: number; order_max_neg_pnl_collat_bps: number;
  config: { is_open: boolean; price_decimals: number; size_decimals: number; initial_margin: number; maintenance_margin: number; maker_fee: number; taker_fee: number; min_posting_amount: string };
}
interface CtxToken { address: string; symbol: string; decimals: number }
interface Context { chain: { chain_id: number }; markets: CtxMarket[]; tokens?: CtxToken[]; [k: string]: unknown }
interface Tick { at: { b: number; t: number }; orl: number; mrk: number; lst: number; mid: number; bid: number; ask: number; prv: number; dv: number; dva: string; oi: number; tvl: string }

export interface PerplMarket {
  /** The market id. On mainnet it equals the on-chain perpId. */
  id: number;
  symbol: string;
  isOpen: boolean;
  priceDecimals: number;
  sizeDecimals: number;
  /** Smallest order size in base units: 1 LNS. */
  minSize: number;
  maxLeverage: number;
  /** Maintenance margin as a fraction of the position value. */
  maintenanceMargin: number;
  takerFee: number;
  makerFee: number;
  markPx: number;
  oraclePx: number;
  lastPx: number;
  bidPx: number;
  askPx: number;
  change24hPct: number;
  /** Funding of one interval as a fraction of the index price. Positive: longs pay shorts. */
  fundingRate: number;
  fundingIntervalSec: number;
  openInterestUsd: number;
  dayVolumeUsd: number;
  orderTtlBlocks: number;
  asOf: string;
}

let ctxCache: { at: number; ctx: Context } | undefined;
async function context(): Promise<Context> {
  if (ctxCache && Date.now() - ctxCache.at < 300_000) return ctxCache.ctx;
  const ctx = await getJson<Context>(`${api()}/v1/pub/context`, { timeoutMs: 15_000 });
  ctxCache = { at: Date.now(), ctx };
  return ctx;
}

let tickCache: { at: number; d: Record<string, Tick> } | undefined;
async function tickers(): Promise<Record<string, Tick>> {
  if (tickCache && Date.now() - tickCache.at < 3_000) return tickCache.d;
  const r = await getJson<{ d: Record<string, Tick> }>(`${api()}/v1/market-data/ticker`, { timeoutMs: 10_000 });
  tickCache = { at: Date.now(), d: r.d };
  return r.d;
}

export async function listMarkets(): Promise<PerplMarket[]> {
  const [ctx, ticks] = await Promise.all([context(), tickers()]);
  const funding = ctx.markets as (CtxMarket & { funding?: { rate: number } })[];
  return funding.filter((m) => m.config).map((m) => {
    const c = m.config;
    const t = ticks[String(m.id)];
    const px = (v: number | undefined) => (v ?? 0) / ten(c.price_decimals);
    const mark = px(t?.mrk);
    return {
      id: m.id, symbol: m.name, isOpen: c.is_open, priceDecimals: c.price_decimals, sizeDecimals: c.size_decimals, minSize: 1 / ten(c.size_decimals),
      maxLeverage: c.initial_margin / 100, maintenanceMargin: 100 / c.maintenance_margin,
      // Fees in parts per million: 345 = 3.45 bps.
      takerFee: c.taker_fee / 1e6, makerFee: c.maker_fee / 1e6,
      markPx: mark, oraclePx: px(t?.orl), lastPx: px(t?.lst), bidPx: px(t?.bid), askPx: px(t?.ask),
      change24hPct: t?.prv ? ((t.lst - t.prv) / t.prv) * 100 : 0,
      fundingRate: (m.funding?.rate ?? 0) / 1e6, fundingIntervalSec: m.funding_interval_sec,
      openInterestUsd: ((t?.oi ?? 0) / ten(c.size_decimals)) * mark, dayVolumeUsd: Number(t?.dva ?? 0) / 1e6,
      orderTtlBlocks: m.order_ttl_blocks, asOf: t ? new Date(t.at.t).toISOString() : new Date().toISOString(),
    };
  });
}

/** Markets whose symbol matches the query. "bitcoin" matches BTC, "ether" matches ETH. */
export async function findMarkets(query?: string): Promise<PerplMarket[]> {
  const all = (await listMarkets()).filter((m) => m.isOpen);
  const q = (query ?? "").trim().toUpperCase();
  if (!q) return all;
  const alias: Record<string, string> = { BITCOIN: "BTC", ETHER: "ETH", ETHEREUM: "ETH", SOLANA: "SOL", MONAD: "MON", ZCASH: "ZEC", UNISWAP: "UNI" };
  const want = alias[q] ?? q;
  return all.filter((m) => m.symbol.toUpperCase() === want || m.symbol.toUpperCase().includes(want) || String(m.id) === q);
}

/** One market by symbol or id. */
export async function getMarket(market: string | number): Promise<PerplMarket> {
  const all = await listMarkets();
  const key = String(market).trim().toUpperCase();
  const m = all.find((x) => x.symbol.toUpperCase() === key || String(x.id) === key);
  if (!m) throw new Error(`Unknown Perpl market "${market}". Markets: ${all.filter((x) => x.isOpen).map((x) => x.symbol).join(", ")}.`);
  if (!m.isOpen) throw new Error(`The Perpl ${m.symbol} market is not open.`);
  return m;
}

export interface BookLevel { px: number; size: number; orders: number }

/** The order book of a market, best levels first. */
export async function getBook(market: string | number, levels = 20) {
  const m = await getMarket(market);
  const r = await getJson<{ at: { t: number }; bid: { p: number; s: number; o: number }[]; ask: { p: number; s: number; o: number }[] }>(`${api()}/v1/market-data/${m.id}/book?levels=${Math.min(Math.max(levels, 1), 100)}`, { timeoutMs: 10_000 });
  const lvl = (l: { p: number; s: number; o: number }): BookLevel => ({ px: l.p / ten(m.priceDecimals), size: l.s / ten(m.sizeDecimals), orders: l.o });
  return { market: m.symbol, asOf: new Date(r.at.t).toISOString(), bids: r.bid.map(lvl), asks: r.ask.map(lvl) };
}

/** Average fill price of a market order of `size` from the live book, and whether the book holds enough. */
export async function estimateFill(market: string | number, isBuy: boolean, size: number) {
  const book = await getBook(market, 100);
  let left = size;
  let cost = 0;
  for (const l of isBuy ? book.asks : book.bids) {
    const take = Math.min(left, l.size);
    cost += take * l.px;
    left -= take;
    if (left <= 1e-12) break;
  }
  const filled = size - Math.max(0, left);
  return { avgPx: filled > 0 ? cost / filled : 0, filled, enoughLiquidity: left <= 1e-12 };
}

// ── Accounts and positions ─────────────────────────────────────────────────

export interface PerplPosition {
  market: string;
  marketId: number;
  side: "long" | "short";
  size: number;
  entryPx: number;
  markPx: number;
  markPriceValid: boolean;
  /** The money in this position (isolated margin), in USD. */
  marginUsd: number;
  notionalUsd: number;
  /** Notional at mark divided by the margin. */
  leverage: number;
  /** Profit or loss now, at the mark price, with funding. */
  unrealizedPnl: number;
  liquidationPx: number | null;
  /** Fraction of the mark price between mark and liquidation. */
  distanceToLiquidation: number | null;
}

export interface PerplAccount {
  address: string;
  accountId: number | null;
  /** AUSD in the account, outside positions. */
  balanceUsd: number;
  /** AUSD held by resting orders. */
  lockedUsd: number;
  /** AUSD that can open positions or be withdrawn. */
  freeUsd: number;
  frozen: boolean;
  positions: PerplPosition[];
}

/** The exchange account of an address, or null when it has none. */
export async function getAccountInfo(address: Address) {
  try {
    const a = await client().readContract({ address: PERPL_EXCHANGE, abi: perplAbi, functionName: "getAccountByAddr", args: [address] });
    return a.accountId === 0n ? null : a;
  } catch (err) {
    if (/AccountDoesNotExist/.test(String(err))) return null;
    throw err;
  }
}

/** Position view with the liquidation price. Formula: docs.perpl.xyz liquidation page and the SDK position.rs. */
function positionView(m: PerplMarket, p: { positionType: number; depositCNS: bigint; pricePNS: bigint; lotLNS: bigint; pnlCNS: bigint; premiumPnlCNS: bigint }, markPNS: bigint, markPriceValid: boolean): PerplPosition {
  const entry = Number(p.pricePNS) / ten(m.priceDecimals);
  const size = Number(p.lotLNS) / ten(m.sizeDecimals);
  const mark = Number(markPNS) / ten(m.priceDecimals) || m.markPx;
  const deposit = Number(p.depositCNS) / 1e6;
  const premium = Number(p.premiumPnlCNS) / 1e6;
  const long = p.positionType === POSITION_TYPE.Long;
  const s = long ? 1 : -1;
  // Maintenance margin requirement on the entry value.
  const mmr = entry * size * m.maintenanceMargin;
  const liq = size > 0 ? Math.max(0, entry + (s * (mmr - deposit - premium)) / size) : null;
  return {
    market: m.symbol, marketId: m.id, side: long ? "long" : "short", size, entryPx: entry, markPx: mark, markPriceValid,
    marginUsd: deposit, notionalUsd: size * mark, leverage: deposit > 0 ? (size * mark) / deposit : 0,
    unrealizedPnl: Number(p.pnlCNS) / 1e6, liquidationPx: liq,
    distanceToLiquidation: liq === null || mark === 0 ? null : Math.abs(mark - liq) / mark,
  };
}

/** Balances and open positions of an address on Perpl, read from the contract. */
export async function getAccount(address: Address, onlyMarket?: string | number): Promise<PerplAccount> {
  const info = await getAccountInfo(address);
  if (!info) return { address, accountId: null, balanceUsd: 0, lockedUsd: 0, freeUsd: 0, frozen: false, positions: [] };
  const markets = onlyMarket !== undefined ? [await getMarket(onlyMarket)] : (await listMarkets()).filter((m) => m.isOpen);
  const reads = await Promise.all(markets.map((m) => client().readContract({ address: PERPL_EXCHANGE, abi: perplAbi, functionName: "getPositionV2", args: [BigInt(m.id), info.accountId] }).then((r) => ({ m, r }))));
  const positions = reads.filter(({ r }) => r[0].lotLNS > 0n).map(({ m, r }) => positionView(m, r[0], r[1], r[2]));
  const balance = Number(info.balanceCNS) / 1e6;
  const locked = Number(info.lockedBalanceCNS) / 1e6;
  return { address, accountId: Number(info.accountId), balanceUsd: balance, lockedUsd: locked, freeUsd: Math.max(0, balance - locked), frozen: info.frozen !== 0, positions };
}

export async function getPosition(address: Address, market: string | number): Promise<PerplPosition | null> {
  return (await getAccount(address, market)).positions[0] ?? null;
}

/** AUSD in the wallet itself (not in Perpl). */
export async function walletAusd(address: Address): Promise<number> {
  const b = await client().readContract({ address: AUSD.address, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  return Number(b) / 1e6;
}

export interface PerplOrder { market: string; marketId: number; orderId: number; type: string; side: "long" | "short"; reduceOnly: boolean; px: number; size: number; leverage: number; expiryBlock: number }

const TYPE_NAMES = ["OpenLong", "OpenShort", "CloseLong", "CloseShort"] as const;

/**
 * Read resting orders by id. The contract has no list of the orders of one account, so the server keeps the ids of the
 * orders it placed and checks each one here. Order ids are reused for each market, so the account id must match.
 */
export async function readOrders(accountId: number, refs: { marketId: number; orderId: number }[]): Promise<PerplOrder[]> {
  const markets = await listMarkets();
  const infos = new Map<number, bigint>();
  const out: PerplOrder[] = [];
  await Promise.all(refs.map(async (ref) => {
    const m = markets.find((x) => x.id === ref.marketId);
    if (!m) return;
    if (!infos.has(m.id)) infos.set(m.id, (await client().readContract({ address: PERPL_EXCHANGE, abi: perplAbi, functionName: "getPerpetualInfoV2", args: [BigInt(m.id)] })).basePricePNS);
    const o = await client().readContract({ address: PERPL_EXCHANGE, abi: perplAbi, functionName: "getOrderV2", args: [BigInt(m.id), BigInt(ref.orderId)] });
    if (o.accountId !== accountId || Number(o.lotLNS) === 0 || o.orderType > 3) return;
    const pricePNS = BigInt(o.priceONS) + infos.get(m.id)!;
    out.push({
      market: m.symbol, marketId: m.id, orderId: ref.orderId, type: TYPE_NAMES[o.orderType]!, side: o.orderType === 0 || o.orderType === 3 ? "long" : "short",
      reduceOnly: o.orderType >= 2, px: Number(pricePNS) / ten(m.priceDecimals), size: Number(o.lotLNS) / ten(m.sizeDecimals), leverage: o.leverageHdths / 100, expiryBlock: o.expiryBlock,
    });
  }));
  return out;
}

// ── Order math and transactions ────────────────────────────────────────────

export const toPNS = (m: PerplMarket, px: number) => BigInt(Math.round(px * ten(m.priceDecimals)));
export const toCNS = (usd: number) => BigInt(Math.round(usd * 1e6));
/** Size in lots, rounded down so an order never exceeds what was asked. */
export const toLNS = (m: PerplMarket, size: number) => BigInt(Math.floor(size * ten(m.sizeDecimals) + 1e-9));

export interface OrderDescInput {
  perpId: bigint; orderType: number; orderId?: bigint; pricePNS?: bigint; lotLNS?: bigint; expiryBlock?: bigint;
  postOnly?: boolean; fillOrKill?: boolean; immediateOrCancel?: boolean; leverageHdths?: bigint; lastExecutionBlock?: bigint; amountCNS?: bigint; maxNegPnlCollatBPS?: bigint;
}

export function orderDesc(p: OrderDescInput) {
  return {
    orderDescId: BigInt(Date.now()), perpId: p.perpId, orderType: p.orderType, orderId: p.orderId ?? 0n, pricePNS: p.pricePNS ?? 0n, lotLNS: p.lotLNS ?? 0n,
    expiryBlock: p.expiryBlock ?? 0n, postOnly: p.postOnly ?? false, fillOrKill: p.fillOrKill ?? false, immediateOrCancel: p.immediateOrCancel ?? false,
    maxMatches: MAX_MATCHES, leverageHdths: p.leverageHdths ?? 0n, lastExecutionBlock: p.lastExecutionBlock ?? 0n, amountCNS: p.amountCNS ?? 0n,
    maxNegPnlCollatBPS: p.maxNegPnlCollatBPS ?? 300n,
  };
}

const call = (data: Hex, description: string): EvmTx => ({ to: PERPL_EXCHANGE, data, value: "0", description });

export function execOrderTx(p: OrderDescInput, description: string): EvmTx {
  return call(encodeFunctionData({ abi: perplAbi, functionName: "execOrder", args: [orderDesc(p)] }), description);
}

export const headBlock = () => client().getBlockNumber();

/**
 * Transactions that bring the free balance of the Perpl account to `neededUsd`, from AUSD in the wallet:
 * an approval, then createAccount (first time) or depositCollateral. Empty when the free balance is enough.
 * A first deposit and each later deposit must be at least 10 AUSD (read live from the contract for the first one).
 */
export async function fundingTxs(address: Address, neededUsd: number): Promise<{ txs: EvmTx[]; depositUsd: number; account: PerplAccount }> {
  const account = await getAccount(address);
  const missing = neededUsd - account.freeUsd;
  if (missing <= 0) return { txs: [], depositUsd: 0, account };
  const minOpen = account.accountId === null ? Number(await client().readContract({ address: PERPL_EXCHANGE, abi: perplAbi, functionName: "getMinAccountOpenCNS" })) / 1e6 : 10;
  const deposit = Math.ceil(Math.max(missing * 1.01, minOpen) * 1e6) / 1e6;
  const inWallet = await walletAusd(address);
  if (inWallet + 1e-9 < deposit) {
    throw new Error(`Perpl needs ${deposit.toFixed(2)} AUSD more in the trading account (free now: ${account.freeUsd.toFixed(2)}, a deposit is at least ${minOpen} AUSD). The wallet holds ${inWallet.toFixed(2)} AUSD on Monad. Swap to AUSD on Monad first (swap tool: fromChain monad, toToken ${AUSD.address}), or move funds to Monad.`);
  }
  const amount = toCNS(deposit);
  const txs: EvmTx[] = [
    { to: AUSD.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERPL_EXCHANGE, amount] }), value: "0", description: `Allow Perpl to take ${deposit} AUSD` },
    account.accountId === null
      ? call(encodeFunctionData({ abi: perplAbi, functionName: "createAccount", args: [amount] }), `Open the Perpl account with ${deposit} AUSD`)
      : call(encodeFunctionData({ abi: perplAbi, functionName: "depositCollateral", args: [amount] }), `Add ${deposit} AUSD to the Perpl account`),
  ];
  return { txs, depositUsd: deposit, account };
}

export function withdrawTx(usd: number): EvmTx {
  return call(encodeFunctionData({ abi: perplAbi, functionName: "withdrawCollateral", args: [toCNS(usd)] }), `Withdraw ${usd} AUSD from Perpl to the wallet`);
}

export function addMarginTx(m: PerplMarket, usd: number): EvmTx {
  return call(encodeFunctionData({ abi: perplAbi, functionName: "increasePositionCollateral", args: [BigInt(m.id), toCNS(usd)] }), `Add ${usd} AUSD of margin to the ${m.symbol} position`);
}

/** A request only: a Perpl keeper applies it within about 120 s, or declines it (for example when it would make the position unsafe). */
export function removeMarginTx(m: PerplMarket, usd: number): EvmTx {
  return call(encodeFunctionData({ abi: perplAbi, functionName: "requestDecreasePositionCollateral", args: [BigInt(m.id), toCNS(usd), true] }), `Ask to take ${usd} AUSD of margin out of the ${m.symbol} position`);
}

/** Estimated liquidation price of a new isolated position: entry minus (margin - maintenance margin) per unit. */
export function estimateLiquidationPx(args: { entryPx: number; size: number; marginUsd: number; maintenanceMargin: number; isLong: boolean }) {
  const mmr = args.entryPx * args.size * args.maintenanceMargin;
  const s = args.isLong ? 1 : -1;
  return Math.max(0, args.entryPx + (s * (mmr - args.marginUsd)) / args.size);
}

export interface OpenPreview {
  market: PerplMarket;
  isLong: boolean;
  orderKind: "market" | "limit";
  size: number;
  lotLNS: bigint;
  leverage: number;
  /** Expected average fill price (market) or the limit price. */
  estEntryPx: number;
  /** The worst price the order accepts. */
  limitPx: number;
  notionalUsd: number;
  marginUsd: number;
  estFeeUsd: number;
  estLiquidationPx: number;
  distanceToLiquidation: number;
  warnings: string[];
}

/**
 * Size and price an opening order. Give the money to put in (marginUsd) or the position size in USD (sizeUsd), and the leverage.
 * A market order is a limit order at the worst accepted price with immediate-or-cancel: Perpl has no other market order on-chain.
 */
export async function previewOpen(args: { market: string | number; isLong: boolean; leverage: number; marginUsd?: number; sizeUsd?: number; size?: number; orderKind?: "market" | "limit"; limitPx?: number; slippageBps?: number; postOnly?: boolean }): Promise<OpenPreview> {
  const m = await getMarket(args.market);
  const warnings: string[] = [];
  if (args.leverage > m.maxLeverage) throw new Error(`The most leverage on Perpl ${m.symbol} is ${m.maxLeverage}x. ${args.leverage}x is not possible.`);
  if (args.leverage < 1) throw new Error("Leverage must be at least 1x.");
  const kind = args.orderKind ?? (args.limitPx ? "limit" : "market");
  const slip = Math.min(args.slippageBps ?? DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS) / 10_000;
  if (kind === "limit" && !args.limitPx) throw new Error("A limit order needs limitPx.");
  const refPx = kind === "limit" ? args.limitPx! : args.isLong ? m.askPx || m.markPx : m.bidPx || m.markPx;
  const sizeWanted = args.size ?? (args.sizeUsd ?? (args.marginUsd ?? 0) * args.leverage) / refPx;
  if (!(sizeWanted > 0)) throw new Error("Give marginUsd, sizeUsd or size.");
  const lotLNS = toLNS(m, sizeWanted);
  if (lotLNS < 1n) throw new Error(`The smallest ${m.symbol} order on Perpl is ${m.minSize} ${m.symbol} (about ${(m.minSize * refPx).toFixed(2)} USD of position).`);
  const size = Number(lotLNS) / ten(m.sizeDecimals);
  let estEntry = refPx;
  let limitPx = refPx;
  if (kind === "market") {
    const fill = await estimateFill(m.id, args.isLong, size);
    if (!fill.enoughLiquidity) warnings.push(`The book holds only ${fill.filled} ${m.symbol} near the price. Part of the order may not fill.`);
    estEntry = fill.avgPx || refPx;
    limitPx = args.isLong ? m.markPx * (1 + slip) : m.markPx * (1 - slip);
    if (args.isLong ? estEntry > limitPx : estEntry < limitPx) warnings.push(`The expected fill (${estEntry}) is past the worst accepted price (${limitPx}). The order can fill only in part.`);
  } else {
    const crosses = args.isLong ? limitPx >= m.askPx : limitPx <= m.bidPx;
    if (crosses && args.postOnly) throw new Error(`A post-only ${args.isLong ? "buy" : "sell"} at ${limitPx} would trade at once (best ${args.isLong ? "ask" : "bid"} ${args.isLong ? m.askPx : m.bidPx}). Choose another price or drop postOnly.`);
    if (crosses) warnings.push("This limit price trades at once against the book, like a market order.");
  }
  const notional = size * estEntry;
  const margin = notional / args.leverage;
  const liq = estimateLiquidationPx({ entryPx: estEntry, size, marginUsd: margin, maintenanceMargin: m.maintenanceMargin, isLong: args.isLong });
  if (m.markPx > 0 && Math.abs(m.markPx - m.oraclePx) / m.markPx > 0.02) warnings.push(`The mark price (${m.markPx}) is more than 2% from the oracle price (${m.oraclePx}).`);
  return {
    market: m, isLong: args.isLong, orderKind: kind, size, lotLNS, leverage: args.leverage, estEntryPx: estEntry, limitPx,
    notionalUsd: notional, marginUsd: margin, estFeeUsd: notional * (kind === "market" ? m.takerFee : m.makerFee),
    estLiquidationPx: liq, distanceToLiquidation: estEntry > 0 ? Math.abs(estEntry - liq) / estEntry : 0, warnings,
  };
}

export interface Candle { t: number; o: number; h: number; l: number; c: number; volumeUsd: number; trades: number }

/** Price candles of a market. `resolutionSec` is the bar size (60, 300, 900, 3600, 14400, 86400). At most 1024 bars per call. */
export async function getCandles(market: string | number, resolutionSec = 3600, hours = 24): Promise<{ market: string; resolutionSec: number; candles: Candle[] }> {
  const m = await getMarket(market);
  const to = Date.now();
  const from = to - Math.min(hours * 3_600_000, resolutionSec * 1000 * 1024);
  const r = await getJson<{ d: { t: number; o: number; h: number; l: number; c: number; v: string; n: number }[] }>(`${api()}/v1/market-data/${m.id}/candles/${resolutionSec}/${from}-${to}`);
  const px = (v: number) => v / ten(m.priceDecimals);
  // Volume is in AUSD units (6 decimals).
  return { market: m.symbol, resolutionSec, candles: r.d.map((k) => ({ t: k.t, o: px(k.o), h: px(k.h), l: px(k.l), c: px(k.c), volumeUsd: Number(k.v) / 1e6, trades: k.n })) };
}
