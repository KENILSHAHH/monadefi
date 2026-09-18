import { Platform, type TextStyle } from "react-native";

export const colors = {
  bg: "#0B0D10",
  panel: "#13161B",
  raised: "#1A1E25",
  line: "#252A33",
  ink: "#ECEFF4",
  dim: "#A0A8B5",
  faint: "#6C7480",
  accent: "#836EF9",
  accentSoft: "rgba(131,110,249,0.16)",
  good: "#2BD67B",
  goodSoft: "rgba(43,214,123,0.14)",
  bad: "#FF5A5F",
  badSoft: "rgba(255,90,95,0.14)",
  warn: "#F5A524",
  warnSoft: "rgba(245,165,36,0.14)",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 22 } as const;

const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

export const type = {
  hero: { fontSize: 40, fontWeight: "700", color: colors.ink, fontVariant: ["tabular-nums"], letterSpacing: -1 },
  title: { fontSize: 22, fontWeight: "700", color: colors.ink },
  h2: { fontSize: 17, fontWeight: "600", color: colors.ink },
  body: { fontSize: 15, color: colors.ink },
  small: { fontSize: 13, color: colors.dim },
  tiny: { fontSize: 11, color: colors.faint },
  label: { fontSize: 12, fontWeight: "600", color: colors.faint, textTransform: "uppercase", letterSpacing: 0.8 },
  num: { fontSize: 15, color: colors.ink, fontVariant: ["tabular-nums"] },
  mono: { fontFamily: mono, fontSize: 13, color: colors.ink },
} satisfies Record<string, TextStyle>;
