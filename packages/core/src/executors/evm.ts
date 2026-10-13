// Send agent-built EVM transactions from the user's agent wallet, in order, and read each receipt.
import { createWalletClient, encodeFunctionData, erc20Abi, http, parseUnits, type Address } from "viem";
import type { EvmTx } from "../adapters/evm";
import { CHAINS, USDC, type ChainKey } from "../registry/chains";
import { isSponsored, sendSponsored } from "../sponsor";
import { isMeraUser, legacyAccount, publicClient, signerClient, viemChain } from "../wallet";
import { wrapSessionTransactions } from "../session";

export interface SentTx { hash: string; explorer: string; block: number; description: string; contractAddress: string | null; gasUsed: string }

/** `legacy` sends from the legacy key in place of the wallet. */
export async function sendTransactions(userId: string, chain: ChainKey, txs: EvmTx[], opts: { legacy?: boolean } = {}): Promise<SentTx[]> {
  // A Mera wallet acts through its session: the agent key redeems the delegations, and the sponsor pays the gas.
  if (!opts.legacy && (await isMeraUser(userId))) {
    if (chain !== "monad") throw new Error("A passkey wallet trades through its session on Monad only. Do this in the app.");
    // With the sponsor, sendSponsored redeems the session chain. Without it, the agent key redeems and pays its own gas.
    if (!isSponsored(chain)) return sendTransactions(userId, chain, await wrapSessionTransactions(userId, txs), { legacy: true });
  }
  // With gas sponsorship, the sponsor sends one transaction and the wallet of the user makes all the calls in it. They succeed or fail together.
  if (isSponsored(chain)) {
    const r = await sendSponsored(userId, chain, txs, opts);
    return txs.map((tx, i) => ({ hash: r.hash, explorer: `${CHAINS[chain].explorer}/tx/${r.hash}`, block: r.block, description: tx.description, contractAddress: r.deployed[i] ?? null, gasUsed: r.gasUsed }));
  }
  const wallet = opts.legacy ? createWalletClient({ account: await legacyAccount(userId), chain: viemChain(chain), transport: http() }) : await signerClient(userId, chain);
  const reader = publicClient(chain);
  const sent: SentTx[] = [];
  for (const [i, tx] of txs.entries()) {
    let hash: `0x${string}`;
    try {
      hash = await wallet.sendTransaction({ to: tx.to ?? undefined, data: tx.data, value: BigInt(tx.value) } as never);
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      const hint = /insufficient funds|gas required exceeds/i.test(String(err)) ? ` The agent wallet needs native gas on ${CHAINS[chain].name}.` : "";
      throw new Error(`Transaction ${i + 1} of ${txs.length} ("${tx.description}") was not sent: ${msg}.${hint} ${sent.length} earlier transaction(s) are final: ${sent.map((s) => s.hash).join(", ") || "none"}.`);
    }
    const r = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== "success") throw new Error(`Transaction ${i + 1} ("${tx.description}") reverted on-chain: ${hash}. Earlier transactions are final.`);
    sent.push({ hash, explorer: `${CHAINS[chain].explorer}/tx/${hash}`, block: Number(r.blockNumber), description: tx.description, contractAddress: r.contractAddress ?? null, gasUsed: r.gasUsed.toString() });
  }
  return sent;
}

/** Send funds from the wallet of the user back to the owner. The destination is always the sign-in address. */
export async function withdrawToOwner(userId: string, args: { chain: ChainKey; asset: "USDC" | "MON"; amount: number }) {
  const to = userId as Address;
  let tx: EvmTx;
  if (args.asset === "MON") {
    tx = { to, data: "0x", value: parseUnits(args.amount.toString(), 18).toString(), description: `Withdraw ${args.amount} MON` };
  } else {
    const usdc = USDC[args.chain];
    if (!usdc) throw new Error(`No USDC entry for ${CHAINS[args.chain].name}.`);
    tx = { to: usdc.address as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, parseUnits(args.amount.toString(), usdc.decimals)] }), value: "0", description: `Withdraw ${args.amount} USDC` };
  }
  const [sent] = await sendTransactions(userId, args.chain, [tx]);
  return { hash: sent!.hash, explorer: sent!.explorer, to };
}
