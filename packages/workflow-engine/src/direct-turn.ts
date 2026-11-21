import { createHash } from "node:crypto";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import { selectRelevantSourceSummaries } from "../../context-selector/src/index.js";
import { executeAllowedFileRead } from "../../local-tools/src/file-reader.js";
import {
  executeWithProviderFallback,
  providerFallbackPolicyFromEnv,
  providerFromEnv
} from "../../model-providers/src/index.js";
import type { StageExecutionOutput } from "../../model-providers/src/types.js";
import { resolveExecutionPolicy } from "../../policy-engine/src/index.js";
import { listProjectFileSummaries } from "../../storage/src/postgres.js";
import { executeDevTurnActions } from "./dev-turn-actions.js";
import {
  addDevSessionTurn,
  appendDevSessionReceipt,
  getDevSession,
  listApprovedDevSessionApprovals,
  listDevSessionTurns,
  updateDevSessionTurn,
  type DevSession
} from "../../storage/src/dev-sessions.js";

/**
 * Direct agent turns for Dev mode.
 *
 * One user message = one bounded agent turn. This deliberately bypasses
 * the queue path: no per-message run creation, no 6-stage graph, no worker
 * claim/lease, no plan/package promotion gates. It keeps the policy engine,
 * receipts, hard-action approvals, provider routing/fallback, and project
 * indexing (light context only — open files plus relevant indexed summaries,
 * never the full run brief).
 *
 * The provider contract (`ModelProvider.executeStage`) is not streaming, so
 * token events are the completed text re-emitted in bounded chunks for the
 * SSE channel. A true token-streaming provider contract is future work, not
 * something this milestone invents per provider.
 */

export const DEV_MODE_AGENT_ID = "dev-mode-agent";
export const DEV_MODE_AGENT_NAME = "Dev mode agent";
export const DEV_MODE_WORKFLOW_ID = "dev-mode";
export const DEV_MODE_STAGE_ID = "dev-turn";
export const DEV_MODE_MAX_ITERATIONS = 6;
export const DEV_MODE_MAX_OPEN_FILES = 8;
export const DEV_MODE_MAX_TOKENS = 120_000;

export type DevTurnEvent =
  | { type: "turn_started"; turnId: string; sessionId: string }
  | { type: "token"; turnId: string; text: string }
  | { type: "tool_call"; turnId: string; tool: string; target: string; status: string; detail?: string }
  | { type: "diff_proposed"; turnId: string; path: string; diffId: string }
  | { type: "turn_awaiting_approval"; turnId: string; approvalId: string; actionType: string; target: string; reason: string }
  | { type: "turn_completed"; turnId: string; summary: string; usage?: StageExecutionOutput["usage"] }
  | { type: "turn_failed"; turnId: string; error: string };

export interface DevTurnDeferredAction {
  kind: "command" | "file_write" | "file_read" | "file_search";
  target: string;
  status: "deferred" | "executed" | "rejected" | "awaiting_approval";
  detail?: string;
}

export interface DevTurnResult {
  turnId: string;
  assistantTurnId: string;
  summary: string;
  usage?: StageExecutionOutput["usage"];
  iterations: number;
  deferredActions: DevTurnDeferredAction[];
  diffIds: string[];
  stoppedReason: "completed" | "max_iterations" | "token_budget" | "awaiting_approval";
  awaitingApproval?: { approvalId: string; actionType: string; target: string; reason: string };
}

export interface RunDirectTurnInput {
  session: DevSession;
  projectDir: string;
  project: ProjectConfig;
  message: string;
  openFiles?: string[];
  providerId?: string;
  modelOverride?: string;
  /** Bounded ReAct iterations (default 1; the message route uses DEV_MODE_MAX_ITERATIONS). */
  maxIterations?: number;
  /** When true, requested reads/commands run and file writes become proposed diffs. */
  toolsEnabled?: boolean;
  /** Approved hard actions for this turn (by "actionType:target"), set after an inline approval. */
  approvedActions?: string[];
  onEvent: (event: DevTurnEvent) => void | Promise<void>;
  abortSignal?: AbortSignal;
}

const DEV_AGENT_PROMPT = [
  "You are the Dev mode agent working directly with the owner in their editor.",
  "Answer the request directly and concisely.",
  "To read a file, list it in requestedFileReads.",
  "To run a command, list it in requestedCommands.",
  "To change a file, list it in requestedFileWrites with the full new content, or a unified patch plus the expectedHash of the current file.",
  "Never apply changes yourself: edits are proposed as diffs and applied only when the owner accepts them, per file and per hunk.",
  "Never run push, deploy, external sends, or destructive commands; those need the owner's explicit approval and will pause the turn."
].join("\n");

