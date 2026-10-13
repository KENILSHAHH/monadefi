/** Native storage: expo-secure-store (iOS Keychain, Android Keystore). The web build uses storage.web.ts instead. */
import * as SecureStore from "expo-secure-store";
import { makeStorage } from "./storageCore";

export const storage = makeStorage({
  async read(key) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async write(key, value) {
    try {
      if (value === null) await SecureStore.deleteItemAsync(key);
      else await SecureStore.setItemAsync(key, value);
    } catch {
      // Storage is only a cache. A failed write costs one extra challenge signature later.
    }
  },
});
