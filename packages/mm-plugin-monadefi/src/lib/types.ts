// Structural types for the host wallet executor. They mirror EvmWalletRequest / EvmWalletResult of
// @metamask/agent-sdk 7.2.0 (dist/lib.cjs/walletExecutor-*.d.ts) and EVMTransaction of @metamask/fox-sdk 2.10
// (dist/wallets/evm/types/EVMTransaction.d.ts). The host bundles agent-sdk, so its types are not importable here.
import type { Hex } from "viem";

/** WalletIntent.action values used by this plugin (a subset of WALLET_INTENT_ACTION). */
export type IntentAction = "perps.open" | "perps.close" | "perps.modify" | "perps.deposit" | "transfer" | "swap" | "swap.approve" | "bridge" | "call";

export interface WalletIntent {
  summary: string;
  action: IntentAction;
  details?: Record<string, string | undefined>;
}

export interface TxRequest {
  kind: "transaction";
  chainId: number;
  transaction: { to: string; data?: Hex; value?: bigint };
  intent?: WalletIntent;
}

export interface TxResult {
  kind: "transaction" | "signature";
  hash: string;
  status: string;
  failureCode?: string;
  failureDescription?: string;
  pendingJob?: { pollingId: string; kind?: string };
}

export type Executor = (req: TxRequest, opts?: { signal?: AbortSignal; noAwait?: boolean; waitForReceipt?: boolean }) => Promise<TxResult>;

/** A transaction this plugin wants to send. `value` is in wei, as a decimal string. */
export interface PlannedTx {
  chainId: number;
  to: string;
  data: Hex;
  value: string;
  description: string;
  action: IntentAction;
}

/** The outcome of one sent transaction. */
export interface SentTx {
  description: string;
  chainId: number;
  status: string;
  hash?: string;
  explorerUrl?: string;
  pollingId?: string;
}
