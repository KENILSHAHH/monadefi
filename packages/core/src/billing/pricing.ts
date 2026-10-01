// Prompt price (flat) and measured OpenAI usage.
// Model prices: https://developers.openai.com/api/docs/pricing (USD per million tokens, short context, read on 2026-10-13).
import { config } from "../config";
import { sql } from "../db";

interface Price { input: number; cachedInput: number; cacheWrite: number; output: number }
const PRICES: Record<string, Price> = {
  "gpt-6-astra": { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  "gpt-6.1-sol": { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-5.6-luna": { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
};
/** Unknown models are priced as the most expensive known model. A prompt is then never under-priced. */
const FALLBACK: Price = PRICES["gpt-6-astra"]!;
/** The hosted web search tool: 10 USD for 1,000 calls. */
const WEB_SEARCH_CALL_USD = 0.01;

/** Usage of one run. `inputTokens` includes the cached and the cache-write tokens, as OpenAI reports it. */
export interface TokenUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; webSearchCalls?: number }

export function modelCostUsd(model: string, u: TokenUsage): number {
  const p = Object.entries(PRICES).find(([id]) => model.startsWith(id))?.[1] ?? FALLBACK;
  const plain = Math.max(0, u.inputTokens - u.cachedInputTokens - u.cacheWriteTokens);
  return (plain * p.input + u.cachedInputTokens * p.cachedInput + u.cacheWriteTokens * p.cacheWrite + u.outputTokens * p.output) / 1_000_000 + (u.webSearchCalls ?? 0) * WEB_SEARCH_CALL_USD;
}

/** Price charged to the user for one prompt. It is flat. It does not follow the model cost. */
export function promptPriceUsd(): number {
  return config().PRICE_PROMPT_USD;
}

/** Record the usage of one prompt: one row for each model. The agent loop counts the usage of this run only. */
export async function recordUsage(args: { userId: string; sessionId: string | null; modelUsage: Record<string, TokenUsage> }) {
  let cost = 0;
  // The flat price goes on the first model row, so the sum of the rows is the price of the prompt.
  let price = promptPriceUsd();
  for (const [model, u] of Object.entries(args.modelUsage)) {
    const c = modelCostUsd(model, u);
    cost += c;
    await sql()`insert into usage (user_id, session_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, charged_usd)
      values (${args.userId}, ${args.sessionId}, ${model}, ${u.inputTokens}, ${u.outputTokens}, ${u.cachedInputTokens}, ${u.cacheWriteTokens}, ${c}, ${price})`;
    price = 0;
  }
  return { costUsd: cost, chargedUsd: promptPriceUsd() };
}

export async function recordCharge(args: { userId: string; kind: "prompt" | "action" | "guard"; amountUsd: number; reference?: string | null; detail?: unknown }) {
  await sql()`insert into charges (user_id, kind, amount_usd, reference, detail)
    values (${args.userId}, ${args.kind}, ${args.amountUsd}, ${args.reference ?? null}, ${args.detail ? sql().json(args.detail as never) : null})`;
}
