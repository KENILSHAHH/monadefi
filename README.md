# Mona-DeFi

**A trading agent for Monad. Sign in with a passkey, hold AUSD, trade perps on Perpl. Nansen checks every trade first.**

Mona-DeFi is a mobile app with one AI agent. You sign in with a passkey (Mera), so you need no seed phrase and no extension. Your money stays in AUSD on Monad. You trade perps on Perpl, the fully on-chain order book on Monad, from a ticket or by chat:

> *"Open a 5x long on BTC with 20 USD, stop-loss at 80,000."*
> *"What does Nansen say about longing ETH right now?"*
> *"Close half of my SOL position."*

Before every order, Nansen data decides in code if the trade goes ahead, at what leverage, with what size and with what stop-loss. After the trade, a position manager watches the position.

Live API: `https://api.3-83-183-92.sslip.io` · Web: `https://app.3-83-183-92.sslip.io` · Monad mainnet (chain 143).

---

## Parts

| Part | Where | What it does |
|---|---|---|
| Mobile app (Expo, iOS and Android) | `apps/mobile` | Passkey sign-in with Mera, AUSD balance, markets, Nansen risk card, Perpl trades, any-chain deposits, agent chat, activity. |
| Mera accounts and sessions | `packages/core/src/session.ts`, `relay.ts` | The passkey wallet becomes an EIP-7702 smart account. A scoped session lets the agent trade on Perpl and approve AUSD to Perpl only. It cannot withdraw or transfer. Gasless relays run only the exact calls that the phone signed. |
| Perpl | `packages/perpl` | Markets, accounts, positions, order math, transaction builders. Shared by the server, the plugin and the app. |
| Nansen risk engine | `packages/risk` | Segments smart money, whales, exchanges, fresh wallets, top holders and the trader. It blocks, lowers leverage and size, and requires stops. It also re-checks open positions. |
| Position manager | `packages/core/src/guards.ts`, `apps/guard` | Every new position gets a guard: it deleverages near liquidation and acts on Nansen exits. Stop-loss and take-profit jobs watch the Perpl mark price. |
| Aurora Intents deposits | `packages/core/src/adapters/aurora.ts`, `auroraDeposits.ts`, `auroraWorker.ts` | Deposits from 36 chains. EVM sources arrive as AUSD (Intents Connect plus Curve). Other sources arrive as USDC, then a gasless Curve swap. After settlement, the server funds Perpl. |
| MetaMask Agent Wallet plugin | `packages/mm-plugin-monadefi` | `mm monadefi …`: markets, positions, risk, open-perpl, close-perpl, protect, rebalance, fund. Every transaction goes through Agent Wallet signing, policy and MFA. |
| Agent | `packages/core/src/agent` | OpenAI Responses API with typed tools, product skills (`skills/`), a sandboxed terminal and hosted docs search (Perpl, Monad, Relay, LI.FI, Nansen). |
| API | `apps/api` | Routes for the mobile app (`docs/api-mobile.md`) and the web app. |
| Web app | `apps/web` | A browser version of the chat and positions (Privy sign-in). |

```text
 Mobile app (Mera passkey) ─┐
                            ├─►  API (Hono)  ──►  Agent (OpenAI)  ──►  tools ──► Perpl, LI.FI, Relay on Monad
 Web app (Privy)  ──────────┘     sessions, relay       Nansen risk gate         executors (session or sponsor)
                                  Aurora worker         guard watcher            Postgres on AWS RDS
```

## Safety model

- **No custody on mobile.** The passkey key stays on the phone. The server acts only inside the signed session: Perpl orders, margin and deposits, and AUSD approvals to Perpl. The DelegationManager enforces it on-chain, and tests prove that a withdrawal, a transfer, another spender or another redeemer reverts.
- **Stateless test.** The passkey always derives the same wallet. The stored session is untrusted storage: the chain checks it, and the phone signs it again when it is lost.
- **Revoke.** The app deletes the session on the server and sends `disableDelegation` on-chain through the relay.
- **Risk in code.** The Nansen verdict is applied before an order exists. The agent cannot skip it.
- **Isolated terminal.** The agent terminal runs in an OS sandbox. It has an allowlist of network hosts, no server secrets and no other users' files.

## Run it locally

Requirements: Node 22+, pnpm, Postgres, Foundry (for the agent terminal).

```bash
pnpm install
createdb mona_dfi
pnpm db:migrate
pnpm dev:api        # http://localhost:8787
pnpm dev:web        # http://localhost:3000
cd apps/mobile && npm install && npx expo run:ios   # a development build; passkeys need a real device
```

Tests use `TEST_DATABASE_URL` or the local `mona_dfi` database, never production.

Main settings in `.env`:

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_GUARD_MODEL`, `OPENAI_EFFORT` | The agent model |
| `NANSEN_API_KEY` | The Nansen risk engine |
| `AURORA_API_KEY` | Aurora Intents deposits |
| `SPONSOR_PRIVATE_KEY` | The gas sponsor on Monad (fund it with MON) |
| `KEY_ENCRYPTION_SECRET` | Signs session tokens and encrypts server keys |
| `DATABASE_URL` | Postgres (AWS RDS in production) |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_SIGNER_ID`, `PRIVY_AUTHORIZATION_KEY` | Web sign-in and server signing for web wallets |
| `RPC_MONAD` | Monad RPC (default `https://rpc.monad.xyz`) |

## Deployment

One EC2 instance in `us-east-1` runs the API, the guard watcher, the web app and Caddy (HTTPS). Postgres is on RDS. The steps are in the project notes; deploy with `rsync` (no `node_modules`, no `.env`) and restart the `mona-api`, `mona-guard` and `mona-web` services.

> Mona-DeFi runs on mainnet with real money. The session and relay design is tested on mainnet state and on forks, but it has no third-party audit.
