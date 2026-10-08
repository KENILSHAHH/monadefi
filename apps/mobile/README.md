# Mona-DeFi mobile

Mona-DeFi is a mobile trading app on Monad (chain 143). A passkey is the account. Perpl is the exchange. AUSD is the money. Nansen checks each trade before it is sent. Aurora Intents brings funds from any chain.

Stack: Expo SDK 57, React Native 0.86, Expo Router, TypeScript strict, TanStack Query, viem, `@category-labs/mera` 0.2.0.

## What the app does

| Screen | What it does | API routes |
|---|---|---|
| Welcome | One passkey ceremony: create the account, or sign in. Then it signs the server challenge with no prompt. | `/auth/mera/challenge`, `/auth/mera/verify` |
| Trading permission | Shows the scope. One tap: EIP-7702 upgrade (if needed), then two EIP-712 delegations. No prompts. | `/session`, `/session/upgrade`, `/session/start`, `/session/grant` |
| Home | AUSD total (wallet + Perpl free + in positions), positions with PnL and liquidation distance, pull to refresh, close a position. | `/balance`, `/positions`, `/trade/close`, `/intents/:id/confirm` |
| Markets | Mark, 24h change, max leverage, funding. Detail: 24h chart and the order book. | `/perpl/markets`, `/perpl/markets/:symbol/candles`, `/perpl/markets/:symbol/book` |
| Trade | Side, AUSD margin, leverage slider (up to the market max), optional stop-loss and take-profit, Nansen risk card, preview, confirm sheet, fill price and Monadscan link. A blocked trade shows why. | `/risk/check`, `/trade/preview`, `/intents/:id/confirm` |
| Add funds | "Monad": QR of the wallet address. "Any chain": Aurora Intents with a quote, a deposit address, the memo, and a live progress view. Connect mode signs one message. Swap mode signs the USDC to AUSD swap through the relay. | `/deposit/aurora/*`, `/relay/send` |
| Agent | The chat stream (SSE over `expo/fetch`): text, tool steps, intent cards with Confirm and Reject. | `/chat`, `/chat/message`, `/intents/:id/*` |
| Activity | Trades, jobs and relays in one feed, with explorer links. | `/activity` |
| Settings | Address, permission scope and Revoke, withdraw AUSD (Perpl to wallet, wallet to an address) through the relay, RP id, the stateless explanation, lock, sign out. | `DELETE /session`, `/relay/prepare`, `/relay/send` |

The app has no mock data. If a route does not answer, the screen shows its error state and a retry button.

## Setup

Requirements:

- Node 24 (Mera needs Node 24 or later for its tests and tools).
- Xcode 16 or later with an iOS 18 device, or Android Studio with an Android 9 (API 28) or later device.
- Use a physical device. Passkeys with the PRF extension need a real platform authenticator (iCloud Keychain or Google Password Manager). Simulator support is limited.

This app has its own npm install and lockfile. It is not in the pnpm workspace: `pnpm-workspace.yaml` has `!apps/mobile`, because Expo installs with pnpm at the workspace root otherwise.

```sh
cd apps/mobile
npm install
cp .env.example .env    # then edit the values
npm test                # unit tests
npx tsc --noEmit        # typecheck
```

### Environment variables

| Name | Default | Use |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | `http://localhost:8787` | Base URL of `apps/api`. On a device, use the LAN IP of your computer or an HTTPS tunnel, not `localhost`. |
| `EXPO_PUBLIC_RP_ID` | `app.3-83-183-92.sslip.io` | Passkey relying party id. It must be a domain that serves the two files below. The app config also writes it into the iOS associated domains. |
| `EXPO_PUBLIC_MONAD_RPC` | `https://rpc.monad.xyz` | Monad RPC. The app reads only the wallet nonce for the EIP-7702 authorization. |
| `MONADEFI_BUNDLE_ID` | `xyz.monadefi.app` | iOS bundle id and Android package. Change it to an id that your Apple team owns. |

