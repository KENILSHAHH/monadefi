"use client";

import { AlertTriangle, Check, ExternalLink, Loader2, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { post, usd, type Intent } from "@/lib/api";

const TITLES: Record<string, string> = {
  perpl: "Perpl",
  job_create: "Scheduled job",
  bridge: "Bridge",
  evm_transactions: "Sign transactions",
};

/** The title of a Perpl card, by the kind of action. */
const PERPL_TITLES: Record<string, string> = {
  open: "Open position", close: "Close position", cancel: "Cancel order", modify: "Change order", margin: "Change margin", deposit: "Deposit to Perpl", withdraw: "Withdraw from Perpl",
};

const num = (v: unknown, d = 2) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: d }) : String(v ?? "—"));

/** Label and value rows for each kind of preview. Every number comes from the server preview. */
function rows(intent: Intent): [string, string][] {
  const p = intent.preview;
  switch (intent.kind) {
    case "perpl":
      if (p.estEntryPx !== undefined)
        return [
          ["Market", `${p.market} on Perpl (Monad)`],
          ["Side", `${String(p.side).toUpperCase()} ${p.leverage}x · ${p.orderType === "limit" ? "limit order" : "market order"}`],
          ["Margin", usd(p.marginUsd)],
          ["Size", `${p.size} ${p.market} (${usd(p.notionalUsd)})`],
          [p.orderType === "limit" ? "Limit price" : "Est. entry", num(p.orderType === "limit" ? p.limitPx : p.estEntryPx, 6)],
          ...(p.orderType === "limit" ? [] : [["Worst price", num(p.limitPx, 6)] as [string, string]]),
          ["Est. liquidation", `${num(p.estLiquidationPx, 6)} (${num(p.distanceToLiquidationPct, 1)}% away)`],
          ["Exchange fee", usd(p.estFeeUsd)],
          ...(p.depositFromWalletAusd ? [["Deposit to Perpl", `${num(p.depositFromWalletAusd)} AUSD from your wallet`] as [string, string]] : []),
          ["Stop loss", p.stopLossPx ? num(p.stopLossPx, 6) : "None"],
          ...(p.takeProfitPx ? [["Take profit", num(p.takeProfitPx, 6)] as [string, string]] : []),
        ];
      if (p.closeSize !== undefined)
        return [["Market", `${p.market} ${p.side}`], ["Close size", num(p.closeSize, 6)], ["Mark", num(p.markPx, 6)], ["Profit or loss now", usd(p.unrealizedPnl)], ["Order", p.orderType]];
      return Object.entries(p).filter(([k, v]) => typeof v !== "object" && !["venue", "chain", "marketId"].includes(k)).map(([k, v]) => [k, typeof v === "number" ? num(v, 6) : String(v)]);
    case "bridge":
      return [
        ["From", `${p.from.amount} ${p.from.token} on ${p.from.chain}`],
        ["To", `${num(p.to.amount, 4)} ${p.to.token} on ${p.to.chain}`],
        ["Fee", usd(p.totalFeeUsd)],
        ["ETA", p.etaSeconds ? `${p.etaSeconds} s` : "—"],
        ["Route", p.provider],
      ];
    case "evm_transactions":
      return [["Chain", p.chain], ["What it does", p.summary], ["Simulation", p.simulation?.method ?? "—"]];
    default:
      return Object.entries(p).filter(([, v]) => typeof v !== "object").map(([k, v]) => [k, String(v)]);
  }
}

