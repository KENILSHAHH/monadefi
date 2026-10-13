/**
 * The logo of a token, chain or protocol, from the files in assets/logos/ (downloaded once from trusted sources,
 * never loaded from the network at run time). See logoRegistry.ts for the list and the source of each file.
 * - Dark logos (`light: true` in the registry) sit on a white circle, so they stay visible on the dark theme.
 * - A token can carry a small chain badge, for example USDC with the Base badge.
 * - Anything missing gets the first letter in a colored circle.
 */
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { colors, fonts } from "@/theme";
import { CHAIN_LOGOS, PROTOCOL_LOGOS, TOKEN_LOGOS, type LogoEntry } from "./logoRegistry";

export type LogoKind = "token" | "chain" | "protocol";

/** "USDT0" -> "usdt0", "BNB Chain" -> "bnbchain", "LI.FI" -> "lifi". */
export const logoId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Other names that the app or Aurora uses for the same thing.
const ALIASES: Record<LogoKind, Record<string, string>> = {
  token: {
    btcomni: "btc", xbtc: "btc", hemibtc: "btc", wmon: "mon", nrusdt: "usdt", usdt0deprecated: "usdt0", xpldeprecated: "xpl",
    wif: "wif", "1wif": "wif", stnear: "near", gnear: "near", mpdao: "near", usdcx: "usdc", susdc: "usdc", laudc: "usdc",
    gtusdcp: "usdc", mwusdc: "usdc", sparkusdc: "usdc", steakusdc: "usdc", usdcv: "usdc", matic: "pol", wpol: "pol", wbnb: "bnb", wavax: "avax", wsol: "sol",
  },
  chain: {
    ethereum: "eth", mainnet: "eth", arbitrum: "arb", arbitrumone: "arb", optimism: "op", polygon: "pol", bnbchain: "bsc", bnb: "bsc", binance: "bsc",
    avalanche: "avax", solana: "sol", bitcoin: "btc", tron: "tron", trx: "tron", sui: "sui", aptos: "aptos", apt: "aptos", ton: "ton",
    robinhoodchain: "hood", robinhood: "hood", hyperliquid: "hypercore", xrpledger: "xrp", dogecoin: "doge", litecoin: "ltc", bitcoincash: "bch",
    zcash: "zec", abstract: "abs", berachain: "bera", xlayer: "xlayer", monadmainnet: "monad",
  },
  protocol: { auroraintents: "aurora", lifi: "lifi", relaylink: "relay", nansenai: "nansen", curvefinance: "curve", agorafinance: "agora", metamaskdelegationframework: "metamask" },
};

const REGISTRY: Record<LogoKind, Record<string, LogoEntry>> = { token: TOKEN_LOGOS, chain: CHAIN_LOGOS, protocol: PROTOCOL_LOGOS };

/** The entry for an id, also through the aliases and the other kinds (a chain's native token, a protocol's token). */
export function findLogo(kind: LogoKind, raw: string): LogoEntry | null {
  const id = logoId(raw);
  const key = ALIASES[kind][id] ?? id;
  const own = REGISTRY[kind][key];
  if (own) return own;
  const order: LogoKind[] = kind === "token" ? ["chain", "protocol"] : kind === "chain" ? ["token", "protocol"] : ["token", "chain"];
  for (const k of order) {
    const e = REGISTRY[k][ALIASES[k][id] ?? id];
    if (e) return e;
  }
  return null;
}

const FALLBACK_COLORS = ["#836EF9", "#22B8CF", "#2BD67B", "#F5A524", "#FF7A59", "#E06BDB", "#5B8CFF", "#9AA4B2"];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export function Logo({ kind, id, size = 28, badge, style }: { kind: LogoKind; id: string; size?: number; badge?: { kind: LogoKind; id: string } | null; style?: StyleProp<ViewStyle> }) {
  const entry = findLogo(kind, id);
  const round = { width: size, height: size, borderRadius: size / 2 };
  let body;
  if (!entry) {
    const letter = (id.replace(/[^A-Za-z0-9]/g, "")[0] ?? "?").toUpperCase();
    body = (
      <View style={[round, styles.center, { backgroundColor: FALLBACK_COLORS[hash(logoId(id)) % FALLBACK_COLORS.length] }]}>
        <Text style={[styles.letter, { fontSize: size * 0.46, lineHeight: size * 0.6 }]}>{letter}</Text>
      </View>
    );
  } else if (entry.light) {
    const inner = size * 0.72;
    body = (
      <View style={[round, styles.center, styles.white]}>
        <Image source={entry.src} style={{ width: inner, height: inner }} resizeMode="contain" />
      </View>
    );
  } else {
    body = <Image source={entry.src} style={round} resizeMode="cover" />;
  }
  const b = badge ? Math.max(12, Math.round(size * 0.46)) : 0;
  return (
    <View style={[{ width: size, height: size }, style]} accessible={false} importantForAccessibility="no-hide-descendants">
      {body}
      {badge ? (
        <View style={[styles.badge, { width: b + 3, height: b + 3, borderRadius: (b + 3) / 2, right: -3, bottom: -3 }]}>
          <Logo kind={badge.kind} id={badge.id} size={b} />
        </View>
      ) : null}
    </View>
  );
}

/** A logo and a name on one line, for text that mentions a protocol (for example "Nansen" or "Aurora Intents"). */
export function Brand({ id, label, size = 16, color = colors.dim }: { id: string; label: string; size?: number; color?: string }) {
  return (
    <View style={styles.brand}>
      <Logo kind="protocol" id={id} size={size} />
      <Text style={[styles.brandText, { color, fontSize: Math.max(12, size - 2) }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  white: { backgroundColor: "#FFFFFF" },
  letter: { ...fonts.sansBold, color: "#FFFFFF", textAlign: "center" },
  badge: { position: "absolute", backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
  brand: { flexDirection: "row", alignItems: "center", gap: 6 },
  brandText: { ...fonts.sansMedium },
});
