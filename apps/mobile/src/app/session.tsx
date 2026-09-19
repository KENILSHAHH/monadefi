import Ionicons from "@expo/vector-icons/Ionicons";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button, Card, Chip, ErrorState, LinkText, Notice, Screen, Skeleton, haptic } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { shortDate } from "@/lib/format";
import { keys, useSessionStatus } from "@/lib/queries";
import { enableTrading, type SetupStep } from "@/lib/wallet";
import { colors, radius, space, type } from "@/theme";

const CAN = ["Place and close Perpl orders", "Add margin to your positions", "Move AUSD into Perpl"];
const CANNOT = ["Withdraw from Perpl", "Transfer AUSD or any token", "Spend other tokens or call other contracts"];
const DAYS = [7, 30, 90] as const;

const STEP_TEXT: Record<Exclude<SetupStep, "done">, string> = {
  upgrade: "Upgrading your wallet to a smart account on Monad (EIP-7702). The gas is paid for you.",
  start: "Preparing the two scoped permissions…",
  grant: "Signing the permissions on this phone. No prompt.",
};

/** The scope screen and the one-tap setup of prompt-free trading. */
export default function SessionSetup() {
  const qc = useQueryClient();
  const session = useSessionStatus();
  const [days, setDays] = useState<(typeof DAYS)[number]>(30);
  const [step, setStep] = useState<SetupStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upgradeTx, setUpgradeTx] = useState<string | null>(null);
  const ends = new Date(Date.now() + days * 86_400_000).toISOString();
  const active = session.data?.status === "active";
  const activeUntil = session.data?.permissions.filter((p) => p.status === "active").map((p) => p.expiresAt).sort()[0];

  async function run() {
    setError(null);
    try {
      const r = await enableTrading(days, (s) => setStep(s));
      setUpgradeTx(r.upgradeTx);
      haptic.success();
      await qc.invalidateQueries({ queryKey: keys.session });
    } catch (e) {
      haptic.error();
      setStep(null);
      setError(errorMessage(e, "Trading could not be turned on."));
    }
  }

  return (
    <Screen edges={["bottom"]}>
      <View style={styles.hero}>
        <View style={styles.badge}>
          <Ionicons name="key" size={22} color={colors.accent} />
        </View>
        <Text style={[type.title, styles.center]}>{active ? "Trading is on" : "Turn on prompt-free trading"}</Text>
        <Text style={[type.small, styles.center]}>
          Your wallet signs two narrow permissions for the Mona-DeFi agent key. They are checked on-chain by the MetaMask Delegation Framework on Monad.
        </Text>
      </View>

      <Card style={styles.gap}>
        <Text style={type.label}>Mona-DeFi can</Text>
        {CAN.map((c) => (
          <Line key={c} ok text={c} />
        ))}
        <Text style={[type.label, styles.top]}>Mona-DeFi cannot</Text>
        {CANNOT.map((c) => (
          <Line key={c} ok={false} text={c} />
        ))}
        {session.data?.scope && (
          <Text style={[type.tiny, styles.top]}>
            Contracts: {session.data.scope.targets.map((t) => `${t.slice(0, 8)}…`).join(", ")} · Functions: {session.data.scope.functions.join(", ")}
          </Text>
        )}
      </Card>

      {session.isLoading ? (
        <Skeleton height={120} />
      ) : session.error ? (
        <ErrorState message={errorMessage(session.error)} onRetry={() => void session.refetch()} />
      ) : active ? (
        <Card style={styles.gap}>
          <Notice tone="good">Active. Ends {activeUntil ? shortDate(activeUntil) : "—"}. You can revoke it in Settings at any time.</Notice>
          {upgradeTx && <LinkText url={upgradeTx} label="Wallet upgrade on Monadscan" />}
          <Button title="Done" onPress={() => router.back()} />
        </Card>
      ) : (
        <Card style={styles.gap}>
          <Text style={type.label}>Length</Text>
          <View style={styles.chips}>
            {DAYS.map((d) => (
              <Chip key={d} label={`${d} days`} active={d === days} onPress={() => setDays(d)} />
            ))}
          </View>
          <Text style={type.small}>Ends {shortDate(ends)}. It also ends when you revoke it.</Text>
          {session.data?.status === "needs_upgrade" && (
            <Text style={type.small}>First use: your wallet becomes a smart account with one gasless transaction. Your address does not change.</Text>
          )}
          {step && step !== "done" && (
            <View style={styles.step}>
              <Ionicons name="sync" size={16} color={colors.accent} />
              <Text style={[type.small, styles.flex]}>{STEP_TEXT[step]}</Text>
            </View>
          )}
          {error && <Notice tone="bad">{error}</Notice>}
          <Button title="Turn on trading" icon="flash" loading={step !== null && step !== "done"} onPress={() => void run()} />
        </Card>
      )}
    </Screen>
  );
}

function Line({ ok, text }: { ok: boolean; text: string }) {
  return (
    <View style={styles.line}>
      <Ionicons name={ok ? "checkmark-circle" : "close-circle"} size={18} color={ok ? colors.good : colors.bad} />
      <Text style={type.body}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: "center" },
  hero: { alignItems: "center", gap: space.sm, marginTop: space.sm },
  badge: { width: 52, height: 52, borderRadius: radius.lg, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" },
  gap: { gap: space.sm },
  top: { marginTop: space.md },
  line: { flexDirection: "row", alignItems: "center", gap: space.sm },
  chips: { flexDirection: "row", gap: space.sm },
  step: { flexDirection: "row", gap: space.sm, alignItems: "center", backgroundColor: colors.accentSoft, padding: space.md, borderRadius: radius.md },
});
