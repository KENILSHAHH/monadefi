/**
 * The glass surface of the app: cards, the tab bar, headers and sheets.
 * - web: a translucent fill with CSS backdrop-filter (blur and saturate).
 * - iOS: expo-blur BlurView (dark) under a light fill.
 * - Android: no live blur (BlurView needs a blur target there), so a semi-opaque fill.
 * Every surface has a 1 px hairline border, a faint inner top highlight and a soft layered shadow (boxShadow,
 * which React Native draws outside the box only, so the see-through fill stays clean).
 */
import { BlurView } from "expo-blur";
import { useRef, type ReactNode } from "react";
import { Animated, Platform, Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { glass, radius as radii, webStyle } from "@/theme";

const isWeb = Platform.OS === "web";
const isIos = Platform.OS === "ios";

export type GlassTone = "card" | "bar" | "sheet";

const TINT: Record<GlassTone, string> = { card: glass.tint, bar: glass.barTint, sheet: glass.sheetTint };

/** The fill layers only, for a navigator background (tab bar, header) or inside another view. Fills its parent. */
export function GlassFill({ tone = "bar", radius = 0, intensity }: { tone?: GlassTone; radius?: number; intensity?: number }) {
  if (isWeb) {
    return (
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderRadius: radius, backgroundColor: TINT[tone] }, webStyle({ backdropFilter: glass.webBlur, WebkitBackdropFilter: glass.webBlur })]}
      />
    );
  }
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: "hidden" }]}>
      {isIos ? <BlurView tint="dark" intensity={intensity ?? (tone === "card" ? glass.blur : 60)} style={StyleSheet.absoluteFill} /> : null}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: isIos ? TINT[tone] : tone === "card" ? glass.androidFill : "rgba(16,18,24,0.94)" }]} />
      {tone === "card" && isIos ? <View style={[StyleSheet.absoluteFill, { backgroundColor: glass.fill }]} /> : null}
    </View>
  );
}

const shadow: ViewStyle = { boxShadow: glass.shadow };

/** A glass card. `style` sets padding, gap and layout of the content. */
export function Glass({ children, style, radius = radii.lg, tone = "card", shadowed = true }: { children?: ReactNode; style?: StyleProp<ViewStyle>; radius?: number; tone?: GlassTone; shadowed?: boolean }) {
  if (isWeb) {
    return (
      <View
        style={[
          { borderRadius: radius, borderWidth: 1, borderColor: glass.border, backgroundColor: tone === "card" ? `rgba(255,255,255,0.05)` : TINT[tone] },
          webStyle({
            backdropFilter: glass.webBlur,
            WebkitBackdropFilter: glass.webBlur,
            boxShadow: shadowed ? `${glass.innerHighlight}, ${glass.shadow}` : glass.innerHighlight,
            // A slight dark tint under the white fill keeps the text readable over the brightest aurora.
            backgroundImage: tone === "card" ? `linear-gradient(${glass.tint}, ${glass.tint})` : "none",
          }),
          style,
        ]}
      >
        {children}
      </View>
    );
  }
  return (
    <View style={[{ borderRadius: radius }, shadowed && shadow, style]}>
      <GlassFill tone={tone} radius={radius} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.edge, { borderRadius: radius }]} />
      {children}
    </View>
  );
}

const native = !isWeb;

/**
 * A tappable glass card: scales to 0.98 and dims a little on press, then springs back.
 * Keep the touch target 44 px or more.
 */
export function GlassPressable({ children, style, radius = radii.lg, onPress, disabled, ...rest }: Omit<PressableProps, "style" | "children"> & { children?: ReactNode; style?: StyleProp<ViewStyle>; radius?: number }) {
  const v = useRef(new Animated.Value(0)).current;
  const to = (value: number) =>
    Animated.spring(v, { toValue: value, useNativeDriver: native, speed: 40, bounciness: value ? 0 : 6 }).start();
  const scale = v.interpolate({ inputRange: [0, 1], outputRange: [1, 0.98] });
  const opacity = v.interpolate({ inputRange: [0, 1], outputRange: [1, 0.86] });
  return (
    <Pressable onPress={onPress} disabled={disabled} onPressIn={() => to(1)} onPressOut={() => to(0)} {...rest}>
      <Animated.View style={{ transform: [{ scale }], opacity }}>
        <Glass radius={radius} style={style}>
          {children}
        </Glass>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The hairline border and the faint top highlight.
  edge: { borderWidth: StyleSheet.hairlineWidth * 2, borderColor: glass.border, borderTopColor: glass.highlight },
});
