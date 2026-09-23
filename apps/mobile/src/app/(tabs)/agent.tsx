import Ionicons from "@expo/vector-icons/Ionicons";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { IntentConfirm } from "@/components/IntentConfirm";
import { Card, Notice, haptic } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import type { AgentEvent, Intent } from "@/lib/api/types";
import { useAuth } from "@/lib/auth/AuthProvider";
import { applyEvent, type ChatMessage } from "@/lib/chatModel";
import { chatStream } from "@/lib/chat";
import { keys } from "@/lib/queries";
import { colors, radius, space, type } from "@/theme";

const SUGGESTIONS = [
  "Open a 3x long on ETH with 20 AUSD, stop-loss 5% below.",
  "What is my liquidation risk right now?",
  "Which Perpl market has the highest funding?",
  "What are smart money wallets doing on BTC?",
];

const TOOL_LABELS: Record<string, string> = {
  perpl_markets: "Read Perpl markets",
  perpl_account: "Read your Perpl account",
  perpl_book: "Read the order book",
  perpl_open_position: "Prepare the order",
  perpl_close_position: "Prepare the close",
  perpl_set_tpsl: "Set stop-loss / take-profit",
  perpl_margin: "Change margin",
  perpl_deposit: "Deposit to Perpl",
  perpl_withdraw: "Withdraw from Perpl",
  risk_check: "Nansen risk check",
  web_search: "Search the web",
  load_skill: "Read protocol notes",
  Skill: "Read protocol notes",
};

export default function Agent() {
  const { token, renewToken } = useAuth();
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionId = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroll = useRef<ScrollView>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const patchLast = useCallback((ev: AgentEvent) => {
    setMessages((all) => (all.length ? [...all.slice(0, -1), applyEvent(all[all.length - 1]!, ev)] : all));
  }, []);

  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt) return;
      setInput("");
      haptic.tap();
      if (busy) {
        // The agent is running: the message joins the same run.
        try {
          await api.chatMessage(prompt);
          setMessages((m) => [...m, { role: "user", parts: [{ kind: "text", text: prompt }] }, { role: "assistant", parts: [] }]);
        } catch (e) {
          setInput(prompt);
          setMessages((m) => [...m, { role: "assistant", parts: [], error: errorMessage(e, "The message was not sent.") }]);
        }
        return;
      }
      setBusy(true);
      setMessages((m) => [...m, { role: "user", parts: [{ kind: "text", text: prompt }] }, { role: "assistant", parts: [] }]);
      abort.current = new AbortController();
      const run = async (t: string | null) => {
        for await (const ev of chatStream(prompt, sessionId.current, t, abort.current!.signal)) {
          if (ev.type === "session") sessionId.current = ev.sessionId;
          patchLast(ev);
        }
      };
      try {
        try {
          await run(token());
        } catch (e) {
          // One retry after a fresh challenge signature (no passkey prompt).
          if (e instanceof ApiError && e.status === 401) await run(await renewToken());
          else throw e;
        }
      } catch (e) {
        if ((e as Error)?.name !== "AbortError") patchLast({ type: "error", message: errorMessage(e, "The agent request failed.") });
      } finally {
        setBusy(false);
        void qc.invalidateQueries({ queryKey: keys.positions });
        void qc.invalidateQueries({ queryKey: keys.balance });
      }
    },
    [busy, patchLast, qc, renewToken, token],
  );

  const stop = () => {
    abort.current?.abort();
    setBusy(false);
  };

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Text style={type.title}>Agent</Text>
        {messages.length > 0 && (
          <Pressable onPress={() => { stop(); setMessages([]); sessionId.current = null; }} hitSlop={10} accessibilityRole="button" accessibilityLabel="New chat">
            <Ionicons name="create-outline" size={22} color={colors.dim} />
          </Pressable>
        )}
      </View>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 80 : 0}>
        <ScrollView ref={scroll} contentContainerStyle={styles.list} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} keyboardShouldPersistTaps="handled">
          {messages.length === 0 && (
            <View style={styles.empty}>
              <Text style={[type.small, styles.center]}>Ask in plain words. The agent prepares orders. You confirm each one here.</Text>
              {SUGGESTIONS.map((s) => (
                <Pressable key={s} onPress={() => void send(s)} style={styles.suggestion} accessibilityRole="button">
                  <Text style={type.body}>{s}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {messages.map((m, i) => (
            <Message key={i} message={m} streaming={busy && i === messages.length - 1} />
          ))}
        </ScrollView>
        <View style={styles.inputBar}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={busy ? "Add to the running request…" : "Message the agent"}
            placeholderTextColor={colors.faint}
            style={styles.input}
            multiline
            accessibilityLabel="Message"
          />
          {busy && !input.trim() ? (
            <Pressable onPress={stop} style={[styles.send, { backgroundColor: colors.raised }]} accessibilityRole="button" accessibilityLabel="Stop">
              <Ionicons name="stop" size={18} color={colors.ink} />
            </Pressable>
          ) : (
            <Pressable onPress={() => void send(input)} disabled={!input.trim()} style={[styles.send, !input.trim() && styles.disabled]} accessibilityRole="button" accessibilityLabel="Send">
              <Ionicons name="arrow-up" size={20} color="#FFFFFF" />
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Message({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
    return (
      <View style={styles.userBubble}>
        <Text style={[type.body, { color: "#FFFFFF" }]}>{text}</Text>
      </View>
    );
  }
  return (
    <View style={styles.assistant}>
      {message.parts.map((p, i) =>
        p.kind === "text" ? (
          <Text key={i} style={[type.body, styles.answer]} selectable>
            {p.text}
          </Text>
        ) : p.kind === "tool" ? (
          <View key={p.id} style={styles.tool}>
            {p.result === undefined ? <ActivityIndicator size="small" color={colors.dim} /> : <Ionicons name={p.isError ? "alert-circle" : "checkmark-circle"} size={15} color={p.isError ? colors.warn : colors.good} />}
            <Text style={[type.small, styles.flex]} numberOfLines={1}>
              {TOOL_LABELS[p.name] ?? p.name.replace(/_/g, " ")}
            </Text>
          </View>
        ) : (
          <IntentCard key={p.intent.id} intent={p.intent} />
        ),
      )}
      {streaming && message.parts.length === 0 && <ActivityIndicator color={colors.dim} style={styles.start} />}
      {message.error && <Notice tone="bad">{message.error}</Notice>}
    </View>
  );
}

function IntentCard({ intent }: { intent: Intent }) {
  return (
    <Card style={styles.intent}>
      <IntentConfirm intent={intent} compact />
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: "center" },
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.lg, paddingBottom: space.sm },
  list: { padding: space.lg, gap: space.md, paddingBottom: space.xl },
  empty: { gap: space.sm, marginTop: space.xl },
  suggestion: { backgroundColor: colors.panel, borderRadius: radius.md, padding: space.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  userBubble: { alignSelf: "flex-end", maxWidth: "85%", backgroundColor: colors.accent, borderRadius: radius.lg, borderBottomRightRadius: 4, paddingHorizontal: space.md, paddingVertical: space.sm },
  assistant: { gap: space.sm },
  answer: { lineHeight: 22 },
  tool: { flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: colors.panel, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  start: { alignSelf: "flex-start" },
  intent: { borderColor: colors.accent },
  inputBar: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, padding: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.bg },
  input: { flex: 1, minHeight: 44, maxHeight: 120, backgroundColor: colors.panel, borderRadius: radius.lg, color: colors.ink, paddingHorizontal: space.lg, paddingTop: 12, paddingBottom: 12, fontSize: 16 },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.4 },
});
