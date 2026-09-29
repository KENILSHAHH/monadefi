// Aurora Intents Swap API (1Click engine). Docs: https://docs.intents.aurora.dev/intents-swap/what-is-swap-api.md
// Endpoints (checked 2026-10-13, api-reference/swap-api-reference/*.md):
//   GET  /api/tokens/{apiKey}
//   POST /api/quote/{apiKey}            -> { quote: { depositAddress, amountIn, amountOut, minAmountOut, deadline, ... } }
//   POST /api/deposit/submit/{apiKey}   body { txHash, depositAddress }
//   GET  /api/status/{apiKey}?depositAddress=...  -> { status, swapDetails: { refundedAmountFormatted, refundReason, ... } }
// Status values: KNOWN_DEPOSIT_TX, PENDING_DEPOSIT, INCOMPLETE_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, FAILED.
// The API key is a path segment. Aurora says it is not secret, but this plugin still never prints it.
export const AURORA_API = "https://intents-api.aurora.dev";
/** USDC on Monad in Aurora / 1Click asset ids. */
export const MONAD_USDC_ASSET = "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx";
export const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

export interface AuroraToken { assetId: string; decimals: number; blockchain: string; symbol: string; price?: number; contractAddress?: string }
export interface AuroraQuote {
  quote: { depositAddress?: string; depositMemo?: string; amountIn: string; amountInFormatted: string; amountOut: string; amountOutFormatted: string; minAmountOut: string; amountOutUsd?: string; amountInUsd?: string; deadline?: string; timeEstimate: number; refundFee?: string | null };
  quoteRequest: Record<string, unknown>;
  correlationId?: string | null;
}
export interface AuroraStatus {
  status: string;
  updatedAt?: string;
  swapDetails?: { amountOut?: string; amountOutFormatted?: string; refundedAmount?: string; refundedAmountFormatted?: string; refundReason?: string; destinationChainTxHashes?: { hash: string; explorerUrl?: string }[]; originChainTxHashes?: { hash: string; explorerUrl?: string }[] };
}

type Fetch = typeof fetch;

export class AuroraClient {
  constructor(private readonly apiKey: string, private readonly f: Fetch = fetch, private readonly base = AURORA_API) {}

  private url(path: string) {
    return `${this.base}${path}/${encodeURIComponent(this.apiKey)}`;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const q = query ? `?${new URLSearchParams(query)}` : "";
    const res = await this.f(`${this.url(path)}${q}`, {
      method, headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? msg;
      } catch { /* keep text */ }
      // The key is in the URL, never in the message. Remove it in case the server echoes it.
      throw new Error(`Aurora ${path} ${res.status}: ${msg.split(this.apiKey).join("***")}`);
    }
    return JSON.parse(text) as T;
  }

  tokens() {
    return this.call<{ tokens: AuroraToken[] }>("GET", "/api/tokens").then((r) => r.tokens);
  }

  quote(req: { originAsset: string; destinationAsset: string; amount: string; slippageBps: number; refundTo: string; recipient: string; dry?: boolean; deadline?: string }) {
    return this.call<AuroraQuote>("POST", "/api/quote", {
      dry: req.dry ?? false, swapType: "EXACT_INPUT", depositType: "ORIGIN_CHAIN",
      originAsset: req.originAsset, destinationAsset: req.destinationAsset, amount: req.amount, slippageTolerance: req.slippageBps,
      refundTo: req.refundTo, refundType: "ORIGIN_CHAIN", recipient: req.recipient, recipientType: "DESTINATION_CHAIN",
      ...(req.deadline ? { deadline: req.deadline } : {}),
    });
  }

  submitDeposit(txHash: string, depositAddress: string) {
    return this.call<AuroraStatus>("POST", "/api/deposit/submit", { txHash, depositAddress });
  }

  status(depositAddress: string) {
    return this.call<AuroraStatus>("GET", "/api/status", undefined, { depositAddress });
  }
}

/** Find the origin asset in the Aurora token list by chain code and symbol. */
export function findToken(tokens: AuroraToken[], blockchain: string, symbol: string): AuroraToken {
  const s = symbol.trim().toUpperCase();
  const hit = tokens.find((t) => t.blockchain === blockchain && t.symbol.toUpperCase() === s);
  if (hit) return hit;
  const chains = [...new Set(tokens.filter((t) => t.symbol.toUpperCase() === s).map((t) => t.blockchain))];
  throw new Error(`Aurora Intents has no ${s} on "${blockchain}". ${s} is on: ${chains.join(", ") || "no chain"}.`);
}

/** Poll the swap status until SUCCESS, REFUNDED or FAILED. Calls onChange on each new status. */
export async function waitForSwap(client: Pick<AuroraClient, "status">, depositAddress: string, opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; onChange?: (s: AuroraStatus) => void; sleep?: (ms: number) => Promise<void> } = {}): Promise<AuroraStatus> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = Date.now() + (opts.timeoutMs ?? 45 * 60_000);
  let last = "";
  for (;;) {
    if (opts.signal?.aborted) throw new Error(`Stopped while waiting. The swap continues on Aurora: check later with deposit address ${depositAddress}.`);
    let s: AuroraStatus | undefined;
    try {
      s = await client.status(depositAddress);
    } catch {
      s = undefined; // A transient error: try again on the next round.
    }
    if (s) {
      if (s.status !== last) {
        last = s.status;
        opts.onChange?.(s);
      }
      if (TERMINAL.has(s.status)) return s;
    }
    if (Date.now() > end) throw new Error(`The swap did not finish in time (last status ${last || "unknown"}). Deposit address: ${depositAddress}.`);
    await sleep(opts.intervalMs ?? 5_000);
  }
}
