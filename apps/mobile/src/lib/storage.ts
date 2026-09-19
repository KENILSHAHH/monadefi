/**
 * Local storage of the app. Everything here is optional and untrusted: the app works when it is empty
 * (a fresh device, or after the user clears it). No key, seed or PRF output is ever written.
 *
 * - token: the API session token. Lost → the app signs a new challenge (no passkey prompt).
 * - address: the last derived address, only to label the lock screen and to match the token.
 * - credential: the passkey credential id, a hint so the platform shows the right passkey first.
 */
import type { PasskeyCredentialMetadata } from "@category-labs/mera";
import * as SecureStore from "expo-secure-store";

// The keys were renamed from the old product prefix. The app does not migrate the old entries on purpose.
// An update loses the cached token and hints once: the app signs a new challenge, and the platform still offers the passkey.
const KEYS = { token: "monadefi.token", address: "monadefi.address", credential: "monadefi.credential" } as const;

async function read(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function write(key: string, value: string | null) {
  try {
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value);
  } catch {
    // Storage is only a cache. A failed write costs one extra challenge signature later.
  }
}

export const storage = {
  getToken: () => read(KEYS.token),
  setToken: (t: string | null) => write(KEYS.token, t),
  getAddress: () => read(KEYS.address),
  setAddress: (a: string | null) => write(KEYS.address, a),
  async getCredential(): Promise<PasskeyCredentialMetadata | null> {
    const raw = await read(KEYS.credential);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Partial<PasskeyCredentialMetadata>;
      return typeof v.credentialId === "string" && v.credentialId ? { credentialId: v.credentialId, ...(Array.isArray(v.transports) ? { transports: v.transports } : {}) } : null;
    } catch {
      return null;
    }
  },
  setCredential: (c: PasskeyCredentialMetadata | null) => write(KEYS.credential, c ? JSON.stringify(c) : null),
  async clearAll() {
    await Promise.all(Object.values(KEYS).map((k) => write(k, null)));
  },
};
