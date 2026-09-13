import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";

type Execute = (args: string[], timeoutMs: number) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;

export function registerContextThresholdTool(server: McpServer, execute: Execute): void {
  server.registerTool("agentflow_context_thresholds", {
    title: "AgentFlow segmented context thresholds",
    description: "List or explicitly review segmented threshold proposals; applying requires a previously approved proposal and writes rollback evidence.",
    inputSchema: {
      project: z.string(), approve: z.string().optional(), reject: z.string().optional(), apply: z.boolean().optional(), ids: z.string().optional(),
      reviewer: z.string().optional(), note: z.string().optional(), json: z.boolean().optional()
    }
  }, async ({ project, approve, reject, apply, ids, reviewer, note, json }) => {
    const args = ["context-thresholds", "--project", project];
    if (approve) args.push("--approve", approve);
    if (reject) args.push("--reject", reject);
    if (apply) args.push("--apply");
    if (ids) args.push("--ids", ids);
    if (reviewer) args.push("--reviewer", reviewer);
    if (note) args.push("--note", note);
    if (json) args.push("--json");
    return execute(args, 60_000);
  });
}
