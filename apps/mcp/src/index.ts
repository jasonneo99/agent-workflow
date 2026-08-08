#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const maxOutputChars = 30_000;
const defaultTimeoutMs = 120_000;

type CommandResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const server = new McpServer({
  name: "portable-agent-workflows",
  version: "0.1.0"
});

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
  "agentflow_list",
  {
    title: "AgentFlow list",
    description: "List available portable agents and workflows."
  },
  async () => toolResult(await runAgentflow(["list"], { timeoutMs: 60_000 }))
);

server.registerTool(
  "agentflow_index_project",
  {
    title: "AgentFlow index project",
    description: "Index a project's local context files into durable compact summaries.",
    inputSchema: {
      project: z.string().describe("Absolute or relative project directory."),
      maxFiles: z.number().int().positive().optional().describe("Maximum files to index."),
      refine: z.boolean().optional().describe("Use the configured model provider to refine summaries."),
      forceRefine: z.boolean().optional().describe("Refresh refined summaries even when content hashes are unchanged.")
    }
  },
  async ({ project, maxFiles, refine, forceRefine }) => {
    const args = ["index-project", "--project", project];
    if (maxFiles) {
      args.push("--max-files", String(maxFiles));
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
  "agentflow_run_workflow",
  {
    title: "AgentFlow run workflow",
    description: "Queue an enterprise workflow run for a project task.",
    inputSchema: {
      workflow: z.string().describe("Workflow id or alias, for example build-feature, review-pr, or review-change."),
      project: z.string().describe("Absolute or relative project directory."),
      task: z.string().describe("Task description."),
      includeBrief: z.boolean().optional().describe("Print the compiled brief in the result."),
      sourceTokenBudget: z.number().int().positive().optional().describe("Token budget for indexed source summaries."),
      sourceMaxFiles: z.number().int().positive().optional().describe("Maximum indexed source summaries to include.")
    }
  },
  async ({ workflow, project, task, includeBrief, sourceTokenBudget, sourceMaxFiles }) => {
    const args = ["run", workflow, "--project", project, "--task", task];
    if (!includeBrief) {
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
      out: z.string().optional().describe("Export directory.")
    }
  },
  async ({ runId, out }) => {
    const args = ["export-run", "--run", runId];
    if (out) {
      args.push("--out", out);
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
  async () => toolResult(await runNpmScript(["run", "-s", "provider-smoke"], { timeoutMs: 10 * 60_000 }))
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
  return runNpmScript(["run", "-s", "agentflow", "--", ...args], options);
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
