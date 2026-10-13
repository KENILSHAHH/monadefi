import { Platform, type TextStyle, type ViewStyle } from "react-native";
import { FONT_FILES } from "@/lib/fonts";

const isWeb = Platform.OS === "web";

export const colors = {
  bg: "#0B0D10",
  /** An opaque surface, for the few places that must hide what is behind them. */
  solid: "#15181F",
  /** Glass surfaces: translucent, so the northern lights show through. */
  panel: "rgba(255,255,255,0.05)",
  raised: "rgba(255,255,255,0.075)",
  line: "rgba(255,255,255,0.08)",
  ink: "#F1F3F7",
  dim: "#A9B1BE",
  faint: "#7F8795",
  accent: "#836EF9",
  accentSoft: "rgba(131,110,249,0.18)",
  good: "#2BD67B",
  goodSoft: "rgba(43,214,123,0.14)",
  bad: "#FF5A5F",
  badSoft: "rgba(255,90,95,0.14)",
  warn: "#F5A524",
  warnSoft: "rgba(245,165,36,0.14)",
} as const;

/** The one glass style of the app: cards, the tab bar, headers and sheets. */
export const glass = {
  /** A very light white fill over a slight dark tint: see-through, and the text stays readable over the brightest aurora. */
  fill: "rgba(255,255,255,0.055)",
  tint: "rgba(8,10,16,0.22)",
  /** Android has no live blur here: a darker semi-opaque fill instead. */
  androidFill: "rgba(24,27,36,0.72)",
  /** Bars and sheets sit over moving content, so they are a little darker. */
  barTint: "rgba(10,12,18,0.55)",
  sheetTint: "rgba(14,16,22,0.78)",
  border: "rgba(255,255,255,0.08)",
  highlight: "rgba(255,255,255,0.09)",
  blur: 36,
  webBlur: "blur(20px) saturate(140%)",
  shadow: "0px 1px 2px rgba(0,0,0,0.25), 0px 8px 24px rgba(0,0,0,0.35)",
  innerHighlight: "inset 0px 1px 0px rgba(255,255,255,0.07)",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 10, md: 14, lg: 18, xl: 24 } as const;

// ── Fonts ────────────────────────────────────────────────────────────────────
// Coinbase Sans for the UI, Coinbase Display for big numbers and titles, Coinbase Mono for addresses and hashes.
// Each weight is its own family name, the same on every platform:
// - web: public/index.html declares @font-face for each name (files served from /fonts/), with a system fallback.
// - native: expo-font loads the TTFs from lib/fonts.generated.ts. A clone without the licensed files gets an
//   empty map and uses the system font with the matching weight.

type Face = "sans" | "sansMedium" | "sansBold" | "display" | "displayBold" | "mono" | "monoMedium";
const FACES: Record<Face, [family: string, weight: TextStyle["fontWeight"]]> = {
  sans: ["CoinbaseSans-Regular", "400"],
  sansMedium: ["CoinbaseSans-Medium", "500"],
  sansBold: ["CoinbaseSans-Bold", "700"],
  display: ["CoinbaseDisplay-Medium", "500"],
  displayBold: ["CoinbaseDisplay-Bold", "700"],
  mono: ["CoinbaseMono-Regular", "400"],
  monoMedium: ["CoinbaseMono-Medium", "500"],
};
const SANS_STACK = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const nativeFonts = !isWeb && Object.keys(FONT_FILES).length > 0;
const systemMono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

/** The text style for one face. Spread it into a style; do not add a fontWeight next to it. */
export function font(face: Face): TextStyle {
  const [family, weight] = FACES[face];
  const isMono = face.startsWith("mono");
  if (isWeb) return { fontFamily: `${family}, ${isMono ? MONO_STACK : SANS_STACK}`, fontWeight: weight };
  // A custom family plus a fontWeight makes Android draw a fake bold. The weight is in the family name.
  if (nativeFonts) return { fontFamily: family };
  return isMono ? { fontFamily: systemMono, fontWeight: weight } : { fontWeight: weight };
}

export const fonts = {
  sans: font("sans"),
  sansMedium: font("sansMedium"),
  sansBold: font("sansBold"),
  display: font("display"),
  displayBold: font("displayBold"),
  mono: font("mono"),
  monoMedium: font("monoMedium"),
} as const;

const tabular: TextStyle["fontVariant"] = ["tabular-nums"];

export const type = {
  /** Screen titles. */
  largeTitle: { ...fonts.displayBold, fontSize: 30, lineHeight: 36, color: colors.ink, letterSpacing: -0.4 },
  /** Balances and prices. */
  hero: { ...fonts.displayBold, fontSize: 40, lineHeight: 46, color: colors.ink, fontVariant: tabular, letterSpacing: -0.8 },
  title: { ...fonts.displayBold, fontSize: 22, lineHeight: 28, color: colors.ink, letterSpacing: -0.2 },
  h2: { ...fonts.sansBold, fontSize: 17, lineHeight: 22, color: colors.ink },
  body: { ...fonts.sans, fontSize: 15, lineHeight: 21, color: colors.ink },
  small: { ...fonts.sans, fontSize: 13, lineHeight: 18, color: colors.dim },
  tiny: { ...fonts.sans, fontSize: 11.5, lineHeight: 15, color: colors.faint },
  label: { ...fonts.sansMedium, fontSize: 12, lineHeight: 16, color: colors.faint, textTransform: "uppercase", letterSpacing: 0.7 },
  num: { ...fonts.sansMedium, fontSize: 15, lineHeight: 20, color: colors.ink, fontVariant: tabular },
  numBold: { ...fonts.sansBold, fontSize: 16, lineHeight: 21, color: colors.ink, fontVariant: tabular },
  mono: { ...fonts.mono, fontSize: 13, lineHeight: 18, color: colors.ink, fontVariant: tabular },
} satisfies Record<string, TextStyle>;

/** Web-only style keys (CSS) that React Native's types do not list. */
export const webStyle = (s: Record<string, string | number>): ViewStyle & TextStyle => (isWeb ? (s as ViewStyle & TextStyle) : {});
