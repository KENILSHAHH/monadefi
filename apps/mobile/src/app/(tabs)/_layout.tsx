import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs } from "expo-router";
import type { ComponentProps } from "react";
import { Platform, StyleSheet, type ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassFill } from "@/components/Glass";
import { colors, fonts } from "@/theme";

type Icon = ComponentProps<typeof Ionicons>["name"];
const icon = (name: Icon) => ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={name} color={color} size={size} />;

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  // Each screen paints its own opaque page color and northern lights (components/ui Screen), so no scene is transparent.
  // On web the navigator keeps the visited tabs mounted: a scene that is not focused gets display: none, so it is never
  // painted. On native, react-native-screens detaches it. The glass tab bar floats over the content; the screens pad
  // their content by the tab bar height.
  return (
    <Tabs
      detachInactiveScreens
      screenOptions={({ navigation }) => ({
        headerShown: false,
        lazy: true,
        freezeOnBlur: Platform.OS !== "web",
        tabBarActiveTintColor: colors.ink,
        tabBarInactiveTintColor: colors.faint,
        tabBarHideOnKeyboard: Platform.OS === "android",
        tabBarStyle: [styles.bar, { height: 62 + insets.bottom, paddingBottom: insets.bottom + 6 }],
        tabBarItemStyle: styles.item,
        tabBarLabelStyle: styles.label,
        tabBarBackground: () => <GlassFill tone="bar" />,
        sceneStyle: [styles.scene, Platform.OS === "web" && !navigation.isFocused() && styles.hidden],
      })}
    >
      <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: icon("wallet-outline") }} />
      <Tabs.Screen name="markets" options={{ title: "Markets", tabBarIcon: icon("stats-chart-outline") }} />
      <Tabs.Screen name="agent" options={{ title: "Agent", tabBarIcon: icon("chatbubble-ellipses-outline") }} />
      <Tabs.Screen name="activity" options={{ title: "Activity", tabBarIcon: icon("time-outline") }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: icon("settings-outline") }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: { position: "absolute", backgroundColor: "transparent", borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth, elevation: 0 },
  item: { paddingTop: 4 },
  label: { ...fonts.sansMedium, fontSize: 11, lineHeight: 14 },
  scene: { backgroundColor: colors.bg },
  hidden: { display: "none" },
});
