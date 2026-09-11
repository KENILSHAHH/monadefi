# @app/risk

Nansen wallet-segment risk engine for Perpl perps on Monad.
Before a trade, it asks Nansen what each wallet segment does with the asset.
The result changes the trade: block, leverage cap, size, stop-loss and margin buffer.
During a trade, `monitorPosition` returns hold, tighten_stop, reduce or exit.

The policy is deterministic code. It does not use an LLM.
The package has no database and no app config. It takes `{ apiKey, fetch? }`.
So it runs in the API server, in a CLI plugin and in tests.

## Use

```ts
import { assessTrade, applyVerdict, monitorPosition } from "@app/risk";

const verdict = await assessTrade({
  apiKey: process.env.NANSEN_API_KEY, market: "ETH", side: "long",
  leverage: 10, marginUsd: 100, marketMaxLeverage: 12, trader: "0xYourPerplWallet",
});
const { order, changes, blocked } = applyVerdict({ leverage: 10, marginUsd: 100, stopLossPx: null }, verdict, { entryPx: 3000 });
// blocked: do not send. Otherwise send `order` and show `changes` to the user.

const check = await monitorPosition({ apiKey, market: "ETH", side: "long", entryPx: 3000, markPx: 2950, sizeUsd: 1000, leverage: 4 });
// check.action: "hold" | "tighten_stop" (check.stopPx) | "reduce" (check.reduceFraction) | "exit"
```

Example `changes` for a 10x ETH long when the segments lean against it (score -38):

```text
Leverage 10x -> 4x: Exchanges received a net 25.0M USD of native ETH on Ethereum in 24h (sell pressure)
Margin 100 USD -> 50 USD (size x0.5): Exchanges received a net 25.0M USD of native ETH on Ethereum in 24h (sell pressure)
Margin buffer +25%: margin 50 USD -> 62.5 USD and leverage 4x -> 3.2x at the same 200 USD position: ...
Stop-loss set at 2910 (3% below entry 3000): ...
```

## Segments

Each segment is a separate signal. A signal has an impact from -1 (against the trade) to +1 (with the trade).

| Segment | Signal id | Nansen source | Meaning | Weight |
|---|---|---|---|---|
| smart_money | `sm_perp_positioning` | `/tgm/position-intelligence` | Long vs short USD of Smart HL Perps Traders on Hyperliquid | 0.25 |
| smart_money | `sm_perp_trades_24h` | `/smart-money/perp-trades` | Buy-side vs sell-side USD of smart money perp trades, 24h (100 largest) | 0.15 |
| smart_money | `sm_spot_flow_24h` | `/tgm/flow-intelligence` | Net spot flow of Smart Traders, 24h | 0.12 |
| smart_money | `top_pnl_spot_flow_24h` | `/tgm/flow-intelligence` | Net spot flow of top PnL wallets, 24h | 0.05 |
| whales | `whale_perp_positioning` | `/tgm/position-intelligence` | Long vs short USD of whales on Hyperliquid | 0.10 |
| whales | `whale_spot_flow_24h` | `/tgm/flow-intelligence` | Net spot flow of whales, 24h | 0.10 |
| exchanges | `exchange_flow_24h` | `/tgm/flow-intelligence` | Net flow into exchanges, 24h. Inflow = sell pressure, so the sign is inverted | 0.15 |
| public_figures | `public_figure_perp_positioning` | `/tgm/position-intelligence` | Long vs short USD of public figures on Hyperliquid | 0.05 |
| public_figures | `public_figure_spot_flow_24h` | `/tgm/flow-intelligence` | Net spot flow of public figures, 24h | 0.03 |
| fresh_wallets | `fresh_wallet_flow_24h` | `/tgm/flow-intelligence` | Large fresh-wallet flow in either direction is a risk (crowding, sybil or airdrop flow) | 0.05 |
| top_holders | `top_holder_flow_24h` | `/tgm/holders` | 24h balance change of the top 10 non-exchange holders | 0.08 |
| concentration | `top10_concentration` | `/tgm/holders` | Share of supply of the top 10 non-exchange holders. Risk points only | see below |
| trader | `trader_record_30d` | `/profiler/address/pnl-summary` | Win rate and realized PnL of the trader wallet on Monad, 30 days. Risk points only | see below |

Flow signals use `tanh(netFlowUsd / flowScaleUsd)`. `flowScaleUsd` is set per market in `src/markets.ts` (for example ETH 25M USD).
Positioning signals use `(long - short) / (long + short)`. A cohort with less than 50k USD is ignored.

## Score

```text
score = 100 * sum(weight * impact) / max(sum(weight), 0.6)   // directional signals that returned data
      + concentration points + trader points                 // then clamped to -100 .. +100
```

The minimum weight of 0.6 stops one small signal from moving the score to an extreme.

| Risk points | Rule |
|---|---|
| -25 | top 10 non-exchange holders own 70% or more |
| -15 | 50% to 70% |
| -5 | 35% to 50% |
| -10 | trader: 5 or more trades, win rate below 35% and a realized loss |
| +5 | trader: 5 or more trades, win rate 55% or more and a realized profit |

