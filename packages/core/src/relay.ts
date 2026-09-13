// Gasless calls that a Mera user signs on the phone: a withdrawal, a USDC to AUSD swap, a revoke.
// The phone signs a one-time delegation to the gas sponsor. Its caveats pin the exact batch of calls (ExactExecutionBatchEnforcer),
// allow one use (LimitedCallsEnforcer) and end in 10 minutes (TimestampEnforcer). The sponsor redeems it, so the wallet makes the
// calls itself and pays no gas. (ExactExecutionEnforcer pins a single call.) The sponsor cannot change a call: any other batch reverts on-chain.
import { randomBytes } from "node:crypto";
import { createExecution, ExecutionMode, getSmartAccountsEnvironment, ROOT_AUTHORITY } from "@metamask/smart-accounts-kit";
import { DelegationManager } from "@metamask/smart-accounts-kit/contracts";
import { createCaveatBuilder, SIGNABLE_DELEGATION_TYPED_DATA } from "@metamask/smart-accounts-kit/utils";
import { createWalletClient, http, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config";
import { sql } from "./db";
import { CHAINS } from "./registry/chains";
import { publicClient, viemChain } from "./wallet";

const env = () => getSmartAccountsEnvironment(CHAINS.monad.chainId!);
const manager = () => env().DelegationManager as Address;
const TTL_SECONDS = 600;

export interface RelayCall { to: Address; data: Hex; value: string; description: string }
interface StoredDelegation { delegate: Address; delegator: Address; authority: Hex; caveats: { enforcer: Address; terms: Hex; args: Hex }[]; salt: Hex }

const sponsor = () => {
  if (!config().SPONSOR_PRIVATE_KEY) throw new Error("The gas sponsor is not set up on this server.");
  return privateKeyToAccount(config().SPONSOR_PRIVATE_KEY as Hex);
};

function typedData(d: StoredDelegation) {
  return {
    domain: { name: "DelegationManager", version: "1", chainId: CHAINS.monad.chainId!, verifyingContract: manager() },
    types: { ...SIGNABLE_DELEGATION_TYPED_DATA },
    primaryType: "Delegation" as const,
    message: { delegate: d.delegate, delegator: d.delegator, authority: d.authority, caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })), salt: BigInt(d.salt).toString() },
  };
}

const executionsOf = (calls: RelayCall[]) => calls.map((c) => createExecution({ target: c.to, callData: c.data, value: BigInt(c.value) }));

/** Create a one-time delegation for exactly these calls. The phone signs the returned typed data. */
export async function prepareRelay(userId: string, calls: RelayCall[]) {
  if (calls.length < 1 || calls.length > 10) throw new Error("A relay takes 1 to 10 calls.");
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  // No function-call scope: its enforcers accept single calls only. The exact batch already pins every target, method and value.
  // One call uses the single-call mode and ExactExecutionEnforcer; two or more use the batch mode and ExactExecutionBatchEnforcer.
  // The kit encodes one execution in the single format, so the mode must follow the number of calls.
  const executions = executionsOf(calls);
  const caveats = (executions.length === 1
    ? createCaveatBuilder(env()).addCaveat("exactExecution", { execution: executions[0]! })
    : createCaveatBuilder(env()).addCaveat("exactExecutionBatch", { executions }))
    .addCaveat("limitedCalls", { limit: 1 })
    .addCaveat("timestamp", { afterThreshold: 0, beforeThreshold: expires })
    .build();
  const d = { delegate: sponsor().address, delegator: userId as Address, authority: ROOT_AUTHORITY as Hex, caveats };
  const delegation: StoredDelegation = { delegate: d.delegate, delegator: d.delegator, authority: d.authority, caveats: d.caveats, salt: `0x${randomBytes(16).toString("hex")}` };
  const id = `rly_${randomBytes(8).toString("hex")}`;
  await sql()`insert into relays (id, user_id, calls, delegation, expires_at) values (${id}, ${userId}, ${sql().json(calls as never)}, ${sql().json(delegation as never)}, ${new Date(expires * 1000)})`;
  const t = typedData(delegation);
  return {
    id, calls, expiresAt: new Date(expires * 1000).toISOString(),
    typedData: { ...t, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...t.types } },
  };
}

/** Check the signature, then the sponsor sends the batch. Each relay runs once. */
export async function sendRelay(userId: string, id: string, signature: string) {
  const [claimed] = await sql()<{ calls: RelayCall[]; delegation: StoredDelegation; expires_at: Date }[]>`
    update relays set status = 'sending' where id = ${id} and user_id = ${userId} and status = 'pending' and expires_at > now() returning calls, delegation, expires_at`;
  if (!claimed) throw new Error("This request is unknown, used or expired. Try again.");
  try {
    const t = typedData(claimed.delegation);
    const signer = await recoverTypedDataAddress({ ...t, message: { ...t.message, salt: BigInt(t.message.salt) }, signature: signature as Hex } as never);
    if (signer.toLowerCase() !== userId) throw new Error("The signature is not from your wallet.");
    const data = DelegationManager.encode.redeemDelegations({
      delegations: [[{ ...claimed.delegation, signature: signature as Hex }]],
      modes: [claimed.calls.length === 1 ? ExecutionMode.SingleDefault : ExecutionMode.BatchDefault],
      executions: [executionsOf(claimed.calls)],
    } as never);
    const relayer = createWalletClient({ account: sponsor(), chain: viemChain("monad"), transport: http() });
    const reader = publicClient("monad");
    // Monad charges the gas limit, so the limit is the estimate plus a small margin.
    const gas = await reader.estimateGas({ account: relayer.account, to: manager(), data });
    const hash = await relayer.sendTransaction({ to: manager(), data, gas: (gas * 12n) / 10n });
    const r = await reader.waitForTransactionReceipt({ hash, timeout: 120_000 });
    await sql()`insert into sponsored_txs (user_id, chain, hash, gas_cost_wei, success) values (${userId}, 'monad', ${hash}, ${(r.gasUsed * r.effectiveGasPrice).toString()}, ${r.status === "success"})`;
    await sql()`update relays set status = ${r.status === "success" ? "done" : "failed"}, hash = ${hash} where id = ${id}`;
    if (r.status !== "success") throw new Error(`The transaction ${hash} reverted. Nothing changed.`);
    return { hash, explorer: `${CHAINS.monad.explorer}/tx/${hash}`, status: "success" as const };
  } catch (err) {
    await sql()`update relays set status = 'failed', error = ${String(err instanceof Error ? err.message : err).slice(0, 400)} where id = ${id} and status = 'sending'`;
    throw err;
  }
}
