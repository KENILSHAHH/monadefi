import type { AgentEvent, Intent } from "./api/types";

export type ChatPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; result?: string; isError?: boolean }
  | { kind: "intent"; intent: Intent };

export interface ChatMessage {
  role: "user" | "assistant";
  parts: ChatPart[];
  error?: string;
}

/** Fold one stream event into the assistant message. Pure, so the chat behaviour is testable. */
export function applyEvent(m: ChatMessage, ev: AgentEvent): ChatMessage {
  switch (ev.type) {
    case "text": {
      const last = m.parts[m.parts.length - 1];
      return last?.kind === "text"
        ? { ...m, parts: [...m.parts.slice(0, -1), { kind: "text", text: last.text + ev.delta }] }
        : { ...m, parts: [...m.parts, { kind: "text", text: ev.delta }] };
    }
    case "tool":
      return { ...m, parts: [...m.parts, { kind: "tool", id: ev.id, name: ev.name }] };
    case "tool_result":
      return { ...m, parts: m.parts.map((p) => (p.kind === "tool" && p.id === ev.id ? { ...p, result: ev.preview, isError: ev.isError } : p)) };
    case "intent":
      // A newer state of the same intent replaces the card in place.
      return m.parts.some((p) => p.kind === "intent" && p.intent.id === ev.intent.id)
        ? { ...m, parts: m.parts.map((p) => (p.kind === "intent" && p.intent.id === ev.intent.id ? { kind: "intent", intent: ev.intent } : p)) }
        : { ...m, parts: [...m.parts, { kind: "intent", intent: ev.intent }] };
    case "error":
      return { ...m, error: ev.message };
    default:
      return m;
  }
}
