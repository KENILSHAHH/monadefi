# Mona-DeFi (mm-plugin-monadefi)

Mona-DeFi is a MetaMask Agent Wallet plugin. It adds `mm monadefi` commands for Nansen-aware trading of Perpl perpetuals on Monad (chain 143).

- Perpl: a fully on-chain perpetuals order book on Monad. AUSD is the collateral.
- Nansen: smart-money, whale, exchange and fresh-wallet flows. The plugin checks them before each trade and while a position is open.
- Aurora Intents and Curve: move USDC from another chain to Monad, then swap it to AUSD on the Curve AUSD/USDC pool.

Every transaction goes through the Agent Wallet executor (`ctx.walletExecutor`). The executor applies the wallet policy, simulation, Blockaid scanning and MFA. The plugin has no private key, no token and no other signing path.

## Requirements

- MetaMask Agent Wallet CLI `mm` 6.2.0 or later (tested with 7.2.0).
- Node.js 22 or later.
- A signed-in Agent Wallet (`mm login`, `mm init`) for the commands that write.
- Optional: a Nansen API key (smart-money checks). An Aurora Intents API key (`monadefi fund` from another chain).

## Install

Build and pack in the monorepo:

```bash
cd packages/mm-plugin-monadefi
pnpm install --ignore-workspace
pnpm build          # tsup bundle + oclif manifest
pnpm test           # vitest unit tests
npm pack            # writes mm-plugin-monadefi-0.1.0.tgz
```

The bundle includes `@app/perpl`, `@app/risk`, viem and zod. The tarball has no runtime dependencies and no monorepo links. Only `@metamask/agent-wallet` stays external: the host links its own copy, so `PluginCommand` is the same class.

Install the tarball into `mm`:

```bash
mm config set experimentalPlugins true
mm config set experimentalAllowUnverifiedInstalls true    # local file: installs only
mm plugins install "file:$PWD/mm-plugin-monadefi-0.1.0.tgz" --accept-permissions
mm plugins inspect mm-plugin-monadefi
mm monadefi markets
```

Use the tarball, not the folder. A folder install (`file:$PWD`) makes a symlink to this folder. The plugin then loads the dev copy of `@metamask/agent-wallet` from `node_modules`, and the command fails with `window.addEventListener is not a function`. To use a folder install, remove `node_modules/@metamask/agent-wallet` after the build.

Remove it with `mm plugins uninstall mm-plugin-monadefi`.

## Settings

Keys come from the environment first, then from the plugin's own file `~/.config/mm-plugin-monadefi/config.json` (mode 0600). The plugin never prints a key.

```bash
printf %s "$NANSEN_KEY" | mm monadefi config set nansen-key     # or NANSEN_API_KEY
printf %s "$AURORA_KEY" | mm monadefi config set aurora-key     # or AURORA_API_KEY
mm monadefi config set slippage-bps 75                          # default 50 = 0.5%
mm monadefi config get
mm monadefi config set nansen-key --unset
```

## Commands

All commands take `--json`. JSON goes to stdout. The human summary goes to stderr in headless mode.

### `mm monadefi markets`

Perpl markets with mark price, max leverage, funding per interval, funding APR, 24h change, 24h volume and open interest.

```bash
mm monadefi markets
mm monadefi markets --market ETH --json
```

### `mm monadefi positions`

The Perpl account (AUSD balance, locked, free), AUSD in the wallet, and each position with leverage, margin, PnL, liquidation price and distance to liquidation. `--address` gives a read-only view of any address, with no login.

```bash
mm monadefi positions
mm monadefi positions --address 0x5D8FfA5F7c6A42470B4eC61a8CdAbB799fd3765A --json
```

### `mm monadefi risk`

The Nansen verdict for a planned trade: score (-100 to +100), level, decision, signals by segment, and the changes `open-perpl` would make.

```bash
mm monadefi risk --market ETH --side long --leverage 5 --margin 20
mm monadefi risk --market BTC --side short --leverage 3 --margin 50 --stop 86000 --json
```

### `mm monadefi open-perpl`

