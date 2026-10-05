# Mobile API contract

The mobile app talks to the API server (`apps/api`). JSON over HTTPS. All amounts are numbers in whole units unless a field name ends in `Wei` or `Raw`. Every route except `/auth/*` and `/health` needs `Authorization: Bearer <session token>`.

The user's wallet is the Mera EOA on Monad (chain 143). Its address is the user id. The server holds no key of it.

## Auth (Mera)

### `POST /auth/mera/challenge`
Body `{ "address": "0x…" }` → `{ "nonce": "…", "message": "Sign in to Mona-DeFi on Monad…" }`.

### `POST /auth/mera/verify`
Body `{ "address": "0x…", "nonce": "…", "signature": "0x…" }`. The app signs `message` with EIP-191 (`account.signMessage`) from the Mera signing session. No extra passkey prompt.
→ `{ "token": "…", "address": "0x…", "agentAddress": "0x…" }`. `agentAddress` is the per-user server key that the session delegation names. It holds no funds.

## Session (scoped, prompt-free trading)

### `GET /session`
→
```json
{
  "status": "none" | "needs_upgrade" | "needs_signature" | "active" | "expired",
  "address": "0x…", "agentAddress": "0x…",
  "upgraded": true,
  "implementation": "0x63c0…", "chainId": 143,
  "permissions": [{ "id": "perm_…", "kind": "perpl_trade" | "ausd_approve", "expiresAt": "ISO", "status": "pending" | "active" }],
  "scope": { "targets": ["0x34B6…"], "functions": ["execOrder(…)", "…"], "cannot": ["withdraw", "transfer"] }
}
```
`needs_upgrade`: the wallet is not a smart account on Monad yet. `needs_signature`: delegations wait for a signature.

### `POST /session/upgrade`
The app signs an EIP-7702 authorization with `account.signAuthorization({ chainId: 143, contractAddress: implementation, nonce })`, where `nonce` is the current transaction count of the wallet. Body:
`{ "authorization": { "address": "0x…(implementation)", "chainId": 143, "nonce": 0, "r": "0x…", "s": "0x…", "yParity": 0 } }`
The gas sponsor sends it. → `{ "hash": "0x…", "explorer": "https://monadscan.com/tx/…" }`.

### `POST /session/start`
Body `{ "days": 30 }` (1 to 90). → `{ "permissions": [{ "id": "perm_…", "kind": "…", "typedData": { domain, types, primaryType, message } }] }`.
The app signs each `typedData` with `account.signTypedData` (EIP-712, no prompt) and sends each signature to `/session/grant`.

### `POST /session/grant`
Body `{ "id": "perm_…", "signature": "0x…" }` → the permission with `status: "active"`.

### `DELETE /session`
The server deletes the signatures. → `{ "revoked": true, "calls": RelayCall[] }`. The delegations stay valid on-chain until they end, so the app sends `calls` (one `DelegationManager.disableDelegation` per permission) through `/relay/prepare` + `/relay/send`.

## Relay (gasless calls that the user signs on the phone)

For actions outside the session, for example a withdrawal or a USDC → AUSD swap. The user's wallet makes the calls itself. The sponsor pays the gas.

### `POST /relay/prepare`
Body `{ "calls": [{ "to": "0x…", "data": "0x…", "value": "0", "description": "…" }] }` →
`{ "id": "rly_…", "typedData": { … }, "expiresAt": "ISO", "calls": [...] }`. The typed data is a one-time delegation to the sponsor. Its caveats pin the exact calls, allow one use, and end in 10 minutes.

### `POST /relay/send`
Body `{ "id": "rly_…", "signature": "0x…" }` → `{ "hash": "0x…", "explorer": "…", "status": "success" }`.

## Balances and positions

### `GET /balance`
```json
{
  "address": "0x…", "asOf": "ISO",
  "ausd": { "wallet": 120.5, "perplFree": 30, "perplLocked": 0, "inPositions": 52.1, "total": 202.6 },
  "usdc": 0, "mon": 0.4,
  "totalUsd": 202.9
}
```

### `GET /positions`
The full view (the same as the web app): `perpl` (account and positions), `balances`, `assets`, `guards`, `errors`.

### `GET /activity`
Recent intents, jobs and relays for one feed: `[{ "kind": "trade" | "job" | "relay", "title": "…", "status": "…", "at": "ISO", "explorer": "…" }]`.

## Markets

### `GET /perpl/markets` → `{ "markets": PerplMarket[] }` (see `@app/perpl`).
### `GET /perpl/markets/:symbol/book?levels=10` → the book.
### `GET /perpl/markets/:symbol/candles?res=3600&hours=24` → `{ "market": "ETH", "resolutionSec": 3600, "candles": [{ "t": ms, "o", "h", "l", "c", "volumeUsd", "trades" }] }`.

## Risk (Nansen)

