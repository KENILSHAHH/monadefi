import { describe, expect, it, vi } from "vitest";

vi.mock("@metamask/agent-wallet/plugin", () => ({
  CommandError: class CommandError extends Error { constructor(readonly code: string, message: string, readonly hint: string) { super(message); } },
}));
const { resolveAddress, selectedAddress, toCommandError } = await import("../src/lib/host");
const { FlowStopped } = await import("../src/lib/send");

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("host helpers", () => {
  it("resolves the selected wallet by id, then address", () => {
    const state = { byokWallets: [], remoteWallets: [{ id: "w1", address: A }, { id: "w2", address: B }], selectedWallet: { mode: "server", namespace: "evm", ref: { id: "w2" } } };
    expect(selectedAddress(state)).toBe(B);
    expect(selectedAddress({ ...state, selectedWallet: { mode: "server", namespace: "evm", ref: { address: A.toUpperCase().replace("0X", "0x") } } })).toBe(A);
    expect(selectedAddress({ byokWallets: [], remoteWallets: [] })).toBeUndefined();
  });

  it("uses --address for read-only views and asks for a login otherwise", () => {
    const ctx = { walletStateManager: { read: () => ({ byokWallets: [], remoteWallets: [] }) } } as never;
    expect(resolveAddress(ctx, A)).toBe(A);
    expect(() => resolveAddress(ctx, undefined)).toThrow(/No Agent Wallet is selected/);
    expect(() => resolveAddress(ctx, "0x123")).toThrow(/Not an EVM address/);
  });

  it("turns a stopped flow into a command error with the polling hint", () => {
    const e = toCommandError(new FlowStopped("Step 2/2 did not complete", [{ description: "approve", chainId: 143, status: "CONFIRMED", hash: "0xa" }], "poll-7")) as Error & { hint: string; code: string };
    expect(e.code).toBe("TX_NOT_COMPLETED");
    expect(e.message).toContain("approve (0xa)");
    expect(e.hint).toBe("Watch or approve it: mm wallet requests watch poll-7");
  });
});
