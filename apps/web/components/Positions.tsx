"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api, short, usd, type Positions } from "@/lib/api";

const n = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: d }));

/** The local logo of Monad. Other chains use the LI.FI logo. */
const CHAIN_LOGO: Record<number, string> = { 143: "/icons/chain-monad.svg" };

/** A token or venue logo with a small chain logo at its corner. A missing logo shows the first letter. */
function Logo({ src, label, chain }: { src: string | null; label: string; chain?: string | null }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="relative size-8 shrink-0">
      {src && !broken ? (
        <img src={src} alt="" onError={() => setBroken(true)} className="size-8 rounded-full bg-raised object-cover" />
      ) : (
        <span className="grid size-8 place-items-center rounded-full bg-raised text-[12px] font-bold text-dim">{label.slice(0, 1)}</span>
      )}
      {chain && <img src={chain} alt="" className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full border border-panel bg-panel" />}
    </span>
  );
}

function Row({ logo, title, sub, value, valueSub, valueClass = "" }: { logo: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; value: React.ReactNode; valueSub?: React.ReactNode; valueClass?: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      {logo}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-[13.5px] font-semibold">{title}</div>
        {sub && <div className="truncate text-[11.5px] text-faint">{sub}</div>}
      </div>
      <div className="shrink-0 text-right">
        <div className={`font-mono text-[13px] tabular-nums ${valueClass}`}>{value}</div>
        {valueSub && <div className="font-mono text-[11px] tabular-nums text-faint">{valueSub}</div>}
      </div>
    </div>
  );
}

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="text-[12px] font-medium uppercase tracking-wider text-faint">{title}</h2>
        {right && <span className="font-mono text-[12px] tabular-nums text-dim">{right}</span>}
      </div>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">{children}</div>
    </section>
  );
}

const Pill = ({ children, tone }: { children: React.ReactNode; tone: "good" | "bad" | "warn" | "dim" }) => (
  <span className={`rounded-md px-1.5 py-px text-[10.5px] font-semibold ${{ good: "bg-good/15 text-good", bad: "bg-bad/15 text-bad", warn: "bg-warn/15 text-warn", dim: "bg-raised text-dim" }[tone]}`}>{children}</span>
);

