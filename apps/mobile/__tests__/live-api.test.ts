/**
 * @jest-environment node
 *
 * Opt-in contract check against a running API:
 *   MONADEFI_LIVE_API=1 EXPO_PUBLIC_API_URL=http://localhost:8787 npx jest live-api
 * It derives a throwaway account from fixed PRF bytes, signs in like the app, and calls every read route.
 * It sends no transaction (no upgrade, no grant, no relay), so it spends no gas.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { api, ApiError, setAuthHooks } from "../src/lib/api/client";
import { deriveAccount } from "../src/lib/mera/derive";
import { setSigner } from "../src/lib/mera/signer";
import { signMessage } from "../src/lib/wallet";

const LIVE = process.env.MONADEFI_LIVE_API;

/** The React Native Jest setup replaces fetch with a stub. This is a small real fetch over node:http for this test only. */
type NodeHttp = { request: (url: string, opts: object, cb: (res: { statusCode?: number; on: (e: string, f: (c?: unknown) => void) => void }) => void) => { on: (e: string, f: (err: Error) => void) => void; end: (body?: string) => void } };
function nodeFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const lib = jest.requireActual<NodeHttp>(url.startsWith("https") ? "node:https" : "node:http");
  return new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>((resolve, reject) => {
    const req = lib.request(url, { method: init.method ?? "GET", headers: init.headers ?? {} }, (res) => {
      let data = "";
      res.on("data", (c) => (data += String(c)));
      res.on("end", () => resolve({ ok: (res.statusCode ?? 0) < 400, status: res.statusCode ?? 0, text: async () => data }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}
const d = LIVE ? describe : describe.skip;

d("live API contract (docs/api-mobile.md)", () => {
  jest.setTimeout(120_000);
  const results: Record<string, string> = {};

  beforeAll(async () => {
    (globalThis as { fetch: unknown }).fetch = nodeFetch;
    const { session, address } = await deriveAccount(sha256(utf8ToBytes("monadefi-mobile-contract-test")));
    setSigner(session);
    const challenge = await api.auth.challenge(address);
    expect(challenge.message).toContain(address.toLowerCase());
    const v = await api.auth.verify({ address, nonce: challenge.nonce, signature: await signMessage(challenge.message) });
    expect(v.address.toLowerCase()).toBe(address.toLowerCase());
    setAuthHooks({ getToken: () => v.token, renew: async () => null });
    results["auth"] = `ok ${address}`;
  });

  afterAll(() => {
    // eslint-disable-next-line no-console
    console.log(Object.entries(results).map(([k, v]) => `${k.padEnd(22)} ${v}`).join("\n"));
  });

  const probe = async <T>(name: string, fn: () => Promise<T>, check?: (r: T) => void) => {
    try {
      const r = await fn();
      check?.(r);
      results[name] = "ok";
      return r;
    } catch (e) {
      results[name] = e instanceof ApiError ? `HTTP ${e.status}: ${e.message}` : `error: ${(e as Error).message}`;
      return null;
    }
  };

  it("reads every route with the shapes the app expects", async () => {
    const s = await probe("GET /session", api.session.status, (r) => {
      expect(["none", "needs_upgrade", "needs_signature", "active", "expired"]).toContain(r.status);
      expect(r.chainId).toBe(143);
      expect(r.implementation).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });
    if (s) results["GET /session"] = `ok status=${s.status} upgraded=${s.upgraded}`;
    await probe("GET /balance", api.balance, (r) => expect(typeof r.ausd.total).toBe("number"));
    await probe("GET /positions", api.positions, (r) => expect(Array.isArray(r.perpl.positions)).toBe(true));
    await probe("GET /activity", api.activity, (r) => expect(Array.isArray(r)).toBe(true));
    const markets = await probe("GET /perpl/markets", api.markets.list, (r) => {
      expect(r.length).toBeGreaterThan(0);
      expect(typeof r[0]!.markPx).toBe("number");
    });
    const sym = markets?.find((m) => m.symbol === "ETH")?.symbol ?? markets?.[0]?.symbol ?? "ETH";
    await probe("GET book", () => api.markets.book(sym, 10), (r) => expect(Array.isArray(r.bids)).toBe(true));
    await probe("GET candles", () => api.markets.candles(sym), (r) => {
      expect(Array.isArray(r)).toBe(true);
      if (r[0]) expect(typeof r[0].c).toBe("number");
    });
    const risk = await probe("POST /risk/check", () => api.risk.check({ market: sym, side: "long", leverage: 5, marginUsd: 20 }), (r) => {
      expect(["allow", "reduce", "block"]).toContain(r.decision);
      expect(Array.isArray(r.signals)).toBe(true);
      expect(typeof r.applied.leverage).toBe("number");
    });
    if (risk) results["POST /risk/check"] = `ok decision=${risk.decision} level=${risk.level} data=${risk.dataAvailable} changes=${risk.changes.length}`;
    await probe("POST /trade/preview", () => api.trade.preview({ market: sym, side: "long", leverage: 3, marginUsd: 15, orderType: "market" }));
    const chains = await probe("GET deposit assets", api.deposit.assets, (r) => {
      expect(Array.isArray(r)).toBe(true);
      if (r[0]) {
        expect(typeof r[0].connect).toBe("boolean");
        expect(Array.isArray(r[0].tokens)).toBe(true);
      }
    });
    if (chains) results["GET deposit assets"] = `ok ${chains.length} chains, connect: ${chains.filter((c) => c.connect).map((c) => c.chain).join(",")}`;
    const usdc = chains?.find((c) => c.chain === "base")?.tokens.find((t) => t.symbol === "USDC") ?? chains?.[0]?.tokens[0];
    if (usdc) await probe("POST deposit quote", () => api.deposit.quote(usdc.assetId, "25"), (r) => expect(typeof r.quote.amountOutFormatted).toBe("string"));
    await probe("GET /deposit/aurora", api.deposit.list, (r) => expect(Array.isArray(r)).toBe(true));
    expect(results["auth"]).toMatch(/^ok/);
  });
});
