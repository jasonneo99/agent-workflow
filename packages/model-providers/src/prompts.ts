import type { StageExecutionInput, StageExecutionOutput } from "./types.js";
import { foldStateDeltas, renderFactSet } from "./state-deltas.js";

export interface StageJsonArtifact {
  outcome: "completed" | "blocked";
  blockedReason: string;
  summary: string;
  findings: string[];
  nextAction: string;
  requestedCommands: string[];
  requestedFileWrites: Array<{
    path: string;
    content?: string | null;
    patch?: string | null;
    expectedHash?: string | null;
  }>;
  requestedFileReads: string[];
}

export interface FileSummaryJsonArtifact {
  summary: string;
  keyFacts: string[];
  likelyUseWhen: string[];
}

export function buildStagePrompt(input: StageExecutionInput): string {
  const briefBudget = stageBriefBudget(input);
  const relevantArtifacts = selectPriorStageArtifacts(input);
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
    selectCompiledBriefForPrompt(input.compiledBrief, briefBudget, input.stageId),
    "",
    "Prior stage receipts:",
    input.priorReceipts.length
      ? input.priorReceipts.slice(-12).map((receipt) => `- ${receipt.actionType} ${receipt.agentId}: ${truncate(receipt.summary, 400)}`).join("\n")
      : "None yet.",
    "",
    "Prior stage artifacts (authoritative outputs from this run):",
    relevantArtifacts.length
      ? relevantArtifacts.map((item) => [
        `### ${item.stageId} (${item.agentId})`,
        `Summary: ${item.summary}`,
        truncate(JSON.stringify(item.artifact), 1800)
      ].join("\n")).join("\n\n")
      : "None yet.",
    "",
    "Runtime state (machine state deltas, folded; consume this instead of re-deriving history):",
    input.stateDeltas?.length ? renderFactSet(foldStateDeltas(input.stateDeltas)) : "No state changes recorded yet this stage.",
    "",
    "Relevant past context (from the memory graph; earlier stages and runs):",
    input.memoryContext?.length ? input.memoryContext.join("\n") : "None recorded yet.",
    "",
    "File contents you requested to read (fresh from disk this stage):",
    input.fileReads?.length
      ? input.fileReads.map((item) => [
        `### ${item.path}${item.truncated ? " (truncated at policy max)" : ""}${item.sha256 ? ` sha256:${item.sha256}` : ""}`,
        item.error ? `READ ERROR: ${item.error}` : item.content
      ].join("\n")).join("\n\n")
      : "None yet. Use requestedFileReads when you need to inspect source before acting.",
    "",
    "Outcome rules:",
    "- PINNED KEYWORD CONTRACT: BUILD means create, verify, package, and deliver a usable product. Never reinterpret BUILD as analyze, plan, document, recommend, prototype-only, or hand off.",
    "- When the task contains the standalone word BUILD, every downstream stage must preserve that delivery intent. If product creation or verification evidence is absent, return blocked; do not describe the run as complete.",
    "- The overall task is the user acceptance contract. If it asks to build, implement, create, deliver, or ship a product, planning, inspection, documentation, or packaging alone is not completion.",
    "- An implementation or finalizer stage must return blocked when required product changes or verification are still absent and no policy-allowed requested action will produce them.",
    "- The model provider sandbox is intentionally read-only and is never itself a blocker. Do not attempt direct mutation or report that the sandbox prevented implementation; express every allowed edit through requestedFileWrites and every allowed verification through requestedCommands so the governed executor can apply them.",
    "- Preserve unrelated dirty work. A dirty worktree is not itself a blocker. Stop only when an intended file overlaps an existing change whose ownership or intended baseline is uncertain, or when a conflicting project-scoped work intent exists. If the task explicitly accepts the current worktree as its baseline, inspect the exact preimage and merge surgically instead of blocking. Leave unrelated files untouched.",
    "- Structured requests are the executable contract. Never say that a read, write, or command was requested unless its exact path or command is present in requestedFileReads, requestedFileWrites, or requestedCommands in the same response.",
    "- Prior receipts and artifacts are historical evidence. Words such as blocked, failed, or could not inside a completed prior-stage artifact do not make the current stage blocked.",
    "- Do not claim project context is missing when the compiled brief or prior artifacts contain project-specific evidence. Use the available evidence and name any narrow verification gap as a finding.",
    "- Review, audit, and advisory stages must report missing implementation proof or incomplete acceptance evidence as findings with recommended follow-up. Those evidence gaps do not block the review itself; block only for a real unavailable authority, external dependency, approval, or required input that prevents producing any useful review result.",
    "- Analytical questions that ask you to define, explain, compare, classify, or recommend policy are completed when you return the requested decision and evidence boundaries. The fact that analysis requires judgment is not itself an approval blocker; do not block merely because a policy decision cannot be automated.",
    "- Distinguish implementing a consent gate from exercising the gated authority. A task that asks to add a flow which asks a human before a purchase, paid-provider call, secret use, deployment, or other external action authorizes policy-allowed local implementation and tests of that gate; it does not authorize the eventual external action.",
    "- For consent-gated features, preserve fail-closed behavior: present the exact action, provider/target, amount or bounded scope, and consequences; accept an explicit affirmative decision through the product's authenticated text or voice channel; record an auditable decision; execute at most the approved action; and require a new decision when material terms change. Never treat a request to build this mechanism as approval to perform the transaction.",
    "- A terminal blocker must identify the specific unavailable authority, external dependency, approval, or required input and explain why no allowed action or existing artifact can resolve it.",
    "",
    "Return JSON with:",
    "- outcome: completed when the stage goal was achieved or when requestedCommands/requestedFileWrites/requestedFileReads contain the bounded policy-allowed actions needed to finish it; blocked only when no requested action can resolve the missing context, authority, implementation, or verification",
    "- blockedReason: concise reason when outcome is blocked; otherwise an empty string",
    "- summary: one or two sentences describing the stage result",
    "- findings: concrete observations, risks, or decisions",
    "- nextAction: the next useful workflow action",
    "- requestedCommands: exact commands from the allowed command policy only; do not use shell operators, pipes, redirects, variables, or command chaining; use [] when no command is necessary",
    "- requestedFileWrites: project-relative files under allowed write paths only. For a compact or new file, provide path and full content, with patch/expectedHash null. For a surgical edit to a large existing file, provide path, a unified-diff patch containing @@ hunks, and the SHA-256 expectedHash of the exact preimage, with content null. Never provide both content and patch. Use [] unless an edit is necessary",
    "- requestedFileReads: project-relative files to inspect, under allowed read paths only; files you list here are read and shown to you, then you are asked again so you can act on what you read; request reads first whenever you need source context instead of guessing; use [] when no inspection is needed"
  ].join("\n");
}

