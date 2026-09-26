// Deposits from any chain to the user's Monad wallet through Aurora Intents, and what to do when they settle.
//
// Two paths:
// - "connect" (preferred): EVM source chains. The user signs one Intents Connect message with the Monad wallet before the
//   deposit. Aurora bridges to USDC on Monad, then the intermediary swaps USDC to AUSD on Curve and pays the AUSD to the
//   user's address. No signature after the deposit. onSettled gives { kind: "fund_perpl" }.
// - "swap" / "persistent": every other source (Solana, Bitcoin, NEAR, Tron, ...), or no Intents Connect. Aurora delivers
//   USDC on Monad to the user's address. onSettled gives { kind: "needs_conversion" }: the app signs USDC -> AUSD.
//
// pollAuroraDeposits() is the body of a loop. It claims due rows atomically (FOR UPDATE SKIP LOCKED plus a lease), so two
// workers never poll the same row at once.
import { randomUUID } from "node:crypto";
import { createPublicClient, erc20Abi, formatUnits, http, isAddress, parseEventLogs, parseUnits, type Hex } from "viem";
import { z } from "zod";
import {
  AuroraRateLimitError, CHAINS, CONNECT_EVM_SOURCES, MONAD, QuoteMovedError, connectExecutions, connectSubmitDepositHash, connectSubmitSignature,
  createPersistentAddress, encodeErc191Signature, listTokens, persistentDepositStatus, planAusdExecution, quote, status as swapStatus, submitDeposit,
  type AuroraOptions, type ConnectExecution, type PersistentDeposit, type StatusResponse,
} from "./adapters/aurora";
import { HttpError } from "./adapters/http";
import { sql } from "./db";

export type DepositMode = "swap" | "connect" | "persistent" | "persistent_child";
export type DepositStatus =
  | "awaiting_signature" // connect: the user must sign the execution payload
  | "awaiting_deposit" // the user must send funds to deposit_address
  | "processing" // funds seen; Aurora is swapping and delivering
  | "incomplete" // less than the quoted amount arrived; Aurora refunds it after the deadline
  | "listening" // persistent address row: open for any number of deposits
  | "settled" // output delivered on Monad
  | "refunded" // funds sent back to refund_to
  | "failed"
  | "expired";

export const ACTIVE_STATUSES: readonly DepositStatus[] = ["awaiting_signature", "awaiting_deposit", "processing", "incomplete", "listening"];
export const TERMINAL_STATUSES: readonly DepositStatus[] = ["settled", "refunded", "failed", "expired"];

export const AfterAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("perpl_open"), market: z.string().min(1), side: z.enum(["long", "short"]), leverage: z.number().positive().max(100), usd: z.number().positive().optional() }),
  z.object({ type: z.literal("perpl_deposit") }),
]);
export type AfterAction = z.infer<typeof AfterAction>;

export type NextStep =
  | { kind: "fund_perpl"; ausd: number; afterAction: AfterAction | null }
  | { kind: "needs_conversion"; usdc: number; afterAction: AfterAction | null };

