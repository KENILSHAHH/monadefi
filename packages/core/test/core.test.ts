import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { estimateLiquidationPx, orderDesc, toLNS, toPNS, type PerplMarket, type PerplPosition } from "../src/adapters/perpl";
import { parametersOf, tool, callTool } from "../src/agent/tool";
import { modelCostUsd, promptPriceUsd } from "../src/billing/pricing";
import { sha256Hex, signToken, stableStringify, verifyToken, encrypt, decrypt } from "../src/crypto";
import { ensureUser, migrate, sql } from "../src/db";
import { claimFiring, createGuard, evaluatePerpGuard, normalizePerpParams, superviseDecision } from "../src/guards";
import { createIntent, transition } from "../src/intents";

process.env.KEY_ENCRYPTION_SECRET ??= "test-secret";

const position = (over: Partial<PerplPosition>): PerplPosition => ({
  market: "BTC", marketId: 1, side: "long", size: 0.01, entryPx: 80_000, markPx: 80_000, markPriceValid: true, marginUsd: 160, notionalUsd: 800,
  leverage: 5, unrealizedPnl: 0, liquidationPx: 67_200, distanceToLiquidation: 0.16, ...over,
});
const btc = { id: 1, symbol: "BTC", priceDecimals: 1, sizeDecimals: 5 } as PerplMarket;

describe("perpl order math", () => {
  it("scales prices to the market decimals", () => {
    expect(toPNS(btc, 83_500.24)).toBe(835_002n);
  });
  it("rounds sizes down to whole lots", () => {
    expect(toLNS(btc, 0.0011999)).toBe(119n);
    expect(toLNS(btc, 0.0012)).toBe(120n);
    expect(toLNS(btc, 0.000009)).toBe(0n);
  });
  it("puts a long liquidation price below entry and a short one above", () => {
    const args = { entryPx: 80_000, size: 0.01, marginUsd: 160, maintenanceMargin: 0.04 };
    const long = estimateLiquidationPx({ ...args, isLong: true });
    const short = estimateLiquidationPx({ ...args, isLong: false });
    // 5x long, 4% maintenance: 80000 + (32 - 160) / 0.01 = 67200.
    expect(long).toBeCloseTo(67_200, 6);
    expect(short).toBeCloseTo(92_800, 6);
  });
  it("fills every OrderDesc field, with no market price of 0", () => {
    const d = orderDesc({ perpId: 1n, orderType: 0, pricePNS: 835_002n, lotLNS: 100n, immediateOrCancel: true });
    expect(Object.keys(d)).toHaveLength(15);
    expect(d).toMatchObject({ orderId: 0n, maxMatches: 0n, postOnly: false, immediateOrCancel: true, maxNegPnlCollatBPS: 300n });
  });
});

describe("agent tools", () => {
  const t = tool("demo", "A demo tool.", { a: z.number(), b: z.string().default("x") }, async (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }));
  it("gives the model a JSON schema where a default makes a field optional", () => {
    const schema = parametersOf(t) as { type: string; required?: string[] };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["a"]);
  });
  it("returns bad arguments to the model as an error", async () => {
    expect((await callTool(t, '{"a":"no"}')).isError).toBe(true);
    expect((await callTool(t, "{")).isError).toBe(true);
    expect((await callTool(t, '{"a":1}')).content[0]!.text).toBe('{"a":1,"b":"x"}');
  });
});

describe("guard trigger", () => {
  const params = normalizePerpParams({ market: "BTC", triggerDistancePct: 5, action: "partial_deleverage" });
  it("always allows a full close as the last resort", () => {
    expect(params.allowedActions).toEqual(["partial_deleverage", "full_close"]);
  });
  it("is safe above the trigger distance", () => {
    expect(evaluatePerpGuard(params, position({})).state).toBe("safe");
  });
  it("triggers at or below the trigger distance", () => {
    expect(evaluatePerpGuard(params, position({ markPx: 70_000, distanceToLiquidation: 0.04 })).state).toBe("triggered");
  });
  it("reports a closed position", () => {
    expect(evaluatePerpGuard(params, null).state).toBe("closed");
    expect(evaluatePerpGuard(params, position({ size: 0 })).state).toBe("closed");
  });
  it("uses the default action when the model is not available", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const d = await superviseDecision(params, position({}));
    expect(d).toMatchObject({ action: "partial_deleverage", source: "default" });
    if (saved) process.env.OPENAI_API_KEY = saved;
  });
});

