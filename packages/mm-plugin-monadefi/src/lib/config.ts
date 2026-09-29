// The plugin's own settings file. It holds the Nansen key, the Aurora key and the default slippage.
// The host config (~/.metamask/config.json) is host-only, so the plugin keeps its own file with mode 0600.
// Secrets are never printed: `describe()` says only where a key comes from.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_KEYS = ["nansen-key", "aurora-key", "slippage-bps"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

const SECRET_KEYS: ReadonlySet<ConfigKey> = new Set(["nansen-key", "aurora-key"]);
const ENV_FOR: Record<ConfigKey, string> = { "nansen-key": "NANSEN_API_KEY", "aurora-key": "AURORA_API_KEY", "slippage-bps": "MONADEFI_SLIPPAGE_BPS" };

export const DEFAULT_SLIPPAGE_BPS = 50;
export const MAX_SLIPPAGE_BPS = 300;

export function configDir(): string {
  if (process.env.MONADEFI_CONFIG_DIR) return process.env.MONADEFI_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "mm-plugin-monadefi");
}
export const configPath = () => join(configDir(), "config.json");

type Stored = Partial<Record<ConfigKey, string>>;

function readFile(): Stored {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const out: Stored = {};
    for (const k of CONFIG_KEYS) if (typeof raw[k] === "string") out[k] = raw[k] as string;
    return out;
  } catch {
    return {};
  }
}

export function isConfigKey(k: string): k is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(k);
}

/** Check and normalize a value before it is stored. Throws on a bad value. */
export function validateConfigValue(key: ConfigKey, value: string): string {
  const v = value.trim();
  if (!v) throw new Error(`The value for ${key} is empty.`);
  if (key === "slippage-bps") {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SLIPPAGE_BPS) throw new Error(`slippage-bps must be a whole number from 1 to ${MAX_SLIPPAGE_BPS} (50 = 0.5%).`);
    return String(n);
  }
  if (/\s/.test(v)) throw new Error(`The value for ${key} has spaces.`);
  return v;
}

export function setConfig(key: ConfigKey, value: string): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const next = { ...readFile(), [key]: validateConfigValue(key, value) };
  writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(configPath(), 0o600);
  } catch {
    // Best effort on file systems without POSIX modes.
  }
}

export function unsetConfig(key: ConfigKey): void {
  const cur = readFile();
  delete cur[key];
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), `${JSON.stringify(cur, null, 2)}\n`, { mode: 0o600 });
}

/** The value of a setting. The environment wins over the file. Internal use only: never print a secret. */
export function getConfig(key: ConfigKey): string | undefined {
  const env = process.env[ENV_FOR[key]];
  if (env && env.trim()) return env.trim();
  return readFile()[key];
}

export interface ConfigView { key: ConfigKey; set: boolean; source: "env" | "file" | "default" | "none"; value?: string; env: string }

/** A printable view. Secret values are left out. */
export function describeConfig(key: ConfigKey): ConfigView {
  const env = process.env[ENV_FOR[key]];
  const file = readFile()[key];
  const source = env && env.trim() ? "env" : file ? "file" : key === "slippage-bps" ? "default" : "none";
  const set = source !== "none";
  const view: ConfigView = { key, set, source, env: ENV_FOR[key] };
  if (!SECRET_KEYS.has(key)) view.value = getConfig(key) ?? String(DEFAULT_SLIPPAGE_BPS);
  return view;
}

export function slippageBps(override?: string): number {
  if (override !== undefined && override !== "") return Number(validateConfigValue("slippage-bps", override));
  const v = getConfig("slippage-bps");
  return v ? Number(v) : DEFAULT_SLIPPAGE_BPS;
}
