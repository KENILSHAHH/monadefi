/** The progress of one Aurora deposit: steps from GET /deposit/aurora/:id every 5 s, plus the actions of each phase. */
import Ionicons from "@expo/vector-icons/Ionicons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { AddressQr } from "@/components/AddressQr";
import { Brand, Logo } from "@/components/Logo";
import { Button, Card, CopyButton, KeyValue, LinkText, Notice, haptic } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import type { AuroraDeposit } from "@/lib/api/types";
import { txUrl } from "@/lib/config";
import { depositPhase, isFinal, shouldPoll, type DepositPhase } from "@/lib/deposit";
import { fixed } from "@/lib/format";
import { keys } from "@/lib/queries";
import { ensureSession } from "@/lib/session";
import { signMessage, signTypedPayload } from "@/lib/wallet";
import { colors, fonts, radius, space, type } from "@/theme";

/**
 * Connect mode: personal_sign of `signPayload.payload_json`, verbatim, with the Mera wallet.
 * The key is in memory: no prompt. Returns the updated deposit.
 */
export async function signConnectOrder(d: AuroraDeposit): Promise<AuroraDeposit> {
  if (!d.signPayload) throw new Error("This deposit has nothing to sign.");
  return api.deposit.signature(d.id, await signMessage(d.signPayload.payload_json));
}

const PHASE_TEXT: Record<DepositPhase, string> = {
  sign: "Sign the deposit order on this phone.",
  send: "Send the funds to the address below.",
  wait: "Aurora is moving your funds. This screen updates by itself.",
  convert: "USDC arrived on Monad. Convert it to AUSD to trade.",
  session: "AUSD arrived. Mona-DeFi is turning on trading access so it can move it into Perpl.",
  done: "Done. Your AUSD is ready to trade.",
  refunded: "Aurora refunded the deposit.",
  failed: "The deposit did not complete.",
};

