import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { Button, Card, CopyButton, KeyValue, LinkText, Notice, Pill, Screen, SectionTitle, Skeleton, haptic } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import { useAuth, useAddress } from "@/lib/auth/AuthProvider";
import { addressUrl, config } from "@/lib/config";
import { shortDate, short } from "@/lib/format";
import { EVM_PATH } from "@/lib/mera/derive";
import { keys, useSessionStatus } from "@/lib/queries";
import { relay } from "@/lib/wallet";
import { colors, space, type } from "@/theme";

const STATUS_LABEL = { none: "Off", needs_upgrade: "Off", needs_signature: "Waiting for signature", active: "Active", expired: "Ended" } as const;

export default function Settings() {
  const address = useAddress();
  const { lock, signOut } = useAuth();
  const qc = useQueryClient();
  const session = useSessionStatus();
  const [revoking, setRevoking] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; link?: string } | null>(null);

  const s = session.data;
  const activeUntil = s?.permissions.filter((p) => p.status === "active").map((p) => p.expiresAt).sort()[0];

  function confirmRevoke() {
    Alert.alert("Revoke trading permission?", "Mona-DeFi can no longer place orders for you. Open positions stay open.", [
      { text: "Cancel", style: "cancel" },
      { text: "Revoke", style: "destructive", onPress: () => void revoke() },
    ]);
  }

  async function revoke() {
    setRevoking(true);
    setNote(null);
    try {
      const r = await api.session.revoke();
      let link: string | undefined;
      // When the server gives the disable calls, the wallet also disables the delegations on-chain (gasless, no prompt).
      if (r.calls?.length) link = (await relay(r.calls)).explorer;
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
    Alert.alert("Sign out?", "Mona-DeFi ends the key and deletes the local hints. Your account stays with your passkey: sign in again at any time.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void signOut() },
    ]);
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

      <SectionTitle title="Trading permission" />
      <Card style={styles.gap}>
        {session.isLoading ? (
          <Skeleton height={60} />
        ) : session.error ? (
          <Text style={[type.small, { color: colors.warn }]}>{errorMessage(session.error)}</Text>
        ) : s ? (
          <>
            <View style={styles.between}>
              <Text style={type.h2}>Prompt-free trading</Text>
              <Pill label={STATUS_LABEL[s.status]} tone={s.status === "active" ? "good" : s.status === "expired" ? "warn" : "dim"} />
            </View>
            {s.status === "active" && <Text style={type.small}>Ends {activeUntil ? shortDate(activeUntil) : "—"}.</Text>}
            <Text style={type.small}>Can: place and close Perpl orders, add margin, move AUSD into Perpl.</Text>
            <Text style={type.small}>Cannot: {s.scope?.cannot?.length ? s.scope.cannot.join(", ") : "withdraw, transfer, or spend other tokens"}.</Text>
            <KeyValue label="Agent key" value={short(s.agentAddress)} mono />
            <KeyValue label="Smart account" value={s.upgraded ? "Yes (EIP-7702)" : "Not yet"} />
            {s.status === "active" ? (
              <Button title="Revoke" variant="danger" icon="close-circle-outline" loading={revoking} onPress={confirmRevoke} />
            ) : (
              <Button title="Turn on trading" variant="secondary" icon="key-outline" onPress={() => router.push("/session")} />
            )}
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

const styles = StyleSheet.create({
  gap: { gap: space.sm },
  top: { marginTop: space.md },
  address: { marginVertical: space.sm, color: colors.ink },
  row: { flexDirection: "row", alignItems: "center", gap: space.lg },
  between: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
});
