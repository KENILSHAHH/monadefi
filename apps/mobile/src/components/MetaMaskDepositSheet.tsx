/**
 * "Deposit from MetaMask" sheet of the deposit screen (signed in).
 * - Monad: a plain transfer from MetaMask to the user's Mona-DeFi (Mera) wallet.
 * - Other chain: an Aurora deposit (POST /deposit/aurora). For connect mode the Mera wallet signs the order first
 *   (signConnectOrder). Then MetaMask sends a plain transfer to the Aurora deposit address from our API.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { Address } from "viem";
import { DepositProgress, signConnectOrder } from "@/components/DepositProgress";
import { Destination, MonadDirect, NoMetaMask, StepList, useMetaMask } from "@/components/MetaMask";
import { Button, Card, Chip, ErrorState, KeyValue, Notice, Segmented, Sheet, SkeletonRows, haptic } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import type { AuroraDeposit } from "@/lib/api/types";
import { useAddress } from "@/lib/auth/AuthProvider";
import { short } from "@/lib/format";
import {
  FlowError, amountText, auroraSendAmount, buildTransferTx, checkAuroraDestination, connectAccount, metamaskErrorMessage, parseTokenAmount,
  sendTransfer, sleep, sourceChains, switchChain, type Eip1193Provider, type SourceChain, type SourceToken,
} from "@/lib/metamask/core";
import { canUseProvider } from "@/lib/metamask/provider";
import { keys } from "@/lib/queries";
import { colors, radius, space, type } from "@/theme";

export function MetaMaskDepositSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Deposit from MetaMask">
      {visible && <SheetBody onClose={onClose} />}
    </Sheet>
  );
}

function SheetBody({ onClose }: { onClose: () => void }) {
  const address = useAddress() as Address;
  const mm = useMetaMask();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"monad" | "other">("monad");

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.balance });
    void qc.invalidateQueries({ queryKey: keys.positions });
  };

  return (
    <View style={styles.body}>
      {canUseProvider && (
        <Segmented value={tab} onChange={setTab} options={[{ value: "monad", label: "Monad" }, { value: "other", label: "Other chain" }]} />
      )}
      {mm.status === "searching" && <SkeletonRows rows={1} />}
      {mm.status === "missing" && <NoMetaMask to={address} onRetry={mm.retry} />}
      {mm.status === "found" && tab === "monad" && (
        <>
          <Destination address={address} title="Deposit to your Mona-DeFi wallet" />
          <MonadDirect provider={mm.provider} to={address} onSuccess={refresh} />
        </>
      )}
      {mm.status === "found" && tab === "other" && <OtherChain provider={mm.provider} onClose={onClose} />}
    </View>
  );
}

// ── Other chain (Aurora) ─────────────────────────────────────────────────────

const STEPS_CONNECT = ["Connect", "Create deposit", "Sign the order (Mona-DeFi wallet)", "Switch network", "Confirm in MetaMask", "Tell Aurora"] as const;
const STEPS_SWAP = ["Connect", "Create deposit", "Switch network", "Confirm in MetaMask", "Tell Aurora"] as const;

type Prepared = { deposit: AuroraDeposit; from: Address; destination: Address; amount: bigint; chain: SourceChain; token: SourceToken };

/** Wait (up to 30 s) until the deposit has its address after the signature. */
async function untilAddress(d: AuroraDeposit): Promise<AuroraDeposit> {
  let cur = d;
  for (let i = 0; i < 15 && (cur.status === "awaiting_signature" || !cur.depositAddress); i++) {
    if (cur.status === "failed" || cur.status === "expired") break;
    await sleep(2_000);
    cur = await api.deposit.get(cur.id);
  }
  return cur;
}

