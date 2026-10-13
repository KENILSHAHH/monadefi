import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { AppState, Platform, StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GlassFill } from "@/components/Glass";
import { showToast, ToastHost } from "@/components/Toast";
import { ApiError } from "@/lib/api/client";
import { AuthProvider, useAuth } from "@/lib/auth/AuthProvider";
import { keys } from "@/lib/queries";
import { ensureSession, sessionManager } from "@/lib/session";
import { FONT_FILES } from "@/lib/fonts";
import { colors, fonts } from "@/theme";

// Native: keep the splash screen until the fonts are in (web loads them with @font-face, see public/index.html).
if (Platform.OS !== "web") void SplashScreen.preventAutoHideAsync().catch(() => undefined);
const hasFonts = Object.keys(FONT_FILES).length > 0;

/**
 * Stack headers are glass: transparent, with a blurred fill behind the title. The screen content starts below the
 * header (components/ui Screen reads the header height) and scrolls under it.
 */
const header = {
  headerShown: true,
  headerTransparent: true,
  headerBackground: () => <GlassFill tone="bar" />,
  headerTintColor: colors.ink,
  headerShadowVisible: false,
  headerBackButtonDisplayMode: "minimal" as const,
  headerTitleStyle: { ...fonts.sansBold, fontSize: 17, color: colors.ink } as { fontFamily?: string; fontSize: number; color: string },
};

function RootStack() {
  const { state } = useAuth();
  const ready = state.tag === "ready";
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={ready}>
        <Stack.Screen name="(tabs)" options={{ title: "Mona-DeFi" }} />
        <Stack.Screen name="market/[symbol]" options={{ ...header, title: "" }} />
        <Stack.Screen name="trade/[symbol]" options={{ ...header, title: "Trade" }} />
        <Stack.Screen name="deposit" options={{ ...header, title: "Add funds", presentation: "modal" }} />
        <Stack.Screen name="withdraw" options={{ ...header, title: "Withdraw", presentation: "modal" }} />
      </Stack.Protected>
      <Stack.Protected guard={!ready}>
        <Stack.Screen name="welcome" />
      </Stack.Protected>
      {/* Public: no sign-in. Opens in the MetaMask app browser, where passkeys may not work. */}
      <Stack.Screen name="fund" options={{ ...header, title: "Deposit" }} />
    </Stack>
  );
}

/**
 * Prompt-free trading with no setup screen: after the passkey, the in-memory key sets up the scoped session
 * in the background (see lib/session). It runs again when the app comes back to the foreground.
 */
function SessionAutopilot() {
  const { state } = useAuth();
  const qc = useQueryClient();
  const ready = state.tag === "ready";

  useEffect(
    () =>
      sessionManager.onSetup((e) => {
        void qc.invalidateQueries({ queryKey: keys.session });
        if (e.first) showToast("Trading is on: Perpl only, no withdrawals.");
      }),
    [qc],
  );

  useEffect(() => {
    if (!ready) return;
    void ensureSession().then(() => qc.invalidateQueries({ queryKey: keys.session }));
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void ensureSession();
    });
    return () => sub.remove();
  }, [ready, qc]);

  return null;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(hasFonts ? FONT_FILES : {});
  const ready = !hasFonts || fontsLoaded || Boolean(fontError);
  useEffect(() => {
    if (ready && Platform.OS !== "web") SplashScreen.hide();
  }, [ready]);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            // A missing route (404) or a bad request does not get better with retries.
            retry: (count, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 2,
          },
        },
      }),
  );
  if (!ready) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <AuthProvider>
          <StatusBar style="light" />
          <View style={styles.page}>
            <View style={styles.column}>
              <RootStack />
              <ToastHost />
            </View>
          </View>
          <SessionAutopilot />
        </AuthProvider>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

// On web the app is a narrow mobile column. On a wide (desktop) window it is centered with a max width.
// On native the column fills the screen.
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, ...(Platform.OS === "web" ? { alignItems: "center" as const } : {}) },
  column: {
    flex: 1,
    width: "100%",
    backgroundColor: colors.bg,
    ...(Platform.OS === "web" ? { maxWidth: 480, borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, borderColor: colors.line } : {}),
  },
});