export interface AuroraDeposit {
  id: string;
  userId: string;
  mode: DepositMode;
  parentId: string | null;
  originAsset: string;
  originChain: string;
  destinationAsset: string | null;
  depositAddress: string | null;
  depositMemo: string | null;
  recipient: string;
  refundTo: string;
  amountIn: string | null;
  amountOut: string | null;
  status: DepositStatus;
  auroraStatus: string | null;
  quote: Record<string, unknown> | null;
  afterAction: AfterAction | null;
  executionId: string | null;
  intermediary: string | null;
  /** connect + awaiting_signature: sign `payloadJson` verbatim with personal_sign. */
  signPayload: { standard: string; payload_json: string; payload_bytes_base64?: string } | null;
  depositTx: string | null;
  settledTx: string | null;
  refundTx: string | null;
  refundAmount: string | null;
  refundReason: string | null;
  nextStep: NextStep | null;
  error: string | null;
  deadline: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Row {
  id: string; user_id: string; mode: DepositMode; parent_id: string | null; origin_asset: string; origin_chain: string; destination_asset: string | null;
  deposit_address: string | null; deposit_memo: string | null; recipient: string; refund_to: string; amount_in: string | null; amount_out: string | null;
  status: DepositStatus; aurora_status: string | null; quote: Record<string, unknown> | null; after_action: AfterAction | null; execution_id: string | null;
  intermediary: string | null; sign_payload: AuroraDeposit["signPayload"]; deposit_tx: string | null; settled_tx: string | null; refund_tx: string | null;
  refund_amount: string | null; refund_reason: string | null; next_step: NextStep | null; error: string | null; deadline: Date | null; source_tx?: string | null;
  poll_count?: number; created_at: Date; updated_at: Date;
}

export const toDeposit = (r: Row): AuroraDeposit => ({
  id: r.id, userId: r.user_id, mode: r.mode, parentId: r.parent_id, originAsset: r.origin_asset, originChain: r.origin_chain, destinationAsset: r.destination_asset,
  depositAddress: r.deposit_address, depositMemo: r.deposit_memo, recipient: r.recipient, refundTo: r.refund_to, amountIn: r.amount_in, amountOut: r.amount_out,
  status: r.status, auroraStatus: r.aurora_status, quote: r.quote, afterAction: r.after_action, executionId: r.execution_id, intermediary: r.intermediary,
  signPayload: r.status === "awaiting_signature" ? r.sign_payload : null, depositTx: r.deposit_tx, settledTx: r.settled_tx, refundTx: r.refund_tx,
  refundAmount: r.refund_amount, refundReason: r.refund_reason, nextStep: r.next_step, error: r.error, deadline: r.deadline?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

/** USDC and AUSD on Monad both have 6 decimals. */
const STABLE_DECIMALS = 6;
/** How long after the quote deadline a row with no deposit becomes "expired". 1Click refunds late deposits. */
export const EXPIRY_GRACE_MS = 30 * 60_000;
/** Poll intervals. The status endpoint allows 2000 requests per hour per key, so the waits are not short. */
export const POLL_MS: Record<DepositStatus, number> = {
  awaiting_signature: 20_000, awaiting_deposit: 20_000, processing: 8_000, incomplete: 30_000, listening: 60_000,
  settled: 0, refunded: 0, failed: 0, expired: 0,
};

// ---------- pure transitions (no DB, no network) ----------

/** The change that one status answer makes to a row. Fields that are absent do not change. */
export interface Patch {
  status: DepositStatus;
  aurora_status: string;
  amount_in?: string | null;
  amount_out?: string | null;
  settled_tx?: string | null;
  refund_tx?: string | null;
  refund_amount?: string | null;
  refund_reason?: string | null;
  error?: string | null;
  raw?: unknown;
}

type RowLike = Pick<Row, "deadline" | "deposit_tx" | "refund_to" | "amount_in" | "origin_asset">;

const pastDeadline = (deadline: Date | null, now: Date) => !!deadline && now.getTime() > deadline.getTime() + EXPIRY_GRACE_MS;

/** Swap API / 1Click status to a row change. */
export function applySwapStatus(row: RowLike, s: StatusResponse, now = new Date()): Patch {
  const d = s.swapDetails;
  const base = { aurora_status: s.status, raw: s, error: null };
  switch (s.status) {
    case "PENDING_DEPOSIT":
      if (pastDeadline(row.deadline, now)) return { ...base, status: "expired", error: "No deposit arrived before the deadline. Do not send to this address again. A late deposit is refunded to the refund address." };
      return { ...base, status: "awaiting_deposit" };
    case "KNOWN_DEPOSIT_TX":
    case "PROCESSING":
      return { ...base, status: "processing", ...(d?.amountIn ? { amount_in: d.amountIn } : {}) };
    case "INCOMPLETE_DEPOSIT": {
      const got = d?.depositedAmountFormatted ?? d?.depositedAmount ?? "less";
      const need = s.quoteResponse?.quote.amountInFormatted ?? row.amount_in ?? "the quoted amount";
      return { ...base, status: "incomplete", error: `The deposit (${got}) is below the quoted amount (${need}). Send the rest before the deadline, or Aurora refunds the deposit to ${row.refund_to}.` };
    }
    case "SUCCESS":
      return {
        ...base, status: "settled",
        amount_in: d?.amountIn ?? row.amount_in,
        amount_out: d?.amountOut ?? null,
        settled_tx: d?.destinationChainTxHashes?.at(-1)?.hash ?? null,
      };
    case "REFUNDED": {
      // originChainTxHashes holds the user's deposit and the refund. The refund is the one that is not the deposit.
      const refund = (d?.originChainTxHashes ?? []).map((t) => t.hash).filter((h) => h.toLowerCase() !== (row.deposit_tx ?? "").toLowerCase()).at(-1) ?? null;
      return {
        ...base, status: "refunded",
        refund_tx: refund,
        refund_amount: d?.refundedAmountFormatted ?? d?.refundedAmount ?? null,
        refund_reason: d?.refundReason ?? null,
        error: `Aurora refunded the deposit to ${row.refund_to}${d?.refundReason ? `: ${d.refundReason}` : "."}`,
      };
    }
    case "FAILED":
      return { ...base, status: "failed", error: "Aurora reports that the swap failed. Funds that arrived go back to the refund address. Contact support with the deposit address if nothing arrives." };
    default:
      return { ...base, status: "processing", error: `Unknown Aurora status ${String(s.status)}.` };
  }
}

/** Intents Connect execution status to a row change. */
export function applyConnectStatus(row: RowLike, e: ConnectExecution, now = new Date()): Patch {
  const base = { aurora_status: e.status, raw: e, error: null };
  switch (e.status) {
    case "CREATED":
      if (!e.details?.messageSigned) {
        if (pastDeadline(row.deadline, now)) return { ...base, status: "expired", error: "The deposit was not signed in time. Start a new deposit." };
        return { ...base, status: "awaiting_signature" };
      }
      return { ...base, status: "awaiting_deposit" };
    case "DEPOSIT_PENDING":
      if (pastDeadline(row.deadline, now)) return { ...base, status: "expired", error: "No deposit arrived before the deadline. A late deposit is refunded." };
      return { ...base, status: "awaiting_deposit" };
    case "DEPOSIT_PROCESSING":
    case "OPERATION_PENDING":
    case "OPERATION_PROCESSING":
      return { ...base, status: "processing", ...(e.quote?.amountIn ? { amount_in: e.quote.amountIn } : {}) };
    case "SUCCESS":
      return { ...base, status: "settled", settled_tx: findTxHash(e) };
    case "EXPIRED":
      return { ...base, status: "expired", error: "The deposit window closed. Funds sent after it are refunded." };
    case "DEPOSIT_FAILED":
      return { ...base, status: "refunded", refund_reason: "DEPOSIT_FAILED", error: "The deposit failed (for example a wrong amount). Aurora refunds the funds." };
    case "OPERATION_FAILED":
      return { ...base, status: "failed", error: "The swap to AUSD on Monad failed. The USDC stays in your intermediary account on Monad. Sign a recovery to move it to your wallet." };
    default:
      return { ...base, status: "processing", error: `Unknown Intents Connect status ${String(e.status)}.` };
  }
}

/** The destination transaction hash, when the execution response carries one. Field names are not documented. */
function findTxHash(e: ConnectExecution): string | null {
  const seen: string[] = [];
  const walk = (v: unknown, k = "") => {
    if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) && /hash|tx/i.test(k)) seen.push(v);
    else if (v && typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(vv, Array.isArray(v) ? k : kk);
  };
  walk({ details: e.details, transactions: (e as unknown as Record<string, unknown>).transactions });
  return seen.at(-1) ?? null;
}

/**
 * The next step after a deposit settles.
 * - connect: AUSD is already in the user's wallet. The server funds Perpl with the user's delegation.
 * - swap / persistent: USDC is in the user's wallet. The app signs USDC -> AUSD (relay endpoint).
 * For connect the AUSD amount is read from the settlement transaction when there is one; else the guaranteed minimum.
 */
export async function onSettled(row: Pick<Row, "mode" | "amount_out" | "after_action" | "settled_tx" | "recipient" | "quote">, opts: { readAusdReceived?: (tx: string, to: string) => Promise<bigint | null> } = {}): Promise<NextStep> {
  const afterAction = row.after_action ?? null;
  if (row.mode === "connect") {
    let raw: bigint | null = null;
    if (row.settled_tx) raw = await (opts.readAusdReceived ?? ausdReceived)(row.settled_tx, row.recipient).catch(() => null);
    if (raw === null) raw = BigInt(row.amount_out ?? (row.quote?.minAusdOut as string | undefined) ?? "0");
    return { kind: "fund_perpl", ausd: Number(formatUnits(raw, STABLE_DECIMALS)), afterAction };
  }
  return { kind: "needs_conversion", usdc: Number(formatUnits(BigInt(row.amount_out ?? "0"), STABLE_DECIMALS)), afterAction };
}

/** AUSD Transfer amount to `to` in a Monad transaction receipt. */
async function ausdReceived(tx: string, to: string): Promise<bigint | null> {
  const client = createPublicClient({ transport: http(process.env.RPC_MONAD || "https://rpc.monad.xyz") });
  const receipt = await client.getTransactionReceipt({ hash: tx as Hex });
  const logs = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs.filter((l) => l.address.toLowerCase() === MONAD.AUSD.toLowerCase()) });
  const sum = logs.filter((l) => l.args.to.toLowerCase() === to.toLowerCase()).reduce((a, l) => a + l.args.value, 0n);
  return sum > 0n ? sum : null;
}

