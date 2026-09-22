import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import type { Intent } from "@/lib/api/types";
import { usd } from "@/lib/format";
import { keys } from "@/lib/queries";
import { colors, space, type } from "@/theme";
import { IntentResultView, IntentRows, StatusPill, intentTitle } from "./IntentDetails";
import { Button, Notice, haptic } from "./ui";

/** The text of packages/core wrapSessionTransactions when trading is off or the session ended. */
const SESSION_ERROR = /trading is not turned on|session ended/i;

/**
 * An intent with Confirm and Reject. Confirm runs it through the scoped session: the server's agent key
 * redeems the delegation, so the phone shows no prompt here.
 */
export function IntentConfirm({
  intent: initial, onSettled, compact, onOpenSession,
}: {
  intent: Intent;
  onSettled?: (i: Intent) => void;
  compact?: boolean;
  /** Called before the app opens the trading permission screen, for example to close a sheet. */
  onOpenSession?: () => void;
}) {
  const qc = useQueryClient();
  const [intent, setIntent] = useState(initial);
  const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSession, setNeedsSession] = useState(false);
  // A newer state of the same intent from the chat stream wins over the local one while it is pending.
  const shown = intent.status === "pending" && initial.status !== "pending" ? initial : intent;

  async function decide(action: "confirm" | "reject") {
    setError(null);
    setNeedsSession(false);
    setBusy(action);
    if (action === "confirm") haptic.impact();
    try {
      const next = action === "confirm" ? await api.intents.confirm(shown.id) : await api.intents.reject(shown.id);
      setIntent(next);
      if (next.status === "done") haptic.success();
      if (next.status === "failed") {
        haptic.error();
        // The server returns the failed intent (HTTP 200) when the session is off or ended.
        if (SESSION_ERROR.test(String(next.result?.error ?? ""))) setNeedsSession(true);
      }
      onSettled?.(next);
      void qc.invalidateQueries({ queryKey: keys.positions });
      void qc.invalidateQueries({ queryKey: keys.balance });
      void qc.invalidateQueries({ queryKey: keys.activity });
    } catch (e) {
      haptic.error();
      const msg = errorMessage(e, "The order was not sent.");
      if (e instanceof ApiError && SESSION_ERROR.test(msg)) setNeedsSession(true);
      setError(msg);
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={compact ? type.h2 : type.title}>{intentTitle(shown)}</Text>
        <StatusPill status={shown.status} />
      </View>
      <IntentRows intent={shown} />
      <IntentResultView intent={shown} />
      {error && <Notice tone="bad">{error}</Notice>}
      {needsSession && <Button title="Turn on trading" variant="secondary" icon="key-outline" onPress={() => { onOpenSession?.(); router.push("/session"); }} />}
      {shown.status === "pending" && (
        <>
          <Text style={[type.small, styles.fee]}>
            {busy === "confirm" ? "Sending to Perpl on Monad. This takes a few seconds." : `Mona-DeFi fee ${usd(shown.feeUsd)} · no passkey prompt, signed by your trading permission`}
          </Text>
          <View style={styles.buttons}>
            <Button title="Reject" variant="secondary" onPress={() => void decide("reject")} disabled={busy !== null} loading={busy === "reject"} style={styles.flex} compact={compact} />
            <Button title="Confirm" variant="primary" icon="checkmark" onPress={() => void decide("confirm")} disabled={busy !== null} loading={busy === "confirm"} style={styles.flex2} compact={compact} />
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.md, marginBottom: space.xs },
  fee: { color: colors.dim, marginTop: space.xs },
  buttons: { flexDirection: "row", gap: space.md, marginTop: space.xs },
  flex: { flex: 1 },
  flex2: { flex: 2 },
});
