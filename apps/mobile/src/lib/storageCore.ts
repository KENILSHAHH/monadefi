/**
 * Local storage of the app. Everything here is optional and untrusted: the app works when it is empty
 * (a fresh device, or after the user clears it). No key, seed or PRF output is ever written.
 *
 * - token: the API session token. Lost → the app signs a new challenge (no passkey prompt).
 * - address: the last derived address, only to label the lock screen and to match the token.
 * - credential: the passkey credential id, a hint so the platform shows the right passkey first.
 * - tradingRevoked: "1" after the user revoked trading access. The app then does not turn it on again by itself.
 *
 * The backend differs per platform: storage.ts (native, expo-secure-store) and storage.web.ts (browser, localStorage).
 */
import type { PasskeyCredentialMetadata } from "@category-labs/mera";

// The keys were renamed from the old product prefix. The app does not migrate the old entries on purpose.
// An update loses the cached token and hints once: the app signs a new challenge, and the platform still offers the passkey.
const KEYS = { token: "monadefi.token", address: "monadefi.address", credential: "monadefi.credential", tradingRevoked: "monadefi.tradingRevoked" } as const;

export interface StorageBackend {
  /** Returns null when the value is missing or the read fails. */
  read(key: string): Promise<string | null>;
  /** null deletes the value. A failed write is ignored: storage is only a cache. */
  write(key: string, value: string | null): Promise<void>;
}

export function parseCredential(raw: string | null): PasskeyCredentialMetadata | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PasskeyCredentialMetadata>;
    return typeof v.credentialId === "string" && v.credentialId ? { credentialId: v.credentialId, ...(Array.isArray(v.transports) ? { transports: v.transports } : {}) } : null;
  } catch {
    return null;
  }
}

export function makeStorage({ read, write }: StorageBackend) {
  return {
    getToken: () => read(KEYS.token),
    setToken: (t: string | null) => write(KEYS.token, t),
    getAddress: () => read(KEYS.address),
    setAddress: (a: string | null) => write(KEYS.address, a),
    getCredential: async (): Promise<PasskeyCredentialMetadata | null> => parseCredential(await read(KEYS.credential)),
    setCredential: (c: PasskeyCredentialMetadata | null) => write(KEYS.credential, c ? JSON.stringify(c) : null),
    getTradingRevoked: async () => (await read(KEYS.tradingRevoked)) === "1",
    setTradingRevoked: (v: boolean) => write(KEYS.tradingRevoked, v ? "1" : null),
    async clearAll() {
      await Promise.all(Object.values(KEYS).map((k) => write(k, null)));
    },
  };
}