Expo puts `EXPO_PUBLIC_*` values into the bundle at build time. Restart Metro after a change.

## Associated domains (needed for passkeys)

The relying party domain must say that the app may use its passkeys. Templates are in `well-known/`. Host both on `https://<RP_ID>/.well-known/` over HTTPS, as `application/json`, with no redirect.

1. `apple-app-site-association`: replace `TEAM_ID` with your Apple team id, and `xyz.monadefi.app` with your bundle id.

   ```json
   { "webcredentials": { "apps": ["ABCDE12345.xyz.monadefi.app"] } }
   ```

2. `assetlinks.json`: replace the package name and the SHA-256 fingerprint of each signing certificate (debug, EAS, Play).

   ```sh
   keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android | grep SHA256
   npx eas-cli credentials        # shows the fingerprint of the EAS keystore
   ```

The app config adds `webcredentials:<RP_ID>` to the iOS entitlements (`app.config.ts`). Check it after a prebuild:

```sh
npx expo prebuild --no-install
cat ios/MonaDeFi/MonaDeFi.entitlements    # webcredentials:app.3-83-183-92.sslip.io
```

Apple caches the association file through its CDN. After you change the file, delete and reinstall the app. In development you can add `?mode=developer` to the entitlement and turn on Associated Domains Development in the iOS developer settings.

## Development build

Passkeys need native code (`react-native-passkey`), so Expo Go does not work. Use a development build.

```sh
npx expo run:ios --device       # builds and installs on a connected iPhone (needs your Apple team in Xcode)
npx expo run:android --device   # builds and installs on a connected Android phone
npm start                       # Metro for the development client
```

EAS profiles are in `eas.json`: `development` (development client, internal), `preview` (internal), `production`.

```sh
npx eas-cli build --profile development --platform ios
npx eas-cli build --profile development --platform android
```

Set `EXPO_PUBLIC_RP_ID` and `EXPO_PUBLIC_API_URL` in the profile `env` or as EAS environment variables before a build.

## How the account works (Mera)

Sources: the package source (`@category-labs/mera@0.2.0`, `src/passkey.ts`, `src/viem.ts`) and the docs pages "Create passkey accounts", "Use mera with React Native" and "Signing sessions" on https://mera.category.xyz.

1. **One ceremony.** First use: `createPasskeyWithPrfOutput({ rp: { id: RP_ID, name: "Mona-DeFi" }, user, webAuthnClient: reactNativeWebAuthnClient })`. Later: `getPasskeyPrfOutput({ rpId, credential?, webAuthnClient })`. Both return 32 PRF bytes. Mera uses the fixed salt `sha256("mera.prf.salt.v1")`, so the same passkey always gives the same bytes. (On an authenticator that does not give PRF output at creation, Mera adds one assertion. The docs say so. Then the first use has two prompts.)
2. **Derivation** (`src/lib/mera/derive.ts`), exactly as the Mera recipe: PRF bytes as BIP-39 entropy → 24 words → BIP-39 seed (no passphrase) → BIP-32 `m/44'/60'/0'/0/0` → secp256k1 key → `createSecp256k1SigningSession`. The PRF bytes, the seed and the key copy are zeroed. Only the session holds the key.
3. **Prompt-free signing.** `toViemAccount(session)` gives a viem account. `signMessage` (sign-in, Aurora Connect), `signTypedData` (the session delegations, the relays), and `signAuthorization` (EIP-7702) need no prompt.
4. **Memory only.** The key is never written to storage. It ends on "Lock now", on sign out, and after 5 minutes in the background.

Local storage (expo-secure-store) holds only data that is safe to lose: the API token, the last address, and the passkey credential id (a hint so the right passkey shows first).

## The stateless test

A judge can clear the app data or use a new phone. The account comes back from the passkey alone:

