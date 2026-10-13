# Mona-DeFi

**A trading agent for Monad. Sign in with a passkey, hold AUSD, trade perps on Perpl, by tapping, typing or speaking. Nansen checks every trade before it exists.**

| | |
|---|---|
| App (browser, passkeys) | https://app.3-83-183-92.sslip.io |
| API | https://api.3-83-183-92.sslip.io (`/health`) |
| Web app (Privy sign-in) | https://web.3-83-183-92.sslip.io |
| Chain | Monad mainnet, chain id 143 |
| Repo | https://github.com/KENILSHAHH/monadefi |

---

## What it does

You open the app and create an account with **one passkey prompt** (Face ID or a fingerprint). There is no seed phrase, no extension and no email code. The passkey gives you a normal wallet on Monad. Then you trade:

> *"Open a 5x long on BTC with 20 AUSD, stop-loss at 80,000."*
> *"What does Nansen say about longing ETH right now?"*
> *"Close half of my SOL position and move the money back to my wallet."*

Before any order exists, server code reads Nansen and decides:
- whether the trade goes ahead;
- at what leverage and with what size;
- with what stop-loss.

The trade card shows each change and the reason for it. After the fill, a position manager watches the position. It deleverages near liquidation, and it reduces or closes the position when Nansen turns against it.

Money comes in from **36 chains** through Aurora Intents, and it arrives as AUSD, the collateral of Perpl. You can also deposit from **MetaMask** with one signed transfer.

## Hackathon tracks (Monad Metropolis)

| Track | Sponsor | How Mona-DeFi meets it |
|---|---|---|
| Best Mobile Trading App | Agora | Mera passkey sign-in, AUSD balance in the app, trades through Perpl. Flow: passkey → AUSD → market → Nansen check → Perpl trade. |
| Best Mera-Powered UX | Monad Foundation | Mera is the whole account layer: one passkey ceremony, prompt-free signing through a scoped session, real Monad transactions, and the stateless test (the account and access come back from the passkey alone). |
| Best Use of Nansen | Nansen | Nansen is a risk engine in code. It segments smart money, whales, exchanges, fresh wallets, top holders, public figures and the trader. Its verdict changes whether the agent trades, the leverage, the size and the stop-loss, and it triggers exits. |
| Bring Any-Chain Liquidity to Monad | Aurora Intents | Live deposits with settlement and refund handling. EVM sources use Intents Connect (deposit-and-execute): Aurora swaps USDC to AUSD on Curve and pays the wallet. Other sources use the Swap API, then a gasless Curve swap. After settlement, the server funds Perpl. |
| Best Agent Wallet Plugin | MetaMask | `mm-plugin-monadefi`: `mm monadefi markets / positions / risk / open-perpl / close-perpl / protect / rebalance / fund`. Every transaction goes through Agent Wallet signing, policy and MFA. |
| Best Use of Perpl API | Perpl | A Perpl position manager: Nansen-based leverage, stop-loss and take-profit, collateral checks, automatic deleveraging and Nansen exits, with real on-chain orders. |

## Features

- **Passkey accounts (Mera).** One ceremony creates the wallet. It works in the native app and in Safari (iOS 18+) or Chrome, so no App Store is needed.
- **Automatic trading access.** Right after sign-in, the app sets up a scoped session in the background, with no tap and no prompt. Settings show its scope and a Revoke button.
- **Perpl perps.** Market and limit orders, long and short, post-only, expiry, stop-loss and take-profit, add or remove margin, deposit and withdraw. The agent can also read the order book, candles and funding.
- **Nansen risk gate.** It runs before each order, in code. The agent cannot skip it. It also re-checks open positions.
- **Position manager.** Every new position gets a guard. Stop-loss jobs watch the Perpl mark price. A take-profit can rest on the Perpl book.
- **Any-chain deposits (Aurora Intents)** with a progress view: address ready, deposit seen, arrived on Monad, changed to AUSD, ready to trade. Refunds are shown too.
- **MetaMask deposits.** The browser extension, or the MetaMask mobile app through a deep link. MetaMask signs one plain transfer to your own wallet or to the Aurora deposit address, and nothing else.
- **Voice (Deepgram).** Hold the mic and speak. Nova-3 turns the speech into text, and Aura-2 reads the replies aloud. A trade asked by voice always waits for a confirm tap.
- **The agent.** OpenAI (`gpt-5.6-sol`, medium effort) with typed DeFi tools, product skills, hosted docs search (Perpl, Monad, Relay, LI.FI, Nansen), a sandboxed terminal (Foundry is installed) and a memory of lessons.
- **Gasless.** A gas sponsor pays every fee on Monad. A user never needs MON.

