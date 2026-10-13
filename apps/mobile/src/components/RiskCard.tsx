import Ionicons from "@expo/vector-icons/Ionicons";
import { StyleSheet, Text, View } from "react-native";
import type { RiskSegment, RiskSignal, RiskVerdict } from "@/lib/api/types";
import { num } from "@/lib/format";
import { colors, fonts, radius, space, type } from "@/theme";
import { Brand, Logo } from "./Logo";
import { Card, Pill } from "./ui";

const SEGMENT_LABEL: Record<RiskSegment, string> = {
  smart_money: "Smart money",
  whales: "Whales",
  exchanges: "Exchanges",
  fresh_wallets: "Fresh wallets",
  top_holders: "Top holders",
  public_figures: "Public figures",
  concentration: "Concentration",
  trader: "Your trading record",
};

const DECISION: Record<RiskVerdict["decision"], { label: string; tone: "good" | "warn" | "bad"; icon: "shield-checkmark" | "shield-half" | "close-circle" }> = {
  allow: { label: "Allowed", tone: "good", icon: "shield-checkmark" },
  reduce: { label: "Reduced", tone: "warn", icon: "shield-half" },
  block: { label: "Blocked", tone: "bad", icon: "close-circle" },
};

const LEVEL_TONE = { low: "good", medium: "warn", high: "bad", extreme: "bad" } as const;

const toneColor = { good: colors.good, warn: colors.warn, bad: colors.bad };

/** The Nansen risk verdict: decision, level, the exact changes, and the wallet-segment signals behind them. */
export function RiskCard({ risk }: { risk: RiskVerdict }) {
  const d = DECISION[risk.decision];
  const scorePct = Math.max(0, Math.min(100, (risk.score + 100) / 2));
  return (
    <Card style={[styles.card, { borderColor: `${toneColor[d.tone]}88`, borderWidth: 1 }]}>
      <View style={styles.head}>
        <View>
          <Logo kind="protocol" id="nansen" size={36} />
          <View style={[styles.decision, { backgroundColor: toneColor[d.tone] }]}>
            <Ionicons name={d.icon} size={11} color="#0B0D10" />
          </View>
        </View>
        <View style={styles.flex}>
          <Text style={type.h2}>Nansen risk check: {d.label}</Text>
          <Text style={type.small}>
            {risk.market} {risk.side} · {risk.dataAvailable ? `score ${num(risk.score, 0)} of ±100` : "no Nansen data"}
          </Text>
        </View>
        <Pill label={`${risk.level.toUpperCase()} RISK`} tone={LEVEL_TONE[risk.level]} />
      </View>

      {risk.dataAvailable && (
        <View style={styles.meter} accessibilityLabel={`Score ${Math.round(risk.score)}. Negative is against the trade.`}>
          <View style={styles.meterTrack} />
          <View style={[styles.meterMid]} />
          <View style={[styles.meterDot, { left: `${scorePct}%`, backgroundColor: risk.score >= 0 ? colors.good : colors.bad }]} />
          <View style={styles.meterLabels}>
            <Text style={type.tiny}>Against the trade</Text>
            <Text style={type.tiny}>With the trade</Text>
          </View>
        </View>
      )}

      {!risk.dataAvailable && (
        <Text style={type.small}>Nansen has no data for this market now. Mona-DeFi uses its default limits for the trade.</Text>
      )}

      {risk.changes.length > 0 && (
        <View style={styles.block}>
          <Text style={type.label}>What changes</Text>
          {risk.changes.map((c) => (
            <View key={c} style={styles.change}>
              <Ionicons name="arrow-forward-circle" size={16} color={colors.warn} style={styles.icon} />
              <Text style={[type.body, styles.flex]}>{c}</Text>
            </View>
          ))}
        </View>
      )}

      {risk.signals.length > 0 && (
        <View style={styles.block}>
          <Text style={type.label}>Signals</Text>
          {risk.signals.map((s) => (
            <SignalRow key={s.id} signal={s} />
          ))}
        </View>
      )}

      {risk.reasons.length > 0 && risk.changes.length === 0 && (
        <View style={styles.block}>
          {risk.reasons.map((r) => (
            <Text key={r} style={type.small}>
              {r}
            </Text>
          ))}
        </View>
      )}
      <View style={styles.footerRow}>
        <Brand id="nansen" label="Wallet labels and flows by Nansen" size={14} color={colors.faint} />
        <Text style={type.tiny}>
          {risk.cached ? "cached" : "live"} · {new Date(risk.asOf).toLocaleTimeString()}
        </Text>
      </View>
    </Card>
  );
}

function SignalRow({ signal }: { signal: RiskSignal }) {
  const icon = signal.direction === "with_trade" ? "trending-up" : signal.direction === "against_trade" ? "trending-down" : "remove";
  const color = signal.direction === "with_trade" ? colors.good : signal.direction === "against_trade" ? colors.bad : colors.faint;
  return (
    <View style={styles.signal}>
      <View style={[styles.signalIcon, { backgroundColor: `${color}22` }]}>
        <Ionicons name={icon} size={14} color={color} />
      </View>
      <View style={styles.flex}>
        <Text style={[type.small, styles.segment]}>{SEGMENT_LABEL[signal.segment] ?? signal.segment}</Text>
        <Text style={type.small}>{signal.label}</Text>
      </View>
      <Text style={[type.tiny, styles.window]}>{signal.window}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { gap: space.md },
  head: { flexDirection: "row", alignItems: "center", gap: space.md },
  meter: { height: 34, justifyContent: "flex-start" },
  meterTrack: { position: "absolute", top: 6, left: 0, right: 0, height: 4, borderRadius: 2, backgroundColor: colors.raised },
  meterMid: { position: "absolute", top: 2, left: "50%", width: 1, height: 12, backgroundColor: colors.line },
  meterDot: { position: "absolute", top: 2, width: 12, height: 12, borderRadius: 6, marginLeft: -6, borderWidth: 2, borderColor: colors.bg },
  meterLabels: { position: "absolute", top: 18, left: 0, right: 0, flexDirection: "row", justifyContent: "space-between" },
  block: { gap: space.sm },
  change: { flexDirection: "row", gap: space.sm, backgroundColor: colors.warnSoft, padding: space.md, borderRadius: radius.md },
  icon: { marginTop: 2 },
  signal: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 4 },
  signalIcon: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  window: { alignSelf: "flex-start", marginTop: 2 },
  footerRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  segment: { ...fonts.sansBold, color: colors.ink },
  decision: { position: "absolute", right: -3, bottom: -3, width: 17, height: 17, borderRadius: 9, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#0B0D10" },
});
