import Ionicons from "@expo/vector-icons/Ionicons";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { IntentConfirm } from "@/components/IntentConfirm";
import { Logo } from "@/components/Logo";
import { PositionRow } from "@/components/PositionRow";
import { Button, Card, Divider, EmptyState, ErrorState, IconButton, KeyValue, Notice, Screen, SectionTitle, Sheet, Skeleton, SkeletonRows, haptic, type IconName } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import type { Intent, PerplPosition } from "@/lib/api/types";
import { useAddress } from "@/lib/auth/AuthProvider";
import { fixed, num, price, short, signedUsd, usd } from "@/lib/format";
import { keys, useBalance, usePositions } from "@/lib/queries";
import { useTradingSession } from "@/lib/session";
import { colors, fonts, radius, space, type } from "@/theme";

export default function Home() {
  const address = useAddress();
  const qc = useQueryClient();
  const balance = useBalance();
  const positions = usePositions();
  const trading = useTradingSession();
  const [selected, setSelected] = useState<PerplPosition | null>(null);

  const refreshing = balance.isRefetching || positions.isRefetching;
  const refresh = () => {
    haptic.tap();
    void qc.invalidateQueries({ queryKey: keys.balance });
    void qc.invalidateQueries({ queryKey: keys.positions });
    void qc.invalidateQueries({ queryKey: keys.session });
  };

  const list = positions.data?.perpl.positions ?? [];
  const pnl = list.reduce((s, p) => s + p.unrealizedPnl, 0);

  return (
    <Screen
      title="Mona-DeFi"
      subtitle={
        <View style={styles.addressLine}>
          <Logo kind="chain" id="monad" size={14} />
          <Text style={[type.mono, styles.address]} numberOfLines={1}>
            {short(address)} · Monad
          </Text>
        </View>
      }
      right={<IconButton icon="qr-code-outline" label="Add funds" onPress={() => router.push("/deposit")} />}
      refreshing={refreshing}
      onRefresh={refresh}
    >

      {trading.phase === "revoked" && (
        <Pressable onPress={() => router.push("/(tabs)/settings")} accessibilityRole="button">
          <Notice tone="accent" icon="key-outline">Trading access is off because you revoked it. You can restore it in Settings.</Notice>
        </Pressable>
      )}

      <Card style={styles.balanceCard}>
        <View style={styles.balanceHead}>
          <Logo kind="token" id="ausd" size={22} badge={{ kind: "chain", id: "monad" }} />
          <Text style={type.label}>AUSD balance</Text>
        </View>
        {balance.isLoading ? (
          <Skeleton width={200} height={44} style={{ marginTop: space.sm }} />
        ) : balance.error ? (
          <Text style={[type.small, { marginTop: space.sm, color: colors.warn }]}>{errorMessage(balance.error)}</Text>
        ) : (
          <>
            <Text style={[type.hero, styles.hero]} accessibilityLabel={`${fixed(balance.data?.ausd.total ?? 0, 2)} AUSD`}>
              {fixed(balance.data?.ausd.total ?? 0, 2)}
              <Text style={styles.unit}> AUSD</Text>
            </Text>
            {list.length > 0 && <Text style={[type.small, { color: pnl >= 0 ? colors.good : colors.bad }]}>{signedUsd(pnl)} open profit or loss</Text>}
            <View style={styles.breakdown}>
              <Part label="Wallet" value={balance.data?.ausd.wallet} />
              <Part label="Perpl free" value={balance.data?.ausd.perplFree} />
              <Part label="In positions" value={(balance.data?.ausd.inPositions ?? 0) + (balance.data?.ausd.perplLocked ?? 0)} />
            </View>
            {balance.data && (balance.data.usdc > 0 || balance.data.mon > 0) && (
              <View style={styles.other}>
                <Text style={type.tiny}>Also in the wallet</Text>
                <View style={styles.otherRow}>
                  <Asset id="usdc" text={`${num(balance.data.usdc, 2)} USDC`} />
                  <Asset id="mon" text={`${num(balance.data.mon, 4)} MON`} />
                  <Text style={[type.tiny, styles.total]}>total {usd(balance.data.totalUsd)}</Text>
                </View>
              </View>
            )}
          </>
        )}
        <View style={styles.actions}>
          <Action icon="add" label="Add funds" primary onPress={() => router.push("/deposit")} />
          <Action icon="swap-vertical" label="Trade" onPress={() => router.push("/(tabs)/markets")} />
          <Action icon="arrow-up" label="Withdraw" onPress={() => router.push("/withdraw")} />
        </View>
      </Card>

      <SectionTitle title="Positions" right={list.length ? `${list.length} open` : undefined} />
      {positions.isLoading ? (
        <SkeletonRows rows={2} />
      ) : positions.error ? (
        <ErrorState message={errorMessage(positions.error)} onRetry={() => void positions.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon="pulse-outline" title="No open position" message="Pick a market, size the trade, and the Nansen check runs before you confirm." action={<Button compact title="See markets" variant="secondary" onPress={() => router.push("/(tabs)/markets")} />} />
      ) : (
        list.map((p) => <PositionRow key={`${p.marketId}-${p.side}`} position={p} onPress={() => setSelected(p)} />)
      )}
      {positions.data && positions.data.errors.length > 0 && <Notice>Some sources did not answer, so this view can be incomplete: {positions.data.errors.join("; ")}</Notice>}

      <PositionSheet position={selected} onClose={() => setSelected(null)} />
    </Screen>
  );
}

/** A round action button with its label below (the Apple Wallet style). */
function Action({ icon, label, onPress, primary }: { icon: IconName; label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
    >
      <View style={[styles.actionIcon, primary && styles.actionPrimary]}>
        <Ionicons name={icon} size={22} color={primary ? "#FFFFFF" : colors.ink} />
      </View>
      <Text style={[type.small, styles.actionLabel]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function Asset({ id, text }: { id: string; text: string }) {
  return (
    <View style={styles.asset}>
      <Logo kind="token" id={id} size={16} />
      <Text style={[type.small, styles.assetText]}>{text}</Text>
    </View>
  );
}

function Part({ label, value }: { label: string; value: number | undefined }) {
  return (
    <View style={styles.part}>
      <Text style={type.tiny}>{label}</Text>
      <Text style={[type.num, styles.partValue]}>{fixed(value ?? 0, 2)}</Text>
    </View>
  );
}

function PositionSheet({ position: p, onClose }: { position: PerplPosition | null; onClose: () => void }) {
  const [intent, setIntent] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setIntent(null);
    setError(null);
    onClose();
  };
  async function prepareClose() {
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      setIntent((await api.trade.close(p.market, 1)).intent);
    } catch (e) {
      setError(errorMessage(e, "The close order could not be prepared."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet visible={p !== null} onClose={close} title={p ? `${p.market} ${p.side}` : ""}>
      {p && !intent && (
        <View style={styles.sheetBody}>
          <View style={styles.sheetLogo}>
            <Logo kind="token" id={p.market} size={40} />
            <Text style={[type.hero, { color: p.unrealizedPnl >= 0 ? colors.good : colors.bad }]}>{signedUsd(p.unrealizedPnl)}</Text>
          </View>
          <KeyValue label="Size" value={`${num(p.size, 6)} ${p.market}`} />
          <KeyValue label="Entry" value={price(p.entryPx)} />
          <KeyValue label="Mark" value={price(p.markPx)} />
          <KeyValue label="Margin" value={usd(p.marginUsd)} />
          <KeyValue label="Leverage" value={`${num(p.leverage, 1)}x`} />
          <KeyValue label="Liquidation" value={p.liquidationPx === null ? "—" : `${price(p.liquidationPx)} (${num((p.distanceToLiquidation ?? 0) * 100, 1)}% away)`} />
          <KeyValue label="Profit or loss" value={signedUsd(p.unrealizedPnl)} valueStyle={{ color: p.unrealizedPnl >= 0 ? colors.good : colors.bad }} />
          <Divider />
          {error && <Notice tone="bad">{error}</Notice>}
          <Button title="Close position" variant="danger" icon="close-circle-outline" loading={busy} onPress={() => void prepareClose()} />
          <Button title={`Trade ${p.market}`} variant="secondary" onPress={() => { close(); router.push({ pathname: "/trade/[symbol]", params: { symbol: p.market } }); }} />
        </View>
      )}
      {intent && (
        <View style={styles.sheetBody}>
          <IntentConfirm intent={intent} />
          {intent.status !== "pending" && <Button title="Done" variant="secondary" onPress={close} />}
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  addressLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  address: { color: colors.dim, flexShrink: 1 },
  balanceCard: { paddingVertical: space.xl },
  balanceHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  hero: { marginTop: space.sm },
  unit: { ...fonts.display, fontSize: 18, color: colors.dim, letterSpacing: 0 },
  breakdown: { flexDirection: "row", marginTop: space.lg, gap: space.sm },
  part: { flex: 1, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: radius.md, padding: space.md, gap: 3, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  partValue: { ...fonts.sansBold },
  other: { marginTop: space.lg, gap: 6 },
  otherRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.md },
  asset: { flexDirection: "row", alignItems: "center", gap: 6 },
  assetText: { color: colors.ink },
  total: { marginLeft: "auto" },
  actions: { flexDirection: "row", justifyContent: "space-around", marginTop: space.xl },
  action: { alignItems: "center", gap: 6, minWidth: 76, minHeight: 44 },
  actionPressed: { opacity: 0.8, transform: [{ scale: 0.96 }] },
  actionIcon: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.09)", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  actionPrimary: { backgroundColor: colors.accent, borderColor: "rgba(255,255,255,0.18)", boxShadow: "0px 6px 18px rgba(131,110,249,0.4)" },
  actionLabel: { color: colors.ink },
  sheetBody: { gap: space.sm, paddingBottom: space.md },
  sheetLogo: { flexDirection: "row", alignItems: "center", gap: space.md, marginBottom: space.sm },
});
