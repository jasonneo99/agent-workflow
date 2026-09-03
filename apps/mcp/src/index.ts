#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import { findAgentWorkflowRoot } from "../../../packages/runtime-root/src/index.js";

const rootDir = findAgentWorkflowRoot(import.meta.url);
const compiledCliPath = path.join(rootDir, "dist", "apps", "cli", "src", "index.js");
const maxOutputChars = 30_000;
const defaultTimeoutMs = 120_000;

type CommandResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const server = new McpServer(
  {
    name: "portable-agent-workflows",
    version: "0.2.1"
  },
  {
    instructions:
      "Agent Workflow is the default orchestration layer for software-project work. " +
      "When this server is available and a request involves planning, implementation, debugging, testing, review, security, UX, documentation, release readiness, or project maintenance, use its tools before doing substantive work. " +
      "Prefer agentflow_orchestrate for ambiguous or multi-stage tasks and the narrowest matching tool for focused tasks. " +
      "Use project paths that are accessible on Loki. If the target project is not accessible on Loki or this server cannot serve the task, continue with native Codex tools and state the fallback."
  }
);

server.registerTool(
  "agentflow_doctor",
  {
    title: "AgentFlow doctor",
    description: "Check workflow definitions and local enterprise services.",
    inputSchema: {
      simple: z.boolean().optional().describe("Skip enterprise service checks.")
    }
  },
  async ({ simple }) => toolResult(await runAgentflow(["doctor", ...(simple ? ["--simple"] : [])], { timeoutMs: 60_000 }))
);

server.registerTool(
  "agentflow_validate",
  {
    title: "AgentFlow validate",
    description: "Validate reusable agent cards and workflow definitions."
  },
  async () => toolResult(await runAgentflow(["validate"], { timeoutMs: 60_000 }))
);

server.registerTool(
  "agentflow_contract_test",
  {
    title: "AgentFlow contract test",
    description: "Run contract tests for reusable definitions, project-local agents, and provider adapters.",
    inputSchema: {
      definitions: z.string().optional().describe("Definition bundle root with agents/ and workflows/."),
      project: z.string().optional().describe("Project directory with optional .agent-workflow/agents."),
      provider: z.string().optional().describe("Provider adapter to check; defaults to mock."),
      liveProvider: z.boolean().optional().describe("Allow execution against non-mock providers."),
      json: z.boolean().optional().describe("Return machine-readable contract report.")
    }
  },
  async ({ definitions, project, provider, liveProvider, json }) => {
    const args = ["contract-test"];
    if (definitions) args.push("--definitions", definitions);
    if (project) args.push("--project", project);
    if (provider) args.push("--provider", provider);
    if (liveProvider) args.push("--live-provider");
    if (json) args.push("--json");
    return toolResult(await runAgentflow(args, { timeoutMs: liveProvider ? 180_000 : 60_000 }));
  }
);

server.registerTool(
  "agentflow_governance",
  {
    title: "AgentFlow multi-project governance",
    description: "Read-only inspection of registered project health, policy drift, providers, queues, and remediation guidance.",
    inputSchema: {
      health: z.enum(["all", "healthy", "warning", "critical"]).optional(),
      provider: z.string().optional(),
      policyProfile: z.string().optional(),
      staleMinutes: z.number().int().positive().optional(),
      includeEphemeral: z.boolean().optional(),
      json: z.boolean().optional()
    }
  },
  async ({ health, provider, policyProfile, staleMinutes, includeEphemeral, json }) => {
    const args = ["governance", "--health", health ?? "all", "--stale-minutes", String(staleMinutes ?? 15)];
    if (provider) args.push("--provider", provider);
    if (policyProfile) args.push("--policy-profile", policyProfile);
    if (includeEphemeral) args.push("--include-ephemeral");
    if (json) args.push("--json");
    return toolResult(await runAgentflow(args, { timeoutMs: 120_000 }));
  }
);

