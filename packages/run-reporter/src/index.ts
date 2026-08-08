import type {
  ActionReceiptStatus,
  ArtifactStatus,
  WorkflowRunStatus,
  WorkflowTaskStatus
} from "../../storage/src/postgres.js";

export interface RunExportInput {
  run: WorkflowRunStatus;
  tasks: WorkflowTaskStatus[];
  receipts: ActionReceiptStatus[];
  artifacts: ArtifactStatus[];
}

export interface RunExportDocument {
  markdown: string;
  json: Record<string, unknown>;
}

export interface CostQualityReport {
  runId: string;
  workflowId: string;
  task: string;
  status: string;
  projectName: string;
  totalStages: number;
  routedStages: number;
  fallbackCount: number;
  qualityPassCount: number;
  qualityFailCount: number;
  averageQuality: number | null;
  totalLatencyMs: number;
  averageLatencyMs: number | null;
  estimatedCostMix: Record<string, number>;
  providerMix: Record<string, number>;
  modelTierMix: Record<string, number>;
  estimatedByoSavingsStages: number;
  stages: CostQualityStage[];
  recommendations: string[];
}

export interface CostQualityStage {
  stageId: string;
  agentId: string;
  providerId: string;
  model?: string;
  modelTier: string;
  estimatedCostTier: string;
  qualityScore: number | null;
  qualityPassed: boolean | null;
  fallbackUsed: boolean;
  fallbackProviderId?: string;
  latencyMs: number | null;
  reasons: string[];
}

