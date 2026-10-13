/**
 * Native stub (iOS and Android builds). There is no injected wallet in the app, and the app needs no MetaMask SDK:
 * "Open in MetaMask" opens the web page /fund in the MetaMask app browser. The web build uses provider.web.ts.
 */
import { Linking } from "react-native";
import { config } from "../config";
import type { Eip1193Provider } from "./core";

export const METAMASK_RDNS = "io.metamask";

export const isPlainMetaMask = (_p: unknown): _p is Eip1193Provider => false;

export const findMetaMask = async (_timeoutMs?: number): Promise<Eip1193Provider | null> => null;

/** Native shows the same "Open in MetaMask" link as a phone browser. */
export const isPhoneBrowser = () => true;

/** The website origin that serves /fund. */
export const appOrigin = () => `https://${config.rpId}`;

export function openExternal(url: string): void {
  void Linking.openURL(url).catch(() => undefined);
}

export const canUseProvider = false;