### `POST /risk/check`
Body `{ "market": "ETH", "side": "long", "leverage": 5, "marginUsd": 20 }` → a `RiskVerdict` (see `@app/risk`). The app shows `decision`, `level`, `changes` and the segment `signals`.

## Trade

### `POST /trade/preview`
Body `{ "market": "ETH", "side": "long", "leverage": 5, "marginUsd": 20, "orderType": "market" | "limit", "limitPx"?: 2400, "stopLossPx"?: 2300, "takeProfitPx"?: 2700 }` →
`{ "intent": Intent, "risk": RiskVerdict, "requested": {…}, "applied": {…}, "changes": ["Leverage 5x → 3x: …"] }`.
The server applies the Nansen verdict in code before the intent exists. A `block` decision returns HTTP 409 with `{ "error": "…", "risk": RiskVerdict }`.

### `POST /intents/:id/confirm` → the executed intent (`status: "done" | "failed"`, `result` with fills and the receipt link). Needs an active session: a failed intent has `result.code: "session_inactive"` when trading is off or ended.
### `POST /intents/:id/reject`

### `POST /trade/close` body `{ "market": "ETH", "fraction": 1 }` → `{ "intent": Intent }`.

## Deposits (Aurora Intents)

Two paths, chosen by the server from the source chain:
- **connect** (EVM sources: Ethereum, Base, Arbitrum, BNB, …): Aurora Intents Connect runs a Curve USDC → AUSD swap on Monad and pays AUSD to the wallet. The phone signs one message first. After settlement the server moves the AUSD into Perpl (and opens the asked position) through the session.
- **swap** (Solana, Bitcoin, NEAR, …): the Swap API delivers USDC on Monad. The phone then signs the Curve swap through the relay (`/convert`, then `/relay/send`, then `/converted`).

### `GET /deposit/aurora/assets` → `{ "chains": [{ "chain": "base", "name": "Base", "evm": true, "connect": true, "tokens": [{ "assetId": "…", "symbol": "USDC", "decimals": 6, "icon"?: "…" }] }] }`
### `POST /deposit/aurora/quote` body `{ "assetId": "…", "amount": "25" }` → a dry Aurora quote (`quote.amountOutFormatted`, `quote.timeEstimate`, fees) for a preview.
### `POST /deposit/aurora` body `{ "assetId": "…", "amount"?: "25", "refundTo": "<the user's address on the source chain>", "after"?: { "type": "perpl_open", "market": "ETH", "side": "long", "leverage": 3, "usd"?: 20 } | { "type": "perpl_deposit" } }` → `{ "deposit": AuroraDeposit }`.
### `GET /deposit/aurora` → `{ "deposits": AuroraDeposit[] }`; `GET /deposit/aurora/:id` → `{ "deposit": AuroraDeposit }`.
### `POST /deposit/aurora/:id/signature` body `{ "signature": "0x…" }` — connect only: `personal_sign` (viem `signMessage({ message: signPayload.payload_json })`) of `signPayload.payload_json`, verbatim.
### `POST /deposit/aurora/:id/tx` body `{ "txHash": "…" }` — optional, when the app knows the source-chain transaction.
### `POST /deposit/aurora/:id/refresh` → polls Aurora now and returns the deposit.
### `POST /deposit/aurora/:id/convert` → a relay `{ id, typedData, calls, expiresAt }` (Curve approve + exchange to the same wallet). Sign `typedData`, send it to `/relay/send`, then call `POST /deposit/aurora/:id/converted`.

`AuroraDeposit` fields: `id, mode ("connect"|"swap"|"persistent"|"persistent_child"), originAsset, originChain, depositAddress, depositMemo, amountIn, amountOut, status, signPayload, depositTx, settledTx, refundTx, refundAmount, refundReason, nextStep ({kind:"fund_perpl", ausd} | {kind:"needs_conversion", usdc}), error, deadline, afterStatus, afterResult, steps: [{ label, done }]`.

`status`: `awaiting_signature` → `awaiting_deposit` → `processing` → `settled`, or `incomplete`, `refunded` (with `refundTx`, `refundAmount`, `refundReason`), `failed`, `expired`. `listening` is a persistent address.
`afterStatus` (after `settled`): `funded`, `opened`, `ready`, `needs_conversion`, `converted`, `needs_session` (turn on trading), `failed` (see `afterResult.error`).

## Agent chat

### `POST /chat` body `{ "prompt": "…", "sessionId"?: "conv_…" }` → `text/event-stream` of `AgentEvent` (see `packages/core/src/agent/run.ts`): `session`, `text`, `tool`, `tool_result`, `intent`, `done`, `error`.
### `POST /chat/message` body `{ "prompt": "…" }` → a message for the run that is active now.

## Errors
`{ "error": "plain sentence", "code"?: "…" }` with HTTP 4xx or 5xx. `401` means sign in again.
