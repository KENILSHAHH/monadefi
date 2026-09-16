import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { verifyMessage } from "viem";
import { z } from "zod";
import {
  config, ensureUser, executeIntent, getDepositWallet, getIntent, getOrCreateWallet, getPositions, isExpired, listIntents,
  migrate, privyEnabled, sponsorAddress, syncDepositWallet, privySignIn, promptPriceUsd, runChatAgent, sendToRun, ChatRecorder, activeRecorders, listChats, getChat, deleteChat, signToken, sql, transition, updateWalletSettings, verifyToken, withdrawToOwner, type AgentEvent,
} from "@app/core";
import { jobs, lifi, auroraWorker } from "@app/core";
import { cancelGuard, listGuards } from "@app/core/guards";
import { meraAuth, mobile } from "./mobile";

type Env = { Variables: { userId: string } };
const app = new Hono<Env>();
app.use("*", cors({ origin: (o) => o ?? "*", credentials: true }));

app.get("/health", (c) => c.json({ ok: true, privy: privyEnabled(), gasSponsor: sponsorAddress(), model: config().OPENAI_MODEL }));

// ── Sign-in through Privy ───────────────────────────────────────────────────
// The browser sends its Privy access token. The server returns the session token of this app.
app.post("/auth/privy", async (c) => {
  if (!privyEnabled()) return c.json({ error: "PRIVY_APP_ID and PRIVY_APP_SECRET are not set on the server. Add them to .env and restart the API." }, 503);
  const { accessToken } = z.object({ accessToken: z.string().min(1).max(4096) }).parse(await c.req.json());
  const result = await privySignIn(accessToken);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ token: signToken({ sub: result.userId, aud: "session" }, 7 * 86_400), address: result.userId });
});

// ── Sign-in with a wallet signature. For scripts on a server without Privy. Off when Privy is on. ──
const SIGN_IN_TEXT = (address: string, nonce: string) => `Sign in to Mona-DeFi.\n\nAddress: ${address}\nNonce: ${nonce}\n\nThis signature does not move funds.`;

app.post("/auth/nonce", async (c) => {
  if (privyEnabled()) return c.json({ error: "Sign in through Privy." }, 404);
  const { address } = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(await c.req.json());
  const nonce = signToken({ address: address.toLowerCase(), aud: "nonce" }, 300);
  return c.json({ nonce, message: SIGN_IN_TEXT(address.toLowerCase(), nonce) });
});

app.post("/auth/verify", async (c) => {
  if (privyEnabled()) return c.json({ error: "Sign in through Privy." }, 404);
  const body = z.object({ address: z.string(), nonce: z.string(), signature: z.string() }).parse(await c.req.json());
  const address = body.address.toLowerCase();
  const claims = verifyToken<{ address: string; aud: string }>(body.nonce);
  if (!claims || claims.aud !== "nonce" || claims.address !== address) return c.json({ error: "The nonce is invalid or expired." }, 401);
  const valid = await verifyMessage({ address: address as `0x${string}`, message: SIGN_IN_TEXT(address, body.nonce), signature: body.signature as `0x${string}` });
  if (!valid) return c.json({ error: "The signature does not match the address." }, 401);
  await ensureUser(address);
  return c.json({ token: signToken({ sub: address, aud: "session" }, 7 * 86_400), address });
});

// ── Sign-in with a Mera passkey wallet (the mobile app) ─────────────────────
app.route("/auth/mera", meraAuth);

const auth = async (c: Context<Env>, next: () => Promise<void>) => {
  const claims = verifyToken<{ sub: string; aud: string }>(c.req.header("authorization")?.replace(/^Bearer /, ""));
  if (!claims || claims.aud !== "session") return c.json({ error: "Sign in first." }, 401);
  c.set("userId", claims.sub);
  await next();
};
for (const p of ["/me", "/wallet", "/wallet/*", "/positions", "/chat", "/chat/*", "/chats", "/chats/*", "/intents", "/intents/*", "/guards", "/guards/*", "/billing", "/billing/*", "/deposit", "/deposit/*", "/jobs", "/jobs/*", "/session", "/session/*", "/relay/*", "/balance", "/activity", "/perpl/*", "/trade/*", "/risk/*"]) app.use(p, auth);
app.route("/", mobile);

// ── Account and agent wallet ───────────────────────────────────────────────
app.get("/me", async (c) => {
  const userId = c.get("userId");
  const cfg = config();
  return c.json({
    address: userId,
    wallet: await getOrCreateWallet(userId),
    deposit: await getDepositWallet(userId).then(({ address, enabled, signerId }) => ({ address, enabled, signerId })),
    pricing: { promptUsd: promptPriceUsd(), actionUsd: cfg.PRICE_ACTION_USD, guardMinuteUsd: cfg.PRICE_GUARD_MINUTE_USD },
  });
});

app.post("/wallet/settings", async (c) => {
  const body = z.object({ autoExecute: z.boolean().optional(), maxActionUsd: z.number().positive().max(1_000_000).optional() }).parse(await c.req.json());
  return c.json(await updateWalletSettings(c.get("userId"), body));
});

