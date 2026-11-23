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

export function registerProviderCreditTool(server:McpServer,execute:Execute):void {
 server.registerTool('agentflow_provider_credits',{
  title:'AgentFlow provider credit measurement',
  description:'Read supported provider-reported credit metadata using existing configured credentials. Unknown balances remain unknown; key limits are not funds. No purchases, account changes, inference or persistence.',
  annotations:{readOnlyHint:true,destructiveHint:false},
  inputSchema:{providers:z.array(z.string().regex(/^[a-z0-9-]{1,64}$/u)).min(1).max(20).optional().describe('Exact provider ids; defaults to the supported runtime provider list.')}
 },async({providers})=>execute(['provider-credits',...(providers?['--providers',providers.join(',')]:[])],60_000));
}