function OtherChain({ provider, onClose }: { provider: Eip1193Provider; onClose: () => void }) {
  const assets = useQuery({ queryKey: keys.depositAssets, queryFn: api.deposit.assets, staleTime: 5 * 60_000 });
  const chains = useMemo(() => sourceChains(assets.data ?? []), [assets.data]);
  const [chainKey, setChainKey] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [toPerpl, setToPerpl] = useState(true);
  const [step, setStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [progress, setProgress] = useState<AuroraDeposit | null>(null);

  const chain = chains.find((c) => c.key === chainKey) ?? chains[0];
  const token = chain?.tokens.find((t) => t.assetId === assetId) ?? chain?.tokens[0];
  const parsed = token && text ? parseTokenAmount(text, token.decimals) : null;
  const steps = chain?.connect ? STEPS_CONNECT : STEPS_SWAP;
  const [busy, setBusy] = useState(false);
  /** MetaMask errors carry a number code (EIP-1193). API and app errors carry a plain sentence. */
  const message = (e: unknown) => (typeof (e as { code?: unknown })?.code === "number" ? metamaskErrorMessage(e) : errorMessage(e));

  // Part 1: connect MetaMask, create the deposit, sign the order with the Mera wallet, check the destination.
  async function prepare() {
    if (!chain || !token || !parsed?.ok) return;
    setError(null);
    setBusy(true);
    let n = 0;
    const at = (i: number) => {
      n = i;
      setStep(i);
    };
    at(0);
    try {
      const from = await connectAccount(provider);
      at(1);
      let d = await api.deposit.create({ assetId: token.assetId, amount: amountText(parsed.value, token.decimals), refundTo: from, ...(toPerpl ? { after: { type: "perpl_deposit" as const } } : {}) });
      if (d.status === "awaiting_signature" && d.signPayload) {
        at(2);
        d = await untilAddress(await signConnectOrder(d));
      }
      const destination = checkAuroraDestination(d);
      const amount = auroraSendAmount(parsed.value, d.amountIn);
      setPrepared({ deposit: d, from, destination, amount, chain, token });
      at(steps.indexOf("Switch network"));
    } catch (e) {
      haptic.error();
      setStep(n);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  // Part 2, after the user saw the destination: switch MetaMask to the source chain and send the plain transfer.
  async function sendWithMetaMask() {
    if (!prepared) return;
    const { deposit, from, destination, amount, chain: c, token: t } = prepared;
    setError(null);
    setBusy(true);
    const switchAt = steps.indexOf("Switch network");
    let n = switchAt;
    setStep(n);
    try {
      await switchChain(provider, c.chainId, c.add, c.name);
      n = switchAt + 1;
      setStep(n);
      const account = await connectAccount(provider);
      if (account.toLowerCase() !== from.toLowerCase()) throw new FlowError(`Switch MetaMask back to ${short(from)}. The refund goes to that account.`);
      const hash = await sendTransfer(provider, buildTransferTx({ from, recipient: destination, amount, token: t.contract }));
      n = switchAt + 2;
      setStep(n);
      let next = deposit;
      try {
        next = await api.deposit.tx(deposit.id, hash);
      } catch {
        // Aurora also finds the transfer by itself. The progress view shows the state.
      }
      haptic.success();
      setProgress(next);
    } catch (e) {
      haptic.error();
      setStep(n);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (progress) return <DepositProgress initial={progress} onDone={onClose} onLeave={onClose} />;
  if (assets.isLoading) return <SkeletonRows rows={2} />;
  if (assets.error) return <ErrorState message={errorMessage(assets.error)} onRetry={() => void assets.refetch()} />;
  if (!chain || !token) return <Notice>No EVM source chain is available for MetaMask deposits now.</Notice>;

  if (prepared) {
    return (
      <Card style={styles.gap}>
        <Text style={type.h2}>Review the transfer</Text>
        <KeyValue label="From" value={short(prepared.from)} mono />
        <KeyValue label="Network" value={prepared.chain.name} />
        <KeyValue label="Amount" value={`${amountText(prepared.amount, prepared.token.decimals)} ${prepared.token.symbol}`} />
        <Text style={[type.label, styles.top]}>Destination: Aurora deposit address</Text>
        <Text style={[type.mono, styles.full]} selectable>
          {prepared.destination}
        </Text>
        <Text style={type.tiny}>Aurora moves the funds to your Mona-DeFi wallet on Monad. A refund goes back to {short(prepared.from)}.</Text>
        <StepList steps={steps} current={step ?? 0} failed={Boolean(error)} />
        {error && <Notice tone="bad">{error}</Notice>}
        <Button title="Confirm in MetaMask" icon="shield-checkmark-outline" loading={busy} onPress={() => void sendWithMetaMask()} />
        <Button title="Show deposit status" variant="ghost" compact onPress={() => setProgress(prepared.deposit)} />
      </Card>
    );
  }

  return (
    <Card style={styles.gap}>
      <Text style={type.small}>Aurora brings funds from another chain to your Mona-DeFi wallet on Monad as AUSD. MetaMask sends one plain transfer.</Text>
      <Text style={[type.label, styles.top]}>From chain</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {chains.map((c) => (
          <Chip key={c.key} label={c.name} active={c.key === chain.key} onPress={() => { setChainKey(c.key); setAssetId(null); setText(""); }} />
        ))}
      </ScrollView>
      <Text style={[type.label, styles.top]}>Token</Text>
      <View style={styles.wrap}>
        {chain.tokens.slice(0, 12).map((t) => (
          <Chip key={t.assetId} label={t.symbol} active={t.assetId === token.assetId} onPress={() => { setAssetId(t.assetId); setText(""); }} />
        ))}
      </View>
      <Text style={[type.label, styles.top]}>Amount</Text>
      <TextInput value={text} onChangeText={setText} keyboardType="decimal-pad" placeholder={`Amount of ${token.symbol}`} placeholderTextColor={colors.faint} style={styles.input} accessibilityLabel="Amount" autoCorrect={false} />
      {parsed && !parsed.ok && <Text style={[type.tiny, { color: colors.warn }]}>{parsed.error}</Text>}
      <View style={[styles.row, styles.top]}>
        <View style={styles.flex}>
          <Text style={type.body}>Move to Perpl when it arrives</Text>
          <Text style={type.tiny}>Needs trading turned on.</Text>
        </View>
        <Switch value={toPerpl} onValueChange={setToPerpl} trackColor={{ true: colors.accent, false: colors.line }} accessibilityLabel="Move to Perpl when it arrives" />
      </View>
      {step !== null && <StepList steps={steps} current={step} failed={Boolean(error)} />}
      {error && <Notice tone="bad">{error}</Notice>}
      <Button title="Continue" icon="arrow-forward" loading={busy} disabled={!parsed?.ok} onPress={() => void prepare()} />
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { gap: space.md, paddingBottom: space.md },
  flex: { flex: 1 },
  gap: { gap: space.sm },
  top: { marginTop: space.sm },
  row: { flexDirection: "row", alignItems: "center", gap: space.md },
  chips: { gap: space.sm },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  full: { color: colors.ink, backgroundColor: colors.raised, padding: space.sm, borderRadius: radius.sm },
  input: { backgroundColor: colors.raised, borderRadius: radius.md, color: colors.ink, paddingHorizontal: space.md, height: 46, fontSize: 16 },
});
