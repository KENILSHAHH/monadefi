// Argument parsing and checks. Pure functions, so the unit tests cover them without a CLI.
export class InputError extends Error {
  constructor(message: string, readonly code = "INVALID_INPUT") {
    super(message);
  }
}

export type Side = "long" | "short";
export type RiskProfile = "conservative" | "balanced" | "aggressive";

const isBlank = (v: unknown): v is undefined | null | "" => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

export function optional(raw: unknown): string | undefined {
  return isBlank(raw) ? undefined : String(raw).trim();
}

export function parseSide(raw: unknown): Side {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "long" || v === "buy") return "long";
  if (v === "short" || v === "sell") return "short";
  throw new InputError(`--side must be long or short (got "${raw ?? ""}").`, "INVALID_SIDE");
}

/** A finite number above zero. `max` is inclusive. */
export function parsePositive(name: string, raw: unknown, opts: { max?: number; min?: number } = {}): number {
  if (isBlank(raw)) throw new InputError(`--${name} is required.`, "MISSING_FLAG");
  const s = String(raw).trim().replace(/[_,$]/g, "");
  if (!/^\d*\.?\d+(e[+-]?\d+)?$/i.test(s)) throw new InputError(`--${name} must be a number (got "${raw}").`);
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new InputError(`--${name} must be above zero (got "${raw}").`);
  if (opts.min !== undefined && n < opts.min) throw new InputError(`--${name} must be at least ${opts.min} (got ${n}).`);
  if (opts.max !== undefined && n > opts.max) throw new InputError(`--${name} must be at most ${opts.max} (got ${n}).`);
  return n;
}

export function parseOptionalPositive(name: string, raw: unknown, opts: { max?: number; min?: number } = {}): number | undefined {
  return isBlank(raw) ? undefined : parsePositive(name, raw, opts);
}

/**
 * Leverage, from 1x to the market maximum. The Perpl contract silently clamps a leverage above the maximum,
 * so the plugin refuses it before anything is built. "5", "5x" and "5X" are all 5.
 */
export function parseLeverage(raw: unknown, marketMax?: number): number {
  const n = parsePositive("leverage", String(raw ?? "").trim().replace(/x$/i, ""));
  if (n < 1) throw new InputError(`--leverage must be at least 1x (got ${n}x).`, "INVALID_LEVERAGE");
  if (Math.round(n * 100) / 100 !== n) throw new InputError(`--leverage takes at most two decimals (got ${n}).`, "INVALID_LEVERAGE");
  if (marketMax !== undefined && n > marketMax) throw new InputError(`The most leverage on this Perpl market is ${marketMax}x. ${n}x is not possible: the contract would silently use ${marketMax}x.`, "INVALID_LEVERAGE");
  return n;
}

/** A percentage. "3%" and "3" are both 0.03. Allowed range: above 0 and below 100%. */
export function parsePercent(name: string, raw: unknown): number {
  const s = String(raw ?? "").trim().replace(/%$/, "");
  const n = parsePositive(name, s);
  if (n >= 100) throw new InputError(`--${name} must be below 100% (got ${raw}).`);
  return n / 100;
}

/** A part of a position: 0 < f <= 1. "0.5", "50%" are both a half. */
export function parseFraction(raw: unknown): number {
  if (isBlank(raw)) return 1;
  const s = String(raw).trim();
  const n = s.endsWith("%") ? parsePositive("fraction", s.slice(0, -1)) / 100 : parsePositive("fraction", s);
  if (n > 1) throw new InputError(`--fraction must be at most 1 (or 100%). Got ${raw}.`);
  return n;
}

export function parseRiskProfile(raw: unknown): RiskProfile {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "conservative" || v === "balanced" || v === "aggressive") return v;
  throw new InputError(`--risk must be conservative, balanced or aggressive (got "${raw ?? ""}").`);
}

export function parseMarket(raw: unknown): string {
  const v = String(raw ?? "").trim().toUpperCase().replace(/-?PERP$/, "").replace(/[-/]USD[CT]?$/, "");
  if (!v) throw new InputError("--market is required (for example ETH or BTC).", "MISSING_FLAG");
  if (!/^[A-Z0-9]{1,12}$/.test(v)) throw new InputError(`--market looks wrong: "${raw}".`);
  return v;
}

export function parseAddress(raw: unknown): `0x${string}` {
  const v = String(raw ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new InputError(`Not an EVM address: "${raw}".`, "INVALID_EVM_ADDRESS");
  return v as `0x${string}`;
}

/** Origin chains for `monadefi fund`. `aurora` is the blockchain code of the 1Click / Aurora Intents token list. */
export interface OriginChain { key: string; chainId: number; aurora: string; name: string }
export const ORIGIN_CHAINS: readonly OriginChain[] = [
  { key: "base", chainId: 8453, aurora: "base", name: "Base" },
  { key: "arbitrum", chainId: 42161, aurora: "arb", name: "Arbitrum" },
  { key: "ethereum", chainId: 1, aurora: "eth", name: "Ethereum" },
  { key: "optimism", chainId: 10, aurora: "op", name: "Optimism" },
  { key: "polygon", chainId: 137, aurora: "pol", name: "Polygon" },
  { key: "bsc", chainId: 56, aurora: "bsc", name: "BNB Smart Chain" },
  { key: "avalanche", chainId: 43114, aurora: "avax", name: "Avalanche" },
  { key: "monad", chainId: 143, aurora: "monad", name: "Monad" },
];
const CHAIN_ALIASES: Record<string, string> = { arb: "arbitrum", eth: "ethereum", mainnet: "ethereum", op: "optimism", pol: "polygon", matic: "polygon", bnb: "bsc", avax: "avalanche", mon: "monad" };

export function parseOriginChain(raw: unknown): OriginChain {
  const v = String(raw ?? "").trim().toLowerCase();
  const key = CHAIN_ALIASES[v] ?? v;
  const byId = ORIGIN_CHAINS.find((c) => String(c.chainId) === v);
  const found = byId ?? ORIGIN_CHAINS.find((c) => c.key === key);
  if (!found) throw new InputError(`--from must be one of ${ORIGIN_CHAINS.map((c) => c.key).join(", ")} (got "${raw ?? ""}").`, "INVALID_CHAIN");
  return found;
}

/** Decimal string to base units, without floating point loss. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new InputError(`Not a plain decimal amount: "${amount}".`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new InputError(`The amount has more than ${decimals} decimals.`);
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function fromBaseUnits(v: bigint | string, decimals: number): number {
  return Number(BigInt(v)) / 10 ** decimals;
}

export function isTruthyFlag(v: unknown): boolean {
  return v === true || v === "true" || v === "1" || v === "yes";
}
