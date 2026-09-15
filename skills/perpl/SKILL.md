---
name: perpl
description: Perpl perps on Monad. Fully on-chain order book, isolated margin, AUSD collateral, market ids, units, order types, fees, funding, liquidation, minimums, the Exchange ABI and the public API. Use for any Perpl question, order, position, stop-loss, take-profit, margin change, deposit or withdrawal.
---

# Perpl

Checked on 2026-10-13 against docs.perpl.xyz, github.com/PerplFoundation (api-docs, dex-sdk, delegated-account), the public API and the mainnet contract (version 1.7.5).

## Network and addresses (Monad mainnet, chain 143)

| Item | Value |
|---|---|
| Exchange (proxy, all markets) | `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` |
| Collateral: AUSD, 6 decimals (the only one) | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` |
| REST API | `https://app.perpl.xyz/api` |
| WebSocket | `wss://app.perpl.xyz` |
| App | https://app.perpl.xyz |
| Docs (also an MCP docs tool: perpl_docs) | https://docs.perpl.xyz |

The contract source is not verified on an explorer. The ABI comes from the official Rust SDK (dex-sdk, crates/sdk/abi/dex). The server has it in `packages/core/src/adapters/perplAbi.ts`. There is no official TypeScript SDK. The npm package `perpl` is not Perpl.

## Model

- One exchange account for each wallet. The contract finds the account from `msg.sender`. The first deposit (`createAccount(amountCNS)`) opens it.
- **Isolated margin only.** Each position has its own collateral (`depositCNS`). The free account balance does not protect a position.
- One position for each account in each market. An order on the other side reduces it, closes it, or turns it around.
- Matching: price-time priority, fully on-chain. Each fill settles in the transaction.
- Mark price: the median of 4 inputs, computed off-chain and pushed on-chain. Oracle: Chainlink Data Streams.

## Units

| Suffix | Meaning |
|---|---|
| CNS | AUSD units, 6 decimals. `10_000_000` = 10 AUSD |
| PNS | price x 10^priceDecimals of the market |
| ONS | book price. `PNS = ONS + basePricePNS` |
| LNS | size x 10^sizeDecimals. 1 LNS is the smallest order |
| Hdths | hundredths. `leverageHdths 500` = 5x |
| fees on-chain | parts per million. 345 = 3.45 bps |

## Markets (ids on mainnet = on-chain perpId)

Read live values with perpl_markets. On 2026-10-13: 1 BTC (15x), 10 MON (10x), 20 ETH (12x), 31 SOL (12x), 40 HYPE (10x), 50 ZEC (10x), 60 LIT (3x), 70 VVV (3x), 90 PUMP (5x), 100 NEAR (3x), 110 UNI (3x). Market 30 is the old SOL market: do not use it.

- Max leverage = `initial_margin / 100`. Maintenance margin fraction = `100 / maintenance_margin`.
- The contract does not revert on leverage above the maximum: it silently uses the maximum. The tools refuse it first.
- `leverageHdths = 0` means the maximum.
- The leverage of an order that adds to a position applies to the whole position. A lower leverage can pull a lot more collateral.

## Order types (on-chain `OrderDesc.orderType`; the API uses the value + 1)

| Value | Type |
|---|---|
| 0 | OpenLong |
| 1 | OpenShort |
| 2 | CloseLong (reduce-only sell) |
| 3 | CloseShort (reduce-only buy) |
| 4 | Cancel (needs orderId) |
| 5 | IncreasePositionCollateral (amountCNS) |
| 6 | Change (orderId, new price, size, expiry) |

- **No "price 0 = market" on-chain.** A market order is a limit order at the worst accepted price with `immediateOrCancel = true`. A price of 0 reverts with `PriceOutOfRange`.
- Flags: `postOnly`, `fillOrKill`, `immediateOrCancel`. Post-only cannot go with FOK or IOC. A post-only order that crosses reverts with `CrossesBook`.
- `expiryBlock`: last block on the book. 0 = until cancelled. A block is about 0.3 s to 0.4 s.
- `lastExecutionBlock`: the request fails after this block. The tools use head + 300.
- A close larger than the position reverts with `CloseOrderExceedsPosition`. For a full close, use the exact position size.
- A resting order needs some free AUSD in the account. Otherwise it reverts with `InsuficientFundsForRecycleFee`.
- Order ids are uint16 for each market, and the contract reuses them. The contract has no list of the orders of one account. The server keeps the ids it placed (perpl_open_orders).
- On a Change, always send an explicit size.