## Architecture

```text
 Mobile app / Safari (Mera passkey) ─┐
 Web app (Privy) ────────────────────┤
 mm CLI plugin (MetaMask Agent Wallet)┘ (uses @app/perpl + @app/risk directly)
                │
                ▼
        API (Hono, apps/api) ─────────► Agent (OpenAI Responses API, packages/core/src/agent)
          sessions · relay · voice          typed tools ─► Perpl · LI.FI · Relay · Nansen
          Aurora worker · jobs              sandboxed terminal · skills · memory
                │
                ├─► Executors: Mera session chain or Privy signer ─► gas sponsor ─► Monad
                ├─► Guard watcher (apps/guard): liquidation distance + Nansen exits
                └─► Postgres (AWS RDS): users, sessions, intents, jobs, guards, deposits, chats, memory
```

### Repository layout

```text
apps/mobile                  Expo app (iOS, Android, web): Mera, trade ticket, Nansen card, deposits, MetaMask, voice, agent
apps/api                     Hono API: Mera auth, sessions, relay, balances, markets, trades, deposits, voice, chat (SSE)
apps/guard                   Guard watcher: Perpl liquidation distance and Nansen exits
apps/web                     Next.js web app (Privy sign-in)
packages/core                Agent, tools, executors, sessions, relay, sponsor, jobs, guards, Aurora, voice, schema
packages/perpl               Perpl SDK for TypeScript: markets, accounts, positions, order math, tx builders, ABI
packages/risk                Nansen risk engine: client, market map, assessTrade, applyVerdict, monitorPosition
packages/mm-plugin-monadefi  MetaMask Agent Wallet plugin (mm monadefi …)
skills/                      Product skills that the agent loads: perpl, monad, aurora-intents, bridging
docs/                        API contract for the app (api-mobile.md), Aurora flow (aurora.md)
```

## How the passkey account works

1. **Sign-in.** Mera reads the passkey's PRF output, which is 32 bytes, always the same for that passkey. The app derives the wallet from it with BIP-39 and BIP-32 (`m/44'/60'/0'/0/0`). The key exists only in the app's memory. The app then signs a server challenge, and the user id is the wallet address.
2. **Scoped session, in the background.** The app signs, with no prompt:
   - an **EIP-7702 authorization**, so the wallet becomes a MetaMask smart account at the same address (the gas sponsor sends it);
   - two **delegations** to a per-user agent key that holds no funds:
     - **Perpl Exchange:** orders, margin, deposits;
     - **AUSD approve:** only with the Perpl Exchange as the spender, enforced by `AllowedCalldataEnforcer`.
3. **Trading.** The sponsor redeems a delegation chain `[agent key → sponsor, wallet → agent key]` in one call. The wallet itself makes the Perpl call.
4. **What the server cannot do.** It cannot withdraw, transfer or call any other contract. The DelegationManager checks this on-chain. Tests show that a withdrawal, a transfer, another spender and another redeemer all revert.
5. **Gasless relays** for actions that the user signs on the phone: withdrawals, the USDC → AUSD swap, revoke. A one-time delegation to the sponsor pins the exact calls (`ExactExecution` or `ExactExecutionBatch`), allows one use and ends in 10 minutes.
6. **Stateless test.** Clear the storage or use a new device, and the passkey derives the same wallet. The stored session is untrusted: the chain checks it, and the app signs it again when it is lost.
7. **Revoke.** The server deletes the signatures, and the app sends `disableDelegation` on-chain through the relay.

## Nansen risk engine (`packages/risk`)

- **Inputs** (about 7 credits for each check):
  - `/tgm/position-intelligence`: perp positioning of smart money, whales and public figures;
  - `/smart-money/perp-trades`;
  - `/tgm/flow-intelligence`: exchanges, fresh wallets, top traders, whales and public figures in one call;
  - `/tgm/holders`: concentration;
  - `/profiler/address/pnl-summary`: the trader's record.
- **Policy** (deterministic, no model):

| Score | Decision | Leverage | Margin | Stop-loss |
|---|---|---|---|---|
| ≤ −60 | block | — | — | — |
| −60 to −25 | reduce | ≤ max/3 | × 0.5 | required, tight |
| −25 to +25 | allow | ≤ market max | × 1 | required above 5x |
| ≥ +25 | allow | as asked | × 1 | optional |
| no data | reduce | ≤ 3x | × 1 | required |

- **Monitor:** every few minutes, the guard asks `monitorPosition`. The answer is exit, reduce, tighten the stop, or hold.

## Aurora Intents deposits

- **EVM sources** (Ethereum, Base, Arbitrum, BNB and more): **Intents Connect.** The user signs once. Aurora delivers USDC to an intermediary account on Monad, which runs `approve` and then the Curve `exchange(USDC → AUSD, receiver = user)`. AUSD arrives in the wallet with no further signature.
- **Other sources** (Solana, Bitcoin, NEAR and more): **Swap API.** USDC arrives on Monad. The app then signs the Curve swap through the gasless relay.
- **After settlement,** the server moves the AUSD into Perpl through the session. If the user asked for a trade, the server opens it after the Nansen check.
- **States:** `awaiting_signature`, `awaiting_deposit`, `processing`, `settled`, `incomplete`, `refunded` (with the refund transaction), `failed` and `expired`.

## Run it locally

Requirements: Node 22+, pnpm 10, Postgres 17, Foundry (for the agent terminal).

```bash
pnpm install
createdb mona_dfi
cp .env.example .env        # then fill in the keys below
pnpm db:migrate
pnpm dev:api                # http://localhost:8787
pnpm dev:web                # http://localhost:3000 (Privy web app)
pnpm --filter @app/guard dev  # guard watcher

