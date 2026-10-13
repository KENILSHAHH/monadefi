/**
 * Browser storage: localStorage. expo-secure-store has no web implementation.
 * Only untrusted hints go here (the token, the address, the credential id). The key stays in memory only.
 * localStorage can be missing or blocked (private mode, storage cleared by Safari): then every call is a no-op.
 */
import { makeStorage } from "./storageCore";

function local(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export const storage = makeStorage({
  async read(key) {
    try {
      return local()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  async write(key, value) {
    try {
      const ls = local();
      if (!ls) return;
      if (value === null) ls.removeItem(key);
      else ls.setItem(key, value);
    } catch {
      // Quota or privacy errors: storage is only a cache.
    }
  },
});
