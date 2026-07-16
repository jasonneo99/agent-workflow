import type { StageExecutionInput } from "./types.js";

export interface StageJsonArtifact {
  summary: string;
  findings: string[];
  nextAction: string;
  requestedCommands: string[];
  requestedFileWrites: Array<{
    path: string;
    content: string;
  }>;
}

export interface FileSummaryJsonArtifact {
  summary: string;
  keyFacts: string[];
  likelyUseWhen: string[];
}

export function buildStagePrompt(input: StageExecutionInput): string {
  return [
    `Workflow: ${input.workflowId}`,
    `Overall task: ${input.workflowTask}`,
    `Stage: ${input.stageId}`,
    `Stage goal: ${input.stageGoal}`,
    `Agent: ${input.agentName} (${input.agentId})`,
    "",
    "Agent instructions:",
    input.agentPrompt,
    "",
    "Project action policy:",
    formatActionPolicy(input.projectConfig),
    "",
    "Compiled project/workflow brief:",
    truncate(input.compiledBrief, 8000),
    "",
    "Prior stage receipts:",
    input.priorReceipts.length
      ? input.priorReceipts.map((receipt) => `- ${receipt.actionType} ${receipt.agentId}: ${receipt.summary}`).join("\n")
      : "None yet.",
    "",
    "Return JSON with:",
    "- summary: one or two sentences describing the stage result",
    "- findings: concrete observations, risks, or decisions",
    "- nextAction: the next useful workflow action",
    "- requestedCommands: exact commands from the allowed command policy only; do not use shell operators, pipes, redirects, variables, or command chaining; use [] when no command is necessary",
    "- requestedFileWrites: project-relative files under allowed write paths only, each with path and full content; use [] unless a file edit is necessary and keep content compact"
  ].join("\n");
}

export function buildFileSummaryPrompt(input: {
  sourceUri: string;
  deterministicSummary: string;
  content: string;
}): string {
  return [
    `File: ${input.sourceUri}`,
    "",
    "Deterministic summary:",
    input.deterministicSummary,
    "",
    "File content:",
    truncate(input.content, 12000)
  ].join("\n");
}

export function normalizeStageArtifact(value: Partial<StageJsonArtifact>): StageJsonArtifact {
  return {
    summary: typeof value.summary === "string" ? value.summary : "Stage completed.",
    findings: Array.isArray(value.findings) ? value.findings.filter((item): item is string => typeof item === "string") : [],
    nextAction: typeof value.nextAction === "string" ? value.nextAction : "",
    requestedCommands: Array.isArray(value.requestedCommands)
      ? value.requestedCommands.filter((item): item is string => typeof item === "string")
      : [],
    requestedFileWrites: Array.isArray(value.requestedFileWrites)
      ? value.requestedFileWrites
        .filter((item): item is { path: string; content: string } => Boolean(item) && typeof item.path === "string" && typeof item.content === "string")
      : []
  };
}

export function normalizeFileSummaryArtifact(value: Partial<FileSummaryJsonArtifact>): FileSummaryJsonArtifact {
  return {
    summary: typeof value.summary === "string" ? value.summary : "",
    keyFacts: Array.isArray(value.keyFacts) ? value.keyFacts.filter((item): item is string => typeof item === "string") : [],
    likelyUseWhen: Array.isArray(value.likelyUseWhen) ? value.likelyUseWhen.filter((item): item is string => typeof item === "string") : []
  };
}

export function extractJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Provider response did not contain a JSON object.");
    }
    return JSON.parse(text.slice(start, end + 1));
  }
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function formatActionPolicy(project: StageExecutionInput["projectConfig"]): string {
  return [
    `Allowed commands: ${project.actions.allowed_commands.join(" | ") || "none"}`,
    `Blocked commands: ${project.actions.blocked_commands.join(" | ") || "none"}`,
    `Allowed write paths: ${project.actions.allowed_write_paths.join(" | ") || "none"}`,
    `Blocked write paths: ${project.actions.blocked_write_paths.join(" | ") || "none"}`,
    `Command timeout: ${project.actions.command_timeout_ms}ms`,
    `Max write bytes: ${project.actions.max_write_bytes}`
  ].join("\n");
}
