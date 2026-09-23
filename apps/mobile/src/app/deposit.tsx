import Ionicons from "@expo/vector-icons/Ionicons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { AddressQr } from "@/components/AddressQr";
import { Button, Card, Chip, CopyButton, ErrorState, KeyValue, LinkText, Notice, Screen, Segmented, SkeletonRows, haptic } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import type { AuroraChain, AuroraDeposit } from "@/lib/api/types";
import { useAddress } from "@/lib/auth/AuthProvider";
import { txUrl } from "@/lib/config";
import { depositPhase, isFinal, shouldPoll, type DepositPhase } from "@/lib/deposit";
import { eta, fixed, parseAmount } from "@/lib/format";
import { keys, useBalance } from "@/lib/queries";
import { signMessage, signTypedPayload } from "@/lib/wallet";
import { colors, radius, space, type } from "@/theme";

export default function Deposit() {
  const [tab, setTab] = useState<"monad" | "any">("monad");
  return (
    <Screen edges={["bottom"]}>
      <Segmented value={tab} onChange={setTab} options={[{ value: "monad", label: "Monad" }, { value: "any", label: "Any chain" }]} />
      {tab === "monad" ? <MonadTab /> : <AnyChainTab />}
    </Screen>
  );
}

function MonadTab() {
  const address = useAddress();
  // Polls while the screen is open, so a transfer shows within seconds.
  const balance = useBalance(5_000);
  const start = useRef<number | null>(null);
  const total = balance.data ? balance.data.ausd.wallet + balance.data.usdc : null;
  if (start.current === null && total !== null) start.current = total;
  const received = start.current !== null && total !== null && total - start.current >= 0.01 ? total - start.current : null;

  useEffect(() => {
    if (received) haptic.success();
  }, [received]);

  return (
    <>
      <Card>
        <AddressQr value={address} caption="Send AUSD, USDC or MON on Monad (chain 143) to your Mona-DeFi address." />
      </Card>
      {received !== null ? (
        <Notice tone="good">Received {fixed(received, 2)}. It is in your wallet now.</Notice>
      ) : (
        <Notice tone="accent" icon="time-outline">Waiting for a transfer. This screen updates by itself.</Notice>
      )}
      <Card>
        <KeyValue label="AUSD in wallet" value={balance.data ? fixed(balance.data.ausd.wallet, 2) : "—"} />
        <KeyValue label="USDC in wallet" value={balance.data ? fixed(balance.data.usdc, 2) : "—"} />
        <KeyValue label="MON in wallet" value={balance.data ? fixed(balance.data.mon, 4) : "—"} />
        <Text style={[type.tiny, styles.top]}>Perpl takes AUSD only. Send AUSD to trade at once. Only send on Monad: other networks use the Any chain tab.</Text>
      </Card>
      {balance.error && <Notice>{errorMessage(balance.error)}</Notice>}
    </>
  );
}


