import Ionicons from "@expo/vector-icons/Ionicons";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Animated, Easing, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StepLine, StepsSummary } from "@/components/AgentSteps";
import { Glass, GlassFill } from "@/components/Glass";
import { IntentConfirm } from "@/components/IntentConfirm";
import { Brand } from "@/components/Logo";
import { Markdown } from "@/components/Markdown";
import { Card, IconButton, Notice, Screen, haptic, useScreenInsets } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import type { AgentEvent, Intent } from "@/lib/api/types";
import { useAuth } from "@/lib/auth/AuthProvider";
import { applyEvent, type ChatMessage } from "@/lib/chatModel";
import { chatStream } from "@/lib/chat";
import { keys } from "@/lib/queries";
import { ensureSessionBefore } from "@/lib/session";
import { clock, HOLD_MIN_MS, intentResultSentence, MAX_RECORD_MS, SEND_DELAY_MS, speakableText, VoiceError } from "@/lib/voice/core";
import { speakBytes } from "@/lib/voice/http";
import { playMp3, stopPlayback, unlockAudio } from "@/lib/voice/player";
import { useVoiceRecorder } from "@/lib/voice/useRecorder";
import { colors, fonts, radius, space, type } from "@/theme";

const SUGGESTIONS = [
  "Open a 3x long on ETH with 20 AUSD, stop-loss 5% below.",
  "What is my liquidation risk right now?",
  "Which Perpl market has the highest funding?",
  "What are smart money wallets doing on BTC?",
];

const native = Platform.OS !== "web";

/** True while the software keyboard is open (native). The input bar then sits on the keyboard, not on the tab bar. */
function useKeyboardOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!native) return;
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setOpen(true));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return open;
}

