import { config } from "../config";
import type {
  ActivityItem, AuroraChain, AuroraDeposit, AuroraDepositBody, AuroraQuote, RiskCheckResponse, Balance, Candle, ChallengeResponse, Intent, OrderBook,
  PerplMarket, PositionsView, RelayCall, RelayPrepareResponse, RelaySendResponse, RiskCheckBody,
  SessionPermission, SessionRevokeResponse, SessionStartResponse, SessionStatus, SignedAuthorizationBody,
  TradePreviewBody, TradePreviewResponse, TxResponse, VerifyResponse, ApiErrorBody,
} from "./types";

/** An error from the API with a plain sentence for the user. `status` 0 means the server did not answer. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly body?: ApiErrorBody,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The auth layer plugs in here: it gives the token and renews it after a 401 without a passkey prompt. */
interface AuthHooks {
  getToken: () => string | null;
  /** Sign the server challenge again with the in-memory key. Returns the new token, or null when the key is locked. */
  renew: () => Promise<string | null>;
}

let hooks: AuthHooks = { getToken: () => null, renew: async () => null };
export function setAuthHooks(h: AuthHooks) {
  hooks = h;
}

const statusText = (status: number) =>
  status === 404 ? "This feature is not live on the server yet." :
  status === 401 ? "Your sign-in ended. Unlock with your passkey." :
  status === 429 ? "Too many requests. Wait a moment and try again." :
  status >= 500 ? "The Mona-DeFi server had a problem. Try again in a moment." :
  `The request failed (HTTP ${status}).`;

export function authHeader(token: string | null): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function send(path: string, init: RequestInit, token: string | null): Promise<Response> {
  try {
    return await fetch(`${config.apiUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", accept: "application/json", ...authHeader(token), ...(init.headers as Record<string, string> | undefined) },
    });
  } catch {
    throw new ApiError(0, "The Mona-DeFi server did not answer. Check your connection and try again.");
  }
}

export async function request<T>(path: string, init: RequestInit = {}, opts: { auth?: boolean } = {}): Promise<T> {
  const useAuth = opts.auth !== false;
  let res = await send(path, init, useAuth ? hooks.getToken() : null);
  if (res.status === 401 && useAuth) {
    const token = await hooks.renew().catch(() => null);
    if (token) res = await send(path, init, token);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const b = (body ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(res.status, typeof b.error === "string" && b.error ? b.error : statusText(res.status), b.code, b as ApiErrorBody);
  }
  return body as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: "POST", body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

const enc = encodeURIComponent;

/** Every route of docs/api-mobile.md. */
export const api = {
  auth: {
    challenge: (address: string) => request<ChallengeResponse>("/auth/mera/challenge", { method: "POST", body: JSON.stringify({ address }) }, { auth: false }),
    verify: (body: { address: string; nonce: string; signature: string }) =>
      request<VerifyResponse>("/auth/mera/verify", { method: "POST", body: JSON.stringify(body) }, { auth: false }),
  },
  session: {
    status: () => get<SessionStatus>("/session"),
    upgrade: (authorization: SignedAuthorizationBody) => post<TxResponse>("/session/upgrade", { authorization }),
    start: (days: number) => post<SessionStartResponse>("/session/start", { days }),
    grant: (id: string, signature: string) => post<SessionPermission>("/session/grant", { id, signature }),
    revoke: () => del<SessionRevokeResponse>("/session"),
  },
  relay: {
    prepare: (calls: RelayCall[]) => post<RelayPrepareResponse>("/relay/prepare", { calls }),
    send: (id: string, signature: string) => post<RelaySendResponse>("/relay/send", { id, signature }),
  },
  balance: () => get<Balance>("/balance"),
  positions: () => get<PositionsView>("/positions"),
  activity: async () => {
    const r = await get<ActivityItem[] | { activity: ActivityItem[] }>("/activity");
    return Array.isArray(r) ? r : (r?.activity ?? []);
  },
  markets: {
    list: () => get<{ markets: PerplMarket[] }>("/perpl/markets").then((r) => r.markets),
    book: (symbol: string, levels = 10) => get<OrderBook>(`/perpl/markets/${enc(symbol)}/book?levels=${levels}`),
    // The contract shows a bare array. The server sends { market, resolutionSec, candles }. Both work.
    candles: (symbol: string, res = 3600, hours = 24) =>
      get<Candle[] | { candles: Candle[] }>(`/perpl/markets/${enc(symbol)}/candles?res=${res}&hours=${hours}`).then((r) => (Array.isArray(r) ? r : (r?.candles ?? []))),
  },
  risk: {
    check: (body: RiskCheckBody) => post<RiskCheckResponse>("/risk/check", body),
  },
  trade: {
    preview: (body: TradePreviewBody) => post<TradePreviewResponse>("/trade/preview", body),
    close: (market: string, fraction = 1) => post<{ intent: Intent }>("/trade/close", { market, fraction }),
  },
  intents: {
    confirm: (id: string) => post<Intent>(`/intents/${enc(id)}/confirm`),
    reject: (id: string) => post<Intent>(`/intents/${enc(id)}/reject`),
  },
  deposit: {
    assets: () => get<{ chains: AuroraChain[] }>("/deposit/aurora/assets").then((r) => r.chains),
    quote: (assetId: string, amount: string) => post<AuroraQuote>("/deposit/aurora/quote", { assetId, amount }),
    create: (body: AuroraDepositBody) => post<{ deposit: AuroraDeposit }>("/deposit/aurora", body).then((r) => r.deposit),
    list: () => get<{ deposits: AuroraDeposit[] }>("/deposit/aurora").then((r) => r.deposits),
    get: (id: string) => get<{ deposit: AuroraDeposit }>(`/deposit/aurora/${enc(id)}`).then((r) => r.deposit),
    signature: (id: string, signature: string) => post<{ deposit: AuroraDeposit }>(`/deposit/aurora/${enc(id)}/signature`, { signature }).then((r) => r.deposit),
    tx: (id: string, txHash: string) => post<{ deposit: AuroraDeposit }>(`/deposit/aurora/${enc(id)}/tx`, { txHash }).then((r) => r.deposit),
    refresh: (id: string) => post<{ deposit: AuroraDeposit }>(`/deposit/aurora/${enc(id)}/refresh`).then((r) => r.deposit),
    convert: (id: string) => post<RelayPrepareResponse>(`/deposit/aurora/${enc(id)}/convert`),
    converted: (id: string) => post<{ deposit: AuroraDeposit }>(`/deposit/aurora/${enc(id)}/converted`).then((r) => r.deposit),
  },
  chatMessage: (prompt: string) => post<unknown>("/chat/message", { prompt }),
};

export function errorMessage(e: unknown, fallback = "Something went wrong. Try again."): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message.split("\n")[0] ?? fallback;
  return fallback;
}
