import { describe, expect, it, vi } from "vitest";
import { FlowStopped, sendPlanned } from "../src/lib/send";
import type { Executor, PlannedTx } from "../src/lib/types";

const tx = (n: number): PlannedTx => ({ chainId: 143, to: "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F", data: "0x01", value: n === 2 ? "1000" : "0", description: `step ${n}`, action: "perps.open" });

describe("sendPlanned", () => {
  it("sends every step through the executor in order, waiting for receipts", async () => {
    const exec = vi.fn<Executor>(async () => ({ kind: "transaction", hash: `0x${"ab".repeat(32)}`, status: "CONFIRMED" }));
    const r = await sendPlanned(exec, [tx(1), tx(2)]);
    expect(r.complete).toBe(true);
    expect(r.sent).toHaveLength(2);
    expect(exec).toHaveBeenCalledTimes(2);
    const [req, opts] = exec.mock.calls[1]!;
    expect(req).toMatchObject({ kind: "transaction", chainId: 143, transaction: { to: tx(2).to, data: "0x01", value: 1000n }, intent: { summary: "step 2", action: "perps.open" } });
    expect(opts).toMatchObject({ waitForReceipt: true });
    expect(r.sent[0]!.explorerUrl).toMatch(/^https:\/\/monadscan.com\/tx\//);
  });

  it("stops at a step without a hash (for example AWAITING_MFA) and reports the pollingId", async () => {
    const exec = vi.fn<Executor>()
      .mockResolvedValueOnce({ kind: "transaction", hash: "0x1", status: "CONFIRMED" })
      .mockResolvedValueOnce({ kind: "transaction", hash: "", status: "AWAITING_MFA", pendingJob: { pollingId: "poll-1" } });
    const r = await sendPlanned(exec, [tx(1), tx(2), tx(3)]);
    expect(r.complete).toBe(false);
    expect(r.sent).toHaveLength(1);
    expect(r.pending).toMatchObject({ status: "AWAITING_MFA", pollingId: "poll-1" });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("wraps an executor failure with the steps already done and the pending job", async () => {
    const err = Object.assign(new Error("Transaction job ended in status DENIED."), { code: "DENIED", pendingJob: { pollingId: "poll-9" } });
    const exec = vi.fn<Executor>().mockResolvedValueOnce({ kind: "transaction", hash: "0x1", status: "CONFIRMED" }).mockRejectedValueOnce(err);
    const p = sendPlanned(exec, [tx(1), tx(2)]);
    await expect(p).rejects.toBeInstanceOf(FlowStopped);
    await p.catch((e: FlowStopped) => {
      expect(e.sent).toHaveLength(1);
      expect(e.pollingId).toBe("poll-9");
      expect(e.code).toBe("DENIED");
      expect(e.message).toMatch(/Step 2\/2/);
    });
  });

  it("does not start when the user already stopped", async () => {
    const ac = new AbortController();
    ac.abort();
    const exec = vi.fn<Executor>();
    await expect(sendPlanned(exec, [tx(1)], { signal: ac.signal })).rejects.toBeInstanceOf(FlowStopped);
    expect(exec).not.toHaveBeenCalled();
  });
});