export function buildRunExport(input: RunExportInput): RunExportDocument {
  const stageOutputs = input.artifacts.filter((artifact) => artifact.kind === "stage_output");
  const commandOutputs = input.artifacts.filter((artifact) => artifact.kind === "command_output");
  const fileWrites = input.artifacts.filter((artifact) => artifact.kind === "file_write");
  const actionRejections = input.artifacts.filter((artifact) => artifact.kind === "action_rejection");

  const markdown = [
    `# Workflow Run ${input.run.id}`,
    "",
    "## Summary",
    `- Status: ${input.run.status}`,
    `- Workflow: ${input.run.workflowId}`,
    `- Task: ${input.run.task}`,
    `- Project: ${input.run.projectName}`,
    `- Project root: ${input.run.projectRootUri}`,
    `- Autonomy: ${input.run.autonomy}`,
    `- Started: ${input.run.startedAt}`,
    `- Finished: ${input.run.finishedAt ?? "not finished"}`,
    "",
    "## Stages",
    input.tasks.length
      ? input.tasks.map((task) => `- ${task.stageId}: ${task.agentId} ${task.status} attempts=${task.attempts}`).join("\n")
      : "_No stages recorded._",
    "",
    "## Receipts",
    input.receipts.length
      ? input.receipts.map((receipt) => [
        `- ${receipt.actionType} ${receipt.agentId}`,
        `  - Target: ${receipt.target}`,
        `  - Summary: ${receipt.summary}`,
        `  - Created: ${receipt.createdAt}`
      ].join("\n")).join("\n")
      : "_No receipts recorded._",
    "",
    "## Stage Outputs",
    stageOutputs.length
      ? stageOutputs.map(formatStageOutput).join("\n\n")
      : "_No stage output artifacts recorded._",
    "",
    "## Command Outputs",
    commandOutputs.length
      ? commandOutputs.map(formatCommandOutput).join("\n\n")
      : "_No command output artifacts recorded._",
    "",
    "## File Writes",
    fileWrites.length
      ? fileWrites.map(formatFileWrite).join("\n\n")
      : "_No file write artifacts recorded._",
    "",
    "## Action Rejections",
    actionRejections.length
      ? actionRejections.map(formatActionRejection).join("\n\n")
      : "_No action rejections recorded._",
    "",
    "## Artifacts",
    input.artifacts.length
      ? input.artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.uri}`).join("\n")
      : "_No artifacts recorded._",
    ""
  ].join("\n");

  return {
    markdown,
    json: {
      exportedAt: new Date().toISOString(),
      run: input.run,
      tasks: input.tasks,
      receipts: input.receipts,
      artifacts: input.artifacts
    }
  };
}

export function buildCostQualityReport(input: RunExportInput): CostQualityReport {
  const routeArtifacts = input.artifacts.filter((artifact) => artifact.kind === "model_route");
  const stageOutputArtifacts = input.artifacts.filter((artifact) => artifact.kind === "stage_output");
  const stageOutputByKey = new Map(
    stageOutputArtifacts.map((artifact) => {
      const stageId = stringValue(artifact.content.stageId, "");
      const agentId = stringValue(artifact.content.agentId, "");
      return [`${stageId}:${agentId}`, artifact];
    })
  );

  const stages = routeArtifacts.map((artifact): CostQualityStage => {
    const route = objectValue(artifact.content.route);
    const quality = objectValue(artifact.content.quality);
    const target = stringValue(artifact.content.target, "");
    const targetStage = target.includes("/") ? target.split("/").at(-1) ?? target : target;
    const agentId = stringValue(artifact.content.agentId, "");
    const stageId = stringValue(artifact.content.stageId, targetStage);
    const stageArtifact = stageOutputByKey.get(`${stageId}:${agentId}`);
    const fallbackProviderId = stringValue(artifact.content.fallbackProviderId, "");

    return {
      stageId,
      agentId,
      providerId: stringValue(route.providerId, "unknown"),
      model: stageArtifact ? stringValue(stageArtifact.content.model, "") || undefined : undefined,
      modelTier: stringValue(route.modelTier, "standard"),
      estimatedCostTier: stringValue(route.estimatedCostTier, "unknown"),
      qualityScore: numberValue(quality.score),
      qualityPassed: booleanValue(quality.passed),
      fallbackUsed: booleanValue(artifact.content.fallbackUsed) ?? false,
      fallbackProviderId: fallbackProviderId || undefined,
      latencyMs: numberValue(artifact.content.latencyMs),
      reasons: arrayOfStrings(quality.reasons)
    };
  });

  const scoredStages = stages.filter((stage) => stage.qualityScore !== null);
  const latencyStages = stages.filter((stage) => stage.latencyMs !== null);
  const qualityPassCount = stages.filter((stage) => stage.qualityPassed === true).length;
  const qualityFailCount = stages.filter((stage) => stage.qualityPassed === false).length;
  const totalLatencyMs = latencyStages.reduce((sum, stage) => sum + (stage.latencyMs ?? 0), 0);
  const estimatedByoSavingsStages = stages.filter((stage) =>
    ["byo", "openai-compatible", "mock"].includes(stage.providerId) &&
    ["low", "medium", "none"].includes(stage.estimatedCostTier)
  ).length;

  return {
    runId: input.run.id,
    workflowId: input.run.workflowId,
    task: input.run.task,
    status: input.run.status,
    projectName: input.run.projectName,
    totalStages: input.tasks.length,
    routedStages: stages.length,
    fallbackCount: stages.filter((stage) => stage.fallbackUsed).length,
    qualityPassCount,
    qualityFailCount,
    averageQuality: scoredStages.length
      ? round(scoredStages.reduce((sum, stage) => sum + (stage.qualityScore ?? 0), 0) / scoredStages.length)
      : null,
    totalLatencyMs,
    averageLatencyMs: latencyStages.length ? Math.round(totalLatencyMs / latencyStages.length) : null,
    estimatedCostMix: countBy(stages, (stage) => stage.estimatedCostTier),
    providerMix: countBy(stages, (stage) => stage.providerId),
    modelTierMix: countBy(stages, (stage) => stage.modelTier),
    estimatedByoSavingsStages,
    stages,
    recommendations: recommendCostQualityActions(stages, input.run.status)
  };
}

export function formatCostQualityReport(report: CostQualityReport): string {
  return [
    `Cost & Quality Report: ${report.runId}`,
    `Status: ${report.status}`,
    `Workflow: ${report.workflowId}`,
    `Project: ${report.projectName}`,
    `Task: ${report.task}`,
    "",
    "Summary",
    `- Routed stages: ${report.routedStages}/${report.totalStages}`,
    `- Average quality: ${report.averageQuality ?? "n/a"}`,
    `- Quality pass/fail: ${report.qualityPassCount}/${report.qualityFailCount}`,
    `- Fallbacks used: ${report.fallbackCount}`,
    `- Total latency: ${report.totalLatencyMs}ms`,
    `- Estimated BYO/local savings stages: ${report.estimatedByoSavingsStages}`,
    `- Provider mix: ${formatCounts(report.providerMix)}`,
    `- Cost mix: ${formatCounts(report.estimatedCostMix)}`,
    `- Tier mix: ${formatCounts(report.modelTierMix)}`,
    "",
    "Stages",
    report.stages.length
      ? report.stages.map((stage) => [
        `- ${stage.stageId}: ${stage.agentId}`,
        `  - Provider: ${stage.providerId}${stage.model ? ` / ${stage.model}` : ""}`,
        `  - Tier: ${stage.modelTier}, cost=${stage.estimatedCostTier}, quality=${stage.qualityScore ?? "n/a"}`,
        `  - Fallback: ${stage.fallbackUsed ? stage.fallbackProviderId ?? "yes" : "no"}, latency=${stage.latencyMs ?? "n/a"}ms`,
        stage.reasons.length ? `  - Notes: ${stage.reasons.join("; ")}` : ""
      ].filter(Boolean).join("\n")).join("\n")
      : "- No model routing receipts found.",
    "",
    "Recommendations",
    report.recommendations.map((item) => `- ${item}`).join("\n")
  ].join("\n");
}

function formatStageOutput(artifact: ArtifactStatus): string {
  const content = artifact.content;
  return [
    `### ${stringValue(content.stageId, artifact.taskId ?? artifact.id)} - ${stringValue(content.agentName, stringValue(content.agentId, "unknown agent"))}`,
    `- Artifact: ${artifact.uri}`,
    `- Summary: ${stringValue(content.summary, "No summary.")}`,
    formatStringArray("Findings", content.findings),
    stringValue(content.nextAction, "") ? `- Next action: ${stringValue(content.nextAction, "")}` : "",
    formatStringArray("Requested commands", content.requestedCommands),
    formatFileWriteRequests(content.requestedFileWrites)
  ].filter(Boolean).join("\n");
}