// ---------- create ----------

export const CreateDepositInput = z.object({
  /** Aurora asset id from the token list, for example nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near. */
  originAsset: z.string().min(3),
  /** Human units of the origin asset ("25.5"). Without it: a persistent address (Aurora must approve the key). */
  amount: z.string().regex(/^\d+(\.\d+)?$/, "amount is a decimal number, for example 25.5").optional(),
  /** The user's address on the origin chain. Refunds go there. */
  refundTo: z.string().min(1),
  afterAction: AfterAction.optional(),
  /** 1Click slippage in bps. Default 100. */
  slippageBps: z.number().int().min(1).max(500).optional(),
  /** Minutes until the quote deadline. Default 30. */
  deadlineMinutes: z.number().int().min(5).max(24 * 60).optional(),
  /** auto: connect when possible, else swap. */
  mode: z.enum(["auto", "connect", "swap", "persistent"]).optional(),
});
export type CreateDepositInput = z.infer<typeof CreateDepositInput>;

/**
 * Starts a deposit for `userId` (the user's lower-case Monad address).
 * connect rows start "awaiting_signature": the app signs `signPayload.payload_json` with personal_sign, then calls submitConnectSignature.
 * swap rows start "awaiting_deposit" with a one-time `depositAddress`. persistent rows are "listening" and never expire.
 */