cd apps/mobile && npm install
npx expo start --web        # the app in a browser (passkeys need https or localhost)
npx expo run:android        # a development build on a phone; passkeys need a real device
```

### Environment

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_EFFORT`, `OPENAI_GUARD_MODEL` | The agent and the small guard model |
| `NANSEN_API_KEY`, `NANSEN_MAX_CREDITS` | The Nansen risk engine |
| `AURORA_API_KEY` | Aurora Intents deposits (studio.aurora.dev) |
| `DEEPGRAM_API_KEY`, `DEEPGRAM_STT_MODEL`, `DEEPGRAM_TTS_MODEL` | Voice |
| `SPONSOR_PRIVATE_KEY` | The gas sponsor on Monad (fund it with MON) |
| `KEY_ENCRYPTION_SECRET` | Signs session tokens and encrypts server keys (`openssl rand -hex 32`) |
| `DATABASE_URL` | Postgres |
| `RPC_MONAD` | Monad RPC (default `https://rpc.monad.xyz`) |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_SIGNER_ID`, `PRIVY_AUTHORIZATION_KEY` | The web app (Privy) |
| `PUBLIC_APP_URL` | The web app URL |
| App: `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_RP_ID`, `EXPO_PUBLIC_MONAD_RPC` | The app's API and its passkey domain. Accounts are tied to the RP id for good. |

## Tests

```bash
pnpm -r typecheck
pnpm --filter @app/core test          # sessions, relay, Perpl math, guards, Aurora (uses TEST_DATABASE_URL or the local DB)
pnpm --filter @app/risk test          # the Nansen policy, the client, the monitor
cd packages/mm-plugin-monadefi && npx vitest run
cd apps/mobile && npm test            # derivation, auth and session machines, MetaMask, voice, Markdown
```

Tests never use the production database.

The session, the relay and the revoke are also proven against live Monad state and on Anvil forks of Monad mainnet:
- a Perpl order through the session reaches Perpl as the user's wallet;
- withdrawal, transfer, a foreign spender and a foreign redeemer revert;
- a changed relay call reverts;
- after a revoke, the session cannot be used.

## API

The routes of the app are in [`docs/api-mobile.md`](docs/api-mobile.md): auth, session, relay, balance, activity, markets, risk, trade, deposits, voice and chat.

## Deployment

- **Server:** one EC2 instance (`t4g.medium`, us-east-1). It runs the API, the guard watcher and the web app as systemd services. Caddy serves HTTPS, the browser build of the app, and the passkey association files (`/.well-known/apple-app-site-association`, `assetlinks.json`).
- **Database:** Postgres on RDS.
- **Agent terminal:** it runs in an OS sandbox (bubblewrap with seccomp), with a network allowlist.

## Safety

- Mona-DeFi runs on mainnet with real money.
- The session, the relay and the risk design are tested on mainnet state and on forks, but they have no third-party audit.
- A guard or a stop-loss reduces risk. It cannot guarantee a result when the price gaps, an oracle lags or the network is congested.
- Perps with leverage can lose all of the margin.
