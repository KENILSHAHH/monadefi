import { authReducer, canReuseToken, initialAuthState, isUnlocked, shouldLock, type AuthEvent, type AuthState } from "../src/lib/auth/machine";
import { planSession } from "../src/lib/wallet";

const run = (events: AuthEvent[], from: AuthState = initialAuthState) => events.reduce(authReducer, from);
const ADDR = "0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb";

describe("auth state machine", () => {
  it("first launch: no hint → signed out → create → one passkey ceremony → ready", () => {
    const s1 = run([{ type: "BOOTED", hasPasskeyHint: false, address: null }]);
    expect(s1).toEqual({ tag: "signedOut" });
    const s2 = authReducer(s1, { type: "START", mode: "create" });
    expect(s2).toEqual({ tag: "passkey", mode: "create", address: null });
    const s3 = run([{ type: "PASSKEY_OK" }, { type: "DERIVED", address: ADDR }, { type: "AUTH_OK", agentAddress: "0xagent" }], s2);
    expect(s3).toEqual({ tag: "ready", address: ADDR, agentAddress: "0xagent" });
  });

  it("later launch: a hint → locked (the screen starts the assertion)", () => {
    expect(run([{ type: "BOOTED", hasPasskeyHint: true, address: ADDR }])).toEqual({ tag: "locked", address: ADDR, reason: "start" });
  });

  it("stateless: cleared storage on a known account still signs in through the discoverable passkey", () => {
    const s = run([
      { type: "BOOTED", hasPasskeyHint: false, address: null },
      { type: "START", mode: "signin" },
      { type: "PASSKEY_OK" },
      { type: "DERIVED", address: ADDR },
      { type: "AUTH_OK", agentAddress: null },
    ]);
    expect(s.tag).toBe("ready");
  });

  it("a cancelled passkey returns to the start screen with a plain error", () => {
    const fresh = run([{ type: "BOOTED", hasPasskeyHint: false, address: null }, { type: "START", mode: "create" }, { type: "PASSKEY_FAILED", error: "Cancelled" }]);
    expect(fresh).toEqual({ tag: "signedOut", error: "Cancelled" });
    const known = run([{ type: "BOOTED", hasPasskeyHint: true, address: ADDR }, { type: "START", mode: "signin" }, { type: "PASSKEY_FAILED", error: "Cancelled" }]);
    expect(known).toEqual({ tag: "locked", address: ADDR, reason: "start", error: "Cancelled" });
  });

  it("a server error keeps the key: retry goes back to authenticating without a passkey state", () => {
    const s = run([
      { type: "BOOTED", hasPasskeyHint: false, address: null },
      { type: "START", mode: "signin" },
      { type: "PASSKEY_OK" },
      { type: "DERIVED", address: ADDR },
      { type: "AUTH_FAILED", error: "The Mona-DeFi server did not answer." },
    ]);
    expect(s).toEqual({ tag: "authError", address: ADDR, error: "The Mona-DeFi server did not answer." });
    expect(isUnlocked(s)).toBe(true);
    expect(authReducer(s, { type: "RETRY" })).toEqual({ tag: "authenticating", address: ADDR });
  });

  it("a 401 while ready signs a new challenge (authenticating), not a new passkey", () => {
    const ready: AuthState = { tag: "ready", address: ADDR, agentAddress: null };
    expect(authReducer(ready, { type: "UNAUTHORIZED" })).toEqual({ tag: "authenticating", address: ADDR });
  });

  it("lock ends the unlocked states; sign out works from any state", () => {
    const ready: AuthState = { tag: "ready", address: ADDR, agentAddress: null };
    const locked = authReducer(ready, { type: "LOCK" });
    expect(locked).toEqual({ tag: "locked", address: ADDR, reason: "timeout" });
    expect(isUnlocked(locked)).toBe(false);
    expect(authReducer(locked, { type: "SIGN_OUT" })).toEqual({ tag: "signedOut" });
    expect(authReducer({ tag: "passkey", mode: "create", address: null }, { type: "SIGN_OUT" })).toEqual({ tag: "signedOut" });
  });

  it("ignores events that do not fit the state", () => {
    const ready: AuthState = { tag: "ready", address: ADDR, agentAddress: null };
    expect(authReducer(ready, { type: "START", mode: "create" })).toBe(ready);
    expect(authReducer(ready, { type: "PASSKEY_OK" })).toBe(ready);
    const signedOut: AuthState = { tag: "signedOut" };
    expect(authReducer(signedOut, { type: "LOCK" })).toBe(signedOut);
    expect(authReducer(initialAuthState, { type: "START", mode: "signin" })).toBe(initialAuthState);
  });

  it("locks only after the background timeout", () => {
    expect(shouldLock(null, 10_000, 5_000)).toBe(false);
    expect(shouldLock(1_000, 5_999, 5_000)).toBe(false);
    expect(shouldLock(1_000, 6_000, 5_000)).toBe(true);
  });

  it("reuses a stored token only for the same derived address (storage is untrusted)", () => {
    expect(canReuseToken({ token: "t", address: ADDR.toLowerCase() }, ADDR)).toBe(true);
    expect(canReuseToken({ token: "t", address: "0x0000000000000000000000000000000000000001" }, ADDR)).toBe(false);
    expect(canReuseToken({ token: null, address: ADDR }, ADDR)).toBe(false);
    expect(canReuseToken({ token: "t", address: null }, ADDR)).toBe(false);
  });
});

describe("trading session plan", () => {
  it("maps each server status to the next steps", () => {
    expect(planSession({ status: "active", upgraded: true })).toEqual({ upgrade: false, grant: false });
    expect(planSession({ status: "needs_upgrade", upgraded: false })).toEqual({ upgrade: true, grant: true });
    expect(planSession({ status: "none", upgraded: true })).toEqual({ upgrade: false, grant: true });
    expect(planSession({ status: "needs_signature", upgraded: true })).toEqual({ upgrade: false, grant: true });
    expect(planSession({ status: "expired", upgraded: true })).toEqual({ upgrade: false, grant: true });
    expect(planSession({ status: "expired", upgraded: false })).toEqual({ upgrade: true, grant: true });
  });
});