1. Refuses leverage above the market maximum.
2. Runs the Nansen check and applies the verdict (see "Risk policy").
3. Sizes the order on live data (`previewOpen`). Checks the stop and the take-profit against entry and liquidation.
4. Builds an AUSD approval and `createAccount` or `depositCollateral` when the Perpl account lacks free AUSD, then the order.
5. Sends each transaction through the Agent Wallet executor on chain 143. Each step waits for its receipt.
6. Reads the fills from the order receipt (`TakerOrderFilledV2`, `ImmediateOrCancelExecuted`, `OrderPlaced`).
7. With `--tp`, places a resting post-only reduce-only close for the filled size.
8. With `--stop` (or a stop that Nansen requires), prints the `mm monadefi protect` command that keeps it.

```bash
mm monadefi open-perpl --market ETH --side long --leverage 2 --margin 20 --dry-run
mm monadefi open-perpl --market ETH --side long --leverage 2 --margin 20 --stop 2300 --tp 2700
mm monadefi open-perpl --market BTC --side short --leverage 3 --margin 25 --limit 86000 --post-only
mm monadefi open-perpl --market ETH --side long --leverage 8 --margin 20 --ignore-risk --yes   # overrides a Nansen block
```

### `mm monadefi close-perpl`

A reduce-only IOC close at mark +/- slippage. A full close uses the exact position size.

```bash
mm monadefi close-perpl --market ETH
mm monadefi close-perpl --market ETH --fraction 0.5 --slippage-bps 100
```

### `mm monadefi protect`

A foreground watcher. It reads the Perpl mark price every `--interval` seconds (default 5) and runs the Nansen position check every `--nansen-every` minutes (default 5). It closes the position through the executor when:

- the mark crosses `--stop`;
- the mark crosses the trailing stop (`--trailing 3%` from the best mark seen; it only moves toward the price);
- the mark reaches `--tp`;
- Nansen says `exit`.

Nansen `tighten_stop` moves the stop closer (never further). Nansen `reduce` prints a suggested partial close. Each check is one line (NDJSON with `--json`). Ctrl-C stops the watcher. The position has no stop while the watcher is off.

```bash
mm monadefi protect --market ETH --stop 2300
mm monadefi protect --market ETH --stop 2300 --trailing 3% --tp 2700
mm monadefi protect --market ETH --trailing 2% --watch-only --max-checks 20 --json
```

### `mm monadefi rebalance`

For each open position: the target leverage is the lowest of the profile (conservative 2x, balanced 3x, aggressive 5x), the market maximum and the Nansen cap. A position above the target gets more margin (`increasePositionCollateral`, after an AUSD deposit when needed). When AUSD is short, the command first closes a part of the position, then adds the freed margin. A Nansen block on the side closes the position. A position below the target is left as is. Dry run by default.

```bash
mm monadefi rebalance --risk conservative
mm monadefi rebalance --risk balanced --execute
```

### `mm monadefi fund`

Any-chain funding to AUSD on Monad:

1. Aurora Intents quote (`POST /api/quote/{apiKey}`): origin asset to USDC on Monad (`nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx`). The recipient is the Agent Wallet address. Refunds go to the same address on the origin chain.
2. The origin transfer to `quote.depositAddress`, through the executor on the origin chain.
3. `POST /api/deposit/submit/{apiKey}`, then `GET /api/status/{apiKey}` until `SUCCESS`, `REFUNDED` or `FAILED`. A refund prints its amount and reason.
4. Curve quote on Monad (USDC to AUSD, pool 0x9426…91ab). The approval and the swap go through the executor.
5. With `--deposit-perpl`, the AUSD goes into the Perpl account (at least 10 AUSD).

```bash
mm monadefi fund --from base --amount 50 --asset USDC --dry-run
mm monadefi fund --from base --amount 50 --asset USDC --deposit-perpl
mm monadefi fund --from base --amount 50 --resume <depositAddress>     # continue after an MFA pause
mm monadefi fund --from monad --amount 25 --deposit-perpl              # USDC already on Monad
```

Origin chains: base, arbitrum, ethereum, optimism, polygon, bsc, avalanche (Aurora chain codes base, arb, eth, op, pol, bsc, avax).

## Risk policy

The Nansen engine is `@app/risk` (shared with the server and the app). `open-perpl` applies its verdict with the engine's `applyVerdict`.