// Funds leave the agent wallet to the sign-in address only. No other destination is possible on this route.
app.post("/wallet/withdraw", async (c) => {
  const body = z.object({ chain: z.literal("monad"), asset: z.enum(["USDC", "MON"]), amount: z.number().positive() }).parse(await c.req.json());
  return c.json(await withdrawToOwner(c.get("userId"), body));
});

// A wrong signature or a wrong state is the caller's error, not a server error.
const badRequest = (err: unknown) => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });

/** The tokens of the wallet plus the tokens in the legacy key, when that is a different address. */
const assetCache = new Map<string, { at: number; value: Promise<Awaited<ReturnType<typeof lifi.allWalletAssets>>> }>();
async function withLegacy(address: string, legacy: string, minUsd: number) {
  // The deposit window polls every 5 seconds. A 4-second cache keeps that from multiplying the LI.FI and RPC calls.
  const key = `${address}:${legacy}:${minUsd}`;
  const hit = assetCache.get(key);
  if (hit && Date.now() - hit.at < 4_000) return hit.value;
  const value = readWithLegacy(address, legacy, minUsd);
  assetCache.set(key, { at: Date.now(), value });
  value.catch(() => assetCache.delete(key));
  return value;
}
async function readWithLegacy(address: string, legacy: string, minUsd: number) {
  if (address.toLowerCase() === legacy.toLowerCase()) return lifi.allWalletAssets(address, minUsd);
  const [main, old] = await Promise.all([lifi.allWalletAssets(address, minUsd), lifi.allWalletAssets(legacy, minUsd).catch(() => null)]);
  const extra = (old ?? []).map((a) => ({ ...a, chainName: `${a.chainName} (old address)` }));
  return main === null && old === null ? null : [...(main ?? []), ...extra];
}

app.get("/positions", async (c) => {
  const userId = c.get("userId");
  const w = await getOrCreateWallet(userId);
  // Every token of the wallet, with logos, next to the positions.
  const [positions, assets] = await Promise.all([getPositions(userId, w.address), withLegacy(w.address, w.legacyAddress, 0.01)]);
  return c.json({ ...positions, assets });
});

// ── Chat ───────────────────────────────────────────────────────────────────
const ChatBody = z.object({ prompt: z.string().min(1).max(20_000), sessionId: z.string().optional() });

async function* chatEvents(userId: string, body: z.infer<typeof ChatBody>, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  // The run is stored while it streams. A storage error never stops the chat.
  const rec = await ChatRecorder.open(userId, body.prompt, body.sessionId).catch((err) => (console.error("chat store:", err), null));
  if (rec) activeRecorders.set(userId, rec);
  try {
    for await (const ev of runChatAgent({ userId, prompt: body.prompt, resume: body.sessionId, signal })) {
      await rec?.add(ev).catch((err) => console.error("chat store:", err));
      yield ev;
    }
  } finally {
    if (rec) {
      await rec.flush().catch((err) => console.error("chat store:", err));
      if (activeRecorders.get(userId) === rec) activeRecorders.delete(userId);
    }
  }
}

const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" };

