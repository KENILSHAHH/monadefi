// Routes of the mobile app: Mera sign-in, the scoped trading session, gasless relays, balances, markets and trades.
// Contract: docs/api-mobile.md. Every route except /auth/mera/* needs a session token (set by the auth middleware of server.ts).
import { Hono } from "hono";
import { erc20Abi, formatUnits, type Address, type Hex } from "viem";
import { z } from "zod";
import { aurora, auroraDeposits, auroraWorker, buildTools, config, gasless, getIntent, getOrCreateWallet, jobs, listIntents, perpl, publicClient, risk, session, sql, USDC, type Intent } from "@app/core";

type Env = { Variables: { userId: string } };
export const mobile = new Hono<Env>();

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const fail = (err: unknown, status: 400 | 409 = 400) => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });

// ── Mera sign-in (no session token yet) ─────────────────────────────────────
export const meraAuth = new Hono();
meraAuth.post("/challenge", async (c) => c.json(session.meraChallenge(z.object({ address: Address }).parse(await c.req.json()).address)));
meraAuth.post("/verify", async (c) => {
  const body = z.object({ address: Address, nonce: z.string(), signature: Hex }).parse(await c.req.json());
  return session.meraVerify(body).then((r) => c.json(r), (err) => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 401 }));
});

/** Mobile routes act on a Mera wallet only. A web user keeps the web routes. The check is on these paths only: a "*" middleware would run for every route of the app. */
for (const p of ["/session", "/session/*", "/relay/*", "/balance", "/activity", "/perpl/*", "/trade/*", "/risk/*", "/deposit/aurora", "/deposit/aurora/*"])
  mobile.use(p, async (c, next) => {
    if (!(await session.isMeraUser(c.get("userId")))) return c.json({ error: "This account did not sign in with a passkey." }, 403);
    await next();
  });

// ── Session ──────────────────────────────────────────────────────────────────
mobile.get("/session", async (c) => c.json(await session.sessionStatus(c.get("userId"))));

mobile.post("/session/upgrade", async (c) => {
  const { authorization } = z.object({
    authorization: z.object({ address: Address, chainId: z.number().int(), nonce: z.number().int().min(0), r: Hex, s: Hex, yParity: z.number().int().min(0).max(1) }),
  }).parse(await c.req.json());
  return session.relayUpgrade(c.get("userId"), { ...authorization, address: authorization.address as Address, r: authorization.r as Hex, s: authorization.s as Hex }).then((r) => c.json(r), (e) => fail(e));
});

mobile.post("/session/start", async (c) => {
  const { days } = z.object({ days: z.number().int().min(1).max(90).default(30) }).parse(await c.req.json().catch(() => ({})));
  if (!(await session.isUpgraded(c.get("userId")))) return c.json({ error: "Upgrade the wallet first (POST /session/upgrade)." }, 409);
  return c.json(await session.startSession(c.get("userId"), days));
});

mobile.post("/session/grant", async (c) => {
  const body = z.object({ id: z.string(), signature: Hex }).parse(await c.req.json());
  return session.grantSession(c.get("userId"), body.id, body.signature).then((p) => c.json(p), (e) => fail(e));
});

mobile.delete("/session", async (c) => c.json(await session.revokeSession(c.get("userId"))));

// ── Relay: gasless calls that the phone signs ────────────────────────────────
mobile.post("/relay/prepare", async (c) => {
  const { calls } = z.object({ calls: z.array(z.object({ to: Address, data: Hex, value: z.string().regex(/^\d+$/).default("0"), description: z.string().min(3).max(200) })).min(1).max(10) }).parse(await c.req.json());
  if (!(await session.isUpgraded(c.get("userId")))) return c.json({ error: "Upgrade the wallet first (POST /session/upgrade)." }, 409);
  return gasless.prepareRelay(c.get("userId"), calls.map((x) => ({ ...x, to: x.to as Address, data: x.data as Hex }))).then((r) => c.json(r), (e) => fail(e));
});

mobile.post("/relay/send", async (c) => {
  const body = z.object({ id: z.string(), signature: Hex }).parse(await c.req.json());
  return gasless.sendRelay(c.get("userId"), body.id, body.signature).then((r) => c.json(r), (e) => fail(e));
});

