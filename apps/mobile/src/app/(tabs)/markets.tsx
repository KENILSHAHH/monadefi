import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Card, ErrorState, Screen, SkeletonRows } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import type { PerplMarket } from "@/lib/api/types";
import { num, pct, price } from "@/lib/format";
import { fundingApr } from "@/lib/markets";
import { useMarkets } from "@/lib/queries";
import { colors, radius, space, type } from "@/theme";

export default function Markets() {
  const markets = useMarkets();
  const [query, setQuery] = useState("");
  const list = (markets.data ?? [])
    .filter((m) => m.isOpen && m.symbol.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => b.dayVolumeUsd - a.dayVolumeUsd);

  return (
    <Screen refreshing={markets.isRefetching} onRefresh={() => void markets.refetch()}>
      <Text style={type.title}>Markets</Text>
      <Text style={[type.small, styles.sub]}>Perpl perpetuals on Monad. AUSD margin, isolated per position.</Text>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search a market"
        placeholderTextColor={colors.faint}
        style={styles.search}
        autoCapitalize="characters"
        autoCorrect={false}
        accessibilityLabel="Search markets"
      />
      {markets.isLoading ? (
        <SkeletonRows rows={6} />
      ) : markets.error ? (
        <ErrorState message={errorMessage(markets.error)} onRetry={() => void markets.refetch()} />
      ) : (
        <Card padded={false}>
          <View style={styles.headRow}>
            <Text style={[type.tiny, styles.colMarket]}>Market</Text>
            <Text style={[type.tiny, styles.colNum]}>Mark · 24h</Text>
            <Text style={[type.tiny, styles.colNum]}>Funding (yr)</Text>
          </View>
          {list.map((m) => (
            <MarketRow key={m.id} m={m} />
          ))}
          {list.length === 0 && <Text style={[type.small, styles.empty]}>No open market matches “{query}”.</Text>}
        </Card>
      )}
    </Screen>
  );
}

function MarketRow({ m }: { m: PerplMarket }) {
  const up = m.change24hPct >= 0;
  const apr = fundingApr(m);
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/market/[symbol]", params: { symbol: m.symbol } })}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.raised }]}
      accessibilityRole="button"
      accessibilityLabel={`${m.symbol}, mark ${price(m.markPx)}, ${num(m.change24hPct, 2)} percent in 24 hours`}
    >
      <View style={styles.colMarket}>
        <Text style={type.h2}>{m.symbol}</Text>
        <Text style={type.tiny}>Up to {num(m.maxLeverage, 0)}x</Text>
      </View>
      <View style={styles.colNum}>
        <Text style={[type.num, styles.right]}>{price(m.markPx)}</Text>
        <Text style={[type.tiny, styles.right, { color: up ? colors.good : colors.bad }]}>{`${up ? "+" : ""}${num(m.change24hPct, 2)}%`}</Text>
      </View>
      <View style={styles.colNum}>
        <Text style={[type.num, styles.right, { color: apr > 0 ? colors.bad : apr < 0 ? colors.good : colors.dim }]}>{pct(apr, 1, true)}</Text>
        <Text style={[type.tiny, styles.right]}>{apr > 0 ? "longs pay" : apr < 0 ? "shorts pay" : "flat"}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sub: { marginTop: -space.md },
  search: { backgroundColor: colors.panel, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, color: colors.ink, paddingHorizontal: space.lg, height: 46, fontSize: 16 },
  headRow: { flexDirection: "row", paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  colMarket: { flex: 1.1, gap: 2 },
  colNum: { flex: 1, gap: 2, alignItems: "flex-end" },
  right: { textAlign: "right" },
  empty: { padding: space.lg },
});
