import { AUSD, fundingTxs, getAccount, walletAusd } from "@app/perpl";
import { CommandError, type CommandIO, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, erc20Abi, type PublicClient } from "viem";
import { isTruthyFlag, optional, parseOriginChain, parsePositive, toBaseUnits, type OriginChain } from "../../lib/args";
import { AuroraClient, findToken, MONAD_USDC_ASSET, waitForSwap, type AuroraStatus } from "../../lib/aurora";
import { getConfig, slippageBps } from "../../lib/config";
import { num } from "../../lib/format";
import { executor, MONAD, signerAddress, toCommandError, usePerpl, type Ctx } from "../../lib/host";
import { bool, slippageInput, text } from "../../lib/inputs";
import { CURVE_POOL, curveQuote, curveSwapTxs, MONAD_USDC } from "../../lib/curve";
import { sendPlanned } from "../../lib/send";
import { perplTx } from "../../lib/strategy";
import type { Executor, PlannedTx, SentTx } from "../../lib/types";

const inputs = {
  from: text("from", "Origin chain: base, arbitrum, ethereum, optimism, polygon, bsc, avalanche, or monad (swap only)", true),
  amount: text("amount", "Amount of the origin asset, for example 50", true),
  asset: text("asset", "Origin asset symbol (default USDC)"),
  "deposit-perpl": bool("deposit-perpl", "Deposit the AUSD into the Perpl account at the end"),
  "no-swap": bool("no-swap", "Stop with USDC on Monad (skip the USDC -> AUSD swap)"),
  resume: text("resume", "Resume a bridge: the Aurora deposit address of a transfer already sent"),
  "slippage-bps": slippageInput,
  "dry-run": bool("dry-run", "Quote only (Aurora dry quote and Curve quote), send nothing"),
};

type Status = "dry_run" | "pending" | "bridged" | "swapped" | "deposited" | "refunded" | "failed";
interface Result {
  status: Status; address: string; from: string; asset: string; amount: string;
  bridge?: { depositAddress?: string; amountIn?: string; expectedOutUsdc?: string; minOutUsdc?: string; etaSeconds?: number; deadline?: string; final?: AuroraStatus["status"]; refund?: { amount?: string; reason?: string }; destinationTxs?: { hash: string; explorerUrl?: string }[] };
  swap?: { tool: string; usdcIn: number; expectedAusd: number; minAusd: number; ausdReceived?: number };
  perplDeposit?: { ausd: number; note?: string };
  transactions: SentTx[];
  pending?: SentTx;
  note?: string;
}

const isEvmAddr = (s?: string) => !!s && /^0x[0-9a-fA-F]{40}$/.test(s);

export default class MonadefiFund extends PluginCommand<Result> {
  static override description = "Fund Perpl trading from any chain: Aurora Intents bridge to USDC on Monad, Curve swap to AUSD, optional Perpl deposit. Every transaction goes through Agent Wallet signing.";
  static override examples = [
    "<%= config.bin %> monadefi fund --from base --amount 50 --asset USDC --deposit-perpl",
    "<%= config.bin %> monadefi fund --from arbitrum --amount 100 --dry-run --json",
    "<%= config.bin %> monadefi fund --from monad --amount 25 --deposit-perpl",
    "<%= config.bin %> monadefi fund --from base --amount 50 --resume <depositAddress>",
  ];
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "monadefi:fund";