export function selectCompiledBriefForPrompt(compiledBrief: string, maxChars = 8000, stageId = ""): string {
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
  const implementationStage = /implement|fix|frontend|backend|database/iu.test(stageId);
  const verificationStage = /verify|test|review|package/iu.test(stageId);
  const allocations: Array<[string, number]> = [
    ["Exact Source Evidence", implementationStage ? 2600 : verificationStage ? 1100 : 1500],
    ["Project Context", 650],
    ["Indexed Source Summaries", implementationStage ? 750 : 450],
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

function stageBriefBudget(input: StageExecutionInput): number {
  if (/implement|fix|frontend|backend|database/iu.test(input.stageId)) return 6000;
  if (/plan|architecture|security/iu.test(input.stageId)) return 4800;
  if (/verify|test|review/iu.test(input.stageId)) return 3600;
  return 2800;
}

function selectPriorStageArtifacts(input: StageExecutionInput): NonNullable<StageExecutionInput["priorStageArtifacts"]> {
  const artifacts = input.priorStageArtifacts ?? [];
  if (artifacts.length <= 2) return artifacts;
  const preferred = /verify|test|package|document/iu.test(input.stageId)
    ? artifacts.filter((item) => /implement|fix|verify|test/iu.test(item.stageId))
    : artifacts;
  return preferred.slice(-2);
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
      .filter((item): item is { path: string; content?: string | null; patch?: string | null; expectedHash?: string | null } => {
        if (!item || typeof item.path !== "string" || !item.path.trim()) return false;
        const content = typeof item.content === "string";
        const patch = typeof item.patch === "string" && typeof item.expectedHash === "string";
        return content !== patch;
      })
    : [];
  const requestedFileReads = Array.isArray(value.requestedFileReads)
    ? value.requestedFileReads
      .map((item): string | null => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string") {
          return String((item as { path: string }).path).trim();
        }
        return null;
      })
      .filter((item): item is string => Boolean(item && item.length > 0))
    : [];
  const hasActionableRecovery = requestedCommands.length > 0 || requestedFileWrites.length > 0 || requestedFileReads.length > 0;
  const outcome = (explicitlyBlocked || legacyBlocked) && !hasActionableRecovery ? "blocked" : "completed";
  return {
    outcome,
    blockedReason: outcome === "blocked" ? (blockedReason || summary) : "",
    summary,
    findings: Array.isArray(value.findings) ? value.findings.filter((item): item is string => typeof item === "string") : [],
    nextAction: typeof value.nextAction === "string" ? value.nextAction : "",
    requestedCommands,
    requestedFileWrites,
    requestedFileReads
  };
}

