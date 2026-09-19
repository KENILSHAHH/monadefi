/**
 * The one place that holds the signing key, in memory only. Nothing here is written to storage.
 * The key lives inside the Mera signing session. end() zeroes it.
 */
import type { Secp256k1SigningSession } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import type { LocalAccount } from "viem";

let session: Secp256k1SigningSession | null = null;
let account: LocalAccount | null = null;

export function setSigner(s: Secp256k1SigningSession): LocalAccount {
  endSigner();
  session = s;
  account = toViemAccount(s);
  return account;
}

/** The viem account of the live session. Throws when the app is locked. */
export function requireAccount(): LocalAccount {
  if (!account) throw new Error("Your account is locked. Unlock it with your passkey.");
  return account;
}

export const hasSigner = () => account !== null;

export function endSigner() {
  session?.end();
  session = null;
  account = null;
}
