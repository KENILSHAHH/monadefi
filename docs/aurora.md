# Aurora Intents deposits

This document describes how a user funds Perpl on Monad from any chain with Aurora Intents.
Code:

- `packages/core/src/adapters/aurora.ts` is the API client.
- `packages/core/src/auroraDeposits.ts` holds the rows, the poller and the next step.
- `packages/core/src/schema/20-aurora.sql` creates the table.

Agent facts are in `skills/aurora-intents/SKILL.md`.

## Decision

Intents Connect can deliver AUSD to the user's Monad address with no signature after the deposit. We use it for EVM source chains.

Evidence (checked on 2026-10-13):

1. Monad is a supported Intents Connect destination (https://docs.intents.aurora.dev/intents-connect/supported-chains.md).
2. Steps are free contract calls from the intermediary. `{MIN_AMOUNT_OUT}` is the delivered USDC after the fee. Aurora's Polymarket example uses the same method: approve USDC, then a swap that pays the user's account.
3. A Curve pool on Monad holds AUSD, USDC and USDT0, with about $2.3M of liquidity. Its `exchange(int128,int128,uint256,uint256,address)` has a `receiver` parameter. The pool is `0x942644106b073e30d72c2c5d7529d5c296ea91ab`.
4. A live dry `/steps` call on Monad accepted the two Curve steps. It returned a network fee of 0.002 USDC.

Limits of this path:

- The user signs one message before the deposit. Only one execution can be open per wallet.
- The deposit address is for one deposit only. It is not a persistent address.
- Perpl finds the account from `msg.sender`. The intermediary cannot deposit into Perpl for the user. The server funds Perpl after settlement, with the user's delegation.

Other sources (Solana, Bitcoin, NEAR, Tron, TON and others) use the Swap API. The same applies when Intents Connect fails. USDC arrives at the user's address, and the row gets `needs_conversion`. A persistent address is used when the key has Aurora's approval.

## Flow

```
EVM source (connect)                                     Other source (swap / persistent)
--------------------                                     --------------------------------
App: POST /aurora/deposits {originAsset, amount}         App: POST /aurora/deposits {originAsset, amount, refundTo}
Server: Connect dry -> Curve get_dy -> Connect create    Server: POST /api/quote (dry:false)
Row: awaiting_signature (+ signPayload)                  Row: awaiting_deposit (+ depositAddress)
App: personal_sign(payload_json) -> POST .../signature        |
Row: awaiting_deposit (+ depositAddress)                      |
User sends the asset to depositAddress  <-------------------- same
Aurora / NEAR Intents: asset -> USDC on Monad
  connect: intermediary approves Curve, exchange -> AUSD to user     swap: USDC to user
Poller: SUCCESS -> settled                                           Poller: SUCCESS -> settled
next_step = { kind: "fund_perpl", ausd }                             next_step = { kind: "needs_conversion", usdc }
Server: approve AUSD + Perpl deposit/open (delegation)               App: signs USDC -> AUSD (relay), then fund Perpl
```

## Row states

| Status | When | Terminal |
|---|---|---|
| awaiting_signature | connect row before the user signs | no |
| awaiting_deposit | waiting for funds (`PENDING_DEPOSIT`, `CREATED` signed, `DEPOSIT_PENDING`) | no |
| processing | `KNOWN_DEPOSIT_TX`, `PROCESSING`, `DEPOSIT_PROCESSING`, `OPERATION_*` | no |
| incomplete | `INCOMPLETE_DEPOSIT`. The error tells the user to send the rest, or wait for the refund | no |
| listening | a persistent address row. Each payout becomes a `persistent_child` row | no |
| settled | `SUCCESS` | yes |
| refunded | `REFUNDED`, or Connect `DEPOSIT_FAILED` | yes |
| failed | `FAILED`, or Connect `OPERATION_FAILED` | yes |
| expired | no deposit 30 minutes after the deadline, or Connect `EXPIRED` | yes |

The poller (`pollAuroraDeposits`) claims due rows with `FOR UPDATE SKIP LOCKED` and a 2-minute lease. Two workers never poll the same row at once. Poll intervals:

- awaiting rows: 20 s
- processing rows: 8 s
- incomplete rows: 30 s
- listening rows: 60 s

A 429 stops the pass. The claimed rows then wait for `Retry-After`. A network error keeps the status, writes a visible "retrying" error and waits 60 s.

## Refunds

- Swap API: refunds go to `refundTo` on the origin chain (`refundType: ORIGIN_CHAIN`). The row stores these values:
  - `refund_tx`: the origin-chain hash that is not the deposit hash
  - `refund_amount`
  - `refund_reason`
- EXACT_INPUT: Aurora refunds a deposit below the quote at the deadline. Aurora swaps a deposit above the quote and refunds the excess.
- Intents Connect `DEPOSIT_FAILED` and `EXPIRED`: Aurora refunds the deposit. The docs do not name the refund address for a bridge-in. See "Unverified".
- Intents Connect `OPERATION_FAILED`: the USDC stays in the user's intermediary on Monad. The user must sign a recovery. The recovery is a `/steps` execution that sends the USDC to the wallet.

Example of a refunded row:

```json
{ "status": "refunded", "auroraStatus": "REFUNDED", "refundTx": "0x9f...", "refundAmount": "25", "refundReason": "Deadline passed",
  "error": "Aurora refunded the deposit to 0xUser: Deadline passed" }
```

## Fees

- Aurora sets the integrator fee per API key in the portal. The quote request has no fee field.
- The fee is split 60 % integrator and 40 % Aurora. Aurora's minimum share is 2 bps for stables and 10 bps for other assets. The maximum fee is 500 bps.
- Intents Connect also charges a network fee in USDC on Monad. It was 0.002 USDC on 2026-10-13. The fee comes out of the delivered amount.
- Curve takes 0.005 %. The AUSD minimum is `get_dy(min USDC) * (1 - 0.5 %)`.

## Unverified

- Intents Connect bridge-in refunds: the create request has no `refundTo` field. We expect the refund to go to the signing wallet on the origin chain. This is not confirmed.
- The Connect execution response has no documented field for the destination transaction hash. The code searches `details` and `transactions` for a field that holds a transaction hash.
- Persistent address payloads: we assume the `amount` of a `success` item is the delivered USDC in base units.
- The Swap API `REFUNDED` response: we assume that `originChainTxHashes` holds the refund transaction.
- No real deposit was sent. We have no AURORA_API_KEY, so the Aurora quote and Connect create calls were tested only with stubs.
