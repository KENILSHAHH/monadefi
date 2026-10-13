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

/** What the session setup does next for a given server status. The automatic setup is in session/manager.ts. */
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
