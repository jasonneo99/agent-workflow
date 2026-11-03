import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { CONTEXT_INTENTS } from "../../../../packages/context-gateway/src/index.js";

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

export function registerContextGatewayTools(server: McpServer, executeTool: Execute): void {
  server.registerTool(
    "agentflow_context_report",
    {
      title: "AgentFlow Context Gateway report",
      description: "Read privacy-safe shadow routing evidence and projected whole-workflow frontier-token savings.",
      inputSchema: { project: z.string(), json: z.boolean().optional() }
    },
    async ({ project, json }) => {
      const args = ["context-report", "--project", project];
      if (json) args.push("--json");
      return executeTool(args, 60_000);
    }
  );

  server.registerTool(
    "agentflow_context_route",
    {
      title: "AgentFlow routed context read",
      description: "Preview or execute a token-aware routed file read with cache, receipts, exact-read escape hatch, and evidence-gated enforcement.",
      inputSchema: {
        project: z.string(), file: z.string(), question: z.string(), intent: z.enum(CONTEXT_INTENTS).optional(),
        mode: z.enum(["shadow", "advisory", "enforce"]).optional(), holdoutApproved: z.boolean().optional(),
        exact: z.boolean().optional(), execute: z.boolean().optional(), json: z.boolean().optional()
      }
    },
    async ({ project, file, question, intent, mode, holdoutApproved, exact, execute, json }) => {
      const args = ["context-route", "--project", project, "--file", file, "--question", question];
      if (intent) args.push("--intent", intent);
      if (mode) args.push("--mode", mode);
      if (holdoutApproved) args.push("--holdout-approved");
      if (exact) args.push("--exact");
      if (execute) args.push("--execute");
      if (json) args.push("--json");
      return executeTool(args, execute ? 180_000 : 60_000);
    }
  );

  server.registerTool(
    "agentflow_context_status",
    {
      title: "AgentFlow Context Gateway operator status",
      description: "Inspect body-free savings, cache health, host readiness, calibration, and pending generation plans.",
      inputSchema: { project: z.string(), json: z.boolean().optional() }
    },
    async ({ project, json }) => {
      const args = ["context-status", "--project", project];
      if (json) args.push("--json");
      return executeTool(args, 60_000);
    }
  );

  server.registerTool(
    "agentflow_context_calibrate",
    {
      title: "AgentFlow repository context calibration",
      description: "Run a versioned repository holdout, compare the prior baseline, and record review-required threshold proposals without changing policy.",
      inputSchema: { project: z.string(), corpus: z.string().optional(), json: z.boolean().optional() }
    },
    async ({ project, corpus, json }) => {
      const args = ["context-calibrate", "--project", project];
      if (corpus) args.push("--corpus", corpus);
      if (json) args.push("--json");
      return executeTool(args, 180_000);
    }
  );

  server.registerTool(
    "agentflow_context_holdout",
    {
      title: "AgentFlow Context Gateway holdout",
      description: "Evaluate and persist aggregate direct-versus-routed quality, citation, token, and latency evidence without storing case bodies.",
      inputSchema: { project: z.string(), cases: z.string(), json: z.boolean().optional() }
    },
    async ({ project, cases, json }) => {
      const args = ["context-holdout", "--project", project, "--cases", cases];
      if (json) args.push("--json");
      return executeTool(args, 60_000);
    }
  );

  server.registerTool(
    "agentflow_context_host_setup",
    {
      title: "AgentFlow Context Gateway host setup",
      description: "Preview or merge the project-local Claude Code or Cursor read hook without removing existing hooks.",
      inputSchema: { project: z.string(), host: z.enum(["claude", "cursor"]), write: z.boolean().optional(), json: z.boolean().optional() }
    },
    async ({ project, host, write, json }) => {
      const args = ["context-host-setup", "--project", project, "--host", host];
      if (write) args.push("--write");
      if (json) args.push("--json");
      return executeTool(args, 60_000);
    }
  );

  server.registerTool(
    "agentflow_context_host_doctor",
    {
      title: "AgentFlow Context Gateway host doctor",
      description: "Check host-hook installation, policy mode, holdout evidence, and enforcement readiness.",
      inputSchema: { project: z.string(), host: z.enum(["claude", "cursor"]), json: z.boolean().optional() }
    },
    async ({ project, host, json }) => {
      const args = ["context-host-doctor", "--project", project, "--host", host];
      if (json) args.push("--json");
      return executeTool(args, 60_000);
    }
  );

  server.registerTool(
    "agentflow_context_codegen",
    {
      title: "AgentFlow governed context code generation",
      description: "Stage a cheap-model code candidate for diff review, or explicitly promote it through project policy and validation with rollback evidence.",
      inputSchema: {
        project: z.string(), spec: z.string().optional(), reference: z.string().optional(), target: z.string().optional(), plan: z.string().optional(),
        approved: z.boolean().optional(), reviewedBy: z.string().optional(), validateCommand: z.string().optional(), json: z.boolean().optional()
      }
    },
    async ({ project, spec, reference, target, plan, approved, reviewedBy, validateCommand, json }) => {
      const args = ["context-codegen", "--project", project];
      if (spec) args.push("--spec", spec);
      if (reference) args.push("--reference", reference);
      if (target) args.push("--target", target);
      if (plan) args.push("--plan", plan);
      if (approved) args.push("--approved");
      if (reviewedBy) args.push("--reviewed-by", reviewedBy);
      if (validateCommand) args.push("--validate-command", validateCommand);
      if (json) args.push("--json");
      return executeTool(args, 180_000);
    }
  );
}