server.registerTool(
  "agentflow_approvals",
  {
    title: "AgentFlow action approvals",
    description: "List, approve, reject, or execute agent-requested actions that require human approval.",
    inputSchema: {
      status: z.enum(["pending", "approved", "executed", "failed", "rejected", "all"]).optional(),
      run: z.string().optional().describe("Filter by workflow run id."),
      project: z.string().optional().describe("Filter by project directory."),
      approve: z.string().optional().describe("Approval id to approve."),
      reject: z.string().optional().describe("Approval id to reject."),
      execute: z.string().optional().describe("Approval id to execute after it has been approved."),
      actor: z.string().optional().describe("Person or tool making the decision."),
      note: z.string().optional().describe("Decision note."),
      limit: z.number().int().positive().max(100).optional(),
      json: z.boolean().optional().describe("Return approval JSON.")
    }
  },
  async ({ status, run, project, approve, reject, execute, actor, note, limit, json }) => {
    const args = ["approvals", "--status", status ?? "pending"];
    if (run) args.push("--run", run);
    if (project) args.push("--project", project);
    if (approve) args.push("--approve", approve);
    if (reject) args.push("--reject", reject);
    if (execute) args.push("--execute", execute);
    if (actor) args.push("--actor", actor);
    if (note) args.push("--note", note);
    if (limit) args.push("--limit", String(limit));
    if (json) args.push("--json");
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_request_approval",
  {
    title: "AgentFlow request approval",
    description: "Create a run-level deployment or autonomy approval request in the shared approval inbox.",
    inputSchema: {
      project: z.string().describe("Project directory."),
      type: z.enum(["deployment", "autonomy"]).describe("Kind of approval request."),
      target: z.string().describe("Approval target, such as staging, production, or an autonomy level."),
      rationale: z.string().describe("Why this approval is needed."),
      workflow: z.string().optional().describe("Workflow context for the approval request."),
      policyProfile: z.string().optional().describe("Execution policy profile snapshot to attach."),
      actor: z.string().optional().describe("Person or tool requesting approval."),
      json: z.boolean().optional().describe("Return request JSON.")
    }
  },
  async ({ project, type, target, rationale, workflow, policyProfile, actor, json }) => {
    const args = ["request-approval", "--project", project, "--type", type, "--target", target, "--rationale", rationale];
    if (workflow) args.push("--workflow", workflow);
    if (policyProfile) args.push("--policy-profile", policyProfile);
    if (actor) args.push("--actor", actor);
    if (json) args.push("--json");
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_gate",
  {
    title: "AgentFlow evaluation gate",
    description: "Evaluate a workflow run against project-local quality, latency, fallback, and cost gates.",
    inputSchema: {
      run: z.string().describe("Candidate workflow run id."),
      project: z.string().optional().describe("Project directory; defaults to the run project."),
      gate: z.string().optional().describe("Gate YAML file; defaults to <project>/.agent-workflow/evaluation-gates.yaml."),
      baselineRun: z.string().optional().describe("Baseline workflow run id for regression budgets."),
      json: z.boolean().optional().describe("Return gate JSON.")
    }
  },
  async ({ run, project, gate, baselineRun, json }) => {
    const args = ["gate", "--run", run];
    if (project) args.push("--project", project);
    if (gate) args.push("--gate", gate);
    if (baselineRun) args.push("--baseline-run", baselineRun);
    if (json) args.push("--json");
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_observe",
  {
    title: "AgentFlow observe",
    description: "Export OpenTelemetry-compatible spans and metrics for a workflow run.",
    inputSchema: {
      run: z.string().describe("Workflow run id."),
      json: z.boolean().optional().describe("Return OpenTelemetry-style JSON.")
    }
  },
  async ({ run, json }) => {
    const args = ["observe", "--run", run];
    if (json) args.push("--json");
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_bundle_manifest",
  {
    title: "AgentFlow bundle manifest",
    description: "Print or write the versioned reusable agent/workflow bundle manifest.",
    inputSchema: {
      write: z.boolean().optional().describe("Write agent-workflow.bundle.json instead of printing JSON.")
    }
  },
  async ({ write }) => toolResult(await runAgentflow(["bundle-manifest", ...(write ? ["--write"] : [])], { timeoutMs: 60_000 }))
);

server.registerTool(
  "agentflow_bundle_verify",
  {
    title: "AgentFlow bundle trust verification",
    description: "Read-only verification of workflow bundle integrity, compatibility, signature, and signer trust.",
    inputSchema: {
      policy: z.enum(["allow", "warn", "require"]).optional(),
      json: z.boolean().optional()
    }
  },
  async ({ policy, json }) => toolResult(await runAgentflow(["bundle-verify", "--policy", policy ?? "allow", ...(json ? ["--json"] : [])], { timeoutMs: 60_000 }))
);

server.registerTool(
  "agentflow_bundle_compat",
  {
    title: "AgentFlow bundle compatibility",
    description: "Check bundle runtime, Node.js, MCP compatibility requirements, and migration notes.",
    inputSchema: {
      runtimeVersion: z.string().optional().describe("Agent Workflow runtime version to check."),
      nodeVersion: z.string().optional().describe("Node.js version to check."),
      mcpVersion: z.string().optional().describe("MCP SDK version to check."),
      json: z.boolean().optional().describe("Return machine-readable compatibility report.")
    }
  },
  async ({ runtimeVersion, nodeVersion, mcpVersion, json }) => {
    const args = ["bundle-compat"];
    if (runtimeVersion) args.push("--runtime-version", runtimeVersion);
    if (nodeVersion) args.push("--node-version", nodeVersion);
    if (mcpVersion) args.push("--mcp-version", mcpVersion);
    if (json) args.push("--json");
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_bundle_upgrade_preview",
  {
    title: "AgentFlow bundle upgrade preview",
    description: "Preview project bundle migration notes and safe upgrade actions without changing files.",
    inputSchema: {
      project: z.string().optional().describe("Project directory with .agent-workflow/bundle-state.json."),
      fromVersion: z.string().optional().describe("Source bundle version to compare from."),
      fromChecksum: z.string().optional().describe("Source bundle checksum to compare from."),
      fromBundleId: z.string().optional().describe("Source bundle id to compare from."),
      json: z.boolean().optional().describe("Return machine-readable upgrade preview.")
    }
  },
  async ({ project, fromVersion, fromChecksum, fromBundleId, json }) => {
    const args = ["bundle-upgrade-preview"];
    if (project) args.push("--project", project);
    if (fromVersion) args.push("--from-version", fromVersion);
    if (fromChecksum) args.push("--from-checksum", fromChecksum);
    if (fromBundleId) args.push("--from-bundle-id", fromBundleId);
    if (json) args.push("--json");
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_bundle_adopt",
  {
    title: "AgentFlow bundle adopt",
    description: "Record the current reusable bundle as adopted by a project.",
    inputSchema: {
      project: z.string().describe("Project directory."),
      force: z.boolean().optional().describe("Overwrite an existing .agent-workflow/bundle-state.json after review."),
      json: z.boolean().optional().describe("Return machine-readable adoption output.")
    }
  },
  async ({ project, force, json }) => {
    const args = ["bundle-adopt", "--project", project];
    if (force) args.push("--force");
    if (json) args.push("--json");
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_definition_migrations",
  {
    title: "AgentFlow definition migrations",
    description: "Preview definition contract migration steps, validation, and rollback guidance.",
    inputSchema: {
      project: z.string().optional().describe("Project directory with .agent-workflow/bundle-state.json."),
      fromVersion: z.string().optional().describe("Source bundle version to compare from."),
      fromChecksum: z.string().optional().describe("Source bundle checksum to compare from."),
      json: z.boolean().optional().describe("Return machine-readable migration plan.")
    }
  },
  async ({ project, fromVersion, fromChecksum, json }) => {
    const args = ["definition-migrations"];
    if (project) args.push("--project", project);
    if (fromVersion) args.push("--from-version", fromVersion);
    if (fromChecksum) args.push("--from-checksum", fromChecksum);
    if (json) args.push("--json");
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_list",
  {
    title: "AgentFlow list",
    description: "List available portable agents and workflows."
  },
  async () => toolResult(await runAgentflow(["list"], { timeoutMs: 60_000 }))
);

server.registerTool(
  "agentflow_schemas",
  {
    title: "AgentFlow schemas",
    description: "List JSON Schemas and optionally write VS Code/Cursor YAML validation settings for a project.",
    inputSchema: {
      project: z.string().optional().describe("Project directory when writing editor settings."),
      writeVscode: z.boolean().optional().describe("Write .vscode/settings.json YAML schema associations."),
      json: z.boolean().optional().describe("Return machine-readable schema registry output.")
    }
  },
  async ({ project, writeVscode, json }) => {
    const args = ["schemas"];
    if (project) args.push("--project", project);
    if (writeVscode) args.push("--write-vscode");
    if (json) args.push("--json");
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_onboard_project",
  {
    title: "AgentFlow onboard project",
    description: "Analyze a project and recommend or write tailored Agent Workflow project config for lower-cost, more personalized runs.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      profile: z.enum(["enterprise", "simple"]).optional().describe("Project profile to recommend or write."),
      write: z.boolean().optional().describe("Write AGENTS.md and .agent-workflow files."),
      force: z.boolean().optional().describe("Overwrite existing onboarding files when writing."),
      json: z.boolean().optional().describe("Return machine-readable onboarding output.")
    }
  },
  async ({ project, profile, write, force, json }) => {
    const args = ["onboard-project", "--project", project, "--profile", profile ?? "enterprise"];
    if (write) {
      args.push("--write");
    }
    if (force) {
      args.push("--force");
    }
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_index_project",
  {
    title: "AgentFlow index project",
    description: "Index a project's local context files into durable compact summaries.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      maxFiles: z.number().int().positive().optional().describe("Maximum files to index."),
      incremental: z.boolean().optional().describe("Only refresh files changed since the last indexed commit."),
      sinceCommit: z.string().optional().describe("Reference commit for incremental indexing."),
      refine: z.boolean().optional().describe("Use the configured model provider to refine summaries."),
      forceRefine: z.boolean().optional().describe("Refresh refined summaries even when content hashes are unchanged.")
    }
  },
  async ({ project, maxFiles, incremental, sinceCommit, refine, forceRefine }) => {
    const args = ["index-project", "--project", project];
    if (maxFiles) {
      args.push("--max-files", String(maxFiles));
    }
    if (incremental) {
      args.push("--incremental");
    }
    if (sinceCommit) {
      args.push("--since-commit", sinceCommit);
    }
    if (refine) {
      args.push("--refine");
    }
    if (forceRefine) {
      args.push("--force-refine");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 10 * 60_000 }));
  }
);

server.registerTool(
  "agentflow_compile",
  {
    title: "AgentFlow compile",
    description: "Compile a compact workflow brief without queueing work.",
    inputSchema: {
      workflow: z.string().describe("Workflow id or alias, for example build-feature, review-pr, or review-change."),
      project: z.string().describe("Absolute or relative project directory."),
      task: z.string().describe("Task description."),
      sourceTokenBudget: z.number().int().positive().optional().describe("Token budget for indexed source summaries."),
      sourceMaxFiles: z.number().int().positive().optional().describe("Maximum indexed source summaries to include.")
    }
  },
  async ({ workflow, project, task, sourceTokenBudget, sourceMaxFiles }) => {
    const args = ["compile", "--workflow", workflow, "--project", project, "--task", task];
    addSourceOptions(args, sourceTokenBudget, sourceMaxFiles);
    return toolResult(await runAgentflow(args));
  }
);

server.registerTool(
  "agentflow_workflow_graph",
  {
    title: "AgentFlow workflow graph",
    description: "Inspect a workflow graph, policy fit, approvals, agents, and context budgets without queueing work.",
    inputSchema: {
      workflow: z.string().describe("Workflow id or alias, for example build-feature, review-pr, or review-change."),
      project: z.string().describe("Absolute or relative project directory."),
      policyProfile: z.string().optional().describe("Execution policy profile, for example local, staging, or production."),
      json: z.boolean().optional().describe("Return machine-readable graph JSON."),
      mermaid: z.boolean().optional().describe("Return only the Mermaid flowchart.")
    }
  },
  async ({ workflow, project, policyProfile, json, mermaid }) => {
    const args = ["workflow-graph", "--workflow", workflow, "--project", project];
    if (policyProfile) args.push("--policy-profile", policyProfile);
    if (json) args.push("--json");
    if (mermaid) args.push("--mermaid");
    return toolResult(await runAgentflow(args));
  }
);

server.registerTool(
  "agentflow_run_workflow",
  {
    title: "AgentFlow run workflow",
    description: "Run a workflow for a project task and process worker stages by default. Set queueOnly=true only when you explicitly want to leave the run queued for a separate worker.",
    inputSchema: {
      workflow: z.string().describe("Workflow id or alias, for example build-feature, review-pr, or review-change."),
      project: z.string().describe("Absolute or relative project directory."),
      task: z.string().describe("Task description."),
      queueOnly: z.boolean().optional().describe("Only queue the run and return immediately. Defaults to false so Codex-facing calls do not get stuck in queued state."),
      includeBrief: z.boolean().optional().describe("Print the compiled brief in the result."),
      workerLimit: z.number().int().positive().max(50).optional().describe("Maximum queued stage tasks to process per worker tick when queueOnly is false."),
      timeoutMs: z.number().int().positive().optional().describe("Maximum time to wait for completion when queueOnly is false."),
      out: z.string().optional().describe("Export directory when queueOnly is false."),
      skipIndex: z.boolean().optional().describe("Skip project indexing before queueing."),
      fullIndex: z.boolean().optional().describe("Force a full project index instead of the default incremental refresh."),
      sourceTokenBudget: z.number().int().positive().optional().describe("Token budget for indexed source summaries."),
      sourceMaxFiles: z.number().int().positive().optional().describe("Maximum indexed source summaries to include.")
    }
  },
  async ({ workflow, project, task, queueOnly, includeBrief, workerLimit, timeoutMs, out, skipIndex, fullIndex, sourceTokenBudget, sourceMaxFiles }) => {
    if (!queueOnly) {
      const args = ["run-and-watch", workflow, "--project", project, "--task", task];
      if (skipIndex) {
        args.push("--skip-index");
      }
      if (fullIndex) {
        args.push("--full-index");
      }
      if (workerLimit) {
        args.push("--worker-limit", String(workerLimit));
      }
      if (timeoutMs) {
        args.push("--timeout-ms", String(timeoutMs));
      }
      if (out) {
        args.push("--out", out);
      }
      addSourceOptions(args, sourceTokenBudget, sourceMaxFiles);
      return toolResult(await runAgentflow(args, { timeoutMs: timeoutMs ? timeoutMs + 60_000 : 16 * 60_000 }));
    }

    const args = ["run", workflow, "--project", project, "--task", task];
    if (includeBrief !== true) {
      args.push("--no-brief");
    }
    addSourceOptions(args, sourceTokenBudget, sourceMaxFiles);
    return toolResult(await runAgentflow(args));
  }
);

server.registerTool(
  "agentflow_run_and_watch",
  {
    title: "AgentFlow run and watch",
    description: "Index a project, queue a workflow, process worker tasks until complete or failed, export reports, and return the summary.",
    inputSchema: {
      workflow: z.string().describe("Workflow id or alias, for example build-feature, review-pr, or review-change."),
      project: z.string().describe("Absolute or relative project directory."),
      task: z.string().describe("Task description."),
      skipIndex: z.boolean().optional().describe("Skip project indexing before queueing."),
      indexMaxFiles: z.number().int().positive().optional().describe("Maximum project files to index first."),
      fullIndex: z.boolean().optional().describe("Force a full project index instead of the default incremental refresh."),
      refineIndex: z.boolean().optional().describe("Refine indexed summaries with the selected provider."),
      forceRefine: z.boolean().optional().describe("Refresh refined summaries even when content hashes are unchanged."),
      workerLimit: z.number().int().positive().max(50).optional().describe("Maximum queued stage tasks to process per worker tick."),
      intervalMs: z.number().int().positive().optional().describe("Polling interval while waiting for run status."),
      timeoutMs: z.number().int().positive().optional().describe("Maximum time to wait for completion."),
      out: z.string().optional().describe("Export directory."),
      sourceTokenBudget: z.number().int().positive().optional().describe("Token budget for indexed source summaries."),
      sourceMaxFiles: z.number().int().positive().optional().describe("Maximum indexed source summaries to include.")
    }
  },
  async ({
    workflow,
    project,
    task,
    skipIndex,
    indexMaxFiles,
    fullIndex,
    refineIndex,
    forceRefine,
    workerLimit,
    intervalMs,
    timeoutMs,
    out,
    sourceTokenBudget,
    sourceMaxFiles
  }) => {
    const args = ["run-and-watch", workflow, "--project", project, "--task", task];
    if (skipIndex) {
      args.push("--skip-index");
    }
    if (indexMaxFiles) {
      args.push("--index-max-files", String(indexMaxFiles));
    }
    if (fullIndex) {
      args.push("--full-index");
    }
    if (refineIndex) {
      args.push("--refine-index");
    }
    if (forceRefine) {
      args.push("--force-refine");
    }
    if (workerLimit) {
      args.push("--worker-limit", String(workerLimit));
    }
    if (intervalMs) {
      args.push("--interval-ms", String(intervalMs));
    }
    if (timeoutMs) {
      args.push("--timeout-ms", String(timeoutMs));
    }
    if (out) {
      args.push("--out", out);
    }
    addSourceOptions(args, sourceTokenBudget, sourceMaxFiles);
    return toolResult(await runAgentflow(args, { timeoutMs: timeoutMs ? timeoutMs + 60_000 : 16 * 60_000 }));
  }
);

server.registerTool(
  "agentflow_agent_task",
  {
    title: "AgentFlow agent task",
    description: "Run one specialist agent directly, process the task, export reports, and return the summary.",
    inputSchema: {
      agent: z.string().describe("Agent id, display name, or alias, for example ux-reviewer, Mira, security, or frontend."),
      project: z.string().describe("Absolute or relative project directory."),
      task: z.string().describe("Task description."),
      skipIndex: z.boolean().optional().describe("Skip project indexing before queueing."),
      indexMaxFiles: z.number().int().positive().optional().describe("Maximum project files to index first."),
      fullIndex: z.boolean().optional().describe("Force a full project index instead of the default incremental refresh."),
      refineIndex: z.boolean().optional().describe("Refine indexed summaries with the selected provider."),
      forceRefine: z.boolean().optional().describe("Refresh refined summaries even when content hashes are unchanged."),
      intervalMs: z.number().int().positive().optional().describe("Polling interval while waiting for run status."),
      timeoutMs: z.number().int().positive().optional().describe("Maximum time to wait for completion."),
      out: z.string().optional().describe("Export directory."),
      sourceTokenBudget: z.number().int().positive().optional().describe("Token budget for indexed source summaries."),
      sourceMaxFiles: z.number().int().positive().optional().describe("Maximum indexed source summaries to include.")
    }
  },
  async ({
    agent,
    project,
    task,
    skipIndex,
    indexMaxFiles,
    fullIndex,
    refineIndex,
    forceRefine,
    intervalMs,
    timeoutMs,
    out,
    sourceTokenBudget,
    sourceMaxFiles
  }) => {
    const args = ["agent-task", agent, "--project", project, "--task", task];
    if (skipIndex) {
      args.push("--skip-index");
    }
    if (indexMaxFiles) {
      args.push("--index-max-files", String(indexMaxFiles));
    }
    if (fullIndex) {
      args.push("--full-index");
    }
    if (refineIndex) {
      args.push("--refine-index");
    }
    if (forceRefine) {
      args.push("--force-refine");
    }
    if (intervalMs) {
      args.push("--interval-ms", String(intervalMs));
    }
    if (timeoutMs) {
      args.push("--timeout-ms", String(timeoutMs));
    }
    if (out) {
      args.push("--out", out);
    }
    addSourceOptions(args, sourceTokenBudget, sourceMaxFiles);
    return toolResult(await runAgentflow(args, { timeoutMs: timeoutMs ? timeoutMs + 60_000 : 11 * 60_000 }));
  }
);

server.registerTool(
  "agentflow_preset",
  {
    title: "AgentFlow preset",
    description: "Run a named Agent Workflow preset, such as tellara-ux-pass, tellara-pr-review, tellara-test-triage, tellara-maintain-context, or tellara-frontend-pass.",
    inputSchema: {
      preset: z.string().optional().describe("Preset id or alias. Use list to show available presets."),
      project: z.string().optional().describe("Optional project directory override."),
      task: z.string().optional().describe("Optional task description override."),
      list: z.boolean().optional().describe("List available presets instead of running one.")
    }
  },
  async ({ preset, project, task, list }) => {
    const args = ["preset"];
    if (list) {
      args.push("--list");
    } else {
      if (!preset) {
        return toolResult({
          command: "agentflow preset",
          exitCode: 1,
          stdout: "",
          stderr: "Provide preset or set list=true.",
          timedOut: false
        });
      }
      args.push(preset);
    }
    if (project) {
      args.push("--project", project);
    }
    if (task) {
      args.push("--task", task);
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 16 * 60_000 }));
  }
);

server.registerTool(
  "agentflow_orchestrate",
  {
    title: "AgentFlow orchestrate",
    description: "Route a natural-language project task to the right agents and workflows, run the plan, export reports, and return an aggregate summary.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      task: z.string().describe("Natural-language task description."),
      dryRun: z.boolean().optional().describe("Print the orchestration plan without running it."),
      indexMaxFiles: z.number().int().positive().optional().describe("Maximum project files to index before each step."),
      refineIndex: z.boolean().optional().describe("Refine indexed summaries with the selected provider."),
      forceRefine: z.boolean().optional().describe("Refresh refined summaries even when content hashes are unchanged."),
      workerLimit: z.number().int().positive().max(50).optional().describe("Maximum workflow tasks to process per worker tick."),
      timeoutMs: z.number().int().positive().optional().describe("Maximum time to wait for each step."),
      out: z.string().optional().describe("Export directory.")
    }
  },
  async ({ project, task, dryRun, indexMaxFiles, refineIndex, forceRefine, workerLimit, timeoutMs, out }) => {
    const args = ["orchestrate", "--project", project, "--task", task];
    if (dryRun) {
      args.push("--dry-run");
    }
    if (indexMaxFiles) {
      args.push("--index-max-files", String(indexMaxFiles));
    }
    if (refineIndex) {
      args.push("--refine-index");
    }
    if (forceRefine) {
      args.push("--force-refine");
    }
    if (workerLimit) {
      args.push("--worker-limit", String(workerLimit));
    }
    if (timeoutMs) {
      args.push("--timeout-ms", String(timeoutMs));
    }
    if (out) {
      args.push("--out", out);
    }
    return toolResult(await runAgentflow(args, { timeoutMs: timeoutMs ? timeoutMs + 60_000 : 30 * 60_000 }));
  }
);

server.registerTool(
  "agentflow_worker",
  {
    title: "AgentFlow worker",
    description: "Execute queued workflow stage tasks once.",
    inputSchema: {
      limit: z.number().int().positive().max(50).optional().describe("Maximum queued stage tasks to process.")
    }
  },
  async ({ limit }) => toolResult(await runAgentflow(["worker", "--limit", String(limit ?? 1)], { timeoutMs: 15 * 60_000 }))
);

server.registerTool(
  "agentflow_status",
  {
    title: "AgentFlow status",
    description: "Show recent workflow runs or details for one run.",
    inputSchema: {
      runId: z.string().optional().describe("Workflow run id."),
      limit: z.number().int().positive().max(100).optional().describe("Number of recent runs to show."),
      artifacts: z.boolean().optional().describe("Include artifact URIs when inspecting a run.")
    }
  },
  async ({ runId, limit, artifacts }) => {
    const args = ["status"];
    if (runId) {
      args.push("--run", runId);
      if (artifacts) {
        args.push("--artifacts");
      }
    } else if (limit) {
      args.push("--limit", String(limit));
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_quality_report",
  {
    title: "AgentFlow quality report",
    description: "Show adaptive routing, cost mix, latency, fallback, and quality scoring for a workflow run.",
    inputSchema: {
      runId: z.string().describe("Workflow run id."),
      json: z.boolean().optional().describe("Return report JSON.")
    }
  },
  async ({ runId, json }) => {
    const args = ["quality-report", "--run", runId];
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_feedback",
  {
    title: "AgentFlow feedback",
    description: "Record accepted, revised, or rejected feedback for a workflow run so future routing can learn from it.",
    inputSchema: {
      runId: z.string().describe("Workflow run id."),
      rating: z.enum(["accepted", "revised", "rejected"]).describe("User outcome rating for the run."),
      note: z.string().optional().describe("Short note explaining what worked or what should change.")
    }
  },
  async ({ runId, rating, note }) => {
    const args = ["feedback", "--run", runId, "--rating", rating];
    if (note) {
      args.push("--note", note);
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_preference_scorecard",
  {
    title: "AgentFlow preference scorecard",
    description: "Aggregate feedback, quality, fallback, and routing performance by workflow, stage, agent, provider, and tier.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      limit: z.number().int().positive().max(100).optional().describe("Number of recent project runs to analyze."),
      json: z.boolean().optional().describe("Return scorecard JSON.")
    }
  },
  async ({ project, limit, json }) => {
    const args = ["preference-scorecard", "--project", project];
    if (limit) {
      args.push("--limit", String(limit));
    }
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_tuning_proposals",
  {
    title: "AgentFlow tuning proposals",
    description: "Generate reviewable prompt, context-budget, and routing tuning proposals from the preference scorecard.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      limit: z.number().int().positive().max(100).optional().describe("Number of recent project runs to analyze."),
      json: z.boolean().optional().describe("Return proposals JSON.")
    }
  },
  async ({ project, limit, json }) => {
    const args = ["tuning-proposals", "--project", project];
    if (limit) {
      args.push("--limit", String(limit));
    }
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_learning_report",
  {
    title: "AgentFlow learning report",
    description: "Read-only local learning report from run history, feedback, failures, routing, and evaluation evidence.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      limit: z.number().int().positive().max(100).optional().describe("Number of recent project runs to analyze."),
      json: z.boolean().optional().describe("Return report JSON.")
    }
  },
  async ({ project, limit, json }) => {
    const args = ["learning-report", "--project", project];
    if (limit) {
      args.push("--limit", String(limit));
    }
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_learning_proposals",
  {
    title: "AgentFlow learning proposals",
    description: "Generate or write local learning proposals and a project-local approval inbox.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      ids: z.string().optional().describe("Comma-separated proposal ids to queue, or all."),
      limit: z.number().int().positive().max(100).optional().describe("Number of recent project runs to analyze."),
      write: z.boolean().optional().describe("Write proposal and approval inbox files into .agent-workflow/learning."),
      json: z.boolean().optional().describe("Return proposal JSON.")
    }
  },
  async ({ project, ids, limit, write, json }) => {
    const args = ["learning-proposals", "--project", project];
    if (ids) {
      args.push("--ids", ids);
    }
    if (limit) {
      args.push("--limit", String(limit));
    }
    if (write) {
      args.push("--write");
    }
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_learning_approvals",
  {
    title: "AgentFlow learning approvals",
    description: "List, approve, or reject project-local learning proposal inbox items without applying changes.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      approve: z.string().optional().describe("Comma-separated approval ids or proposal ids to approve, or all."),
      reject: z.string().optional().describe("Comma-separated approval ids or proposal ids to reject, or all."),
      reviewer: z.string().optional().describe("Reviewer name."),
      note: z.string().optional().describe("Decision note."),
      json: z.boolean().optional().describe("Return approval queue JSON.")
    }
  },
  async ({ project, approve, reject, reviewer, note, json }) => {
    const args = ["learning-approvals", "--project", project];
    if (approve) {
      args.push("--approve", approve);
    }
    if (reject) {
      args.push("--reject", reject);
    }
    if (reviewer) {
      args.push("--reviewer", reviewer);
    }
    if (note) {
      args.push("--note", note);
    }
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_learning_daemon_status",
  {
    title: "AgentFlow learning daemon status",
    description: "Show local learning daemon heartbeat and owned learning-state status for a project.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      json: z.boolean().optional().describe("Return daemon status JSON.")
    }
  },
  async ({ project, json }) => {
    const args = ["learning-daemon-status", "--project", project];
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_learning_daemon_tick",
  {
    title: "AgentFlow learning daemon tick",
    description: "Run one bounded local learning daemon tick in observe or propose mode.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      mode: z.enum(["observe", "propose", "apply-approved"]).optional().describe("observe writes latest report/status; propose also refreshes proposal inbox; apply-approved also refreshes approved application plans."),
      limit: z.number().int().positive().max(100).optional().describe("Number of recent project runs to analyze."),
      json: z.boolean().optional().describe("Return final daemon status JSON.")
    }
  },
  async ({ project, mode, limit, json }) => {
    const args = ["learning-daemon", "--project", project, "--once", "--mode", mode ?? "observe"];
    if (limit) {
      args.push("--limit", String(limit));
    }
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_learning_application_plan",
  {
    title: "AgentFlow learning application plan",
    description: "Prepare a dry-run or saved Agent Workflow-owned application plan from approved learning proposals without applying changes.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      ids: z.string().optional().describe("Comma-separated approved proposal ids or approval ids to include, or all."),
      write: z.boolean().optional().describe("Write application-plan files into .agent-workflow/learning."),
      json: z.boolean().optional().describe("Return application plan JSON.")
    }
  },
  async ({ project, ids, write, json }) => {
    const args = ["learning-application-plan", "--project", project];
    if (ids) {
      args.push("--ids", ids);
    }
    if (write) {
      args.push("--write");
    }
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_apply_tuning_proposals",
  {
    title: "AgentFlow apply tuning proposals",
    description: "Dry-run or write project-local tuning overlay files from selected tuning proposals.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      ids: z.string().optional().describe("Comma-separated proposal ids to apply, or all."),
      limit: z.number().int().positive().max(100).optional().describe("Number of recent project runs to analyze."),
      approved: z.boolean().optional().describe("Apply only approved proposals from .agent-workflow/tuning/approval-queue.json."),
      write: z.boolean().optional().describe("Write generated overlay files into .agent-workflow/tuning."),
      json: z.boolean().optional().describe("Return application plan JSON.")
    }
  },
  async ({ project, ids, limit, approved, write, json }) => {
    const args = ["apply-tuning-proposals", "--project", project];
    if (ids) {
      args.push("--ids", ids);
    }
    if (approved) {
      args.push("--approved");
    }
    if (limit) {
      args.push("--limit", String(limit));
    }
    if (write) {
      args.push("--write");
    }
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_queue_tuning_approvals",
  {
    title: "AgentFlow queue tuning approvals",
    description: "Dry-run or write a project-local approval queue for selected tuning proposals.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      ids: z.string().optional().describe("Comma-separated proposal ids to queue, or all."),
      limit: z.number().int().positive().max(100).optional().describe("Number of recent project runs to analyze."),
      write: z.boolean().optional().describe("Write approval queue files into .agent-workflow/tuning."),
      json: z.boolean().optional().describe("Return approval queue JSON.")
    }
  },
  async ({ project, ids, limit, write, json }) => {
    const args = ["queue-tuning-approvals", "--project", project];
    if (ids) {
      args.push("--ids", ids);
    }
    if (limit) {
      args.push("--limit", String(limit));
    }
    if (write) {
      args.push("--write");
    }
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_tuning_approvals",
  {
    title: "AgentFlow tuning approvals",
    description: "List, approve, or reject project-local tuning approval queue items.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      approve: z.string().optional().describe("Comma-separated approval ids or proposal ids to approve, or all."),
      reject: z.string().optional().describe("Comma-separated approval ids or proposal ids to reject, or all."),
      reviewer: z.string().optional().describe("Reviewer name."),
      note: z.string().optional().describe("Decision note."),
      json: z.boolean().optional().describe("Return approval queue JSON.")
    }
  },
  async ({ project, approve, reject, reviewer, note, json }) => {
    const args = ["tuning-approvals", "--project", project];
    if (approve) {
      args.push("--approve", approve);
    }
    if (reject) {
      args.push("--reject", reject);
    }
    if (reviewer) {
      args.push("--reviewer", reviewer);
    }
    if (note) {
      args.push("--note", note);
    }
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_generate_tuning_patches",
  {
    title: "AgentFlow generate tuning patches",
    description: "Dry-run or write reviewable patch-plan files from approved tuning proposals.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      ids: z.string().optional().describe("Comma-separated approved proposal ids or approval ids to include, or all."),
      write: z.boolean().optional().describe("Write patch-plan files into .agent-workflow/tuning/patches."),
      json: z.boolean().optional().describe("Return patch plan JSON.")
    }
  },
  async ({ project, ids, write, json }) => {
    const args = ["generate-tuning-patches", "--project", project];
    if (ids) {
      args.push("--ids", ids);
    }
    if (write) {
      args.push("--write");
    }
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_apply_tuning_patches",
  {
    title: "AgentFlow apply tuning patches",
    description: "Dry-run or write project-local tuning notes from reviewed patch-plan items.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      ids: z.string().optional().describe("Comma-separated approved proposal ids or approval ids to apply, or all."),
      write: z.boolean().optional().describe("Write applied tuning notes into .agent-workflow/tuning."),
      json: z.boolean().optional().describe("Return application plan JSON.")
    }
  },
  async ({ project, ids, write, json }) => {
    const args = ["apply-tuning-patches", "--project", project];
    if (ids) {
      args.push("--ids", ids);
    }
    if (write) {
      args.push("--write");
    }
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_artifacts",
  {
    title: "AgentFlow artifacts",
    description: "Inspect compiled briefs and stage output artifacts.",
    inputSchema: {
      runId: z.string().optional().describe("Workflow run id."),
      uri: z.string().optional().describe("Specific artifact URI."),
      kind: z.string().optional().describe("Artifact kind, for example compiled_brief or stage_output."),
      json: z.boolean().optional().describe("Print full artifact JSON."),
      content: z.boolean().optional().describe("Print artifact content only.")
    }
  },
  async ({ runId, uri, kind, json, content }) => {
    const args = ["artifacts"];
    if (runId) {
      args.push("--run", runId);
    }
    if (uri) {
      args.push("--uri", uri);
    }
    if (kind) {
      args.push("--kind", kind);
    }
    if (json) {
      args.push("--json");
    }
    if (content) {
      args.push("--content");
    }
    return toolResult(await runAgentflow(args));
  }
);

server.registerTool(
  "agentflow_export_run",
  {
    title: "AgentFlow export run",
    description: "Export a workflow run report as Markdown and JSON.",
    inputSchema: {
      runId: z.string().describe("Workflow run id."),
      out: z.string().optional().describe("Export directory."),
      scrub: z.boolean().optional().describe("Redact secrets and high-risk project details for sharing.")
    }
  },
  async ({ runId, out, scrub }) => {
    const args = ["export-run", "--run", runId];
    if (out) {
      args.push("--out", out);
    }
    if (scrub) {
      args.push("--scrub");
    }
    return toolResult(await runAgentflow(args));
  }
);

server.registerTool(
  "agentflow_summarize_run",
  {
    title: "AgentFlow summarize run",
    description: "Print a compact decision-ready summary for a workflow run.",
    inputSchema: {
      runId: z.string().describe("Workflow run id."),
      json: z.boolean().optional().describe("Return summary JSON.")
    }
  },
  async ({ runId, json }) => {
    const args = ["summarize-run", "--run", runId];
    if (json) {
      args.push("--json");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_schedule",
  {
    title: "AgentFlow schedule",
    description: "Run due project schedules from .agent-workflow/schedules.yaml, or dry-run to list due schedules.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      dryRun: z.boolean().optional().describe("Print due schedules without running them.")
    }
  },
  async ({ project, dryRun }) => {
    const args = ["schedule", "--project", project];
    if (dryRun) {
      args.push("--dry-run");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 16 * 60_000 }));
  }
);

server.registerTool(
  "agentflow_provider_check",
  {
    title: "AgentFlow provider check",
    description: "Check the configured model provider."
  },
  async () => toolResult(await runAgentflow(["provider-check"], { timeoutMs: 60_000 }))
);

server.registerTool(
  "agentflow_provider_use",
  {
    title: "AgentFlow provider use",
    description: "Switch or update the Agent Workflow model provider in .env, for requests like 'use BYO model', 'update my model to openai', or 'use Kiro'.",
    inputSchema: {
      provider: z.enum(["mock", "byo", "openai", "openai-compatible", "bedrock", "kiro"]).describe("Provider to store in .env."),
      check: z.boolean().optional().describe("Run provider-check after switching.")
    }
  },
  async ({ provider, check }) => {
    const args = ["provider-use", provider];
    if (check) {
      args.push("--check");
    }
    return toolResult(await runAgentflow(args, { timeoutMs: 60_000 }));
  }
);

server.registerTool(
  "agentflow_provider_smoke",
  {
    title: "AgentFlow provider smoke",
    description: "Run a minimal workflow through the configured model provider."
  },
  async () => toolResult(await runCommand("bash", [path.join(rootDir, "scripts", "provider-smoke.sh")], 10 * 60_000))
);

await server.connect(new StdioServerTransport());

function addSourceOptions(args: string[], sourceTokenBudget?: number, sourceMaxFiles?: number): void {
  if (sourceTokenBudget) {
    args.push("--source-token-budget", String(sourceTokenBudget));
  }
  if (sourceMaxFiles) {
    args.push("--source-max-files", String(sourceMaxFiles));
  }
}

async function runAgentflow(args: string[], options: { timeoutMs?: number } = {}): Promise<CommandResult> {
  if (await fileExists(compiledCliPath)) {
    return runCommand(process.execPath, [compiledCliPath, ...args], options.timeoutMs ?? defaultTimeoutMs);
  }
  return runNpmScript(["run", "-s", "agentflow", "--", ...args], options);
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then((fs) => fs.access(target));
    return true;
  } catch {
    return false;
  }
}

async function runNpmScript(args: string[], options: { timeoutMs?: number } = {}): Promise<CommandResult> {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  return runCommand(command, args, options.timeoutMs ?? defaultTimeoutMs);
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = trimOutput(stdout + chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = trimOutput(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command: formatCommand(command, args),
        exitCode: 1,
        stdout,
        stderr: trimOutput(`${stderr}\n${error.message}`.trim()),
        timedOut
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        command: formatCommand(command, args),
        exitCode,
        stdout,
        stderr,
        timedOut
      });
    });
  });
}

function toolResult(result: CommandResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  const chunks = [
    `$ ${result.command}`,
    result.stdout.trim(),
    result.stderr.trim() ? `stderr\n${result.stderr.trim()}` : "",
    result.timedOut ? "Timed out." : "",
    result.exitCode === 0 ? "" : `Exit code: ${result.exitCode ?? "unknown"}`
  ].filter(Boolean);

  return {
    content: [{ type: "text", text: chunks.join("\n\n") || "(no output)" }],
    isError: result.exitCode !== 0 || result.timedOut
  };
}

function trimOutput(value: string): string {
  if (value.length <= maxOutputChars) {
    return value;
  }
  return `${value.slice(0, 2_000)}\n\n[...output truncated...]\n\n${value.slice(-maxOutputChars + 2_000)}`;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map((part) => part.includes(" ") ? JSON.stringify(part) : part).join(" ");
}
