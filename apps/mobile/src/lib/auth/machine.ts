/**
 * The account and sign-in state machine. Pure: no React, no I/O, so the tests can drive it.
 *
 *   booting ──BOOTED──▶ signedOut (no passkey hint) | locked (a hint from a previous launch)
 *   signedOut | locked ──START──▶ passkey ──PASSKEY_OK──▶ deriving ──DERIVED──▶ authenticating
 *   authenticating ──AUTH_OK──▶ ready          authenticating ──AUTH_FAILED──▶ authError ──RETRY──▶ authenticating
 *   ready ──UNAUTHORIZED──▶ authenticating     (the key is in memory: a new challenge needs no passkey prompt)
 *   any unlocked state ──LOCK──▶ locked        (background timeout: the key is zeroed)
 *   any state ──SIGN_OUT──▶ signedOut
 *
 * The passkey prompt happens only in the `passkey` state, so one app start means one ceremony.
 */

export type PasskeyMode = "create" | "signin";

export type AuthState =
  | { tag: "booting" }
  | { tag: "signedOut"; error?: string }
  | { tag: "locked"; address: string | null; reason: "start" | "timeout"; error?: string }
  | { tag: "passkey"; mode: PasskeyMode; address: string | null }
  | { tag: "deriving"; mode: PasskeyMode }
  | { tag: "authenticating"; address: string }
  | { tag: "authError"; address: string; error: string }
  | { tag: "ready"; address: string; agentAddress: string | null };

export type AuthEvent =
  | { type: "BOOTED"; hasPasskeyHint: boolean; address: string | null }
  | { type: "START"; mode: PasskeyMode }
  | { type: "PASSKEY_OK" }
  | { type: "PASSKEY_FAILED"; error: string }
  | { type: "DERIVED"; address: string }
  | { type: "AUTH_OK"; agentAddress: string | null }
  | { type: "AUTH_FAILED"; error: string }
  | { type: "RETRY" }
  | { type: "UNAUTHORIZED" }
  | { type: "LOCK" }
  | { type: "SIGN_OUT" };

export const initialAuthState: AuthState = { tag: "booting" };

/** True in the states where the signing key is in memory. */
export const isUnlocked = (s: AuthState) => s.tag === "authenticating" || s.tag === "authError" || s.tag === "ready";

export function authReducer(state: AuthState, event: AuthEvent): AuthState {
  if (event.type === "SIGN_OUT") return { tag: "signedOut" };

  switch (state.tag) {
    case "booting":
      if (event.type === "BOOTED")
        return event.hasPasskeyHint ? { tag: "locked", address: event.address, reason: "start" } : { tag: "signedOut" };
      return state;

    case "signedOut":
      // A fresh device: "Sign in" asks for any Mona-DeFi passkey; "Create" makes a new one.
      if (event.type === "START") return { tag: "passkey", mode: event.mode, address: null };
      return state;

    case "locked":
      if (event.type === "START") return { tag: "passkey", mode: event.mode, address: state.address };
      return state;

    case "passkey":
      if (event.type === "PASSKEY_OK") return { tag: "deriving", mode: state.mode };
      if (event.type === "PASSKEY_FAILED")
        return state.address !== null
          ? { tag: "locked", address: state.address, reason: "start", error: event.error }
          : { tag: "signedOut", error: event.error };
      return state;

    case "deriving":
      if (event.type === "DERIVED") return { tag: "authenticating", address: event.address };
      if (event.type === "PASSKEY_FAILED") return { tag: "signedOut", error: event.error };
      return state;

    case "authenticating":
      if (event.type === "AUTH_OK") return { tag: "ready", address: state.address, agentAddress: event.agentAddress };
      if (event.type === "AUTH_FAILED") return { tag: "authError", address: state.address, error: event.error };
      if (event.type === "LOCK") return { tag: "locked", address: state.address, reason: "timeout" };
      return state;

    case "authError":
      if (event.type === "RETRY") return { tag: "authenticating", address: state.address };
      if (event.type === "LOCK") return { tag: "locked", address: state.address, reason: "timeout" };
      return state;

    case "ready":
      if (event.type === "UNAUTHORIZED") return { tag: "authenticating", address: state.address };
      if (event.type === "LOCK") return { tag: "locked", address: state.address, reason: "timeout" };
      return state;
  }
}

/**
 * Should the app end the key after a stay in the background?
 * `backgroundAt` is the time the app left the foreground, or null if it never did.
 */
export function shouldLock(backgroundAt: number | null, now: number, lockAfterMs: number): boolean {
  return backgroundAt !== null && now - backgroundAt >= lockAfterMs;
}

/**
 * The stored token is reusable only if it belongs to the address that the passkey derived now.
 * Storage is untrusted: a token for another address is ignored and a new challenge is signed.
 */
export function canReuseToken(stored: { token: string | null; address: string | null }, derivedAddress: string): boolean {
  return Boolean(stored.token) && stored.address !== null && stored.address.toLowerCase() === derivedAddress.toLowerCase();
}
