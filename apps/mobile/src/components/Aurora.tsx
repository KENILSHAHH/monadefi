/**
 * Northern lights behind the main screens (native). Three large soft blobs (SVG radial gradients) in Monad purple,
 * teal and a hint of green drift and change shape in slow 20–40 s loops at low opacity.
 * Only transform and opacity animate, on the native driver. Reduced motion: a static picture.
 * The web build uses Aurora.web.tsx (CSS).
 */
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, useWindowDimensions, View } from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";

type BlobSpec = { id: string; color: string; alpha: number; size: number; x: number; y: number; dx: number; dy: number; sx: number; sy: number; duration: number };

// Positions and sizes are fractions of the screen width/height.
const BLOBS: BlobSpec[] = [
  { id: "purple", color: "#836EF9", alpha: 0.34, size: 1.25, x: -0.35, y: -0.2, dx: 0.25, dy: 0.12, sx: 1.18, sy: 0.88, duration: 32_000 },
  { id: "teal", color: "#22D3C5", alpha: 0.2, size: 1.1, x: 0.3, y: 0.05, dx: -0.22, dy: 0.18, sx: 0.9, sy: 1.15, duration: 26_000 },
  { id: "green", color: "#34E89E", alpha: 0.1, size: 0.95, x: -0.1, y: 0.45, dx: 0.18, dy: -0.14, sx: 1.12, sy: 0.92, duration: 38_000 },
];

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => live && setReduced(v)).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

function Blob({ spec, width, height, still }: { spec: BlobSpec; width: number; height: number; still: boolean }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (still) {
      t.setValue(0.5);
      return;
    }
    const half = spec.duration / 2;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, { toValue: 1, duration: half, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(t, { toValue: 0, duration: half, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [still, spec.duration, t]);

  const d = spec.size * Math.max(width, height * 0.75);
  const style = {
    position: "absolute" as const,
    width: d,
    height: d,
    left: spec.x * width,
    top: spec.y * height,
    opacity: t.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.75, 1, 0.8] }),
    transform: [
      { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, spec.dx * width] }) },
      { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, spec.dy * height] }) },
      { scaleX: t.interpolate({ inputRange: [0, 1], outputRange: [1, spec.sx] }) },
      { scaleY: t.interpolate({ inputRange: [0, 1], outputRange: [1, spec.sy] }) },
    ],
  };
  return (
    <Animated.View style={style} pointerEvents="none">
      <Svg width="100%" height="100%" viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id={`g-${spec.id}`} cx="50" cy="50" r="50" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={spec.color} stopOpacity={spec.alpha} />
            <Stop offset="0.45" stopColor={spec.color} stopOpacity={spec.alpha * 0.45} />
            <Stop offset="1" stopColor={spec.color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx="50" cy="50" r="50" fill={`url(#g-${spec.id})`} />
      </Svg>
    </Animated.View>
  );
}

/** Put it first inside a container with the page color; the screens above it need a transparent background. */
export function Aurora() {
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  return (
    <View style={styles.layer} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {BLOBS.map((b) => (
        <Blob key={b.id} spec={b} width={width} height={height} still={reduced} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, overflow: "hidden" },
});
