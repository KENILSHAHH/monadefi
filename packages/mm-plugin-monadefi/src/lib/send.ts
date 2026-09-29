// Send planned transactions one by one through the Agent Wallet executor. No other signing path exists in this plugin.
// Each step waits for its receipt, because a later step depends on it (approve -> deposit -> order).
// The executor drives policy, simulation, Blockaid and MFA. A step that does not reach a hash (for example a job
// still in AWAITING_MFA when the wait ends) stops the flow; the result carries the pollingId to watch.
import type { Executor, PlannedTx, SentTx } from "./types";

const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io", 10: "https://optimistic.etherscan.io", 56: "https://bscscan.com", 137: "https://polygonscan.com",
  143: "https://monadscan.com", 8453: "https://basescan.org", 42161: "https://arbiscan.io", 43114: "https://snowtrace.io",
};
export const explorerTx = (chainId: number, hash: string) => (EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/tx/${hash}` : undefined);

export class FlowStopped extends Error {
  constructor(message: string, readonly sent: SentTx[], readonly pollingId?: string, readonly code = "TX_NOT_COMPLETED") {
    super(message);
  }
}

export interface SendResult { sent: SentTx[]; complete: boolean; pending?: SentTx }

export async function sendPlanned(exec: Executor, txs: PlannedTx[], opts: { signal?: AbortSignal; onStep?: (s: SentTx, i: number, n: number) => void } = {}): Promise<SendResult> {
  const sent: SentTx[] = [];
  for (const [i, tx] of txs.entries()) {
    if (opts.signal?.aborted) throw new FlowStopped("Stopped by the user before all steps were sent.", sent);
    let res;
    try {
      res = await exec(
        { kind: "transaction", chainId: tx.chainId, transaction: { to: tx.to, data: tx.data, value: BigInt(tx.value || "0") }, intent: { summary: tx.description, action: tx.action } },
        { ...(opts.signal ? { signal: opts.signal } : {}), waitForReceipt: true },
      );
    } catch (err) {
      const pollingId = (err as { pendingJob?: { pollingId?: string } })?.pendingJob?.pollingId;
      const msg = err instanceof Error ? err.message : String(err);
      throw new FlowStopped(`Step ${i + 1}/${txs.length} (${tx.description}) did not complete: ${msg}`, sent, pollingId, (err as { code?: string })?.code ?? "TX_NOT_COMPLETED");
    }
    const step: SentTx = { description: tx.description, chainId: tx.chainId, status: res.status, ...(res.hash ? { hash: res.hash, explorerUrl: explorerTx(tx.chainId, res.hash) } : {}), ...(res.pendingJob?.pollingId ? { pollingId: res.pendingJob.pollingId } : {}) };
    opts.onStep?.(step, i, txs.length);
    if (!res.hash) return { sent, complete: false, pending: step };
    sent.push(step);
  }
  return { sent, complete: true };
}
