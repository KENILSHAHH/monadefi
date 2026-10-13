import { router } from "expo-router";
import { useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { Glass } from "@/components/Glass";
import { Brand, Logo } from "@/components/Logo";
import { Card, ErrorState, Screen, SkeletonRows } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import type { PerplMarket } from "@/lib/api/types";
import { num, pct, price } from "@/lib/format";
import { fundingApr } from "@/lib/markets";
import { useMarkets } from "@/lib/queries";
import { colors, fonts, radius, space, type } from "@/theme";

export default function Markets() {
  const markets = useMarkets();
  const [query, setQuery] = useState("");
  const list = (markets.data ?? [])
    .filter((m) => m.isOpen && m.symbol.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => b.dayVolumeUsd - a.dayVolumeUsd);

  return (
    <Screen title="Markets" refreshing={markets.isRefetching} onRefresh={() => void markets.refetch()}>
      <View style={styles.sub}>
        <Brand id="perpl" label="Perpl" size={18} color={colors.ink} />
        <Text style={[type.small, styles.flex]}>perpetuals on Monad. AUSD margin, isolated per position.</Text>
      </View>
      <Glass radius={radius.md} style={styles.search}>
        <Ionicons name="search" size={17} color={colors.faint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search a market"
          placeholderTextColor={colors.faint}
          style={styles.searchInput}
          autoCapitalize="characters"
          autoCorrect={false}
          accessibilityLabel="Search markets"
        />
      </Glass>
      {markets.isLoading ? (
        <SkeletonRows rows={6} />
      ) : markets.error ? (
        <ErrorState message={errorMessage(markets.error)} onRetry={() => void markets.refetch()} />
      ) : (
        <>
          <View style={styles.headRow}>
            <Text style={[type.label, styles.colMarket]}>Market</Text>
            <Text style={[type.label, styles.colNum]}>Mark · 24h</Text>
            <Text style={[type.label, styles.colNum]}>Funding / yr</Text>
          </View>
          {list.map((m) => (
            <MarketRow key={m.id} m={m} />
          ))}
          {list.length === 0 && (
            <Card>
              <Text style={type.small}>No open market matches “{query}”.</Text>
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}

function MarketRow({ m }: { m: PerplMarket }) {
  const up = m.change24hPct >= 0;
  const apr = fundingApr(m);
  return (
    <Card
      onPress={() => router.push({ pathname: "/market/[symbol]", params: { symbol: m.symbol } })}
      style={styles.row}
      accessibilityLabel={`${m.symbol}, mark ${price(m.markPx)}, ${num(m.change24hPct, 2)} percent in 24 hours`}
    >
      <View style={[styles.colMarket, styles.market]}>
        <Logo kind="token" id={m.symbol} size={36} />
        <View style={styles.flex}>
          <Text style={type.h2} numberOfLines={1}>
            {m.symbol}
          </Text>
          <Text style={type.tiny}>Up to {num(m.maxLeverage, 0)}x</Text>
        </View>
      </View>
      <View style={styles.colNum}>
        <Text style={[type.numBold, styles.right]} numberOfLines={1}>
          {price(m.markPx)}
        </Text>
        <View style={[styles.change, { backgroundColor: up ? colors.goodSoft : colors.badSoft }]}>
          <Text style={[styles.changeText, { color: up ? colors.good : colors.bad }]}>{`${up ? "+" : ""}${num(m.change24hPct, 2)}%`}</Text>
        </View>
      </View>
      <View style={styles.colNum}>
        <Text style={[type.num, styles.right, { color: apr > 0 ? colors.bad : apr < 0 ? colors.good : colors.dim }]}>{pct(apr, 1, true)}</Text>
        <Text style={[type.tiny, styles.right]}>{apr > 0 ? "longs pay" : apr < 0 ? "shorts pay" : "flat"}</Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  sub: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, height: 48 },
  searchInput: { ...fonts.sans, flex: 1, color: colors.ink, fontSize: 16, height: 46 },
  headRow: { flexDirection: "row", paddingHorizontal: space.lg + 2, marginTop: space.xs, marginBottom: -space.xs },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: space.md + 2 },
  market: { flexDirection: "row", alignItems: "center", gap: space.md },
  colMarket: { flex: 1.25, gap: 2 },
  colNum: { flex: 1, gap: 4, alignItems: "flex-end" },
  right: { textAlign: "right" },
  change: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  changeText: { ...fonts.sansBold, fontSize: 12, fontVariant: ["tabular-nums"] },
});