## Policy

| Score | Decision | Level | Max leverage | Size (margin) | Stop-loss | Margin buffer |
|---|---|---|---|---|---|---|
| no data | reduce | high | min(request, 3x) | x1 | required, tight | 0% |
| <= -60 | block | extreme | 0 | x0 | - | - |
| -60 .. -25 | reduce | high | min(request, max(1, floor(market max / 3))) | x0.5 | required, tight | +25% |
| -25 .. +25 | allow | medium | min(request, market max) | x1 | required if leverage > 5x, normal | +10% if leverage > 5x |
| >= +25 | allow | low | as requested (up to market max) | x1 | not required | 0% |

- Stop distance = min(cap, 0.5 x 100 / leverage) %. The cap is 3% (tight) or 5% (normal). The minimum is 0.5%.
- `applyVerdict` keeps a stop that the user set if it is tighter. It moves a looser stop.
- The margin buffer keeps the position size the same. It adds collateral and lowers the leverage. Perpl applies the leverage to the whole position, so this is the same as `increasePositionCollateral` after the open.
- No data means: no key, Nansen errors, or no coverage. The verdict says `dataAvailable: false` and the reason. It never invents signals.

`monitorPosition` uses the same score:

| Score | Position in loss | Position in profit |
|---|---|---|
| <= -60 | exit | exit |
| -60 .. -25 | reduce 50% | tighten_stop (to break-even or mark minus the tight distance) |
| > -25 | hold | hold |
| no data | hold | hold |

## Credit budget

Costs are from https://docs.nansen.ai/getting-started/credits. Only 2xx answers are charged (header `X-Nansen-Credits-Used`).

| Call | Credits | When |
|---|---|---|
| `/tgm/position-intelligence` | 1 | always |
| `/tgm/flow-intelligence` (timeframe 1d) | 1 | when the market has a spot token (not ZEC) |
| `/profiler/address/pnl-summary` | 1 | when `trader` is given |
| `/smart-money/perp-trades` (lookback 24h) | 5 | always, inside the budget |
| `/tgm/holders` (`premium_labels: false`) | 5 | LIT, VVV, PUMP, UNI only |

- One full assessment costs 7 credits (ETH, BTC, SOL), 8 with a trader, 13 for UNI with a trader.
- `maxCredits` (default 15) skips calls in reverse priority order. `maxCredits: 2` uses only the two 1-credit calls.
- `monitorPosition` uses `maxCredits: 2` by default.
- Answers are cached in memory: 5 min (perp data), 10 min (flows), 15 min (holders, trader PnL). A repeat costs 0 credits.
- The Free plan gives 100 credits once, then 10 a day. That is about 1 full assessment a day after the first 100. A continuous monitor needs the Pro plan.
- Rate limit: 15 requests per second on Free. One assessment sends at most 5 requests. A 429 is retried after `Retry-After`.

## Markets

| Perpl | Hyperliquid symbol | Spot token for flows | Holders check |
|---|---|---|---|
| BTC | BTC | WBTC on Ethereum `0x2260fac5e5542a773aa44fbcfedf7c193bc2c599` (proxy) | no |
| ETH | ETH | native ETH on Ethereum (placeholder `0xeeee...eeee`) | no |
| SOL | SOL | native SOL on Solana `So11111111111111111111111111111111111111112` | no |
| MON | MON | native MON on Monad (placeholder) | no |
| HYPE | HYPE | native HYPE on HyperEVM (placeholder) | no |
| ZEC | ZEC | none (Nansen has no Zcash chain) | no |
| LIT | LIT | LIT on Ethereum `0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2` | yes |
| VVV | VVV | VVV on Base `0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf` | yes |
| PUMP | PUMP | PUMP on Solana `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn` | yes |
| NEAR | NEAR | native NEAR (`native-token.near`) | no |
| UNI | UNI | UNI on Ethereum `0x1f9840a85d5af5bf1d1762f925bdaddc4201f984` | yes |

A market that is not in the table gets only the Hyperliquid perp signals, with the same symbol.

## API key

1. Go to https://app.nansen.ai/auth/agent-setup and sign in.
2. Create a key with the `data` permission.
3. Pass it as `apiKey` (the server reads `NANSEN_API_KEY`). The client sends it in the `apikey` header.

## Nansen MCP

The same data is on the Nansen MCP server: `https://mcp.nansen.ai/ra/mcp`, header `NANSEN-API-KEY: <key>`.
Example for Claude Code:

```bash
claude mcp add --transport http nansen https://mcp.nansen.ai/ra/mcp --header "NANSEN-API-KEY: $NANSEN_API_KEY"
```

The MCP tools are for the agent to explain a verdict. The verdict itself comes from this package, so it is the same every time.

## Tests

```bash
npx vitest run          # fake Nansen responses, no network, no credits
npx tsc -p tsconfig.json
```
