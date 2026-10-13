/** The app's one session manager, wired to the API, the in-memory Mera key and storage. See manager.ts. */
import { useSyncExternalStore } from "react";
import type { Address } from "viem";
import { api } from "../api/client";
import { hasSigner, requireAccount } from "../mera/signer";
import { storage } from "../storage";
import { monadClient, relay, signTypedPayload } from "../wallet";
import { createSessionManager, within, type EnsureResult } from "./manager";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const sessionManager = createSessionManager({
  status: api.session.status,
  upgrade: api.session.upgrade,
  start: api.session.start,
  grant: api.session.grant,
  revoke: api.session.revoke,
  relay,
  address: () => (hasSigner() ? requireAccount().address : null),
  pendingNonce: (address) => monadClient.getTransactionCount({ address: address as Address, blockTag: "pending" }),
  async signAuthorization({ chainId, contractAddress, nonce }) {
    const account = requireAccount();
    if (!account.signAuthorization) throw new Error("This signer cannot sign an EIP-7702 authorization.");
    const a = await account.signAuthorization({ chainId, contractAddress: contractAddress as Address, nonce });
    return { address: a.address, chainId: a.chainId, nonce: a.nonce, r: a.r, s: a.s, yParity: a.yParity ?? 0 };
  },
  signTypedData: signTypedPayload,
  readRevoked: storage.getTradingRevoked,
  writeRevoked: storage.setTradingRevoked,
  sleep,
  now: () => Date.now(),
});

/** Make sure trading is on. Fast when it is. Never throws. */
export const ensureSession = (opts?: { upgradeOnly?: boolean }) => sessionManager.ensure(opts);

/**
 * For a user action (send a prompt, confirm an order): wait for the setup at most `ms`, then go on.
 * If the session is still not active, the server answers with a clear error and the app retries once.
 */
export const ensureSessionBefore = (ms = 12_000): Promise<EnsureResult | null> => within(sessionManager.ensure(), ms, sleep);

export function useTradingSession() {
  return useSyncExternalStore(sessionManager.subscribe, sessionManager.getSnapshot, sessionManager.getSnapshot);
}

export { isSessionFailure, isSessionConflict } from "./manager";