export function IntentCard({ intent: initial }: { intent: Intent }) {
  const [local, setLocal] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The stream can deliver a newer state of the same intent. The newest state wins.
  const intent = local && local.status !== "pending" ? local : initial.status !== "pending" ? initial : (local ?? initial);

  const p = intent.preview;
  const guard = p.guard as Record<string, any> | null | undefined;
  const warnings: string[] = p.warnings ?? [];
  const txs: { chainId: number; to: string | null; data: string; value: string; description: string }[] = p.transactions ?? [];
  const step = "The agent wallet signs and sends. This can take a minute.";

  async function decide(action: "confirm" | "reject") {
    setError(null);
    setBusy(true);
    try {
      setLocal(await post<Intent>(`/intents/${intent.id}/${action}`));
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0]! : "The action failed");
    } finally {
      setBusy(false);
    }
  }
  const confirm = () => decide("confirm");
  const reject = () => decide("reject");

  const result = intent.result;

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-accent">{p.venue ?? "Action"}</span>
          {intent.kind === "perpl" ? PERPL_TITLES[intent.params?.op?.op as string] ?? "Perpl" : TITLES[intent.kind] ?? intent.kind}
        </div>
        <StatusPill status={intent.status} />
      </div>

      <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-6 gap-y-1.5 px-4 py-3 text-[13.5px]">
        {rows(intent).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-dim">{k}</dt>
            <dd className="font-mono text-[13px] tabular-nums break-words">{v}</dd>
          </div>
        ))}
      </dl>

      {txs.length > 0 && (
        <ol className="mx-4 mb-3 space-y-1 rounded-lg border border-line bg-raised px-3 py-2 text-[13px]">
          {txs.map((t, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-faint">{i + 1}.</span>
              <span className="flex-1">{t.description}</span>
              <span className="font-mono text-[11.5px] text-faint">{t.to ? `${t.to.slice(0, 8)}…` : "new contract"}</span>
            </li>
          ))}
        </ol>
      )}

      {guard && (
        <div className="mx-4 mb-3 flex gap-2.5 rounded-lg border border-line bg-raised px-3 py-2.5 text-[13px]">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-good" />
          <div>
            <div className="font-medium">
              Liquidation Guard:{" "}
              {`act at ${num(guard.triggerPx)} (${guard.triggerDistancePct}% before liquidation), ${String(guard.action).replaceAll("_", " ")}`}
            </div>
            <div className="mt-0.5 text-dim">
              {usd(guard.pricePerMinuteUsd, 3)} per watched minute. {guard.disclosure}
            </div>
          </div>
        </div>
      )}

      {warnings.map((w) => (
        <div key={w} className="mx-4 mb-2 flex gap-2 text-[13px] text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{w}</span>
        </div>
      ))}

      {Array.isArray(p.sources) && (
        <div className="mx-4 mb-3 text-[12px] text-faint">
          Sources:{" "}
          {p.sources.map((s: string, i: number) => (
            <span key={s}>
              {i > 0 && ", "}
              {s.startsWith("http") ? <a className="underline" href={s} target="_blank" rel="noreferrer">{new URL(s).hostname}</a> : s}
            </span>
          ))}
        </div>
      )}

      {intent.status === "pending" && (
        <div className="flex items-center justify-between gap-3 border-t border-line bg-raised px-4 py-2.5">
          <div className="text-[12.5px] text-dim">
            {busy ? step : <>Action fee {usd(intent.feeUsd)} · the agent wallet signs</>}
          </div>
          <div className="flex gap-2">
            <button onClick={reject} disabled={busy} className="rounded-lg border border-line px-3 py-1.5 text-sm text-dim hover:text-ink disabled:opacity-40">
              Reject
            </button>
            <button onClick={confirm} disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-60">
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              Confirm
            </button>
          </div>
        </div>
      )}


      {result && intent.status === "done" && (
        <div className="border-t border-line bg-raised px-4 py-2.5 text-[13px]">
          {result.avgFillPx && <div>Filled {num(result.filledSize, 6)} at {num(result.avgFillPx, 6)}. {result.positionAfter?.liquidationPx ? `Liquidation price ${num(result.positionAfter.liquidationPx, 6)}.` : ""} {result.guardId ? "Guard is active." : ""}</div>}
          {result.restingOrderIds && <div>Order {result.restingOrderIds.join(", ")} rests on the Perpl book.</div>}
          {result.exitJobs && <div>{result.exitJobs.map((j: any) => `${j.kind === "stop_loss" ? "Stop-loss" : "Take-profit"}: ${j.fires}`).join(" · ")}</div>}
          {result.skipped && <div>{result.skipped}</div>}
          {result.closedSize !== undefined && <div>Closed {num(result.closedSize, 4)}. Remaining {num(result.remainingSize, 4)}.</div>}
          {result.orderId && <a href={result.explorer} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-mono text-[12px] text-accent">Order {result.orderId} <ExternalLink className="size-3" /></a>}
          {result.guardId && !result.avgFillPx && <div>Guard is active. Id {String(result.guardId).slice(0, 8)}.</div>}
          {(result.receipts ?? []).map((r: any) => (
            <a key={r.hash} href={r.explorer} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-mono text-[12px] text-accent">
              {r.description}: {r.hash.slice(0, 14)}… <ExternalLink className="size-3" />
              {r.contractAddress && <span className="text-dim">→ contract {r.contractAddress}</span>}
            </a>
          ))}
        </div>
      )}
      {(error || (intent.status === "failed" && result?.error)) && (
        <div className="border-t border-line bg-raised px-4 py-2.5 text-[13px] text-bad">{error ?? result?.error}</div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: Intent["status"] }) {
  const map: Record<string, [string, string, React.ReactNode]> = {
    pending: ["Needs your confirmation", "text-warn", null],
    confirmed: ["Waiting for signature", "text-warn", <Loader2 key="i" className="size-3 animate-spin" />],
    executing: ["Executing", "text-warn", <Loader2 key="i" className="size-3 animate-spin" />],
    done: ["Done", "text-good", <Check key="i" className="size-3" />],
    failed: ["Failed", "text-bad", <X key="i" className="size-3" />],
    rejected: ["Rejected", "text-faint", <X key="i" className="size-3" />],
    expired: ["Expired", "text-faint", null],
  };
  const [label, color, icon] = map[status] ?? [status, "text-dim", null];
  return <span className={`flex items-center gap-1 text-[12px] ${color}`}>{icon}{label}</span>;
}
