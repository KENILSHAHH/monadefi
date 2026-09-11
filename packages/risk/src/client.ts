// Typed Nansen API client. No app config, no database: it takes { apiKey, fetch? }.
// Facts from https://docs.nansen.ai (checked 2026-10-13):
// - Base https://api.nansen.ai/api/v1. Data endpoints are POST with a JSON body. Header `apikey: <key>`.
// - Credits are charged only on 2xx. The header X-Nansen-Credits-Used gives the charge (0 on errors).
//   X-Nansen-Credits-Remaining gives the balance when the account has one.
// - 429: wait Retry-After seconds (the body can also carry retry_after), then retry.
// - Errors carry { error, message, code, status, request_id }. A rejected key returns { message } only.
import { z } from "zod";

export const NANSEN_API = "https://api.nansen.ai/api/v1";
/** Nansen MCP server (full tool catalog). Auth header: NANSEN-API-KEY. */
export const NANSEN_MCP = { url: "https://mcp.nansen.ai/ra/mcp", authHeader: "NANSEN-API-KEY" } as const;
/** Where a user gets a key. */
export const NANSEN_KEY_URL = "https://app.nansen.ai/auth/agent-setup";

/** Documented credit cost per call (Free and Pro), https://docs.nansen.ai/getting-started/credits. */
export const CREDIT_COST: Record<string, number> = {
  "/tgm/position-intelligence": 1,
  "/tgm/flow-intelligence": 1,
  "/tgm/flows": 1,
  "/tgm/who-bought-sold": 1,
  "/tgm/token-information": 1,
  "/profiler/address/pnl-summary": 1,
  "/profiler/address/related-wallets": 1,
  "/profiler/perp-pnl-summary": 1,
  "/smart-money/perp-trades": 5,
  "/smart-money/netflow": 5,
  "/smart-money/holdings": 5,
  "/smart-money/dex-trades": 5,
  "/tgm/holders": 5,
  "/tgm/indicators": 5,
  "/tgm/perp-positions": 5,
};

/** Cache time per endpoint. Nansen itself caches flow-intelligence for 10-30 min. */
export const DEFAULT_TTL_MS: Record<string, number> = {
  "/tgm/position-intelligence": 5 * 60_000,
  "/smart-money/perp-trades": 5 * 60_000,
  "/tgm/flow-intelligence": 10 * 60_000,
  "/tgm/holders": 15 * 60_000,
  "/profiler/address/pnl-summary": 15 * 60_000,
};
const FALLBACK_TTL_MS = 10 * 60_000;
/** A failed call (not 429, not 5xx) is cached for this long, so that an unsupported token is not asked again and again. */
const ERROR_TTL_MS = 15 * 60_000;

export class NansenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly path: string,
  ) {
    super(message);
    this.name = "NansenError";
  }
}

export interface NansenResult<T> {
  data: T;
  /** Credits charged for this call. 0 when the result came from the cache. */
  credits: number;
  cached: boolean;
  /** Credits left on the account, when Nansen sends it. */
  remaining?: number;
}

export interface NansenClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Per-attempt timeout. Default 12 s. */
  timeoutMs?: number;
  /** Retries after a 429 or a retryable 5xx. Default 2. */
  maxRetries?: number;
  /** Longest wait for one Retry-After. Default 10 s. */
  maxRetryWaitMs?: number;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Shared cache. Default: the module cache (one per process). */
  cache?: ResponseCache;
  now?: () => number;
}

type Entry = { expires: number; value: Promise<{ body: unknown; remaining?: number }> | { body: unknown; remaining?: number } | { error: NansenError } };

/** A small TTL cache. It also shares a call that is still in flight. */
export class ResponseCache {
  private map = new Map<string, Entry>();
  constructor(private maxEntries = 500) {}
  get(key: string, now: number): Entry | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= now) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }
  set(key: string, e: Entry) {
    if (this.map.size >= this.maxEntries) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, e);
  }
  delete(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
}

