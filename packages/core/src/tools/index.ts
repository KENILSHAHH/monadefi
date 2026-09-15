// Typed DeFi tools for the agent. Handlers run in the API process, outside the agent subprocess.
// Read tools return data. Action tools build a preview, check limits, and execute from the user's agent wallet
// (or wait for a confirmation click when the user turned automatic execution off).
import { tool, type AgentTool } from "../agent/tool";
import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import { z } from "zod";
import * as evm from "../adapters/evm";
import * as perpl from "../adapters/perpl";
import { applyVerdict, assessTrade } from "@app/risk";
import * as relay from "../adapters/relay";
import { config } from "../config";
import { executeIntent } from "../executors/index";
import { createIntent, transition, type Intent, type IntentKind } from "../intents";
import * as jobs from "../jobs";
import * as memory from "../memory";
import { isSponsored, simulateSponsored } from "../sponsor";
import { getPositions } from "../positions";
import { buildPerpl, openOrders as perplOpenOrders, type PerplOp } from "../executors/perpl";
import * as lifi from "../adapters/lifi";
import { SPONSORED_CHAINS, sponsorEnabled } from "../sponsor";
import { CHAINS, SOURCE_CHAINS } from "../registry/chains";
import type { AgentWallet } from "../wallet";

export interface ToolContext {
  userId: string;
  wallet: AgentWallet;
  /** Called when an intent is created and again when its status changes. The API streams it to the browser. */
  onIntent: (intent: Intent) => void;
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (err: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true });

const RISK_DISCLOSURE =
  "A guard reduces liquidation risk. It cannot guarantee a result. Price gaps, oracle delay and network congestion can cause a liquidation before the guard acts.";

/** Agent actions run on Monad. The other EVM chains are only sources of funds that move into Monad. */
const ACT_CHAIN = ["monad"] as const;
const TxShape = z.object({
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullable().describe("Target contract. null deploys a contract."),
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  value: z.string().regex(/^[0-9]+$/).default("0").describe("Native value in wei"),
  description: z.string().describe("One plain sentence shown to the user"),
});
const toEvmTx = (t: z.infer<typeof TxShape>): evm.EvmTx => ({ to: t.to as `0x${string}` | null, data: t.data as `0x${string}`, value: t.value, description: t.description });

