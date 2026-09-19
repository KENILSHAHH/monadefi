import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ApiError } from "@/lib/api/client";
import { AuthProvider, useAuth } from "@/lib/auth/AuthProvider";
import { colors } from "@/theme";

const header = {
  headerShown: true,
  headerStyle: { backgroundColor: colors.bg },
  headerTintColor: colors.ink,
  headerShadowVisible: false,
  headerBackButtonDisplayMode: "minimal" as const,
  headerTitleStyle: { fontWeight: "600" as const },
};

function RootStack() {
  const { state } = useAuth();
  const ready = state.tag === "ready";
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={ready}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="market/[symbol]" options={{ ...header, title: "" }} />
        <Stack.Screen name="trade/[symbol]" options={{ ...header, title: "Trade" }} />
        <Stack.Screen name="session" options={{ ...header, title: "Trading permission", presentation: "modal" }} />
        <Stack.Screen name="deposit" options={{ ...header, title: "Add funds", presentation: "modal" }} />
        <Stack.Screen name="withdraw" options={{ ...header, title: "Withdraw", presentation: "modal" }} />
      </Stack.Protected>
      <Stack.Protected guard={!ready}>
        <Stack.Screen name="welcome" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
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
  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <AuthProvider>
          <StatusBar style="light" />
          <RootStack />
        </AuthProvider>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
