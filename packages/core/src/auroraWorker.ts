// What happens after an Aurora deposit settles on Monad. The cross-chain part is hidden from the user:
//   AUSD arrived (Intents Connect ran the Curve swap)  -> fund Perpl through the session, and open the asked position after the Nansen gate;
//   USDC arrived (Swap API)                            -> the phone signs the Curve USDC -> AUSD swap through the gasless relay.
import { applyVerdict, assessTrade } from "@app/risk";
import { encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from "viem";
import * as perpl from "./adapters/perpl";
import { MONAD } from "./adapters/aurora";
import { pollAuroraDeposits, type AuroraDeposit, type NextStep } from "./auroraDeposits";
import { config } from "./config";
import { sql } from "./db";
import { executePerpl } from "./executors/perpl";
import { sessionStatus } from "./session";
import { publicClient } from "./wallet";

const curveAbi = parseAbi(["function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)", "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver) returns (uint256)"]);

async function setAfter(id: string, status: string, result: unknown) {
  await sql()`update aurora_deposits set after_status = ${status}, after_result = ${sql().json((result ?? null) as never)}, updated_at = now() where id = ${id}`;
}

/** Run the step after one settled deposit. It never throws: the outcome is stored on the row. */
export async function runAfterStep(d: AuroraDeposit, next: NextStep) {
  const userId = d.userId;
  const address = d.recipient as Address;
  try {
    if (next.kind === "needs_conversion") return setAfter(d.id, "needs_conversion", { usdc: next.usdc });
    if ((await sessionStatus(userId)).status !== "active") return setAfter(d.id, "needs_session", { ausd: next.ausd, note: "Turn on trading in the app to move the AUSD into Perpl." });
    const a = next.afterAction;
    if (a?.type === "perpl_open") {
      // The same Nansen gate as every other order: it can block, lower the leverage and the margin, and add a stop-loss.
      const m = await perpl.getMarket(a.market);
      const marginUsd = Math.min(a.usd ?? next.ausd * 0.97, next.ausd * 0.97);
      const verdict = await assessTrade({ apiKey: config().NANSEN_API_KEY, market: m.symbol, side: a.side, leverage: a.leverage, marginUsd, marketMaxLeverage: m.maxLeverage, trader: address, maxCredits: config().NANSEN_MAX_CREDITS });
      const gated = applyVerdict({ leverage: Math.min(a.leverage, m.maxLeverage), marginUsd, stopLossPx: null }, verdict, { entryPx: m.markPx });
      if (gated.blocked) {
        const funded = next.ausd >= 10 ? await executePerpl(userId, address, { op: "deposit", usd: Math.floor(next.ausd * 100) / 100 }) : null;
        return setAfter(d.id, funded ? "funded" : "ready", { blockedByNansen: verdict.reasons, changes: gated.changes, funded });
      }
      const res = await executePerpl(userId, address, { op: "open", market: m.symbol, side: a.side, leverage: Math.max(1, gated.order.leverage), marginUsd: gated.order.marginUsd, orderKind: "market", slippageBps: 100 });
      return setAfter(d.id, "opened", { ...res, riskChanges: gated.changes });
    }
    // A Perpl deposit is at least 10 AUSD. A smaller amount stays in the wallet, ready for the next order.
    if (next.ausd < 10) return setAfter(d.id, "ready", { ausd: next.ausd, note: "Less than 10 AUSD: it stays in your wallet. The next order deposits it." });
    return setAfter(d.id, "funded", await executePerpl(userId, address, { op: "deposit", usd: Math.floor(next.ausd * 100) / 100 }));
  } catch (err) {
    return setAfter(d.id, "failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

/** The two calls that turn USDC in the wallet into AUSD on Curve, to the same wallet. The phone signs them through the relay. */
export async function conversionCalls(address: Address, usdc: number): Promise<{ to: Address; data: Hex; value: string; description: string }[]> {
  const dx = BigInt(Math.floor(usdc * 1e6));
  if (dx <= 0n) throw new Error("No USDC to convert.");
  const dy = await publicClient("monad").readContract({ address: MONAD.CURVE_POOL, abi: curveAbi, functionName: "get_dy", args: [BigInt(MONAD.CURVE_USDC_INDEX), BigInt(MONAD.CURVE_AUSD_INDEX), dx] });
  const minOut = (dy * 995n) / 1000n;
  return [
    { to: MONAD.USDC as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MONAD.CURVE_POOL, dx] }), value: "0", description: `Allow Curve to take ${usdc} USDC` },
    { to: MONAD.CURVE_POOL, data: encodeFunctionData({ abi: curveAbi, functionName: "exchange", args: [BigInt(MONAD.CURVE_USDC_INDEX), BigInt(MONAD.CURVE_AUSD_INDEX), dx, minOut, address] }), value: "0", description: `Swap ${usdc} USDC to at least ${Number(minOut) / 1e6} AUSD` },
  ];
}

let running = false;
/** Poll Aurora every few seconds and run the step after each settled deposit. */
export function startAuroraWorker(intervalMs = 5_000) {
  if (!process.env.AURORA_API_KEY) return false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await pollAuroraDeposits({ workerId: `api-${process.pid}` });
      for (const s of r.settled) await runAfterStep(s.deposit, s.next);
    } catch (err) {
      console.error("aurora worker:", err instanceof Error ? err.message.split("\n")[0] : err);
    } finally {
      running = false;
    }
  }, intervalMs).unref();
  return true;
}
