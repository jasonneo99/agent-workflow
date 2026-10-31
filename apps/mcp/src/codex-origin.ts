import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const requestOrigin = new AsyncLocalStorage<{ threadId?: string }>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Codex supplies _meta.threadId outside model-controlled tool arguments.
 * This is a local host routing identity, never approval or execution authority.
 */
export function withCodexRequestOrigin<T>(meta: unknown, execute: () => T): T {
  const value = meta && typeof meta === "object" ? (meta as Record<string, unknown>).threadId : undefined;
  if (value !== undefined && (typeof value !== "string" || !uuid.test(value))) {
    throw new Error("Invalid host Codex thread metadata; workflow origin was not bound.");
  }
  return requestOrigin.run({ threadId: value as string | undefined }, execute);
}

export function codexRequestEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const origin = requestOrigin.getStore();
  if (!origin) return { ...base };
  const env = { ...base };
  // A shared MCP process must never reuse its startup chat identity.
  delete env.CODEX_THREAD_ID;
  if (env.AGENTFLOW_REQUESTER_CHANNEL === "codex") delete env.AGENTFLOW_REQUESTER_CHANNEL;
  if (origin.threadId) {
    env.CODEX_THREAD_ID = origin.threadId;
    env.AGENTFLOW_REQUESTER_CHANNEL = "codex";
    delete env.AGENTFLOW_ORIGIN_TASK_ID;
  }
  return env;
}

/** Cover parameterless and schema-bearing tools, including separately registered tools. */
export function bindCodexToolOrigins(server: McpServer): void {
  const register = server.registerTool;
  server.registerTool = (name, config, callback) => Reflect.apply(register, server, [name, config,
    (...args: unknown[]) => {
      const extra = args.at(-1) as { _meta?: unknown } | undefined;
      return withCodexRequestOrigin(extra?._meta, () => Reflect.apply(callback, undefined, args));
    }
  ]);
}
