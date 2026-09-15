// Liquidation Guard of Perpl positions: trigger logic, idempotent claim, bounded supervisor, deterministic deleverage.
// The trigger and the unwind are plain code. A small model only picks one of the actions that the user approved.
import { randomUUID } from "node:crypto";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { PerplPosition } from "./adapters/perpl";
import { GUARD_SUPERVISOR_PROMPT } from "./agent/prompts";
import { config } from "./config";
import { openai, openaiEnabled } from "./openai";
import { sql } from "./db";
import { executePerpl } from "./executors/perpl";
import { getOrCreateWallet } from "./wallet";

export type PerpGuardAction = "full_close" | "partial_deleverage" | "add_margin";

/** Guard of a Perpl position. */
export interface PerpGuardParams {
  /** Perpl market symbol, for example BTC. */
  market: string;
  /** Act when the mark price is within this percent of the liquidation price. */
  triggerDistancePct: number;
  /** Actions the user approved. The first entry is the default. */
  allowedActions: PerpGuardAction[];
  maxSlippageBps: number;
  /** Fraction closed by partial_deleverage. Hard limit set in code: 0.25 to 0.75. */
  partialFraction: number;
  /** Margin added by add_margin, in USD. Hard limit: at most this amount per firing. */
  addMarginUsd: number;
  /** Nansen watches the position too: an "exit" verdict closes it, "reduce" closes part, "tighten_stop" moves the stop-loss closer. */
  nansen?: boolean;
}

export interface Guard {
  id: string;
  userId: string;
  venue: "perpl";
  params: PerpGuardParams;
  status: "active" | "triggered" | "done" | "cancelled" | "failed";
  lastValue: number | null;
  lastCheck: string | null;
  createdAt: string;
}

interface Row { id: string; user_id: string; venue: Guard["venue"]; params: Guard["params"]; status: Guard["status"]; last_value: string | null; last_check: Date | null; created_at: Date }
const toGuard = (r: Row): Guard => ({ id: r.id, userId: r.user_id, venue: r.venue, params: r.params, status: r.status, lastValue: r.last_value === null ? null : Number(r.last_value), lastCheck: r.last_check?.toISOString() ?? null, createdAt: r.created_at.toISOString() });

export function normalizePerpParams(input: { market: string; triggerDistancePct: number; action: PerpGuardAction; maxSlippageBps?: number; addMarginUsd?: number; nansen?: boolean }): PerpGuardParams {
  // A full close is always allowed as the last resort.
  const allowed: PerpGuardAction[] = input.action === "full_close" ? ["full_close"] : [input.action, "full_close"];
  return { market: input.market, triggerDistancePct: input.triggerDistancePct, allowedActions: allowed, maxSlippageBps: input.maxSlippageBps ?? 100, partialFraction: 0.5, addMarginUsd: input.addMarginUsd ?? 0, nansen: input.nansen ?? false };
}

export async function createGuard(userId: string, venue: Guard["venue"], params: Guard["params"]): Promise<Guard> {
  const [row] = await sql()<Row[]>`insert into guards (id, user_id, venue, params) values (${randomUUID()}, ${userId}, ${venue}, ${sql().json(params as never)}) returning *`;
  return toGuard(row!);
}

export async function listGuards(userId?: string, status?: Guard["status"]): Promise<Guard[]> {
  const rows = await sql()<Row[]>`select * from guards where true ${userId ? sql()`and user_id = ${userId}` : sql()``} ${status ? sql()`and status = ${status}` : sql()``} order by created_at desc limit 500`;
  return rows.map(toGuard);
}

export async function cancelGuard(id: string, userId: string) {
  const rows = await sql()`update guards set status = 'cancelled' where id = ${id} and user_id = ${userId} and status = 'active' returning id`;
  return rows.length > 0;
}

export async function recordCheck(id: string, value: number | null) {
  await sql()`update guards set last_value = ${value}, last_check = now() where id = ${id}`;
}

