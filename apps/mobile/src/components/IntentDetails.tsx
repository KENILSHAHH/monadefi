import { StyleSheet, Text, View } from "react-native";
import type { Intent, IntentResult } from "@/lib/api/types";
import { num, price, usd } from "@/lib/format";
import { colors, space, type } from "@/theme";
import { KeyValue, LinkText, Notice, Pill } from "./ui";

const n = (v: unknown) => (typeof v === "number" ? v : undefined);
const s = (v: unknown) => (v === undefined || v === null ? "—" : String(v));

const PERPL_TITLES: Record<string, string> = {
  open: "Open position", close: "Close position", cancel: "Cancel order", modify: "Change order",
  margin: "Change margin", deposit: "Deposit to Perpl", withdraw: "Withdraw from Perpl",
};

export function intentTitle(intent: Intent): string {
  if (intent.kind !== "perpl") return intent.kind.replace(/_/g, " ");
  const op = (intent.params?.op as { op?: string } | undefined)?.op;
  return (op && PERPL_TITLES[op]) ?? "Perpl order";
}

/** Label and value rows for a preview. Every number comes from the server. Same rules as the web IntentCard. */
export function previewRows(intent: Intent): [string, string][] {
  const p = intent.preview;
  if (intent.kind === "perpl" && p.estEntryPx !== undefined) {
    const limit = p.orderType === "limit";
    const rows: [string, string][] = [
      ["Market", `${s(p.market)} on Perpl (Monad)`],
      ["Side", `${s(p.side).toUpperCase()} ${s(p.leverage)}x · ${limit ? "limit order" : "market order"}`],
      ["Margin", usd(n(p.marginUsd))],
      ["Size", `${num(n(p.size), 6)} ${s(p.market)} (${usd(n(p.notionalUsd))})`],
      [limit ? "Limit price" : "Est. entry", price(n(limit ? p.limitPx : p.estEntryPx))],
    ];
    if (!limit) rows.push(["Worst price", price(n(p.limitPx))]);
    rows.push(["Est. liquidation", `${price(n(p.estLiquidationPx))} (${num(n(p.distanceToLiquidationPct), 1)}% away)`]);
    rows.push(["Exchange fee", usd(n(p.estFeeUsd))]);
    if (n(p.depositFromWalletAusd)) rows.push(["Moves to Perpl", `${num(n(p.depositFromWalletAusd))} AUSD from your wallet`]);
    rows.push(["Stop-loss", n(p.stopLossPx) ? price(n(p.stopLossPx)) : "None"]);
    if (n(p.takeProfitPx)) rows.push(["Take-profit", price(n(p.takeProfitPx))]);
    return rows;
  }
  if (intent.kind === "perpl" && p.closeSize !== undefined) {
    return [
      ["Market", `${s(p.market)} ${s(p.side)}`],
      ["Close size", num(n(p.closeSize), 6)],
      ["Mark", price(n(p.markPx))],
      ["Profit or loss now", usd(n(p.unrealizedPnl))],
      ["Order", s(p.orderType)],
    ];
  }
  return Object.entries(p)
    .filter(([k, v]) => v !== null && typeof v !== "object" && !["venue", "chain", "marketId"].includes(k))
    .map(([k, v]) => [k, typeof v === "number" ? num(v, 6) : String(v)]);
}

export function IntentRows({ intent }: { intent: Intent }) {
  const warnings = Array.isArray(intent.preview.warnings) ? (intent.preview.warnings as string[]) : [];
  return (
    <View>
      {previewRows(intent).map(([k, v]) => (
        <KeyValue key={k} label={k} value={v} />
      ))}
      {warnings.map((w) => (
        <View key={w} style={styles.gap}>
          <Notice>{w}</Notice>
        </View>
      ))}
    </View>
  );
}

export function StatusPill({ status }: { status: Intent["status"] }) {
  const map: Record<Intent["status"], [string, "warn" | "good" | "bad" | "dim"]> = {
    pending: ["Needs your confirmation", "warn"],
    confirmed: ["Sending", "warn"],
    executing: ["Executing", "warn"],
    done: ["Done", "good"],
    failed: ["Failed", "bad"],
    rejected: ["Rejected", "dim"],
    expired: ["Expired", "dim"],
  };
  const [label, tone] = map[status] ?? [status, "dim"];
  return <Pill label={label} tone={tone} />;
}

/** The first explorer link of a result: the Monadscan page of the trade. */
export function resultLink(r: IntentResult | null): string | null {
  if (!r) return null;
  return r.receipts?.find((x) => x.explorer)?.explorer ?? (typeof r.explorer === "string" ? r.explorer : null);
}

export function IntentResultView({ intent }: { intent: Intent }) {
  const r = intent.result;
  if (intent.status === "failed") return <Notice tone="bad">{r?.error ?? "The order failed. No funds moved."}</Notice>;
  if (!r || intent.status !== "done") return null;
  return (
    <View style={styles.result}>
      {r.avgFillPx !== undefined && (
        <Text style={type.body}>
          Filled {num(r.filledSize, 6)} at {price(r.avgFillPx)}.{r.positionAfter?.liquidationPx ? ` Liquidation price ${price(r.positionAfter.liquidationPx)}.` : ""}
        </Text>
      )}
      {r.restingOrderIds && <Text style={type.body}>Order {r.restingOrderIds.join(", ")} rests on the Perpl book.</Text>}
      {r.closedSize !== undefined && <Text style={type.body}>Closed {num(r.closedSize, 4)}. Left {num(r.remainingSize, 4)}.</Text>}
      {r.exitJobs?.map((j) => (
        <Text key={j.kind} style={type.small}>
          {j.kind === "stop_loss" ? "Stop-loss" : "Take-profit"}: {j.fires}
        </Text>
      ))}
      {r.skipped && <Text style={type.small}>{r.skipped}</Text>}
      {(r.receipts ?? []).map((x) => (
        <LinkText key={x.hash} url={x.explorer} label={`${x.description ?? "Transaction"} on Monadscan`} />
      ))}
      {!r.receipts?.length && typeof r.explorer === "string" && <LinkText url={r.explorer} label="View on Monadscan" />}
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { marginTop: space.sm },
  result: { gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingTop: space.md, marginTop: space.sm },
});
