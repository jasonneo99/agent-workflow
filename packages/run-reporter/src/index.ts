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
