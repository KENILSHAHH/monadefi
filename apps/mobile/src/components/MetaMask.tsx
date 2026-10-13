/**
 * MetaMask UI parts for the deposit sheet (signed in) and the public /fund page (no sign-in).
 * MetaMask signs only plain transfers to the destination shown on screen (src/lib/metamask/core.ts).
 */
import Ionicons from "@expo/vector-icons/Ionicons";
import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { Address } from "viem";
import { Logo } from "@/components/Logo";
import { Button, Card, Chip, LinkText, Notice, haptic, openLink } from "@/components/ui";
import { short } from "@/lib/format";
import { monadBalance } from "@/lib/metamask/balances";
import {
  MONAD_ADD_CHAIN, MONAD_CHAIN_ID, MONAD_TOKENS, METAMASK_DOWNLOAD, amountText, buildTransferTx, connectAccount, maxSendable, metamaskDeepLink,
  metamaskErrorMessage, monadTxUrl, parseTokenAmount, sendTransfer, switchChain, waitForReceipt, type Eip1193Provider, type MonadToken,
} from "@/lib/metamask/core";
import { appOrigin, findMetaMask, isPhoneBrowser, openExternal } from "@/lib/metamask/provider";
import { colors, fonts, radius, space, type } from "@/theme";

// ── Provider ─────────────────────────────────────────────────────────────────

export type MetaMaskState = { status: "searching" } | { status: "found"; provider: Eip1193Provider } | { status: "missing" };

/** Find MetaMask once (EIP-6963, then window.ethereum). `retry` looks again, for "Try again" after an install. */
export function useMetaMask(): MetaMaskState & { retry: () => void } {
  const [state, setState] = useState<MetaMaskState>({ status: "searching" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "searching" });
    void findMetaMask().then((p) => {
      if (live) setState(p ? { status: "found", provider: p } : { status: "missing" });
    });
    return () => {
      live = false;
    };
  }, [attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

/** The connected account; follows accountsChanged. */
function useAccount(provider: Eip1193Provider) {
  const [account, setAccount] = useState<Address | null>(null);
  useEffect(() => {
    const onAccounts = (...args: unknown[]) => {
      const list = args[0];
      setAccount(Array.isArray(list) && typeof list[0] === "string" ? (list[0] as Address) : null);
    };
    provider.on?.("accountsChanged", onAccounts);
    return () => provider.removeListener?.("accountsChanged", onAccounts);
  }, [provider]);
  return [account, setAccount] as const;
}

// ── No MetaMask ──────────────────────────────────────────────────────────────

/** No MetaMask here. Phone browser and native app: open /fund in the MetaMask app. Desktop: install it. */
export function NoMetaMask({ to, onRetry }: { to: string; onRetry: () => void }) {
  if (isPhoneBrowser()) {
    const link = metamaskDeepLink(appOrigin(), to);
    return (
      <Card style={styles.gap}>
        <View style={styles.row}>
          <Logo kind="protocol" id="metamask" size={28} />
          <Text style={type.h2}>Open in MetaMask</Text>
        </View>
        <Text style={type.small}>The MetaMask app opens this deposit page in its browser. You confirm the transfer there. You do not need to sign in.</Text>
        <Button title="Open in MetaMask" leading={<Logo kind="protocol" id="metamask" size={22} />} onPress={() => openExternal(link)} />
        <Text style={[type.tiny, styles.center]}>Install the MetaMask app first if you do not have it.</Text>
      </Card>
    );
  }
  return (
    <Card style={styles.gap}>
      <View style={styles.row}>
        <Logo kind="protocol" id="metamask" size={28} />
        <Text style={[type.h2, styles.flex]}>MetaMask is not in this browser</Text>
      </View>
      <Text style={type.small}>Install the MetaMask extension, then reload or tap Try again.</Text>
      <Button title="Install MetaMask" leading={<Logo kind="protocol" id="metamask" size={22} />} onPress={() => openLink(METAMASK_DOWNLOAD)} />
      <Button title="Try again" variant="secondary" icon="refresh" onPress={onRetry} />
    </Card>
  );
}

// ── Destination ──────────────────────────────────────────────────────────────

export function Destination({ address, title, warn }: { address: string; title: string; warn?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Card style={styles.gap}>
      <Text style={type.label}>Destination</Text>
      <View style={styles.row}>
        <Logo kind="chain" id="monad" size={20} />
        <Text style={[type.small, styles.flex]}>Monad · chain 143</Text>
      </View>
      <Text style={type.body}>
        {title} <Text style={type.mono}>{short(address)}</Text>
      </Text>
      <Pressable accessibilityRole="button" onPress={() => setOpen((v) => !v)} style={styles.row} hitSlop={8}>
        <Text style={styles.linkText}>{open ? "Hide full address" : "Show full address"}</Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={14} color={colors.accent} />
      </Pressable>
      {open && (
        <Text style={[type.mono, styles.full]} selectable testID="full-address">
          {address}
        </Text>
      )}
      {warn && <Notice tone="warn">Check that this is your own Mona-DeFi address.</Notice>}
    </Card>
  );
}

// ── Steps ────────────────────────────────────────────────────────────────────

export function StepList({ steps, current, failed }: { steps: readonly string[]; current: number; failed?: boolean }) {
  return (
    <View style={styles.gap}>
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <View key={label} style={styles.step}>
            <View style={[styles.stepDot, done && styles.stepDone, active && failed && styles.stepFailed, active && !failed && styles.stepActive]}>
              {done && <Ionicons name="checkmark" size={12} color="#06110B" />}
              {active && failed && <Ionicons name="close" size={12} color="#FFFFFF" />}
            </View>
            <Text style={[type.body, !done && !active && { color: colors.dim }]}>{label}</Text>
          </View>
        );
      })}
    </View>
  );
}

