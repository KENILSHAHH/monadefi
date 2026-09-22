import Ionicons from "@expo/vector-icons/Ionicons";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  ActivityIndicator, Animated, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
  type StyleProp, type TextStyle, type ViewStyle,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, space, type } from "@/theme";

export type IconName = ComponentProps<typeof Ionicons>["name"];

export const haptic = {
  tap: () => void Haptics.selectionAsync().catch(() => undefined),
  success: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined),
  error: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined),
  impact: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined),
};

export const openLink = (url: string) => void WebBrowser.openBrowserAsync(url, { toolbarColor: colors.bg, controlsColor: colors.accent }).catch(() => undefined);

// ── Layout ───────────────────────────────────────────────────────────────────

export function Screen({
  children, refreshing, onRefresh, scroll = true, edges = ["top"], contentStyle,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  scroll?: boolean;
  edges?: ("top" | "bottom")[];
  contentStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <SafeAreaView style={styles.screen} edges={edges}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={[styles.content, contentStyle]}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={colors.dim} /> : undefined}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.flex, contentStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function Card({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  return <View style={[styles.card, padded && styles.cardPad, style]}>{children}</View>;
}

export function SectionTitle({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionTitle}>
      <Text style={type.label}>{title}</Text>
      {typeof right === "string" ? <Text style={[type.small, styles.tabular]}>{right}</Text> : right}
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

/** A label and a value on one line. */
export function KeyValue({ label, value, valueStyle, mono }: { label: string; value: ReactNode; valueStyle?: StyleProp<TextStyle>; mono?: boolean }) {
  return (
    <View style={styles.kv}>
      <Text style={[type.small, styles.kvLabel]}>{label}</Text>
      {typeof value === "string" || typeof value === "number" ? (
        <Text style={[mono ? type.mono : type.num, styles.kvValue, valueStyle]} selectable>
          {value}
        </Text>
      ) : (
        value
      )}
    </View>
  );
}

// ── Controls ─────────────────────────────────────────────────────────────────

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "good";

export function Button({
  title, onPress, variant = "primary", loading, disabled, icon, style, compact,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const v = buttonVariants[variant];
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: Boolean(off), busy: Boolean(loading) }}
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      disabled={off}
      style={({ pressed }) => [styles.button, compact && styles.buttonCompact, { backgroundColor: v.bg, borderColor: v.border }, pressed && styles.pressed, off && styles.disabled, style]}
    >
      {loading ? <ActivityIndicator color={v.fg} size="small" /> : icon ? <Ionicons name={icon} size={compact ? 15 : 18} color={v.fg} /> : null}
      <Text style={[styles.buttonText, compact && styles.buttonTextCompact, { color: v.fg }]}>{title}</Text>
    </Pressable>
  );
}

const buttonVariants: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
  primary: { bg: colors.accent, fg: "#FFFFFF", border: colors.accent },
  secondary: { bg: colors.raised, fg: colors.ink, border: colors.line },
  danger: { bg: colors.badSoft, fg: colors.bad, border: "transparent" },
  good: { bg: colors.good, fg: "#04150B", border: colors.good },
  ghost: { bg: "transparent", fg: colors.dim, border: "transparent" },
};

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string; tone?: "good" | "bad" }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((o) => {
        const active = o.value === value;
        const tone = o.tone === "good" ? colors.good : o.tone === "bad" ? colors.bad : colors.accent;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => {
              haptic.tap();
              onChange(o.value);
            }}
            style={[styles.segment, active && { backgroundColor: o.tone ? tone : colors.panel, borderColor: active ? tone : "transparent" }]}
          >
            <Text style={[styles.segmentText, active && { color: o.tone ? "#06110B" : colors.ink }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(active) }}
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && { color: colors.ink }]}>{label}</Text>
    </Pressable>
  );
}

export function Pill({ label, tone = "dim" }: { label: string; tone?: "good" | "bad" | "warn" | "dim" | "accent" }) {
  const t = pillTones[tone];
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }]}>
      <Text style={[styles.pillText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

const pillTones = {
  good: { bg: colors.goodSoft, fg: colors.good },
  bad: { bg: colors.badSoft, fg: colors.bad },
  warn: { bg: colors.warnSoft, fg: colors.warn },
  dim: { bg: colors.raised, fg: colors.dim },
  accent: { bg: colors.accentSoft, fg: colors.accent },
} as const;

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <Button
      compact
      variant="secondary"
      icon={done ? "checkmark" : "copy-outline"}
      title={done ? "Copied" : label}
      onPress={() => {
        void Clipboard.setStringAsync(value).then(() => {
          haptic.success();
          setDone(true);
        });
      }}
    />
  );
}

export function LinkText({ url, label }: { url: string; label: string }) {
  return (
    <Pressable accessibilityRole="link" onPress={() => openLink(url)} style={styles.link} hitSlop={8}>
      <Text style={styles.linkText}>{label}</Text>
      <Ionicons name="open-outline" size={13} color={colors.accent} />
    </Pressable>
  );
}

