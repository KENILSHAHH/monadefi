// The chat agent loop. It runs an OpenAI model through the Responses API with the typed DeFi tools,
// the workspace tools (a sandboxed terminal, files, web) and the product skills.
// API reference: https://developers.openai.com/api/docs/guides/function-calling and .../conversation-state
import type { ResponseInputItem, Tool as OpenAITool } from "openai/resources/responses/responses";
import { recordUsage, type TokenUsage } from "../billing/pricing";
import { config } from "../config";
import type { Intent } from "../intents";
import { openai } from "../openai";
import { buildTools } from "../tools/index";
import { getOrCreateWallet } from "../wallet";
import { memoryBlock, reflectOnChat, type ChatRecord } from "../memory";
import { CHAT_SYSTEM_PROMPT } from "./prompts";
import { SKILLS, SKILLS_INDEX, workspaceTools } from "./terminal";
import { callTool, parametersOf, textOf, type AgentTool } from "./tool";

export type AgentEvent =
  | { type: "session"; sessionId: string; skills: string[] }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; isError: boolean; preview: string }
  | { type: "intent"; intent: Intent }
  | { type: "done"; costUsd: number; chargedUsd: number; turns: number; stopReason: string }
  | { type: "error"; message: string };

/**
 * Official documentation MCP servers of the supported apps, as hosted MCP tools: OpenAI calls them, they only search and read docs.
 * Only the read tools are allowed. Their feedback tools send text out and stay off. Checked on 2026-10-13.
 */
const DOCS_MCP: Record<string, { url: string; tools: string[] }> = {
  perpl_docs: { url: "https://docs.perpl.xyz/~gitbook/mcp", tools: ["searchDocumentation", "getPage"] },
  monad_docs: { url: "https://docs.monad.xyz/mcp", tools: ["search_monad_documentation", "query_docs_filesystem_monad_documentation"] },
  relay_docs: { url: "https://docs.relay.link/mcp", tools: ["search_relay", "query_docs_filesystem_relay"] },
  lifi_docs: { url: "https://docs.li.fi/mcp", tools: ["search_li_fi", "query_docs_filesystem_li_fi"] },
};
const docsTools: OpenAITool[] = Object.entries(DOCS_MCP).map(([label, d]) => ({ type: "mcp", server_label: label, server_url: d.url, allowed_tools: d.tools, require_approval: "never" }));

/** Nansen MCP (read-only market intelligence) when the server has a Nansen key. The key goes to OpenAI's MCP client in a header. */
const nansenTools = (): OpenAITool[] => {
  const key = config().NANSEN_API_KEY;
  return key ? [{ type: "mcp", server_label: "nansen", server_url: "https://mcp.nansen.ai/ra/mcp", headers: { "NANSEN-API-KEY": key }, require_approval: "never" }] : [];
};

/** The system prompt with the skill list. Constant, so the prompt cache prefix stays stable. */
const INSTRUCTIONS = `${CHAT_SYSTEM_PROMPT}\n\n# Skills (load with load_skill)\n${SKILLS_INDEX}`;

export interface RunArgs {
  userId: string;
  prompt: string;
  /** Session id (an OpenAI conversation id) from a previous turn of the same chat. */
  resume?: string;
  signal?: AbortSignal;
  /** Test mode: every action waits for a confirmation that never comes, so nothing executes, and no lesson is saved. */
  dryRun?: boolean;
}

/** The open input of one running agent. A message sent during the run goes into it and the agent reads it before its next step. */
interface RunInbox {
  queue: string[];
  closed: boolean;
}

const inboxes = new Map<string, RunInbox>();

/** Give a message to the run of the user that is active now. Returns false when no run accepts it. */
export function sendToRun(userId: string, text: string): boolean {
  const inbox = inboxes.get(userId);
  if (!inbox || inbox.closed) return false;
  inbox.queue.push(text);
  return true;
}

/** A long task (build, test on a fork, deploy, schedule) needs many steps. There is no cost limit. */
const MAX_TURNS = 300;

/** The run of each user that is active now. A second run waits for it: both would use the same workspace. */
const userLocks = new Map<string, Promise<void>>();