// ── Balance and activity ─────────────────────────────────────────────────────
mobile.get("/balance", async (c) => {
  const address = c.get("userId") as Address;
  const client = publicClient("monad");
  const usdc = USDC.monad!;
  const [account, ausdWallet, usdcRaw, mon] = await Promise.all([
    perpl.getAccount(address),
    perpl.walletAusd(address),
    client.readContract({ address: usdc.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    client.getBalance({ address }),
  ]);
  const inPositions = account.positions.reduce((s, p) => s + p.marginUsd + p.unrealizedPnl, 0);
  const usdcAmount = Number(formatUnits(usdcRaw, usdc.decimals));
  const ausdTotal = ausdWallet + account.balanceUsd + inPositions;
  return c.json({
    address, asOf: new Date().toISOString(),
    ausd: { wallet: ausdWallet, perplFree: account.freeUsd, perplLocked: account.lockedUsd, inPositions, total: ausdTotal },
    usdc: usdcAmount, mon: Number(formatUnits(mon, 18)),
    // MON is not priced here; the total is the stablecoins.
    totalUsd: ausdTotal + usdcAmount,
  });
});

mobile.get("/activity", async (c) => {
  const userId = c.get("userId");
  const [intents, jobList, relays] = await Promise.all([
    listIntents(userId, 30),
    jobs.listJobs(userId, true),
    sql()<{ id: string; calls: { description: string }[]; status: string; hash: string | null; created_at: Date }[]>`select id, calls, status, hash, created_at from relays where user_id = ${userId} order by created_at desc limit 20`,
  ]);
  const explorerOf = (i: Intent) => (i.result?.explorer as string | undefined) ?? ((i.result?.receipts as { explorer: string }[] | undefined)?.at(-1)?.explorer ?? null);
  const items = [
    ...intents.map((i) => ({ kind: i.kind === "job_create" ? "job" : "trade", title: String(i.preview.summary ?? i.preview.market ?? i.kind), status: i.status, at: i.createdAt, explorer: explorerOf(i) })),
    ...jobList.map((j) => ({ kind: "job", title: j.name, status: j.status, at: j.createdAt, explorer: null })),
    ...relays.map((r) => ({ kind: "relay", title: r.calls.map((x) => x.description).join(", "), status: r.status, at: r.created_at.toISOString(), explorer: r.hash ? `https://monadscan.com/tx/${r.hash}` : null })),
  ];
  return c.json(items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60));
});

// ── Markets ──────────────────────────────────────────────────────────────────
mobile.get("/perpl/markets", async (c) => c.json({ markets: await perpl.findMarkets() }));
mobile.get("/perpl/markets/:symbol/book", async (c) => perpl.getBook(c.req.param("symbol"), Number(c.req.query("levels") ?? 10)).then((r) => c.json(r), (e) => fail(e)));
mobile.get("/perpl/markets/:symbol/candles", async (c) =>
  perpl.getCandles(c.req.param("symbol"), Number(c.req.query("res") ?? 3600), Number(c.req.query("hours") ?? 24)).then((r) => c.json(r), (e) => fail(e)));

// ── Risk (Nansen) ────────────────────────────────────────────────────────────
mobile.post("/risk/check", async (c) => {
  const body = z.object({ market: z.string(), side: z.enum(["long", "short"]), leverage: z.number().min(1), marginUsd: z.number().positive() }).parse(await c.req.json());
  const m = await perpl.getMarket(body.market);
  const verdict = await risk.assessTrade({ apiKey: config().NANSEN_API_KEY, market: m.symbol, side: body.side, leverage: body.leverage, marginUsd: body.marginUsd, marketMaxLeverage: m.maxLeverage, trader: c.get("userId"), maxCredits: config().NANSEN_MAX_CREDITS });
  const gated = risk.applyVerdict({ leverage: body.leverage, marginUsd: body.marginUsd, stopLossPx: null }, verdict, { entryPx: m.markPx });
  return c.json({ ...verdict, applied: gated.order, changes: gated.changes, blocked: gated.blocked, markPx: m.markPx });
});

// ── Deposits from any chain (Aurora Intents) ────────────────────────────────
/** The deposit row, plus the step after settlement and a progress list for the app. */
async function withAfter(d: auroraDeposits.AuroraDeposit) {
  const [r] = await sql()<{ after_status: string | null; after_result: unknown }[]>`select after_status, after_result from aurora_deposits where id = ${d.id}`;
  const after = r?.after_status ?? null;
  const done = (s: string[]) => s.includes(d.status);
  const steps = [
    { label: d.mode === "connect" ? "Sign once" : "Address ready", done: d.status !== "awaiting_signature" },
    { label: "Deposit seen", done: done(["processing", "settled"]) },
    { label: d.mode === "connect" ? "Arrived on Monad as AUSD" : "Arrived on Monad as USDC", done: d.status === "settled" },
    ...(d.mode !== "connect" ? [{ label: "Changed to AUSD", done: after === "converted" || after === "funded" || after === "opened" }] : []),
    { label: d.afterAction?.type === "perpl_open" ? "Position opened on Perpl" : "Ready to trade", done: after === "funded" || after === "opened" || after === "ready" || after === "converted" },
  ];
  return { ...d, afterStatus: after, afterResult: r?.after_result ?? null, steps };
}

mobile.get("/deposit/aurora/assets", async (c) => c.json({ chains: await aurora.originAssetsByChain() }));

mobile.post("/deposit/aurora/quote", async (c) => {
  const body = z.object({ assetId: z.string(), amount: z.string().regex(/^\d+(\.\d+)?$/) }).parse(await c.req.json());
  const token = (await aurora.listTokens()).find((t) => t.assetId === body.assetId);
  if (!token) return c.json({ error: "Aurora does not list this asset." }, 400);
  const amount = BigInt(Math.round(Number(body.amount) * 10 ** token.decimals)).toString();
  return aurora.quote({ dry: true, swapType: "EXACT_INPUT", depositType: "ORIGIN_CHAIN", amount, originAsset: body.assetId, destinationAsset: aurora.MONAD.USDC_ASSET, slippageTolerance: 100, refundTo: c.get("userId"), refundType: "ORIGIN_CHAIN", recipient: c.get("userId"), recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 3_600_000).toISOString() } as never)
    .then((q) => c.json(q), (e) => fail(e));
});

