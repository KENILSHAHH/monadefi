/**
 * Web: find the MetaMask provider in the browser. Metro picks this file for the web build; native uses provider.ts.
 *
 * 1. EIP-6963: send `eip6963:requestProvider` and keep only the announcement with rdns "io.metamask".
 * 2. Else `window.ethereum` (or one entry of `window.ethereum.providers`) with `isMetaMask` and no flag of another wallet.
 * The app never uses any other provider.
 */
import { isPhoneUserAgent, type Eip1193Provider } from "./core";

export const METAMASK_RDNS = "io.metamask";

interface Eip6963Detail {
  info?: { rdns?: string; name?: string; uuid?: string };
  provider?: Eip1193Provider;
}

/** Wallets that also set isMetaMask for compatibility. The app does not use them. */
const OTHER_WALLET_FLAGS = [
  "isBraveWallet", "isRabby", "isCoinbaseWallet", "isPhantom", "isTrust", "isTrustWallet", "isOkxWallet", "isOKExWallet",
  "isTokenPocket", "isBitKeep", "isFrame", "isZerion", "isExodus", "isRainbow", "isTally", "isApexWallet", "isPortal",
] as const;

export function isPlainMetaMask(p: unknown): p is Eip1193Provider {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  if (o.isMetaMask !== true || typeof o.request !== "function") return false;
  return !OTHER_WALLET_FLAGS.some((f) => o[f] === true);
}

function legacyMetaMask(): Eip1193Provider | null {
  const eth = (window as unknown as { ethereum?: Eip1193Provider & { providers?: unknown[] } }).ethereum;
  if (!eth) return null;
  if (Array.isArray(eth.providers)) return (eth.providers.find(isPlainMetaMask) as Eip1193Provider | undefined) ?? null;
  return isPlainMetaMask(eth) ? eth : null;
}

/** Wait up to `timeoutMs` for an EIP-6963 announcement from MetaMask. Fall back to window.ethereum. */
export function findMetaMask(timeoutMs = 500): Promise<Eip1193Provider | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (p: Eip1193Provider | null) => {
      if (done) return;
      done = true;
      window.removeEventListener("eip6963:announceProvider", onAnnounce as EventListener);
      clearTimeout(timer);
      resolve(p);
    };
    const onAnnounce = (event: CustomEvent<Eip6963Detail>) => {
      const d = event.detail;
      if (d?.info?.rdns === METAMASK_RDNS && d.provider && typeof d.provider.request === "function") finish(d.provider);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce as EventListener);
    const timer = setTimeout(() => finish(legacyMetaMask()), timeoutMs);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  });
}

/** True in a phone or tablet browser: there the app offers "Open in MetaMask". */
export function isPhoneBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return isPhoneUserAgent(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

/** The origin of this page, for the MetaMask link (works on any host). */
export function appOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

/** Open a link. A same-tab load lets iOS and Android hand the MetaMask universal link to the app. */
export function openExternal(url: string): void {
  if (typeof window !== "undefined") window.location.assign(url);
}

/** The web can talk to a MetaMask extension or the MetaMask browser. */
export const canUseProvider = true;