export function PositionsView() {
  const { data, isLoading, isFetching, refetch, error } = useQuery({ queryKey: ["positions"], queryFn: () => api<Positions>("/positions"), refetchInterval: 15_000 });

  if (isLoading) return <p className="p-8 text-sm text-faint">Reading your account from the chains…</p>;
  if (error || !data) return <p className="p-8 text-sm text-bad">{(error as Error)?.message ?? "Could not load the account."}</p>;

  const pp = data.perpl;
  const assets = data.assets ?? [];
  const walletUsd = assets.reduce((s, a) => s + (a.usd ?? 0), 0);
  // The account balance plus the margin and the profit or loss of each position.
  const perplUsd = pp.balanceUsd + pp.positions.reduce((s, p) => s + p.marginUsd + p.unrealizedPnl, 0);
  const total = walletUsd + perplUsd;
  const guarded = (market: string) => data.guards.some((g) => g.venue === "perpl" && g.params.market === market);
  const positionCount = pp.positions.length;

  return (
    <div className="mx-auto w-full max-w-[720px] px-4 py-7 sm:px-6">
      <div className="mb-6 flex items-end justify-between gap-3">
        <div>
          <p className="text-[12px] font-medium uppercase tracking-wider text-faint">Total value</p>
          <p className="mt-1 font-mono text-3xl font-bold tabular-nums tracking-tight">{usd(total)}</p>
          <div className="mt-2 flex flex-wrap gap-3 text-[12px] text-dim">
            <span className="flex items-center gap-1.5"><img src="/icons/eth.png" alt="" className="size-3.5 rounded-full" /> Wallet {usd(walletUsd)}</span>
            <span className="flex items-center gap-1.5"><img src="/icons/perpl.svg" alt="" className="size-3.5 rounded-full" /> Perpl {usd(perplUsd)}</span>
          </div>
        </div>
        <button onClick={() => refetch()} title="Refresh" aria-label="Refresh" className="grid size-9 place-items-center rounded-lg border border-line text-dim hover:text-ink">
          <RefreshCw className={`size-3.5 ${isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>

      {(data.errors.length > 0 || data.assets === null) && (
        <div className="mb-4 flex gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div>Some sources did not answer, so this view can be incomplete. {[...data.errors, ...(data.assets === null ? ["wallet tokens"] : [])].join("; ")}</div>
        </div>
      )}

      <Card title="Positions" right={positionCount ? `${positionCount} open` : undefined}>
        {positionCount === 0 && <p className="px-4 py-3.5 text-[13px] text-faint">No open position. Ask the agent to open one.</p>}
        {pp.positions.map((p) => {
          const long = p.side === "long";
          const near = p.distanceToLiquidation !== null && p.distanceToLiquidation < 0.08;
          return (
            <Row
              key={`perpl-${p.marketId}`}
              logo={<Logo src="/icons/perpl.svg" label="P" chain={CHAIN_LOGO[143]} />}
              title={<>{p.market} <Pill tone={long ? "good" : "bad"}>{long ? "Long" : "Short"} {n(p.leverage, 1)}x</Pill>{guarded(p.market) && <ShieldCheck className="size-3.5 text-good" />}</>}
              sub={<>Entry {n(p.entryPx)} · Liq {n(p.liquidationPx)}{p.distanceToLiquidation !== null && <span className={near ? "text-warn" : ""}> ({(p.distanceToLiquidation * 100).toFixed(0)}% away)</span>}</>}
              value={`${p.unrealizedPnl >= 0 ? "+" : ""}${usd(p.unrealizedPnl)}`}
              valueClass={p.unrealizedPnl >= 0 ? "text-good" : "text-bad"}
              valueSub={usd(p.notionalUsd)}
            />
          );
        })}
        {pp.accountId !== null && pp.balanceUsd >= 0.01 && (
          <Row
            key="perpl-account"
            logo={<Logo src="/icons/perpl.svg" label="P" chain={CHAIN_LOGO[143]} />}
            title={<>Perpl <span className="font-normal text-faint">cash</span></>}
            sub={`Free ${usd(pp.freeUsd)} · Held by orders ${usd(pp.lockedUsd)}`}
            value={usd(pp.balanceUsd)}
          />
        )}
      </Card>

      <Card title="Wallet" right={usd(walletUsd)}>
        {assets.length === 0 && (
          <p className="px-4 py-3.5 text-[13px] text-faint">No tokens yet. Send USDC, MON or AUSD to <span className="select-all font-mono text-dim">{short(data.address)}</span> on Monad.</p>
        )}
        {assets.map((a) => (
          <Row
            key={`${a.chainId}-${a.token}`}
            logo={<Logo src={a.logo} label={a.symbol} chain={CHAIN_LOGO[a.chainId] ?? a.chainLogo} />}
            title={a.symbol}
            sub={a.chainName}
            value={a.usd === null ? "—" : usd(a.usd)}
            valueSub={n(a.amount, a.amount < 1 ? 6 : 4)}
          />
        ))}
      </Card>

      <Card title="Guards" right={data.guards.length ? `${data.guards.length} active` : undefined}>
        {data.guards.length === 0 && <p className="px-4 py-3.5 text-[13px] text-faint">No guards. Ask the agent to protect a Perpl position from liquidation.</p>}
        {data.guards.map((g) => (
          <Row
            key={g.id}
            logo={<Logo src="/icons/perpl.svg" label="P" chain={CHAIN_LOGO[143]} />}
            title={<>{g.params.market ?? "Perpl"} <Pill tone={g.status === "triggered" ? "warn" : "good"}>{g.status === "triggered" ? "Triggered" : "Active"}</Pill></>}
            sub={`Acts at ${g.params.triggerDistancePct ?? "—"}% to liquidation`}
            value={g.lastValue === null ? "—" : `${g.lastValue.toFixed(1)}%`}
            valueSub="to liquidation"
          />
        ))}
      </Card>
    </div>
  );
}
