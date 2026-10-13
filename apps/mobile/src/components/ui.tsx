import Ionicons from "@expo/vector-icons/Ionicons";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import { useIsFocused } from "expo-router";
import { HeaderHeightContext } from "expo-router/react-navigation";
import { BottomTabBarHeightContext } from "expo-router/build/react-navigation/bottom-tabs";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  ActivityIndicator, Alert, Animated, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
  type StyleProp, type TextStyle, type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, fonts, radius, space, type } from "@/theme";
import { Aurora } from "./Aurora";
import { Glass, GlassFill, GlassPressable } from "./Glass";

export type IconName = ComponentProps<typeof Ionicons>["name"];

const isWeb = Platform.OS === "web";
const noop = () => undefined;

/** Haptic feedback. A no-op on web: browsers have no haptics API that iOS Safari supports. */
export const haptic = isWeb
  ? { tap: noop, success: noop, error: noop, impact: noop }
  : {
      tap: () => void Haptics.selectionAsync().catch(noop),
      success: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(noop),
      error: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(noop),
      impact: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(noop),
    };

/**
 * Ask the user to confirm a destructive action. Native: a system alert. Web: window.confirm,
 * because the react-native-web Alert.alert does nothing.
 */
export function confirmAction(title: string, message: string, confirmText: string, onConfirm: () => void) {
  if (isWeb) {
    if (typeof window !== "undefined" && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: confirmText, style: "destructive", onPress: onConfirm },
  ]);
}

export const openLink = (url: string) => void WebBrowser.openBrowserAsync(url, { toolbarColor: colors.bg, controlsColor: colors.accent }).catch(() => undefined);

// ── Layout ───────────────────────────────────────────────────────────────────

/** Height of the glass title bar of a tab screen, below the status bar. */
const BAR_H = 56;
const BAR_SUB_H = 18;

type Insets = { top: number; bottom: number };
const ScreenInsets = createContext<Insets>({ top: 0, bottom: 0 });
/** The space that the glass header (top) and the tab bar or home indicator (bottom) cover on this screen. */
export const useScreenInsets = () => useContext(ScreenInsets);

/**
 * The root of every screen. It has the opaque page color with the northern lights on it, so a screen never depends
 * on a transparent navigator scene and a hidden screen can never show through. The content scrolls under the glass
 * header and the glass tab bar, with padding so that nothing stays under them.
 * - `title`: a tab screen. A fixed glass title bar with the large title and the `right` buttons.
 * - no `title`: a stack screen. The navigator header (transparent glass) is on top: its height is the top padding.
 * - `scroll={false}`: the children lay out the area themselves; `useScreenInsets()` gives the padding to use.
 */
export function Screen({
  children, title, subtitle, right, refreshing, onRefresh, scroll = true, contentStyle,
}: {
  children: ReactNode;
  title?: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const tabBarHeight = useContext(BottomTabBarHeightContext) ?? 0;
  const focused = useIsFocused();
  const barHeight = insets.top + (isWeb ? space.sm : 0) + BAR_H + (subtitle ? BAR_SUB_H : 0);
  const top = title ? barHeight : headerHeight > 0 ? headerHeight : insets.top;
  const bottom = tabBarHeight > 0 ? tabBarHeight : insets.bottom;
  const value = useMemo(() => ({ top, bottom }), [top, bottom]);

  return (
    <ScreenInsets.Provider value={value}>
      <View style={styles.screen}>
        <Aurora paused={!focused} />
        {scroll ? (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={[styles.content, { paddingTop: top + space.lg, paddingBottom: bottom + space.xxl }, contentStyle]}
            scrollIndicatorInsets={{ top, bottom }}
            keyboardShouldPersistTaps="handled"
            refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={colors.dim} progressViewOffset={top} /> : undefined}
          >
            {children}
          </ScrollView>
        ) : (
          <View style={[styles.flex, contentStyle]}>{children}</View>
        )}
        {title ? <TitleBar title={title} subtitle={subtitle} right={right} paddingTop={insets.top + (isWeb ? space.sm : 0)} /> : null}
      </View>
    </ScreenInsets.Provider>
  );
}