mobile.post("/deposit/aurora", async (c) => {
  const raw = (await c.req.json()) as Record<string, unknown>;
  // The app sends `assetId` and `after` (docs/api-mobile.md); the deposit module names them originAsset and afterAction.
  const input = auroraDeposits.CreateDepositInput.parse({ ...raw, originAsset: raw.originAsset ?? raw.assetId, afterAction: raw.afterAction ?? raw.after });
  return auroraDeposits.createDeposit(c.get("userId"), input).then(async (d) => c.json({ deposit: await withAfter(d) }), (e) => fail(e));
});

mobile.get("/deposit/aurora", async (c) => c.json({ deposits: await Promise.all((await auroraDeposits.listDeposits(c.get("userId"), 30)).map(withAfter)) }));

mobile.get("/deposit/aurora/:id", async (c) => {
  const d = await auroraDeposits.getDeposit(c.get("userId"), c.req.param("id"));
  return d ? c.json({ deposit: await withAfter(d) }) : c.json({ error: "Unknown deposit." }, 404);
});

/** Intents Connect: the phone signs the execution payload once (personal_sign). */
mobile.post("/deposit/aurora/:id/signature", async (c) => {
  const { signature } = z.object({ signature: Hex }).parse(await c.req.json());
  return auroraDeposits.submitConnectSignature(c.get("userId"), c.req.param("id"), signature).then(async (d) => c.json({ deposit: await withAfter(d) }), (e) => fail(e));
});

/** The origin-chain transaction hash, when the app sent the deposit itself. It speeds up the settlement. */
mobile.post("/deposit/aurora/:id/tx", async (c) => {
  const { txHash } = z.object({ txHash: z.string().min(10) }).parse(await c.req.json());
  return auroraDeposits.submitDepositTx(c.get("userId"), c.req.param("id"), txHash).then(async (d) => c.json({ deposit: await withAfter(d) }), (e) => fail(e));
});

mobile.post("/deposit/aurora/:id/refresh", async (c) => {
  const userId = c.get("userId");
  const r = await auroraDeposits.pollAuroraDeposits({ userId });
  for (const s of r.settled) await auroraWorker.runAfterStep(s.deposit, s.next);
  const d = await auroraDeposits.getDeposit(userId, c.req.param("id"));
  return d ? c.json({ deposit: await withAfter(d) }) : c.json({ error: "Unknown deposit." }, 404);
});

