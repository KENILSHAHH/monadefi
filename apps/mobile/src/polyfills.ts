// Hermes has no crypto.getRandomValues. Mera needs it for WebAuthn challenges and user handles, and viem uses it too.
// This is the polyfill from the Mera React Native guide (https://mera.category.xyz/recipes/use-mera-with-react-native/).
import { getRandomValues } from "expo-crypto";

const g = globalThis as { crypto?: Partial<Crypto> };
if (typeof g.crypto?.getRandomValues !== "function") {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { ...g.crypto, getRandomValues },
  });
}
