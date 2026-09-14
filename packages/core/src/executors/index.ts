// Deterministic execution of an intent from the agent wallet: execute → verify → log.
import type { EvmTx } from "../adapters/evm";
import { recordCharge } from "../billing/pricing";
import { sql } from "../db";
import { createGuard, listGuards, normalizePerpParams, type PerpGuardAction, type PerpGuardParams } from "../guards";
import { transition, type Intent } from "../intents";
import type { ChainKey } from "../registry/chains";
import { createJob } from "../jobs";
import { sendTransactions } from "./evm";
import { createExitJobs, executePerpl, type PerplOp } from "./perpl";

async function hasPerpGuard(userId: string, market: string) {
  return (await listGuards(userId, "active")).some((g) => g.venue === "perpl" && (g.params as PerpGuardParams).market === market);
}

async function logAction(intent: Intent, chain: string, txHash: string) {
  await sql()`insert into action_log (user_id, intent_id, intent_hash, chain, tx_hash) values (${intent.userId}, ${intent.id}, ${intent.intentHash}, ${chain}, ${txHash})`;
}

async function run(intent: Intent, address: string): Promise<Record<string, unknown>> {
  const p = intent.params as Record<string, any>;
  switch (intent.kind) {
    case "perpl": {
      // Perpl trades from the wallet itself on Monad. The order is built again now from live prices.
      const op = p.op as PerplOp;
      const res = await executePerpl(intent.userId, address as `0x${string}`, op, (intent.preview.markPx as number | undefined) ?? null);
      for (const r of (res.receipts as { hash: string }[]) ?? []) await logAction(intent, "monad", r.hash);
      // Every new Perpl position gets a guard: it deleverages near liquidation, and Nansen watches the position.
      // An explicit guard of the order replaces the default (10% from liquidation, partial deleverage).
      if (op.op === "open" && res.positionAfter && !(await hasPerpGuard(intent.userId, op.market))) {
        const g = p.guard as { triggerDistancePct: number; action: PerpGuardAction } | null | undefined;
        const guard = await createGuard(intent.userId, "perpl", normalizePerpParams({ market: op.market, triggerDistancePct: g?.triggerDistancePct ?? 10, action: g?.action ?? "partial_deleverage", nansen: true }));
        res.guardId = guard.id;
      }
      // Stop-loss and take-profit asked with the order: server jobs that watch the Perpl mark price.
      if (op.op === "open" && (p.stopLossPx || p.takeProfitPx) && res.positionAfter) {
        res.exitJobs = await createExitJobs(intent.userId, { market: op.market, side: op.side, stopLossPx: p.stopLossPx, takeProfitPx: p.takeProfitPx });
      }
      return res;
    }
    case "bridge":
    case "evm_transactions": {
      const chain: ChainKey = intent.kind === "bridge" ? p.fromChain : p.chain;
      const txs = (intent.preview.transactions as (EvmTx & { chainId?: number })[]).map((t) => ({ to: t.to, data: t.data, value: String(t.value ?? "0"), description: t.description }));
      const receipts = await sendTransactions(intent.userId, chain, txs);
      for (const r of receipts) await logAction(intent, chain, r.hash);
      const extra: Record<string, unknown> = {};
      if (intent.kind === "bridge") extra.requestIds = ((intent.preview.steps as { requestId: string | null }[]) ?? []).map((s) => s.requestId).filter(Boolean);
      return { receipts, ...extra };
    }
    case "job_create": {
      const job = await createJob(intent.userId, { name: p.name, condition: p.condition, action: p.action, days: p.days, repeat: p.repeat });
      return { jobId: job.id, status: job.status, fires: job.conditionText, expiresAt: job.expiresAt };
    }
    default:
      throw new Error(`Intent kind "${intent.kind}" has no executor.`);
  }
}

/** Run a claimed intent (status "executing") and store the outcome. It never throws. */
export async function executeIntent(intent: Intent, address: string): Promise<Intent> {
  try {
    const result = await run(intent, address);
    if (intent.feeUsd > 0) await recordCharge({ userId: intent.userId, kind: "action", amountUsd: intent.feeUsd, detail: { intentId: intent.id, kind: intent.kind } });
    return (await transition(intent.id, intent.userId, "executing", "done", result))!;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // A stable code for the app: the passkey wallet must turn trading on again.
    const code = /Trading is not turned on|session ended|outside the trading session/.test(error) ? "session_inactive" : undefined;
    return (await transition(intent.id, intent.userId, "executing", "failed", { error, ...(code ? { code } : {}) }))!;
  }
}
