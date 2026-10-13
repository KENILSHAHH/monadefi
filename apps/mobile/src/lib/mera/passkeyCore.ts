/**
 * The passkey calls that native and web share. Only the WebAuthn client differs:
 * - native (passkey.ts): Mera's React Native client over react-native-passkey.
 * - web (passkey.web.ts): no client, so Mera uses its built-in browser client (navigator.credentials).
 * The rp id, the PRF salt (Mera's default sha256("mera.prf.salt.v1")) and the derivation are the same on both.
 * So the same passkey gives the same wallet in the app and in the browser.
 */
import {
  createPasskeyWithPrfOutput, getPasskeyPrfOutput, isMeraError, type PasskeyCredentialMetadata, type WebAuthnClient,
} from "@category-labs/mera";
import { config } from "../config";

export interface PasskeyResult {
  prfOutput: Uint8Array;
  credential: PasskeyCredentialMetadata;
}

const client = (c: WebAuthnClient | undefined) => (c ? { webAuthnClient: c } : {});

/**
 * First use: create a discoverable passkey with PRF. One ceremony (a second one only on authenticators without create-time PRF).
 * In a browser, call this first thing in the click handler: Safari needs the user gesture for the ceremony.
 */
export async function createPasskeyWith(webAuthnClient: WebAuthnClient | undefined): Promise<PasskeyResult> {
  const created = await createPasskeyWithPrfOutput({
    rp: { id: config.rpId, name: config.rpName },
    user: { name: `Mona-DeFi ${new Date().toISOString().slice(0, 10)}`, displayName: "Mona-DeFi account" },
    ...client(webAuthnClient),
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
export async function assertPasskeyWith(webAuthnClient: WebAuthnClient | undefined, credential?: PasskeyCredentialMetadata | null): Promise<PasskeyResult> {
  const out = await getPasskeyPrfOutput({
    rpId: config.rpId,
    ...(credential ? { credential } : {}),
    ...client(webAuthnClient),
  });
  const hint = credential?.credentialId === out.credentialId ? credential : { credentialId: out.credentialId };
  return { prfOutput: out.prfOutput, credential: hint };
}

/** A plain sentence for a passkey error. `prfHelp` tells the user which passkey provider to use on this platform. */
export function passkeyErrorMessageWith(e: unknown, prfHelp: string): string {
  if (isMeraError(e)) {
    switch (e.code) {
      case "PRF_UNAVAILABLE":
        return `This passkey provider does not support the PRF extension. ${prfHelp}`;
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
