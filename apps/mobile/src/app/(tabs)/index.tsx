import Ionicons from "@expo/vector-icons/Ionicons";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { IntentConfirm } from "@/components/IntentConfirm";
import { PositionRow } from "@/components/PositionRow";
import { Button, Card, Divider, EmptyState, ErrorState, KeyValue, Notice, Screen, SectionTitle, Sheet, Skeleton, SkeletonRows, haptic } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import type { Intent, PerplPosition } from "@/lib/api/types";
import { useAddress } from "@/lib/auth/AuthProvider";
import { fixed, num, price, short, signedUsd, usd } from "@/lib/format";
import { keys, useBalance, usePositions, useSessionStatus } from "@/lib/queries";
import { colors, radius, space, type } from "@/theme";

export default function Home() {
  const address = useAddress();
  const qc = useQueryClient();
  const balance = useBalance();
  const positions = usePositions();
  const session = useSessionStatus();
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
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <View style={styles.header}>
        <View>
          <Text style={type.title}>Mona-DeFi</Text>
          <Text style={[type.mono, { color: colors.faint }]}>{short(address)} · Monad</Text>
        </View>
        <Pressable onPress={() => router.push("/deposit")} style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Add funds">
          <Ionicons name="qr-code-outline" size={20} color={colors.ink} />
        </Pressable>
      </View>

      {session.data && session.data.status !== "active" && (
        <Pressable onPress={() => router.push("/session")} accessibilityRole="button">
          <Notice tone="accent" icon="key-outline">
            {session.data.status === "expired" ? "Your trading permission ended. Tap to renew it." : "Turn on trading: one tap gives Mona-DeFi a scoped permission to place Perpl orders. No prompts after that."}
          </Notice>
        </Pressable>
      )}

      <Card>
        <Text style={type.label}>AUSD balance</Text>
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
              <Text style={[type.tiny, styles.other]}>
                Also in the wallet: {num(balance.data.usdc, 2)} USDC · {num(balance.data.mon, 4)} MON · total {usd(balance.data.totalUsd)}
              </Text>
            )}
          </>
        )}
        <View style={styles.actions}>
          <Button title="Add funds" icon="add" onPress={() => router.push("/deposit")} style={styles.flex} compact />
          <Button title="Trade" icon="swap-vertical" variant="secondary" onPress={() => router.push("/(tabs)/markets")} style={styles.flex} compact />
          <Button title="Withdraw" icon="arrow-up" variant="secondary" onPress={() => router.push("/withdraw")} style={styles.flex} compact />
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
        <Card style={styles.listCard}>
          {list.map((p, i) => (
            <View key={`${p.marketId}-${p.side}`}>
              {i > 0 && <View style={styles.sep} />}
              <PositionRow position={p} onPress={() => setSelected(p)} />
            </View>
          ))}
        </Card>
      )}
      {positions.data && positions.data.errors.length > 0 && <Notice>Some sources did not answer, so this view can be incomplete: {positions.data.errors.join("; ")}</Notice>}

      <PositionSheet position={selected} onClose={() => setSelected(null)} />
    </Screen>
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
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  iconButton: { width: 42, height: 42, borderRadius: radius.md, backgroundColor: colors.raised, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  hero: { marginTop: space.sm },
  unit: { fontSize: 18, fontWeight: "600", color: colors.dim, letterSpacing: 0 },
  breakdown: { flexDirection: "row", marginTop: space.lg, gap: space.sm },
  part: { flex: 1, backgroundColor: colors.raised, borderRadius: radius.md, padding: space.md, gap: 2 },
  partValue: { fontWeight: "600" },
  other: { marginTop: space.md },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.lg },
  listCard: { paddingVertical: 0 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  sheetBody: { gap: space.sm, paddingBottom: space.md },
});
