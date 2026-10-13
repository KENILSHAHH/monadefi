import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { AddressQr } from "@/components/AddressQr";
import { DepositProgress } from "@/components/DepositProgress";
import { Brand, Logo } from "@/components/Logo";
import { MetaMaskDepositSheet } from "@/components/MetaMaskDepositSheet";
import { Button, Card, Chip, ErrorState, KeyValue, Notice, Screen, Segmented, SkeletonRows, haptic } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import type { AuroraChain, AuroraDeposit } from "@/lib/api/types";
import { useAddress } from "@/lib/auth/AuthProvider";
import { eta, fixed, parseAmount } from "@/lib/format";
import { keys, useBalance } from "@/lib/queries";
import { colors, fonts, radius, space, type } from "@/theme";

export default function Deposit() {
  const [tab, setTab] = useState<"monad" | "any">("monad");
  const [metamask, setMetamask] = useState(false);
  return (
    <Screen>
      <Button title="Deposit from MetaMask" leading={<Logo kind="protocol" id="metamask" size={22} />} onPress={() => setMetamask(true)} />
      <MetaMaskDepositSheet visible={metamask} onClose={() => setMetamask(false)} />
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
      <Card style={styles.gap}>
        <View style={styles.row}>
          <Logo kind="chain" id="monad" size={22} />
          <Text style={type.h2}>Monad</Text>
          <Text style={[type.tiny, styles.flex]}>chain 143</Text>
        </View>
        <AddressQr value={address} caption="Send AUSD, USDC or MON on Monad (chain 143) to your Mona-DeFi address." />
      </Card>
      {received !== null ? (
        <Notice tone="good">Received {fixed(received, 2)}. It is in your wallet now.</Notice>
      ) : (
        <Notice tone="accent" icon="time-outline">Waiting for a transfer. This screen updates by itself.</Notice>
      )}
      <Card style={styles.gap}>
        <TokenLine id="ausd" label="AUSD in wallet" value={balance.data ? fixed(balance.data.ausd.wallet, 2) : "—"} />
        <TokenLine id="usdc" label="USDC in wallet" value={balance.data ? fixed(balance.data.usdc, 2) : "—"} />
        <TokenLine id="mon" label="MON in wallet" value={balance.data ? fixed(balance.data.mon, 4) : "—"} />
        <Text style={[type.tiny, styles.top]}>Perpl takes AUSD only. Send AUSD to trade at once. Only send on Monad: other networks use the Any chain tab.</Text>
      </Card>
      {balance.error && <Notice>{errorMessage(balance.error)}</Notice>}
    </>
  );
}

function TokenLine({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Logo kind="token" id={id} size={28} badge={{ kind: "chain", id: "monad" }} />
      <Text style={[type.body, styles.flex]}>{label}</Text>
      <Text style={type.numBold}>{value}</Text>
    </View>
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
      <Card style={styles.gap}>
        <Brand id="aurora" label="Aurora Intents" size={20} color={colors.ink} />
        <Text style={type.small}>Aurora Intents brings funds from another chain to your Mona-DeFi wallet on Monad as AUSD.</Text>
      </Card>
      <Card style={styles.gap}>
        <Text style={type.label}>From chain</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {chains.map((c) => (
            <Chip key={c.chain} label={c.name} leading={<Logo kind="chain" id={c.chain} size={22} />} active={c.chain === chain.chain} onPress={() => { setChainKey(c.chain); setAssetId(null); setRefundText(""); }} />
          ))}
        </ScrollView>
        <Text style={type.tiny}>
          {chain.connect ? "AUSD arrives directly. You sign one message on this phone, with no prompt." : "USDC arrives first. Then you sign a swap to AUSD on this phone, with no prompt and no gas."}
        </Text>
        <Text style={[type.label, styles.top]}>Asset</Text>
        <View style={styles.wrapChips}>
          {chain.tokens.slice(0, 12).map((t) => (
            <Chip key={t.assetId} label={t.symbol} leading={<Logo kind="token" id={t.symbol} size={22} badge={{ kind: "chain", id: chain.chain }} />} active={t.assetId === token.assetId} onPress={() => setAssetId(t.assetId)} />
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
          <Logo kind="protocol" id="perpl" size={24} />
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap: { gap: space.sm },
  top: { marginTop: space.md },
  chips: { gap: space.sm, paddingVertical: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 32 },
  wrapChips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  input: { ...fonts.sans, backgroundColor: colors.raised, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, color: colors.ink, paddingHorizontal: space.md, height: 48, fontSize: 16 },
  toggle: { flexDirection: "row", alignItems: "center", gap: space.md },
});