/** USDC arrived (a non-EVM source): prepare the Curve USDC -> AUSD swap for the phone to sign through the relay. */
mobile.post("/deposit/aurora/:id/convert", async (c) => {
  const userId = c.get("userId");
  const d = await auroraDeposits.getDeposit(userId, c.req.param("id"));
  if (!d || d.status !== "settled" || d.nextStep?.kind !== "needs_conversion") return c.json({ error: "This deposit has no USDC to convert." }, 409);
  if (!(await session.isUpgraded(userId))) return c.json({ error: "Upgrade the wallet first (POST /session/upgrade)." }, 409);
  const calls = await auroraWorker.conversionCalls(userId as `0x${string}`, d.nextStep.usdc);
  return c.json(await gasless.prepareRelay(userId, calls));
});

/** After the phone sent the conversion relay: mark it, and fund Perpl when the session is on. */
mobile.post("/deposit/aurora/:id/converted", async (c) => {
  const userId = c.get("userId");
  const d = await auroraDeposits.getDeposit(userId, c.req.param("id"));
  if (!d || d.nextStep?.kind !== "needs_conversion") return c.json({ error: "Unknown deposit." }, 404);
  const ausd = await perpl.walletAusd(userId as `0x${string}`);
  await auroraWorker.runAfterStep(d, { kind: "fund_perpl", ausd: Math.min(ausd, d.nextStep.usdc), afterAction: d.afterAction });
  const [r] = await sql()<{ after_status: string }[]>`select after_status from aurora_deposits where id = ${d.id}`;
  if (r?.after_status === "ready" || r?.after_status === "needs_session") await sql()`update aurora_deposits set after_status = 'converted' where id = ${d.id}`;
  return c.json({ deposit: await withAfter((await auroraDeposits.getDeposit(userId, d.id))!) });
});

// ── Trades ───────────────────────────────────────────────────────────────────
/**
 * Run a typed agent tool as a preview: the intent is created and waits for the confirm route. The tool applies the same checks
 * (market rules, the Nansen risk verdict, simulation) as when the agent calls it.
 */
async function previewWithTool(userId: string, name: string, args: unknown) {
  const wallet = { ...(await getOrCreateWallet(userId)), autoExecute: false };
  let created: Intent | null = null;
  const tool = buildTools({ userId, wallet, onIntent: (i) => (created ??= i) }).find((t) => t.name === name)!;
  const out = await tool.handler(tool.schema.parse(args));
  const text = out.content.map((x) => x.text).join("");
  if (out.isError || text.startsWith("Error:")) throw new Error(text.replace(/^Error:\s*/, ""));
  const intent = created ? await getIntent((created as Intent).id, userId) : null;
  if (!intent) throw new Error("No action was prepared.");
  return intent;
}

const TradeBody = z.object({
  market: z.string(), side: z.enum(["long", "short"]), leverage: z.number().min(1), marginUsd: z.number().positive(),
  orderType: z.enum(["market", "limit"]).default("market"), limitPx: z.number().positive().optional(), postOnly: z.boolean().optional(),
  stopLossPx: z.number().positive().optional(), takeProfitPx: z.number().positive().optional(),
});

mobile.post("/trade/preview", async (c) => {
  const body = TradeBody.parse(await c.req.json());
  try {
    const intent = await previewWithTool(c.get("userId"), "perpl_open_position", body);
    const p = intent.preview as Record<string, unknown>;
    return c.json({ intent, risk: p.risk ?? null, requested: p.requested ?? body, applied: p.applied ?? null, changes: (p.riskChanges as string[] | undefined) ?? [] });
  } catch (err) {
    const risk = (err as { risk?: unknown }).risk;
    return Response.json({ error: err instanceof Error ? err.message : String(err), ...(risk ? { risk } : {}) }, { status: 409 });
  }
});

mobile.post("/trade/close", async (c) => {
  const body = z.object({ market: z.string(), fraction: z.number().gt(0).max(1).default(1) }).parse(await c.req.json());
  return previewWithTool(c.get("userId"), "perpl_close_position", body).then((intent) => c.json({ intent }), (e) => fail(e, 409));
});
