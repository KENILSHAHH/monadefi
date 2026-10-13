import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * The relying party id (RP id) is the web domain that owns the passkeys.
 * The same value must be in EXPO_PUBLIC_RP_ID at build time, in the iOS associated domains,
 * and on the domain in /.well-known/apple-app-site-association and /.well-known/assetlinks.json.
 */
const RP_ID = process.env.EXPO_PUBLIC_RP_ID ?? "app.3-83-183-92.sslip.io";
const BUNDLE_ID = process.env.MONADEFI_BUNDLE_ID ?? "xyz.monadefi.app";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Mona-DeFi",
  slug: "monadefi",
  scheme: "monadefi",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "dark",
  backgroundColor: "#0B0D10",
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: false,
    associatedDomains: [`webcredentials:${RP_ID}`],
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: BUNDLE_ID,
    adaptiveIcon: {
      backgroundColor: "#0B0D10",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  // The mobile website. Single-page output: a static host with an SPA fallback to index.html serves every route.
  // public/index.html adds the home screen (PWA) meta tags and public/manifest.webmanifest.
  web: {
    bundler: "metro",
    output: "single",
    favicon: "./assets/favicon.png",
    name: "Mona-DeFi",
    shortName: "Mona-DeFi",
    themeColor: "#0B0D10",
    backgroundColor: "#0B0D10",
    description: "Perps on Monad, from a passkey.",
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    // Hold-to-talk in the Agent tab (Deepgram through the server). No background recording.
    ["expo-audio", { microphonePermission: "Mona-DeFi uses the microphone when you hold the mic button to talk to the agent.", enableBackgroundRecording: false, enableBackgroundPlayback: false }],
    ["expo-splash-screen", { image: "./assets/splash-icon.png", imageWidth: 160, backgroundColor: "#0B0D10" }],
    // Passkeys with the PRF extension need iOS 18 or later and Android 9 (API 28) or later.
    ["expo-build-properties", { ios: { deploymentTarget: "18.0" }, android: { minSdkVersion: 28 } }],
  ],
  experiments: { typedRoutes: true },
  extra: { rpId: RP_ID },
});
