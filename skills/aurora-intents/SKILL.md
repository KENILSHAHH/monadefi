---
name: aurora-intents
description: Aurora Intents (NEAR Intents / 1Click) facts for deposits from any chain to Monad. Swap API, persistent deposit addresses, Intents Connect deposit-and-execute, Monad asset ids, statuses, refunds, fees, rate limits, and the USDC to AUSD step for Perpl. Use for any cross-chain deposit, bridge-in, refund or "fund my Perpl account from another chain" question.
---

# Aurora Intents

Checked on 2026-10-13 against https://docs.intents.aurora.dev (index: https://docs.intents.aurora.dev/llms.txt) and the live APIs.
Code: `packages/core/src/adapters/aurora.ts` (client) and `packages/core/src/auroraDeposits.ts` (rows, poller, next step).

## Hosts and keys

| API | Base URL | Key |
|---|---|---|
| Swap API and persistent addresses | `https://intents-api.aurora.dev/api` | in the path: `/api/quote/{apiKey}` |
| Intents Connect | `https://intents-connect-api.aurora.dev/api/v1` | header `x-api-key`, only on `POST /executions/{wallet}` |
| Public 1Click (tests only) | `https://1click.chaindefuser.com/v0` | none for dry quotes |

- The key comes from https://studio.aurora.dev. Env var: `AURORA_API_KEY`.
- Aurora says the key is not confidential. The code still never logs it. Errors show `***`.
- The integrator fee is set per key in the portal (https://portal.intents.aurora.dev). The quote request has no fee field.

## Monad assets (from GET /api/tokens)

| Symbol | Asset id | Address |
|---|---|---|
| MON | `nep245:v2_1.omni.hot.tg:143_11111111111111111111` | native |
| USDC | `nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx` | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |
| USDT0 | `nep245:v2_1.omni.hot.tg:143_4EJiJxSALvGoTZbnc8K7Ft9533et` | `0xe7cd86e13AC4309349F30B3435a9d337750fC82D` |

AUSD (`0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`) is not listed. Perpl needs AUSD. A USDC to AUSD swap on Monad is necessary.

## USDC to AUSD on Monad

- Use Curve pool `0x942644106b073e30d72c2c5d7529d5c296ea91ab` (stableswap-ng). coins: 0 = AUSD, 1 = USDC, 2 = USDT0. Fee 0.005 %.
- Call `exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)` with i = 1, j = 0. The `receiver` gets the AUSD.
- On 2026-10-13, `get_dy(1, 0, 100e6)` returned 100.01 AUSD. The pool held about 554k AUSD and 506k USDC.
- LI.FI returned "No available quotes" for USDC to AUSD on Monad on 2026-10-13. Do not depend on LI.FI for this swap.

## Swap API (one-time deposit address)

1. `GET /api/tokens/{key}` returns `{ tokens: [{assetId, symbol, decimals, blockchain, price, contractAddress}], asset_stats }`. Cache it for 5 minutes or more.
2. `POST /api/quote/{key}` with these required fields: `dry`, `swapType`, `depositType`, `amount`, `originAsset`, `destinationAsset`, `slippageTolerance` (bps), `refundTo`, `refundType`, `recipient`, `recipientType`. `deadline` is optional (ISO).
   - `amount` is in base units, as an integer string.
   - `dry: true` returns no `depositAddress`.
   - Example: `{ "dry": false, "swapType": "EXACT_INPUT", "depositType": "ORIGIN_CHAIN", "originAsset": "nep141:arb.omft.near", "destinationAsset": "<Monad USDC id>", "amount": "10000000000000000", "slippageTolerance": 100, "refundTo": "0xUser", "refundType": "ORIGIN_CHAIN", "recipient": "0xUser", "recipientType": "DESTINATION_CHAIN" }`.
3. The user sends the origin asset to `quote.depositAddress`. A memo chain (Stellar) also needs `quote.depositMemo`.
4. Optional: `POST /api/deposit/submit/{key}` with `{ txHash, depositAddress, memo? }` makes the check faster.
5. Poll `GET /api/status/{key}?depositAddress=...&depositMemo=...` every 5 s to 10 s or slower.

Status values:

| Status | Meaning | Row status |
|---|---|---|
| `PENDING_DEPOSIT` | No deposit yet | awaiting_deposit (expired 30 min after the deadline) |
| `KNOWN_DEPOSIT_TX` | A deposit transaction is known, not confirmed | processing |
| `PROCESSING` | Deposit received, swap running | processing |
| `INCOMPLETE_DEPOSIT` | The deposit is below the quoted amount | incomplete (show the error) |
| `SUCCESS` | Delivered. `swapDetails.amountOut`, `destinationChainTxHashes` | settled |
| `REFUNDED` | Sent back to `refundTo`. `refundedAmount`, `refundReason` | refunded |
| `FAILED` | The swap failed | failed |

EXACT_INPUT refund rules: less than `amountIn` is refunded at the deadline. More than `amountIn` is swapped, and the excess goes to `refundTo`.

## Persistent deposit addresses (Intents Deposits)

- `POST /api/persistent-deposit-address/{key}` with `{ recipient, sender, depositChain, destinationChain, destinationAsset, confidential? }` returns `{ depositAddress, alreadyExists, memo? }`.
- The same inputs always return the same address. It never expires. All EVM chains share one address: use `depositChain: "evm"`.
- Only organisations that Aurora approved can create new addresses. Other keys get 403.
- `GET /api/persistent-deposit-status/{key}?address=...&type=received|success|failed` lists deposits and payouts.

## Intents Connect (deposit-and-execute)

- Monad is a supported destination. EVM source chains: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Avalanche, Gnosis, Bera, Scroll, XLayer, Plasma, ADI, Robinhood.
- `GET /executions/{wallet}/intermediary` returns `{ evm, solana }`. The intermediary is derived from the wallet. The wallet controls it.
- `POST /executions/{wallet}` (x-api-key) with `{ version: "1.0", type: "evm", quote: { originAsset, destinationAsset, amount, swapType, slippageTolerance, deadline }, steps, dry }`.
- A step is exactly `{ to, functionSignature, parameters, value, metadata? }`. The service encodes the call.
- The placeholder `{MIN_AMOUNT_OUT}` becomes the guaranteed delivered amount after the network fee.
- At least one step must call the destination token (the USDC approve does this). The service appends a fee transfer in USDC.
- Do not set `quote.recipient` on a bridge-in. Put the final receiver in a step parameter.
- The user signs `details.payload.payload_json` verbatim with `personal_sign`. Submit `secp256k1:` + base58(r||s||v0/1) to `POST /executions/{wallet}/submit` as `{ executionId, signature }`.
- One execution at a time per wallet (409 otherwise).
- States: CREATED, DEPOSIT_PENDING, DEPOSIT_PROCESSING, OPERATION_PENDING, OPERATION_PROCESSING, SUCCESS. Failures: DEPOSIT_FAILED (refunded), OPERATION_FAILED (funds stay in the intermediary), EXPIRED.
- On 2026-10-13 a dry `/steps` call on Monad with the Curve steps returned a network fee of 2037 (0.002 USDC).

Steps that this product uses (receiver = the user's Monad address):

```json
[
  { "to": "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", "value": "0", "functionSignature": "approve(address,uint256)", "parameters": ["0x942644106b073e30d72c2c5d7529d5c296ea91ab", "{MIN_AMOUNT_OUT}"] },
  { "to": "0x942644106b073e30d72c2c5d7529d5c296ea91ab", "value": "0", "functionSignature": "exchange(int128,int128,uint256,uint256,address)", "parameters": ["1", "0", "{MIN_AMOUNT_OUT}", "<min AUSD>", "0xUser"] }
]
```

## Fees and limits

- The fee is split 60 % integrator and 40 % Aurora. Aurora's minimum share is 2 bps for stables and 10 bps for other assets. The maximum fee is 500 bps.
- Rate limit: 100 requests per 10 s and 2000 per hour, per key and per endpoint. A 429 has `Retry-After` in seconds. Rejected requests count toward the hourly limit.

## Rules for the agent

- Never send funds to test. Use `dry: true` quotes.
- Tell the user the refund address before they send. Refunds go to `refundTo` on the origin chain.
- After a USDC settlement, the user must sign USDC to AUSD. After an Intents Connect settlement, AUSD is already in the wallet.