export async function* runChatAgent(args: RunArgs): AsyncGenerator<AgentEvent> {
  const before = userLocks.get(args.userId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chain = before.then(() => mine);
  userLocks.set(args.userId, chain);
  try {
    await before;
    yield* runOne(args);
  } finally {
    release();
    if (userLocks.get(args.userId) === chain) userLocks.delete(args.userId);
  }
}

const userMessage = (text: string): ResponseInputItem => ({ role: "user", content: text });

function addUsage(total: Record<string, TokenUsage>, model: string, u: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } } | undefined, webSearchCalls: number) {
  const t = (total[model] ??= { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, webSearchCalls: 0 });
  t.inputTokens += u?.input_tokens ?? 0;
  t.outputTokens += u?.output_tokens ?? 0;
  t.cachedInputTokens += u?.input_tokens_details?.cached_tokens ?? 0;
  t.cacheWriteTokens += u?.input_tokens_details?.cache_write_tokens ?? 0;
  t.webSearchCalls = (t.webSearchCalls ?? 0) + webSearchCalls;
}

async function* runOne(args: RunArgs): AsyncGenerator<AgentEvent> {
  const c = config();
  const client = openai();
  const pending: Intent[] = [];
  const wallet = { ...(await getOrCreateWallet(args.userId)), ...(args.dryRun ? { autoExecute: false } : {}) };

  const abort = new AbortController();
  args.signal?.addEventListener("abort", () => abort.abort(), { once: true });

  const defiTools = buildTools({ userId: args.userId, wallet, onIntent: (i) => pending.push(i) });
  const local = new Map<string, AgentTool>([...defiTools, ...workspaceTools(args.userId, abort.signal)].map((t) => [t.name, t]));
  const tools: OpenAITool[] = [
    ...[...local.values()].map((t): OpenAITool => ({ type: "function", name: t.name, description: t.description, parameters: parametersOf(t), strict: false })),
    { type: "web_search" },
    ...docsTools,
    ...nansenTools(),
  ];

  const inbox: RunInbox = { queue: [], closed: false };
  inboxes.set(args.userId, inbox);

  const flushIntents = function* (): Generator<AgentEvent> {
    while (pending.length) yield { type: "intent", intent: pending.shift()! };
  };

  // A short record of the chat, for the review that saves lessons afterwards.
  const record: ChatRecord = { prompt: args.prompt, reply: "", steps: [], tools: [...local.keys()] };
  const usage: Record<string, TokenUsage> = {};
  let sessionId: string | null = args.resume ?? null;
  /** Function calls that have no output in the conversation yet. An aborted run closes them, so the chat can resume. */
  const openCalls = new Set<string>();
  let turns = 0;
  try {
    // The conversation keeps every item of the chat on the OpenAI side. Its id is the session id of the chat.
    if (!sessionId) sessionId = (await client.conversations.create({ metadata: { app: "mona-dfi" } })).id;
    yield { type: "session", sessionId, skills: SKILLS.map((s) => s.name) };

    // A new chat starts with the memory. A resumed chat has it already.
    let input: ResponseInputItem[] = [userMessage(args.resume ? args.prompt : `${await memoryBlock(args.userId)}${args.prompt}`)];
    let stopReason = "end_turn";
    for (;;) {
      if (turns >= MAX_TURNS) {
        stopReason = "max_turns";
        break;
      }
      turns++;
      // A message sent during the run reaches the agent before its next step.
      while (inbox.queue.length) input.push(userMessage(inbox.queue.shift()!));

      const stream = await client.responses.create(
        { model: c.OPENAI_MODEL, instructions: INSTRUCTIONS, conversation: sessionId, input, tools, reasoning: { effort: c.OPENAI_EFFORT }, parallel_tool_calls: true, store: true, stream: true },
        { signal: abort.signal },
      );
      input = [];
      const calls: { callId: string; name: string; arguments: string }[] = [];
      let webSearches = 0;
      let model = c.OPENAI_MODEL;
      for await (const ev of stream) {
        if (ev.type === "response.output_text.delta") {
          record.reply += ev.delta;
          yield { type: "text", delta: ev.delta };
        } else if (ev.type === "response.output_item.done") {
          const item = ev.item;
          if (item.type === "function_call") {
            calls.push({ callId: item.call_id, name: item.name, arguments: item.arguments });
            openCalls.add(item.call_id);
            let shown: unknown = item.arguments;
            try { shown = JSON.parse(item.arguments); } catch { /* shown as text */ }
            yield { type: "tool", id: item.call_id, name: item.name, input: shown };
          } else if (item.type === "mcp_call") {
            // A docs search. OpenAI ran it; the result is already in the conversation.
            yield { type: "tool", id: item.id, name: `${item.server_label}__${item.name}`, input: item.arguments };
            yield { type: "tool_result", id: item.id, isError: !!item.error, preview: String(item.error ?? item.output ?? "").slice(0, 2000) };
          } else if (item.type === "web_search_call") {
            webSearches++;
            const action = (item as { action?: { type?: string; query?: string; queries?: string[]; url?: string } }).action;
            yield { type: "tool", id: item.id, name: "web_search", input: { query: action?.query ?? action?.queries?.join(" | ") ?? action?.url ?? action?.type ?? "" } };
            yield { type: "tool_result", id: item.id, isError: item.status === "failed", preview: item.status };
          }
        } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
          model = ev.response.model ?? model;
          addUsage(usage, model, ev.response.usage ?? undefined, webSearches);
          if (ev.type === "response.incomplete") stopReason = ev.response.incomplete_details?.reason ?? "incomplete";
        } else if (ev.type === "response.failed") {
          addUsage(usage, model, ev.response.usage ?? undefined, webSearches);
          throw new Error(ev.response.error?.message ?? "The model run failed.");
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        }
      }

      if (calls.length === 0) {
        // The answer is complete. A message that waits starts one more step of the same run.
        yield* flushIntents();
        if (inbox.queue.length) continue;
        break;
      }

      // The tools run one after the other: an action can depend on the result of the one before.
      for (const call of calls) {
        const t = local.get(call.name);
        const result = t ? await callTool(t, call.arguments) : { content: [{ type: "text" as const, text: `Error: unknown tool ${call.name}.` }], isError: true };
        const text = textOf(result);
        record.steps.push({ tool: call.name, input: call.arguments, ok: result.isError !== true && !text.startsWith("Error:"), result: text.slice(0, 1000) });
        yield { type: "tool_result", id: call.callId, isError: result.isError === true, preview: text.slice(0, 2000) };
        input.push({ type: "function_call_output", call_id: call.callId, output: text });
        openCalls.delete(call.callId);
        yield* flushIntents();
      }
    }

    inbox.closed = true;
    const billed = await recordUsage({ userId: args.userId, sessionId, modelUsage: usage });
    // Learn from this chat in the background. The user does not wait for it.
    if (!args.dryRun) void reflectOnChat(args.userId, { ...record, steps: [...record.steps] }).then(
      (n) => n > 0 && console.log(`memory: saved ${n} lesson(s) from a chat of ${args.userId}`),
      (err) => console.error("memory: the review failed:", err instanceof Error ? err.message.split("\n")[0] : err),
    );
    yield { type: "done", costUsd: billed.costUsd, chargedUsd: billed.chargedUsd, turns, stopReason };
  } catch (err) {
    yield* flushIntents();
    if (Object.keys(usage).length) await recordUsage({ userId: args.userId, sessionId, modelUsage: usage }).catch(() => undefined);
    yield { type: "error", message: abort.signal.aborted ? "The run was stopped." : err instanceof Error ? err.message : String(err) };
  } finally {
    inbox.closed = true;
    if (inboxes.get(args.userId) === inbox) inboxes.delete(args.userId);
    // A call without an output blocks the next turn of the conversation. Close each one as cancelled.
    if (sessionId && openCalls.size) {
      await client.conversations.items.create(sessionId, { items: [...openCalls].map((id) => ({ type: "function_call_output" as const, call_id: id, output: "Error: the run stopped before this tool call finished. Read the state again before you act." })) }).catch(() => undefined);
    }
  }
}
