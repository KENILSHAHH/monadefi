// One view of everything a wallet holds: balances, Perpl positions on Monad, active guards.
import type { Address } from "viem";
import * as perpl from "./adapters/perpl";
import { listGuards } from "./guards";
import { walletBalances } from "./wallet";

const settle = async <T>(p: Promise<T>): Promise<{ data: T | null; error: string | null }> => {
  try {
    return { data: await p, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message.slice(0, 160) : String(err) };
  }
};

/** `address` holds the funds and trades on Perpl. */
export async function getPositions(userId: string, address: Address) {
  const [balances, perps, guards] = await Promise.all([
    settle(walletBalances(address)),
    settle(perpl.getAccount(address)),
    settle(listGuards(userId)),
  ]);
  return {
    address,
    asOf: new Date().toISOString(),
    balances: balances.data ?? [],
    /** Perpl on Monad: the trading account (AUSD) and the open positions. */
    perpl: perps.data ?? { address, accountId: null, balanceUsd: 0, lockedUsd: 0, freeUsd: 0, frozen: false, positions: [] },
    guards: (guards.data ?? []).filter((g) => g.status === "active" || g.status === "triggered"),
    // A source that failed is listed here. A missing position is then not read as "no position".
    errors: Object.entries({ balances: balances.error, perpl: perps.error, guards: guards.error }).flatMap(([k, v]) => (v ? [`${k}: ${v}`] : [])),
  };
}
