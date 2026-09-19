/** Every signature of the app. They all come from the in-memory Mera session: no passkey prompt. */
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseUnits, type Address } from "viem";
import { monad } from "viem/chains";
import { api } from "./api/client";
import type { RelayCall, RelaySendResponse, SessionStatus, TypedDataPayload } from "./api/types";
import { CONTRACTS, config } from "./config";
import { requireAccount } from "./mera/signer";
import { normalizeTypedData } from "./typedData";

export const monadClient = createPublicClient({ chain: monad, transport: http(config.monadRpc) });

export async function signTypedPayload(td: TypedDataPayload): Promise<`0x${string}`> {
  const n = normalizeTypedData(td);
  // The payload shape is checked by the server, so the cast to viem's generic typed data is safe here.
  return requireAccount().signTypedData(n as unknown as Parameters<ReturnType<typeof requireAccount>["signTypedData"]>[0]);
}

export async function signMessage(message: string): Promise<`0x${string}`> {
  return requireAccount().signMessage({ message });
}

/** What the session setup does next for a given server status. */
export type SessionPlan = { upgrade: boolean; grant: boolean };

export function planSession(s: Pick<SessionStatus, "status" | "upgraded">): SessionPlan {
  switch (s.status) {
    case "active":
      return { upgrade: false, grant: false };
    case "needs_upgrade":
      return { upgrade: true, grant: true };
    case "none":
    case "needs_signature":
    case "expired":
      return { upgrade: !s.upgraded, grant: true };
  }
}

export type SetupStep = "upgrade" | "start" | "grant" | "done";

/**
 * Turn on trading: the EIP-7702 upgrade if needed, then one EIP-712 signature per scoped delegation.
 * `onStep` drives the progress view. Returns the upgrade transaction link, if one was sent.
 */
export async function enableTrading(days: number, onStep: (s: SetupStep, detail?: string) => void): Promise<{ upgradeTx: string | null }> {
  const account = requireAccount();
  const status = await api.session.status();
  const plan = planSession(status);
  let upgradeTx: string | null = null;
  if (plan.upgrade) {
    onStep("upgrade");
    // The sponsor sends the authorization, so its nonce is the wallet's own current transaction count.
    const nonce = await monadClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    if (!account.signAuthorization) throw new Error("This signer cannot sign an EIP-7702 authorization.");
    const auth = await account.signAuthorization({ chainId: config.chainId, contractAddress: status.implementation, nonce });
    const r = await api.session.upgrade({ address: auth.address, chainId: auth.chainId, nonce: auth.nonce, r: auth.r, s: auth.s, yParity: auth.yParity ?? 0 });
    upgradeTx = r.explorer;
  }
  if (plan.grant) {
    onStep("start");
    const started = await api.session.start(days);
    for (const p of started.permissions) {
      onStep("grant", p.kind);
      await api.session.grant(p.id, await signTypedPayload(p.typedData));
    }
  }
  onStep("done");
  return { upgradeTx };
}

/** A gasless call batch that the wallet makes itself: prepare, sign the one-time delegation, send. */
export async function relay(calls: RelayCall[]): Promise<RelaySendResponse> {
  const prepared = await api.relay.prepare(calls);
  const signature = await signTypedPayload(prepared.typedData);
  return api.relay.send(prepared.id, signature);
}

const perplWithdrawAbi = [{ type: "function", name: "withdrawCollateral", stateMutability: "nonpayable", inputs: [{ name: "amountCNS", type: "uint256" }], outputs: [] }] as const;

/** Perpl free balance → wallet. Perpl only lets the free balance leave. */
export function perplWithdrawCall(amount: number): RelayCall {
  return {
    to: CONTRACTS.perplExchange,
    data: encodeFunctionData({ abi: perplWithdrawAbi, functionName: "withdrawCollateral", args: [parseUnits(amount.toFixed(6), 6)] }),
    value: "0",
    description: `Withdraw ${amount} AUSD from Perpl to your wallet`,
  };
}

/** Wallet AUSD → another address on Monad. */
export function ausdTransferCall(to: Address, amount: number): RelayCall {
  return {
    to: CONTRACTS.ausd,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, parseUnits(amount.toFixed(6), 6)] }),
    value: "0",
    description: `Send ${amount} AUSD to ${to}`,
  };
}
