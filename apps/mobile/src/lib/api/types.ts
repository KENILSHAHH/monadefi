/**
 * Response types of the Mona-DeFi API, as docs/api-mobile.md defines them.
 * Types marked "ASSUMED" are not fully specified in the contract. The README lists them for the API team.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export interface ApiErrorBody {
  error: string;
  code?: string;
  risk?: RiskVerdict;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface ChallengeResponse {
  nonce: string;
  message: string;
}

export interface VerifyResponse {
  token: string;
  address: string;
  agentAddress: string;
}

// ── Session ──────────────────────────────────────────────────────────────────

export type SessionStatusValue = "none" | "needs_upgrade" | "needs_signature" | "active" | "expired";
export type PermissionKind = "perpl_trade" | "ausd_approve";

export interface SessionPermission {
  id: string;
  kind: PermissionKind;
  expiresAt: string;
  status: "pending" | "active" | "expired";
}

export interface SessionStatus {
  status: SessionStatusValue;
  address: string;
  agentAddress: string;
  upgraded: boolean;
  implementation: Address;
  chainId: number;
  permissions: SessionPermission[];
  scope: { targets: string[]; functions: string[]; cannot: string[] };
}

export interface SignedAuthorizationBody {
  address: Address;
  chainId: number;
  nonce: number;
  r: Hex;
  s: Hex;
  yParity: number;
}

export interface TxResponse {
  hash: Hex;
  explorer: string;
}

/** EIP-712 typed data as the server sends it. Integer fields can come as decimal strings. */
export interface TypedDataPayload {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface SessionStartResponse {
  permissions: { id: string; kind: PermissionKind; typedData: TypedDataPayload }[];
  expiresAt?: string;
}

/** ASSUMED: `calls` is optional (not sent today). When present, the app relays them to disable the delegations on-chain. */
export interface SessionRevokeResponse {
  revoked: boolean;
  calls?: RelayCall[];
}

// ── Relay ────────────────────────────────────────────────────────────────────

export interface RelayCall {
  to: Address;
  data: Hex;
  value: string;
  description: string;
}

export interface RelayPrepareResponse {
  id: string;
  typedData: TypedDataPayload;
  expiresAt: string;
  calls: RelayCall[];
}

export interface RelaySendResponse {
  hash: Hex;
  explorer: string;
  status: "success" | "reverted" | string;
}

// ── Balances and positions ───────────────────────────────────────────────────

export interface Balance {
  address: string;
  asOf: string;
  ausd: { wallet: number; perplFree: number; perplLocked: number; inPositions: number; total: number };
  usdc: number;
  mon: number;
  totalUsd: number;
}

export interface PerplPosition {
  market: string;
  marketId: number;
  side: "long" | "short";
  size: number;
  entryPx: number;
  markPx: number;
  marginUsd: number;
  notionalUsd: number;
  leverage: number;
  unrealizedPnl: number;
  liquidationPx: number | null;
  /** Fraction of the mark price between mark and liquidation. */
  distanceToLiquidation: number | null;
}

/** GET /positions: the same view as the web app. The mobile app reads the Perpl part and the errors. */
export interface PositionsView {
  address: string;
  asOf: string;
  perpl: {
    accountId: number | null;
    balanceUsd: number;
    lockedUsd: number;
    freeUsd: number;
    positions: PerplPosition[];
  };
  guards: { id: string; venue: string; params: Record<string, unknown>; status: string }[];
  errors: string[];
}

export type ActivityKind = "trade" | "deposit" | "job" | "session" | "relay";

export interface ActivityItem {
  kind: ActivityKind;
  title: string;
  status: string;
  at: string;
  explorer?: string | null;
}

// ── Markets ──────────────────────────────────────────────────────────────────

/** PerplMarket from packages/perpl. */
export interface PerplMarket {
  id: number;
  symbol: string;
  isOpen: boolean;
  priceDecimals: number;
  sizeDecimals: number;
  minSize: number;
  maxLeverage: number;
  maintenanceMargin: number;
  takerFee: number;
  makerFee: number;
  markPx: number;
  oraclePx: number;
  lastPx: number;
  bidPx: number;
  askPx: number;
  /** A percentage: 2.5 means +2.5% (packages/perpl listMarkets). */
  change24hPct: number;
  /** Funding of one interval as a fraction of the index price. Positive: longs pay shorts. */
  fundingRate: number;
  fundingIntervalSec: number;
  openInterestUsd: number;
  dayVolumeUsd: number;
  orderTtlBlocks: number;
  asOf: string;
}

export interface BookLevel {
  px: number;
  size: number;
  orders: number;
}

export interface OrderBook {
  market: string;
  asOf: string;
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
  volumeUsd?: number;
  trades?: number;
}

// ── Risk (Nansen) — RiskVerdict from packages/risk/src/assess.ts ─────────────

export type RiskSegment = "smart_money" | "whales" | "exchanges" | "fresh_wallets" | "top_holders" | "public_figures" | "concentration" | "trader";
export type Side = "long" | "short";

export interface RiskSignal {
  id: string;
  segment: RiskSegment;
  label: string;
  value: number;
  unit: string;
  window: string;
  direction: "with_trade" | "against_trade" | "neutral";
  weight: number;
  impact: number;
  source: string;
}

export interface RiskVerdict {
  market: string;
  side: Side;
  asOf: string;
  dataAvailable: boolean;
  score: number;
  level: "low" | "medium" | "high" | "extreme";
  decision: "allow" | "reduce" | "block";
  adjusted: {
    maxLeverage: number;
    sizeMultiplier: number;
    requireStopLoss: boolean;
    stopLossDistancePct: number | null;
    extraMarginPct: number;
  };
  changes: string[];
  reasons: string[];
  signals: RiskSignal[];
  creditsUsed: number;
  cached: boolean;
}

/** POST /risk/check: the verdict plus the order after the verdict. */
export interface RiskCheckResponse extends RiskVerdict {
  applied: { leverage: number; marginUsd: number; stopLossPx?: number | null };
  blocked: boolean;
  markPx: number;
}

export interface RiskCheckBody {
  market: string;
  side: Side;
  leverage: number;
  marginUsd: number;
}

// ── Trade and intents ────────────────────────────────────────────────────────

export type IntentStatus = "pending" | "confirmed" | "executing" | "done" | "failed" | "rejected" | "expired";

export interface Receipt {
  hash: string;
  explorer: string;
  description?: string;
}

/** The result of an executed Perpl intent. Every field is optional: the kind of action decides which ones exist. */
export interface IntentResult {
  avgFillPx?: number;
  filledSize?: number;
  orderId?: number | string;
  explorer?: string;
  receipts?: Receipt[];
  restingOrderIds?: (number | string)[];
  closedSize?: number;
  remainingSize?: number;
  skipped?: string;
  error?: string;
  positionAfter?: { liquidationPx?: number | null } | null;
  exitJobs?: { kind: "stop_loss" | "take_profit"; fires: string }[];
  [key: string]: unknown;
}

export interface Intent {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  preview: Record<string, unknown>;
  status: IntentStatus;
  feeUsd: number;
  result: IntentResult | null;
  createdAt: string;
}

export interface TradePreviewBody {
  market: string;
  side: Side;
  leverage: number;
  marginUsd: number;
  orderType: "market" | "limit";
  limitPx?: number;
  stopLossPx?: number;
  takeProfitPx?: number;
}

export interface TradeParams {
  market: string;
  side: Side;
  leverage: number;
  marginUsd: number;
  stopLossPx?: number | null;
  takeProfitPx?: number | null;
  [key: string]: unknown;
}

export interface TradePreviewResponse {
  intent: Intent;
  risk: RiskVerdict | null;
  requested: TradeParams;
  applied: TradeParams | null;
  changes: string[];
}

// ── Deposits (Aurora Intents) — packages/core/src/auroraDeposits.ts and apps/api/src/mobile.ts ──

export interface AuroraToken {
  assetId: string;
  symbol: string;
  decimals: number;
  blockchain?: string;
  price?: number | null;
  icon?: string | null;
}

export interface AuroraChain {
  chain: string;
  name: string;
  /** The user's own 0x address works on this chain (for the refund). */
  evm: boolean;
  /** Intents Connect: AUSD arrives directly after one signature. Otherwise USDC arrives and the phone signs a swap. */
  connect: boolean;
  tokens: AuroraToken[];
}

export interface AuroraQuote {
  quote: {
    amountIn: string;
    amountInFormatted: string;
    amountInUsd?: string;
    minAmountIn?: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd?: string;
    timeEstimate: number;
    deadline?: string;
  };
}

export type AuroraMode = "connect" | "swap" | "persistent" | "persistent_child";

export type AuroraStatus =
  | "awaiting_signature" | "awaiting_deposit" | "processing" | "incomplete" | "listening"
  | "settled" | "refunded" | "failed" | "expired";

export type AuroraAfterStatus = "funded" | "opened" | "ready" | "needs_conversion" | "converted" | "needs_session" | "failed";

export interface AuroraDeposit {
  id: string;
  mode: AuroraMode;
  originAsset: string;
  originChain: string;
  depositAddress: string | null;
  depositMemo: string | null;
  refundTo: string;
  amountIn: string | null;
  amountOut: string | null;
  status: AuroraStatus;
  /** connect + awaiting_signature: sign `payload_json` verbatim with personal_sign (viem signMessage). */
  signPayload: { standard: string; payload_json: string; payload_bytes_base64?: string } | null;
  depositTx: string | null;
  settledTx: string | null;
  refundTx: string | null;
  refundAmount: string | null;
  refundReason: string | null;
  nextStep: { kind: "fund_perpl"; ausd: number } | { kind: "needs_conversion"; usdc: number } | null;
  error: string | null;
  deadline: string | null;
  createdAt: string;
  afterStatus: AuroraAfterStatus | null;
  afterResult: { error?: string; [key: string]: unknown } | null;
  steps: { label: string; done: boolean }[];
}

export type AuroraAfter = { type: "perpl_open"; market: string; side: Side; leverage: number; usd?: number } | { type: "perpl_deposit" };

export interface AuroraDepositBody {
  assetId: string;
  amount?: string;
  refundTo: string;
  after?: AuroraAfter;
}

// ── Chat ─────────────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: "session"; sessionId: string; skills?: string[] }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; isError: boolean; preview: string }
  | { type: "intent"; intent: Intent }
  | { type: "done"; costUsd: number; chargedUsd: number; turns: number; stopReason: string }
  | { type: "error"; message: string };
