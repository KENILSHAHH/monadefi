import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useRef } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Aurora } from "@/components/Aurora";
import { Brand } from "@/components/Logo";
import { Button, Card, Notice } from "@/components/ui";
import { useAuth } from "@/lib/auth/AuthProvider";
import { short } from "@/lib/format";
import { colors, fonts, radius, space, type } from "@/theme";

const POINTS: { icon: "finger-print" | "flash" | "shield-checkmark"; title: string; text: string }[] = [
  { icon: "finger-print", title: "Your passkey is your account", text: "No seed phrase, no email, no extension. Face ID or your fingerprint opens it." },
  { icon: "flash", title: "Trade without prompts", text: "A scoped permission lets Mona-DeFi place Perpl orders for you. It cannot withdraw." },
  { icon: "shield-checkmark", title: "Checked by Nansen first", text: "Each trade gets a smart-money and whale risk check before it is sent." },
];

/** Onboarding, lock screen and sign-in progress. The only screen with a passkey prompt. */
export default function Welcome() {
  const { state, unlock, retry, signOut } = useAuth();
  const autoStarted = useRef(false);

  // App start with a passkey hint: start the one ceremony at once. Not on web: a browser needs a user gesture
  // (a tap on "Unlock with passkey") to start a passkey ceremony.
  useEffect(() => {
    if (Platform.OS === "web") return;
    if (state.tag === "locked" && state.reason === "start" && !state.error && !autoStarted.current) {
      autoStarted.current = true;
      void unlock("signin");
    }
  }, [state, unlock]);

  const busy = state.tag === "passkey" || state.tag === "deriving" || state.tag === "authenticating" || state.tag === "booting";
  const progress =
    state.tag === "passkey" ? (state.mode === "create" ? "Creating your passkey…" : "Waiting for your passkey…") :
    state.tag === "deriving" ? "Opening your account…" :
    state.tag === "authenticating" ? "Signing in to Mona-DeFi…" : null;

  return (
    <View style={styles.root}>
      <Aurora />
    <SafeAreaView style={styles.screen}>
      <View style={styles.top}>
        <View style={styles.logo}>
          <Text style={styles.logoText}>M</Text>
        </View>
        <Text style={styles.brand}>Mona-DeFi</Text>
        <Text style={[type.body, styles.tagline]}>Perps on Monad, from a passkey.</Text>
        <View style={styles.brands}>
          <Brand id="monad" label="Monad" />
          <Brand id="perpl" label="Perpl" />
          <Brand id="nansen" label="Nansen" />
        </View>
      </View>

      {state.tag === "signedOut" && (
        <View style={styles.points}>
          {POINTS.map((p) => (
            <Card key={p.title} style={styles.point}>
              <View style={styles.pointIcon}>
                <Ionicons name={p.icon} size={18} color={colors.accent} />
              </View>
              <View style={styles.flex}>
                <Text style={type.h2}>{p.title}</Text>
                <Text style={type.small}>{p.text}</Text>
              </View>
            </Card>
          ))}
        </View>
      )}

      {(state.tag === "locked" || state.tag === "authError") && (
        <View style={[styles.points, styles.lockBox]}>
          <Ionicons name="lock-closed" size={28} color={colors.dim} style={styles.lockIcon} />
          <Text style={[type.h2, styles.center]}>{state.tag === "authError" ? "Your account is open" : "Your account is locked"}</Text>
          {state.address && <Text style={[type.mono, styles.center, { color: colors.dim }]}>{short(state.address)}</Text>}
          {state.tag === "locked" && state.reason === "timeout" && <Text style={[type.small, styles.center]}>Mona-DeFi ended the signing key after some time in the background.</Text>}
        </View>
      )}

      <View style={styles.bottom}>
        {state.tag === "signedOut" && state.error && <Notice tone="bad">{state.error}</Notice>}
        {state.tag === "locked" && state.error && <Notice tone="bad">{state.error}</Notice>}
        {state.tag === "authError" && <Notice tone="bad">{state.error}</Notice>}

        {busy && (
          <View style={styles.progress}>
            <ActivityIndicator color={colors.accent} />
            <Text style={type.small}>{progress ?? "Loading…"}</Text>
          </View>
        )}

        {state.tag === "signedOut" && (
          <>
            <Button title="Create account with passkey" icon="finger-print" onPress={() => void unlock("create")} />
            <Button title="Sign in with passkey" variant="secondary" icon="key-outline" onPress={() => void unlock("signin")} />
            <Text style={[type.tiny, styles.center]}>{Platform.OS === "web" ? "One Face ID or fingerprint check. Your key stays in this tab only and is never stored." : "One Face ID or fingerprint check. Your key never leaves this device and is never stored."}</Text>
          </>
        )}
        {state.tag === "locked" && (
          <>
            <Button title="Unlock with passkey" icon="finger-print" onPress={() => void unlock("signin")} />
            <Button title="Use another account" variant="ghost" onPress={() => void signOut()} />
          </>
        )}
        {state.tag === "authError" && (
          <>
            <Button title="Try again" icon="refresh" onPress={retry} />
            <Text style={[type.tiny, styles.center]}>Your key is still open in memory. A retry needs no passkey.</Text>
            <Button title="Sign out" variant="ghost" onPress={() => void signOut()} />
          </>
        )}
      </View>
    </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: "center" },
  root: { flex: 1, backgroundColor: colors.bg, overflow: "hidden" },
  screen: { flex: 1, paddingHorizontal: space.xl },
  brands: { flexDirection: "row", gap: space.lg, marginTop: space.sm },
  lockBox: { gap: space.md },
  top: { alignItems: "center", marginTop: space.xxl * 1.5, gap: space.sm },
  logo: { width: 68, height: 68, borderRadius: 22, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", boxShadow: "0px 10px 30px rgba(131,110,249,0.45)" },
  logoText: { ...fonts.displayBold, color: "#FFFFFF", fontSize: 34 },
  brand: { ...fonts.displayBold, color: colors.ink, fontSize: 36, letterSpacing: -0.6, marginTop: space.sm },
  tagline: { color: colors.dim },
  points: { flex: 1, justifyContent: "center", gap: space.md },
  point: { flexDirection: "row", gap: space.md, alignItems: "flex-start" },
  pointIcon: { width: 36, height: 36, borderRadius: radius.md, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" },
  lockIcon: { alignSelf: "center" },
  bottom: { gap: space.md, paddingBottom: space.lg, marginTop: "auto" },
  progress: { flexDirection: "row", gap: space.sm, alignItems: "center", justifyContent: "center", paddingVertical: space.md },
});