export async function createDeposit(userId: string, input: CreateDepositInput, o: AuroraOptions = {}): Promise<AuroraDeposit> {
  const a = CreateDepositInput.parse(input);
  if (!isAddress(userId)) throw new Error("The user id must be the Monad wallet address.");
  const recipient = userId.toLowerCase();
  const token = (await listTokens(o)).find((t) => t.assetId === a.originAsset);
  if (!token) throw new Error(`Aurora does not list ${a.originAsset}.`);
  if (token.blockchain === MONAD.chain) throw new Error("The asset is already on Monad. Use a swap, not a deposit.");
  const chain = token.blockchain;
  const evm = CHAINS[chain]?.evm ?? false;
  if (evm && !isAddress(a.refundTo)) throw new Error(`The refund address must be an EVM address on ${CHAINS[chain]?.name ?? chain}.`);
  const mode = a.mode ?? "auto";
  const deadline = new Date(Date.now() + (a.deadlineMinutes ?? 30) * 60_000);
  const common = { id: randomUUID(), user_id: recipient, origin_asset: a.originAsset, origin_chain: chain, recipient, refund_to: a.refundTo, after_action: a.afterAction ?? null };

  if (!a.amount || mode === "persistent") return createPersistent(common, evm, o);
  const amount = parseUnits(a.amount, token.decimals);
  if (amount <= 0n) throw new Error("Enter an amount above zero.");

  const connectable = evm && (CONNECT_EVM_SOURCES as readonly string[]).includes(chain);
  if (mode === "connect" && !connectable) throw new Error(`Intents Connect deposits from ${CHAINS[chain]?.name ?? chain} are not offered. Use mode swap.`);
  let connectError: string | null = null;
  if (connectable && (mode === "connect" || mode === "auto")) {
    const [busy] = await sql()<{ id: string }[]>`select id from aurora_deposits where user_id = ${recipient} and mode = 'connect' and status in ('awaiting_signature', 'awaiting_deposit', 'processing') limit 1`;
    if (busy && mode === "connect") throw new Error(`Another deposit (${busy.id}) is still open. Intents Connect allows one at a time per wallet.`);
    if (!busy) {
      try {
        const plan = await planAusdExecution({ wallet: recipient, originAsset: a.originAsset, amount: amount.toString(), slippageBps: a.slippageBps, deadline: deadline.toISOString(), metadata: { depositId: common.id } }, o);
        const e = plan.execution;
        const q = { connect: e.quote, networkFee: plan.networkFee.toString(), minUsdcOut: plan.minUsdcOut.toString(), minAusdOut: plan.minAusdOut.toString(), steps: e.steps ?? plan.steps };
        const [row] = await sql()<Row[]>`
          insert into aurora_deposits (id, user_id, mode, origin_asset, origin_chain, destination_asset, deposit_address, deposit_memo, recipient, refund_to, amount_in, amount_out,
            status, aurora_status, quote, after_action, execution_id, intermediary, sign_payload, deadline, next_poll_at)
          values (${common.id}, ${recipient}, 'connect', ${a.originAsset}, ${chain}, ${MONAD.AUSD}, ${e.quote?.depositAddress ?? null}, ${e.quote?.depositMemo ?? null}, ${recipient}, ${a.refundTo},
            ${e.quote?.amountIn ?? amount.toString()}, ${plan.minAusdOut.toString()}, 'awaiting_signature', ${e.status}, ${sql().json(q as never)}, ${sql().json(common.after_action as never)},
            ${e.id ?? null}, ${e.details?.intermediaryAddress ?? null}, ${sql().json((e.details?.payload ?? null) as never)}, ${e.quote?.deadline ? new Date(e.quote.deadline) : deadline}, now() + interval '20 seconds')
          returning *`;
        return toDeposit(row!);
      } catch (err) {
        if (mode === "connect" || err instanceof QuoteMovedError) throw err;
        connectError = (err as Error).message;
      }
    }
  }

  const q = await quote({
    dry: false, swapType: "EXACT_INPUT", depositType: "ORIGIN_CHAIN", originAsset: a.originAsset, destinationAsset: MONAD.USDC_ASSET, amount: amount.toString(),
    slippageTolerance: a.slippageBps ?? 100, refundTo: a.refundTo, refundType: "ORIGIN_CHAIN", recipient, recipientType: "DESTINATION_CHAIN", deadline: deadline.toISOString(),
  }, o);
  if (!q.quote.depositAddress) throw new Error("Aurora returned no deposit address.");
  const stored = { ...q, ...(connectError ? { connectError } : {}) };
  const [row] = await sql()<Row[]>`
    insert into aurora_deposits (id, user_id, mode, origin_asset, origin_chain, destination_asset, deposit_address, deposit_memo, recipient, refund_to, amount_in, amount_out,
      status, aurora_status, quote, after_action, deadline, next_poll_at)
    values (${common.id}, ${recipient}, 'swap', ${a.originAsset}, ${chain}, ${MONAD.USDC_ASSET}, ${q.quote.depositAddress}, ${q.quote.depositMemo ?? null}, ${recipient}, ${a.refundTo},
      ${q.quote.amountIn}, ${q.quote.amountOut}, 'awaiting_deposit', 'PENDING_DEPOSIT', ${sql().json(stored as never)}, ${sql().json(common.after_action as never)},
      ${new Date(q.quote.deadline ?? deadline.toISOString())}, now() + interval '20 seconds')
    returning *`;
  return toDeposit(row!);
}

