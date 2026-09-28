import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AuroraRateLimitError, MIN_AMOUNT_OUT, MONAD, QuoteMovedError, ausdSwapSteps, base58, clearTokenCache, encodeErc191Signature, groupByChain, listTokens,
  planAusdExecution, quote, retryAfterMs, status, type AuroraOptions, type AuroraToken, type QuoteRequest, type StatusResponse,
} from "../src/adapters/aurora";
import { applyConnectStatus, applySwapStatus, onSettled } from "../src/auroraDeposits";

// The DB tests read DATABASE_URL from the repo .env when the shell does not set it.
const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);

const USER = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const SOL = "nep141:sol.omft.near";
const TOKENS: AuroraToken[] = [
  { assetId: BASE_USDC, symbol: "USDC", decimals: 6, blockchain: "base", price: 1, contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  { assetId: "nep141:base.omft.near", symbol: "ETH", decimals: 18, blockchain: "base", price: 2500, contractAddress: null },
  { assetId: SOL, symbol: "SOL", decimals: 9, blockchain: "sol", price: 150, contractAddress: null },
  { assetId: "nep141:btc.omft.near", symbol: "BTC", decimals: 8, blockchain: "btc", price: 100000, contractAddress: null },
  { assetId: MONAD.USDC_ASSET, symbol: "USDC", decimals: 6, blockchain: "monad", price: 1, contractAddress: MONAD.USDC },
];

type Handler = (url: string, init: RequestInit) => { status?: number; body: unknown; headers?: Record<string, string> };
/** A fetch stub. Each call goes to the first handler whose pattern is in the URL. */
function stub(routes: [string, Handler][]) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined, headers: (init.headers ?? {}) as Record<string, string> });
    const route = routes.find(([p]) => url.includes(p));
    if (!route) return new Response(JSON.stringify({ message: "no stub" }), { status: 500 });
    const r = route[1](url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { f, calls };
}

const quoteReq = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  dry: true, swapType: "EXACT_INPUT", depositType: "ORIGIN_CHAIN", originAsset: BASE_USDC, destinationAsset: MONAD.USDC_ASSET, amount: "25000000",
  slippageTolerance: 100, refundTo: USER, refundType: "ORIGIN_CHAIN", recipient: USER, recipientType: "DESTINATION_CHAIN", ...over,
});
const quoteRes = (depositAddress?: string) => ({
  timestamp: "2026-10-13T00:00:00Z", signature: "sig", quoteRequest: quoteReq({ dry: !depositAddress }),
  quote: { timeEstimate: 30, amountIn: "25000000", amountInFormatted: "25", amountInUsd: "25", minAmountIn: "25000000", amountOut: "24941756", amountOutFormatted: "24.941756", amountOutUsd: "24.93", minAmountOut: "24692338", ...(depositAddress ? { depositAddress, deadline: new Date(Date.now() + 1800_000).toISOString() } : {}) },
});
const noSleep = { sleep: async () => {} };

