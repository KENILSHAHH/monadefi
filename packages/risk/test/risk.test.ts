import { beforeEach, describe, expect, it } from "vitest";
import { applyVerdict, assessTrade, clearNansenCache, createNansenClient, monitorPosition, ResponseCache } from "../src/index";
import { PositionIntelligenceSchema as PositionIntelligenceSchemaForTest } from "../src/client";

// ── Fake Nansen ──

type Handler = (body: any) => { status?: number; body: unknown; headers?: Record<string, string> };
interface Fake {
  fetch: typeof fetch;
  calls: { path: string; body: any; headers: Record<string, string> }[];
}

function fakeNansen(routes: Record<string, Handler | Handler[]>): Fake {
  const calls: Fake["calls"] = [];
  const counters: Record<string, number> = {};
  const f = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://api.nansen.ai/api/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = routes[path];
    if (!r) return new Response(JSON.stringify({ error: "Not Found", code: "not_found", message: "no route", status: 404 }), { status: 404 });
    const i = (counters[path] = (counters[path] ?? 0) + 1) - 1;
    const h = Array.isArray(r) ? r[Math.min(i, r.length - 1)]! : r;
    const out = h(body);
    const status = out.status ?? 200;
    const cost = { "/smart-money/perp-trades": "5", "/tgm/holders": "5" }[path] ?? "1";
    const headers: Record<string, string> = { "content-type": "application/json", "x-nansen-credits-cost": cost, "x-nansen-credits-used": status < 300 ? cost : "0", ...(out.headers ?? {}) };
    return new Response(JSON.stringify(out.body), { status, headers });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

// Recorded-shape fixtures (field names from the Nansen OpenAPI; values made up). Extra fields test loose parsing.
const posIntel = (sL: number, sS: number, wL: number, wS: number, pL = 0, pS = 0) => () => ({
  body: { data: [{ smart_trader_longs_usd: sL, smart_trader_shorts_usd: sS, smart_trader_total_usd: sL + sS, whale_longs_usd: wL, whale_shorts_usd: wS, whale_total_usd: wL + wS, public_figure_longs_usd: pL, public_figure_shorts_usd: pS, public_figure_total_usd: pL + pS, top_pnl_longs_usd: 1, new_field: "x" }] },
});
const flowIntel = (f: { sm?: number; top?: number; whale?: number; ex?: number; pf?: number; fresh?: number }) => () => ({
  body: { data: [{ smart_trader_net_flow_usd: f.sm ?? 0, top_pnl_net_flow_usd: f.top ?? 0, whale_net_flow_usd: f.whale ?? 0, exchange_net_flow_usd: f.ex ?? 0, exchange_wallet_count: 0, public_figure_net_flow_usd: f.pf ?? 0, fresh_wallets_net_flow_usd: f.fresh ?? 0, fresh_wallets_wallet_count: 0 }], warnings: null },
});
const perpTrades = (buy: number, sell: number, sym = "ETH") => () => ({
  body: {
    data: [
      { trader_address: "0x1", trader_address_label: "Smart HL Perps Trader", token_symbol: sym, side: "Long", action: "Buy - Open Long", value_usd: buy, block_timestamp: "2026-10-13T10:00:00" },
      { trader_address: "0x2", trader_address_label: "Fund", token_symbol: sym, side: "Short", action: "Sell - Open Short", value_usd: sell, block_timestamp: "2026-10-13T11:00:00" },
    ],
    pagination: { page: 1, per_page: 100, is_last_page: true },
  },
});

const bearishEth = {
  "/tgm/position-intelligence": posIntel(10e6, 40e6, 5e6, 20e6, 1e6, 3e6),
  "/tgm/flow-intelligence": flowIntel({ sm: -20e6, top: -10e6, whale: -30e6, ex: 40e6, pf: -2e6, fresh: 1e6 }),
  "/smart-money/perp-trades": perpTrades(2e6, 9e6),
};
const mildBearishEth = {
  "/tgm/position-intelligence": posIntel(18e6, 32e6, 10e6, 12e6),
  "/tgm/flow-intelligence": flowIntel({ sm: -12e6, whale: -15e6, ex: 25e6 }),
  "/smart-money/perp-trades": perpTrades(4e6, 6e6),
};
const bullishEth = {
  "/tgm/position-intelligence": posIntel(45e6, 10e6, 20e6, 5e6, 2e6, 0.5e6),
  "/tgm/flow-intelligence": flowIntel({ sm: 25e6, top: 8e6, whale: 30e6, ex: -40e6, pf: 1e6 }),
  "/smart-money/perp-trades": perpTrades(9e6, 1e6),
};

const base = { apiKey: "test-key", market: "ETH", side: "long" as const, leverage: 10, marginUsd: 100, marketMaxLeverage: 12, now: new Date("2026-10-13T12:00:00Z") };

beforeEach(() => clearNansenCache());

describe("assessTrade", () => {
  it("blocks a long when smart money, whales and exchanges are all against it", async () => {
    const fake = fakeNansen(bearishEth);
    const v = await assessTrade({ ...base, fetchImpl: fake.fetch });
    expect(v.dataAvailable).toBe(true);
    expect(v.score).toBeLessThanOrEqual(-60);
    expect(v.decision).toBe("block");
    expect(v.level).toBe("extreme");
    expect(v.adjusted.sizeMultiplier).toBe(0);
    expect(v.changes[0]).toMatch(/^Trade blocked/);
    expect(v.creditsUsed).toBe(7);
    expect(v.signals.find((s) => s.segment === "exchanges")?.label).toMatch(/Exchanges received a net 40.0M USD of native ETH on Ethereum in 24h/);
    // request bodies match the Nansen docs
    const bodies = Object.fromEntries(fake.calls.map((c) => [c.path, c.body]));
    expect(bodies["/tgm/position-intelligence"]).toEqual({ token_address: "ETH" });
    expect(bodies["/tgm/flow-intelligence"]).toEqual({ chain: "ethereum", token_address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", timeframe: "1d" });
    expect(bodies["/smart-money/perp-trades"]).toMatchObject({ filters: { token_symbol: "ETH" }, lookback_hours: 24 });
    expect(fake.calls[0]!.headers.apikey).toBe("test-key");
  });

  it("the same data favours a short", async () => {
    const v = await assessTrade({ ...base, side: "short", fetchImpl: fakeNansen(bearishEth).fetch });
    expect(v.score).toBeGreaterThanOrEqual(25);
    expect(v.decision).toBe("allow");
    expect(v.changes).toEqual([]);
  });

  it("reduces leverage and size when the segments lean against the trade", async () => {
    const v = await assessTrade({ ...base, fetchImpl: fakeNansen(mildBearishEth).fetch });
    expect(v.score).toBeGreaterThan(-60);
    expect(v.score).toBeLessThanOrEqual(-25);
    expect(v.decision).toBe("reduce");
    expect(v.adjusted.maxLeverage).toBe(4); // floor(12 / 3)
    expect(v.adjusted.sizeMultiplier).toBe(0.5);
    expect(v.adjusted.requireStopLoss).toBe(true);
    expect(v.adjusted.stopLossDistancePct).toBe(3);
    expect(v.changes.some((c) => c.startsWith("Leverage 10x -> 4x: "))).toBe(true);
  });

  it("allows a trade the segments support, as requested", async () => {
    const v = await assessTrade({ ...base, fetchImpl: fakeNansen(bullishEth).fetch });
    expect(v.score).toBeGreaterThanOrEqual(25);
    expect(v.decision).toBe("allow");
    expect(v.level).toBe("low");
    expect(v.adjusted).toMatchObject({ maxLeverage: 10, sizeMultiplier: 1, requireStopLoss: false, extraMarginPct: 0 });
    expect(v.reasons[0]).toMatch(/Nansen score \d+ for a ETH long/);
  });

  it("neutral data at high leverage: allow, but require a stop and a margin buffer", async () => {
    const v = await assessTrade({ ...base, fetchImpl: fakeNansen({ "/tgm/position-intelligence": posIntel(10e6, 10e6, 5e6, 5e6), "/tgm/flow-intelligence": flowIntel({}) }).fetch });
    expect(v.decision).toBe("allow");
    expect(v.level).toBe("medium");
    expect(v.adjusted.requireStopLoss).toBe(true);
    expect(v.adjusted.stopLossDistancePct).toBe(5);
    expect(v.adjusted.extraMarginPct).toBe(10);
  });

  it("without a key: conservative default, never pretends data exists", async () => {
    const v = await assessTrade({ ...base, apiKey: undefined });
    expect(v.dataAvailable).toBe(false);
    expect(v.decision).toBe("reduce");
    expect(v.adjusted.maxLeverage).toBe(3);
    expect(v.adjusted.requireStopLoss).toBe(true);
    expect(v.signals).toEqual([]);
    expect(v.creditsUsed).toBe(0);
    expect(v.reasons[0]).toMatch(/Nansen data is not available/);
    expect(v.changes[0]).toMatch(/^Leverage 10x -> 3x: Nansen data is not available/);
  });

  it("Nansen down (500 everywhere): same conservative default", async () => {
    const down = () => ({ status: 500, body: { error: "Internal", code: "internal_error", message: "boom", status: 500 } });
    const v = await assessTrade({ ...base, fetchImpl: fakeNansen({ "/tgm/position-intelligence": down, "/tgm/flow-intelligence": down, "/smart-money/perp-trades": down }).fetch, clientOptions: { sleep: async () => {} } });
    expect(v.dataAvailable).toBe(false);
    expect(v.decision).toBe("reduce");
    expect(v.creditsUsed).toBe(0);
  });

  it("concentrated supply and a weak trader record add risk", async () => {
    const holders = () => ({
      body: {
        data: [
          { address: "0xa", address_label: "Binance Hot Wallet", token_amount: 1e6, value_usd: 5e6, ownership_percentage: 0.3, balance_change_24h: 0 },
          ...Array.from({ length: 10 }, (_, i) => ({ address: `0x${i}`, address_label: i === 0 ? "Team Vesting" : null, token_amount: 1e6, value_usd: 5e6, ownership_percentage: 0.08, balance_change_24h: -1e5 })),
        ],
      },
    });
    const pnl = () => ({ body: { traded_times: 20, traded_token_count: 4, realized_pnl_usd: -800, realized_pnl_percent: -12, win_rate: 0.25, top5_tokens: [] } });
    const fake = fakeNansen({ "/tgm/position-intelligence": posIntel(5e6, 5e6, 1e6, 1e6), "/tgm/flow-intelligence": flowIntel({}), "/tgm/holders": holders, "/profiler/address/pnl-summary": pnl, "/smart-money/perp-trades": perpTrades(1e5, 1e5, "UNI") });
    const v = await assessTrade({ ...base, market: "UNI", marketMaxLeverage: 3, leverage: 3, trader: "0x1111111111111111111111111111111111111111", fetchImpl: fake.fetch });
    const conc = v.signals.find((s) => s.id === "top10_concentration")!;
    expect(conc.value).toBe(80); // the exchange wallet is excluded
    expect(v.signals.find((s) => s.id === "trader_record_30d")?.direction).toBe("against_trade");
    expect(v.score).toBeLessThanOrEqual(-25);
    expect(v.creditsUsed).toBe(13);
    const hb = fake.calls.find((c) => c.path === "/tgm/holders")!.body;
    expect(hb).toMatchObject({ chain: "ethereum", token_address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", premium_labels: false });
    const pb = fake.calls.find((c) => c.path === "/profiler/address/pnl-summary")!.body;
    expect(pb).toEqual({ wallet_address: "0x1111111111111111111111111111111111111111", chain: "monad", date: { from: "2026-09-13", to: "2026-10-13" } });
  });

  it("keeps the credit budget", async () => {
    const fake = fakeNansen(bullishEth);
    const v = await assessTrade({ ...base, fetchImpl: fake.fetch, maxCredits: 2 });
    expect(fake.calls.map((c) => c.path).sort()).toEqual(["/tgm/flow-intelligence", "/tgm/position-intelligence"]);
    expect(v.creditsUsed).toBe(2);
    expect(v.reasons.some((r) => r.includes("Skipped Nansen /smart-money/perp-trades"))).toBe(true);
  });
});

describe("cache", () => {
  it("a second assessment within the TTL uses no credits and no requests", async () => {
    const fake = fakeNansen(bullishEth);
    const a = await assessTrade({ ...base, fetchImpl: fake.fetch });
    const n = fake.calls.length;
    const b = await assessTrade({ ...base, leverage: 3, fetchImpl: fake.fetch });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.creditsUsed).toBe(0);
    expect(fake.calls.length).toBe(n);
    expect(b.score).toBe(a.score);
  });

  it("expires after the TTL", async () => {
    let t = 0;
    const fake = fakeNansen(bullishEth);
    const c = createNansenClient({ apiKey: "k", fetch: fake.fetch, cache: new ResponseCache(), now: () => t });
    await c.post("/tgm/position-intelligence", { token_address: "ETH" }, PositionIntelligenceSchemaForTest);
    t = 4 * 60_000;
    expect((await c.post("/tgm/position-intelligence", { token_address: "ETH" }, PositionIntelligenceSchemaForTest)).cached).toBe(true);
    t = 6 * 60_000;
    expect((await c.post("/tgm/position-intelligence", { token_address: "ETH" }, PositionIntelligenceSchemaForTest)).cached).toBe(false);
    expect(fake.calls.length).toBe(2);
  });
});

describe("client", () => {
  it("retries a 429 after Retry-After, and counts credits only for the 2xx", async () => {
    const waits: number[] = [];
    const fake = fakeNansen({
      "/tgm/position-intelligence": [
        () => ({ status: 429, body: { error: "Too Many Requests", code: "rate_limit_exceeded", message: "slow down", status: 429, retry_after: 2 }, headers: { "retry-after": "2", "x-nansen-ratelimit-scope": "second" } }),
        posIntel(1e6, 1e6, 1e6, 1e6),
      ],
    });
    const c = createNansenClient({ apiKey: "k", fetch: fake.fetch, cache: new ResponseCache(), sleep: async (ms) => { waits.push(ms); } });
    const r = await c.post("/tgm/position-intelligence", { token_address: "ETH" }, PositionIntelligenceSchemaForTest);
    expect(waits).toEqual([2000]);
    expect(fake.calls.length).toBe(2);
    expect(r.credits).toBe(1);
    expect(r.data.data[0]?.smart_trader_longs_usd).toBe(1e6);
  });

  it("gives up after the retries with a NansenError", async () => {
    const fake = fakeNansen({ "/tgm/position-intelligence": () => ({ status: 429, body: { code: "rate_limit_exceeded", message: "slow down" }, headers: { "retry-after": "1" } }) });
    const c = createNansenClient({ apiKey: "k", fetch: fake.fetch, cache: new ResponseCache(), maxRetries: 2, sleep: async () => {} });
    await expect(c.post("/tgm/position-intelligence", { token_address: "ETH" }, PositionIntelligenceSchemaForTest)).rejects.toMatchObject({ status: 429, code: "rate_limit_exceeded" });
    expect(fake.calls.length).toBe(3);
  });

  it("caches a 422 (unsupported token) but not a 403", async () => {
    const fake = fakeNansen({
      "/tgm/flow-intelligence": () => ({ status: 422, body: { code: "invalid_field_value", message: "native not supported" } }),
      "/tgm/position-intelligence": () => ({ status: 403, body: { code: "insufficient_credits", message: "no credits" } }),
    });
    const c = createNansenClient({ apiKey: "k", fetch: fake.fetch, cache: new ResponseCache() });
    for (let i = 0; i < 2; i++) {
      await expect(c.post("/tgm/flow-intelligence", { a: 1 }, PositionIntelligenceSchemaForTest)).rejects.toMatchObject({ status: 422 });
      await expect(c.post("/tgm/position-intelligence", { a: 1 }, PositionIntelligenceSchemaForTest)).rejects.toMatchObject({ status: 403 });
    }
    expect(fake.calls.filter((x) => x.path === "/tgm/flow-intelligence").length).toBe(1);
    expect(fake.calls.filter((x) => x.path === "/tgm/position-intelligence").length).toBe(2);
  });
});

describe("applyVerdict", () => {
  it("applies leverage cap, size cut, margin buffer and stop", async () => {
    const v = await assessTrade({ ...base, fetchImpl: fakeNansen(mildBearishEth).fetch });
    const r = applyVerdict({ market: "ETH", leverage: 10, marginUsd: 100, stopLossPx: null as number | null }, v, { entryPx: 3000 });
    expect(r.blocked).toBe(false);
    // 100 x 0.5 = 50 USD at 4x = 200 USD notional; +25% margin = 62.5 USD at 3.2x, same 200 USD notional.
    expect(r.order.marginUsd).toBe(62.5);
    expect(r.order.leverage).toBe(3.2);
    expect(r.order.stopLossPx).toBe(2910);
    expect(r.order.market).toBe("ETH");
    expect(r.changes[0]).toMatch(/^Leverage 10x -> 4x: /);
    expect(r.changes.some((c) => c.startsWith("Stop-loss set at 2910 (3% below entry 3000)"))).toBe(true);
  });

  it("keeps a tighter stop the user already set, and tightens a looser one", async () => {
    const v = await assessTrade({ ...base, side: "short", fetchImpl: fakeNansen(mildBearishEth).fetch, leverage: 10 });
    // mild bearish data supports a short -> neutral/allow band; force a known verdict for the stop logic instead
    const forced = { ...v, decision: "allow" as const, adjusted: { maxLeverage: 10, sizeMultiplier: 1, requireStopLoss: true, stopLossDistancePct: 5, extraMarginPct: 0 } };
    expect(applyVerdict({ leverage: 10, marginUsd: 100, stopLossPx: 3050 }, forced, { entryPx: 3000 }).order.stopLossPx).toBe(3050);
    const t = applyVerdict({ leverage: 10, marginUsd: 100, stopLossPx: 3300 }, forced, { entryPx: 3000 });
    expect(t.order.stopLossPx).toBe(3150);
    expect(t.changes[0]).toMatch(/^Stop-loss 3300 -> 3150/);
  });

  it("returns blocked for a block verdict and leaves the order as is", async () => {
    const v = await assessTrade({ ...base, fetchImpl: fakeNansen(bearishEth).fetch });
    const order = { leverage: 10, marginUsd: 100 };
    const r = applyVerdict(order, v, { entryPx: 3000 });
    expect(r.blocked).toBe(true);
    expect(r.order).toEqual(order);
    expect(r.changes[0]).toMatch(/^Trade blocked/);
  });

  it("no-data verdict caps leverage at 3x and sets a stop", async () => {
    const v = await assessTrade({ ...base, apiKey: undefined });
    const r = applyVerdict({ leverage: 10, marginUsd: 100 }, v, { entryPx: 3000 });
    expect(r.order.leverage).toBe(3);
    expect(r.order.marginUsd).toBe(100);
    expect(r.order.stopLossPx).toBe(2910);
  });
});

describe("monitorPosition", () => {
  it("exits a long when the segments turn strongly against it", async () => {
    const r = await monitorPosition({ apiKey: "k", market: "ETH", side: "long", entryPx: 3000, markPx: 2950, sizeUsd: 1000, fetchImpl: fakeNansen(bearishEth).fetch, maxCredits: 7 });
    expect(r.action).toBe("exit");
  });
  it("reduces a losing position and tightens a winning one under moderate pressure", async () => {
    const lose = await monitorPosition({ apiKey: "k", market: "ETH", side: "long", entryPx: 3000, markPx: 2950, sizeUsd: 1000, fetchImpl: fakeNansen(mildBearishEth).fetch, maxCredits: 7 });
    expect(lose.action).toBe("reduce");
    expect(lose.reduceFraction).toBe(0.5);
    const win = await monitorPosition({ apiKey: "k", market: "ETH", side: "long", entryPx: 3000, markPx: 3300, sizeUsd: 1000, fetchImpl: fakeNansen(mildBearishEth).fetch, maxCredits: 7 });
    expect(win.action).toBe("tighten_stop");
    expect(win.stopPx).toBeGreaterThanOrEqual(3000);
    expect(win.stopPx).toBeLessThan(3300);
  });
  it("holds without data", async () => {
    const r = await monitorPosition({ market: "ETH", side: "long", entryPx: 3000, markPx: 2000, sizeUsd: 1000 });
    expect(r.action).toBe("hold");
    expect(r.verdict.dataAvailable).toBe(false);
  });
});