async function createPersistent(common: { id: string; user_id: string; origin_asset: string; origin_chain: string; recipient: string; refund_to: string; after_action: AfterAction | null }, evm: boolean, o: AuroraOptions): Promise<AuroraDeposit> {
  let res;
  try {
    res = await createPersistentAddress({ recipient: common.recipient, sender: common.user_id, depositChain: evm ? "evm" : common.origin_chain, destinationChain: MONAD.chain, destinationAsset: MONAD.USDC_ASSET }, o);
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) throw new Error("Persistent deposit addresses are not enabled for this Aurora key. Enter an amount for a one-time deposit address.");
    throw e;
  }
  const chainKey = evm ? "evm" : common.origin_chain;
  const [existing] = await sql()<Row[]>`select * from aurora_deposits where user_id = ${common.user_id} and mode = 'persistent' and deposit_address = ${res.depositAddress} limit 1`;
  if (existing) return toDeposit(existing);
  const [row] = await sql()<Row[]>`
    insert into aurora_deposits (id, user_id, mode, origin_asset, origin_chain, destination_asset, deposit_address, deposit_memo, recipient, refund_to, status, aurora_status, quote, after_action, next_poll_at)
    values (${common.id}, ${common.user_id}, 'persistent', ${common.origin_asset}, ${chainKey}, ${MONAD.USDC_ASSET}, ${res.depositAddress}, ${res.memo ?? null}, ${common.recipient}, ${common.refund_to},
      'listening', 'LISTENING', ${sql().json(res as never)}, ${sql().json(common.after_action as never)}, now() + interval '60 seconds')
    returning *`;
  return toDeposit(row!);
}

