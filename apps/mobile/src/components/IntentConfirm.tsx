import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { api, errorMessage } from "@/lib/api/client";
import type { Intent } from "@/lib/api/types";
import { usd } from "@/lib/format";
import { keys } from "@/lib/queries";
import { ensureSession, ensureSessionBefore, isSessionConflict, isSessionFailure, sessionManager } from "@/lib/session";
import { colors, space, type } from "@/theme";
import { IntentResultView, IntentRows, StatusPill, intentTitle } from "./IntentDetails";
import { Logo } from "./Logo";
import { Button, Notice, haptic } from "./ui";

/**
 * An intent with Confirm and Reject. Confirm runs it through the scoped session: the server's agent key
 * redeems the delegation, so the phone shows no prompt here.
 *
 * Before Confirm, the app makes sure the session is active (a fast no-op when it is). When the server still
 * says the session is off (`result.code: "session_inactive"`, or a 409 about the session), the app sets it up
 * again and retries once by itself.
 */
export function IntentConfirm({
  intent: initial, onSettled, compact, onOpenSession, onRetry,
}: {
  intent: Intent;
  onSettled?: (i: Intent) => void;
  compact?: boolean;
  /** Called before the app opens Settings (to restore trading access), for example to close a sheet. */
  onOpenSession?: () => void;
  /**
   * A failed intent cannot run again. This gives a new pending intent for the same order (for example a new
   * preview), which the app then confirms once by itself. Return null when that is not possible.
   */
  onRetry?: () => Promise<Intent | null>;
}) {
  const qc = useQueryClient();
  const [intent, setIntent] = useState(initial);
  const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSession, setNeedsSession] = useState(false);
  // A newer state of the same intent from the chat stream wins over the local one while it is pending.
  const shown = intent.status === "pending" && initial.status !== "pending" ? initial : intent;
  const market = typeof shown.preview?.market === "string" ? shown.preview.market : null;

  /** Set the session up again after the server said it is off. Returns false (and shows why) when it is still off. */
  async function repairSession(): Promise<boolean> {
    sessionManager.invalidate();
    const r = await ensureSession();
    if (r.state === "active") return true;
    if (r.state === "revoked") setNeedsSession(true);
    else setError(r.state === "error" ? r.error : "Unlock the app to trade.");
    return false;
  }

  async function confirmOnce(id: string): Promise<Intent> {
    try {
      return await api.intents.confirm(id);
    } catch (e) {
      // A 409 about the session: the intent is still pending, so set the session up and confirm it again once.
      if (isSessionConflict(e) && (await repairSession())) return api.intents.confirm(id);
      throw e;
    }
  }

  async function confirm(): Promise<Intent> {
    await ensureSessionBefore();
    let next = await confirmOnce(shown.id);
    if (next.status === "failed" && isSessionFailure(next.result)) {
      setIntent(next);
      if (await repairSession()) {
        const fresh = onRetry ? await onRetry().catch(() => null) : null;
        if (fresh && fresh.status === "pending") {
          setIntent(fresh);
          next = await api.intents.confirm(fresh.id);
        } else if (!onRetry) {
          setError("Trading access was off and is on again now. Ask the agent to prepare the order again.");
        }
      }
    }
    return next;
  }

  async function decide(action: "confirm" | "reject") {
    setError(null);
    setNeedsSession(false);
    setBusy(action);
    if (action === "confirm") haptic.impact();
    try {
      const next = action === "confirm" ? await confirm() : await api.intents.reject(shown.id);
      setIntent(next);
      if (next.status === "done") haptic.success();
      if (next.status === "failed") haptic.error();
      onSettled?.(next);
      void qc.invalidateQueries({ queryKey: keys.positions });
      void qc.invalidateQueries({ queryKey: keys.balance });
      void qc.invalidateQueries({ queryKey: keys.activity });
    } catch (e) {
      haptic.error();
      setError(errorMessage(e, "The order was not sent."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Logo kind={market ? "token" : "protocol"} id={market ?? (shown.kind === "perpl" ? "perpl" : "monad")} size={compact ? 32 : 40} badge={market && shown.kind === "perpl" ? { kind: "protocol", id: "perpl" } : null} />
        <View style={styles.titleBox}>
          <Text style={compact ? type.h2 : type.title} numberOfLines={2}>
            {intentTitle(shown)}
            {market ? ` · ${market}` : ""}
          </Text>
          <StatusPill status={shown.status} />
        </View>
      </View>
      <IntentRows intent={shown} />
      <IntentResultView intent={shown} />
      {error && <Notice tone="bad">{error}</Notice>}
      {needsSession && (
        <>
          <Notice tone="accent" icon="key-outline">Trading access is off because you revoked it. Restore it in Settings to confirm orders.</Notice>
          <Button title="Open Settings" variant="secondary" icon="settings-outline" onPress={() => { onOpenSession?.(); router.push("/settings"); }} />
        </>
      )}
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
  head: { flexDirection: "row", alignItems: "center", gap: space.md, marginBottom: space.xs },
  titleBox: { flex: 1, gap: 4 },
  fee: { color: colors.dim, marginTop: space.xs },
  buttons: { flexDirection: "row", gap: space.md, marginTop: space.xs },
  flex: { flex: 1 },
  flex2: { flex: 2 },
});
