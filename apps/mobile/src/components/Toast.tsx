import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useRef, useState } from "react";
import { Animated, Platform, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, space, type } from "@/theme";

/** A one-line, non-blocking message at the top of the screen. It does not take touches. */
type ToastMsg = { id: number; text: string; tone: "good" | "accent" | "bad" };

let next = 1;
const listeners = new Set<(t: ToastMsg) => void>();

export function showToast(text: string, tone: ToastMsg["tone"] = "good") {
  const t = { id: next++, text, tone };
  for (const l of listeners) l(t);
}

export function ToastHost() {
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const l = (t: ToastMsg) => setToast(t);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const native = Platform.OS !== "web";
    Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: native }).start();
    const t = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: native }).start(() => setToast((c) => (c?.id === toast.id ? null : c)));
    }, 4_000);
    return () => clearTimeout(t);
  }, [toast, opacity]);

  if (!toast) return null;
  const color = toast.tone === "good" ? colors.good : toast.tone === "bad" ? colors.bad : colors.accent;
  return (
    <Animated.View pointerEvents="none" style={[styles.wrap, { top: insets.top + space.sm, opacity }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
      <Ionicons name={toast.tone === "bad" ? "alert-circle" : "checkmark-circle"} size={16} color={color} />
      <Text style={[type.small, styles.text]} numberOfLines={2}>
        {toast.text}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    alignSelf: "center",
    maxWidth: 440,
    marginHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: colors.raised,
    borderColor: colors.line,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    zIndex: 1000,
  },
  text: { color: colors.ink, flexShrink: 1 },
});