export const sharedCache = new ResponseCache();
/** Empties the module cache. For tests and for a key change. */
export function clearNansenCache() {
  sharedCache.clear();
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const num = (v: string | null | undefined) => (v == null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

/** Stable JSON for the cache key (sorted object keys). */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export interface NansenClient {
  post<S extends z.ZodType>(path: string, body: Record<string, unknown>, schema: S, opts?: { ttlMs?: number }): Promise<NansenResult<z.infer<S>>>;
}

export function createNansenClient(opts: NansenClientOptions): NansenClient {
  if (!opts.apiKey) throw new Error("A Nansen API key is required. Get one at " + NANSEN_KEY_URL);
  const f = opts.fetch ?? globalThis.fetch;
  const base = (opts.baseUrl ?? NANSEN_API).replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const maxRetries = opts.maxRetries ?? 2;
  const maxWait = opts.maxRetryWaitMs ?? 10_000;
  const sleep = opts.sleep ?? defaultSleep;
  const cache = opts.cache ?? sharedCache;
  const now = opts.now ?? Date.now;

  async function send(path: string, body: Record<string, unknown>): Promise<{ body: unknown; credits: number; remaining?: number }> {
    for (let attempt = 0; ; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res: Response;
      try {
        res = await f(base + path, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", apikey: opts.apiKey },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const timedOut = ac.signal.aborted;
        if (attempt < maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new NansenError(timedOut ? `Nansen did not answer in ${timeoutMs} ms` : `Nansen request failed: ${(e as Error).message}`, 0, timedOut ? "timeout" : "network_error", path);
      }
      clearTimeout(timer);
      const text = await res.text();
      let json: unknown = undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      const remaining = num(res.headers.get("x-nansen-credits-remaining"));
      if (res.ok) {
        const used = num(res.headers.get("x-nansen-credits-used"));
        return { body: json, credits: used ?? CREDIT_COST[path] ?? 1, remaining };
      }
      const err = (json && typeof json === "object" ? json : {}) as { message?: string; code?: string; retry_after?: number; detail?: string };
      const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504 || err.code === "query_timeout" || err.code === "upstream_unavailable";
      if (retryable && attempt < maxRetries) {
        const ra = num(res.headers.get("retry-after")) ?? err.retry_after;
        const wait = Math.min(maxWait, ra != null ? ra * 1000 : 1000 * 2 ** attempt);
        await sleep(wait);
        continue;
      }
      const msg = err.message ?? err.detail ?? `HTTP ${res.status}`;
      throw new NansenError(`Nansen ${path} returned ${res.status}${err.code ? ` (${err.code})` : ""}: ${msg}`, res.status, err.code, path);
    }
  }

  return {
    async post(path, body, schema, o) {
      const key = path + " " + stableJson(body);
      const t = now();
      const hit = cache.get(key, t);
      if (hit) {
        const v = await hit.value;
        if ("error" in v) throw v.error;
        return { data: schema.parse(v.body), credits: 0, cached: true, remaining: v.remaining };
      }
      const ttl = o?.ttlMs ?? DEFAULT_TTL_MS[path] ?? FALLBACK_TTL_MS;
      const p = send(path, body);
      // Share the in-flight call. The credits are counted only by the caller that started it.
      const shared = p.then((r) => ({ body: r.body, remaining: r.remaining }));
      cache.set(key, { expires: t + ttl, value: shared });
      shared.catch(() => undefined);
      try {
        const r = await p;
        cache.set(key, { expires: t + ttl, value: { body: r.body, remaining: r.remaining } });
        const parsed = schema.safeParse(r.body);
        if (!parsed.success) {
          cache.delete(key);
          throw new NansenError(`Nansen ${path} returned an unexpected shape: ${parsed.error.issues[0]?.message ?? "invalid"}`, 200, "bad_shape", path);
        }
        return { data: parsed.data, credits: r.credits, cached: false, remaining: r.remaining };
      } catch (e) {
        const ne = e instanceof NansenError ? e : new NansenError((e as Error).message, 0, "unknown", path);
        // Keep "this token is not supported" (4xx) answers. Do not keep rate limits, auth, credit or server errors.
        const keep = ne.status >= 400 && ne.status < 500 && ![401, 402, 403, 408, 429].includes(ne.status);
        if (keep) cache.set(key, { expires: t + ERROR_TTL_MS, value: { error: ne } });
        else cache.delete(key);
        throw ne;
      }
    },
  };
}

// ── Response schemas (only the fields used; extra fields are kept and ignored) ──

const n = z.number().nullish();
const s = z.string().nullish();

export const PositionIntelligenceSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      smart_trader_longs_usd: n, smart_trader_shorts_usd: n, smart_trader_total_usd: n,
      whale_longs_usd: n, whale_shorts_usd: n, whale_total_usd: n,
      public_figure_longs_usd: n, public_figure_shorts_usd: n, public_figure_total_usd: n,
    }),
  ).default([]),
});

export const FlowIntelligenceSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      public_figure_net_flow_usd: n, public_figure_wallet_count: n,
      top_pnl_net_flow_usd: n, top_pnl_wallet_count: n,
      whale_net_flow_usd: n, whale_wallet_count: n,
      smart_trader_net_flow_usd: n, smart_trader_wallet_count: n,
      exchange_net_flow_usd: n,
      fresh_wallets_net_flow_usd: n,
    }),
  ).default([]),
  warnings: z.array(z.string()).nullish(),
});

export const SmartMoneyPerpTradesSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      trader_address: s, trader_address_label: s, token_symbol: s, side: s, action: s,
      value_usd: n, block_timestamp: s,
    }),
  ).default([]),
});

export const HoldersSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      address: s, address_label: s, token_amount: n, value_usd: n, ownership_percentage: n,
      balance_change_24h: n, balance_change_7d: n,
    }),
  ).default([]),
  warnings: z.array(z.string()).nullish(),
});

export const PnlSummarySchema = z.looseObject({
  traded_token_count: n,
  traded_times: n,
  realized_pnl_usd: n,
  realized_pnl_percent: n,
  win_rate: n,
});