function formatCommandOutput(artifact: ArtifactStatus): string {
  const content = artifact.content;
  return [
    `### ${stringValue(content.commandLine, artifact.uri)}`,
    `- Artifact: ${artifact.uri}`,
    `- Exit code: ${stringValue(content.exitCode, "unknown")}`,
    `- Timed out: ${stringValue(content.timedOut, "unknown")}`,
    `- Duration ms: ${stringValue(content.durationMs, "unknown")}`,
    stringValue(content.stdout, "") ? fenced("stdout", stringValue(content.stdout, "")) : "",
    stringValue(content.stderr, "") ? fenced("stderr", stringValue(content.stderr, "")) : ""
  ].filter(Boolean).join("\n");
}

function formatFileWrite(artifact: ArtifactStatus): string {
  const content = artifact.content;
  return [
    `### ${stringValue(content.relativePath, artifact.uri)}`,
    `- Artifact: ${artifact.uri}`,
    `- Existed: ${stringValue(content.existed, "unknown")}`,
    `- Bytes written: ${stringValue(content.bytesWritten, "unknown")}`,
    `- Previous hash: ${stringValue(content.previousHash, "none")}`,
    `- Next hash: ${stringValue(content.nextHash, "unknown")}`
  ].join("\n");
}

function formatActionRejection(artifact: ArtifactStatus): string {
  const content = artifact.content;
  return [
    `### ${stringValue(content.actionType, "action")} rejected`,
    `- Artifact: ${artifact.uri}`,
    `- Target: ${stringValue(content.target, "unknown")}`,
    `- Error: ${stringValue(content.error, "unknown")}`
  ].join("\n");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item) || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(", ") : "none";
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function recommendCostQualityActions(stages: CostQualityStage[], status: string): string[] {
  const recommendations: string[] = [];
  const weakStages = stages.filter((stage) => stage.qualityPassed === false || (stage.qualityScore !== null && stage.qualityScore < 0.7));
  const fallbackStages = stages.filter((stage) => stage.fallbackUsed);
  const highCostStages = stages.filter((stage) => stage.estimatedCostTier === "high");

  if (!stages.length) {
    recommendations.push("Run a workflow with adaptive routing enabled to collect model_route receipts.");
  }
  if (weakStages.length) {
    recommendations.push(`Review ${weakStages.length} weak stage output(s) and tune prompts, context budget, or model tier for those agents.`);
  }
  if (fallbackStages.length) {
    recommendations.push(`Inspect ${fallbackStages.length} fallback stage(s); repeated fallback usage means the primary provider is underpowered for that work.`);
  }
  if (highCostStages.length && highCostStages.length === stages.length) {
    recommendations.push("Move fast or standard stages to BYO/local providers to reduce cost without using reasoning models for every stage.");
  }
  if (status === "failed") {
    recommendations.push("Use the failed stage and quality notes to run debug-failure before retrying the full workflow.");
  }
  if (!recommendations.length) {
    recommendations.push("Routing looks healthy. Keep this mix and compare future runs for latency and fallback drift.");
  }

  return recommendations;
}

function formatStringArray(label: string, value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "";
  }
  const items = value.filter((item): item is string => typeof item === "string");
  if (!items.length) {
    return "";
  }
  return [`- ${label}:`, ...items.map((item) => `  - ${item}`)].join("\n");
}

function formatFileWriteRequests(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "";
  }
  const items = value
    .filter((item): item is { path: string; content: string } => Boolean(item) && typeof item.path === "string")
    .map((item) => `  - ${item.path}`);
  if (!items.length) {
    return "";
  }
  return ["- Requested file writes:", ...items].join("\n");
}

function fenced(label: string, value: string): string {
  return [
    `- ${label}:`,
    "```text",
    value.trim(),
    "```"
  ].join("\n");
}

function stringValue(value: unknown, fallback: string): string {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}
