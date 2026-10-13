import Ionicons from "@expo/vector-icons/Ionicons";
import { StyleSheet, Text, View } from "react-native";
import { findLogo, Logo } from "@/components/Logo";
import { Card, EmptyState, ErrorState, Pill, Screen, SkeletonRows, openLink, type IconName } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import type { ActivityItem, ActivityKind } from "@/lib/api/types";
import { relativeTime } from "@/lib/format";
import { useActivity } from "@/lib/queries";
import { colors, space, type } from "@/theme";

const ICON: Record<ActivityKind, IconName> = { trade: "swap-vertical", deposit: "arrow-down", job: "timer-outline", session: "key-outline", relay: "flash-outline" };

/** The protocol behind each kind of item, for its badge. */
const PROTOCOL: Record<ActivityKind, string> = { trade: "perpl", deposit: "aurora", job: "perpl", session: "metamask", relay: "monad" };

/** The first token symbol in a title that has a logo ("Opened ETH long" -> ETH). */
function tokenIn(title: string): string | null {
  for (const w of title.match(/\b[A-Za-z][A-Za-z0-9]{1,7}\b/g) ?? []) {
    if (w === w.toUpperCase() && findLogo("token", w)) return w;
  }
  return null;
}

const tone = (status: string): "good" | "bad" | "warn" | "dim" =>
  /done|success|funded|active|filled/i.test(status) ? "good" : /fail|revert|error|refund|blocked/i.test(status) ? "bad" : /pending|waiting|processing|executing|converting/i.test(status) ? "warn" : "dim";

export default function Activity() {
  const activity = useActivity();
  const items = activity.data ?? [];
  return (
    <Screen title="Activity" refreshing={activity.isRefetching} onRefresh={() => void activity.refetch()}>
      {activity.isLoading ? (
        <SkeletonRows rows={5} />
      ) : activity.error ? (
        <ErrorState message={errorMessage(activity.error)} onRetry={() => void activity.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon="time-outline" title="Nothing yet" message="Trades, deposits and permission changes show here." />
      ) : (
        items.map((it, i) => <Row key={`${it.at}-${i}`} item={it} />)
      )}
    </Screen>
  );
}

function Row({ item }: { item: ActivityItem }) {
  const link = item.explorer ?? null;
  const token = tokenIn(item.title);
  return (
    <Card onPress={link ? () => openLink(link) : undefined} style={styles.row} accessibilityLabel={`${item.title}, ${item.status}`}>
      {token ? (
        <Logo kind="token" id={token} size={36} badge={{ kind: "protocol", id: PROTOCOL[item.kind] ?? "monad" }} />
      ) : (
        <View style={styles.icon}>
          <Ionicons name={ICON[item.kind] ?? "ellipse-outline"} size={17} color={colors.accent} />
        </View>
      )}
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
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md },
  icon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" },
  right: { alignItems: "flex-end", gap: 6 },
});