function AnyChainTab() {
  const address = useAddress();
  const assets = useQuery({ queryKey: keys.depositAssets, queryFn: api.deposit.assets, staleTime: 5 * 60_000 });
  const [chainKey, setChainKey] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [amountText, setAmountText] = useState("");
  const [refundText, setRefundText] = useState("");
  const [toPerpl, setToPerpl] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deposit, setDeposit] = useState<AuroraDeposit | null>(null);

  const chains: AuroraChain[] = assets.data ?? [];
  const chain = chains.find((c) => c.chain === chainKey) ?? chains[0];
  const token = chain?.tokens.find((t) => t.assetId === assetId) ?? chain?.tokens[0];
  const amount = parseAmount(amountText);
  const refundTo = refundText.trim() || (chain?.evm ? address : "");

  // A dry quote for the preview, once the amount stops changing.
  const [quoteKey, setQuoteKey] = useState<string | null>(null);
  useEffect(() => {
    if (!token || !amount) return setQuoteKey(null);
    const t = setTimeout(() => setQuoteKey(`${token.assetId}|${amount}`), 600);
    return () => clearTimeout(t);
  }, [token, amount]);
  const quote = useQuery({
    queryKey: ["deposit-quote", quoteKey],
    queryFn: () => api.deposit.quote(token!.assetId, String(amount)),
    enabled: quoteKey !== null && Boolean(token && amount),
    staleTime: 30_000,
  });

  async function create() {
    if (!token || !amount) return;
    setError(null);
    setCreating(true);
    try {
      const d = await api.deposit.create({ assetId: token.assetId, amount: String(amount), refundTo, ...(toPerpl ? { after: { type: "perpl_deposit" as const } } : {}) });
      haptic.success();
      setDeposit(d);
    } catch (e) {
      haptic.error();
      setError(errorMessage(e, "The deposit could not be created."));
    } finally {
      setCreating(false);
    }
  }

  if (deposit) return <DepositProgress initial={deposit} onDone={() => setDeposit(null)} />;
  if (assets.isLoading) return <SkeletonRows rows={3} />;
  if (assets.error) return <ErrorState message={errorMessage(assets.error)} onRetry={() => void assets.refetch()} />;
  if (!chain || !token) return <Notice>No source chain is available for deposits now.</Notice>;

  return (
    <>
      <Text style={type.small}>Aurora Intents brings funds from another chain to your Mona-DeFi wallet on Monad as AUSD.</Text>
      <Card style={styles.gap}>
        <Text style={type.label}>From chain</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {chains.map((c) => (
            <Chip key={c.chain} label={c.name} active={c.chain === chain.chain} onPress={() => { setChainKey(c.chain); setAssetId(null); setRefundText(""); }} />
          ))}
        </ScrollView>
        <Text style={type.tiny}>
          {chain.connect ? "AUSD arrives directly. You sign one message on this phone, with no prompt." : "USDC arrives first. Then you sign a swap to AUSD on this phone, with no prompt and no gas."}
        </Text>
        <Text style={[type.label, styles.top]}>Asset</Text>
        <View style={styles.wrapChips}>
          {chain.tokens.slice(0, 12).map((t) => (
            <Chip key={t.assetId} label={t.symbol} active={t.assetId === token.assetId} onPress={() => setAssetId(t.assetId)} />
          ))}
        </View>
        <Text style={[type.label, styles.top]}>Amount</Text>
        <TextInput value={amountText} onChangeText={setAmountText} keyboardType="decimal-pad" placeholder={`Amount of ${token.symbol}`} placeholderTextColor={colors.faint} style={styles.input} accessibilityLabel="Amount" />
        {quote.data && (
          <Text style={type.small}>
            You get about {quote.data.quote.amountOutFormatted} on Monad · {eta(quote.data.quote.timeEstimate)}
          </Text>
        )}
        {quote.error && <Text style={[type.tiny, { color: colors.warn }]}>{errorMessage(quote.error)}</Text>}
        <Text style={[type.label, styles.top]}>Refund address on {chain.name}</Text>
        <TextInput value={refundText} onChangeText={setRefundText} placeholder={chain.evm ? `Your Mona-DeFi address (${address.slice(0, 8)}…)` : `Your ${chain.name} address`} placeholderTextColor={colors.faint} style={styles.input} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Refund address" />
        <Text style={type.tiny}>If the deposit cannot complete, Aurora sends the funds back here.</Text>
        <View style={[styles.toggle, styles.top]}>
          <View style={styles.flex}>
            <Text style={type.body}>Move to Perpl when it arrives</Text>
            <Text style={type.tiny}>Needs trading turned on.</Text>
          </View>
          <Switch value={toPerpl} onValueChange={setToPerpl} trackColor={{ true: colors.accent, false: colors.line }} accessibilityLabel="Move to Perpl when it arrives" />
        </View>
      </Card>
      {error && <Notice tone="bad">{error}</Notice>}
      <Button title={chain.connect ? "Sign and get deposit address" : "Get deposit address"} icon="qr-code-outline" loading={creating} disabled={!amount || !refundTo} onPress={() => void create()} />
    </>
  );
}

const PHASE_TEXT: Record<DepositPhase, string> = {
  sign: "Sign the deposit order on this phone.",
  send: "Send the funds to the address below.",
  wait: "Aurora is moving your funds. This screen updates by itself.",
  convert: "USDC arrived on Monad. Convert it to AUSD to trade.",
  session: "AUSD arrived. Turn on trading so Mona-DeFi can move it into Perpl.",
  done: "Done. Your AUSD is ready to trade.",
  refunded: "Aurora refunded the deposit.",
  failed: "The deposit did not complete.",
};

