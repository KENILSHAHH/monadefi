/** Balances of the MetaMask account on Monad, read from the public Monad RPC (no session, no API call). */
import { createPublicClient, erc20Abi, http, type Address } from "viem";
import { monad } from "viem/chains";
import { config } from "../config";
import type { MonadToken } from "./core";

const client = createPublicClient({ chain: monad, transport: http(config.monadRpc) });

export async function monadBalance(owner: Address, token: MonadToken): Promise<bigint> {
  if (token.address === null) return client.getBalance({ address: owner });
  return client.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}