/** Split completed provider text into bounded chunks for SSE token events. */
export function chunkTextForStreaming(text: string, maxChars = 400): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars / 2) cut = rest.lastIndexOf(" ", maxChars);
    if (cut <= 0) cut = maxChars;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/u, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function buildDevTurnBrief(input: {
  projectDir: string;
  message: string;
  openFiles: string[];
  openFileReads: Array<{ path: string; content: string; truncated: boolean; error?: string }>;
  priorTurns: Array<{ role: string; content: string }>;
  indexedSummaries: Array<{ sourceUri: string; summary: string }>;
  toolResults: string[];
}): string {
  const sections: string[] = [
    `Project: ${input.projectDir}`,
    `Request: ${input.message}`
  ];
  if (input.priorTurns.length) {
    sections.push(
      `Recent conversation:\n${input.priorTurns
        .map((turn) => `${turn.role === "user" ? "Owner" : "Agent"}: ${turn.content}`)
        .join("\n")}`
    );
  }
  if (input.indexedSummaries.length) {
    sections.push(
      `Relevant indexed sources:\n${input.indexedSummaries
        .map((summary) => `- ${summary.sourceUri}: ${summary.summary}`)
        .join("\n")}`
    );
  }
  if (input.openFileReads.length) {
    sections.push(
      `Open files:\n${input.openFileReads
        .map((file) =>
          file.error
            ? `--- ${file.path} (could not be read: ${file.error})`
            : `--- ${file.path}${file.truncated ? " (truncated)" : ""}\n${file.content}`
        )
        .join("\n")}`
    );
  }
  if (input.toolResults.length) {
    sections.push(`Tool results so far:\n${input.toolResults.join("\n")}`);
  }
  return sections.join("\n\n");
}