// ---------- user actions ----------

export async function listDeposits(userId: string, limit = 50): Promise<AuroraDeposit[]> {
  const rows = await sql()<Row[]>`select * from aurora_deposits where user_id = ${userId.toLowerCase()} order by created_at desc limit ${limit}`;
  return rows.map(toDeposit);
}

export async function getDeposit(userId: string, id: string): Promise<AuroraDeposit | null> {
  const [row] = await sql()<Row[]>`select * from aurora_deposits where id = ${id} and user_id = ${userId.toLowerCase()}`;
  return row ? toDeposit(row) : null;
}

/** The app sends the personal_sign result over `signPayload.payload_json`. The row moves to awaiting_deposit. */
export async function submitConnectSignature(userId: string, id: string, signatureHex: string, o: AuroraOptions = {}): Promise<AuroraDeposit> {
  const [row] = await sql()<Row[]>`select * from aurora_deposits where id = ${id} and user_id = ${userId.toLowerCase()}`;
  if (!row) throw new Error("No such deposit.");
  if (row.mode !== "connect" || row.status !== "awaiting_signature" || !row.execution_id) throw new Error(`The deposit is ${row.status}; it needs no signature.`);
  await connectSubmitSignature(row.recipient, { executionId: row.execution_id, signature: encodeErc191Signature(signatureHex) }, o);
  const [updated] = await sql()<Row[]>`update aurora_deposits set status = 'awaiting_deposit', next_poll_at = now() + interval '15 seconds', error = null, updated_at = now()
    where id = ${id} and status = 'awaiting_signature' returning *`;
  return toDeposit(updated ?? row);
}

/** Optional: the app reports the origin transaction so Aurora checks it sooner. */
export async function submitDepositTx(userId: string, id: string, txHash: string, o: AuroraOptions = {}): Promise<AuroraDeposit> {
  const [row] = await sql()<Row[]>`select * from aurora_deposits where id = ${id} and user_id = ${userId.toLowerCase()}`;
  if (!row) throw new Error("No such deposit.");
  if (!row.deposit_address || row.mode === "persistent") throw new Error("This deposit takes no transaction hash.");
  if (row.mode === "connect") await connectSubmitDepositHash({ depositAddress: row.deposit_address, txHash, ...(row.deposit_memo ? { memo: row.deposit_memo } : {}) }, o);
  else await submitDeposit({ txHash, depositAddress: row.deposit_address, ...(row.deposit_memo ? { memo: row.deposit_memo } : {}) }, o);
  const [updated] = await sql()<Row[]>`update aurora_deposits set deposit_tx = ${txHash}, next_poll_at = now(), updated_at = now() where id = ${id} returning *`;
  return toDeposit(updated!);
}