// ── Monad direct ─────────────────────────────────────────────────────────────

const MONAD_STEPS = ["Connect", "Switch network", "Confirm in MetaMask", "Waiting for confirmation", "Done"] as const;
type Run = { step: number; error: string | null; hash: string | null };

/**
 * Send AUSD, USDC, USDT0 or MON on Monad from the MetaMask account to `to`.
 * Steps: eth_requestAccounts → wallet_switchEthereumChain 0x8f (add on 4902) → eth_sendTransaction → receipt poll.
 */
export function MonadDirect({ provider, to, onSuccess }: { provider: Eip1193Provider; to: Address; onSuccess?: (hash: string) => void }) {
  const [account, setAccount] = useAccount(provider);
  const [token, setToken] = useState<MonadToken>(MONAD_TOKENS[0]!);
  const [text, setText] = useState("");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [mon, setMon] = useState<bigint | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const native = token.address === null;
  const parsed = text ? parseTokenAmount(text, token.decimals) : null;
  const over = parsed?.ok && balance !== null && parsed.value > balance;
  const running = run !== null && run.error === null && run.step < 4;

  const loadBalances = useCallback(async () => {
    if (!account) return;
    setBalance(null);
    try {
      const [b, m] = await Promise.all([monadBalance(account, token), monadBalance(account, MONAD_TOKENS[3]!)]);
      setBalance(b);
      setMon(m);
    } catch {
      setBalance(null);
    }
  }, [account, token]);

  useEffect(() => {
    void loadBalances();
  }, [loadBalances]);

  async function connect() {
    setConnecting(true);
    setConnectError(null);
    try {
      setAccount(await connectAccount(provider));
    } catch (e) {
      setConnectError(metamaskErrorMessage(e));
    } finally {
      setConnecting(false);
    }
  }

  async function send() {
    if (!parsed?.ok) return;
    let step = 0;
    const at = (s: number) => {
      step = s;
      setRun((r) => ({ step: s, error: null, hash: r?.hash ?? null }));
    };
    setRun({ step: 0, error: null, hash: null });
    try {
      const from = await connectAccount(provider);
      setAccount(from);
      at(1);
      await switchChain(provider, MONAD_CHAIN_ID, MONAD_ADD_CHAIN, "Monad");
      at(2);
      const tx = buildTransferTx({ from, recipient: to, amount: parsed.value, token: token.address });
      const hash = await sendTransfer(provider, tx);
      setRun({ step: 3, error: null, hash });
      step = 3;
      const r = await waitForReceipt(provider, hash);
      if (r.status === "timeout") throw new Error("No confirmation after 2 minutes. Check the transaction on Monadscan.");
      if (r.status === "reverted") throw new Error("The transfer failed on Monad (reverted). No funds moved.");
      setRun({ step: 4, error: null, hash });
      haptic.success();
      onSuccess?.(hash);
      void loadBalances();
    } catch (e) {
      haptic.error();
      setRun((r) => ({ step, error: metamaskErrorMessage(e), hash: r?.hash ?? null }));
    }
  }

  if (!account) {
    return (
      <Card style={styles.gap}>
        <Text style={type.small}>Connect MetaMask to send funds on Monad (chain 143). MetaMask asks you to confirm one plain transfer. It signs nothing else.</Text>
        <Button title="Connect MetaMask" leading={<Logo kind="protocol" id="metamask" size={22} />} loading={connecting} onPress={() => void connect()} />
        {connectError && <Notice tone="bad">{connectError}</Notice>}
      </Card>
    );
  }

  if (run) {
    const done = run.step === 4 && !run.error;
    return (
      <Card style={styles.gap}>
        <Text style={type.h2}>
          Send {text} {token.symbol} on Monad
        </Text>
        <Text style={type.small}>
          From <Text style={type.mono}>{short(account)}</Text> to <Text style={type.mono}>{short(to)}</Text>
        </Text>
        <StepList steps={MONAD_STEPS} current={done ? 5 : run.step} failed={Boolean(run.error)} />
        {done && <Notice tone="good">Done. The funds are in your Mona-DeFi wallet.</Notice>}
        {run.error && <Notice tone="bad">{run.error}</Notice>}
        {run.hash && <LinkText url={monadTxUrl(run.hash)} label="Transaction on Monadscan" />}
        {!running && (
          <Button
            title={done ? "Send more" : "Back"}
            variant="secondary"
            onPress={() => {
              setRun(null);
              if (done) setText("");
            }}
          />
        )}
      </Card>
    );
  }

  return (
    <Card style={styles.gap}>
      <View style={styles.row}>
        <Logo kind="protocol" id="metamask" size={20} />
        <Text style={type.small}>
          MetaMask account <Text style={type.mono}>{short(account)}</Text>
        </Text>
      </View>
      <Text style={[type.label, styles.top]}>Token on Monad</Text>
      <View style={styles.wrap}>
        {MONAD_TOKENS.map((t) => (
          <Chip key={t.symbol} label={t.symbol} leading={<Logo kind="token" id={t.symbol} size={22} badge={{ kind: "chain", id: "monad" }} />} active={t.symbol === token.symbol} onPress={() => { setToken(t); setText(""); }} />
        ))}
      </View>
      <Text style={type.tiny}>Perpl trades with AUSD. USDC is changed to AUSD when you trade or with the deposit tools.</Text>
      <View style={[styles.row, styles.top]}>
        <Text style={[type.label, styles.flex]}>Amount</Text>
        <Text style={type.small}>Balance: {balance === null ? "…" : `${amountText(balance, token.decimals)} ${token.symbol}`}</Text>
      </View>
      <View style={styles.row}>
        <TextInput
          value={text}
          onChangeText={setText}
          keyboardType="decimal-pad"
          placeholder={`Amount of ${token.symbol}`}
          placeholderTextColor={colors.faint}
          style={[styles.input, styles.flex]}
          accessibilityLabel="Amount"
          autoCorrect={false}
        />
        <Button compact variant="secondary" title="Max" disabled={balance === null} onPress={() => balance !== null && setText(amountText(maxSendable(balance, native), token.decimals))} />
      </View>
      {native && <Text style={type.tiny}>Max keeps 0.01 MON for gas.</Text>}
      {parsed && !parsed.ok && <Text style={[type.tiny, { color: colors.warn }]}>{parsed.error}</Text>}
      {over && <Text style={[type.tiny, { color: colors.warn }]}>This is more than the balance of the MetaMask account.</Text>}
      {!native && mon === 0n && <Text style={[type.tiny, { color: colors.warn }]}>The MetaMask account has no MON for gas on Monad.</Text>}
      {parsed?.ok && (
        <Text style={[type.small, styles.top]}>
          You send {text} {token.symbol} on Monad to <Text style={type.mono}>{short(to)}</Text>.
        </Text>
      )}
      <Button title="Confirm in MetaMask" leading={<Logo kind="protocol" id="metamask" size={22} />} disabled={!parsed?.ok || Boolean(over)} onPress={() => void send()} />
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap: { gap: space.sm },
  top: { marginTop: space.sm },
  center: { textAlign: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  full: { color: colors.ink, backgroundColor: colors.raised, padding: space.sm, borderRadius: radius.sm, ...(Platform.OS === "web" ? ({ wordBreak: "break-all" } as object) : {}) },
  linkText: { ...fonts.sansMedium, color: colors.accent, fontSize: 14 },
  input: { ...fonts.sans, backgroundColor: colors.raised, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, color: colors.ink, paddingHorizontal: space.md, height: 48, fontSize: 16 },
  step: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 2 },
  stepDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  stepDone: { backgroundColor: colors.good, borderColor: colors.good },
  stepActive: { borderColor: colors.accent },
  stepFailed: { backgroundColor: colors.bad, borderColor: colors.bad },
});
