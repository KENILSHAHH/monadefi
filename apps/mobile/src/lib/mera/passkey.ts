import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, isMeraError, type PasskeyCredentialMetadata } from "@category-labs/mera";
import { reactNativeWebAuthnClient } from "@category-labs/mera/react-native-webauthn-client";
import { config } from "../config";

export interface PasskeyResult {
  prfOutput: Uint8Array;
  credential: PasskeyCredentialMetadata;
}

/** First use: create a discoverable passkey with PRF. One ceremony (a second one only on authenticators without create-time PRF). */
export async function createPasskey(): Promise<PasskeyResult> {
  const created = await createPasskeyWithPrfOutput({
    rp: { id: config.rpId, name: config.rpName },
    user: { name: `Mona-DeFi ${new Date().toISOString().slice(0, 10)}`, displayName: "Mona-DeFi account" },
    webAuthnClient: reactNativeWebAuthnClient,
  });
  return {
    prfOutput: created.prfOutput,
    credential: { credentialId: created.credentialId, ...(created.transports ? { transports: created.transports } : {}) },
  };
}

/**
 * Later: assert the passkey and get the same PRF output. `credential` is only a hint from local storage. Without it
 * (a fresh device, or cleared storage) the platform offers every Mona-DeFi passkey, which is the stateless path.
 */
export async function assertPasskey(credential?: PasskeyCredentialMetadata | null): Promise<PasskeyResult> {
  const out = await getPasskeyPrfOutput({
    rpId: config.rpId,
    ...(credential ? { credential } : {}),
    webAuthnClient: reactNativeWebAuthnClient,
  });
  const hint = credential?.credentialId === out.credentialId ? credential : { credentialId: out.credentialId };
  return { prfOutput: out.prfOutput, credential: hint };
}

/** A plain sentence for a passkey error. */
export function passkeyErrorMessage(e: unknown): string {
  if (isMeraError(e)) {
    switch (e.code) {
      case "PRF_UNAVAILABLE":
        return "This passkey provider does not support the PRF extension. Use iCloud Keychain on iOS 18 or later, or Google Password Manager on Android 9 or later.";
      case "PASSKEY_OPERATION_FAILED":
        return "The passkey request was cancelled or failed. Try again.";
      case "CRYPTO_UNAVAILABLE":
        return "Secure random numbers are not available on this device.";
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : "The passkey request failed.";
}
