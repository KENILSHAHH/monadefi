const root = new URL("../src", import.meta.url).pathname;
const perpl = await import(`${root}/adapters/perpl.ts`);
const relay = await import(`${root}/adapters/relay.ts`);
const t = async (name: string, f: () => Promise<unknown>) => {
  try { console.log(`\n== ${name}\n`, JSON.stringify(await f(), null, 1).slice(0, 1400)); }
  catch (e) { console.log(`\n== ${name} FAILED\n`, String(e).slice(0, 600)); }
};
await t("perpl markets", async () => (await perpl.findMarkets()).map((m: any) => [m.id, m.symbol, m.markPx, m.maxLeverage, Math.round(m.dayVolumeUsd)]));
await t("perpl preview", async () => { const p = await perpl.previewOpen({ market: "BTC", isLong: true, marginUsd: 20, leverage: 5 }); return { ...p, market: p.market.symbol, lotLNS: p.lotLNS.toString() }; });
await t("perpl book", () => perpl.getBook("ETH", 3));
await t("relay base->monad", async () => { const q = await relay.quoteBridge({ fromChain: "base", toChain: "monad", fromToken: "USDC", toToken: "USDC", amount: 1000 }); return { ...q, steps: q.steps.map((s: any) => [s.id, s.kind, s.description]) }; });
