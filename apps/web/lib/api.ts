export interface Intent {
  id: string;
  kind: string;
  params: Record<string, any>;
  preview: Record<string, any>;
  status: "pending" | "confirmed" | "executing" | "done" | "failed" | "rejected" | "expired";
  feeUsd: number;
  result: Record<string, any> | null;
  createdAt: string;
}

export type AgentEvent =
  | { type: "session"; sessionId: string; skills: string[] }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; input: any }
  | { type: "tool_result"; id: string; isError: boolean; preview: string }
  | { type: "intent"; intent: Intent }
  | { type: "done"; costUsd: number; chargedUsd: number; turns: number; stopReason: string }
  | { type: "error"; message: string };

export interface Me {
  address: string;
  /** The Privy wallet of the user. The server can sign for it when `enabled` is true. */
  deposit: { address: string | null; enabled: boolean; signerId: string | null } | null;
  /** `legacyAddress` is an older key of the user; it equals `address` for most users. */
  wallet: { address: string; legacyAddress: string; autoExecute: boolean; maxActionUsd: number };
  pricing: { promptUsd: number; actionUsd: number; guardMinuteUsd: number };
}

const TOKEN_KEY = "defi-agent-token";

export const token = {
  get: () => (typeof window === "undefined" ? null : window.localStorage.getItem(TOKEN_KEY)),
  set: (t: string) => window.localStorage.setItem(TOKEN_KEY, t),
  clear: () => window.localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const t = token.get();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}), ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

/** Send a prompt and read the event stream. */
export async function* chat(prompt: string, sessionId: string | null, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const t = token.get();
  const res = await fetch("/api/chat", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify({ prompt, sessionId: sessionId ?? undefined }),
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data) yield JSON.parse(data) as AgentEvent;
    }
  }
}

export const usd = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: n !== 0 && Math.abs(n) < 0.01 ? 4 : digits });

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export interface Positions {
  address: string;
  asOf: string;
  balances: { chain: string; chainName: string; eth: number | null; usdc: number | null; error: string | null }[];
  /** Perpl on Monad: the AUSD trading account and the open positions (isolated margin). */
  perpl: {
    address?: string; accountId: number | null; balanceUsd: number; lockedUsd: number; freeUsd: number; frozen?: boolean;
    positions: { market: string; marketId: number; side: "long" | "short"; size: number; entryPx: number; markPx: number; marginUsd: number; notionalUsd: number; leverage: number; unrealizedPnl: number; liquidationPx: number | null; distanceToLiquidation: number | null }[];
  };
  /** Active and triggered guards. Guards watch Perpl positions only. */
  guards: Guard[];
  errors: string[];
  /** Every token of the wallet. null when LI.FI did not answer. */
  assets: { chainId: number; chainName: string; symbol: string; token: string; amount: number; usd: number | null; logo: string | null; chainLogo: string | null }[] | null;
}

/** A guard on a Perpl position. `lastValue` is the distance to liquidation in percent. */
export interface Guard { id: string; venue: "perpl"; params: Record<string, any>; status: string; lastValue: number | null; lastCheck: string | null }

/** GET /billing/balances: the USD value of the wallet. null when the tokens were not read. */
export interface Balances { address: string; usd: number | null }

/** POST /wallet/withdraw: funds go from the agent wallet to the sign-in address on Monad. */
export interface WithdrawRequest { chain: "monad"; asset: "USDC" | "MON"; amount: number }
export interface WithdrawResult { hash: string; explorer: string; to: string }