export default function Agent() {
  const { token, renewToken } = useAuth();
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionId = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroll = useRef<ScrollView>(null);

  // ── Voice ──
  const [speakOn, setSpeakOn] = useState(false);
  const speakRef = useRef(false);
  speakRef.current = speakOn;
  const speakTouched = useRef(false);
  const speakAbort = useRef<AbortController | null>(null);
  const [voiceDraft, setVoiceDraft] = useState<{ text: string; editing: boolean } | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const micMode = useRef<"hold" | "toggle" | null>(null);
  const pressAt = useRef(0);

  const recorder = useVoiceRecorder({
    onTranscript: (text) => setVoiceDraft({ text, editing: false }),
    onError: (e: VoiceError) => {
      haptic.error();
      setVoiceError(e.message);
    },
  });

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (!voiceError) return;
    const t = setTimeout(() => setVoiceError(null), 6_000);
    return () => clearTimeout(t);
  }, [voiceError]);

  const stopSpeaking = useCallback(() => {
    speakAbort.current?.abort();
    speakAbort.current = null;
    stopPlayback();
  }, []);

  /** POST /voice/speak and play the MP3. Errors show in plain words; an abort is silent. */
  const speakOut = useCallback(
    async (text: string) => {
      const t = speakableText(text);
      if (!t) return;
      stopSpeaking();
      const ctrl = new AbortController();
      speakAbort.current = ctrl;
      try {
        const bytes = await speakBytes(t, ctrl.signal);
        if (ctrl.signal.aborted) return;
        await playMp3(bytes);
      } catch (e) {
        if ((e as Error)?.name !== "AbortError" && !ctrl.signal.aborted) setVoiceError(e instanceof VoiceError ? e.message : "The spoken reply did not play.");
      }
    },
    [stopSpeaking],
  );

  // Leaving the tab stops the playback and drops a recording.
  const cancelRecording = recorder.cancel;
  useFocusEffect(
    useCallback(
      () => () => {
        stopSpeaking();
        cancelRecording();
      },
      [stopSpeaking, cancelRecording],
    ),
  );

  const patchLast = useCallback((ev: AgentEvent) => {
    setMessages((all) => (all.length ? [...all.slice(0, -1), applyEvent(all[all.length - 1]!, ev)] : all));
  }, []);

  const send = useCallback(
    async (text: string, opts: { voice?: boolean } = {}) => {
      const prompt = text.trim();
      if (!prompt) return;
      setInput("");
      haptic.tap();
      if (busy) {
        // The agent is running: the message joins the same run.
        try {
          await api.chatMessage(prompt);
          setMessages((m) => [...m, { role: "user", parts: [{ kind: "text", text: prompt }], voice: opts.voice }, { role: "assistant", parts: [], startedAt: Date.now() }]);
        } catch (e) {
          setInput(prompt);
          setMessages((m) => [...m, { role: "assistant", parts: [], error: errorMessage(e, "The message was not sent.") }]);
        }
        return;
      }
      setBusy(true);
      setMessages((m) => [...m, { role: "user", parts: [{ kind: "text", text: prompt }], voice: opts.voice }, { role: "assistant", parts: [], startedAt: Date.now() }]);
      abort.current = new AbortController();
      let reply = "";
      const run = async (t: string | null) => {
        reply = "";
        for await (const ev of chatStream(prompt, sessionId.current, t, abort.current!.signal, opts)) {
          if (ev.type === "session") sessionId.current = ev.sessionId;
          if (ev.type === "text") reply += ev.delta;
          patchLast(ev);
          if (ev.type === "done" && speakRef.current) void speakOut(reply);
        }
      };
      try {
        // Trading access sets itself up after the passkey. This waits only when it is not ready yet.
        await ensureSessionBefore();
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
        const end = Date.now();
        setMessages((all) => all.map((m) => (m.role === "assistant" && m.startedAt && !m.endedAt ? { ...m, endedAt: end } : m)));
        void qc.invalidateQueries({ queryKey: keys.positions });
        void qc.invalidateQueries({ queryKey: keys.balance });
      }
    },
    [busy, patchLast, qc, renewToken, token, speakOut],
  );

  const stop = () => {
    abort.current?.abort();
    setBusy(false);
  };

  // The transcript waits 1.5 s in an editable bubble, then goes to the agent with "voice": true.
  useEffect(() => {
    if (!voiceDraft || voiceDraft.editing) return;
    const t = setTimeout(() => {
      setVoiceDraft(null);
      void send(voiceDraft.text, { voice: true });
    }, SEND_DELAY_MS);
    return () => clearTimeout(t);
  }, [voiceDraft, send]);

  // ── Mic: press and hold to record, release to send. A short tap toggles: tap again to send. ──
  const onMicIn = () => {
    // Safari: start the recording and unlock the audio from the gesture itself.
    unlockAudio();
    stopSpeaking();
    if (recorder.phase === "idle") {
      setVoiceError(null);
      setVoiceDraft(null);
      micMode.current = "hold";
      pressAt.current = Date.now();
      recorder.start();
      haptic.impact();
      if (!speakTouched.current) setSpeakOn(true);
    } else if (micMode.current === "toggle" && (recorder.phase === "recording" || recorder.phase === "starting")) {
      micMode.current = null;
      haptic.tap();
      void recorder.stop();
    }
  };
  const onMicOut = () => {
    if (micMode.current !== "hold") return;
    if (Date.now() - pressAt.current >= HOLD_MIN_MS) {
      micMode.current = null;
      haptic.tap();
      void recorder.stop();
    } else micMode.current = "toggle";
  };
  const cancelMic = () => {
    micMode.current = null;
    recorder.cancel();
  };

  const toggleSpeak = () => {
    unlockAudio();
    speakTouched.current = true;
    if (speakOn) stopSpeaking();
    setSpeakOn(!speakOn);
  };

  const onIntentSettled = useCallback(
    (i: Intent) => {
      if (!speakRef.current) return;
      const line = intentResultSentence(i);
      if (line) void speakOut(line);
    },
    [speakOut],
  );

  const recording = recorder.phase === "recording" || recorder.phase === "starting";
  const transcribing = recorder.phase === "transcribing";

  const headerRight = (
    <>
      <IconButton icon={speakOn ? "volume-high-outline" : "volume-mute-outline"} label="Spoken replies" onPress={toggleSpeak} color={speakOn ? colors.accent : colors.dim} active={speakOn} />
      {messages.length > 0 && (
        <IconButton icon="create-outline" label="New chat" onPress={() => { stop(); stopSpeaking(); setMessages([]); sessionId.current = null; }} color={colors.dim} />
      )}
    </>
  );

  return (
    <Screen title="Agent" right={headerRight} scroll={false}>
      <AgentBody>
        {({ top, bottom, keyboard }) => (
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          ref={scroll}
          style={styles.flex}
          contentContainerStyle={[styles.list, { paddingTop: top + space.lg }]}
          scrollIndicatorInsets={{ top }}
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
        >
          {messages.length === 0 && (
            <View style={styles.empty}>
              <View style={styles.hello}>
                <View style={styles.helloIcon}>
                  <Ionicons name="sparkles" size={22} color={colors.accent} />
                </View>
                <Text style={[type.title, styles.center]}>Ask Mona</Text>
                <Text style={[type.small, styles.center]}>Ask in plain words, or hold the mic and speak. The agent prepares orders. You confirm each one here.</Text>
                <View style={styles.helloBrands}>
                  <Brand id="perpl" label="Perpl" />
                  <Brand id="nansen" label="Nansen" />
                  <Brand id="deepgram" label="Deepgram" />
                </View>
              </View>
              {SUGGESTIONS.map((s) => (
                <Card key={s} onPress={() => void send(s)} style={styles.suggestion} accessibilityLabel={s}>
                  <Ionicons name="chatbubble-outline" size={16} color={colors.accent} />
                  <Text style={[type.body, styles.flex]}>{s}</Text>
                  <Ionicons name="arrow-up-circle" size={20} color={colors.faint} />
                </Card>
              ))}
            </View>
          )}
          {messages.map((m, i) => (
            <Message key={i} message={m} streaming={busy && i === messages.length - 1} onSettled={onIntentSettled} />
          ))}
        </ScrollView>

        {voiceError && (
          <View style={styles.banner}>
            <Notice tone="bad" icon="mic-off-outline">{voiceError}</Notice>
          </View>
        )}
        {voiceDraft && (
          <VoiceDraft
            draft={voiceDraft}
            onChange={(text) => setVoiceDraft({ text, editing: true })}
            onEdit={() => setVoiceDraft((d) => (d ? { ...d, editing: true } : d))}
            onCancel={() => setVoiceDraft(null)}
            onSend={() => {
              const t = voiceDraft.text;
              setVoiceDraft(null);
              void send(t, { voice: true });
            }}
          />
        )}

        <View style={[styles.inputBar, { paddingBottom: (keyboard ? 0 : bottom) + space.md }]}>
          <GlassFill tone="bar" />
          {recording ? (
            <View style={styles.recordBar}>
              <Pressable onPress={cancelMic} hitSlop={10} style={styles.cancel} accessibilityRole="button" accessibilityLabel="Cancel the recording">
                <Ionicons name="close" size={20} color={colors.ink} />
              </Pressable>
              <RecDot />
              <Text style={[type.num, styles.recTime]}>{clock(recorder.elapsed)}</Text>
              <Text style={[type.small, styles.flex]} numberOfLines={1}>
                {recorder.phase === "starting" ? "Starting the mic…" : micMode.current === "toggle" ? "Tap the mic to send" : "Release to send"}
                {recorder.elapsed > MAX_RECORD_MS - 10_000 ? ` · ${Math.ceil((MAX_RECORD_MS - recorder.elapsed) / 1000)}s left` : ""}
              </Text>
            </View>
          ) : transcribing ? (
            <View style={styles.recordBar}>
              <Pressable onPress={cancelMic} hitSlop={10} style={styles.cancel} accessibilityRole="button" accessibilityLabel="Cancel">
                <Ionicons name="close" size={20} color={colors.ink} />
              </Pressable>
              <ActivityIndicator size="small" color={colors.dim} />
              <Text style={[type.small, styles.flex]}>Reading your words…</Text>
            </View>
          ) : (
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder={busy ? "Add to the running request…" : "Message the agent"}
              placeholderTextColor={colors.faint}
              style={styles.input}
              multiline
              numberOfLines={native ? undefined : 1}
              accessibilityLabel="Message"
            />
          )}
          {/* The mic stays mounted while it records, so the release (onPressOut) always arrives. */}
          <Pressable
            onPressIn={onMicIn}
            onPressOut={onMicOut}
            disabled={transcribing}
            style={[styles.send, styles.mic, recording && styles.micOn, transcribing && styles.disabled, !native && styles.noSelect]}
            accessibilityRole="button"
            accessibilityLabel={recording ? "Send the recording" : "Hold to talk"}
            accessibilityHint="Press and hold to record, release to send. Or tap once to start and tap again to send."
          >
            <Ionicons name={recording ? "mic" : "mic-outline"} size={20} color={recording ? "#FFFFFF" : colors.ink} />
          </Pressable>
          {!recording && !transcribing &&
            (busy && !input.trim() ? (
              <Pressable onPress={stop} style={[styles.send, { backgroundColor: colors.raised }]} accessibilityRole="button" accessibilityLabel="Stop">
                <Ionicons name="stop" size={18} color={colors.ink} />
              </Pressable>
            ) : (
              <Pressable onPress={() => void send(input)} disabled={!input.trim()} style={[styles.send, !input.trim() && styles.disabled]} accessibilityRole="button" accessibilityLabel="Send">
                <Ionicons name="arrow-up" size={20} color="#FFFFFF" />
              </Pressable>
            ))}
        </View>
      </KeyboardAvoidingView>
        )}
      </AgentBody>
    </Screen>
  );
}