// ---------- poller ----------

export interface PollResult {
  polled: number;
  changed: { id: string; from: DepositStatus; to: DepositStatus }[];
  /** Rows that became settled in this pass, with the step the caller must run next. */
  settled: { deposit: AuroraDeposit; next: NextStep }[];
  rateLimitedMs: number | null;
}

/**
 * One pass of the deposit poller. Run it every few seconds from one or more workers.
 * It claims at most `limit` due rows with a 2-minute lease, polls each, writes the change, and releases the lease.
 * On 429 it stops, and the remaining claimed rows wait for Retry-After.
 */
export async function pollAuroraDeposits(opts: { workerId?: string; limit?: number; userId?: string; aurora?: AuroraOptions; now?: () => Date; readAusdReceived?: (tx: string, to: string) => Promise<bigint | null> } = {}): Promise<PollResult> {
  const worker = opts.workerId ?? `aurora-${process.pid}-${randomUUID().slice(0, 8)}`;
  const o = opts.aurora ?? {};
  const now = opts.now ?? (() => new Date());
  const claimed = await sql()<Row[]>`
    update aurora_deposits set claimed_by = ${worker}, claimed_until = now() + interval '2 minutes'
    where id in (
      select id from aurora_deposits
      where status in ('awaiting_signature', 'awaiting_deposit', 'processing', 'incomplete', 'listening')
        and next_poll_at <= now() and (claimed_until is null or claimed_until < now())
        ${opts.userId ? sql()`and user_id = ${opts.userId.toLowerCase()}` : sql()``}
      order by next_poll_at limit ${opts.limit ?? 5}
      for update skip locked)
    returning *`;
  const result: PollResult = { polled: 0, changed: [], settled: [], rateLimitedMs: null };
  for (let i = 0; i < claimed.length; i++) {
    const row = claimed[i]!;
    try {
      if (row.mode === "persistent") {
        await pollPersistent(row, worker, o, result, opts.readAusdReceived);
        result.polled++;
        continue;
      }
      const patch = row.mode === "connect"
        ? await connectExecutions(row.recipient, { id: row.execution_id ?? undefined }, o).then((list) => {
            const e = list.find((x) => x.id === row.execution_id) ?? list[0];
            if (!e) throw new Error("Intents Connect does not know this execution.");
            return applyConnectStatus(row, e, now());
          })
        : applySwapStatus(row, await swapStatus(row.deposit_address!, row.deposit_memo, o), now());
      result.polled++;
      await writePatch(row, patch, worker, result, opts.readAusdReceived);
    } catch (e) {
      if (e instanceof AuroraRateLimitError) {
        result.rateLimitedMs = e.retryAfterMs;
        const ids = claimed.slice(i).map((r) => r.id);
        await sql()`update aurora_deposits set claimed_by = null, claimed_until = null, next_poll_at = now() + ${`${Math.ceil(e.retryAfterMs / 1000) + 1} seconds`}::interval where id = any(${ids}) and claimed_by = ${worker}`;
        break;
      }
      // A network or server error is not a deposit failure. Keep the status, show the reason, and back off.
      await sql()`update aurora_deposits set claimed_by = null, claimed_until = null, poll_count = poll_count + 1,
        error = ${`Status check failed, retrying: ${(e as Error).message.slice(0, 300)}`}, next_poll_at = now() + interval '60 seconds', updated_at = now()
        where id = ${row.id} and claimed_by = ${worker}`;
    }
  }
  return result;
}

