/** Native (iOS and Android) passkeys: Mera's React Native WebAuthn client. The web build uses passkey.web.ts instead. */
import type { PasskeyCredentialMetadata } from "@category-labs/mera";
import { reactNativeWebAuthnClient } from "@category-labs/mera/react-native-webauthn-client";
import { assertPasskeyWith, createPasskeyWith, passkeyErrorMessageWith, type PasskeyResult } from "./passkeyCore";

export type { PasskeyResult } from "./passkeyCore";

export const createPasskey = (): Promise<PasskeyResult> => createPasskeyWith(reactNativeWebAuthnClient);

export const assertPasskey = (credential?: PasskeyCredentialMetadata | null): Promise<PasskeyResult> =>
  assertPasskeyWith(reactNativeWebAuthnClient, credential);

export const passkeyErrorMessage = (e: unknown): string =>
  passkeyErrorMessageWith(e, "Use iCloud Keychain on iOS 18 or later, or Google Password Manager on Android 9 or later.");