/** Gives the agent layout the header and tab bar padding, and the keyboard state. */
function AgentBody({ children }: { children: (v: { top: number; bottom: number; keyboard: boolean }) => ReactNode }) {
  const { top, bottom } = useScreenInsets();
  const keyboard = useKeyboardOpen();
  return <>{children({ top, bottom, keyboard })}</>;
}

/** A red dot that pulses while the mic records. */
function RecDot() {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.3, duration: 600, useNativeDriver: native }),
        Animated.timing(v, { toValue: 1, duration: 600, useNativeDriver: native }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return <Animated.View style={[styles.recDot, { opacity: v }]} />;
}

/** The transcript as an editable bubble. It sends itself after 1.5 s unless the user edits or cancels. */
function VoiceDraft({ draft, onChange, onEdit, onCancel, onSend }: {
  draft: { text: string; editing: boolean };
  onChange: (t: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    progress.setValue(0);
    if (draft.editing) return;
    const a = Animated.timing(progress, { toValue: 1, duration: SEND_DELAY_MS, easing: Easing.linear, useNativeDriver: native });
    a.start();
    return () => a.stop();
  }, [draft.editing, progress]);
  return (
    <View style={styles.draft}>
      <View style={styles.draftBubble}>
        <TextInput value={draft.text} onChangeText={onChange} onFocus={onEdit} multiline style={[type.body, styles.draftInput]} accessibilityLabel="Your words, before they are sent" />
      </View>
      <View style={styles.draftRow}>
        {!draft.editing ? (
          <>
            <View style={styles.draftTrack}>
              <Animated.View style={[styles.draftFill, { transform: [{ scaleX: progress }] }]} />
            </View>
            <Text style={type.small}>Sending…</Text>
          </>
        ) : (
          <Text style={[type.small, styles.flex]}>Edit your words, then send.</Text>
        )}
        <Pressable onPress={onCancel} hitSlop={8} style={styles.draftBtn} accessibilityRole="button" accessibilityLabel="Cancel">
          <Text style={[type.small, { color: colors.ink }]}>Cancel</Text>
        </Pressable>
        {draft.editing && (
          <Pressable onPress={onSend} disabled={!draft.text.trim()} hitSlop={8} style={[styles.draftBtn, styles.draftSend]} accessibilityRole="button" accessibilityLabel="Send">
            <Text style={[type.small, { color: "#FFFFFF" }]}>Send</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function Message({ message, streaming, onSettled }: { message: ChatMessage; streaming: boolean; onSettled: (i: Intent) => void }) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
    return (
      <View style={styles.userBubble}>
        {message.voice && <Ionicons name="mic" size={13} color="rgba(255,255,255,0.8)" style={styles.userMic} />}
        <Text style={[type.body, styles.userText]}>{text}</Text>
      </View>
    );
  }
  const duration = message.startedAt && message.endedAt ? message.endedAt - message.startedAt : null;
  return (
    <View style={styles.assistant}>
      {streaming ? <StepLine message={message} startedAt={message.startedAt ?? Date.now()} /> : <StepsSummary message={message} durationMs={duration} />}
      {message.parts.map((p, i) =>
        p.kind === "text" ? (
          p.text.trim() ? (
            <Glass key={i} radius={radius.lg} style={styles.assistantBubble}>
              <Markdown text={p.text} />
            </Glass>
          ) : null
        ) : p.kind === "intent" ? (
          <Card key={p.intent.id} style={styles.intent}>
            <IntentConfirm intent={p.intent} compact onSettled={onSettled} />
          </Card>
        ) : null,
      )}
      {message.error && <Notice tone="bad">{message.error}</Notice>}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: "center" },
  list: { paddingHorizontal: space.lg, gap: space.md, paddingBottom: space.lg },
  empty: { gap: space.md },
  hello: { alignItems: "center", gap: space.sm, paddingVertical: space.lg, paddingHorizontal: space.md },
  helloIcon: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(131,110,249,0.5)", marginBottom: space.xs },
  helloBrands: { flexDirection: "row", gap: space.lg, marginTop: space.xs, flexWrap: "wrap", justifyContent: "center" },
  suggestion: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 56, paddingVertical: space.md },
  userBubble: { alignSelf: "flex-end", maxWidth: "85%", backgroundColor: colors.accent, borderRadius: radius.lg, borderBottomRightRadius: 6, paddingHorizontal: space.md + 2, paddingVertical: space.sm + 2, flexDirection: "row", gap: 6, boxShadow: "0px 6px 18px rgba(131,110,249,0.30)" },
  userText: { color: "#FFFFFF" },
  userMic: { marginTop: 4 },
  assistant: { gap: space.sm, alignItems: "stretch" },
  assistantBubble: { paddingHorizontal: space.lg, paddingVertical: space.md, borderTopLeftRadius: 6, alignSelf: "flex-start", maxWidth: "100%" },
  intent: { borderColor: "rgba(131,110,249,0.6)" },
  banner: { paddingHorizontal: space.md, paddingBottom: space.sm },
  inputBar: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, paddingHorizontal: space.md, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  // position: relative keeps the field above the glass fill on web.
  input: { ...fonts.sans, position: "relative", flex: 1, minHeight: 44, maxHeight: 120, backgroundColor: "rgba(255,255,255,0.07)", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 22, color: colors.ink, paddingHorizontal: space.lg, paddingTop: 12, paddingBottom: 12, fontSize: 16 },
  recordBar: { flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 22, paddingHorizontal: space.sm },
  cancel: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.raised },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.bad },
  recTime: { minWidth: 40 },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  mic: { backgroundColor: "rgba(255,255,255,0.08)", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  micOn: { backgroundColor: colors.bad, transform: [{ scale: 1.08 }] },
  noSelect: { userSelect: "none" } as object,
  disabled: { opacity: 0.4 },
  draft: { paddingHorizontal: space.md, paddingBottom: space.sm, gap: space.xs },
  draftBubble: { alignSelf: "flex-end", maxWidth: "90%", minWidth: "50%", backgroundColor: colors.accentSoft, borderColor: colors.accent, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, borderBottomRightRadius: 4, paddingHorizontal: space.md, paddingVertical: space.xs },
  draftInput: { color: colors.ink, minHeight: 32, paddingVertical: 6 },
  draftRow: { flexDirection: "row", alignItems: "center", gap: space.sm, justifyContent: "flex-end" },
  draftTrack: { width: 60, height: 3, borderRadius: 2, backgroundColor: colors.line, overflow: "hidden" },
  draftFill: { width: 60, height: 3, backgroundColor: colors.accent, transformOrigin: "left" } as object,
  draftBtn: { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.md, backgroundColor: colors.raised },
  draftSend: { backgroundColor: colors.accent },
});