async function readOpenFiles(input: {
  projectDir: string;
  project: ProjectConfig;
  openFiles: string[];
}): Promise<Array<{ path: string; content: string; truncated: boolean; error?: string }>> {
  const reads: Array<{ path: string; content: string; truncated: boolean; error?: string }> = [];
  for (const relativePath of input.openFiles.slice(0, DEV_MODE_MAX_OPEN_FILES)) {
    try {
      const result = await executeAllowedFileRead({ relativePath, cwd: input.projectDir, project: input.project });
      reads.push({ path: result.relativePath, content: result.content, truncated: result.truncated });
    } catch (error) {
      reads.push({
        path: relativePath,
        content: "",
        truncated: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return reads;
}

/**
 * Light context: relevant summaries from the existing project index, ranked
 * by the context selector. Never re-indexes and never builds a run brief.
 * Returns [] when the project has no index state yet.
 */
export async function selectIndexedContext(input: {
  projectDir: string;
  project: ProjectConfig;
  message: string;
}): Promise<Array<{ sourceUri: string; summary: string }>> {
  try {
    const summaries = await listProjectFileSummaries({ projectRootUri: input.projectDir, limit: 200 });
    if (!summaries.length) return [];
    const ranked = selectRelevantSourceSummaries({
      task: input.message,
      project: input.project,
      workflow: {
        id: DEV_MODE_WORKFLOW_ID,
        name: "Dev mode direct turn",
        description: "Direct agent turn without a queued workflow.",
        stages: []
      } as unknown as Parameters<typeof selectRelevantSourceSummaries>[0]["workflow"],
      agents: [],
      summaries: summaries.map((file) => ({
        sourceUri: file.sourceUri,
        tokenEstimate: file.tokenEstimate ?? 0,
        summary: file.summary ?? ""
      })),
      maxTokens: 2000,
      maxFiles: 8
    });
    return ranked.map((item) => ({ sourceUri: item.sourceUri, summary: item.summary }));
  } catch {
    return [];
  }
}

export async function runDirectTurn(input: RunDirectTurnInput): Promise<DevTurnResult> {
  const session = input.session;
  const providerId = input.providerId ?? session.provider ?? process.env.DEFAULT_MODEL_PROVIDER ?? "mock";
  const maxIterations = Math.max(1, Math.min(input.maxIterations ?? 1, DEV_MODE_MAX_ITERATIONS));
  const toolsEnabled = input.toolsEnabled ?? false;

  // Direct turns run under trusted-personal: ordinary dev pre-approved,
  // hard gates unchanged. Resolution also snapshots the effective config
  // for the turn receipt. Previously approved one-time actions for this
  // session (approved inline, not yet consumed) join the caller-supplied set.
  const resolvedPolicy = resolveExecutionPolicy(input.project, "trusted-personal");
  const project = resolvedPolicy.project;
  const approvedActions = new Map<string, string | undefined>(
    (input.approvedActions ?? []).map((key) => [key, undefined])
  );
  for (const approval of await listApprovedDevSessionApprovals(session.id)) {
    approvedActions.set(`${approval.actionType}:${approval.target}`, approval.id);
  }
  const tokenBudget = Math.max(
    1_000,
    Number(process.env.AGENTFLOW_DEV_TURN_TOKEN_BUDGET ?? DEV_MODE_MAX_TOKENS) || DEV_MODE_MAX_TOKENS
  );

  const userTurn = await addDevSessionTurn({
    sessionId: session.id,
    role: "user",
    content: input.message,
    status: "completed"
  });
  const assistantTurn = await addDevSessionTurn({
    sessionId: session.id,
    role: "assistant",
    content: "",
    status: "running",
    provider: providerId,
    model: input.modelOverride ?? session.model
  });
  const turnId = assistantTurn.id;
  await appendDevSessionReceipt({
    sessionId: session.id,
    turnId,
    agentId: DEV_MODE_AGENT_ID,
    actionType: "dev_turn_started",
    target: userTurn.id,
    summary: `Dev turn started for message ${userTurn.id.slice(0, 8)}.`,
    metadata: {
      provider: providerId,
      model: input.modelOverride ?? session.model ?? null,
      maxIterations,
      toolsEnabled,
      policyProfile: resolvedPolicy.profile,
      policySnapshotHash: resolvedPolicy.snapshotHash
    }
  });
  await input.onEvent({ type: "turn_started", turnId, sessionId: session.id });

  const priorTurns = (await listDevSessionTurns(session.id))
    .filter((turn) => turn.id !== assistantTurn.id)
    .slice(-6)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 2000) }));
  const openFileReads = await readOpenFiles({
    projectDir: input.projectDir,
    project,
    openFiles: input.openFiles ?? []
  });
  const indexedSummaries = await selectIndexedContext({
    projectDir: input.projectDir,
    project,
    message: input.message
  });

  const deferredActions: DevTurnDeferredAction[] = [];
  const diffIds: string[] = [];
  const toolResults: string[] = [];
  const seenActions = new Set<string>();
  let summary = "";
  let usage: StageExecutionOutput["usage"];
  let iterations = 0;
  let usedTokens = 0;
  let stoppedReason: DevTurnResult["stoppedReason"] = "completed";

  try {
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (input.abortSignal?.aborted) throw new Error("Dev turn aborted by the requester.");
      iterations = iteration + 1;
      const compiledBrief = buildDevTurnBrief({
        projectDir: input.projectDir,
        message: input.message,
        openFiles: input.openFiles ?? [],
        openFileReads,
        priorTurns,
        indexedSummaries,
        toolResults
      });
      const stageInput = {
        runId: session.id,
        taskId: turnId,
        projectConfig: project,
        workflowId: DEV_MODE_WORKFLOW_ID,
        workflowTask: input.message,
        stageId: DEV_MODE_STAGE_ID,
        agentId: DEV_MODE_AGENT_ID,
        agentName: DEV_MODE_AGENT_NAME,
        agentPrompt: DEV_AGENT_PROMPT,
        stageGoal: input.message,
        compiledBrief,
        providerOverride: providerId,
        modelOverride: input.modelOverride ?? session.model ?? undefined,
        abortSignal: input.abortSignal,
        priorReceipts: []
      };
      const result = await executeWithProviderFallback({
        providerId,
        stageInput,
        policy: providerFallbackPolicyFromEnv(),
        providerFactory: (candidate) => providerFromEnv(candidate),
        circuitStatePath: null
      });
      const output = result.output;
      summary = output.summary;
      usage = output.usage;
      usedTokens += usage?.totalTokens ?? 0;
      for (const chunk of chunkTextForStreaming(output.summary)) {
        await input.onEvent({ type: "token", turnId, text: chunk });
      }

      const requestedReads = output.requestedFileReads ?? [];
      const requestedCommands = output.requestedCommands ?? [];
      const requestedWrites = output.requestedFileWrites ?? [];
      const requestedSearches = output.requestedFileSearches ?? [];
      const hasActions =
        requestedReads.length > 0 || requestedCommands.length > 0 || requestedWrites.length > 0 || requestedSearches.length > 0;

      if (!hasActions || !toolsEnabled) {
        for (const target of requestedReads) {
          deferredActions.push({ kind: "file_read", target, status: "deferred" });
          await input.onEvent({ type: "tool_call", turnId, tool: "file_read", target, status: "deferred" });
        }
        for (const command of requestedCommands) {
          deferredActions.push({ kind: "command", target: command, status: "deferred" });
          await input.onEvent({ type: "tool_call", turnId, tool: "local_command", target: command, status: "deferred" });
        }
        for (const write of requestedWrites) {
          deferredActions.push({ kind: "file_write", target: write.path, status: "deferred" });
          await input.onEvent({ type: "tool_call", turnId, tool: "file_write", target: write.path, status: "deferred" });
        }
        for (const target of requestedSearches) {
          deferredActions.push({ kind: "file_search", target, status: "deferred" });
          await input.onEvent({ type: "tool_call", turnId, tool: "file_search", target, status: "deferred" });
        }
        if (deferredActions.length) {
          await appendDevSessionReceipt({
            sessionId: session.id,
            turnId,
            agentId: DEV_MODE_AGENT_ID,
            actionType: "dev_action_deferred",
            target: turnId,
            summary: `Deferred ${deferredActions.length} requested action(s) (tools disabled for this turn).`,
            metadata: { actions: deferredActions }
          });
        }
        break;
      }

      const executed = await executeDevTurnActions({
        session,
        turnId,
        projectDir: input.projectDir,
        project,
        output,
        approvedActions,
        seenActions,
        onEvent: input.onEvent,
        toolResults,
        deferredActions,
        diffIds
      });
      if (executed.awaitingApproval) {
        await updateDevSessionTurn(turnId, { content: summary, status: "awaiting_approval", usage });
        await appendDevSessionReceipt({
          sessionId: session.id,
          turnId,
          agentId: DEV_MODE_AGENT_ID,
          actionType: "dev_turn_awaiting_approval",
          target: executed.awaitingApproval.target,
          summary: `Dev turn paused: ${executed.awaitingApproval.actionType} ${executed.awaitingApproval.target} needs approval.`,
          metadata: { approval: executed.awaitingApproval }
        });
        await input.onEvent({
          type: "turn_awaiting_approval",
          turnId,
          approvalId: executed.awaitingApproval.approvalId,
          actionType: executed.awaitingApproval.actionType,
          target: executed.awaitingApproval.target,
          reason: executed.awaitingApproval.reason
        });
        return {
          turnId,
          assistantTurnId: turnId,
          summary,
          usage,
          iterations,
          deferredActions,
          diffIds,
          stoppedReason: "awaiting_approval",
          awaitingApproval: executed.awaitingApproval
        };
      }
      if (!executed.continued) break;
      // The agent asked for nothing new this round; another provider call
      // would repeat the same actions, so the turn ends here.
      if (!executed.progress) break;
      if (usedTokens >= tokenBudget) {
        stoppedReason = "token_budget";
        break;
      }
      if (iteration === maxIterations - 1) stoppedReason = "max_iterations";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateDevSessionTurn(turnId, { content: summary, status: "failed", usage, error: message });
    await appendDevSessionReceipt({
      sessionId: session.id,
      turnId,
      agentId: DEV_MODE_AGENT_ID,
      actionType: "dev_turn_failed",
      target: turnId,
      summary: `Dev turn failed: ${message.slice(0, 200)}`,
      metadata: { error: message }
    });
    await input.onEvent({ type: "turn_failed", turnId, error: message });
    throw error;
  }

  await updateDevSessionTurn(turnId, { content: summary, status: "completed", usage });
  await appendDevSessionReceipt({
    sessionId: session.id,
    turnId,
    agentId: DEV_MODE_AGENT_ID,
    actionType: "dev_turn_completed",
    target: turnId,
    summary: summary.slice(0, 500),
    metadata: { iterations, deferredActions: deferredActions.length, diffs: diffIds.length, usage: usage ?? null, stoppedReason }
  });
  await input.onEvent({ type: "turn_completed", turnId, summary, usage });
  return { turnId, assistantTurnId: turnId, summary, usage, iterations, deferredActions, diffIds, stoppedReason };
}

export async function getDevSessionOrThrow(sessionId: string): Promise<DevSession> {
  const session = await getDevSession(sessionId);
  if (!session) throw new Error(`Unknown dev session: ${sessionId}`);
  return session;
}
