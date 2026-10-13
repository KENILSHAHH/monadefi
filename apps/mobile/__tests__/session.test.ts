import { createSessionManager, isSessionConflict, isSessionFailure, planFor, type SessionDeps } from "../src/lib/session/manager";
import type { SessionStatus } from "../src/lib/api/types";

const ADDR = "0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb";
const IMPL = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-14T12:00:00Z");

const status = (over: Partial<SessionStatus> = {}): SessionStatus => ({
  status: "none", address: ADDR, agentAddress: "0xagent", upgraded: true, implementation: IMPL, chainId: 143, permissions: [],
  scope: { targets: [], functions: [], cannot: ["withdraw", "transfer"] }, ...over,
});

const activeUntil = (ms: number): SessionStatus =>
  status({ status: "active", permissions: [{ id: "perm_1", kind: "perpl_trade", expiresAt: new Date(NOW + ms).toISOString(), status: "active" } as SessionStatus["permissions"][number]] });

class NetErr extends Error {
  status = 0;
}

function mockDeps(statuses: (SessionStatus | Error)[], over: Partial<SessionDeps> = {}) {
  const calls: string[] = [];
  let revokedFlag = false;
  let i = 0;
  const deps: SessionDeps = {
    status: jest.fn(async () => {
      calls.push("status");
      const s = statuses[Math.min(i++, statuses.length - 1)]!;
      if (s instanceof Error) throw s;
      return s;
    }),
    upgrade: jest.fn(async () => {
      calls.push("upgrade");
      return { hash: "0x1" as `0x${string}`, explorer: "https://monadscan.com/tx/0x1" };
    }),
    start: jest.fn(async (days: number) => {
      calls.push(`start:${days}`);
      return {
        permissions: [
          { id: "perm_a", kind: "perpl_trade" as const, typedData: { domain: {}, types: {}, primaryType: "Delegation", message: { salt: "123" } } },
          { id: "perm_b", kind: "ausd_approve" as const, typedData: { domain: {}, types: {}, primaryType: "Delegation", message: { salt: "456" } } },
        ],
      };
    }),
    grant: jest.fn(async (id: string) => {
      calls.push(`grant:${id}`);
      return { id, status: "active", expiresAt: new Date(NOW + 90 * DAY).toISOString() };
    }),
    revoke: jest.fn(async () => {
      calls.push("revoke");
      return { revoked: true, calls: [{ to: "0x1" as `0x${string}`, data: "0x" as `0x${string}`, value: "0", description: "disable" }] };
    }),
    relay: jest.fn(async () => {
      calls.push("relay");
      return { explorer: "https://monadscan.com/tx/0x2", status: "success" };
    }),
    address: () => ADDR,
    pendingNonce: jest.fn(async () => {
      calls.push("nonce");
      return 7;
    }),
    signAuthorization: jest.fn(async (p) => {
      calls.push(`signAuth:${p.chainId}:${p.contractAddress}:${p.nonce}`);
      return { address: IMPL as `0x${string}`, chainId: p.chainId, nonce: p.nonce, r: "0x1" as `0x${string}`, s: "0x2" as `0x${string}`, yParity: 0 };
    }),
    signTypedData: jest.fn(async () => {
      calls.push("sign712");
      return "0xsig";
    }),
    readRevoked: async () => revokedFlag,
    writeRevoked: async (v) => {
      revokedFlag = v;
    },
    sleep: jest.fn(async () => undefined),
    now: () => NOW,
    ...over,
  };
  return { deps, calls, isRevokedStored: () => revokedFlag };
}

