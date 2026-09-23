import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Card, EmptyState, ErrorState, Pill, Screen, SkeletonRows, openLink, type IconName } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import type { ActivityItem, ActivityKind } from "@/lib/api/types";
import { relativeTime } from "@/lib/format";
import { useActivity } from "@/lib/queries";
import { colors, radius, space, type } from "@/theme";

const ICON: Record<ActivityKind, IconName> = { trade: "swap-vertical", deposit: "arrow-down", job: "timer-outline", session: "key-outline", relay: "flash-outline" };

const tone = (status: string): "good" | "bad" | "warn" | "dim" =>
  /done|success|funded|active|filled/i.test(status) ? "good" : /fail|revert|error|refund|blocked/i.test(status) ? "bad" : /pending|waiting|processing|executing|converting/i.test(status) ? "warn" : "dim";

export default function Activity() {
  const activity = useActivity();
  const items = activity.data ?? [];
  return (
    <Screen refreshing={activity.isRefetching} onRefresh={() => void activity.refetch()}>
      <Text style={type.title}>Activity</Text>
      {activity.isLoading ? (
        <SkeletonRows rows={5} />
      ) : activity.error ? (
        <ErrorState message={errorMessage(activity.error)} onRetry={() => void activity.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon="time-outline" title="Nothing yet" message="Trades, deposits and permission changes show here." />
      ) : (
        <Card padded={false}>
          {items.map((it, i) => (
            <Row key={`${it.at}-${i}`} item={it} first={i === 0} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

function Row({ item, first }: { item: ActivityItem; first: boolean }) {
  const link = item.explorer ?? null;
  return (
    <Pressable onPress={link ? () => openLink(link) : undefined} disabled={!link} style={({ pressed }) => [styles.row, !first && styles.border, pressed && { backgroundColor: colors.raised }]} accessibilityRole={link ? "link" : undefined}>
      <View style={styles.icon}>
        <Ionicons name={ICON[item.kind] ?? "ellipse-outline"} size={17} color={colors.dim} />
      </View>
      <View style={styles.flex}>
        <Text style={type.body} numberOfLines={2}>
          {item.title}
        </Text>
        <Text style={type.tiny}>{relativeTime(item.at)}</Text>
      </View>
      <View style={styles.right}>
        <Pill label={item.status} tone={tone(item.status)} />
        {link && <Ionicons name="open-outline" size={14} color={colors.faint} />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg },
  border: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  icon: { width: 34, height: 34, borderRadius: radius.md, backgroundColor: colors.raised, alignItems: "center", justifyContent: "center" },
  right: { alignItems: "flex-end", gap: 6 },
});
