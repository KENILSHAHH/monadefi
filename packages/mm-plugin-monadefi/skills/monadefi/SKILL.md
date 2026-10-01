---
name: monadefi
description: Trade Perpl perpetuals on Monad (chain 143) through the MetaMask Agent Wallet `mm monadefi` plugin, with a Nansen smart-money risk check before each trade. Use it to list markets, read positions, check risk, open and close positions, keep a stop or trailing stop, rebalance leverage, and fund AUSD from another chain. Every transaction goes through Agent Wallet signing, policy and MFA.
---

# Mona-DeFi: Nansen-aware Perpl trading with `mm`

This skill tells an AI agent how to use the `mm monadefi` commands safely.
The plugin never holds a private key. It never signs. Each transaction goes to the Agent Wallet executor, which applies the wallet policy, simulation, Blockaid scanning and MFA.

## Rules for the agent

1. Read before you write. Run `mm monadefi markets` and `mm monadefi positions` first.
2. Run `mm monadefi risk` before each `open-perpl`. Tell the user the decision and the changes.
3. Use `--dry-run` first for `open-perpl`, `close-perpl` and `fund`. Show the plan. Send only after the user agrees.
4. Never use `--ignore-risk`. Only the user can ask for it, in their own words. It also needs `--yes`.
5. Never ask for a private key or a seed phrase. The plugin has no use for them.
6. Never print a Nansen or Aurora key. Ask the user to set it with `mm monadefi config set <key>` and stdin.
7. Use `--json` and read the `ok`, `data` and `hint` fields. Human text goes to stderr.
8. When a result has `status: "pending"` or a `pollingId`, stop. Tell the user to approve in MetaMask. Do not send the command again. A later approval still executes the first request.
9. A stop needs `mm monadefi protect` to run. Tell the user that the stop is not active when the watcher is off.

## Facts about Perpl

- AUSD is the only collateral. Each position has its own margin (isolated margin).
- A market order is an immediate-or-cancel limit order at the worst accepted price (mark +/- slippage).
- The contract silently clamps leverage above the market maximum. The plugin refuses such leverage first.
- A close larger than the position reverts. The plugin closes the exact position size for a full close.
- A resting order needs some free AUSD in the Perpl account. The plugin keeps 1 AUSD free for a limit order or a take-profit.
- The first deposit opens the Perpl account. It must be at least 10 AUSD.

## Commands

| Command | Writes? | Use |
|---|---|---|
| `mm monadefi markets [--market ETH]` | no | Markets: mark price, max leverage, funding, 24h volume, open interest |
| `mm monadefi positions [--address 0x..]` | no | AUSD free and locked, positions, liquidation price and distance |
| `mm monadefi risk --market ETH --side long --leverage 5 --margin 20` | no | Nansen verdict, segments, and the changes `open-perpl` would make |
| `mm monadefi open-perpl --market ETH --side long --leverage 2 --margin 20 [--limit P --post-only] [--stop P] [--tp P] [--dry-run]` | yes | Risk check, deposit if needed, order, take-profit |
| `mm monadefi close-perpl --market ETH [--fraction 0.5] [--dry-run]` | yes | Reduce-only market close |
| `mm monadefi protect --market ETH --stop P [--trailing 3%] [--tp P] [--watch-only]` | yes | Foreground watcher. Closes on stop, trailing stop, take-profit or a Nansen "exit" |
| `mm monadefi rebalance --risk conservative\|balanced\|aggressive [--execute]` | yes with `--execute` | Bring each position to the target leverage |
| `mm monadefi fund --from base --amount 50 [--asset USDC] [--deposit-perpl] [--dry-run]` | yes | Aurora Intents bridge to Monad USDC, Curve swap to AUSD, Perpl deposit |
| `mm monadefi config set\|get <key>` | no | `nansen-key`, `aurora-key`, `slippage-bps` |

## Risk policy (what `open-perpl` does with the verdict)

- `block`: the command refuses. Nothing is sent.
- `reduce`: leverage goes down, margin goes down, a stop is required.
- `allow`: the trade goes as asked. Above 5x on a neutral score, the engine adds a stop and a 10% margin buffer.
- No Nansen key or no data: the engine caps leverage at 3x and requires a tight stop (at most 3% from entry).
- The margin buffer keeps the position size and adds collateral. The AUSD used can be up to 10% more than `--margin`.

Example: check, then open with a dry run.

```bash
mm monadefi risk --market ETH --side long --leverage 5 --margin 20 --json
mm monadefi open-perpl --market ETH --side long --leverage 5 --margin 20 --dry-run --json
mm monadefi open-perpl --market ETH --side long --leverage 5 --margin 20 --json
mm monadefi protect --market ETH --stop 2430
```

## Reading results

- `open-perpl` status: `filled`, `partially_filled`, `resting` (limit order on the book), `not_filled`, `pending`, `dry_run`.
- `fills.avgFillPx`, `fills.filledSize`, `fills.feeUsd` come from the receipt events of the order.
- `stop.protectCommand` is the exact command that keeps the stop.
- `fund` status: `pending`, `bridged`, `swapped`, `deposited`, `refunded`, `failed`, `dry_run`. On `refunded`, `bridge.refund` has the amount and the reason. The refund goes to the same address on the origin chain.

## Errors to handle

| Code | Meaning | What to do |
|---|---|---|
| `RISK_BLOCKED` | Nansen blocks the trade | Tell the user. Do not retry with other flags to get around it |
| `INVALID_LEVERAGE` | Above the market maximum or below 1x | Use a valid leverage |
| `MISSING_WALLET_REF` / `AUTH_FAILED` | No wallet or no login | Ask the user to run `mm login` and `mm init` |
| `TX_NOT_COMPLETED`, `DENIED`, `EXPIRED` | A step did not complete | Read the message: it lists the steps that did complete |
| `MISSING_CONFIG` | No Aurora key | Ask the user to set `aurora-key` |