export function buildTools(ctx: ToolContext): AgentTool[] {
  const address = ctx.wallet.address;
  const run = <A>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };

  /** Create the intent, enforce the per-action limit, then execute it or wait for the user. */
  const act = async (kind: IntentKind, params: Record<string, unknown>, preview: Record<string, unknown>, usdSize: number) => {
    if (usdSize > ctx.wallet.maxActionUsd) {
      throw new Error(`This action is about ${usdSize.toFixed(2)} USD. The user's limit per action is ${ctx.wallet.maxActionUsd} USD. Tell the user. They can raise the limit in the wallet panel.`);
    }
    const intent = await createIntent({ userId: ctx.userId, kind, params, preview });
    ctx.onIntent(intent);
    if (!ctx.wallet.autoExecute) {
      return { status: "AWAITING_USER_CONFIRMATION", intentId: intent.id, preview, note: "The user sees a confirmation card. Do not say that the action ran." };
    }
    const claimed = await transition(intent.id, ctx.userId, "pending", "executing");
    if (!claimed) throw new Error("The intent changed state before execution.");
    const done = await executeIntent(claimed, address);
    ctx.onIntent(done);
    return done.status === "done"
      ? { status: "EXECUTED", intentId: done.id, result: done.result, preview, note: "The user sees a card with this result. Report the real figures and the transaction ids from `result`." }
      : { status: "FAILED", intentId: done.id, error: done.result?.error, note: "Nothing more was executed. Explain the failure plainly. Do not retry the same action without a change." };
  };

  /** Build a Perpl action now, simulate it the way it is sent, then create the intent. The executor builds it again from live data. */
  const perplAct = async (op: PerplOp, extra: Record<string, unknown>, preview: Record<string, unknown>, usdSize: number) => {
    const built = await buildPerpl(address, op);
    const simulation = isSponsored("monad")
      ? await simulateSponsored(ctx.userId, "monad", built.txs).then((x) => ({ method: "sponsored eth_estimateGas", results: [{ index: 0, status: x.ok ? ("success" as const) : ("revert" as const), gasUsed: x.gas, error: x.error }] }))
      : await evm.simulate("monad", address, built.txs);
    const bad = simulation.results.find((r, i) => r.status === "revert" && (i === 0 || simulation.method !== "eth_estimateGas (single calls)"));
    if (bad) throw new Error(`Simulation on Monad: ${built.txs.length > 1 ? `transaction ${bad.index + 1} ` : ""}reverts (${bad.error}). Nothing was sent.${isSponsored("monad") ? "" : " Without the gas sponsor the wallet also needs MON for gas."}`);
    return act("perpl", { op, ...extra }, {
      ...preview, summary: preview.summary ?? built.summary, ...(built.depositUsd ? { depositFromWalletAusd: built.depositUsd } : {}), markPx: preview.markPx ?? built.markPx,
      simulation, sources: [`${perpl.PERPL_API}/v1/pub/context`, `Perpl Exchange ${perpl.PERPL_EXCHANGE} on Monad`], transactions: built.txs.map((t) => ({ ...t, chainId: CHAINS.monad.chainId })),
    }, usdSize);
  };

  const read = { annotations: { readOnlyHint: true } };


  return [
    // ── Read ────────────────────────────────────────────────────────────────
    tool("wallet_overview", "The user's agent wallet: address, every token with its USD value on Monad (and on the EVM chains it can be moved from), the Perpl trading account (AUSD balance and open positions), active guards. Call it before any action to know what funds exist and where.",
      {}, run(async () => ({ ...(await getPositions(ctx.userId, address)), tokens: await lifi.allWalletAssets(address, 0.01), gasSponsor: sponsorEnabled() ? { on: true, chains: SPONSORED_CHAINS, note: "The wallet needs no native gas on these chains." } : { on: false } })), read),

    tool("bridge_quote", "Quote moving tokens from Ethereum, Arbitrum, Base or Polygon into Monad through Relay, without sending. Returns output amount, fee in USD, ETA in seconds and the steps. For deposits from any chain (Solana, Bitcoin and more), the user uses the Deposit screen (Aurora Intents).",
      { fromChain: z.enum(SOURCE_CHAINS), fromToken: z.string(), toToken: z.string().describe("Token on Monad, for example USDC or AUSD"), amount: z.number().positive() },
      run(async (a) => relay.quoteBridge({ ...a, toChain: "monad", user: address, recipient: address })), read),

    tool("bridge_status", "Status of a Relay transfer by request id. Use it after `bridge` to confirm that the funds arrived before the next step.",
      { requestId: z.string() }, run(({ requestId }) => relay.bridgeStatus(requestId)), read),

    tool("evm_simulate", "Simulate EVM transactions from the agent wallet on live chain state. Read-only. Use it to test calldata or a contract deployment that you built.",
      { chain: z.enum(ACT_CHAIN), transactions: z.array(TxShape).min(1).max(40) },
      run(({ chain, transactions }) => evm.simulate(chain, address, transactions.map(toEvmTx))), read),

    // ── The user's own wallet (linked wallet) ───────────────────────────────
    // ── Act ─────────────────────────────────────────────────────────────────
    // ── Perpl (perps on Monad) ──────────────────────────────────────────────
    tool("perpl_markets", "Live Perpl perp markets on Monad: market symbol and id, mark, oracle, best bid and ask, max leverage, maintenance margin, taker and maker fee, funding per interval (positive: longs pay shorts), open interest and 24h volume in USD. Perpl is a fully on-chain order book; margin is isolated per position and the only collateral is AUSD.",
      { query: z.string().optional().describe("Symbol or name, for example BTC, ether, MON. Empty lists all.") },
      run(async ({ query }) => ({ markets: await perpl.findMarkets(query), source: `${perpl.PERPL_API}/v1/pub/context` })), read),

    tool("perpl_account", "Read a Perpl account on Monad from the contract: AUSD balance, free and locked amounts, and every open position with side, size, entry, mark, margin, leverage, unrealized PnL (with funding), liquidation price and distance to liquidation. Default: the agent wallet. Also returns the AUSD held in the wallet itself.",
      { address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() },
      run(async ({ address: a }) => {
        const who = (a ?? address) as `0x${string}`;
        const [account, ausdInWallet] = await Promise.all([perpl.getAccount(who), perpl.walletAusd(who)]);
        return { ...account, ausdInWallet, app: `${perpl.PERPL_APP}`, explorer: `${perpl.MONAD_EXPLORER}/address/${who}` };
      }), read),

    tool("perpl_book", "The live Perpl order book of a market: bids and asks with price, size and order count.",
      { market: z.string(), levels: z.number().int().min(1).max(100).default(10) },
      run(({ market, levels }) => perpl.getBook(market, levels)), read),

    tool("perpl_open_orders", "Resting Perpl orders of the agent wallet that this app placed (limit orders and resting take-profits), with order ids for perpl_cancel_order and perpl_modify_order.",
      {}, run(() => perplOpenOrders(address)), read),

    tool("perpl_api", "GET any public Perpl REST endpoint for market data. Examples: /v1/pub/context, /v1/market-data/ticker, /v1/market-data/1/ticker, /v1/market-data/1/book?levels=20, /v1/market-data/1/candles/3600/<fromMs>-<toMs>, /v1/market-data/1/funding/<fromMs>-<toMs>. Prices are scaled by the price decimals of the market, sizes by its size decimals (see perpl_markets).",
      { path: z.string().regex(/^\/v1\/(pub|market-data)\/[A-Za-z0-9/_\-?=&.]*$/).describe("Path after /api, starting with /v1/pub or /v1/market-data") },
      run(async ({ path: p }) => {
        const res = await fetch(`${perpl.PERPL_API}${p}`, { signal: AbortSignal.timeout(15_000) });
        const text = await res.text();
        return { status: res.status, body: text.length > 20_000 ? `${text.slice(0, 20_000)}… (cut)` : JSON.parse(text) };
      }), read),

    tool("perpl_open_position", "Open or add to a Perpl perp position on Monad from the agent wallet: a market order (immediate-or-cancel at a worst accepted price) or a limit order that rests on the book. Size it with marginUsd (the money put in) or sizeUsd (the position value). The margin comes from the free AUSD in the Perpl account; when it is short, AUSD from the wallet is deposited in the same transaction (at least 10 AUSD per deposit). The wallet must hold AUSD on Monad: swap to AUSD first when it holds USDC or MON. stopLossPx and takeProfitPx add server-watched exits after the fill. Leverage applies to the whole position after the order. Every order first passes the Nansen risk gate (smart money, whales, exchange flows, holder concentration, the trader's record): it can block the order, lower the leverage and the margin, and add a required stop-loss. The preview shows the verdict and each change; report them to the user in plain words.",
      {
        market: z.string().describe("Perpl market symbol from perpl_markets, for example BTC"),
        side: z.enum(["long", "short"]),
        leverage: z.number().min(1),
        marginUsd: z.number().positive().optional(),
        sizeUsd: z.number().positive().optional().describe("Position value in USD, in place of marginUsd"),
        orderType: z.enum(["market", "limit"]).default("market"),
        limitPx: z.number().positive().optional().describe("Price of a limit order"),
        postOnly: z.boolean().optional().describe("Limit order only: refuse to trade at once, only rest on the book"),
        expiryMinutes: z.number().positive().max(60 * 24 * 30).optional().describe("Limit order only: cancel after this time. Default: until cancelled"),
        slippageBps: z.number().int().min(1).max(perpl.MAX_SLIPPAGE_BPS).optional().describe("Market order only. Default 50 (0.5%)"),
        stopLossPx: z.number().positive().optional(),
        takeProfitPx: z.number().positive().optional(),
        guard: z.object({
          triggerDistancePct: z.number().min(0.5).max(50).describe("Act when the mark price is within this percent of the liquidation price"),
          action: z.enum(["full_close", "partial_deleverage"]),
        }).optional().describe("Liquidation guard to register after the fill"),
      },
      run(async (a) => {
        if (!a.marginUsd && !a.sizeUsd) throw new Error("Give marginUsd or sizeUsd.");
        const isLong = a.side === "long";
        // Nansen risk gate, in code: the verdict can block the order, lower the leverage and the margin, and require a stop-loss.
        const market = await perpl.getMarket(a.market);
        const requested = { leverage: a.leverage, marginUsd: a.marginUsd ?? a.sizeUsd! / a.leverage, stopLossPx: a.stopLossPx ?? null };
        const risk = await assessTrade({ apiKey: config().NANSEN_API_KEY, market: market.symbol, side: a.side, leverage: requested.leverage, marginUsd: requested.marginUsd, marketMaxLeverage: market.maxLeverage, trader: address, maxCredits: config().NANSEN_MAX_CREDITS });
        const gated = applyVerdict(requested, risk, { entryPx: market.markPx });
        if (gated.blocked) throw Object.assign(new Error(`Nansen risk check blocked this ${a.side} on ${market.symbol}: ${risk.reasons.join(" ") || risk.changes.join(" ")}`), { risk });
        const applied = { leverage: Math.max(1, gated.order.leverage), marginUsd: gated.order.marginUsd, stopLossPx: gated.order.stopLossPx ?? null };
        a = { ...a, leverage: applied.leverage, marginUsd: applied.marginUsd, sizeUsd: undefined, stopLossPx: applied.stopLossPx ?? undefined };
        const p = await perpl.previewOpen({ market: market.symbol, isLong, leverage: a.leverage, marginUsd: a.marginUsd, orderKind: a.orderType, limitPx: a.limitPx, slippageBps: a.slippageBps, postOnly: a.postOnly });
        const ref = p.estEntryPx;
        if (a.stopLossPx && (isLong ? a.stopLossPx >= ref : a.stopLossPx <= ref)) throw new Error(`A stop-loss of a ${a.side} must be ${isLong ? "below" : "above"} the entry (about ${ref}).`);
        if (a.stopLossPx && (isLong ? a.stopLossPx <= p.estLiquidationPx : a.stopLossPx >= p.estLiquidationPx)) throw new Error(`The stop-loss (${a.stopLossPx}) is past the estimated liquidation price (${p.estLiquidationPx.toFixed(4)}). It could never fire.`);
        if (a.takeProfitPx && (isLong ? a.takeProfitPx <= ref : a.takeProfitPx >= ref)) throw new Error(`A take-profit of a ${a.side} must be ${isLong ? "above" : "below"} the entry (about ${ref}).`);
        const op: PerplOp = { op: "open", market: p.market.symbol, side: a.side, leverage: a.leverage, marginUsd: a.marginUsd, sizeUsd: a.sizeUsd, orderKind: a.orderType, limitPx: a.limitPx, postOnly: a.postOnly, slippageBps: a.slippageBps, expiryBlocks: a.expiryMinutes ? Math.round((a.expiryMinutes * 60) / 0.4) : undefined };
        const exits = a.orderType === "market" ? { stopLossPx: a.stopLossPx, takeProfitPx: a.takeProfitPx } : {};
        if (a.orderType === "limit" && (a.stopLossPx || a.takeProfitPx)) p.warnings.push("Exits are added only to a market order. After the limit order fills, call perpl_set_tpsl.");
        const guard = a.guard ? { ...a.guard, triggerPx: p.estLiquidationPx * (1 + (isLong ? 1 : -1) * a.guard.triggerDistancePct / 100), pricePerMinuteUsd: config().PRICE_GUARD_MINUTE_USD, disclosure: RISK_DISCLOSURE } : null;
        return perplAct(op, { ...exits, guard: a.guard ?? null }, {
          venue: "Perpl", chain: "Monad", market: p.market.symbol, marketId: p.market.id, side: a.side, orderType: a.orderType, leverage: a.leverage,
          size: p.size, notionalUsd: p.notionalUsd, marginUsd: p.marginUsd, estEntryPx: p.estEntryPx, limitPx: p.limitPx, markPx: p.market.markPx,
          estLiquidationPx: p.estLiquidationPx, distanceToLiquidationPct: p.distanceToLiquidation * 100, estFeeUsd: p.estFeeUsd,
          fundingPerIntervalPct: p.market.fundingRate * 100, fundingIntervalMinutes: Math.round(p.market.fundingIntervalSec / 60),
          ...(exits.stopLossPx ? { stopLossPx: exits.stopLossPx } : {}), ...(exits.takeProfitPx ? { takeProfitPx: exits.takeProfitPx } : {}),
          ...(exits.stopLossPx || exits.takeProfitPx ? { exitsNote: "Stop-loss and take-profit are watched by the server every few seconds and close with a market order. A fast move can fill past the level." } : {}),
          guard, warnings: p.warnings,
          risk: { decision: risk.decision, level: risk.level, score: risk.score, dataAvailable: risk.dataAvailable, reasons: risk.reasons, signals: risk.signals, asOf: risk.asOf, source: "Nansen" },
          requested, applied, riskChanges: gated.changes,
        }, p.marginUsd);
      })),

    tool("perpl_close_position", "Close all or part of an open Perpl position with a reduce-only market order (immediate-or-cancel). The money freed stays in the Perpl account as AUSD; withdraw it with perpl_withdraw.",
      { market: z.string(), fraction: z.number().gt(0).max(1).default(1).describe("1 = full close"), slippageBps: z.number().int().min(1).max(perpl.MAX_SLIPPAGE_BPS).optional() },
      run(async (a) => {
        const pos = await perpl.getPosition(address, a.market);
        if (!pos) throw new Error(`No open ${a.market} position on Perpl.`);
        return perplAct({ op: "close", market: pos.market, fraction: a.fraction, orderKind: "market", slippageBps: a.slippageBps }, {}, {
          venue: "Perpl", chain: "Monad", market: pos.market, side: pos.side, currentSize: pos.size, closeSize: pos.size * a.fraction, markPx: pos.markPx,
          unrealizedPnl: pos.unrealizedPnl, marginUsd: pos.marginUsd, orderType: "reduce-only market (IOC)",
        }, 0);
      })),

    tool("perpl_set_tpsl", "Set a stop-loss (kind=sl) or take-profit (kind=tp) on an open Perpl position. Perpl's own trigger orders need a Perpl API key, so a stop-loss is a server job: the server reads the Perpl mark price every few seconds and sends a reduce-only market close when it crosses triggerPx. A take-profit is by default a native resting reduce-only limit order on the Perpl book at triggerPx; a resting order needs some free AUSD in the account, so the tool deposits from the wallet when there is none (at least 10 AUSD). native=false makes it a server job too. A stop of a long must be below the mark, of a short above it. List them with job_list and perpl_open_orders, remove them with job_cancel and perpl_cancel_order.",
      { market: z.string(), kind: z.enum(["sl", "tp"]), triggerPx: z.number().positive(), fraction: z.number().gt(0).max(1).default(1).describe("Part of the position. 1 = all"), native: z.boolean().default(true).describe("Take-profit only: a resting order on the book (true) or a server job (false)") },
      run(async (a) => {
        const pos = await perpl.getPosition(address, a.market);
        if (!pos) throw new Error(`No open ${a.market} position on Perpl.`);
        const isLong = pos.side === "long";
        const wrongSide = a.kind === "sl" ? (isLong ? a.triggerPx >= pos.markPx : a.triggerPx <= pos.markPx) : (isLong ? a.triggerPx <= pos.markPx : a.triggerPx >= pos.markPx);
        if (wrongSide) throw new Error(`A ${a.kind === "sl" ? "stop-loss" : "take-profit"} of a ${pos.side} must be ${(a.kind === "sl") === isLong ? "below" : "above"} the mark price (${pos.markPx}). It would fire at once.`);
        if (a.kind === "sl" && pos.liquidationPx !== null && (isLong ? a.triggerPx <= pos.liquidationPx : a.triggerPx >= pos.liquidationPx)) throw new Error(`The stop (${a.triggerPx}) is past the liquidation price (${pos.liquidationPx.toFixed(4)}). It can never fire. Choose a price between the mark and the liquidation price.`);
        if (a.kind === "tp" && a.native) {
          return perplAct({ op: "close", market: pos.market, fraction: a.fraction, orderKind: "limit", limitPx: a.triggerPx }, {}, {
            venue: "Perpl", chain: "Monad", market: pos.market, kind: "Take-profit (resting order)", triggerPx: a.triggerPx, size: pos.size * a.fraction, markPx: pos.markPx,
            note: "A reduce-only limit order on the Perpl book. It fills when buyers (or sellers for a short) reach this price.",
          }, Math.abs(pos.notionalUsd) * a.fraction);
        }
        const op = (a.kind === "sl") === isLong ? "below" : "above";
        const name = `${a.kind === "sl" ? "Stop-loss" : "Take-profit"} ${pos.market} ${pos.side} at ${a.triggerPx}`;
        const condition = { type: "price" as const, asset: pos.market, op, value: a.triggerPx };
        const action = { type: "perpl" as const, op: "close" as const, market: pos.market, fraction: a.fraction, side: pos.side, slippageBps: 100 };
        return act("job_create", { name, condition, action, days: 90 }, {
          venue: "Perpl", chain: "Monad", summary: `${name}: when the Perpl mark price of ${pos.market} is ${op} ${a.triggerPx}, the server closes ${a.fraction === 1 ? "the whole" : `${Math.round(a.fraction * 100)}% of the`} position with a market order.`,
          markPx: pos.markPx, liquidationPx: pos.liquidationPx, endsInDays: 90,
          disclosure: "A server-side stop. It is checked every few seconds and fills at the market price, which can be past the level in a fast move.",
        }, Math.abs(pos.notionalUsd) * a.fraction);
      })),

    tool("perpl_cancel_order", "Cancel a resting Perpl order (a limit order or a resting take-profit) by market and order id from perpl_open_orders.",
      { market: z.string(), orderId: z.number().int().min(1) },
      run(async (a) => perplAct({ op: "cancel", market: a.market, orderId: a.orderId }, {}, { venue: "Perpl", chain: "Monad", market: a.market, orderId: a.orderId, summary: `Cancel order ${a.orderId} on ${a.market}` }, 0))),

    tool("perpl_modify_order", "Change the price and size of a resting Perpl order in place (keeps its order id).",
      { market: z.string(), orderId: z.number().int().min(1), limitPx: z.number().positive(), size: z.number().positive().describe("New size in base units, for example 0.01 BTC") },
      run(async (a) => perplAct({ op: "modify", market: a.market, orderId: a.orderId, limitPx: a.limitPx, size: a.size }, {}, { venue: "Perpl", chain: "Monad", market: a.market, orderId: a.orderId, newPx: a.limitPx, newSize: a.size }, 0))),

    tool("perpl_margin", "Add margin to (action=add) or take margin out of (action=remove) one open Perpl position. Adding is instant and lowers the liquidation risk; it uses free AUSD in the account and deposits from the wallet when needed. Removing is a request that a Perpl keeper applies within about 2 minutes, or declines when the position would become unsafe; the money goes to the free balance of the account.",
      { market: z.string(), action: z.enum(["add", "remove"]), usd: z.number().positive() },
      run(async (a) => {
        const pos = await perpl.getPosition(address, a.market);
        if (!pos) throw new Error(`No open ${a.market} position on Perpl.`);
        return perplAct({ op: "margin", market: pos.market, action: a.action, usd: a.usd }, {}, { venue: "Perpl", chain: "Monad", market: pos.market, action: a.action, usd: a.usd, marginNow: pos.marginUsd, liquidationPxNow: pos.liquidationPx }, a.usd);
      })),

    tool("perpl_deposit", "Deposit AUSD from the wallet into the Perpl trading account on Monad. The first deposit opens the account. Each deposit is at least 10 AUSD. perpl_open_position deposits by itself when it needs to, so call this only when the user asks.",
      { amountAusd: z.number().min(10) },
      run(async (a) => perplAct({ op: "deposit", usd: a.amountAusd }, {}, { venue: "Perpl", chain: "Monad", summary: `Deposit ${a.amountAusd} AUSD into Perpl`, ausdInWallet: await perpl.walletAusd(address) }, a.amountAusd))),

    tool("perpl_withdraw", "Withdraw free AUSD from the Perpl trading account back to the wallet on Monad. Money in positions or held by resting orders is not free: close or reduce first. Perpl limits withdrawals of the whole exchange per hour, so a very large withdrawal can wait.",
      { amountAusd: z.number().positive() },
      run(async (a) => perplAct({ op: "withdraw", usd: a.amountAusd }, {}, { venue: "Perpl", chain: "Monad", summary: `Withdraw ${a.amountAusd} AUSD from Perpl to your wallet` }, a.amountAusd))),

    tool("bridge", `Move tokens into Monad through Relay: from the wallet on Ethereum, Arbitrum, Base or Polygon to the same wallet on Monad. A passkey (Mera) wallet cannot do this from the server: tell the user to use the Deposit screen (Aurora Intents, any chain). For Perpl, the token on Monad must be AUSD (${perpl.AUSD.address}); bring USDC and swap it to AUSD with swap when Relay has no direct AUSD route.`,
      { fromChain: z.enum(SOURCE_CHAINS), fromToken: z.string(), toToken: z.string().describe("Token on Monad"), amount: z.number().positive() },
      run(async (a) => {
        const q = await relay.quoteBridge({ ...a, toChain: "monad", user: address, recipient: address });
        const transactions = q.steps.flatMap((s) => s.transactions.map((t) => {
          const tx = t as { to: string; data: string; value?: string; chainId?: number };
          return { chainId: tx.chainId, to: tx.to, data: tx.data, value: tx.value ?? "0", description: s.description };
        }));
        return act("bridge", { ...a, toChain: "monad" }, { venue: "Relay", ...q, transactions }, a.amount);
      })),

    tool("evm_send_transactions", "Send EVM transactions that you built, from the agent wallet: a contract deployment (to = null, data = creation bytecode with constructor arguments) or contract calls. They are simulated first and nothing is sent when the first one reverts. Use a typed tool when one fits. State in `summary` what the transactions do in plain words, in `sources` the doc pages or address books behind every target address and ABI, and in `usdValue` the value they move.",
      {
        chain: z.enum(ACT_CHAIN),
        summary: z.string().min(10),
        sources: z.array(z.string()).min(1),
        usdValue: z.number().min(0).describe("Total USD value moved or put at risk"),
        transactions: z.array(TxShape).min(1).max(40),
      },
      run(async (a) => {
        const txs = a.transactions.map(toEvmTx);
        for (const t of txs) {
          if (t.to && t.data !== "0x" && !(await evm.hasCode(a.chain, t.to))) throw new Error(`Target ${t.to} has no contract code on ${CHAINS[a.chain].name}. Check the address against the official source.`);
        }
        const simulation = await evm.simulate(a.chain, address, txs);
        const first = simulation.results[0];
        if (first?.status === "revert") throw new Error(`Simulation: transaction 1 reverts (${first.error}). Nothing was sent. Fix the calldata or check the wallet balance, gas and allowances.`);
        if (simulation.method === "eth_simulateV1") {
          const bad = simulation.results.find((r) => r.status === "revert");
          if (bad) throw new Error(`Simulation: transaction ${bad.index + 1} reverts (${bad.error}). Nothing was sent.`);
        }
        const chainId = CHAINS[a.chain].chainId!;
        return act("evm_transactions", { chain: a.chain, transactions: txs }, {
          venue: CHAINS[a.chain].name, chain: CHAINS[a.chain].name, summary: a.summary, sources: a.sources, simulation,
          transactions: txs.map((t) => ({ chainId, ...t })),
          warnings: [
            ...simulation.results.filter((r) => r.status === "unverified").map((r) => `Transaction ${r.index + 1} could not be simulated alone. It depends on an earlier transaction.`),
            ...(txs.some((t) => t.to === null) ? ["This deploys a new contract written by the agent. The contract has no audit."] : []),
          ],
        }, a.usdValue);
      })),

    tool("job_schedule", "Schedule an action that the server runs later, when a condition is true, once or repeated (daily, hourly, any interval). Use it for every request of the kind \"do X when Y\" or \"do X every day\": close a Perpl position at a price, open one at a price, buy MON every day, act at a time. Conditions: the Perpl mark price of a market, or a time. Actions: a Perpl open or close, a swap on Monad, fixed Monad transactions, or agent_task (you run an instruction yourself at that time, with all your tools). A loop on the server reads the condition every few seconds, for days, with no chat open. When it is true, plain code builds the action again, simulates it and sends it. Prepare the action completely now.",
      {
        name: z.string().min(5).max(80).describe("Short name the user sees, for example: Close the ETH long when ETH is below 2000"),
        condition: z.discriminatedUnion("type", [
          z.object({ type: z.literal("price"), asset: z.string().describe("Perpl market whose mark price is the source, for example BTC, ETH, SOL or MON"), op: z.enum(["below", "above"]), value: z.number().positive() }),
          z.object({ type: z.literal("time"), at: z.string().describe("ISO 8601 time, for example 2026-10-14T09:00:00Z") }),
        ]),
        action: z.union([
          z.object({ type: z.literal("transactions"), chain: z.enum(ACT_CHAIN), wallet: z.literal("agent").default("agent"), transactions: z.array(TxShape).min(1).max(40) }),
          z.object({ type: z.literal("swap"), fromChain: z.enum(ACT_CHAIN), toChain: z.enum(ACT_CHAIN), fromToken: z.string().describe("Symbol or address, or native"), toToken: z.string(), amount: z.string().regex(/^\d+(\.\d+)?$/).describe("Whole units of fromToken") }).describe("Swap a token on Monad through LI.FI, quoted when it fires. Use it for a recurring buy (DCA) on Monad."),
          z.object({ type: z.literal("perpl"), op: z.literal("open"), market: z.string(), side: z.enum(["long", "short"]), marginUsd: z.number().positive(), leverage: z.number().min(1) }).describe("Perpl market order that opens or adds to a position, sized when it fires."),
          z.object({ type: z.literal("perpl"), op: z.literal("close"), market: z.string(), fraction: z.number().gt(0).max(1), side: z.enum(["long", "short"]).optional().describe("Close only a position on this side") }).describe("Perpl reduce-only market close of part or all of a position."),
          z.object({ type: z.literal("agent_task"), instruction: z.string().min(10) }).describe("For anything the other actions cannot express: you will run this instruction yourself when the job fires, with all your tools and the user's settings. Write it so that it needs no question to the user."),
        ]),
        days: z.number().int().min(1).max(365).default(30).describe("Days until the job ends when the condition did not become true"),
        repeat: z.object({ everyHours: z.number().positive().max(24 * 365), times: z.number().int().min(2).max(10_000) }).optional().describe("Repeat the job: wait everyHours after each run, until it ran `times` times. Daily for a month: everyHours 24, times 30. With a time condition, set `at` to the first run (now or in the past to start at once)."),
        usdValue: z.number().min(0).describe("USD value the action moves or puts at risk"),
        whatItDoes: z.string().min(20).describe("Plain words for the user: what happens when it fires, step by step, and what can go wrong"),
        allowRevertNow: z.boolean().optional().describe("Only for an action that cannot pass a simulation before the condition is true. You must have proved it on a fork."),
        forkTestSummary: z.string().optional().describe("What you tested on a fork and the result. Required with allowRevertNow."),
      },
      run(async (a) => {
        if (a.allowRevertNow && !a.forkTestSummary) throw new Error("allowRevertNow needs forkTestSummary: prove the action on a fork first.");
        const action = (a.action.type === "transactions" ? { ...a.action, transactions: a.action.transactions.map(toEvmTx) } : a.action) as jobs.JobAction;
        const condition = a.condition as jobs.JobCondition;
        const repeat = a.repeat ? { everySeconds: Math.round(a.repeat.everyHours * 3600), times: a.repeat.times } : undefined;
        const check = await jobs.checkJob(ctx.userId, { condition, action, allowRevertNow: a.allowRevertNow, repeat });
        return act("job_create", { name: a.name, condition, action, days: a.days, repeat }, {
          venue: "Scheduled job", chain: CHAINS[check.chain].name, summary: `${a.name}. Fires when: ${jobs.describeCondition(condition)}. ${a.whatItDoes}`,
          valueNow: check.valueNow, simulation: check.simulation ?? { note: check.warning ?? `Not simulated now. Fork test: ${a.forkTestSummary}` }, ...(check.warning ? { fundsWarning: check.warning } : {}),
          sources: ["Condition and action are checked by code on the server. No model decides when it fires."],
          transactions: check.transactions.map((t) => ({ ...t, chainId: CHAINS[check.chain].chainId })),
          endsInDays: a.days, disclosure: "A job reduces risk. It cannot guarantee a result. A price gap, a slow chain or a failed simulation can stop it.",
        }, a.usdValue);
      })),

    tool("swap", "Swap one token for another on Monad from the wallet through LI.FI (DEX aggregator routes). Give a symbol (USDC, MON, WETH) or an address, or native. LI.FI has no USDC to AUSD route on Monad; the Deposit flow converts USDC to AUSD on Curve. The gas sponsor pays the gas. Quotes live and simulates first.",
      { fromChain: z.enum(ACT_CHAIN), toChain: z.enum(ACT_CHAIN), fromToken: z.string(), toToken: z.string(), amount: z.string().regex(/^\d+(\.\d+)?$/).describe("Whole units of fromToken"), slippagePct: z.number().min(0.05).max(5).optional() },
      run(async (a) => {
        const r = await lifi.routeTransactions({ fromChainId: CHAINS[a.fromChain].chainId!, toChainId: CHAINS[a.toChain].chainId!, fromToken: a.fromToken, toToken: a.toToken, amount: a.amount, from: address, to: address, slippage: (a.slippagePct ?? 0.5) / 100 });
        const txs = r.calls as evm.EvmTx[];
        const simulation = isSponsored(a.fromChain)
          ? await simulateSponsored(ctx.userId, a.fromChain, txs).then((x) => ({ method: "sponsored eth_estimateGas", results: [{ index: 0, status: x.ok ? ("success" as const) : ("revert" as const), gasUsed: x.gas, error: x.error }] }))
          : await evm.simulate(a.fromChain, address, txs);
        const bad = simulation.results.find((x) => x.status === "revert");
        if (bad) throw new Error(`Simulation: the swap reverts (${bad.error}). Nothing was sent.`);
        return act("evm_transactions", { chain: a.fromChain, transactions: txs }, {
          venue: `LI.FI (${r.tool})`, chain: CHAINS[a.fromChain].name, summary: txs[txs.length - 1]!.description, expectedOut: r.outAmount, minimumOut: r.minOut,
          sources: ["https://li.quest/v1/quote"], simulation, transactions: txs.map((t) => ({ ...t, chainId: CHAINS[a.fromChain].chainId })),
        }, r.usdIn ?? 0);
      })),

    tool("memory_save", "Save a lesson for later chats. Save one each time you solve an error or find a working route, so the next chat does not repeat the mistake, and each time the user states a preference. scope=global for a fact about a venue, a tool or a fix that helps every user (never personal data). scope=user for this user. One lesson, short and concrete: the problem, the cause, the fix. replaces = id of a lesson it corrects.",
      { scope: z.enum(["global", "user"]), topic: z.string().min(2).max(80), lesson: z.string().min(10).max(600), replaces: z.number().int().optional() },
      run((a) => memory.saveLesson(ctx.userId, a))),

    tool("memory_recall", "Search the saved lessons by topic or word. The newest lessons are already in the first message of the chat; use this for older ones.",
      { topic: z.string().optional() }, run(({ topic }) => memory.recallLessons(ctx.userId, topic)), read),

    tool("memory_forget", "Delete a saved lesson that is wrong or out of date, by id.",
      { id: z.number().int() }, run(({ id }) => memory.forgetLesson(ctx.userId, id))),

    tool("job_list", "List the scheduled jobs of the user: name, condition, live value at the last check, status and result.",
      {}, run(async () => ({ jobs: await jobs.listJobs(ctx.userId, true) })), read),

    tool("job_cancel", "Cancel an active scheduled job by id.",
      { jobId: z.string() }, run(async ({ jobId }) => ({ cancelled: await jobs.cancelJob(jobId, ctx.userId) }))),

  ];
}
