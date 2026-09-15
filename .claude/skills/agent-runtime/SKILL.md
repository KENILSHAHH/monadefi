---
name: agent-runtime
description: How this product runs its agent. OpenAI Responses API facts (conversations, function tools, hosted MCP and web search, streaming events, usage fields), the sandboxed terminal, product skills, the confirm-before-execute rule, key isolation, and usage metering. Use when changing the agent loop, tools, permissions, or billing.
user-invocable: false
---

# Agent runtime

Checked against developers.openai.com/api/docs on 2026-10-13 (npm `openai` 7.32).

## OpenAI Responses API facts

- The loop is in `packages/core/src/agent/run.ts`. It calls `client.responses.create({ model, instructions, conversation, input, tools, reasoning: { effort }, stream: true })` until a response has no function call.
- A chat is one OpenAI **conversation** (`client.conversations.create()`). Its id is the `sessionId` of the chat. Each response adds its items to it, so a later turn sends only the new input.
- A function call that has no `function_call_output` blocks the next turn of the conversation. When a run stops, each open call gets a "stopped" output (`conversations.items.create`).
- Function tools: `{ type: "function", name, description, parameters, strict: false }`. `parameters` comes from the zod shape (`z.toJSONSchema`, io "input"). Handlers run in the API process (`agent/tool.ts`).
- Hosted tools: `{ type: "web_search" }`, and the docs servers as `{ type: "mcp", server_label, server_url, allowed_tools, require_approval: "never" }`. OpenAI calls them. The result arrives as `mcp_call` and `web_search_call` output items.
- Stream events in use: `response.output_text.delta`, `response.output_item.done` (function_call, mcp_call, web_search_call), `response.completed`, `response.incomplete`, `response.failed`, `error`.
- Usage: `response.usage` has `input_tokens` (with `input_tokens_details.cached_tokens` and `cache_write_tokens` inside it) and `output_tokens`. The loop adds them up for each model. `billing/pricing.ts` prices them. Web search costs 10 USD for 1,000 calls.
- Models: `OPENAI_MODEL` (default `gpt-6-astra`) for the chat, `OPENAI_GUARD_MODEL` (default `gpt-5.6-luna`) for the guard supervisor and the memory review (`responses.parse` with `zodTextFormat`).

## Workspace tools (`agent/terminal.ts`)

- `bash` runs each command through `@anthropic-ai/sandbox-runtime` (sandbox-exec on macOS, bubblewrap on Linux). This package is only an OS sandbox library. It has no model. Writes stay in the workspace of the user. Reads of the repo, other workspaces and home directories are denied. The network allowlist is the app APIs plus the chain RPCs. If the sandbox is not available, the terminal is off. It never runs a command outside the sandbox.
- `read_file`, `write_file` and `edit_file` run in the API process and check that the path is inside the workspace.
- `web_fetch` reads public https URLs only. Private and loopback addresses are refused.
- `load_skill` returns `skills/<name>/SKILL.md`. The skill list is in the system prompt. The skills are also copied to `./skills` in the workspace.

## Rules of this product

1. A mobile user's wallet is a Mera passkey EOA on Monad; the server holds no key and acts only through the signed session (Perpl calls, AUSD approve to Perpl). A web user's wallet is a Privy wallet that the server signs for after the user adds the server signer.
2. The key never enters the terminal or the workspace. Tool handlers in the API process sign.
3. The OpenAI API key stays in the API and guard processes. The terminal environment has only PATH, HOME (inside the workspace) and LANG.
4. Action tools execute at once from the agent wallet when the user has "Act without asking" on. Each action has a USD limit. With the setting off, an action waits for a confirmation click.
5. Funds leave the agent wallet through agent actions, or through a withdrawal to the user's sign-in address. No other destination exists on the withdrawal route.
6. When no typed tool fits, the agent writes the script or contract in its workspace, tests it on a fork, and sends it with `evm_send_transactions`.
7. A guard is a stored condition plus a stored action. The watcher is plain code. For Perpl it closes or deleverages the position near liquidation, and acts on Nansen exits. The small model only picks one of the actions the user approved.
8. Prompts are free for now (`PRICE_PROMPT_USD=0`). The model cost is still measured and stored in `usage`.