function DepositProgress({ initial, onDone }: { initial: AuroraDeposit; onDone: () => void }) {
  const qc = useQueryClient();
  const [local, setLocal] = useState<AuroraDeposit>(initial);
  const [busy, setBusy] = useState<"sign" | "convert" | "refresh" | "tx" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState("");
  const [convertLink, setConvertLink] = useState<string | null>(null);
  const autoSigned = useRef(false);

  // GET /deposit/aurora/:id every 5 s while Aurora or Mona-DeFi can still move it.
  const live = useQuery({
    queryKey: ["deposit", initial.id],
    queryFn: () => api.deposit.get(initial.id),
    initialData: initial,
    refetchInterval: (q) => (q.state.data && shouldPoll(depositPhase(q.state.data)) ? 5_000 : false),
  });
  const d = live.data ?? local;
  const phase = depositPhase(d);

  useEffect(() => {
    if (isFinal(phase)) {
      if (phase === "done") haptic.success();
      void qc.invalidateQueries({ queryKey: keys.balance });
    }
  }, [phase, qc]);

  const act = async (kind: "sign" | "convert" | "refresh" | "tx", fn: () => Promise<AuroraDeposit>) => {
    setBusy(kind);
    setError(null);
    try {
      const next = await fn();
      setLocal(next);
      qc.setQueryData(["deposit", initial.id], next);
    } catch (e) {
      haptic.error();
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // Connect: personal_sign of payload_json, verbatim. The key is in memory: no prompt.
  const sign = () =>
    act("sign", async () => {
      if (!d.signPayload) throw new Error("This deposit has nothing to sign.");
      return api.deposit.signature(d.id, await signMessage(d.signPayload.payload_json));
    });

  // Swap: the server prepares the Curve swap as a one-time relay; the phone signs it; the server moves on.
  const convert = () =>
    act("convert", async () => {
      const prepared = await api.deposit.convert(d.id);
      const sent = await api.relay.send(prepared.id, await signTypedPayload(prepared.typedData));
      if (sent.status !== "success") throw new Error("The swap reverted on Monad. Your USDC is still in the wallet.");
      setConvertLink(sent.explorer);
      return api.deposit.converted(d.id);
    });

  useEffect(() => {
    if (phase === "sign" && !autoSigned.current) {
      autoSigned.current = true;
      void sign();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const tone = phase === "done" ? "good" : phase === "failed" || phase === "refunded" ? "bad" : "accent";

  return (
    <>
      <Card style={styles.gap}>
        <Notice tone={tone} icon={isFinal(phase) ? undefined : "sync"}>
          {PHASE_TEXT[phase]}
          {d.error ? ` ${d.error}` : ""}
          {phase === "failed" && d.afterResult?.error ? ` ${d.afterResult.error}` : ""}
        </Notice>
        {d.steps.map((s, i) => (
          <View key={`${i}-${s.label}`} style={styles.step}>
            <View style={[styles.stepDot, s.done && styles.stepDone]}>{s.done && <Ionicons name="checkmark" size={12} color="#06110B" />}</View>
            <Text style={[type.body, !s.done && { color: colors.dim }]}>{s.label}</Text>
          </View>
        ))}
      </Card>

      {phase === "sign" && <Button title="Sign the deposit order" icon="create-outline" loading={busy === "sign"} onPress={() => void sign()} />}

      {phase === "send" && d.depositAddress && (
        <Card style={styles.gap}>
          <AddressQr value={d.depositAddress} caption={`Send ${d.amountIn ? `${d.amountIn} ` : ""}on ${d.originChain} to this address.`} />
          {d.depositMemo ? (
            <View style={styles.memo}>
              <Notice tone="warn">Add this memo to the transfer. Without it the deposit cannot be matched.</Notice>
              <Text style={[type.mono, styles.center]} selectable>
                {d.depositMemo}
              </Text>
              <CopyButton value={d.depositMemo} label="Copy memo" />
            </View>
          ) : null}
          {d.deadline && <KeyValue label="Send before" value={new Date(d.deadline).toLocaleTimeString()} />}
          <Text style={[type.label, styles.top]}>Already sent? (optional)</Text>
          <TextInput value={txHash} onChangeText={setTxHash} placeholder="Source transaction hash" placeholderTextColor={colors.faint} style={styles.input} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Source transaction hash" />
          <Button compact variant="secondary" title="Tell Aurora" loading={busy === "tx"} disabled={txHash.trim().length < 10} onPress={() => void act("tx", () => api.deposit.tx(d.id, txHash.trim()))} />
        </Card>
      )}

      {phase === "convert" && (
        <Card style={styles.gap}>
          <Text style={type.h2}>Convert {d.nextStep?.kind === "needs_conversion" ? `${fixed(d.nextStep.usdc, 2)} USDC` : "USDC"} to AUSD</Text>
          <Text style={type.small}>A Curve swap on Monad, signed on this phone for these exact calls only. No prompt, no gas.</Text>
          <Button title="Convert to AUSD" icon="swap-horizontal" loading={busy === "convert"} onPress={() => void convert()} />
        </Card>
      )}
      {convertLink && <LinkText url={convertLink} label="Swap on Monadscan" />}

      {phase === "session" && <Button title="Turn on trading" icon="key-outline" onPress={() => router.push("/session")} />}

      {phase === "refunded" && (
        <Card>
          <KeyValue label="Refunded" value={d.refundAmount ?? "—"} />
          {d.refundReason && <Text style={type.small}>{d.refundReason}</Text>}
        </Card>
      )}

      {d.settledTx && <LinkText url={d.settledTx.startsWith("http") ? d.settledTx : txUrl(d.settledTx)} label="Arrival on Monadscan" />}
      {d.refundTx && <Text style={[type.mono, { color: colors.dim }]} selectable>Refund tx {d.refundTx}</Text>}
      {error && <Notice tone="bad">{error}</Notice>}

      {!isFinal(phase) && <Button compact variant="ghost" icon="refresh" title="Check now" loading={busy === "refresh"} onPress={() => void act("refresh", () => api.deposit.refresh(d.id))} />}
      <Button title={isFinal(phase) ? "Done" : "Start another deposit"} variant="secondary" onPress={onDone} />
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap: { gap: space.sm },
  top: { marginTop: space.md },
  center: { textAlign: "center" },
  chips: { gap: space.sm },
  wrapChips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  input: { backgroundColor: colors.raised, borderRadius: radius.md, color: colors.ink, paddingHorizontal: space.md, height: 46, fontSize: 16 },
  memo: { gap: space.sm, alignItems: "center", alignSelf: "stretch" },
  toggle: { flexDirection: "row", alignItems: "center", gap: space.md },
  step: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 2 },
  stepDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  stepDone: { backgroundColor: colors.good, borderColor: colors.good },
});
