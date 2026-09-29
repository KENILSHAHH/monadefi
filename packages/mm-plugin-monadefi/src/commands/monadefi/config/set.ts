import { CommandError, type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { CONFIG_KEYS, configPath, describeConfig, isConfigKey, setConfig, unsetConfig, type ConfigView } from "../../../lib/config";
import { bool } from "../../../lib/inputs";

const inputs = {
  key: { type: InputFieldType.Text, flag: "key", message: `Setting: ${CONFIG_KEYS.join(", ")}`, required: true, prompt: false, index: 0 },
  value: { type: InputFieldType.Text, flag: "value", message: "Value. Omit it (or use -) to read a secret from stdin or a hidden prompt", required: false, prompt: false, index: 1 },
  unset: bool("unset", "Remove the setting from the plugin config file"),
} satisfies InputSchema;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8").trim();
}

interface Result { saved: ConfigView; file: string }

export default class MonadefiConfigSet extends PluginCommand<Result> {
  static override description = "Save a monadefi setting (nansen-key, aurora-key, slippage-bps) in the plugin's own config file (mode 0600). Secrets are never printed.";
  static override examples = [
    "printf %s \"$NANSEN_KEY\" | <%= config.bin %> monadefi config set nansen-key",
    "<%= config.bin %> monadefi config set aurora-key",
    "<%= config.bin %> monadefi config set slippage-bps 75",
    "<%= config.bin %> monadefi config set nansen-key --unset",
  ];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "monadefi:config:set";

  async execute(io: CommandIO): Promise<Result> {
    const r = await io.resolveInputs(inputs);
    const key = String(r.key ?? "").trim().toLowerCase();
    if (!isConfigKey(key)) throw new CommandError("INVALID_CONFIG_KEY", `Unknown setting "${key}".`, `Use one of: ${CONFIG_KEYS.join(", ")}.`);
    if (r.unset) {
      unsetConfig(key);
      return { saved: describeConfig(key), file: configPath() };
    }
    let value = r.value && r.value !== "-" ? String(r.value) : "";
    if (!value) value = await readStdin();
    if (!value && io.isInteractive) value = await io.ask({ kind: "password", message: `Value for ${key}` });
    if (!value) throw new CommandError("MISSING_ARG", `No value for ${key}.`, `Pipe it on stdin: printf %s "$VALUE" | mm monadefi config set ${key}`);
    try {
      setConfig(key, value);
    } catch (err) {
      throw new CommandError("INVALID_CONFIG_VALUE", err instanceof Error ? err.message : String(err), "Check the value and try again.");
    }
    return { saved: describeConfig(key), file: configPath() };
  }

  override successHint(d: Result): string {
    return `${d.saved.key}: ${d.saved.set ? `set (source ${d.saved.source})` : "not set"}${d.saved.value ? ` = ${d.saved.value}` : ""}. File: ${d.file}`;
  }
}
