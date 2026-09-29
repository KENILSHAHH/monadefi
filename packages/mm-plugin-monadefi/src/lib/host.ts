// Access to the host context: the selected wallet address, the Monad read client and the wallet executor.
import { configurePerpl } from "@app/perpl";
import { CommandError, type CommandIO } from "@metamask/agent-wallet/plugin";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { InputError, optional, parseAddress } from "./args";
import { FlowStopped } from "./send";
import type { Executor } from "./types";

export const MONAD = 143;

// The plugin context type from @metamask/agent-wallet/plugin. Kept loose: only the members below are used.
export interface Ctx {
  walletStateManager: { read(): WalletState };
  publicClient(chainId: number): PublicClient;
  walletExecutor(io: CommandIO, source: string, opts?: { emitStepNotices?: boolean }): Promise<unknown>;
}
interface WalletRec { address: string; id?: string; name?: string; namespace?: string }
interface WalletState {
  byokWallets: WalletRec[];
  remoteWallets: WalletRec[];
  selectedWallet?: { mode: string; namespace: string; ref: { id?: string; address?: string; name?: string } };
}

/** The selected EVM wallet address. Same lookup as the host CLI: the selection's ref by id, then by address, then by name. */
export function selectedAddress(state: WalletState | undefined): `0x${string}` | undefined {
  if (!state) return undefined;
  const all = [...(state.remoteWallets ?? []), ...(state.byokWallets ?? [])];
  const sel = state.selectedWallet;
  const ref = sel?.ref ?? {};
  let addr: string | undefined;
  if (sel) {
    addr = ref.id ? all.find((w) => w.id === ref.id)?.address : undefined;
    addr ??= ref.address ? all.find((w) => w.address.toLowerCase() === ref.address!.toLowerCase())?.address ?? ref.address : undefined;
    addr ??= ref.name ? all.find((w) => w.name === ref.name)?.address : undefined;
  }
  addr ??= all.find((w) => !w.namespace || w.namespace === "evm" || w.namespace === "eip155")?.address;
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? (addr as `0x${string}`) : undefined;
}

/** The address to read: --address when given, else the selected Agent Wallet. */
export function resolveAddress(ctx: Ctx, explicit?: unknown): `0x${string}` {
  const given = optional(explicit);
  if (given) return parseAddress(given);
  let state: WalletState | undefined;
  try {
    state = ctx.walletStateManager.read();
  } catch {
    state = undefined;
  }
  const a = selectedAddress(state);
  if (!a) throw new InputError("No Agent Wallet is selected. Run `mm login` and `mm init`, or pass --address 0x... for a read-only view.", "MISSING_WALLET_REF");
  return a;
}

/** The selected wallet address for a write. --address is not accepted: a write always uses the signing wallet. */
export function signerAddress(ctx: Ctx): `0x${string}` {
  const a = selectedAddress(ctx.walletStateManager.read());
  if (!a) throw new CommandError("MISSING_WALLET_REF", "No Agent Wallet is selected.", "Run `mm login` and `mm init` first.");
  return a;
}

/** A read client for a chain: the host's authenticated client, or the public RPC when the host client is not available (no login). */
export function readClient(ctx: Ctx, chainId: number, fallbackRpc?: string): PublicClient {
  try {
    return ctx.publicClient(chainId);
  } catch (err) {
    if (!fallbackRpc) throw err;
    return createPublicClient({ transport: http(fallbackRpc) }) as PublicClient;
  }
}

// The host client and @app/perpl may resolve different copies of viem's types; the runtime object is the same shape.
const setPerplClient = (client: PublicClient) => configurePerpl({ client: client as unknown as NonNullable<Parameters<typeof configurePerpl>[0]["client"]> });

export const MONAD_PUBLIC_RPC = "https://rpc.monad.xyz";

/**
 * Point @app/perpl at the host's authenticated Monad client. Without a login (read-only use with --address) the host
 * client can fail, so it is probed once; on failure the public Monad RPC is used for reads. Writes never use this fallback:
 * they go through the wallet executor.
 */
export async function usePerpl(ctx: Ctx | null): Promise<{ client: PublicClient; source: "agent-wallet" | "public-rpc" }> {
  if (ctx) {
    try {
      const client = ctx.publicClient(MONAD);
      const id = await client.getChainId();
      if (id === MONAD) {
        setPerplClient(client);
        return { client, source: "agent-wallet" };
      }
    } catch {
      // Fall through to the public RPC.
    }
  }
  const client = createPublicClient({ transport: http(MONAD_PUBLIC_RPC) }) as PublicClient;
  setPerplClient(client);
  return { client, source: "public-rpc" };
}

export async function executor(ctx: Ctx, io: CommandIO, commandId: string): Promise<Executor> {
  return (await ctx.walletExecutor(io, commandId, { emitStepNotices: true })) as Executor;
}

export async function receiptLogs(client: PublicClient, hash: string) {
  const r = await client.getTransactionReceipt({ hash: hash as Hex });
  return { status: r.status, logs: r.logs, blockNumber: r.blockNumber };
}

/** Map plugin errors to host CommandErrors so the CLI renders a code and a hint. */
export function toCommandError(err: unknown): Error {
  if (err instanceof CommandError) return err;
  if (err instanceof InputError) return new CommandError(err.code, err.message, "Check the flags with --help.");
  if (err instanceof FlowStopped) {
    const done = err.sent.length ? ` Completed before the stop: ${err.sent.map((s) => `${s.description} (${s.hash})`).join("; ")}.` : " Nothing was sent before the stop.";
    const hint = err.pollingId ? `Watch or approve it: mm wallet requests watch ${err.pollingId}` : "Check `mm wallet requests list` and the explorer, then run the command again.";
    return new CommandError(err.code || "TX_NOT_COMPLETED", `${err.message}${done}`, hint);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new CommandError("MONADEFI_ERROR", msg, "Run again with --verbose for details.");
}
