import type { CliContext } from "./context.js";
import type { DashboardFollowUpResult, RunInputSnapshot, RunStaleInputReport, RunSummary, WorkflowPreset } from "./cli-types.js";
import { summarizeWorkflowRun } from "./builders-learning.js";
import { exportWorkflowRun, watchWorkflowRun } from "./builders-local-llm.js";
import { indexProjectForRun, loadAgentsForProject, objectValue, queueWorkflow, resolveLocalProjectRootUri, stableHash, stringValue } from "./builders-shared.js";
import { loadAgents, loadProjectConfig, loadWorkflows } from "../../../../packages/agent-registry/src/loaders.js";
import { buildBundleManifest } from "../../../../packages/agent-registry/src/manifest.js";
import { constructDynamicWorkflow } from "../../../../packages/dynamic-workflow/src/index.js";
import { buildObservabilityReport } from "../../../../packages/observability/src/index.js";
import { resolveExecutionPolicy } from "../../../../packages/policy-engine/src/index.js";
import { getWorkflowRunDetails, listArtifacts, seedRegistry } from "../../../../packages/storage/src/postgres.js";
import { formatDashboardDuration } from "../dashboard/home-metrics.js";
import { type RunEta } from "../dashboard/run-eta.js";
import { resolveAgent, resolveWorkflow } from "../reference-resolution.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function assessRunStaleInputs(ctx: CliContext, runId: string): Promise<RunStaleInputReport> {
  const details = await getWorkflowRunDetails(runId);
  if (!details.run) {
    return {
      available: false,
      warnings: [`Unknown workflow run: ${runId}`],
      snapshot: null
    };
  }
  const artifacts = await listArtifacts({ runId, kind: "compiled_brief" });
  const snapshot = readRunInputSnapshot(artifacts.at(-1)?.content);
  if (!snapshot) {
    return {
      available: false,
      warnings: ["This run was created before run-input snapshots were recorded; stale input detection is limited."],
      snapshot: null
    };
  }

  const warnings: string[] = [];
  const localProjectRootUri = await resolveLocalProjectRootUri(details.run.projectRootUri);
  try {
    const currentConfig = await loadProjectConfig(localProjectRootUri);
    const currentConfigHash = stableHash(currentConfig);
    if (currentConfigHash !== snapshot.projectConfigHash) {
      warnings.push("Project config changed since the run was queued.");
    }
    try {
      const currentPolicy = resolveExecutionPolicy(currentConfig, details.run.policyProfile);
      if (currentPolicy.snapshotHash !== snapshot.policySnapshotHash) {
        warnings.push(`Execution policy profile '${details.run.policyProfile}' changed since the run was queued.`);
      }
    } catch (error) {
      warnings.push(`Execution policy profile '${details.run.policyProfile}' can no longer be resolved: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    warnings.push(`Project config could not be loaded for stale-checking: ${error instanceof Error ? error.message : String(error)}`);
  }

  const currentBundle = await buildBundleManifest(ctx.rootDir).catch(() => null);
  if (!snapshot.bundle) {
    warnings.push("Original bundle checksum was not recorded for this run.");
  } else if (!currentBundle) {
    warnings.push("Current bundle checksum could not be computed.");
  } else {
    if (currentBundle.bundle.version !== snapshot.bundle.version) {
      warnings.push(`Bundle version changed from ${snapshot.bundle.version} to ${currentBundle.bundle.version}.`);
    }
    if (currentBundle.checksum.value !== snapshot.bundle.checksum) {
      warnings.push("Agent/workflow bundle checksum changed since the run was queued.");
    }
  }

  const workflows = await loadWorkflows(ctx.rootDir).catch(() => []);
  const currentWorkflow = resolveWorkflow(workflows, details.run!.workflowId);
  if (!currentWorkflow) {
    warnings.push(`Current workflow definition is unavailable: ${details.run.workflowId}.`);
  } else if (stableHash(currentWorkflow) !== snapshot.workflowHash) {
    warnings.push(`Workflow definition '${details.run.workflowId}' changed since the run was queued; replay will use the stored workflow snapshot when available.`);
  }

  for (const source of snapshot.selectedSources) {
    if (!source.contentHash) {
      warnings.push(`Selected source '${source.sourceUri}' did not record a content hash.`);
      continue;
    }
    if (source.contentHash === "skipped-large-file") {
      continue;
    }
    const absolutePath = path.join(localProjectRootUri, source.sourceUri);
    try {
      const currentHash = createHash("sha256").update(await fs.readFile(absolutePath)).digest("hex");
      if (currentHash !== source.contentHash) {
        warnings.push(`Selected source changed: ${source.sourceUri}.`);
      }
    } catch {
      warnings.push(`Selected source is missing or unreadable: ${source.sourceUri}.`);
    }
  }

  return {
    available: true,
    warnings,
    snapshot
  };
}

export function createAgentTaskWorkflow(agent: Awaited<ReturnType<typeof loadAgents>>[number]): Awaited<ReturnType<typeof loadWorkflows>>[number] {
  return {
    id: `agent-task-${agent.id}`,
    name: `Agent Task - ${agent.display_name}`,
    description: `Run ${agent.display_name} directly as a one-stage specialist task.`,
    lead: agent.id,
    default_autonomy: agent.autonomy,
    triggers: {
      manual: true,
      events: []
    },
    stages: [
      {
        id: "specialist-task",
        agent: agent.id,
        goal: agent.purpose,
        subagents: [],
        pattern: {
          type: "single-shot",
          requires_verifier: false,
          promotion_gate: "none",
          stop_conditions: []
        },
        context: {
          load: ["AGENTS.md", ".agent-workflow/**"],
          max_tokens: agent.context_budget.max_tokens
        },
        approval_required: false,
        output: agent.outputs.schema
      }
    ]
  };
}

export function formatDashboardDateTimeText(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(parsed);
}

export function formatIndexResult(result: {
  projectName: string;
  count: number;
  skipped: number;
  refined: number;
  reused: number;
  changed: number;
  deleted: number;
  incremental: boolean;
  fullIndexFallback: boolean;
  truncated: boolean;
  headCommit?: string;
  contextObservations: number;
  projectedContextSavingsPercent: number;
}): string {
  return [
    `${result.incremental ? "Incrementally indexed" : "Indexed"} ${result.count} file${result.count === 1 ? "" : "s"} for ${result.projectName}.`,
    `Changed: ${result.changed}; reused: ${result.reused}; deleted: ${result.deleted}; refined: ${result.refined}; skipped large: ${result.skipped}.`,
    result.headCommit ? `Head commit: ${result.headCommit}` : "",
    `Context gateway: ${result.contextObservations} shadow observation(s); projected frontier-input savings ${result.projectedContextSavingsPercent}%.`,
    result.fullIndexFallback ? "Git delta unavailable; fell back to a full index." : "",
    result.truncated ? "Index limit reached before all changed files were processed; rerun with a higher --max-files or --index-max-files value." : ""
  ].filter(Boolean).join("\n");
}

export function formatRunEta(eta: RunEta): string {
  if (eta.state === "complete") return "Complete";
  if (eta.state === "paused") return "Paused";
  if (eta.state === "learning" || eta.remainingMs === null || !eta.estimatedCompletionAt) return "Estimating…";
  return `~${formatDashboardDuration(eta.remainingMs)} remaining · ${formatDashboardDateTimeText(eta.estimatedCompletionAt)} · ${eta.confidence} confidence`;
}

export function formatRunSummary(summary: RunSummary): string {
  return [
    `Run: ${summary.runId}`,
    `Status: ${summary.status}`,
    `Project: ${summary.projectName}`,
    `Workflow: ${summary.workflowId}`,
    `Task: ${summary.task}`,
    `Tasks: ${summary.completedTasks}/${summary.totalTasks} completed, ${summary.failedTasks} failed`,
    "",
    "Stages:",
    ...summary.stageResults.map((stage) => `- ${stage.stageId}: ${stage.agentId} ${stage.status} attempts=${stage.attempts}`),
    "",
    "Key findings:",
    ...(summary.keyFindings.length ? summary.keyFindings.map((finding, index) => `${index + 1}. ${finding}`) : ["- No findings captured."]),
    "",
    "Failures:",
    ...(summary.failures.length ? summary.failures.map((failure) => `- ${failure}`) : ["- None"]),
    "",
    "Approvals:",
    ...(summary.pendingApprovals.length
      ? summary.pendingApprovals.slice(0, 8).map((approval) => [
        `- Approval required: ${approval.actionType} ${approval.target}`,
        `  id: ${approval.id}`,
        `  requested by: ${approval.stageId} (${approval.agentId})`,
        `  CLI: npm run agentflow -- approvals --approve ${approval.id} --actor "Your Name" --actor-role approver`,
        approval.actionType === "local_command" || approval.actionType === "file_write" || approval.actionType === "executor_adapter" ? `  Always exact: npm run agentflow -- approvals --always ${approval.id} --always-scope exact --actor "Your Name" --actor-role approver` : "",
        approval.actionType === "local_command" || approval.actionType === "file_write" ? `  Always broad: npm run agentflow -- approvals --always ${approval.id} --always-scope broad --actor "Your Name" --actor-role approver` : "",
        approval.executable ? `  Execute after approval: npm run agentflow -- approvals --execute ${approval.id} --actor "Your Name" --actor-role operator` : "",
        `  MCP/Codex: ask the user to choose approve, reject, always exact, always broad, or execute; then call agentflow_approvals with the matching field and id.`
      ].filter(Boolean).join("\n"))
      : ["- None"]),
    "",
    "Recommended next action:",
    summary.recommendedNextAction,
    "",
    "Artifacts:",
    ...(summary.artifactUris.length ? summary.artifactUris.map((artifact) => `- ${artifact}`) : ["- None"])
  ].join("\n");
}

export function formatStaleInputWarnings(report: RunStaleInputReport): string[] {
  if (!report.available) {
    return report.warnings.map((warning) => `Stale-check limited: ${warning}`);
  }
  if (!report.warnings.length) {
    return ["Stale-check: no changed project inputs detected."];
  }
  return [
    "Stale-check warnings:",
    ...report.warnings.map((warning) => `- ${warning}`)
  ];
}

export async function loadObservabilityReport(ctx: CliContext, runId: string): Promise<ReturnType<typeof buildObservabilityReport> | null> {
  const details = await getWorkflowRunDetails(runId);
  if (!details.run) {
    return null;
  }

  const artifacts = await listArtifacts({ runId });
  return buildObservabilityReport({
    run: details.run,
    tasks: details.tasks,
    receipts: details.receipts,
    artifacts,
    version: ctx.packageVersion
  });
}

export function readRunInputSnapshot(content: Record<string, unknown> | undefined): RunInputSnapshot | null {
  const metadata = objectValue(content?.metadata);
  const snapshot = objectValue(metadata?.runInputSnapshot);
  if (!snapshot || snapshot.schemaVersion !== 1) {
    return null;
  }
  const bundle = objectValue(snapshot.bundle);
  return {
    schemaVersion: 1,
    capturedAt: stringValue(snapshot.capturedAt) ?? "",
    bundle: bundle
      ? {
        version: stringValue(bundle.version) ?? "unknown",
        checksum: stringValue(bundle.checksum) ?? ""
      }
      : null,
    projectConfigHash: stringValue(snapshot.projectConfigHash) ?? "",
    policySnapshotHash: stringValue(snapshot.policySnapshotHash) ?? "",
    workflowHash: stringValue(snapshot.workflowHash) ?? "",
    selectedSources: Array.isArray(snapshot.selectedSources)
      ? snapshot.selectedSources.map((item) => {
        const source = objectValue(item) ?? {};
        return {
          sourceUri: stringValue(source.sourceUri) ?? "",
          contentHash: stringValue(source.contentHash) ?? null
        };
      }).filter((item) => item.sourceUri)
      : []
  };
}

export function resolveWorkflowPreset(presetRef: string): WorkflowPreset | null {
  const normalized = presetRef.toLowerCase();
  return workflowPresets.find((preset) => preset.id === normalized || preset.aliases.includes(normalized)) ?? null;
}

export async function runDashboardAgentTask(ctx: CliContext, input: {
  title: string;
  agent: string;
  projectDir: string;
  task: string;
  indexMaxFiles?: number;
  refineIndex?: boolean;
  forceRefine?: boolean;
  timeoutMs?: number;
  outDir?: string;
}): Promise<DashboardFollowUpResult> {
  await indexProjectForRun(ctx, {
    projectDir: input.projectDir,
    maxFiles: input.indexMaxFiles ?? 100,
    refine: input.refineIndex ?? false,
    forceRefine: input.forceRefine ?? false
  });
  const agents = await loadAgentsForProject(ctx, input.projectDir);
  const agent = resolveAgent(agents, input.agent);
  if (!agent) {
    return { ok: false, error: `Unknown agent: ${input.agent}` };
  }
  const workflow = createAgentTaskWorkflow(agent);
  const builtinAgentIds = new Set((await loadAgents(ctx.rootDir)).map((item) => item.id));
  await seedRegistry(builtinAgentIds.has(agent.id) ? [] : [{ path: `project/${agent.id}.yaml`, value: agent }], [{ path: `runtime/${workflow.id}.yaml`, value: workflow }]);
  const queued = await queueWorkflow(ctx, {
    workflowId: workflow.id,
    projectPath: input.projectDir,
    task: input.task,
    workflowOverride: workflow
  });
  if (!queued.ok) {
    return { ok: false, error: queued.error };
  }
  const watchResult = await watchWorkflowRun({
    runId: queued.run.runId,
    workerLimit: 1,
    intervalMs: 1000,
    timeoutMs: input.timeoutMs ?? 600000
  });
  const exportResult = await exportWorkflowRun({
    runId: queued.run.runId,
    outDir: input.outDir ?? path.join(input.projectDir, ".agent-workflow", "exports")
  });
  const summary = await summarizeWorkflowRun(queued.run.runId);
  return {
    ok: true,
    title: `${input.title}: ${watchResult.status}`,
    runId: queued.run.runId,
    output: [
      `Run: ${queued.run.runId}`,
      `Agent: ${agent.id} (${agent.display_name})`,
      exportResult.ok ? `Exported Markdown: ${exportResult.markdownPath}` : "",
      exportResult.ok ? `Exported JSON: ${exportResult.jsonPath}` : "",
      summary.ok ? formatRunSummary(summary.value) : ""
    ].filter(Boolean).join("\n\n")
  };
}

export async function runDashboardWorkflow(ctx: CliContext, input: {
  title: string;
  workflow: string;
  projectDir: string;
  task: string;
  indexMaxFiles?: number;
  refineIndex?: boolean;
  forceRefine?: boolean;
  workerLimit?: number;
  workerConcurrency?: number;
  timeoutMs?: number;
  outDir?: string;
  adaptive?: boolean;
  evaluationSource?: string;
}): Promise<DashboardFollowUpResult> {
  await indexProjectForRun(ctx, {
    projectDir: input.projectDir,
    maxFiles: input.indexMaxFiles ?? 100,
    refine: input.refineIndex ?? false,
    forceRefine: input.forceRefine ?? false
  });
  const configuredProject = input.adaptive ? await loadProjectConfig(input.projectDir) : null;
  const dynamic = configuredProject ? constructDynamicWorkflow({
    goal: input.task,
    project: configuredProject,
    agents: await loadAgentsForProject(ctx, input.projectDir),
    executionProfile: "adaptive"
  }) : null;
  if (dynamic) await seedRegistry([], [{ path: `runtime/${dynamic.id}.yaml`, value: dynamic }]);
  const queued = await queueWorkflow(ctx, {
    workflowId: dynamic?.id ?? input.workflow,
    workflowOverride: dynamic ?? undefined,
    projectPath: input.projectDir,
    task: input.task,
    evaluationMetadata: { source: input.evaluationSource ?? "dashboard", executionProfile: input.adaptive ? "adaptive" : "full" }
  });
  if (!queued.ok) {
    return { ok: false, error: queued.error };
  }
  const watchResult = await watchWorkflowRun({
    runId: queued.run.runId,
    workerLimit: input.workerLimit ?? 6,
    workerConcurrency: input.workerConcurrency,
    projectRootUri: queued.projectDir,
    intervalMs: 1000,
    timeoutMs: input.timeoutMs ?? 900000
  });
  const exportResult = await exportWorkflowRun({
    runId: queued.run.runId,
    outDir: input.outDir ?? path.join(input.projectDir, ".agent-workflow", "exports")
  });
  const summary = await summarizeWorkflowRun(queued.run.runId);
  return {
    ok: true,
    title: `${input.title}: ${watchResult.status}`,
    runId: queued.run.runId,
    output: [
      `Run: ${queued.run.runId}`,
      exportResult.ok ? `Exported Markdown: ${exportResult.markdownPath}` : "",
      exportResult.ok ? `Exported JSON: ${exportResult.jsonPath}` : "",
      summary.ok ? formatRunSummary(summary.value) : ""
    ].filter(Boolean).join("\n\n")
  };
}

export async function runWorkflowPreset(ctx: CliContext, input: {
  presetRef: string;
  project?: string;
  task?: string;
  indexMaxFiles?: number;
  refineIndex?: boolean;
  forceRefine?: boolean;
  workerLimit?: number;
  workerConcurrency?: number;
  timeoutMs?: number;
  outDir?: string;
}): Promise<DashboardFollowUpResult> {
  const preset = resolveWorkflowPreset(input.presetRef);
  if (!preset) {
    const available = workflowPresets.map((item) => item.id).join(", ");
    return { ok: false, error: `Unknown preset: ${input.presetRef}. Available presets: ${available}` };
  }

  const projectDir = path.resolve(process.cwd(), input.project ?? preset.project);
  const task = input.task ?? preset.task;

  if (preset.kind === "agent") {
    return runDashboardAgentTask(ctx, {
      title: preset.label,
      agent: preset.target,
      projectDir,
      task,
      indexMaxFiles: input.indexMaxFiles,
      refineIndex: input.refineIndex,
      forceRefine: input.forceRefine,
      timeoutMs: input.timeoutMs,
      outDir: input.outDir
    });
  }

  return runDashboardWorkflow(ctx, {
    title: preset.label,
    workflow: preset.target,
    projectDir,
    task,
    indexMaxFiles: input.indexMaxFiles,
    refineIndex: input.refineIndex,
    forceRefine: input.forceRefine,
    workerLimit: input.workerLimit,
    workerConcurrency: input.workerConcurrency,
    timeoutMs: input.timeoutMs,
    outDir: input.outDir
  });
}

export const workflowPresets: WorkflowPreset[] = [
  {
    id: "ux-pass",
    aliases: ["mira-ux-pass", "ux-review"],
    label: "UX Pass",
    description: "Ask Mira to review user experience and recommend the top fixes.",
    project: ".",
    task: "Do a UX pass on the current project. Summarize findings and recommend the top 3 fixes.",
    kind: "agent",
    target: "Mira"
  },
  {
    id: "pr-review",
    aliases: ["review-pr", "review"],
    label: "PR Review",
    description: "Run the PR review workflow on current local changes.",
    project: ".",
    task: "Review current changes and call out risks, regressions, missing tests, and recommended fixes.",
    kind: "workflow",
    target: "review-pr"
  },
  {
    id: "test-triage",
    aliases: ["debug-tests", "fix-tests"],
    label: "Test Triage",
    description: "Investigate test or CI failures.",
    project: ".",
    task: "Investigate test and CI failures. Identify failing areas, likely causes, and the next fix.",
    kind: "workflow",
    target: "debug-failure"
  },
  {
    id: "maintain-context",
    aliases: ["context", "refresh-context"],
    label: "Maintain Context",
    description: "Refresh durable project context and workflow memory.",
    project: ".",
    task: "Update durable project context, decisions, and workflow memory from the latest changes.",
    kind: "workflow",
    target: "maintain-context"
  },
  {
    id: "frontend-pass",
    aliases: ["frontend-review"],
    label: "Frontend Pass",
    description: "Ask the frontend specialist to review UI implementation risks.",
    project: ".",
    task: "Review the current frontend implementation and recommend focused UI, accessibility, and state-management fixes.",
    kind: "agent",
    target: "frontend"
  },
  {
    id: "production-readiness",
    aliases: ["prod-ready", "launch-check"],
    label: "Production Readiness",
    description: "Run a full production readiness check (frontend, security, site quality, summary).",
    project: ".",
    task: "Review production site readiness: frontend quality, security risks, SEO, mobile, and launch blockers.",
    kind: "workflow",
    target: "production-readiness"
  }
];