| Nansen result | What the plugin does |
|---|---|
| score <= -60: `block` | Refuses the trade. `--ignore-risk --yes` overrides it (the user must ask for it) |
| score <= -25: `reduce` | Leverage cap about one third of the market maximum, margin x0.5, a 25% margin buffer, a required tight stop |
| score < 25: `allow` | As asked. Above 5x: a required stop and a 10% margin buffer |
| score >= 25: `allow` | As asked |
| no key or no data | Leverage cap 3x and a required stop at most 3% from entry |

Plugin rules that apply in every case:

- Leverage above the market maximum is refused (the contract would clamp it in silence).
- Leverage never goes below 1x.
- A long stop must be below entry and above the estimated liquidation price (the reverse for a short).
- A take-profit must be on the profit side of entry and of the book.
- A close never exceeds the position.
- The margin buffer keeps the position size and adds collateral, so the AUSD used can be up to 10% above `--margin`.

## Security model

- Every transaction is a `{ kind: "transaction", chainId, transaction: { to, data, value }, intent }` request to `ctx.walletExecutor(io, "<command-id>")`. The executor runs the Agent Wallet policy, simulation, Blockaid and MFA. A job can wait in `AWAITING_MFA`. The plugin waits for the receipt of each step, because the next step depends on it.
- A step that ends without a hash stops the flow. The result has `status: "pending"` and the `pollingId`. Approve it, then run `mm wallet requests watch <pollingId>`. A failed step stops the flow and lists the steps that did complete.
- The plugin never reads the session, the CLI token or the Secret Recovery Phrase. The host does not expose them.
- Capabilities per command (consent screen at install): `markets` and `config` need none. `positions` and `risk` need `wallet-read`. The write commands need `wallet-read` and `wallet-submit`.
- Reads use `ctx.publicClient(chainId)`. Without a login, read-only commands use the public Monad RPC (`https://rpc.monad.xyz`). Writes never use that path.
- Nansen and Aurora keys stay in the environment or in a 0600 file. They are not printed, and errors that echo a key are redacted.

## Five-minute demo script

Set up (before the demo): a signed-in Agent Wallet with about 60 USDC on Base and a little ETH on Base and MON on Monad for gas. Nansen and Aurora keys set.

| Time | Step | Command | What to show |
|---|---|---|---|
| 0:00 | Install | `mm plugins install "file:$PWD/mm-plugin-monadefi-0.1.0.tgz" --accept-permissions` | The consent screen: commands, capabilities, Monad chain 143 |
| 0:30 | Markets | `mm monadefi markets` | Perpl markets, max leverage, funding, volume |
| 1:00 | Fund | `mm monadefi fund --from base --amount 50 --asset USDC --deposit-perpl` | Aurora quote, the Base transfer through MetaMask policy and MFA, bridge status, Curve swap, Perpl deposit |
| 2:15 | Risk | `mm monadefi risk --market ETH --side long --leverage 8 --margin 20` | Nansen segments and the changes: lower leverage, margin buffer, required stop |
| 2:45 | Refusal | `mm monadefi open-perpl --market ETH --side long --leverage 20 --margin 20` | The plugin refuses leverage above 12x |
| 3:00 | Open | `mm monadefi open-perpl --market ETH --side long --leverage 3 --margin 20 --tp <mark+5%>` | Plan, MetaMask approval, fill price and fee from the receipt, the resting take-profit |
| 3:45 | Protect | `mm monadefi protect --market ETH --trailing 1% --interval 3` | Each check line. Ctrl-C to stop |
| 4:15 | Positions and rebalance | `mm monadefi positions` then `mm monadefi rebalance --risk conservative` | Liquidation distance. The dry-run plan to reach 2x |
| 4:40 | Close | `mm monadefi close-perpl --market ETH` | The reduce-only close and its fill |

## Development

```bash
pnpm typecheck
pnpm test
pnpm build && npm pack
```

Source layout:

- `src/commands/monadefi/*.ts`: one oclif command per file (the file path is the command id).
- `src/lib/`: argument parsing, order building, risk adapter, protect and rebalance logic, Aurora client, Curve swap, the executor wrapper.
- `skills/monadefi/SKILL.md`: instructions for AI agents.
- `test/`: vitest unit tests with stubbed clients and a stubbed executor.

References: https://docs.metamask.io/agent-wallet/plugins/ (build, install, reference), https://github.com/MetaMask/agent-wallet-plugin-template, https://docs.perpl.xyz, https://docs.intents.aurora.dev.
