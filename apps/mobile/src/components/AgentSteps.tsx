/**
 * The agent progress in one line, in the Claude Code style: the current step with an animated icon and an
 * elapsed-time counter. Each new step slides in from below with a fade (250 ms). When the run ends, the line
 * becomes a small "✓ 5 steps · 14s" chip; a tap opens the full step list.
 * Built on the React Native Animated API (transform and opacity only), so it runs the same on web and native.
 */
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { currentStep, elapsedLabel, stepsOf, type StepIcon } from "@/lib/agentSteps";
import type { ChatMessage } from "@/lib/chatModel";
import { colors, radius, space, type } from "@/theme";

const native = Platform.OS !== "web";

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** A soft pulse (opacity and scale) for the icon of the running step. */
function PulseIcon({ name }: { name: StepIcon }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: native }),
        Animated.timing(v, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: native }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  const opacity = v.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] });
  const scale = v.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.08] });
  return (
    <Animated.View style={{ opacity, transform: [{ scale }] }}>
      <MaterialCommunityIcons name={name} size={16} color={colors.accent} />
    </Animated.View>
  );
}

/** The single line while the agent runs. */
export function StepLine({ message, startedAt }: { message: ChatMessage; startedAt: number }) {
  const step = currentStep(message);
  const now = useNow(true);
  const anim = useRef(new Animated.Value(1)).current;
  const lastKey = useRef(step.key);

  useEffect(() => {
    if (lastKey.current === step.key) return;
    lastKey.current = step.key;
    anim.setValue(0);
    Animated.timing(anim, { toValue: 1, duration: 250, easing: Easing.out(Easing.cubic), useNativeDriver: native }).start();
  }, [step.key, anim]);

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] });
  return (
    <View style={styles.line} accessibilityLiveRegion="polite" accessibilityLabel={`${step.label}. ${elapsedLabel(now - startedAt)}`}>
      <Animated.View style={[styles.lineMain, { opacity: anim, transform: [{ translateY }] }]}>
        <PulseIcon key={step.icon} name={step.icon} />
        <Text style={[type.small, styles.lineText]} numberOfLines={1}>
          {step.label}…
        </Text>
      </Animated.View>
      <Text style={[type.tiny, styles.timer]}>{elapsedLabel(now - startedAt)}</Text>
    </View>
  );
}

/** The chip after the run, and the step list behind it. */
export function StepsSummary({ message, durationMs }: { message: ChatMessage; durationMs: number | null }) {
  const [open, setOpen] = useState(false);
  const steps = stepsOf(message);
  if (steps.length === 0) return null;
  const failed = steps.some((s) => s.isError);
  const label = `${steps.length} ${steps.length === 1 ? "step" : "steps"}${durationMs !== null ? ` · ${elapsedLabel(durationMs)}` : ""}`;
  return (
    <View style={styles.summary}>
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.chip} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${label}${failed ? ", one or more steps failed" : ""}. Show the steps.`}>
        <MaterialCommunityIcons name="check-circle" size={14} color={colors.good} />
        <Text style={[type.tiny, styles.chipText]}>{label}</Text>
        {failed && <MaterialCommunityIcons name="alert-circle" size={14} color={colors.bad} />}
        <MaterialCommunityIcons name={open ? "chevron-up" : "chevron-down"} size={14} color={colors.faint} />
      </Pressable>
      {open && (
        <View style={styles.list}>
          {steps.map((s) => (
            <View key={s.id} style={styles.item}>
              <MaterialCommunityIcons name={s.icon} size={16} color={colors.dim} style={styles.itemIcon} />
              <View style={styles.flex}>
                <View style={styles.itemHead}>
                  <Text style={[type.small, styles.itemLabel]} numberOfLines={1}>
                    {s.label}
                  </Text>
                  <MaterialCommunityIcons
                    name={!s.done ? "dots-horizontal" : s.isError ? "alert-circle" : "check-circle"}
                    size={14}
                    color={!s.done ? colors.faint : s.isError ? colors.bad : colors.good}
                  />
                </View>
                {s.preview ? (
                  <Text style={[type.tiny, s.isError && { color: colors.bad }]} numberOfLines={2}>
                    {s.preview}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  line: { flexDirection: "row", alignItems: "center", gap: space.sm, height: 36, overflow: "hidden", alignSelf: "flex-start", maxWidth: "100%", paddingHorizontal: space.md, borderRadius: 18, backgroundColor: "rgba(131,110,249,0.12)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(131,110,249,0.35)" },
  lineMain: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: space.sm },
  lineText: { color: colors.ink, flexShrink: 1 },
  timer: { fontVariant: ["tabular-nums"], color: colors.faint },
  summary: { gap: space.sm, alignItems: "flex-start" },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space.md, minHeight: 32,
    borderRadius: radius.xl, backgroundColor: "rgba(255,255,255,0.07)", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
  },
  chipText: { color: colors.dim, fontVariant: ["tabular-nums"] },
  list: { alignSelf: "stretch", gap: space.sm, backgroundColor: "rgba(255,255,255,0.05)", borderRadius: radius.md, padding: space.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  item: { flexDirection: "row", gap: space.sm },
  itemIcon: { marginTop: 1 },
  itemHead: { flexDirection: "row", alignItems: "center", gap: space.sm, justifyContent: "space-between" },
  itemLabel: { color: colors.ink, flexShrink: 1 },
});