1. The app has no hint, so it shows "Sign in with passkey".
2. The platform offers every Mona-DeFi passkey for the RP id (a discoverable credential). iCloud Keychain and Google Password Manager sync it to the new phone.
3. The same PRF bytes give the same address. The test `__tests__/derive.test.ts` pins it: 32 zero bytes always give `0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb`.
4. The app signs a new server challenge with no prompt and gets a new token.
5. Everything else is on-chain or on the server, and the server is untrusted storage. Balances and positions come from Monad. The trading permissions are delegations that the wallet signed. The server cannot change them, because the delegation contracts check the wallet signature on-chain. The server cannot withdraw or transfer funds.

A stored token is used only when its address equals the address that the passkey derives now (`canReuseToken`). A swapped token from another account is ignored.

## Demo flow (2-minute video)

1. **0:00 Passkey login.** Fresh install. Tap "Create account with passkey". Face ID. The home screen shows the address. No seed phrase, no email.
2. **0:15 Scoped session.** Tap the "Turn on trading" banner. Show the scope: can and cannot, end date. Tap "Turn on trading". The EIP-7702 upgrade and the two signatures run with no prompt. Open the upgrade transaction on Monadscan.
3. **0:35 Fund AUSD.** Add funds → "Any chain" → Base → USDC → 25. The quote shows. Tap the button. The app signs the Aurora Connect order with no prompt and shows the QR. Send from another wallet. The progress view moves to "Arrived on Monad as AUSD". (Or "Monad" tab: send AUSD to the QR.) The home balance updates.
4. **1:05 Select a market.** Markets → ETH: chart, book, funding. Tap Long.
5. **1:15 Nansen risk check.** 20 AUSD, slide to 10x, stop-loss on. Tap "Check risk". The card shows the decision, the level, the smart money, whale and exchange signals, and "Leverage 10x → 4x because …".
6. **1:35 Perpl trade.** "Preview with the changes" → the confirm sheet shows what Nansen changed → Confirm (haptic). The result shows the fill price and the Monadscan link.
7. **1:50 Stateless.** Settings → Sign out (or delete the app). Sign in with the passkey: the same address and the same open position come back.

## Tests and checks

```sh
npm test                    # 42 unit tests
npx tsc --noEmit            # strict typecheck
npx expo export --platform ios
npx expo-doctor
```

- `derive.test.ts`: fixed PRF bytes → fixed addresses, cross-checked with viem `mnemonicToAccount`. Also: zeroing, and a signature that recovers to the address.
- `machine.test.ts`: the auth state machine (first use, later launch, stateless sign-in, cancel, server error and retry with no prompt, 401, lock, sign out), the token reuse rule, and the session plan.
- `format.test.ts`: amounts, prices, percentages, typed amounts, dates, and leverage and liquidation helpers.
- `protocol.test.ts`: the SSE parser, the chat model, the typed data from the server (decimal-string salts), and EIP-7702 and EIP-712 signatures that recover to the wallet.
- `deposit.test.ts`: the Aurora deposit phases.
- `live-api.test.ts` (opt-in): signs in to a running API with a throwaway key and calls every read route. It sends no transaction.

  ```sh
  MONADEFI_LIVE_API=1 EXPO_PUBLIC_API_URL=http://localhost:8787 npx jest live-api
  ```

## Layout

```
app.config.ts          app name, bundle id, associated domains, iOS 18 / Android 28
eas.json               EAS build profiles
index.ts               polyfills, then expo-router/entry
well-known/            apple-app-site-association and assetlinks.json templates
src/polyfills.ts       crypto.getRandomValues from expo-crypto (Mera React Native guide)
src/app/               screens (Expo Router)
src/components/        UI kit, risk card, intent views, chart, book, QR
src/lib/mera/          passkey ceremonies, derivation, the in-memory signer
src/lib/auth/          the auth state machine and its provider
src/lib/api/           typed API client and the contract types
src/lib/wallet.ts      EIP-7702 upgrade, session grants, relays, withdraw calls
__tests__/             unit tests
```