## Stop-loss and take-profit

- Perpl trigger orders (stop-loss, take-profit, linked to a position) exist **only through the Perpl API**. They need an Ed25519 API key from app.perpl.xyz/apikeys and `allowOrderForwarding(true)` on-chain. Then Perpl submits the orders and pays the gas. An API key cannot withdraw.
- This product does not hold such a key. So:
  - The stop-loss is a server job. It reads the Perpl mark price every few seconds and sends a reduce-only market close. It closes only a position on the same side.
  - The take-profit is a native resting reduce-only limit order (CloseLong above the bid, CloseShort below the ask), or a server job.
- If the user gives an API key, the agent can sign API requests in the terminal. Trigger fields: `tp` trigger price, `tpc` 1 GTE last, 2 LTE last, 3 GTE mark, 4 LTE mark, `lp` position id, `lb` 0. An account has at most 16 trigger orders.

## Margin

- Add: `increasePositionCollateral(perpId, amountCNS)`. It is instant and uses the free balance.
- Remove: `requestDecreasePositionCollateral(perpId, amountCNS, clampToMaximum)`. This is a request. A Perpl keeper applies it, or declines it with `CollateralDecreaseDeclined`. A request expires after 120 s. The keeper blocks it when open interest is above 85% of the cap.

## Funds

- Deposit: approve AUSD to the Exchange, then `createAccount(amount)` the first time (at least 10 AUSD on mainnet, `getMinAccountOpenCNS`) or `depositCollateral(amount)` (at least 10 AUSD).
- Withdraw: `withdrawCollateral(amount)`. Only the free balance (balance minus locked) can leave. The exchange has a global hourly limit (about 10% of TVL per hour, at least 1M USD).
- AUSD on Monad comes from a swap (LI.FI: swap on monad, toToken AUSD) or a bridge.

## Fees and funding

- Taker 3.45 bps, maker 0.45 bps below 5M USD of 14-day volume (tiers go down to taker 1.25 bps, maker -0.5 bps). Each fill that changes the size pays a fee, closes too. Liquidations pay no trading fee.
- Funding: every 8571 blocks (about 43 minutes live). A positive rate means longs pay shorts. The rate is in millionths of the index price for each interval. Funding is realized when the position changes or closes. Before that it is in `premiumPnlCNS`.

## Liquidation

- The trigger is `0 < FMV <= maintenance margin`, at the mark price. Keepers sell the position on the book. Of the margin that is left, 80% goes to the trader, 10% to insurance and 10% to the protocol. ADL starts when FMV <= 0.
- Liquidation price (isolated): `entry + s * (entry*size*mmFraction - deposit - premiumPnl) / size`, with s = +1 for a long and -1 for a short.

## Minimums

- Order: 1 LNS (for example 0.00001 BTC, 1 MON). Minimum order value: 0 now. Perpl can raise it. A full close is always allowed.

## Reads

- `getAccountByAddr(addr)` returns accountId, balanceCNS and lockedBalanceCNS. It reverts with `AccountDoesNotExist` for a new wallet.
- `getPositionV2(perpId, accountId)` returns the position, markPricePNS and markPriceValid.
- `getPerpetualInfoV2(perpId)` returns the decimals, mark, oracle, open interest, funding and basePricePNS.
- `getOrderV2(perpId, orderId)`, `getMarginFractions(perpId, lot)`, `getPerpFeeSchedule(perpId)`, `getWithdrawAllowanceData(block)`.
- Public REST: `/v1/pub/context`, `/v1/market-data/ticker`, `/v1/market-data/:id/book?levels=N`, `/v1/market-data/:id/candles/:res/:from-:to`, `/v1/market-data/:id/funding/:from-:to`. Prices are in PNS, sizes in LNS. 24h dollar volume is `dva / 1e6`.

## Gas

Monad charges the full gas limit, not the gas used. Estimated gas: open IOC about 303k, post-only about 236k, cancel about 207k, close about 308k, withdraw about 135k.
