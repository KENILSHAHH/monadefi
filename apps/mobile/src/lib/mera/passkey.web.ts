/**
 * Browser passkeys. No WebAuthn client is passed, so Mera uses its built-in browser client (navigator.credentials).
 * This file must not import react-native-passkey or "@category-labs/mera/react-native-webauthn-client".
 * The page origin must be https://<rp id> (here the rp id is EXPO_PUBLIC_RP_ID), else WebAuthn rejects the request.
 */
import type { PasskeyCredentialMetadata } from "@category-labs/mera";
import { assertPasskeyWith, createPasskeyWith, passkeyErrorMessageWith, type PasskeyResult } from "./passkeyCore";

export type { PasskeyResult } from "./passkeyCore";

export const createPasskey = (): Promise<PasskeyResult> => createPasskeyWith(undefined);

export const assertPasskey = (credential?: PasskeyCredentialMetadata | null): Promise<PasskeyResult> =>
  assertPasskeyWith(undefined, credential);

export const passkeyErrorMessage = (e: unknown): string =>
  passkeyErrorMessageWith(e, "Use Safari on iOS 18 or macOS 15 or later with iCloud Keychain, or Chrome with Google Password Manager.");
