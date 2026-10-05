---
name: bridging
description: Moving funds INTO Monad. Aurora Intents (any chain, arrives as AUSD or USDC), Relay (Ethereum, Arbitrum, Base, Polygon to Monad), and the USDC to AUSD step on Curve. Use when funds must reach Monad, or when a route, quote, fee or ETA is needed.
---

# Moving funds into Monad

Mona-DeFi acts only on Monad. Other chains are sources of funds.

## Aurora Intents (the Deposit screen of the app, any chain)

- 36 source chains, Bitcoin and Solana included. Load the aurora-intents skill for the details.
- EVM sources: Intents Connect delivers AUSD to the wallet (Curve swap on Monad in the same flow). After settlement, the server funds Perpl.
- Other sources: USDC arrives on Monad. The app then swaps it to AUSD on Curve through a gasless relay.

## Relay (agent tool `bridge`, Ethereum, Arbitrum, Base or Polygon to Monad)

- Base URL: `https://api.relay.link`. Docs: https://docs.relay.link/llms.txt (also the relay_docs search tool).
- Relay chain ids (GET /chains, checked on 2026-10-13): Monad 143, Ethereum 1, Arbitrum 42161, Base 8453, Polygon 137.
- Quote: `POST /quote` with `{user, recipient, originChainId, destinationChainId, originCurrency, destinationCurrency, amount, tradeType:"EXACT_INPUT"}`. Status: `GET /intents/status/v3?requestId=`.
- A passkey (Mera) wallet cannot bridge from the server: the server has no key on other chains. Point the user to the Deposit screen.

## USDC to AUSD on Monad

- Perpl takes only AUSD. LI.FI has no USDC to AUSD route on Monad (checked on 2026-10-13).
- Use the Curve stableswap pool `0x942644106b073e30d72c2c5d7529d5c296ea91ab` (coins: 0 AUSD, 1 USDC, 2 USDT0): `exchange(1, 0, dx, minDy, receiver)`. 25 USDC gave 25.003 AUSD on a fork test.

## Rule

Verify arrival on Monad before the next step runs.
