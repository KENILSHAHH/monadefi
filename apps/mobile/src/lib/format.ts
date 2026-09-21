/**
 * Number and text formatting. Hermes supports Intl, but the output is built by hand here so it is the same
 * on iOS, Android and in Jest, and the tests can pin it.
 */

const groupInt = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Fixed decimals with thousands separators. Rounds half away from zero. */
export function fixed(n: number, decimals: number): string {
  if (!Number.isFinite(n)) return "—";
  const factor = 10 ** decimals;
  const rounded = Math.round(Math.abs(n) * factor + Number.EPSILON * factor) / factor;
  const [int = "0", frac] = rounded.toFixed(decimals).split(".");
  const sign = n < 0 && rounded !== 0 ? "-" : "";
  return `${sign}${groupInt(int)}${frac ? `.${frac}` : ""}`;
}

/** A plain number with up to `max` decimals and no trailing zeros, for example 0.00012 or 2,431.5. */
export function num(n: number | null | undefined, max = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const s = fixed(n, max);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** A USD value: $1,234.56. Values below one cent keep 4 decimals so they do not show as $0.00. */
export function usd(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const d = n !== 0 && Math.abs(n) < 0.01 ? 4 : decimals;
  const s = fixed(Math.abs(n), d);
  return `${n < 0 && s !== fixed(0, d) ? "-" : ""}$${s}`;
}

/** An AUSD amount: 1,234.56 AUSD. */
export const ausd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${fixed(n, 2)} AUSD`);

/** A signed USD value for profit and loss: +$12.30 or -$4.00. */
export function signedUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const s = usd(n);
  return n > 0 ? `+${s}` : s;
}

/** A percentage from a fraction: 0.1234 → 12.34%. */
export function pct(fraction: number | null | undefined, decimals = 2, signed = false): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "—";
  const s = `${fixed(fraction * 100, decimals)}%`;
  return signed && fraction > 0 ? `+${s}` : s;
}

/**
 * A price with a precision that fits its size: 104,250.5 / 2,431.25 / 1.2345 / 0.000123.
 * Perpl markets go from BTC to small tokens, so a fixed precision does not work.
 */
export function price(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const d = a >= 10_000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return fixed(n, d);
}

/** A short address: 0x1234…abcd. */
export const short = (a: string | null | undefined) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

/**
 * Parse an amount that the user typed. Accepts "12", "12.5", "12,5" and "1,234.5".
 * Returns null for text that is not a positive amount.
 */
export function parseAmount(input: string): number | null {
  const t = input.trim().replace(/\s/g, "");
  if (!t) return null;
  // One comma and no dot: the comma is the decimal mark ("12,5"). Otherwise commas group thousands.
  const normal = /^\d+,\d{1,2}$/.test(t) && !t.includes(".") ? t.replace(",", ".") : t.replace(/,/g, "");
  if (!/^\d*\.?\d+$|^\d+\.$/.test(normal)) return null;
  const n = Number(normal);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "in 3 min", "2 h ago" and so on, for the activity feed. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((now - t) / 1000);
  const abs = Math.abs(s);
  const unit = abs < 60 ? `${abs} s` : abs < 3600 ? `${Math.round(abs / 60)} min` : abs < 86_400 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86_400)} d`;
  if (abs < 5) return "now";
  return s >= 0 ? `${unit} ago` : `in ${unit}`;
}

/** A date for the session end: "Nov 12, 2026". */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Seconds to "about 2 min". */
export function eta(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  if (seconds < 90) return `about ${Math.round(seconds)} s`;
  if (seconds < 5400) return `about ${Math.round(seconds / 60)} min`;
  return `about ${Math.round(seconds / 3600)} h`;
}