describe("pricing", () => {
  it("measures the model cost of a prompt", () => {
    // 5,000 plain input at 10, 5,000 cached at 1, 2,000 output at 50, per million tokens, plus one web search.
    const cost = modelCostUsd("gpt-6-astra", { inputTokens: 10_000, cachedInputTokens: 5_000, cacheWriteTokens: 0, outputTokens: 2_000, webSearchCalls: 1 });
    expect(cost).toBeCloseTo(0.05 + 0.005 + 0.1 + 0.01, 6);
  });
  it("charges nothing for a prompt while prompts are free", () => {
    expect(promptPriceUsd()).toBe(0);
  });
  it("prices an unknown model at the highest rate", () => {
    expect(modelCostUsd("some-new-model", { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 })).toBe(10);
  });
});

describe("crypto", () => {
  it("hashes the same intent the same way for any key order", () => {
    expect(sha256Hex(stableStringify({ a: 1, b: { d: 2, c: 3 } }))).toBe(sha256Hex(stableStringify({ b: { c: 3, d: 2 }, a: 1 })));
  });
  it("rejects a changed token and an expired token", () => {
    const t = signToken({ sub: "0xabc" }, 60);
    expect(verifyToken(t)?.sub).toBe("0xabc");
    // Change the first character of the signature. The last character of base64url holds unused bits, so a change there can decode to the same bytes.
    const [body, mac] = t.split(".") as [string, string];
    expect(verifyToken(`${body}.${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`)).toBeNull();
    expect(verifyToken(signToken({ sub: "0xabc" }, -1))).toBeNull();
  });
  it("encrypts and decrypts an agent key", () => {
    expect(decrypt(encrypt("0xsecret"))).toBe("0xsecret");
    expect(encrypt("0xsecret")).not.toContain("secret");
  });
});

describe("database guarantees", () => {
  const user = `0xtest${Date.now().toString(16)}`;
  afterAll(async () => {
    await sql()`delete from guard_actions where guard_id in (select id from guards where user_id = ${user})`;
    await sql()`delete from guards where user_id = ${user}`;
    await sql()`delete from intents where user_id = ${user}`;
    await sql()`delete from users where id = ${user}`;
    await sql().end();
  });

  it("lets exactly one of two watchers claim a firing", async () => {
    await migrate();
    await ensureUser(user);
    const guard = await createGuard(user, "perpl", normalizePerpParams({ market: "BTC", triggerDistancePct: 5, action: "full_close" }));
    const claims = await Promise.all([claimFiring(guard, "watcher-a"), claimFiring(guard, "watcher-b")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("executes a confirmed intent once when confirm arrives twice", async () => {
    const intent = await createIntent({ userId: user, kind: "perpl", params: { op: { op: "close", market: "BTC", fraction: 1, orderKind: "market" } }, preview: {} });
    const results = await Promise.all([
      transition(intent.id, user, "pending", "executing"),
      transition(intent.id, user, "pending", "executing"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("does not let another user touch an intent", async () => {
    const intent = await createIntent({ userId: user, kind: "perpl", params: { op: { op: "close", market: "ETH", fraction: 1, orderKind: "market" } }, preview: {} });
    expect(await transition(intent.id, "0xsomeoneelse", "pending", "executing")).toBeNull();
  });
});

describe("mera session scope", () => {
  it("names the exact selectors that the Perpl transactions use, and no withdrawal", async () => {
    const { toFunctionSelector } = await import("viem");
    const { PERPL_SESSION_FUNCTIONS } = await import("../src/session");
    const p = await import("../src/adapters/perpl");
    const allowed = new Set(PERPL_SESSION_FUNCTIONS.map((f) => toFunctionSelector(f)));
    const m = { id: 1, symbol: "BTC", priceDecimals: 1, sizeDecimals: 5, maxLeverage: 15 } as never;
    const order = p.execOrderTx({ perpId: 1n, orderType: 0, pricePNS: 1n, lotLNS: 1n }, "order").data.slice(0, 10);
    expect(allowed.has(order as `0x${string}`)).toBe(true);
    expect(allowed.has(p.addMarginTx(m, 1).data.slice(0, 10) as `0x${string}`)).toBe(true);
    expect(allowed.has(p.removeMarginTx(m, 1).data.slice(0, 10) as `0x${string}`)).toBe(true);
    expect(allowed.has(p.withdrawTx(1).data.slice(0, 10) as `0x${string}`)).toBe(false);
  });
});
