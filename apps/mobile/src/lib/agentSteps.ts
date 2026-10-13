/**
 * The agent progress line: one icon and one plain label per tool. Pure, so the tests can pin it.
 * Tool names: packages/core/src/tools/index.ts, packages/core/src/agent/terminal.ts, and the hosted
 * MCP tools of packages/core/src/agent/run.ts (named "<server>__<tool>", for example "perpl_docs__getPage").
 */
import type { ChatMessage } from "./chatModel";

/** MaterialCommunityIcons names. */
export type StepIcon =
  | "chart-line" | "shield-check" | "console" | "magnify" | "swap-horizontal" | "clock-outline" | "brain"
  | "wallet-outline" | "flash" | "book-open-variant" | "file-document-outline" | "send" | "circle-small" | "message-text-outline" | "dots-horizontal";

export interface StepInfo {
  icon: StepIcon;
  label: string;
}

const LABELS: Record<string, string> = {
  perpl_markets: "Reading Perpl markets",
  perpl_account: "Reading your Perpl account",
  perpl_book: "Reading the order book",
  perpl_open_orders: "Reading your open orders",
  perpl_api: "Reading Perpl data",
  perpl_open_position: "Preparing your order",
  perpl_close_position: "Preparing the close",
  perpl_set_tpsl: "Setting the stop-loss / take-profit",
  perpl_cancel_order: "Preparing the cancel",
  perpl_modify_order: "Preparing the order change",
  perpl_margin: "Preparing the margin change",
  perpl_deposit: "Preparing the deposit to Perpl",
  perpl_withdraw: "Preparing the withdrawal",
  risk_check: "Checking Nansen risk",
  wallet_overview: "Reading your wallet",
  evm_simulate: "Simulating on Monad",
  evm_send_transactions: "Preparing the transactions",
  swap: "Preparing the swap",
  bridge: "Preparing the bridge",
  bridge_quote: "Getting a bridge quote",
  bridge_status: "Checking the bridge",
  job_schedule: "Scheduling the job",
  job_list: "Reading your jobs",
  job_cancel: "Cancelling the job",
  memory_save: "Saving a note",
  memory_recall: "Recalling notes",
  memory_forget: "Deleting a note",
  web_search: "Searching the web",
  web_fetch: "Reading a web page",
  bash: "Running a command",
  read_file: "Reading a file",
  write_file: "Writing a file",
  edit_file: "Editing a file",
  load_skill: "Reading protocol notes",
  Skill: "Reading protocol notes",
};

/** "perpl_open_orders" → "Perpl open orders". */
export function humanize(name: string): string {
  const s = name.replace(/__/g, " ").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return s ? s[0]!.toUpperCase() + s.slice(1) : "Working";
}

export function stepInfo(name: string): StepInfo {
  const [server, tool] = name.includes("__") ? (name.split("__", 2) as [string, string]) : [null, name];
  if (server) {
    if (server.endsWith("_docs")) return { icon: "magnify", label: `Searching the ${humanize(server.replace(/_docs$/, ""))} docs` };
    if (server === "nansen") return { icon: "shield-check", label: "Checking Nansen data" };
    return { icon: "circle-small", label: humanize(tool) };
  }
  const label = LABELS[name];
  const icon: StepIcon =
    name.startsWith("perpl_") ? "chart-line" :
    name.includes("risk") || name.includes("nansen") ? "shield-check" :
    name === "bash" ? "console" :
    name === "web_search" || name === "web_fetch" || name.endsWith("_docs") ? "magnify" :
    name === "swap" || name.startsWith("bridge") ? "swap-horizontal" :
    name.startsWith("job_") ? "clock-outline" :
    name.startsWith("memory_") ? "brain" :
    name === "wallet_overview" ? "wallet-outline" :
    name === "evm_simulate" ? "flash" :
    name === "evm_send_transactions" ? "send" :
    name === "load_skill" || name === "Skill" ? "book-open-variant" :
    name.endsWith("_file") ? "file-document-outline" :
    "circle-small";
  return { icon, label: label ?? humanize(name) };
}

export interface Step extends StepInfo {
  id: string;
  name: string;
  done: boolean;
  isError: boolean;
  preview: string;
}

export function stepsOf(m: ChatMessage): Step[] {
  return m.parts.flatMap((p) =>
    p.kind === "tool"
      ? [{ id: p.id, name: p.name, ...stepInfo(p.name), done: p.result !== undefined, isError: Boolean(p.isError), preview: shortPreview(p.result ?? "") }]
      : [],
  );
}

/** A one-line preview of a tool result. */
export function shortPreview(s: string, max = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The step to show now on the single line while the agent runs. */
export function currentStep(m: ChatMessage): { key: string } & StepInfo {
  const last = m.parts[m.parts.length - 1];
  if (!last) return { key: "think", icon: "dots-horizontal", label: "Thinking" };
  if (last.kind === "tool" && last.result === undefined) return { key: last.id, ...stepInfo(last.name) };
  if (last.kind === "text") return { key: `write-${m.parts.length}`, icon: "message-text-outline", label: "Writing the answer" };
  return { key: `next-${m.parts.length}`, icon: "dots-horizontal", label: "Thinking" };
}

/** "14s", "2m 05s". */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