export function buildStageExecutionOutput(input: StageExecutionInput, parsed: StageJsonArtifact, provider: Record<string, unknown>): StageExecutionOutput {
  const evidenceGapFinding = reviewEvidenceGapIsFinding(input, parsed) || advisoryPolicyAnalysisIsFinding(input, parsed);
  const outcome = evidenceGapFinding ? "completed" : parsed.outcome;
  const blockedReason = evidenceGapFinding ? "" : parsed.blockedReason;
  return {
    outcome,
    blockedReason: blockedReason || undefined,
    summary: parsed.summary,
    requestedCommands: parsed.requestedCommands,
    requestedFileWrites: parsed.requestedFileWrites,
    requestedFileReads: parsed.requestedFileReads,
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
      outcome,
      blockedReason,
      evidenceGapReclassifiedAsFinding: evidenceGapFinding,
      requestedCommands: parsed.requestedCommands,
      requestedFileWrites: parsed.requestedFileWrites,
      requestedFileReads: parsed.requestedFileReads,
      summary: parsed.summary
    }
  };
}

export function advisoryPolicyAnalysisIsFinding(input: StageExecutionInput, parsed: StageJsonArtifact): boolean {
  if (parsed.outcome !== "blocked" || input.workflowId !== "provider-smoke") return false;
  if (parsed.requestedCommands.length || parsed.requestedFileWrites.length || parsed.requestedFileReads.length) return false;
  const task = `${input.workflowTask} ${input.stageGoal}`;
  if (!/\b(?:define|explain|compare|classify|recommend|describe)\b/iu.test(task)) return false;
  const reason = `${parsed.blockedReason} ${parsed.summary}`;
  const judgmentOnly = /(?:policy|decision|criteria|rules?|boundar(?:y|ies)).*(?:cannot be automated|additional context|human (?:review|decision)|decision-making)/iu.test(reason)
    || /(?:cannot be automated|decision-making).*(?:policy|decision|criteria|rules?|boundar(?:y|ies))/iu.test(reason);
  const concreteBlocker = /(?:deployment|production|external action|protected resource) approval (?:is )?required|permission (?:is )?(?:denied|required)|credential|authentication|provider outage|network unavailable|external dependency/iu.test(reason);
  return judgmentOnly && !concreteBlocker;
}

export function reviewEvidenceGapIsFinding(input: StageExecutionInput, parsed: StageJsonArtifact): boolean {
  if (parsed.outcome !== "blocked") return false;
  const reviewStage = input.workflowId === "review-pr"
    || input.workflowId === "security-audit"
    || input.workflowId === "accessibility-review"
    || input.workflowId.startsWith("agent-task-ux-reviewer")
    || ["ux-reviewer", "security-reviewer", "pr-preparer"].includes(input.agentId)
    || /(?:^|[-_])(?:review|audit|inspect)(?:$|[-_])/iu.test(input.stageId);
  if (!reviewStage) return false;
  const reason = `${parsed.blockedReason} ${parsed.summary}`;
  const evidenceGap = /(?:missing|insufficient|lacks?|no) (?:implementation |project |product |acceptance |verification )?(?:evidence|proof|context)|evidence .* (?:missing|insufficient|absent|unproven)|implementation .* (?:incomplete|absent|unproven)|no (?:specific )?platform(?:-specific)? guidance|(?:platform(?:-specific)? guidance|design system) .* (?:not provided|missing|absent|unavailable)/iu.test(reason);
  const realExternalBlocker = /(?:approval|permission|credential|authentication|quota|provider outage|network unavailable|external dependency|authority) (?:is |was )?(?:required|missing|unavailable|denied|exhausted)/iu.test(reason);
  return evidenceGap && !realExternalBlocker;
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
  const actions = project.actions as Partial<StageExecutionInput["projectConfig"]["actions"]>;
  const list = (value: string[] | undefined): string => value?.join(" | ") || "none";
  return [
    `Allowed commands: ${list(actions.allowed_commands)}`,
    `Blocked commands: ${list(actions.blocked_commands)}`,
    `Allowed write paths: ${list(actions.allowed_write_paths)}`,
    `Blocked write paths: ${list(actions.blocked_write_paths)}`,
    `Allowed read paths: ${list(actions.allowed_read_paths)}`,
    `Blocked read paths: ${list(actions.blocked_read_paths)}`,
    `Command timeout: ${actions.command_timeout_ms ?? 0}ms`,
    `Max write bytes: ${actions.max_write_bytes ?? 0}`,
    `Max read bytes: ${actions.max_read_bytes ?? 0}`
  ].join("\n");
}
