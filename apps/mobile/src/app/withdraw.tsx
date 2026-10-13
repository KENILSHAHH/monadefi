import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { isAddress, type Address } from "viem";
import { Button, Card, Chip, KeyValue, LinkText, Notice, Screen, Segmented, haptic } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fixed, parseAmount } from "@/lib/format";
import { keys, useBalance, useSessionStatus } from "@/lib/queries";
import { ensureSession } from "@/lib/session";
import { ausdTransferCall, perplWithdrawCall, relay } from "@/lib/wallet";
import { colors, radius, space, type } from "@/theme";

type Mode = "perpl" | "wallet";

/**
 * Withdrawals are outside the trading permission on purpose. The wallet signs a one-time relay
 * for the exact calls (no prompt, the sponsor pays the gas).
 */
export default function Withdraw() {
  const qc = useQueryClient();
  const balance = useBalance(8_000);
  const session = useSessionStatus();
  const [mode, setMode] = useState<Mode>("perpl");
  const [amountText, setAmountText] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const max = mode === "perpl" ? (balance.data?.ausd.perplFree ?? 0) : (balance.data?.ausd.wallet ?? 0);
  const amount = parseAmount(amountText);
  const toOk = mode === "perpl" || isAddress(to.trim());
  const problem = !amount ? null : amount > max + 1e-9 ? `You can move up to ${fixed(max, 2)} AUSD from here.` : !toOk ? "Enter a valid 0x address on Monad." : null;
  const upgraded = session.data?.upgraded ?? false;
  const [upgrading, setUpgrading] = useState(false);

  // The one-time smart account upgrade grants no permission, so it runs here even after a revoke. No prompt.
  useEffect(() => {
    if (!session.data || upgraded) return;
    setUpgrading(true);
    void ensureSession({ upgradeOnly: true }).finally(() => {
      setUpgrading(false);
      void qc.invalidateQueries({ queryKey: keys.session });
    });
  }, [session.data, upgraded, qc]);

  async function submit() {
    if (!amount || problem) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const call = mode === "perpl" ? perplWithdrawCall(amount) : ausdTransferCall(to.trim() as Address, amount);
      const r = await relay([call]);
      if (r.status !== "success") throw new Error("The transaction reverted on Monad. No funds moved.");
      haptic.success();
      setDone(r.explorer);
      setAmountText("");
      void qc.invalidateQueries({ queryKey: keys.balance });
      void qc.invalidateQueries({ queryKey: keys.activity });
    } catch (e) {
      haptic.error();
      setError(errorMessage(e, "The withdrawal was not sent."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen edges={["bottom"]}>
      <Segmented value={mode} onChange={(m) => { setMode(m); setDone(null); setError(null); }} options={[{ value: "perpl", label: "Perpl → wallet" }, { value: "wallet", label: "Wallet → address" }]} />

      {session.data && !upgraded && (
        <Notice tone="accent" icon="key-outline">
          {upgrading ? "Setting up your smart account for gasless withdrawals. This takes a few seconds." : "Gasless withdrawals need the one-time smart account upgrade. It did not finish yet: try again in a moment."}
        </Notice>
      )}

      <Card style={styles.gap}>
        <KeyValue label={mode === "perpl" ? "Free on Perpl" : "AUSD in wallet"} value={`${fixed(max, 2)} AUSD`} />
        {mode === "perpl" && <Text style={type.tiny}>Only the free balance can leave Perpl. Margin in open positions stays.</Text>}
        <View style={styles.amountRow}>
          <TextInput value={amountText} onChangeText={setAmountText} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.faint} style={styles.amount} accessibilityLabel="Amount in AUSD" />
          <Chip label="Max" onPress={() => setAmountText(fixed(Math.floor(max * 100) / 100, 2).replace(/,/g, ""))} />
        </View>
        {mode === "wallet" && (
          <TextInput value={to} onChangeText={setTo} placeholder="0x… address on Monad" placeholderTextColor={colors.faint} style={styles.input} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Destination address" />
        )}
      </Card>

      {problem && <Notice>{problem}</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}
      {done && (
        <Card style={styles.gap}>
          <Notice tone="good">Sent on Monad.</Notice>
          <LinkText url={done} label="View on Monadscan" />
        </Card>
      )}

      {session.data && !upgraded ? (
        <Button title={upgrading ? "Setting up the smart account" : "Try the setup again"} variant="secondary" loading={upgrading} disabled={upgrading} onPress={() => { setUpgrading(true); void ensureSession({ upgradeOnly: true }).finally(() => { setUpgrading(false); void qc.invalidateQueries({ queryKey: keys.session }); }); }} />
      ) : (
        <Button title={mode === "perpl" ? "Withdraw to wallet" : "Send AUSD"} icon="arrow-up" loading={busy} disabled={!amount || Boolean(problem)} onPress={() => void submit()} />
      )}
      <Text style={[type.tiny, styles.center]}>Signed on this phone for these exact calls only. The permission ends in 10 minutes and works once.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  gap: { gap: space.sm },
  center: { textAlign: "center" },
  amountRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  amount: { flex: 1, fontSize: 32, fontWeight: "700", color: colors.ink, fontVariant: ["tabular-nums"] },
  input: { backgroundColor: colors.raised, borderRadius: radius.md, color: colors.ink, paddingHorizontal: space.md, height: 46, fontSize: 15 },
});
