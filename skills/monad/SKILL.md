---
name: monad
description: Monad mainnet facts. Chain id, RPCs, explorers, MON gas, the gas limit charge, EIP-7702 and the 10 MON reserve rule, token addresses (USDC, AUSD, USDT0, WMON, WETH), bridges and swaps to Monad. Use for any Monad question, transfer, swap or gas problem.
---

# Monad

Checked on 2026-10-13 against docs.monad.xyz (also an MCP docs tool: monad_docs), the Relay and LI.FI APIs and the chain.

## Network

| Item | Value |
|---|---|
| Chain id | 143 (testnet 10143) |
| Native token | MON, 18 decimals |
| RPC | https://rpc.monad.xyz (also rpc1, rpc2, rpc3, rpc4 .monad.xyz, https://rpc-mainnet.monadinfra.com) |
| Explorers | https://monadscan.com, https://monadvision.com |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Block time | about 0.3 s to 0.4 s |

## Gas

- Monad charges the **gas limit** of a transaction, not the gas used. Keep limits tight.
- The minimum base fee is 100 gwei.
- The gas sponsor of this product works on Monad (EIP-7702, MetaMask Delegation Framework). DelegationManager is `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` and EIP7702StatelessDeleGator is `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B`. Both have code on Monad.
- **Reserve balance rule:** a delegated (EIP-7702) account cannot lower its MON balance below 10 MON in a transaction, beyond the gas fee. If it holds less than 10 MON, it cannot send MON out at all. Tokens are not limited. Source: https://docs.monad.xyz/developer-essentials/eip-7702

## Tokens (LI.FI token list and the Monad token list)

| Token | Address | Decimals |
|---|---|---|
| USDC | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | 6 |
| AUSD (Perpl collateral) | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` | 6 |
| USDT0 | `0xe7cd86e13AC4309349F30B3435a9d337750fC82D` | 6 |
| WMON | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` | 18 |
| WETH | `0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242` | 18 |
| WBTC | `0x0555E30da8f98308EdB960aa94C0Db47230d2B9c` | 8 |

## Moving funds to Monad

- Relay supports Monad (chain id 143 in Relay). Use bridge with toChain monad.
- LI.FI supports Monad (key `mon`, id 143). Use swap with fromChain or toChain monad, for example USDC to AUSD.
- To trade on Perpl, the wallet needs AUSD on Monad.