async function writePatch(row: Row, p: Patch, worker: string, result: PollResult, readAusdReceived?: (tx: string, to: string) => Promise<bigint | null>) {
  const merged: Row = {
    ...row, status: p.status, aurora_status: p.aurora_status,
    amount_in: p.amount_in !== undefined ? p.amount_in : row.amount_in,
    amount_out: p.amount_out !== undefined && p.amount_out !== null ? p.amount_out : row.amount_out,
    settled_tx: p.settled_tx ?? row.settled_tx, refund_tx: p.refund_tx ?? row.refund_tx,
    refund_amount: p.refund_amount ?? row.refund_amount, refund_reason: p.refund_reason ?? row.refund_reason,
    error: p.error !== undefined ? p.error : row.error,
  };
  const settledNow = p.status === "settled" && row.status !== "settled";
  const next = settledNow ? await onSettled(merged, { readAusdReceived }) : row.next_step;
  const wait = POLL_MS[p.status];
  const [updated] = await sql()<Row[]>`
    update aurora_deposits set status = ${merged.status}, aurora_status = ${merged.aurora_status}, amount_in = ${merged.amount_in}, amount_out = ${merged.amount_out},
      settled_tx = ${merged.settled_tx}, refund_tx = ${merged.refund_tx}, refund_amount = ${merged.refund_amount}, refund_reason = ${merged.refund_reason},
      error = ${merged.error}, raw = ${sql().json((p.raw ?? null) as never)}, next_step = ${sql().json((next ?? null) as never)},
      settled_at = ${settledNow ? new Date() : null}, poll_count = poll_count + 1, claimed_by = null, claimed_until = null,
      next_poll_at = now() + ${`${Math.max(1, Math.round(wait / 1000))} seconds`}::interval, updated_at = now()
    where id = ${row.id} and claimed_by = ${worker}
    returning *`;
  if (!updated) return;
  if (row.status !== updated.status) result.changed.push({ id: row.id, from: row.status, to: updated.status });
  if (settledNow && next) result.settled.push({ deposit: toDeposit(updated), next });
}

/** A persistent address stays "listening". Each payout or failure Aurora reports becomes one child row. */
async function pollPersistent(row: Row, worker: string, o: AuroraOptions, result: PollResult, readAusdReceived?: (tx: string, to: string) => Promise<bigint | null>) {
  const [success, failed] = await Promise.all([
    persistentDepositStatus({ address: row.deposit_address!, type: "success" }, o),
    persistentDepositStatus({ address: row.deposit_address!, type: "failed" }, o),
  ]);
  const add = async (d: PersistentDeposit, ok: boolean) => {
    const child: Row = {
      ...row, id: randomUUID(), mode: "persistent_child", parent_id: row.id, status: ok ? "settled" : "failed", aurora_status: ok ? "SUCCESS" : "FAILED",
      amount_in: null, amount_out: ok ? d.amount : null, settled_tx: ok ? d.tx_hash : null, error: ok ? null : "Aurora could not pay this deposit out. Contact support with the deposit address.",
      source_tx: d.tx_hash, next_step: null,
    };
    const next = ok ? await onSettled(child, { readAusdReceived }) : null;
    const [ins] = await sql()<Row[]>`
      insert into aurora_deposits (id, user_id, mode, parent_id, source_tx, origin_asset, origin_chain, destination_asset, deposit_address, deposit_memo, recipient, refund_to,
        amount_out, status, aurora_status, settled_tx, error, after_action, next_step, raw, settled_at, next_poll_at)
      values (${child.id}, ${row.user_id}, 'persistent_child', ${row.id}, ${d.tx_hash}, ${d.asset_id ?? row.origin_asset}, ${row.origin_chain}, ${row.destination_asset}, ${row.deposit_address},
        ${row.deposit_memo}, ${row.recipient}, ${row.refund_to}, ${child.amount_out}, ${child.status}, ${child.aurora_status}, ${child.settled_tx}, ${child.error},
        ${sql().json(row.after_action as never)}, ${sql().json(next as never)}, ${sql().json(d as never)}, ${ok ? new Date() : null}, now())
      on conflict do nothing returning *`;
    if (ins && next) result.settled.push({ deposit: toDeposit(ins), next });
  };
  for (const d of success) await add(d, true);
  for (const d of failed) await add(d, false);
  await sql()`update aurora_deposits set claimed_by = null, claimed_until = null, poll_count = poll_count + 1, error = null, next_poll_at = now() + interval '60 seconds', updated_at = now()
    where id = ${row.id} and claimed_by = ${worker}`;
}
