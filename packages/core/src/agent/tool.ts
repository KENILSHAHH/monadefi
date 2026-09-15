// A typed tool of the agent: a name, a description, a zod shape for the arguments and a handler that runs in the API process.
// The agent loop turns each one into an OpenAI function tool. Docs: https://developers.openai.com/api/docs/guides/function-calling
import { z } from "zod";

export interface ToolResult { content: { type: "text"; text: string }[]; isError?: boolean }

export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodObject;
  readOnly: boolean;
  handler: (args: any) => Promise<ToolResult>;
}

/** Same call shape as before: tool(name, description, zodShape, handler, { annotations: { readOnlyHint } }). */
export function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: z.output<z.ZodObject<S>>) => Promise<ToolResult>,
  extra?: { annotations?: { readOnlyHint?: boolean } },
): AgentTool {
  return { name, description, schema: z.object(shape), readOnly: extra?.annotations?.readOnlyHint === true, handler: handler as AgentTool["handler"] };
}

/** The JSON schema of the arguments, as the model sees it. Defaults make a field optional. */
export function parametersOf(t: AgentTool): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(t.schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return schema;
}

/** Parse the arguments the model sent and run the handler. A bad argument comes back to the model as an error text. */
export async function callTool(t: AgentTool, rawArgs: string): Promise<ToolResult> {
  let json: unknown;
  try {
    json = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return { content: [{ type: "text", text: "Error: the arguments are not valid JSON." }], isError: true };
  }
  const parsed = t.schema.safeParse(json);
  if (!parsed.success) return { content: [{ type: "text", text: `Error: invalid arguments for ${t.name}: ${z.prettifyError(parsed.error).slice(0, 1500)}` }], isError: true };
  try {
    return await t.handler(parsed.data);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export const textOf = (r: ToolResult) => r.content.map((c) => c.text).join("");
