import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PerplPosition } from "@/lib/api/types";
import { num, price, signedUsd, usd } from "@/lib/format";
import { colors, space, type } from "@/theme";
import { Pill } from "./ui";

/** Liquidation distance below this fraction is shown as a warning. */
export const NEAR_LIQUIDATION = 0.08;

export function PositionRow({ position: p, onPress }: { position: PerplPosition; onPress?: () => void }) {
  const long = p.side === "long";
  const near = p.distanceToLiquidation !== null && p.distanceToLiquidation < NEAR_LIQUIDATION;
  const pnlColor = p.unrealizedPnl >= 0 ? colors.good : colors.bad;
  const pnlPct = p.marginUsd > 0 ? (p.unrealizedPnl / p.marginUsd) * 100 : null;
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`${p.market} ${p.side} position`}>
      <View style={styles.flex}>
        <View style={styles.title}>
          <Text style={type.h2}>{p.market}</Text>
          <Pill label={`${long ? "LONG" : "SHORT"} ${num(p.leverage, 1)}x`} tone={long ? "good" : "bad"} />
        </View>
        <Text style={type.small}>
          Entry {price(p.entryPx)} · Mark {price(p.markPx)}
        </Text>
        <Text style={[type.small, near && { color: colors.warn }]}>
          Liq. {price(p.liquidationPx)}
          {p.distanceToLiquidation !== null ? ` · ${num(p.distanceToLiquidation * 100, 1)}% away` : ""}
          {near ? " · close to liquidation" : ""}
        </Text>
      </View>
      <View style={styles.right}>
        <Text style={[type.num, { color: pnlColor, fontWeight: "700" }]}>{signedUsd(p.unrealizedPnl)}</Text>
        {pnlPct !== null && <Text style={[type.tiny, { color: pnlColor }]}>{`${pnlPct >= 0 ? "+" : ""}${num(pnlPct, 1)}%`}</Text>}
        <Text style={type.tiny}>{usd(p.marginUsd)} margin</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 3 },
  row: { flexDirection: "row", gap: space.md, paddingVertical: space.md },
  pressed: { opacity: 0.7 },
  title: { flexDirection: "row", alignItems: "center", gap: space.sm },
  right: { alignItems: "flex-end", gap: 2 },
});
