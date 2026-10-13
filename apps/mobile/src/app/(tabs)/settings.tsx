import Ionicons from "@expo/vector-icons/Ionicons";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button, Card, confirmAction, CopyButton, KeyValue, LinkText, Notice, Pill, Screen, SectionTitle, Skeleton, haptic } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { useAuth, useAddress } from "@/lib/auth/AuthProvider";
import { addressUrl, config } from "@/lib/config";
import { shortDate, short } from "@/lib/format";
import { EVM_PATH } from "@/lib/mera/derive";
import { keys, useSessionStatus } from "@/lib/queries";
import { sessionManager, useTradingSession } from "@/lib/session";
import { colors, space, type } from "@/theme";

const STATUS_LABEL = { none: "Off", needs_upgrade: "Off", needs_signature: "Setting up", active: "On", expired: "Ended" } as const;
const PHASE_TEXT = { checking: "Checking trading access…", upgrading: "Upgrading your wallet to a smart account (gasless)…", granting: "Signing the scoped permissions on this phone…" } as const;

const CAN = ["Place and close Perpl orders", "Add margin to your positions", "Move AUSD into Perpl"];
const CANNOT_DEFAULT = ["Withdraw", "Transfer AUSD or any token", "Call other contracts"];
const cannotLabel = (c: string) => ({ withdraw: "Withdraw", transfer: "Transfer AUSD or any token" })[c.toLowerCase()] ?? c;

