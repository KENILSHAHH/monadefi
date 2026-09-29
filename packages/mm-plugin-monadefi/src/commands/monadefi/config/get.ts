import { CommandError, type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { CONFIG_KEYS, configPath, describeConfig, isConfigKey, type ConfigView } from "../../../lib/config";

const inputs = {
  key: { type: InputFieldType.Text, flag: "key", message: `Setting to show (default: all): ${CONFIG_KEYS.join(", ")}`, required: false, prompt: false, index: 0 },
} satisfies InputSchema;

interface Result { settings: ConfigView[]; file: string }

export default class MonadefiConfigGet extends PluginCommand<Result> {
  static override description = "Show monadefi settings. Secret keys show only whether they are set and where from (env or file), never the value.";
  static override examples = ["<%= config.bin %> monadefi config get", "<%= config.bin %> monadefi config get nansen-key --json"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "monadefi:config:get";

  async execute(io: CommandIO): Promise<Result> {
    const r = await io.resolveInputs(inputs);
    const key = String(r.key ?? "").trim().toLowerCase();
    if (key && !isConfigKey(key)) throw new CommandError("INVALID_CONFIG_KEY", `Unknown setting "${key}".`, `Use one of: ${CONFIG_KEYS.join(", ")}.`);
    const settings = (key ? [key] : [...CONFIG_KEYS]).map((k) => describeConfig(k as (typeof CONFIG_KEYS)[number]));
    for (const s of settings) io.emit(`${s.key.padEnd(13)} ${s.set ? `set (${s.source})` : "not set"}${s.value ? `  ${s.value}` : ""}  [env ${s.env}]`);
    return { settings, file: configPath() };
  }
}
