// The OpenAI client. Only the API and guard processes create it. The key never reaches the browser or the agent terminal.
// API reference: https://developers.openai.com/api/docs
import OpenAI from "openai";
import { config } from "./config";

export const openaiEnabled = () => !!config().OPENAI_API_KEY;

export function openai(opts: { timeoutMs?: number; maxRetries?: number } = {}): OpenAI {
  const c = config();
  if (!c.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set on the server.");
  return new OpenAI({ apiKey: c.OPENAI_API_KEY, project: c.OPENAI_PROJECT ?? null, timeout: opts.timeoutMs ?? 600_000, maxRetries: opts.maxRetries ?? 2 });
}
