/**
 * The automatic trading session. Pure: every I/O step comes in through `SessionDeps`, so the tests can drive it.
 *
 * After the one passkey ceremony, the Mera key is in memory and signs with no prompt. ensure() uses it to:
 *   GET /session → needs_upgrade: sign an EIP-7702 authorization → POST /session/upgrade
 *                → not active, or active but ending within 3 days: POST /session/start → sign each permission → POST /session/grant
 *
 * Rules:
 * - Single flight: two callers share one run.
 * - A network error (no answer, or HTTP 5xx) retries with backoff. Other errors end the run.
 * - ensure() never throws. It returns a result, so a caller can await it before a chat prompt or a confirm.
 * - After the user revokes, ensure() does nothing until restore() or a new sign-in (the flag is in storage).
 */
import type {
  RelayCall, SessionRevokeResponse, SessionStartResponse, SessionStatus, SignedAuthorizationBody, TxResponse, TypedDataPayload,
} from "../api/types";

export const SESSION_DAYS = 90;
/** Renew the permissions when they end within this time. */
export const RENEW_BEFORE_MS = 3 * 86_400_000;
/** A recent "active" answer is trusted for this long, so ensure() is a fast no-op. */
export const ACTIVE_CACHE_MS = 60_000;
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;

export interface SessionDeps {
  status(): Promise<SessionStatus>;
  upgrade(auth: SignedAuthorizationBody): Promise<TxResponse>;
  start(days: number): Promise<SessionStartResponse>;
  grant(id: string, signature: string): Promise<{ expiresAt?: string } | unknown>;
  revoke(): Promise<SessionRevokeResponse>;
  relay(calls: RelayCall[]): Promise<{ explorer: string; status?: string }>;
  /** The address of the in-memory key, or null when the app is locked. */
  address(): string | null;
  /** The pending transaction count of the wallet on Monad. */
  pendingNonce(address: string): Promise<number>;
  signAuthorization(p: { chainId: number; contractAddress: string; nonce: number }): Promise<SignedAuthorizationBody>;
  signTypedData(td: TypedDataPayload): Promise<string>;
  readRevoked(): Promise<boolean>;
  writeRevoked(v: boolean): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type SessionPhase = "idle" | "checking" | "upgrading" | "granting" | "active" | "revoked" | "locked" | "error";

export interface SessionSnapshot {
  phase: SessionPhase;
  /** When the permissions end (ISO), if known. */
  endsAt: string | null;
  error: string | null;
}

export type EnsureResult =
  | { state: "active"; setUp: boolean; endsAt: string | null }
  | { state: "revoked" }
  | { state: "locked" }
  | { state: "error"; error: string };

export interface SetupEvent {
  /** True when trading was off before (not a quiet renewal). */
  first: boolean;
  upgradeTx: string | null;
  endsAt: string | null;
}

class RevokedDuringRun extends Error {}

/** True for an error that a retry can fix: no answer from the server, or a server error. */
export function isRetryable(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status === 0 || status >= 500;
  return e instanceof TypeError; // fetch failed
}

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : "Trading access could not be set up.");

/** The earliest end of the active permissions. */
export function activeEndsAt(s: Pick<SessionStatus, "permissions">): string | null {
  return s.permissions.filter((p) => p.status === "active").map((p) => p.expiresAt).sort()[0] ?? null;
}

/** What ensure() does for a server status. */
export function planFor(s: Pick<SessionStatus, "status" | "upgraded" | "permissions">, now: number): { upgrade: boolean; grant: boolean } {
  const upgrade = s.status === "needs_upgrade" || !s.upgraded;
  if (s.status !== "active") return { upgrade, grant: true };
  const ends = activeEndsAt(s);
  const endingSoon = ends !== null && Date.parse(ends) - now < RENEW_BEFORE_MS;
  return { upgrade: false, grant: endingSoon };
}

