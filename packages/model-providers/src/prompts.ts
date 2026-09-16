import type { StageExecutionInput, StageExecutionOutput } from "./types.js";

export interface StageJsonArtifact {
  outcome: "completed" | "blocked";
  blockedReason: string;
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
    input.stagePattern
      ? `Stage pattern: ${input.stagePattern.type}; promotion gate ${input.stagePattern.promotionGate}; verifier ${input.stagePattern.requiresVerifier ? "required" : "not required"}${input.stagePattern.maxIterations ? `; max iterations ${input.stagePattern.maxIterations}` : ""}`
      : "Stage pattern: executor",
    `Agent: ${input.agentName} (${input.agentId})`,
    "",
    "Agent instructions:",
    input.agentPrompt,
    "",
    "Project action policy:",
    formatActionPolicy(input.projectConfig),
    "",
    "Compiled project/workflow brief:",
    selectCompiledBriefForPrompt(input.compiledBrief, 8000),
    "",
    "Prior stage receipts:",
    input.priorReceipts.length
      ? input.priorReceipts.map((receipt) => `- ${receipt.actionType} ${receipt.agentId}: ${receipt.summary}`).join("\n")
      : "None yet.",
    "",
    "Prior stage artifacts (authoritative outputs from this run):",
    input.priorStageArtifacts?.length
      ? input.priorStageArtifacts.map((item) => [
        `### ${item.stageId} (${item.agentId})`,
        `Summary: ${item.summary}`,
        truncate(JSON.stringify(item.artifact), 4000)
      ].join("\n")).join("\n\n")
      : "None yet.",
    "",
    "Outcome rules:",
    "- Prior receipts and artifacts are historical evidence. Words such as blocked, failed, or could not inside a completed prior-stage artifact do not make the current stage blocked.",
    "- Do not claim project context is missing when the compiled brief or prior artifacts contain project-specific evidence. Use the available evidence and name any narrow verification gap as a finding.",
    "- A terminal blocker must identify the specific unavailable authority, external dependency, approval, or required input and explain why no allowed action or existing artifact can resolve it.",
    "",
    "Return JSON with:",
    "- outcome: completed when the stage goal was achieved or when requestedCommands/requestedFileWrites contain the bounded policy-allowed actions needed to finish it; blocked only when no requested action can resolve the missing context, authority, implementation, or verification",
    "- blockedReason: concise reason when outcome is blocked; otherwise an empty string",
    "- summary: one or two sentences describing the stage result",
    "- findings: concrete observations, risks, or decisions",
    "- nextAction: the next useful workflow action",
    "- requestedCommands: exact commands from the allowed command policy only; do not use shell operators, pipes, redirects, variables, or command chaining; use [] when no command is necessary",
    "- requestedFileWrites: project-relative files under allowed write paths only, each with path and full content; use [] unless a file edit is necessary and keep content compact"
  ].join("\n");
}