describe("ensureSession state machine", () => {
  it("needs_upgrade: upgrade with the pending nonce, then start 90 days and grant each permission", async () => {
    const { deps, calls } = mockDeps([status({ status: "needs_upgrade", upgraded: false })]);
    const m = createSessionManager(deps);
    const setups: boolean[] = [];
    m.onSetup((e) => setups.push(e.first));
    const r = await m.ensure();
    expect(r).toMatchObject({ state: "active", setUp: true });
    expect(calls).toEqual(["status", "nonce", `signAuth:143:${IMPL}:7`, "upgrade", "start:90", "sign712", "grant:perm_a", "sign712", "grant:perm_b"]);
    expect(setups).toEqual([true]);
    expect(m.getSnapshot().phase).toBe("active");
  });

  it("expired or needs_signature on an upgraded wallet: no upgrade, only start + grant", async () => {
    for (const s of ["expired", "needs_signature", "none"] as const) {
      const { deps, calls } = mockDeps([status({ status: s })]);
      await createSessionManager(deps).ensure();
      expect(calls).toEqual(["status", "start:90", "sign712", "grant:perm_a", "sign712", "grant:perm_b"]);
    }
  });

  it("active: a no-op, and a second call within a minute does not even read the status", async () => {
    const { deps, calls } = mockDeps([activeUntil(30 * DAY)]);
    const m = createSessionManager(deps);
    expect(await m.ensure()).toMatchObject({ state: "active", setUp: false });
    expect(await m.ensure()).toMatchObject({ state: "active", setUp: false });
    expect(calls).toEqual(["status"]);
  });

  it("active but ending within 3 days: renews quietly (no first-setup toast)", async () => {
    const { deps, calls } = mockDeps([activeUntil(2 * DAY)]);
    const m = createSessionManager(deps);
    const setups: boolean[] = [];
    m.onSetup((e) => setups.push(e.first));
    await m.ensure();
    expect(calls).toContain("start:90");
    expect(setups).toEqual([false]);
  });

  it("single flight: two callers share one run", async () => {
    const { deps, calls } = mockDeps([status({ status: "none" })]);
    const m = createSessionManager(deps);
    const [a, b] = await Promise.all([m.ensure(), m.ensure()]);
    expect(a).toEqual(b);
    expect(calls.filter((c) => c === "start:90")).toHaveLength(1);
  });

  it("retries network errors with backoff, then succeeds", async () => {
    const { deps, calls } = mockDeps([new NetErr("offline"), new NetErr("offline"), status({ status: "none" })]);
    const m = createSessionManager(deps);
    const r = await m.ensure();
    expect(r.state).toBe("active");
    expect(deps.sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(deps.sleep).toHaveBeenNthCalledWith(2, 2_000);
    expect(calls.filter((c) => c === "status")).toHaveLength(3);
  });

  it("does not retry a 4xx error and never throws", async () => {
    const e = Object.assign(new Error("Bad request."), { status: 400 });
    const { deps } = mockDeps([e]);
    const m = createSessionManager(deps);
    expect(await m.ensure()).toEqual({ state: "error", error: "Bad request." });
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(m.getSnapshot()).toMatchObject({ phase: "error", error: "Bad request." });
  });

  it("locked: nothing happens without the in-memory key", async () => {
    const { deps, calls } = mockDeps([status()], { address: () => null });
    expect(await createSessionManager(deps).ensure()).toEqual({ state: "locked" });
    expect(calls).toEqual([]);
  });

  it("retry after session_inactive: invalidate() makes the next ensure() read the server again and set up", async () => {
    // Active a moment ago (cached), but the confirm said session_inactive: the server dropped it.
    const { deps, calls } = mockDeps([activeUntil(30 * DAY), status({ status: "expired" })]);
    const m = createSessionManager(deps);
    await m.ensure();
    expect(isSessionFailure({ code: "session_inactive", error: "Trading is not turned on." })).toBe(true);
    m.invalidate();
    const r = await m.ensure();
    expect(r).toMatchObject({ state: "active", setUp: true });
    expect(calls).toEqual(["status", "status", "start:90", "sign712", "grant:perm_a", "sign712", "grant:perm_b"]);
  });

  it("revoke: DELETE /session + relay of the disable calls, then no automatic setup", async () => {
    const { deps, calls, isRevokedStored } = mockDeps([status({ status: "none" })]);
    const m = createSessionManager(deps);
    const { link } = await m.revoke();
    expect(link).toBe("https://monadscan.com/tx/0x2");
    expect(calls).toEqual(["revoke", "relay"]);
    expect(isRevokedStored()).toBe(true);
    expect(await m.ensure()).toEqual({ state: "revoked" });
    expect(calls).toEqual(["revoke", "relay"]);
    expect(m.getSnapshot().phase).toBe("revoked");
  });

  it("revoked flag survives a restart (it is in storage) until restore()", async () => {
    const { deps, calls } = mockDeps([status({ status: "none" })], { readRevoked: async () => true });
    const m = createSessionManager(deps);
    expect(await m.ensure()).toEqual({ state: "revoked" });
    expect(calls).toEqual([]);
    const r = await m.restore();
    expect(r.state).toBe("active");
    expect(calls).toContain("start:90");
  });

  it("a revoke during a running setup stops it before the next signature", async () => {
    let m!: ReturnType<typeof createSessionManager>;
    const { deps, calls } = mockDeps([status({ status: "none" })], {
      grant: jest.fn(async (id: string) => {
        calls.push(`grant:${id}`);
        if (id === "perm_a") void m.revoke();
        return { id };
      }),
    });
    m = createSessionManager(deps);
    expect(await m.ensure()).toEqual({ state: "revoked" });
    expect(calls).not.toContain("grant:perm_b");
  });

  it("the upgrade-only run (gasless withdrawal) works after a revoke and grants nothing", async () => {
    const { deps, calls } = mockDeps([status({ status: "needs_upgrade", upgraded: false })], { readRevoked: async () => true });
    const m = createSessionManager(deps);
    await m.ensure({ upgradeOnly: true });
    expect(calls).toEqual(["status", "nonce", `signAuth:143:${IMPL}:7`, "upgrade"]);
  });
});

describe("session helpers", () => {
  it("planFor", () => {
    expect(planFor(status({ status: "needs_upgrade", upgraded: false }), NOW)).toEqual({ upgrade: true, grant: true });
    expect(planFor(activeUntil(10 * DAY), NOW)).toEqual({ upgrade: false, grant: false });
    expect(planFor(activeUntil(DAY), NOW)).toEqual({ upgrade: false, grant: true });
  });

  it("isSessionFailure and isSessionConflict", () => {
    expect(isSessionFailure({ error: "Out of margin." })).toBe(false);
    expect(isSessionFailure({ error: "The trading session ended." })).toBe(true);
    expect(isSessionFailure(null)).toBe(false);
    expect(isSessionConflict({ status: 409, message: "Trading is not turned on." })).toBe(true);
    expect(isSessionConflict({ status: 409, message: "The intent is failed." })).toBe(false);
    expect(isSessionConflict({ status: 400, message: "session" })).toBe(false);
  });
});