/** Pure trigger test. `position` is the live position, or undefined when it is closed. */
export function evaluatePerpGuard(params: PerpGuardParams, position: PerplPosition | null | undefined): { state: "closed" | "safe" | "triggered"; distancePct: number | null } {
  if (!position || position.size === 0) return { state: "closed", distancePct: null };
  if (position.distanceToLiquidation === null) return { state: "safe", distancePct: null };
  const distancePct = position.distanceToLiquidation * 100;
  return { state: distancePct <= params.triggerDistancePct ? "triggered" : "safe", distancePct };
}

/**
 * Claim a firing. Two watchers run the same check. The status update is atomic, so exactly one watcher gets the claim.
 * The idempotency key is also the primary key of guard_actions.
 */
export async function claimFiring(guard: Guard, watcher: string): Promise<string | null> {
  const key = `${guard.id}:${guard.lastCheck ?? "first"}:fire`;
  return sql().begin(async (tx) => {
    const claimed = await tx`update guards set status = 'triggered' where id = ${guard.id} and status = 'active' returning id`;
    if (claimed.length === 0) return null;
    await tx`insert into guard_actions (idempotency_key, guard_id, watcher, decision) values (${key}, ${guard.id}, ${watcher}, ${tx.json({ state: "claimed" })})`;
    return key;
  });
}

const Decision = z.object({ action: z.enum(["full_close", "partial_deleverage", "add_margin"]), reason: z.string() });

/**
 * Ask the small model to choose among the approved actions. Hard rules:
 * - a short timeout and no retries, so a slow or down API never delays the unwind;
 * - an answer outside the approved list is ignored;
 * - every failure returns the default action.
 */
export async function superviseDecision(params: PerpGuardParams, position: PerplPosition, timeoutMs = 4_000): Promise<{ action: PerpGuardAction; reason: string; source: "model" | "default" }> {
  const fallback = { action: params.allowedActions[0]!, reason: "default action", source: "default" as const };
  if (params.allowedActions.length === 1 || !openaiEnabled()) return fallback;
  try {
    const res = await openai({ timeoutMs, maxRetries: 0 }).responses.parse({
      model: config().OPENAI_GUARD_MODEL,
      max_output_tokens: 1024,
      store: false,
      reasoning: { effort: "low" },
      text: { format: zodTextFormat(Decision, "decision") },
      instructions: GUARD_SUPERVISOR_PROMPT,
      input: JSON.stringify({ allowedActions: params.allowedActions, defaultAction: params.allowedActions[0], triggerDistancePct: params.triggerDistancePct, position }),
    });
    const d = res.output_parsed;
    if (!d || !params.allowedActions.includes(d.action)) return fallback;
    return { action: d.action, reason: d.reason, source: "model" };
  } catch {
    return fallback;
  }
}

/** Run the chosen action with the hard limits. Returns the result and the next guard status. */
export async function executePerpGuardAction(guard: Guard, action: PerpGuardAction) {
  const p = guard.params as PerpGuardParams;
  const { address } = await getOrCreateWallet(guard.userId);
  if (action === "add_margin" && p.addMarginUsd > 0) {
    return { result: await executePerpl(guard.userId, address, { op: "margin", market: p.market, action: "add", usd: p.addMarginUsd }), rearm: true };
  }
  if (action === "partial_deleverage") {
    const fraction = Math.min(0.75, Math.max(0.25, p.partialFraction));
    return { result: await executePerpl(guard.userId, address, { op: "close", market: p.market, fraction, orderKind: "market", slippageBps: p.maxSlippageBps }), rearm: true };
  }
  return { result: await executePerpl(guard.userId, address, { op: "close", market: p.market, fraction: 1, orderKind: "market", slippageBps: p.maxSlippageBps }), rearm: false };
}

export async function finishFiring(key: string, guard: Guard, outcome: { ok: boolean; decision: unknown; result: unknown; rearm: boolean }) {
  await sql()`update guard_actions set status = ${outcome.ok ? "done" : "failed"}, decision = ${sql().json(outcome.decision as never)}, result = ${sql().json((outcome.result ?? null) as never)} where idempotency_key = ${key}`;
  // A failed action re-arms the guard. The next check then tries again with a new key.
  const next = !outcome.ok || outcome.rearm ? "active" : "done";
  await sql()`update guards set status = ${next}, last_check = now() where id = ${guard.id}`;
}