export function selectCompiledBriefForPrompt(compiledBrief: string, maxChars = 8000): string {
  const safeMax = Math.max(1000, maxChars);
  const completeMetadata = `Compiled brief selection metadata: strategy=section-budgeted; completeness=complete; originalChars=${compiledBrief.length}; promptBudget=${safeMax}`;
  if (compiledBrief.length + completeMetadata.length + 1 <= safeMax) {
    return `${completeMetadata}\n${compiledBrief}`;
  }

  const sentinelMatches = [...compiledBrief.matchAll(/^<!-- agentflow-section:([^\n]+) -->\n/gmu)];
  const matches = sentinelMatches.length ? sentinelMatches : [...compiledBrief.matchAll(/^## ([^\n]+)\n/gmu)];
  const preambleEnd = matches[0]?.index ?? compiledBrief.length;
  const preamble = compiledBrief.slice(0, preambleEnd).trim();
  const sections = new Map<string, string>();
  for (const [index, match] of matches.entries()) {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? compiledBrief.length;
    sections.set(match[1].trim(), compiledBrief.slice(start, end).trim());
  }

  const metadata = `Compiled brief selection metadata: strategy=section-budgeted; completeness=truncated; originalChars=${compiledBrief.length}; promptBudget=${safeMax}`;
  const allocations: Array<[string, number]> = [
    ["Exact Source Evidence", 3600],
    ["Project Context", 850],
    ["Indexed Source Summaries", 950],
    ["Action Policy", 650],
    ["Adaptive Preference Notes", 350],
    ["Applied Local Tuning Notes", 300],
    ["Workflow Stages", 450],
    ["Agent Instructions", 300]
  ];
  const selected: string[] = [metadata];
  let remaining = safeMax - metadata.length - 2;
  const append = (value: string, requested: number) => {
    if (!value || remaining < 160) return;
    const fragment = budgetBriefFragment(value, Math.min(requested, remaining));
    selected.push(fragment);
    remaining -= fragment.length + 2;
  };
  append(preamble, 650);
  for (const [name, budget] of allocations) append(sections.get(name) ?? "", budget);

  return selected.join("\n\n").slice(0, safeMax);
}

function budgetBriefFragment(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const newline = value.indexOf("\n");
  const label = newline >= 0 ? value.slice(0, newline) : "Brief fragment";
  const marker = `\nSelection metadata: completeness=truncated; includedChars=${maxChars}; originalChars=${value.length}; omittedChars=${Math.max(0, value.length - maxChars)}`;
  const available = Math.max(0, maxChars - marker.length);
  const content = value.slice(0, available).trimEnd();
  return `${content || label}${marker}`.slice(0, maxChars);
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
  const blockedReason = typeof value.blockedReason === "string" ? value.blockedReason.trim() : "";
  const summary = typeof value.summary === "string" ? value.summary : "Stage completed.";
  const explicitlyBlocked = value.outcome === "blocked";
  const legacyBlocked = value.outcome === undefined && /\b(blocked|could not|cannot proceed|no (?:changes|tests) (?:were )?(?:made|run|applied)|not supplied)\b/iu.test(`${summary} ${blockedReason}`);
  const requestedCommands = Array.isArray(value.requestedCommands)
    ? value.requestedCommands.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const requestedFileWrites = Array.isArray(value.requestedFileWrites)
    ? value.requestedFileWrites
      .filter((item): item is { path: string; content: string } => Boolean(item) && typeof item.path === "string" && item.path.trim().length > 0 && typeof item.content === "string")
    : [];
  const hasActionableRecovery = requestedCommands.length > 0 || requestedFileWrites.length > 0;
  const outcome = (explicitlyBlocked || legacyBlocked) && !hasActionableRecovery ? "blocked" : "completed";
  return {
    outcome,
    blockedReason: outcome === "blocked" ? (blockedReason || summary) : "",
    summary,
    findings: Array.isArray(value.findings) ? value.findings.filter((item): item is string => typeof item === "string") : [],
    nextAction: typeof value.nextAction === "string" ? value.nextAction : "",
    requestedCommands,
    requestedFileWrites
  };
}

export function buildStageExecutionOutput(input: StageExecutionInput, parsed: StageJsonArtifact, provider: Record<string, unknown>): StageExecutionOutput {
  return {
    outcome: parsed.outcome,
    blockedReason: parsed.blockedReason || undefined,
    summary: parsed.summary,
    requestedCommands: parsed.requestedCommands,
    requestedFileWrites: parsed.requestedFileWrites,
    artifact: {
      ...provider,
      runId: input.runId,
      taskId: input.taskId,
      workflowId: input.workflowId,
      workflowTask: input.workflowTask,
      stageId: input.stageId,
      agentId: input.agentId,
      agentName: input.agentName,
      stageGoal: input.stageGoal,
      findings: parsed.findings,
      nextAction: parsed.nextAction,
      outcome: parsed.outcome,
      blockedReason: parsed.blockedReason,
      requestedCommands: parsed.requestedCommands,
      requestedFileWrites: parsed.requestedFileWrites,
      summary: parsed.summary
    }
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
    if (start === -1) {
      throw new Error("Provider response did not contain a JSON object.");
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) return JSON.parse(text.slice(start, index + 1));
      }
    }
    throw new Error("Provider response did not contain a complete JSON object.");
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