/** Run the agent and send its events as a server-sent event stream. Prompts are free for now: no charge is recorded. */
function chatStream(userId: string, body: z.infer<typeof ChatBody>, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const events = chatEvents(userId, body, signal);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value: ev } = await events.next();
      if (done) return controller.close();
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
    },
    async cancel() {
      await events.return(undefined);
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

// A message for the run that is active now. The agent reads it before its next step. It adds no price: the run is one prompt.
app.post("/chat/message", async (c) => {
  const { prompt } = z.object({ prompt: z.string().min(1).max(20_000) }).parse(await c.req.json());
  const userId = c.get("userId");
  if (!sendToRun(userId, prompt)) return c.json({ error: "No run is active." }, 409);
  await activeRecorders.get(userId)?.midRunMessage(prompt).catch((err) => console.error("chat store:", err));
  return c.json({ queued: true }, 202);
});

// ── Past chats ─────────────────────────────────────────────────────────────
app.get("/chats", async (c) => c.json(await listChats(c.get("userId"))));

app.get("/chats/:id", async (c) => {
  const userId = c.get("userId");
  const chat = await getChat(userId, c.req.param("id"));
  if (!chat) return c.json({ error: "Unknown chat." }, 404);
  // A card that was pending when the chat was stored can have changed since. Show its state now.
  for (const m of chat.messages)
    m.parts = await Promise.all(m.parts.map(async (p) => (p.kind === "intent" ? { kind: "intent", intent: (await getIntent(p.intent.id, userId)) ?? p.intent } : p)));
  return c.json(chat);
});

app.delete("/chats/:id", async (c) => c.json({ deleted: await deleteChat(c.get("userId"), c.req.param("id")) }));

app.post("/chat", async (c) => {
  const userId = c.get("userId");
  const body = ChatBody.parse(await c.req.json());
  const cfg = config();
  if (!cfg.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY is not set on the server. Add it to .env and restart the API." }, 503);

  return chatStream(userId, body, c.req.raw.signal);
});

// ── Intents ────────────────────────────────────────────────────────────────
app.get("/intents", async (c) => c.json(await listIntents(c.get("userId"))));

app.post("/intents/:id/reject", async (c) => {
  const done = await transition(c.req.param("id"), c.get("userId"), "pending", "rejected");
  return done ? c.json(done) : c.json({ error: "The intent is not pending." }, 409);
});

app.post("/intents/:id/confirm", async (c) => {
  const userId = c.get("userId");
  const intent = await getIntent(c.req.param("id"), userId);
  if (!intent) return c.json({ error: "Unknown intent." }, 404);
  if (intent.status !== "pending") return c.json({ error: `The intent is ${intent.status}.` }, 409);
  if (isExpired(intent)) {
    await transition(intent.id, userId, "pending", "expired");
    return c.json({ error: "The preview is older than 5 minutes. Ask the agent for a new one." }, 410);
  }

  // The atomic status change makes a second click a no-op.
  const claimed = await transition(intent.id, userId, "pending", "executing");
  if (!claimed) return c.json({ error: "The intent is not pending." }, 409);
  return c.json(await executeIntent(claimed, (await getOrCreateWallet(userId)).address));
});

// ── Scheduled jobs ─────────────────────────────────────────────────────────
app.get("/jobs", async (c) => c.json(await jobs.listJobs(c.get("userId"))));
app.delete("/jobs/:id", async (c) => c.json({ cancelled: await jobs.cancelJob(c.req.param("id"), c.get("userId")) }));

// ── Guards and billing ─────────────────────────────────────────────────────
app.get("/guards", async (c) => c.json(await listGuards(c.get("userId"))));
app.delete("/guards/:id", async (c) => c.json({ cancelled: await cancelGuard(c.req.param("id"), c.get("userId")) }));

app.get("/billing", async (c) => {
  const userId = c.get("userId");
  const charges = await sql()`select kind, amount_usd, reference, detail, created_at from charges where user_id = ${userId} order by created_at desc limit 50`;
  const [totals] = await sql()`select coalesce(sum(amount_usd), 0) as charged from charges where user_id = ${userId}`;
  const [llm] = await sql()`select coalesce(sum(cost_usd), 0) as cost, coalesce(sum(input_tokens + output_tokens + cache_read + cache_write), 0) as tokens from usage where user_id = ${userId}`;
  return c.json({ totalChargedUsd: Number(totals?.charged ?? 0), modelCostUsd: Number(llm?.cost ?? 0), tokens: Number(llm?.tokens ?? 0), charges });
});

// The balance of the one wallet of the user, in USD: tokens on every chain, Monad included.
app.get("/billing/balances", async (c) => {
  const userId = c.get("userId");
  const { address, legacyAddress } = await getOrCreateWallet(userId);
  // Tokens in the legacy key (an old deposit address) count as well.
  const assets = await withLegacy(address, legacyAddress, 0);
  return c.json({ address, usd: assets === null ? null : assets.reduce((s, a) => s + (a.usd ?? 0), 0) });
});

// ── Deposits ───────────────────────────────────────────────────────────────
// The Privy wallet of the user is the deposit address. The browser calls this route after the user added the server signer to it.
app.post("/deposit/enable", async (c) => {
  const userId = c.get("userId");
  const evm = await syncDepositWallet(userId);
  return c.json({ address: evm.address, enabled: evm.enabled, signerId: evm.signerId });
});

// A deposit of trading funds: a plain transfer of a listed token to the agent wallet. The token stays as it is, ready for a position.
app.post("/deposit/transfer", async (c) => {
  const body = z.object({ chainId: z.number().int().refine((n) => (lifi.TRADING_DEPOSIT_CHAINS as readonly number[]).includes(n)), symbol: z.string(), amount: z.string().regex(/^\d+(\.\d+)?$/) })
    .refine((b) => lifi.TRADING_DEPOSIT_TOKENS[b.chainId]?.includes(b.symbol), "This token is not listed on this chain").parse(await c.req.json());
  return lifi.depositTransfer({ ...body, toAddress: (await getOrCreateWallet(c.get("userId"))).address }).then((q) => c.json(q), badRequest);
});

app.onError((err, c) => {
  if (err instanceof z.ZodError) return c.json({ error: "Invalid request.", issues: err.issues }, 400);
  console.error(err);
  return c.json({ error: err.message }, 500);
});

await migrate();
jobs.startJobRunner();
const auroraOn = auroraWorker.startAuroraWorker();
serve({ fetch: app.fetch, port: config().API_PORT });
console.log(`API on http://localhost:${config().API_PORT}  (model ${config().OPENAI_MODEL}, prompts free, Aurora worker ${auroraOn ? "on" : "off: set AURORA_API_KEY"})`);
