// expo/fetch gives a streaming response body on iOS and Android. React Native's own fetch buffers the whole body.
import { fetch as streamingFetch } from "expo/fetch";
import { ApiError, authHeader } from "./api/client";
import type { AgentEvent } from "./api/types";
import { config } from "./config";
import { SseParser } from "./sse";

/** Send a prompt to the agent and yield each event of the stream (POST /chat). */
/** `voice`: the prompt is a transcript. The server then waits for the confirm card for every action of the run. */
export async function* chatStream(prompt: string, sessionId: string | null, token: string | null, signal: AbortSignal, opts: { voice?: boolean } = {}): AsyncGenerator<AgentEvent> {
  let res: Awaited<ReturnType<typeof streamingFetch>>;
  try {
    res = await streamingFetch(`${config.apiUrl}/chat`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", accept: "text/event-stream", ...authHeader(token) },
      body: JSON.stringify({ prompt, ...(sessionId ? { sessionId } : {}), ...(opts.voice ? { voice: true } : {}) }),
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError(0, "The Mona-DeFi server did not answer. Check your connection and try again.");
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? (res.status === 404 ? "The agent is not live on the server yet." : `The agent request failed (HTTP ${res.status}).`));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const parse = (data: string): AgentEvent | null => {
    try {
      return JSON.parse(data) as AgentEvent;
    } catch {
      return null;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const data of parser.push(decoder.decode(value, { stream: true }))) {
      const ev = parse(data);
      if (ev) yield ev;
    }
  }
  for (const data of parser.flush()) {
    const ev = parse(data);
    if (ev) yield ev;
  }
}
