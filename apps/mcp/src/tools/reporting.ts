import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";

type Execute = (args: string[], timeoutMs: number) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;

export function registerAcceptedOutcomeTool(server: McpServer, execute: Execute): void {
  server.registerTool("agentflow_accepted_outcomes", {
    title: "AgentFlow accepted workflow outcomes",
    description: "Report measured frontier input tokens and provider-reported cost per accepted workflow.",
    inputSchema: { project: z.string().describe("Project directory."), limit: z.number().int().positive().max(1000).optional(), json: z.boolean().optional() }
  }, async ({ project, limit, json }) => {
    const args = ["accepted-outcomes", "--project", project];
    if (limit) args.push("--limit", String(limit));
    if (json) args.push("--json");
    return execute(args, 60_000);
  });
}