export function createSessionManager(deps: SessionDeps) {
  let snapshot: SessionSnapshot = { phase: "idle", endsAt: null, error: null };
  let inflight: Promise<EnsureResult> | null = null;
  let inflightUpgradeOnly = false;
  let revoked: boolean | null = null; // null: not read from storage yet
  let activeAt: number | null = null;
  const listeners = new Set<() => void>();
  const setupListeners = new Set<(e: SetupEvent) => void>();

  const set = (patch: Partial<SessionSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const l of listeners) l();
  };

  const isRevoked = async () => {
    if (revoked === null) revoked = await deps.readRevoked().catch(() => false);
    return revoked;
  };

  const checkNotRevoked = () => {
    if (revoked) throw new RevokedDuringRun();
  };

  /** One pass of the setup. Throws on failure. */
  async function pass(opts: { upgradeOnly: boolean }): Promise<EnsureResult> {
    const address = deps.address();
    if (!address) return { state: "locked" };
    set({ phase: "checking", error: null });
    const status = await deps.status();
    const wasActive = status.status === "active";
    const plan = planFor(status, deps.now());
    let upgradeTx: string | null = null;

    if (plan.upgrade) {
      set({ phase: "upgrading" });
      // The sponsor sends the authorization, so the nonce is the wallet's own pending transaction count.
      const nonce = await deps.pendingNonce(address);
      const auth = await deps.signAuthorization({ chainId: status.chainId || 143, contractAddress: status.implementation, nonce });
      upgradeTx = (await deps.upgrade(auth)).explorer;
    }
    if (opts.upgradeOnly) {
      set({ phase: wasActive ? "active" : "idle" });
      return wasActive ? { state: "active", setUp: false, endsAt: activeEndsAt(status) } : { state: "error", error: "Trading access is off." };
    }

    let endsAt = activeEndsAt(status);
    if (plan.grant) {
      checkNotRevoked();
      set({ phase: "granting" });
      const started = await deps.start(SESSION_DAYS);
      const ends: string[] = [];
      for (const p of started.permissions) {
        checkNotRevoked();
        // The typed data has decimal-string integers (the salt); signTypedData converts them to bigint.
        const signature = await deps.signTypedData(p.typedData);
        const granted = (await deps.grant(p.id, signature)) as { expiresAt?: string } | null;
        if (typeof granted?.expiresAt === "string") ends.push(granted.expiresAt);
      }
      endsAt = started.expiresAt ?? ends.sort()[0] ?? new Date(deps.now() + SESSION_DAYS * 86_400_000).toISOString();
      const ev: SetupEvent = { first: !wasActive, upgradeTx, endsAt };
      for (const l of setupListeners) l(ev);
    }
    activeAt = deps.now();
    set({ phase: "active", endsAt, error: null });
    return { state: "active", setUp: plan.grant, endsAt };
  }

  async function run(opts: { upgradeOnly: boolean }): Promise<EnsureResult> {
    if (!opts.upgradeOnly && (await isRevoked())) {
      set({ phase: "revoked", error: null });
      return { state: "revoked" };
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await pass(opts);
        if (r.state === "locked") set({ phase: "locked" });
        return r;
      } catch (e) {
        if (e instanceof RevokedDuringRun) {
          set({ phase: "revoked", error: null });
          return { state: "revoked" };
        }
        const delay = BACKOFF_MS[attempt];
        if (isRetryable(e) && delay !== undefined && deps.address()) {
          await deps.sleep(delay);
          continue;
        }
        set({ phase: "error", error: message(e) });
        return { state: "error", error: message(e) };
      }
    }
  }

  /**
   * Make sure the session is active. Fast when it was active a moment ago. Never throws.
   * `upgradeOnly`: only the EIP-7702 upgrade (it grants nothing), for example for a gasless withdrawal. It works after a revoke.
   */
  function ensure(opts: { upgradeOnly?: boolean } = {}): Promise<EnsureResult> {
    const upgradeOnly = opts.upgradeOnly ?? false;
    if (!upgradeOnly && revoked === false && activeAt !== null && deps.now() - activeAt < ACTIVE_CACHE_MS) {
      const ends = snapshot.endsAt ? Date.parse(snapshot.endsAt) : Infinity;
      if (ends - deps.now() >= RENEW_BEFORE_MS) return Promise.resolve({ state: "active", setUp: false, endsAt: snapshot.endsAt });
    }
    if (inflight) {
      // A full setup also does the upgrade. An upgrade-only run is not enough for a full caller: wait, then run again.
      if (inflightUpgradeOnly && !upgradeOnly) return inflight.then(() => ensure());
      return inflight;
    }
    inflightUpgradeOnly = upgradeOnly;
    inflight = run({ upgradeOnly }).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    /** Called after each setup that signed new permissions. */
    onSetup(l: (e: SetupEvent) => void) {
      setupListeners.add(l);
      return () => void setupListeners.delete(l);
    },

    ensure,

    /** Forget the cached "active" answer, for example after a confirm failed with session_inactive. */
    invalidate() {
      activeAt = null;
    },

    /** DELETE /session, then disable the delegations on-chain through the relay. No auto setup after this. */
    async revoke(): Promise<{ link: string | null }> {
      revoked = true;
      activeAt = null;
      await deps.writeRevoked(true);
      set({ phase: "revoked", endsAt: null, error: null });
      await inflight?.catch(() => undefined);
      const r = await deps.revoke();
      let link: string | null = null;
      // The delegations stay valid on-chain until they end, so the wallet disables them itself (gasless, no prompt).
      if (r.calls?.length) link = (await deps.relay(r.calls)).explorer;
      return { link };
    },

    /** The "Restore trading access" button: allow the automatic setup again and run it now. */
    async restore(): Promise<EnsureResult> {
      revoked = false;
      await deps.writeRevoked(false);
      set({ phase: "idle", error: null });
      await inflight?.catch(() => undefined);
      return ensure();
    },

    /** Lock or sign-out: forget the cache. `signedOut` also forgets the revoke flag (storage is cleared). */
    reset(opts: { signedOut?: boolean } = {}) {
      activeAt = null;
      if (opts.signedOut) revoked = null;
      set({ phase: "idle", endsAt: null, error: null });
    },
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;

/** Wait for a promise at most `ms`. Returns null on timeout. The promise keeps running. */
export function within<T>(p: Promise<T>, ms: number, sleep: (ms: number) => Promise<void>): Promise<T | null> {
  return Promise.race([p, sleep(ms).then(() => null)]);
}

const SESSION_TEXT = /trading is not turned on|session ended|outside the trading session|trading session|session is not active/i;

/** True when a confirmed intent failed because the session was not active (`result.code: "session_inactive"`). */
export function isSessionFailure(result: { code?: unknown; error?: unknown } | null | undefined): boolean {
  if (!result) return false;
  return result.code === "session_inactive" || SESSION_TEXT.test(String(result.error ?? ""));
}

/** True for an HTTP 409 whose error is about the session. */
export function isSessionConflict(e: unknown): boolean {
  const x = e as { status?: unknown; message?: unknown; code?: unknown } | null;
  return x?.status === 409 && (x.code === "session_inactive" || /session|trading is not turned on/i.test(String(x.message ?? "")));
}