export default function Settings() {
  const address = useAddress();
  const { lock, signOut } = useAuth();
  const qc = useQueryClient();
  const session = useSessionStatus();
  const auto = useTradingSession();
  const [revoking, setRevoking] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; link?: string } | null>(null);

  const s = session.data;
  const activeUntil = s?.permissions.filter((p) => p.status === "active").map((p) => p.expiresAt).sort()[0] ?? auto.endsAt ?? undefined;
  const revoked = auto.phase === "revoked";
  const working = auto.phase === "checking" || auto.phase === "upgrading" || auto.phase === "granting";
  const cannot = s?.scope?.cannot?.length ? [...s.scope.cannot.map(cannotLabel), "Call other contracts"] : CANNOT_DEFAULT;

  function confirmRevoke() {
    confirmAction(
      "Revoke trading access?",
      "Mona-DeFi can no longer place orders for you. Open positions stay open. Trading stays off until you restore it here or sign in again.",
      "Revoke",
      () => void revoke(),
    );
  }

  async function restore() {
    setRestoring(true);
    setNote(null);
    const r = await sessionManager.restore();
    setRestoring(false);
    void qc.invalidateQueries({ queryKey: keys.session });
    if (r.state === "error") {
      haptic.error();
      setNote({ ok: false, text: r.error });
    } else haptic.success();
  }

  async function revoke() {
    setRevoking(true);
    setNote(null);
    try {
      // The wallet also disables the delegations on-chain with the calls from the server (gasless, no prompt).
      const { link } = await sessionManager.revoke();
      haptic.success();
      setNote({ ok: true, text: link ? "Revoked on the server and on-chain." : "Revoked. The server deleted the permission signatures.", ...(link ? { link } : {}) });
    } catch (e) {
      haptic.error();
      setNote({ ok: false, text: errorMessage(e, "The permission was not revoked.") });
    } finally {
      setRevoking(false);
      void qc.invalidateQueries({ queryKey: keys.session });
    }
  }

  function confirmSignOut() {
    confirmAction("Sign out?", "Mona-DeFi ends the key and deletes the local hints. Your account stays with your passkey: sign in again at any time.", "Sign out", () => void signOut());
  }

  return (
    <Screen>
      <Text style={type.title}>Settings</Text>

      <SectionTitle title="Account" />
      <Card>
        <Text style={type.small}>Your address on Monad and every EVM chain</Text>
        <Text style={[type.mono, styles.address]} selectable>
          {address}
        </Text>
        <View style={styles.row}>
          <CopyButton value={address} />
          <LinkText url={addressUrl(address)} label="Monadscan" />
        </View>
      </Card>

      <SectionTitle title="Trading access" />
      <Card style={styles.gap}>
        {session.isLoading ? (
          <Skeleton height={60} />
        ) : session.error ? (
          <Text style={[type.small, { color: colors.warn }]}>{errorMessage(session.error)}</Text>
        ) : s ? (
          <>
            <View style={styles.between}>
              <Text style={type.h2}>Prompt-free trading</Text>
              <Pill
                label={revoked ? "Revoked" : working ? "Setting up" : STATUS_LABEL[s.status]}
                tone={s.status === "active" && !revoked ? "good" : revoked || s.status === "expired" ? "warn" : "dim"}
              />
            </View>
            <Text style={type.small}>A scoped permission that your wallet signed on this phone. The Mona-DeFi agent key uses it, and the MetaMask Delegation Framework checks it on-chain.</Text>
            <Text style={[type.label, styles.top]}>Mona-DeFi can</Text>
            {CAN.map((c) => (
              <ScopeLine key={c} ok text={c} />
            ))}
            <Text style={[type.label, styles.top]}>Mona-DeFi cannot</Text>
            {cannot.map((c) => (
              <ScopeLine key={c} ok={false} text={c} />
            ))}
            {s.status === "active" && !revoked && <Text style={type.small}>Ends {activeUntil ? shortDate(activeUntil) : "—"}. Mona-DeFi renews it by itself before it ends.</Text>}
            {working && <Text style={type.small}>{PHASE_TEXT[auto.phase as keyof typeof PHASE_TEXT]}</Text>}
            {auto.phase === "error" && auto.error && <Text style={[type.small, { color: colors.warn }]}>{auto.error}</Text>}
            {s.scope?.targets?.length ? (
              <Text style={type.tiny}>
                Contracts: {s.scope.targets.map((t) => short(t)).join(", ")} · Functions: {s.scope.functions.join(", ")}
              </Text>
            ) : null}
            <KeyValue label="Agent key" value={short(s.agentAddress)} mono />
            <KeyValue label="Smart account" value={s.upgraded ? "Yes (EIP-7702)" : "Not yet"} />
            {revoked ? (
              <Button title="Restore trading access" variant="secondary" icon="refresh" loading={restoring} onPress={() => void restore()} />
            ) : s.status === "active" ? (
              <Button title="Revoke" variant="danger" icon="close-circle-outline" loading={revoking} onPress={confirmRevoke} />
            ) : auto.phase === "error" ? (
              <Button title="Try again" variant="secondary" icon="refresh" loading={restoring} onPress={() => void restore()} />
            ) : null}
          </>
        ) : null}
        {note && (
          <>
            <Notice tone={note.ok ? "good" : "bad"}>{note.text}</Notice>
            {note.link && <LinkText url={note.link} label="Revoke transaction" />}
          </>
        )}
      </Card>

      <SectionTitle title="Money" />
      <Card style={styles.gap}>
        <Button title="Add funds" variant="secondary" icon="add" onPress={() => router.push("/deposit")} />
        <Button title="Withdraw AUSD" variant="secondary" icon="arrow-up" onPress={() => router.push("/withdraw")} />
      </Card>

      <SectionTitle title="Passkey" />
      <Card style={styles.gap}>
        <KeyValue label="Relying party (RP id)" value={config.rpId} mono />
        <KeyValue label="Key path" value={EVM_PATH} mono />
        <KeyValue label="API" value={config.apiUrl.replace(/^https?:\/\//, "")} mono />
        <Text style={[type.h2, styles.top]}>How your account works</Text>
        <Text style={type.small}>
          Your account is your passkey. The passkey gives 32 secret bytes (WebAuthn PRF). Mona-DeFi turns them into your key with the standard BIP-39 and BIP-32 steps. The key stays in memory while the app is open and is never stored.
        </Text>
        <Text style={type.small}>
          Clear the app data or use a new phone: sign in with the same passkey and you get the same address, balance and positions. The server and this phone keep only data that can be lost or rebuilt: a sign-in token, the passkey id hint, and the permissions that your wallet signed.
        </Text>
        <Button title="Lock now" variant="secondary" icon="lock-closed-outline" onPress={lock} />
        <Button title="Sign out" variant="ghost" onPress={confirmSignOut} />
      </Card>
    </Screen>
  );
}

function ScopeLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <View style={styles.line}>
      <Ionicons name={ok ? "checkmark-circle" : "close-circle"} size={16} color={ok ? colors.good : colors.bad} />
      <Text style={type.body}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: space.sm },
  gap: { gap: space.sm },
  top: { marginTop: space.md },
  address: { marginVertical: space.sm, color: colors.ink },
  row: { flexDirection: "row", alignItems: "center", gap: space.lg },
  between: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
});