// ── States ───────────────────────────────────────────────────────────────────

/** A pulsing placeholder for content that is loading. */
export function Skeleton({ width = "100%", height = 16, style }: { width?: ViewStyle["width"]; height?: number; style?: StyleProp<ViewStyle> }) {
  const opacity = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={[{ width, height, borderRadius: radius.sm, backgroundColor: colors.raised, opacity }, style]} />;
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <Card>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[styles.skeletonRow, i > 0 && styles.skeletonGap]}>
          <Skeleton width={36} height={36} style={{ borderRadius: 18 }} />
          <View style={styles.flex}>
            <Skeleton width="55%" height={14} />
            <Skeleton width="35%" height={11} style={{ marginTop: 6 }} />
          </View>
          <Skeleton width={64} height={14} />
        </View>
      ))}
    </Card>
  );
}

export function ErrorState({ message, onRetry, title = "This did not load" }: { message: string; onRetry?: () => void; title?: string }) {
  return (
    <Card style={styles.state}>
      <Ionicons name="cloud-offline-outline" size={26} color={colors.warn} />
      <Text style={[type.h2, styles.stateTitle]}>{title}</Text>
      <Text style={[type.small, styles.center]}>{message}</Text>
      {onRetry && <Button title="Try again" variant="secondary" compact icon="refresh" onPress={onRetry} style={styles.stateButton} />}
    </Card>
  );
}

export function EmptyState({ icon, title, message, action }: { icon: IconName; title: string; message: string; action?: ReactNode }) {
  return (
    <Card style={styles.state}>
      <Ionicons name={icon} size={26} color={colors.faint} />
      <Text style={[type.h2, styles.stateTitle]}>{title}</Text>
      <Text style={[type.small, styles.center]}>{message}</Text>
      {action && <View style={styles.stateButton}>{action}</View>}
    </Card>
  );
}

export function Notice({ tone = "warn", icon, children }: { tone?: "warn" | "bad" | "good" | "accent"; icon?: IconName; children: ReactNode }) {
  const c = { warn: [colors.warnSoft, colors.warn], bad: [colors.badSoft, colors.bad], good: [colors.goodSoft, colors.good], accent: [colors.accentSoft, colors.accent] }[tone];
  return (
    <View style={[styles.notice, { backgroundColor: c[0] }]}>
      <Ionicons name={icon ?? (tone === "good" ? "checkmark-circle" : "alert-circle")} size={16} color={c[1]} style={styles.noticeIcon} />
      <Text style={[type.small, styles.flex, { color: c[1] }]}>{children}</Text>
    </View>
  );
}

// ── Sheet ────────────────────────────────────────────────────────────────────

export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={styles.grabber} />
        <View style={styles.sheetHeader}>
          <Text style={type.title}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <Ionicons name="close" size={22} color={colors.dim} />
          </Pressable>
        </View>
        <ScrollView style={styles.sheetBody} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: "center" },
  tabular: { fontVariant: ["tabular-nums"] },
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg },
  card: { backgroundColor: colors.panel, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden" },
  cardPad: { padding: space.lg },
  sectionTitle: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: -space.sm, paddingHorizontal: space.xs },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: space.md },
  kv: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingVertical: 6, gap: space.lg },
  kvLabel: { flexShrink: 0 },
  kvValue: { flex: 1, textAlign: "right" },
  button: { minHeight: 52, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: space.lg, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm },
  buttonCompact: { minHeight: 36, paddingHorizontal: space.md, borderRadius: radius.sm },
  buttonText: { fontSize: 16, fontWeight: "600" },
  buttonTextCompact: { fontSize: 14 },
  pressed: { opacity: 0.8, transform: [{ scale: 0.985 }] },
  disabled: { opacity: 0.45 },
  segmented: { flexDirection: "row", backgroundColor: colors.raised, borderRadius: radius.md, padding: 3, gap: 3 },
  segment: { flex: 1, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, borderWidth: 1, borderColor: "transparent" },
  segmentText: { fontSize: 15, fontWeight: "600", color: colors.dim },
  chip: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: 999, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.line },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { fontSize: 14, fontWeight: "600", color: colors.dim },
  pill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, alignSelf: "flex-start" },
  pillText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.2 },
  link: { flexDirection: "row", alignItems: "center", gap: 4 },
  linkText: { color: colors.accent, fontSize: 14, fontWeight: "500" },
  skeletonRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  skeletonGap: { marginTop: space.lg },
  state: { alignItems: "center", gap: space.sm, paddingVertical: space.xl },
  stateTitle: { marginTop: space.xs },
  stateButton: { marginTop: space.sm },
  notice: { flexDirection: "row", gap: space.sm, padding: space.md, borderRadius: radius.md },
  noticeIcon: { marginTop: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: { maxHeight: "88%", backgroundColor: colors.panel, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingHorizontal: space.lg, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  grabber: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: colors.line, marginTop: space.sm },
  sheetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: space.md },
  sheetBody: { flexGrow: 0 },
});