describe("aurora client", () => {
  beforeEach(() => clearTokenCache());

  it("puts the key in the path and never in an error", async () => {
    const { f, calls } = stub([["/api/status/", () => ({ status: 404, body: { message: "Application key not found" } })]]);
    const err = await status("0xdep", null, { apiKey: "secret-key", fetch: f }).catch((e: Error) => e);
    expect(calls[0]!.url).toBe("https://intents-api.aurora.dev/api/status/secret-key?depositAddress=0xdep");
    expect((err as Error).message).toContain("/api/status/***");
    expect((err as Error).message).not.toContain("secret-key");
  });

  it("sends a dry quote without a key to the public 1Click API, and refuses a real one", async () => {
    const saved = process.env.AURORA_API_KEY;
    delete process.env.AURORA_API_KEY;
    const { f, calls } = stub([["/v0/quote", () => ({ body: quoteRes() })]]);
    const q = await quote(quoteReq(), { fetch: f });
    expect(calls[0]!.url).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(q.quote.amountOut).toBe("24941756");
    await expect(quote(quoteReq({ dry: false }), { fetch: f })).rejects.toThrow(/AURORA_API_KEY/);
    if (saved) process.env.AURORA_API_KEY = saved;
  });

  it("waits for Retry-After on 429, then succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    const { f, calls } = stub([["/api/quote/", () => (++n === 1 ? { status: 429, body: { message: "Rate limit exceeded" }, headers: { "retry-after": "2" } } : { body: quoteRes("0xdep") })]]);
    const q = await quote(quoteReq({ dry: false }), { apiKey: "k", fetch: f, sleep: async (ms) => { waits.push(ms); } });
    expect(calls).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(2000);
    expect(q.quote.depositAddress).toBe("0xdep");
  });

  it("does not wait an hour: a long Retry-After throws AuroraRateLimitError", async () => {
    const { f, calls } = stub([["/api/status/", () => ({ status: 429, body: { message: "Rate limit exceeded" }, headers: { "retry-after": "3600" } })]]);
    const err = await status("0xdep", null, { apiKey: "k", fetch: f, ...noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(AuroraRateLimitError);
    expect((err as AuroraRateLimitError).retryAfterMs).toBe(3_600_000);
    expect(calls).toHaveLength(1);
    expect(retryAfterMs(null)).toBe(1000);
  });

  it("caches the token list and groups origin assets by chain without Monad", async () => {
    const { f, calls } = stub([["/api/tokens/", () => ({ body: { tokens: TOKENS, asset_stats: [] } })]]);
    await listTokens({ apiKey: "k", fetch: f });
    await listTokens({ apiKey: "k", fetch: f });
    expect(calls).toHaveLength(1);
    const groups = groupByChain(TOKENS);
    expect(groups.map((g) => g.chain)).toEqual(["base", "sol", "btc"]);
    expect(groups[0]).toMatchObject({ name: "Base", evm: true, connect: true });
    expect(groups[0]!.tokens.map((t) => t.symbol)).toEqual(["ETH", "USDC"]);
    expect(groups[1]).toMatchObject({ name: "Solana", evm: false, connect: false });
  });
});

describe("deposit-and-execute steps", () => {
  it("swaps the guaranteed USDC on Curve and pays AUSD to the user", () => {
    const [approve, swap] = ausdSwapSteps(USER, 24_900_000n);
    expect(approve).toMatchObject({ to: MONAD.USDC, functionSignature: "approve(address,uint256)", parameters: [MONAD.CURVE_POOL, MIN_AMOUNT_OUT], value: "0" });
    expect(swap).toMatchObject({ to: MONAD.CURVE_POOL, functionSignature: "exchange(int128,int128,uint256,uint256,address)", parameters: ["1", "0", MIN_AMOUNT_OUT, "24900000", USER] });
    expect(() => ausdSwapSteps("not-an-address", 1n)).toThrow();
  });

  const connectStub = (realMinOut: string) => {
    const bodies: unknown[] = [];
    const { f, calls } = stub([[`/executions/${USER}`, (_u, init) => {
      const b = JSON.parse(String(init.body)) as { dry: boolean };
      bodies.push(b);
      return b.dry
        ? { body: { result: { status: "CREATED", details: { networkFee: "2037", intermediaryAddress: "0xinter" }, quote: { minAmountOut: "24690000", amountOut: "24939000" } } } }
        : { status: 201, body: { result: { id: "exec-1", status: "CREATED", details: { networkFee: "2037", intermediaryAddress: "0xinter", messageSigned: false, signingStandard: "erc191", payload: { standard: "erc191", payload_json: "{\"a\":1}", payload_bytes_base64: "" } }, quote: { minAmountOut: realMinOut, amountIn: "25000000", depositAddress: "0xdeposit", deadline: new Date(Date.now() + 600_000).toISOString() } } } };
    }]]);
    return { f, calls, bodies };
  };

  it("plans dry, then real, with a Curve minimum below get_dy", async () => {
    const { f, calls, bodies } = connectStub("24690000");
    const plan = await planAusdExecution({ wallet: USER, originAsset: BASE_USDC, amount: "25000000", deadline: "2026-12-01T00:00:00Z" }, { apiKey: "k", fetch: f, getDy: async (dx) => dx });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["x-api-key"]).toBe("k");
    expect((bodies[0] as { dry: boolean }).dry).toBe(true);
    expect(plan.minUsdcOut).toBe(24_690_000n);
    expect(plan.minAusdOut).toBe((24_690_000n * 9950n) / 10000n);
    expect((bodies[1] as { steps: { parameters: unknown[] }[] }).steps[1]!.parameters[3]).toBe(plan.minAusdOut.toString());
    expect(plan.execution.quote?.depositAddress).toBe("0xdeposit");
  });

  it("refuses an execution whose quote got worse than the swap minimum", async () => {
    const { f } = connectStub("24000000");
    await expect(planAusdExecution({ wallet: USER, originAsset: BASE_USDC, amount: "25000000", deadline: "2026-12-01T00:00:00Z" }, { apiKey: "k", fetch: f, getDy: async (dx) => dx })).rejects.toBeInstanceOf(QuoteMovedError);
  });

  it("encodes a personal_sign signature as secp256k1:base58 with v 0/1", () => {
    expect(base58(Uint8Array.from([0, 1]))).toBe("12");
    expect(base58(Uint8Array.from([0xff]))).toBe("5Q");
    const sig27 = `0x${"11".repeat(64)}1b`;
    const sig0 = `0x${"11".repeat(64)}00`;
    expect(encodeErc191Signature(sig27)).toBe(encodeErc191Signature(sig0));
    expect(encodeErc191Signature(sig27)).toMatch(/^secp256k1:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(() => encodeErc191Signature("0x1234")).toThrow();
  });
});

describe("status transitions", () => {
  const row = { deadline: new Date(Date.now() + 600_000), deposit_tx: "0xdeposit", refund_to: USER, amount_in: "25000000", origin_asset: BASE_USDC };
  const s = (status: StatusResponse["status"], details: Partial<NonNullable<StatusResponse["swapDetails"]>> = {}): StatusResponse => ({
    status, updatedAt: "2026-10-13T00:00:00Z", swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [], ...details },
  });

  it("walks PENDING_DEPOSIT -> KNOWN_DEPOSIT_TX -> PROCESSING -> SUCCESS", () => {
    expect(applySwapStatus(row, s("PENDING_DEPOSIT")).status).toBe("awaiting_deposit");
    expect(applySwapStatus(row, s("KNOWN_DEPOSIT_TX")).status).toBe("processing");
    expect(applySwapStatus(row, s("PROCESSING")).status).toBe("processing");
    const done = applySwapStatus(row, s("SUCCESS", { amountIn: "25000000", amountOut: "24941756", destinationChainTxHashes: [{ hash: "0xsettle", explorerUrl: "" }] }));
    expect(done).toMatchObject({ status: "settled", amount_out: "24941756", settled_tx: "0xsettle", error: null });
  });

  it("records a refund with the refund transaction, amount and reason", () => {
    const p = applySwapStatus(row, s("REFUNDED", { originChainTxHashes: [{ hash: "0xDEPOSIT", explorerUrl: "" }, { hash: "0xrefund", explorerUrl: "" }], refundedAmountFormatted: "25", refundReason: "Deadline passed" }));
    expect(p).toMatchObject({ status: "refunded", refund_tx: "0xrefund", refund_amount: "25", refund_reason: "Deadline passed" });
    expect(p.error).toContain(USER);
  });

  it("shows INCOMPLETE_DEPOSIT and FAILED as errors, and expires an old empty quote", () => {
    const inc = applySwapStatus(row, s("INCOMPLETE_DEPOSIT", { depositedAmountFormatted: "10" }));
    expect(inc.status).toBe("incomplete");
    expect(inc.error).toMatch(/below the quoted amount/);
    expect(applySwapStatus(row, s("FAILED")).status).toBe("failed");
    const old = { ...row, deadline: new Date(Date.now() - 3_600_000) };
    expect(applySwapStatus(old, s("PENDING_DEPOSIT")).status).toBe("expired");
    // A deposit that is already moving does not expire.
    expect(applySwapStatus(old, s("PROCESSING")).status).toBe("processing");
  });

  it("maps Intents Connect states", () => {
    expect(applyConnectStatus(row, { status: "CREATED", details: { messageSigned: false } }).status).toBe("awaiting_signature");
    expect(applyConnectStatus(row, { status: "CREATED", details: { messageSigned: true } }).status).toBe("awaiting_deposit");
    expect(applyConnectStatus(row, { status: "OPERATION_PROCESSING" }).status).toBe("processing");
    expect(applyConnectStatus(row, { status: "SUCCESS" }).status).toBe("settled");
    expect(applyConnectStatus(row, { status: "DEPOSIT_FAILED" }).status).toBe("refunded");
    expect(applyConnectStatus(row, { status: "OPERATION_FAILED" }).error).toMatch(/intermediary/);
    expect(applyConnectStatus(row, { status: "EXPIRED" }).status).toBe("expired");
  });

  it("gives fund_perpl for AUSD and needs_conversion for USDC", async () => {
    const after = { type: "perpl_open" as const, market: "BTC", side: "long" as const, leverage: 5 };
    const connect = await onSettled({ mode: "connect", amount_out: "24800000", after_action: after, settled_tx: "0xtx", recipient: USER, quote: null }, { readAusdReceived: async () => 24_990_000n });
    expect(connect).toEqual({ kind: "fund_perpl", ausd: 24.99, afterAction: after });
    const fallback = await onSettled({ mode: "connect", amount_out: "24800000", after_action: null, settled_tx: null, recipient: USER, quote: null });
    expect(fallback).toEqual({ kind: "fund_perpl", ausd: 24.8, afterAction: null });
    expect(await onSettled({ mode: "swap", amount_out: "24941756", after_action: null, settled_tx: "0xs", recipient: USER, quote: null })).toEqual({ kind: "needs_conversion", usdc: 24.941756, afterAction: null });
  });
});

