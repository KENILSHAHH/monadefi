// Liquidation Guard watcher for Perpl positions. Run two copies with different WATCHER_ID values.
// Both copies evaluate every guard. The atomic claim in the database lets exactly one copy act.
import { hostname } from "node:os";
import { config, getOrCreateWallet, jobs, migrate, perpl, recordCharge, risk, sql } from "@app/core";
import { createExitJobs, executePerpl } from "@app/core/executors/perpl";
import {
  claimFiring, evaluatePerpGuard, executePerpGuardAction, finishFiring, listGuards, recordCheck, superviseDecision,
  type Guard, type PerpGuardParams,
} from "@app/core/guards";

const WATCHER = process.env.WATCHER_ID ?? `${hostname()}-${process.pid}`;
const INTERVAL_MS = Number(process.env.GUARD_INTERVAL_MS ?? 1_000);
/** How often Nansen re-reads a guarded position. Each read costs about 2 credits. */
const NANSEN_EVERY_MS = Number(process.env.NANSEN_MONITOR_MINUTES ?? 15) * 60_000;
const nansenChecked = new Map<string, number>();

/**
 * Nansen watches the position: smart money, whales and exchange flows against it change what the agent does.
 * "exit" closes it, "reduce" closes part, "tighten_stop" moves the stop-loss job closer. Plain code acts; no model decides.
 */
async function nansenCheck(guard: Guard, params: PerpGuardParams, position: perpl.PerplPosition) {
  if (!params.nansen || !config().NANSEN_API_KEY) return;
  if (Date.now() - (nansenChecked.get(guard.id) ?? 0) < NANSEN_EVERY_MS) return;
  nansenChecked.set(guard.id, Date.now());
  const market = await perpl.getMarket(params.market);
  const m = await risk.monitorPosition({ apiKey: config().NANSEN_API_KEY, market: market.symbol, side: position.side, entryPx: position.entryPx, markPx: position.markPx, sizeUsd: position.notionalUsd, leverage: position.leverage, marketMaxLeverage: market.maxLeverage, trader: guard.userId });
  if (m.action === "hold") return;
  const key = await claimFiring(guard, WATCHER);
  if (!key) return;
  const decision = { action: `nansen_${m.action}`, reason: m.reason, source: "nansen", score: m.verdict.score };
  console.log(`[${WATCHER}] guard ${guard.id}: Nansen says ${m.action} on ${market.symbol} ${position.side} (${m.reason})`);
  try {
    const { address } = await getOrCreateWallet(guard.userId);
    let result: unknown;
    if (m.action === "tighten_stop" && m.stopPx) {
      // Replace the stop-loss jobs of this market with one at the tighter level.
      for (const j of await jobs.listJobs(guard.userId, true)) if (j.status === "active" && j.action.type === "perpl" && j.action.op === "close" && j.action.market === market.symbol && /^Stop-loss/.test(j.name)) await jobs.cancelJob(j.id, guard.userId);
      result = await createExitJobs(guard.userId, { market: market.symbol, side: position.side, stopLossPx: m.stopPx });
    } else {
      const fraction = m.action === "exit" ? 1 : Math.min(0.75, Math.max(0.25, m.reduceFraction ?? 0.5));
      result = await executePerpl(guard.userId, address, { op: "close", market: market.symbol, fraction, orderKind: "market", slippageBps: params.maxSlippageBps });
    }
    await finishFiring(key, guard, { ok: true, decision, result, rearm: m.action !== "exit" });
  } catch (err) {
    await finishFiring(key, guard, { ok: false, decision, result: { error: String(err) }, rearm: true });
    console.error(`[${WATCHER}] guard ${guard.id} Nansen action failed:`, err);
  }
}

async function checkPerpGuard(guard: Guard) {
  const params = guard.params as PerpGuardParams;
  const { address } = await getOrCreateWallet(guard.userId);
  // One contract read of the guarded market. A stale mark price is not a trigger: the next tick reads again.
  const position = await perpl.getPosition(address, params.market);
  if (position && !position.markPriceValid) return;
  const verdict = evaluatePerpGuard(params, position);
  await recordCheck(guard.id, verdict.distancePct);

  if (verdict.state === "closed") {
    await sql()`update guards set status = 'done' where id = ${guard.id} and status = 'active'`;
    return;
  }
  if (verdict.state !== "triggered" || !position) {
    if (position) await nansenCheck(guard, params, position);
    return;
  }

  const key = await claimFiring(guard, WATCHER);
  if (!key) return; // The other watcher has the claim.
  console.log(`[${WATCHER}] guard ${guard.id} triggered: Perpl ${params.market} is ${verdict.distancePct?.toFixed(2)}% from liquidation`);

  const decision = await superviseDecision(params, position);
  try {
    const { result, rearm } = await executePerpGuardAction(guard, decision.action);
    await finishFiring(key, guard, { ok: true, decision, result, rearm });
    console.log(`[${WATCHER}] guard ${guard.id} ${decision.action} (${decision.source}) done`);
  } catch (err) {
    await finishFiring(key, guard, { ok: false, decision, result: { error: String(err) }, rearm: true });
    console.error(`[${WATCHER}] guard ${guard.id} action failed:`, err);
  }
}

/** Metered billing: one charge row per watched minute. */
async function bill(guards: Guard[]) {
  const price = config().PRICE_GUARD_MINUTE_USD;
  for (const g of guards) {
    const rows = await sql()`update guards set charged_until = charged_until + interval '1 minute'
      where id = ${g.id} and status = 'active' and charged_until <= now() returning id`;
    if (rows.length) await recordCharge({ userId: g.userId, kind: "guard", amountUsd: price, detail: { guardId: g.id, watcher: WATCHER } });
  }
}

async function tick() {
  const guards = await listGuards(undefined, "active");
  await Promise.allSettled(
    guards.map((g) => checkPerpGuard(g)).map((p, i) =>
      p.catch((err) => console.error(`[${WATCHER}] check failed for guard ${guards[i]?.id}:`, err instanceof Error ? err.message : err)),
    ),
  );
  await bill(guards);
}

await migrate();
console.log(`[${WATCHER}] guard watcher started, interval ${INTERVAL_MS} ms`);
for (;;) {
  const started = Date.now();
  await tick().catch((err) => console.error(`[${WATCHER}] tick failed:`, err));
  await new Promise((r) => setTimeout(r, Math.max(0, INTERVAL_MS - (Date.now() - started))));
}