  async execute(io: CommandIO): Promise<Result> {
    try {
      const f = await io.resolveInputs(inputs);
      const ctx = this.ctx as unknown as Ctx;
      const { client: monad } = await usePerpl(ctx);
      const address = signerAddress(ctx);
      const origin = parseOriginChain(f.from);
      const amountStr = String(parsePositive("amount", f.amount));
      const asset = (optional(f.asset) ?? "USDC").toUpperCase();
      const slip = slippageBps(optional(f["slippage-bps"]));
      const dryRun = isTruthyFlag(f["dry-run"]);
      const resume = optional(f.resume);
      const base: Pick<Result, "address" | "from" | "asset" | "amount"> = { address, from: origin.key, asset, amount: amountStr };
      const txs: SentTx[] = [];
      let exec: Executor | undefined;
      const getExec = async () => (exec ??= await executor(ctx, io, this.pluginCommandId));

      // ── 1. Bridge with Aurora Intents (skipped when the origin is Monad) ─────────────────────
      let usdcOnMonad: bigint;
      let bridge: Result["bridge"];
      if (origin.chainId !== MONAD) {
        const key = getConfig("aurora-key");
        if (!key) throw new CommandError("MISSING_CONFIG", "No Aurora Intents API key.", "Set AURORA_API_KEY or run `mm monadefi config set aurora-key <key>` (create one at https://studio.aurora.dev).");
        const aurora = new AuroraClient(key);
        let depositAddress = resume;
        if (!depositAddress) {
          const token = findToken(await aurora.tokens(), origin.aurora, asset);
          const amount = toBaseUnits(amountStr, token.decimals);
          if (!dryRun) await this.checkOriginBalance(ctx, origin, address, token.contractAddress, amount, token.decimals, asset);
          const q = await aurora.quote({ originAsset: token.assetId, destinationAsset: MONAD_USDC_ASSET, amount: amount.toString(), slippageBps: slip, refundTo: address, recipient: address, dry: dryRun });
          bridge = { depositAddress: q.quote.depositAddress, amountIn: q.quote.amountInFormatted, expectedOutUsdc: q.quote.amountOutFormatted, minOutUsdc: String(Number(q.quote.minAmountOut) / 1e6), etaSeconds: q.quote.timeEstimate, deadline: q.quote.deadline };
          io.emit(`Aurora quote: ${q.quote.amountInFormatted} ${asset} on ${origin.name} -> ~${q.quote.amountOutFormatted} USDC on Monad (min ${bridge.minOutUsdc}, ~${q.quote.timeEstimate}s). Refunds go to ${address} on ${origin.name}.`);
          if (dryRun) return { ...base, status: "dry_run", bridge, transactions: [], note: "Dry quote: no deposit address was reserved." };
          if (!q.quote.depositAddress) throw new CommandError("BRIDGE_API_ERROR", "Aurora returned no deposit address.", "Try again in a minute.");
          depositAddress = q.quote.depositAddress;
          // The origin transfer: the only bridge step that moves funds. It goes through the Agent Wallet executor.
          const amountIn = BigInt(q.quote.amountIn);
          const native = !isEvmAddr(token.contractAddress);
          const plan: PlannedTx = native
            ? { chainId: origin.chainId, to: depositAddress, data: "0x", value: amountIn.toString(), description: `Send ${q.quote.amountInFormatted} ${asset} on ${origin.name} to the Aurora Intents deposit address ${depositAddress}`, action: "bridge" }
            : { chainId: origin.chainId, to: token.contractAddress!, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [depositAddress as `0x${string}`, amountIn] }), value: "0", description: `Send ${q.quote.amountInFormatted} ${asset} on ${origin.name} to the Aurora Intents deposit address ${depositAddress}`, action: "bridge" };
          const sent = await sendPlanned(await getExec(), [plan], { signal: io.signal });
          if (!sent.complete) return { ...base, status: "pending", bridge, transactions: [], pending: sent.pending, note: `After approval, continue with: mm monadefi fund --from ${origin.key} --amount ${amountStr} --resume ${depositAddress}` };
          txs.push(...sent.sent);
          try {
            await aurora.submitDeposit(sent.sent[0]!.hash!, depositAddress);
          } catch (err) {
            io.emit(`note: deposit/submit failed (${err instanceof Error ? err.message : err}). Aurora still detects the deposit on its own.`);
          }
        } else bridge = { depositAddress };
        io.emit(`Waiting for Aurora Intents (deposit address ${depositAddress}). Ctrl-C stops waiting; the swap continues.`);
        const final = await waitForSwap(aurora, depositAddress, { signal: io.signal, onChange: (s) => io.emit(`  bridge status: ${s.status}`) });
        bridge = { ...bridge, final: final.status, destinationTxs: final.swapDetails?.destinationChainTxHashes };
        if (final.status === "REFUNDED") {
          bridge.refund = { amount: final.swapDetails?.refundedAmountFormatted, reason: final.swapDetails?.refundReason };
          io.emit(`REFUNDED: ${bridge.refund.amount ?? "?"} ${asset} back to ${address} on ${origin.name}. Reason: ${bridge.refund.reason ?? "not given"}.`);
          return { ...base, status: "refunded", bridge, transactions: txs };
        }
        if (final.status === "FAILED") return { ...base, status: "failed", bridge, transactions: txs, note: "Aurora reports FAILED. Contact Aurora support with the deposit address." };
        usdcOnMonad = BigInt(final.swapDetails?.amountOut ?? "0");
        io.emit(`Bridged: ${final.swapDetails?.amountOutFormatted ?? "?"} USDC on Monad.`);
      } else {
        if (asset !== "USDC" && asset !== "AUSD") throw new CommandError("INVALID_ASSET", "--from monad supports --asset USDC (swapped to AUSD) or AUSD (deposit only).", "Use --asset USDC or --asset AUSD.");
        usdcOnMonad = asset === "USDC" ? toBaseUnits(amountStr, 6) : 0n;
      }