// ---------- with the database ----------

const dbUrl = process.env.DATABASE_URL;
describe.skipIf(!dbUrl)("aurora deposits in the database", async () => {
  const { ensureUser, migrate, sql } = await import("../src/db");
  const { createDeposit, listDeposits, pollAuroraDeposits, submitConnectSignature } = await import("../src/auroraDeposits");
  const user = `0x${"ab".repeat(14)}${Date.now().toString(16).padStart(12, "0")}`.slice(0, 42).toLowerCase();
  const due = () => sql()`update aurora_deposits set next_poll_at = now() where user_id = ${user}`;

  let swapStatus: StatusResponse["status"] = "PENDING_DEPOSIT";
  let swapDetails: Partial<NonNullable<StatusResponse["swapDetails"]>> = {};
  let connectState = "CREATED";
  let depositN = 0;
  const { f, calls } = stub([
    ["/api/tokens/", () => ({ body: { tokens: TOKENS, asset_stats: [] } })],
    ["/api/quote/", () => ({ body: quoteRes(`0xdeposit${++depositN}${user.slice(2, 10)}`) })],
    ["/api/status/", () => ({ body: { status: swapStatus, updatedAt: "now", swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [], ...swapDetails } } })],
    [`/executions/${user}/submit`, () => ({ body: { result: "ok" } })],
    [`/executions/${user}`, (_u, init) => {
      if (init.method === "POST") {
        const b = JSON.parse(String(init.body)) as { dry: boolean };
        return b.dry
          ? { body: { result: { status: "CREATED", details: { networkFee: "2037" }, quote: { minAmountOut: "24690000" } } } }
          : { status: 201, body: { result: { id: `exec-${user}`, status: "CREATED", details: { networkFee: "2037", intermediaryAddress: "0xinter", messageSigned: false, payload: { standard: "erc191", payload_json: "{}", payload_bytes_base64: "" } }, quote: { minAmountOut: "24690000", amountIn: "25000000", depositAddress: `0xconnect${user.slice(2, 10)}`, deadline: new Date(Date.now() + 600_000).toISOString() } } } };
      }
      return { body: { result: [{ id: `exec-${user}`, status: connectState, details: { messageSigned: connectState !== "CREATED", ...(connectState === "SUCCESS" ? { txHash: `0x${"ab".repeat(32)}` } : {}) } }] } };
    }],
  ]);
  const o: AuroraOptions = { apiKey: "test-key", fetch: f, sleep: async () => {}, getDy: async (dx) => dx };

  beforeAll(async () => {
    await migrate();
    await ensureUser(user);
  });
  beforeEach(() => clearTokenCache());
  afterAll(async () => {
    await sql()`delete from aurora_deposits where user_id = ${user}`;
    await sql()`delete from users where id = ${user}`;
    await sql().end();
  });

  it("settles a Solana deposit as USDC that needs conversion", async () => {
    const d = await createDeposit(user, { originAsset: SOL, amount: "0.2", refundTo: "So1anaRefundAddress1111111111111111111111111", afterAction: { type: "perpl_deposit" } }, o);
    expect(d).toMatchObject({ mode: "swap", status: "awaiting_deposit", recipient: user, amountIn: "25000000" });
    const quoteCall = calls.find((c) => c.url.includes("/api/quote/"))!;
    expect(quoteCall.body).toMatchObject({ dry: false, originAsset: SOL, destinationAsset: MONAD.USDC_ASSET, amount: "200000000", recipient: user, refundType: "ORIGIN_CHAIN" });

    await due();
    swapStatus = "PROCESSING";
    let r = await pollAuroraDeposits({ userId: user, aurora: o });
    expect(r.changed).toEqual([{ id: d.id, from: "awaiting_deposit", to: "processing" }]);

    await due();
    swapStatus = "SUCCESS";
    swapDetails = { amountOut: "24941756", destinationChainTxHashes: [{ hash: "0xsettled", explorerUrl: "" }] };
    r = await pollAuroraDeposits({ userId: user, aurora: o });
    expect(r.settled).toHaveLength(1);
    expect(r.settled[0]!.next).toEqual({ kind: "needs_conversion", usdc: 24.941756, afterAction: { type: "perpl_deposit" } });
    const [row] = await listDeposits(user);
    expect(row).toMatchObject({ status: "settled", settledTx: "0xsettled", amountOut: "24941756" });

    await due();
    expect((await pollAuroraDeposits({ userId: user, aurora: o })).polled).toBe(0); // terminal rows are not polled
  });

  it("records a refund, and lets only one of two workers poll a row", async () => {
    swapStatus = "PENDING_DEPOSIT";
    swapDetails = {};
    const d = await createDeposit(user, { originAsset: "nep141:btc.omft.near", amount: "0.0003", refundTo: "bc1qrefund" }, o);
    await due();
    swapStatus = "REFUNDED";
    swapDetails = { originChainTxHashes: [{ hash: "0xbtcdeposit", explorerUrl: "" }, { hash: "0xbtcrefund", explorerUrl: "" }], refundedAmountFormatted: "0.0003", refundReason: "Quote expired" };
    const statusCallsBefore = calls.filter((c) => c.url.includes("/api/status/")).length;
    const [a, b] = await Promise.all([pollAuroraDeposits({ userId: user, aurora: o, workerId: "w1" }), pollAuroraDeposits({ userId: user, aurora: o, workerId: "w2" })]);
    expect(a.polled + b.polled).toBe(1);
    expect(calls.filter((c) => c.url.includes("/api/status/")).length - statusCallsBefore).toBe(1);
    const row = (await listDeposits(user)).find((x) => x.id === d.id)!;
    expect(row).toMatchObject({ status: "refunded", refundTx: "0xbtcrefund", refundAmount: "0.0003", refundReason: "Quote expired" });
  });

  it("runs an Intents Connect deposit to AUSD: sign, deposit, fund_perpl", async () => {
    const d = await createDeposit(user, { originAsset: BASE_USDC, amount: "25", refundTo: user, afterAction: { type: "perpl_open", market: "BTC", side: "long", leverage: 5 } }, o);
    expect(d).toMatchObject({ mode: "connect", status: "awaiting_signature", executionId: `exec-${user}`, intermediary: "0xinter", destinationAsset: MONAD.AUSD });
    expect(d.signPayload?.standard).toBe("erc191");
    await expect(createDeposit(user, { originAsset: BASE_USDC, amount: "25", refundTo: user, mode: "connect" }, o)).rejects.toThrow(/one at a time/);

    const signed = await submitConnectSignature(user, d.id, `0x${"22".repeat(64)}1c`, o);
    expect(signed.status).toBe("awaiting_deposit");
    expect(calls.find((c) => c.url.endsWith("/submit"))!.body).toMatchObject({ executionId: `exec-${user}`, signature: expect.stringMatching(/^secp256k1:/) });

    await due();
    connectState = "SUCCESS";
    const r = await pollAuroraDeposits({ userId: user, aurora: o, readAusdReceived: async () => 24_950_000n });
    expect(r.settled[0]!.deposit.settledTx).toBe(`0x${"ab".repeat(32)}`);
    expect(r.settled[0]!.next).toEqual({ kind: "fund_perpl", ausd: 24.95, afterAction: { type: "perpl_open", market: "BTC", side: "long", leverage: 5 } });
  });

  it("rate limiting reschedules the claimed rows", async () => {
    swapStatus = "PENDING_DEPOSIT";
    const d = await createDeposit(user, { originAsset: SOL, amount: "0.1", refundTo: "So1ana" }, o);
    await due();
    const limited = stub([["/api/status/", () => ({ status: 429, body: { message: "Rate limit exceeded" }, headers: { "retry-after": "900" } })]]);
    const r = await pollAuroraDeposits({ userId: user, aurora: { ...o, fetch: limited.f } });
    expect(r.rateLimitedMs).toBe(900_000);
    const [row] = await sql()<{ next_poll_at: Date; status: string }[]>`select next_poll_at, status from aurora_deposits where id = ${d.id}`;
    expect(row!.status).toBe("awaiting_deposit");
    expect(row!.next_poll_at.getTime()).toBeGreaterThan(Date.now() + 800_000);
  });
});