/** The glass title bar of a tab screen. A long title shrinks to one line and never runs under the buttons. */
function TitleBar({ title, subtitle, right, paddingTop }: { title: string; subtitle?: ReactNode; right?: ReactNode; paddingTop: number }) {
  return (
    <View style={[styles.bar, { paddingTop }]}>
      <GlassFill tone="bar" />
      <View style={styles.barRow}>
        <View style={styles.barTitle}>
          <Text style={type.largeTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} accessibilityRole="header">
            {title}
          </Text>
          {typeof subtitle === "string" ? (
            <Text style={[type.small, styles.barSub]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : (
            subtitle
          )}
        </View>
        {right ? <View style={styles.barRight}>{right}</View> : null}
      </View>
    </View>
  );
}

/** A round glass icon button for title bars (44 px touch target). */
export function IconButton({ icon, label, onPress, color = colors.ink, active }: { icon: IconName; label: string; onPress: () => void; color?: string; active?: boolean }) {
  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.iconButton, active && styles.iconButtonActive, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={20} color={color} />
    </Pressable>
  );
}

/** A glass card. With `onPress` it is a tappable card with a press state. */
export function Card({ children, style, padded = true, onPress, accessibilityLabel }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean; onPress?: () => void; accessibilityLabel?: string }) {
  if (onPress) {
    return (
      <GlassPressable
        onPress={() => {
          haptic.tap();
          onPress();
        }}
        style={[padded && styles.cardPad, style]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      >
        {children}
      </GlassPressable>
    );
  }
  return <Glass style={[padded && styles.cardPad, style]}>{children}</Glass>;
}

export function SectionTitle({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionTitle}>
      <Text style={styles.sectionText} accessibilityRole="header">
        {title}
      </Text>
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

/** Scale 0.98 and a slight dim while pressed, with a spring back. */
function usePressScale() {
  const v = useRef(new Animated.Value(0)).current;
  const to = (value: number) => Animated.spring(v, { toValue: value, useNativeDriver: !isWeb, speed: 40, bounciness: value ? 0 : 6 }).start();
  const style = { transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 0.98] }) }], opacity: v.interpolate({ inputRange: [0, 1], outputRange: [1, 0.85] }) };
  return { style, onPressIn: () => to(1), onPressOut: () => to(0) };
}