      // ── 2. USDC -> AUSD on Monad with Curve (LI.FI has no route for this pair on Monad) ──────
      const skipSwap = isTruthyFlag(f["no-swap"]) || (origin.chainId === MONAD && asset === "AUSD");
      let swap: Result["swap"];
      let ausdGained = origin.chainId === MONAD && asset === "AUSD" ? Number(amountStr) : 0;
      if (!skipSwap) {
        const held = await monad.readContract({ address: MONAD_USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });
        const amount = usdcOnMonad > 0n && usdcOnMonad < held ? usdcOnMonad : held;
        if (!dryRun && amount === 0n) throw new CommandError("INSUFFICIENT_FUNDS", "No USDC on Monad to swap.", "Check the bridge status, or fund the wallet on Monad.");
        const quoteAmount = dryRun ? usdcOnMonad : amount;
        const q = await curveQuote(monad as never, quoteAmount, slip);
        swap = { tool: "curve", usdcIn: Number(quoteAmount) / 1e6, expectedAusd: Number(q.expected) / 1e6, minAusd: Number(q.min) / 1e6 };
        io.emit(`Curve: ${swap.usdcIn} USDC -> ~${num(swap.expectedAusd, 4)} AUSD (min ${num(swap.minAusd, 4)}).`);
        if (dryRun) return { ...base, status: "dry_run", ...(bridge ? { bridge } : {}), swap, transactions: [] };
        const allowance = await monad.readContract({ address: MONAD_USDC, abi: erc20Abi, functionName: "allowance", args: [address, CURVE_POOL] });
        const before = await walletAusd(address);
        const sent = await sendPlanned(await getExec(), curveSwapTxs(address, amount, q.min, allowance), { signal: io.signal });
        txs.push(...sent.sent);
        if (!sent.complete) return { ...base, status: "pending", ...(bridge ? { bridge } : {}), swap, transactions: txs, pending: sent.pending, note: "After approval, run: mm monadefi fund --from monad --amount <USDC> --deposit-perpl" };
        ausdGained = Math.max(0, (await walletAusd(address)) - before);
        swap.ausdReceived = ausdGained;
        io.emit(`Swapped: +${num(ausdGained, 4)} AUSD in the wallet.`);
      } else if (dryRun) return { ...base, status: "dry_run", ...(bridge ? { bridge } : {}), transactions: [] };

      // ── 3. Optional Perpl deposit ───────────────────────────────────────────────────────────
      let perplDeposit: Result["perplDeposit"];
      if (isTruthyFlag(f["deposit-perpl"]) && ausdGained > 0) {
        const want = Math.floor((ausdGained / 1.01) * 1e6) / 1e6; // fundingTxs adds 1% headroom.
        if (want < 10) perplDeposit = { ausd: 0, note: `Only ${num(ausdGained, 4)} AUSD: a Perpl deposit is at least 10 AUSD. The AUSD stays in the wallet.` };
        else {
          const acct = await getAccount(address);
          const fund = await fundingTxs(address, acct.freeUsd + want);
          const sent = await sendPlanned(await getExec(), fund.txs.map((t) => perplTx(t, "perps.deposit")), { signal: io.signal });
          txs.push(...sent.sent);
          if (!sent.complete) return { ...base, status: "pending", ...(bridge ? { bridge } : {}), ...(swap ? { swap } : {}), transactions: txs, pending: sent.pending };
          perplDeposit = { ausd: fund.depositUsd };
          io.emit(`Deposited ${fund.depositUsd} AUSD into Perpl.`);
        }
      }
      const status: Status = perplDeposit?.ausd ? "deposited" : swap ? "swapped" : "bridged";
      return { ...base, status, ...(bridge ? { bridge } : {}), ...(swap ? { swap } : {}), ...(perplDeposit ? { perplDeposit } : {}), transactions: txs };
    } catch (err) {
      throw toCommandError(err);
    }
  }

  private async checkOriginBalance(ctx: Ctx, origin: OriginChain, address: `0x${string}`, contract: string | undefined, amount: bigint, decimals: number, symbol: string) {
    let client: PublicClient;
    try {
      client = ctx.publicClient(origin.chainId);
    } catch {
      return; // No read client for this chain: the executor's simulation still checks the balance.
    }
    const bal = isEvmAddr(contract)
      ? await client.readContract({ address: contract as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [address] })
      : await client.getBalance({ address });
    if (bal < amount) throw new CommandError("INSUFFICIENT_FUNDS", `The wallet holds ${Number(bal) / 10 ** decimals} ${symbol} on ${origin.name}, less than ${Number(amount) / 10 ** decimals}.`, `Lower --amount or fund the wallet on ${origin.name}.`);
  }

  override successHint(d: Result): string {
    if (d.status === "pending") return d.note ?? `Waiting for approval${d.pending?.pollingId ? `: mm wallet requests watch ${d.pending.pollingId}` : ""}.`;
    if (d.status === "refunded") return `Refunded on ${d.from}: ${d.bridge?.refund?.amount ?? "?"} ${d.asset}.`;
    if (d.status === "deposited") return "Funded. Next: mm monadefi open-perpl --market ETH --side long --leverage 2 --margin 20";
    if (d.status === "dry_run") return `Quote only. Send with: mm monadefi fund --from ${d.from} --amount ${d.amount} --asset ${d.asset} --deposit-perpl`;
    return `Status ${d.status}. See: mm monadefi positions`;
  }
}
