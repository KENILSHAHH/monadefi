// Human output helpers. JSON output is the command's return value; these lines go to io.emit (stderr in headless mode).
export const usd = (n: number | null | undefined, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? "-" : `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`);
export const num = (n: number | null | undefined, d = 4) => (n === null || n === undefined || !Number.isFinite(n) ? "-" : Number(n.toFixed(d)).toString());
export const pct = (f: number | null | undefined, d = 2) => (f === null || f === undefined || !Number.isFinite(f) ? "-" : `${(f * 100).toFixed(d)}%`);

export function compactUsd(n: number): string {
  if (!Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function table(headers: string[], rows: (string | number)[][]): string {
  const cells = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
  return cells.map((r) => r.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}
