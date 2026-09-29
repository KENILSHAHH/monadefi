// USDC -> AUSD on Monad through the Curve stableswap pool (coins: 0 AUSD, 1 USDC, 2 USDT0). LI.FI has no USDC -> AUSD route on
// Monad (checked on 2026-10-13: "No available quotes"). The pool pays the output to `receiver`, here the wallet itself.
// Pool: 0x942644106b073e30d72c2c5d7529d5c296ea91ab, read on-chain (coins, get_dy, exchange with receiver).
import { encodeFunctionData, erc20Abi, parseAbi, type Address, type PublicClient } from "viem";
import type { PlannedTx } from "./types";

export const CURVE_POOL = "0x942644106b073e30d72c2c5d7529d5c296ea91ab" as Address;
export const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address;
const USDC_INDEX = 1n;
const AUSD_INDEX = 0n;
const curveAbi = parseAbi(["function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)", "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver) returns (uint256)"]);

/** Expected and minimum AUSD (6 decimals) for `dx` USDC base units. */
export async function curveQuote(client: PublicClient, dx: bigint, slippageBps: number) {
  const dy = await client.readContract({ address: CURVE_POOL, abi: curveAbi, functionName: "get_dy", args: [USDC_INDEX, AUSD_INDEX, dx] });
  return { expected: dy, min: (dy * BigInt(10_000 - slippageBps)) / 10_000n };
}

/** The approval (when the allowance is short) and the swap, paid to the same wallet. */
export function curveSwapTxs(wallet: Address, dx: bigint, minOut: bigint, allowance: bigint): PlannedTx[] {
  const txs: PlannedTx[] = [];
  if (allowance < dx) txs.push({ chainId: 143, to: MONAD_USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CURVE_POOL, dx] }), value: "0", description: `Allow Curve to take ${Number(dx) / 1e6} USDC`, action: "swap.approve" });
  txs.push({ chainId: 143, to: CURVE_POOL, data: encodeFunctionData({ abi: curveAbi, functionName: "exchange", args: [USDC_INDEX, AUSD_INDEX, dx, minOut, wallet] }), value: "0", description: `Swap ${Number(dx) / 1e6} USDC to at least ${Number(minOut) / 1e6} AUSD on Curve`, action: "swap" });
  return txs;
}