export function Button({
  title, onPress, variant = "primary", loading, disabled, icon, leading, style, compact,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  icon?: IconName;
  /** A logo or other element before the title, in place of the icon. */
  leading?: ReactNode;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const v = buttonVariants[variant];
  const off = disabled || loading;
  const press = usePressScale();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: Boolean(off), busy: Boolean(loading) }}
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      disabled={off}
      style={style}
    >
      <Animated.View style={[styles.button, compact && styles.buttonCompact, { backgroundColor: v.bg, borderColor: v.border }, v.glow && !off ? styles.glow : null, off && styles.disabled, press.style]}>
        {loading ? <ActivityIndicator color={v.fg} size="small" /> : leading ? leading : icon ? <Ionicons name={icon} size={compact ? 15 : 18} color={v.fg} /> : null}
        <Text style={[styles.buttonText, compact && styles.buttonTextCompact, { color: v.fg }]} numberOfLines={1}>
          {title}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const buttonVariants: Record<ButtonVariant, { bg: string; fg: string; border: string; glow?: boolean }> = {
  primary: { bg: colors.accent, fg: "#FFFFFF", border: "rgba(255,255,255,0.14)", glow: true },
  secondary: { bg: "rgba(255,255,255,0.08)", fg: colors.ink, border: colors.line },
  danger: { bg: colors.badSoft, fg: colors.bad, border: "rgba(255,90,95,0.25)" },
  good: { bg: colors.good, fg: "#04150B", border: "rgba(255,255,255,0.14)" },
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
            style={[styles.segment, active && { backgroundColor: o.tone ? tone : "rgba(255,255,255,0.14)", borderColor: o.tone ? tone : "rgba(255,255,255,0.12)" }]}
          >
            <Text style={[styles.segmentText, active && { color: o.tone ? "#06110B" : colors.ink }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({ label, active, onPress, leading }: { label: string; active?: boolean; onPress: () => void; leading?: ReactNode }) {
  const press = usePressScale();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(active) }}
      hitSlop={4}
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
    >
      <Animated.View style={[styles.chip, leading ? styles.chipWithLogo : null, active && styles.chipActive, press.style]}>
        {leading}
        <Text style={[styles.chipText, active && { color: colors.ink }]} numberOfLines={1}>
          {label}
        </Text>
      </Animated.View>
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
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: !isWeb }),
        Animated.timing(opacity, { toValue: 0.45, duration: 700, useNativeDriver: !isWeb }),
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
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      {/* A modal is above every navigator, so the sheet always covers the tab bar. */}
      <Glass tone="sheet" radius={radius.xl} style={[styles.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={styles.grabber} />
        <View style={styles.sheetHeader}>
          <Text style={[type.title, styles.flex]} numberOfLines={2}>
            {title}
          </Text>
          <IconButton icon="close" label="Close" onPress={onClose} color={colors.dim} />
        </View>
        <ScrollView style={styles.sheetBody} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </Glass>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: "center" },
  tabular: { fontVariant: ["tabular-nums"] },
  // Opaque: each screen paints its own page color and northern lights (see Screen).
  screen: { flex: 1, backgroundColor: colors.bg, overflow: "hidden" },
  content: { paddingHorizontal: space.lg, gap: space.md },
  bar: { position: "absolute", top: 0, left: 0, right: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  barRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, minHeight: BAR_H, paddingVertical: space.sm },
  barTitle: { flex: 1, minWidth: 0 },
  barSub: { marginTop: 0 },
  barRight: { flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 0 },
  iconButton: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.08)", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  iconButtonActive: { backgroundColor: colors.accentSoft, borderColor: "rgba(131,110,249,0.45)" },
  cardPad: { padding: space.lg + 2 },
  sectionTitle: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginTop: space.sm, paddingHorizontal: space.xs },
  sectionText: { ...fonts.sansBold, fontSize: 19, lineHeight: 24, color: colors.ink, letterSpacing: -0.2 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: space.md },
  kv: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingVertical: 7, gap: space.lg },
  kvLabel: { flexShrink: 0 },
  kvValue: { flex: 1, textAlign: "right" },
  button: { minHeight: 52, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth * 2, paddingHorizontal: space.lg, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm },
  buttonCompact: { minHeight: 44, paddingHorizontal: space.md, borderRadius: radius.sm + 2 },
  glow: { boxShadow: "0px 6px 18px rgba(131,110,249,0.35)" },
  buttonText: { ...fonts.sansBold, fontSize: 16 },
  buttonTextCompact: { fontSize: 14 },
  pressed: { opacity: 0.8, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.45 },
  segmented: { flexDirection: "row", backgroundColor: "rgba(255,255,255,0.06)", borderRadius: radius.md, padding: 3, gap: 3, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  segment: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, borderWidth: 1, borderColor: "transparent" },
  segmentText: { ...fonts.sansBold, fontSize: 15, color: colors.dim },
  chip: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space.md, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.07)", borderWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.line },
  chipWithLogo: { paddingLeft: 6 },
  chipActive: { borderColor: "rgba(131,110,249,0.8)", backgroundColor: colors.accentSoft },
  chipText: { ...fonts.sansMedium, fontSize: 14, color: colors.dim },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7, alignSelf: "flex-start" },
  pillText: { ...fonts.sansBold, fontSize: 11, letterSpacing: 0.3 },
  link: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32 },
  linkText: { ...fonts.sansMedium, color: colors.accent, fontSize: 14 },
  skeletonRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  skeletonGap: { marginTop: space.lg },
  state: { alignItems: "center", gap: space.sm, paddingVertical: space.xl },
  stateTitle: { marginTop: space.xs },
  stateButton: { marginTop: space.sm },
  notice: { flexDirection: "row", gap: space.sm, padding: space.md, borderRadius: radius.md },
  noticeIcon: { marginTop: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  // On a wide browser window the sheet keeps the width of the centered app column.
  sheet: { ...(isWeb ? { width: "100%", maxWidth: 480, alignSelf: "center" } : {}), maxHeight: "88%", borderBottomLeftRadius: 0, borderBottomRightRadius: 0, paddingHorizontal: space.lg },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.22)", marginTop: space.sm },
  sheetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: space.md, gap: space.md },
  sheetBody: { flexGrow: 0 },
});
