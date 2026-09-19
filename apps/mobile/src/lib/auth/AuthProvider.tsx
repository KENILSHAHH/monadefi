import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { AppState } from "react-native";
import { api, ApiError, errorMessage, setAuthHooks } from "../api/client";
import { config } from "../config";
import { deriveAccount } from "../mera/derive";
import { assertPasskey, createPasskey, passkeyErrorMessage } from "../mera/passkey";
import { endSigner, hasSigner, setSigner } from "../mera/signer";
import { storage } from "../storage";
import { signMessage } from "../wallet";
import { authReducer, canReuseToken, initialAuthState, shouldLock, type AuthState, type PasskeyMode } from "./machine";

interface AuthContextValue {
  state: AuthState;
  /** Run the one passkey ceremony of this app session. */
  unlock: (mode: PasskeyMode) => Promise<void>;
  retry: () => void;
  lock: () => void;
  signOut: () => Promise<void>;
  /** The current API token, for the streaming chat request. */
  token: () => string | null;
  /** Sign a new challenge after a 401. No passkey prompt. */
  renewToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, initialAuthState);
  const queryClient = useQueryClient();
  const tokenRef = useRef<string | null>(null);
  const addressRef = useRef<string | null>(null);
  const renewing = useRef<Promise<string | null> | null>(null);
  const busy = useRef(false);

  /** Challenge → EIP-191 signature from the session → verify. Stores only the token. */
  const signIn = useCallback(async (address: string) => {
    const challenge = await api.auth.challenge(address);
    const signature = await signMessage(challenge.message);
    const v = await api.auth.verify({ address, nonce: challenge.nonce, signature });
    tokenRef.current = v.token;
    await storage.setToken(v.token);
    return v.agentAddress ?? null;
  }, []);

  const renewToken = useCallback(async () => {
    const address = addressRef.current;
    if (!address || !hasSigner()) return null;
    renewing.current ??= signIn(address)
      .then(() => tokenRef.current)
      .catch(() => null)
      .finally(() => {
        renewing.current = null;
      });
    return renewing.current;
  }, [signIn]);

  useEffect(() => {
    setAuthHooks({ getToken: () => tokenRef.current, renew: renewToken });
  }, [renewToken]);

  /** Use the stored token if it matches the derived address and the server accepts it; else sign a new challenge. */
  const authenticate = useCallback(
    async (address: string) => {
      try {
        const stored = { token: await storage.getToken(), address: await storage.getAddress() };
        let agentAddress: string | null = null;
        if (canReuseToken(stored, address)) {
          tokenRef.current = stored.token;
          try {
            // GET /session also checks the token. A 401 here makes the client sign a new challenge by itself.
            agentAddress = (await api.session.status()).agentAddress ?? null;
          } catch (e) {
            if (!(e instanceof ApiError) || e.status === 401 || e.status === 0) throw e;
            // The token works but /session is not live: keep going.
          }
        } else {
          agentAddress = await signIn(address);
        }
        await storage.setAddress(address);
        dispatch({ type: "AUTH_OK", agentAddress });
      } catch (e) {
        dispatch({ type: "AUTH_FAILED", error: errorMessage(e, "Sign-in with the Mona-DeFi server failed.") });
      }
    },
    [signIn],
  );

  const unlock = useCallback(
    async (mode: PasskeyMode) => {
      if (busy.current) return;
      busy.current = true;
      dispatch({ type: "START", mode });
      try {
        let result;
        try {
          result = mode === "create" ? await createPasskey() : await assertPasskey(await storage.getCredential());
        } catch (e) {
          dispatch({ type: "PASSKEY_FAILED", error: passkeyErrorMessage(e) });
          return;
        }
        dispatch({ type: "PASSKEY_OK" });
        let address: string;
        try {
          const derived = await deriveAccount(result.prfOutput);
          setSigner(derived.session);
          address = derived.address;
        } catch (e) {
          dispatch({ type: "PASSKEY_FAILED", error: errorMessage(e, "The account could not be derived from the passkey.") });
          return;
        }
        addressRef.current = address;
        await storage.setCredential(result.credential);
        dispatch({ type: "DERIVED", address });
        await authenticate(address);
      } finally {
        busy.current = false;
      }
    },
    [authenticate],
  );

  const retry = useCallback(() => {
    if (state.tag !== "authError") return;
    dispatch({ type: "RETRY" });
    void authenticate(state.address);
  }, [state, authenticate]);

  const lock = useCallback(() => {
    endSigner();
    tokenRef.current = null;
    queryClient.clear();
    dispatch({ type: "LOCK" });
  }, [queryClient]);

  const signOut = useCallback(async () => {
    endSigner();
    tokenRef.current = null;
    addressRef.current = null;
    queryClient.clear();
    await storage.clearAll();
    dispatch({ type: "SIGN_OUT" });
  }, [queryClient]);

  // Boot: read only the hints. The passkey ceremony starts from the lock screen.
  useEffect(() => {
    void (async () => {
      const [credential, address] = await Promise.all([storage.getCredential(), storage.getAddress()]);
      dispatch({ type: "BOOTED", hasPasskeyHint: credential !== null || address !== null, address });
    })();
  }, []);

  // End the key after a long stay in the background. JS timers stop in the background, so the check runs on return.
  const backgroundAt = useRef<number | null>(null);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background") backgroundAt.current = Date.now();
      if (next === "active") {
        if (shouldLock(backgroundAt.current, Date.now(), config.lockAfterMs) && hasSigner()) lock();
        backgroundAt.current = null;
      }
    });
    return () => sub.remove();
  }, [lock]);

  const value = useMemo<AuthContextValue>(
    () => ({ state, unlock, retry, lock, signOut, token: () => tokenRef.current, renewToken }),
    [state, unlock, retry, lock, signOut, renewToken],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}

/** The address of the unlocked account. Only for screens behind the auth gate. */
export function useAddress(): string {
  const { state } = useAuth();
  return state.tag === "ready" || state.tag === "authenticating" || state.tag === "authError" ? state.address : "";
}