export function DepositProgress({ initial, onDone, onLeave }: { initial: AuroraDeposit; onDone: () => void; /** Called before the view opens another screen (for example, to close a sheet). */ onLeave?: () => void }) {
  const qc = useQueryClient();
  const [local, setLocal] = useState<AuroraDeposit>(initial);
  const [busy, setBusy] = useState<"sign" | "convert" | "refresh" | "tx" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState("");
  const [convertLink, setConvertLink] = useState<string | null>(null);
  const autoSigned = useRef(false);
  const sessionTried = useRef(false);
  const [sessionOff, setSessionOff] = useState(false);

  // GET /deposit/aurora/:id every 5 s while Aurora or Mona-DeFi can still move it.
  const live = useQuery({
    queryKey: ["deposit", initial.id],
    queryFn: () => api.deposit.get(initial.id),
    initialData: initial,
    refetchInterval: (q) => (q.state.data && shouldPoll(depositPhase(q.state.data)) ? 5_000 : false),
  });
  const d = live.data ?? local;
  const phase = depositPhase(d);

  useEffect(() => {
    if (isFinal(phase)) {
      if (phase === "done") haptic.success();
      void qc.invalidateQueries({ queryKey: keys.balance });
    }
  }, [phase, qc]);

  const act = async (kind: "sign" | "convert" | "refresh" | "tx", fn: () => Promise<AuroraDeposit>) => {
    setBusy(kind);
    setError(null);
    try {
      const next = await fn();
      setLocal(next);
      qc.setQueryData(["deposit", initial.id], next);
    } catch (e) {
      haptic.error();
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // Connect: personal_sign of payload_json, verbatim. The key is in memory: no prompt.
  const sign = () =>
    act("sign", () => signConnectOrder(d));

  // Swap: the server prepares the Curve swap as a one-time relay; the phone signs it; the server moves on.
  const convert = () =>
    act("convert", async () => {
      const prepared = await api.deposit.convert(d.id);
      const sent = await api.relay.send(prepared.id, await signTypedPayload(prepared.typedData));
      if (sent.status !== "success") throw new Error("The swap reverted on Monad. Your USDC is still in the wallet.");
      setConvertLink(sent.explorer);
      return api.deposit.converted(d.id);
    });

  useEffect(() => {
    if (phase === "sign" && !autoSigned.current) {
      autoSigned.current = true;
      void sign();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // The server waits for an active session before it moves the AUSD into Perpl. Set it up (no prompt), then refresh.
  useEffect(() => {
    if (phase !== "session" || sessionTried.current) return;
    sessionTried.current = true;
    void ensureSession().then((r) => {
      if (r.state === "active") void act("refresh", () => api.deposit.refresh(d.id));
      else setSessionOff(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const tone = phase === "done" ? "good" : phase === "failed" || phase === "refunded" ? "bad" : "accent";

  return (
    <>
      <Card style={styles.gap}>
        <View style={styles.headRow}>
          <Logo kind="chain" id={d.originChain} size={28} badge={{ kind: "protocol", id: "aurora" }} />
          <View style={styles.flex}>
            <Text style={type.h2}>Deposit from {d.originChain.toUpperCase()}</Text>
            <Brand id="aurora" label="Aurora Intents" size={14} />
          </View>
        </View>
        <Notice tone={tone} icon={isFinal(phase) ? undefined : "sync"}>
          {PHASE_TEXT[phase]}
          {d.error ? ` ${d.error}` : ""}
          {phase === "failed" && d.afterResult?.error ? ` ${d.afterResult.error}` : ""}
        </Notice>
        {d.steps.map((s, i) => (
          <View key={`${i}-${s.label}`} style={styles.step}>
            <View style={[styles.stepDot, s.done && styles.stepDone]}>{s.done && <Ionicons name="checkmark" size={12} color="#06110B" />}</View>
            <Text style={[type.body, !s.done && { color: colors.dim }]}>{s.label}</Text>
          </View>
        ))}
      </Card>

      {phase === "sign" && <Button title="Sign the deposit order" icon="create-outline" loading={busy === "sign"} onPress={() => void sign()} />}

      {phase === "send" && d.depositAddress && (
        <Card style={styles.gap}>
          <AddressQr value={d.depositAddress} caption={`Send ${d.amountIn ? `${d.amountIn} ` : ""}on ${d.originChain} to this address.`} />
          {d.depositMemo ? (
            <View style={styles.memo}>
              <Notice tone="warn">Add this memo to the transfer. Without it the deposit cannot be matched.</Notice>
              <Text style={[type.mono, styles.center]} selectable>
                {d.depositMemo}
              </Text>
              <CopyButton value={d.depositMemo} label="Copy memo" />
            </View>
          ) : null}
          {d.deadline && <KeyValue label="Send before" value={new Date(d.deadline).toLocaleTimeString()} />}
          <Text style={[type.label, styles.top]}>Already sent? (optional)</Text>
          <TextInput value={txHash} onChangeText={setTxHash} placeholder="Source transaction hash" placeholderTextColor={colors.faint} style={styles.input} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Source transaction hash" />
          <Button compact variant="secondary" title="Tell Aurora" loading={busy === "tx"} disabled={txHash.trim().length < 10} onPress={() => void act("tx", () => api.deposit.tx(d.id, txHash.trim()))} />
        </Card>
      )}

      {phase === "convert" && (
        <Card style={styles.gap}>
          <Text style={type.h2}>Convert {d.nextStep?.kind === "needs_conversion" ? `${fixed(d.nextStep.usdc, 2)} USDC` : "USDC"} to AUSD</Text>
          <Text style={type.small}>A Curve swap on Monad, signed on this phone for these exact calls only. No prompt, no gas.</Text>
          <Button title="Convert to AUSD" icon="swap-horizontal" loading={busy === "convert"} onPress={() => void convert()} />
        </Card>
      )}
      {convertLink && <LinkText url={convertLink} label="Swap on Monadscan" />}

      {phase === "session" && sessionOff && (
        <>
          <Notice tone="accent" icon="key-outline">Trading access is off. Restore it in Settings, then Mona-DeFi moves the AUSD into Perpl.</Notice>
          <Button title="Open Settings" variant="secondary" icon="settings-outline" onPress={() => {
            onLeave?.();
            router.push("/settings");
          }} />
        </>
      )}

      {phase === "refunded" && (
        <Card>
          <KeyValue label="Refunded" value={d.refundAmount ?? "—"} />
          {d.refundReason && <Text style={type.small}>{d.refundReason}</Text>}
        </Card>
      )}

      {d.settledTx && <LinkText url={d.settledTx.startsWith("http") ? d.settledTx : txUrl(d.settledTx)} label="Arrival on Monadscan" />}
      {d.refundTx && <Text style={[type.mono, { color: colors.dim }]} selectable>Refund tx {d.refundTx}</Text>}
      {error && <Notice tone="bad">{error}</Notice>}

      {!isFinal(phase) && <Button compact variant="ghost" icon="refresh" title="Check now" loading={busy === "refresh"} onPress={() => void act("refresh", () => api.deposit.refresh(d.id))} />}
      <Button title={isFinal(phase) ? "Done" : "Start another deposit"} variant="secondary" onPress={onDone} />
    </>
  );
}

const styles = StyleSheet.create({
  gap: { gap: space.sm },
  flex: { flex: 1 },
  headRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  top: { marginTop: space.md },
  center: { textAlign: "center" },
  input: { ...fonts.sans, backgroundColor: colors.raised, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, color: colors.ink, paddingHorizontal: space.md, height: 48, fontSize: 16 },
  memo: { gap: space.sm, alignItems: "center", alignSelf: "stretch" },
  step: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 2 },
  stepDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  stepDone: { backgroundColor: colors.good, borderColor: colors.good },
});
