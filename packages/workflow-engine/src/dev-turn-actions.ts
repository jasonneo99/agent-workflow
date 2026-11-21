import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import { evaluateActionApprovalRule, evaluateActionRiskAutoApproval } from "../../policy-engine/src/index.js";
import { assertCommandAllowed, executeAllowedCommand } from "../../local-tools/src/command-executor.js";
import { assertWorkerCommand } from "../../local-tools/src/controller-commands.js";
import { buildUnifiedDiff } from "../../local-tools/src/file-diff.js";
import { applyUnifiedPatch, normalizeRequestedFileMutation } from "../../local-tools/src/file-patcher.js";
import { executeAllowedFileRead } from "../../local-tools/src/file-reader.js";
import { assertFileWriteAllowed } from "../../local-tools/src/file-writer.js";
import type { StageExecutionOutput } from "../../model-providers/src/types.js";
import { searchProjectFileIndex } from "../../storage/src/project-index.js";
import {
  appendDevSessionReceipt,
  consumeDevSessionApproval,
  createDevSessionApproval,
  upsertDevSessionDiff,
  type DevSession
} from "../../storage/src/dev-sessions.js";
import { DEV_MODE_AGENT_ID, sha256Hex, type DevTurnDeferredAction, type DevTurnEvent } from "./direct-turn.js";

/**
 * Executes one provider turn's requested actions for Dev mode.
 *
 * Mirrors the executor's policy ladder for commands (worker-command check,
 * allowlist/blocklist, trusted-personal risk auto-approval) with one
 * deliberate difference: the queue's `requestActionApproval` needs a
 * workflow run, so hard gates pause the turn with a `dev_session_approvals`
 * row answered inline instead. File writes never touch disk here: they
 * become proposed diffs applied only on per-file/per-hunk Accept (Phase 3).
 * Command execution reuses `executeAllowedCommand`, which already applies
 * the scoped sandbox when the project isolates command writes.
 */

export interface DevTurnActionContext {
  session: DevSession;
  turnId: string;
  projectDir: string;
  /** Trusted-personal resolved project: policy checks run against this. */
  project: ProjectConfig;
  output: StageExecutionOutput;
  /** "actionType:target" -> approval row id (when the approval came from the DB). */
  approvedActions: Map<string, string | undefined>;
  /** Actions already performed this turn; repeats are reported, not re-run. */
  seenActions: Set<string>;
  onEvent: (event: DevTurnEvent) => void | Promise<void>;
  toolResults: string[];
  deferredActions: DevTurnDeferredAction[];
  diffIds: string[];
}

export interface DevTurnActionOutcome {
  continued: boolean;
  /** True when this round produced new information for the next iteration. */
  progress: boolean;
  awaitingApproval?: { approvalId: string; actionType: string; target: string; reason: string };
}

const TOOL_RESULT_MAX_CHARS = 4000;

function truncateToolResult(text: string): string {
  return text.length > TOOL_RESULT_MAX_CHARS ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n… (truncated)` : text;
}

async function recordReceipt(input: {
  session: DevSession;
  turnId: string;
  actionType: string;
  target: string;
  summary: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await appendDevSessionReceipt({
    sessionId: input.session.id,
    turnId: input.turnId,
    agentId: DEV_MODE_AGENT_ID,
    actionType: input.actionType,
    target: input.target,
    summary: input.summary,
    metadata: input.metadata
  });
}

type CommandDecision =
  | { decision: "allowed"; reason: string }
  | { decision: "rejected"; reason: string }
  | { decision: "awaiting_approval"; reason: string };

function decideCommand(
  commandLine: string,
  project: ProjectConfig,
  approvedActions: Map<string, string | undefined>
): CommandDecision {
  const key = `local_command:${commandLine.trim()}`;
  try {
    assertWorkerCommand(commandLine);
  } catch (error) {
    return { decision: "rejected", reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    assertCommandAllowed(commandLine, project);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Blocklist / metacharacter / long-running rejections are hard rejects.
    // An allowlist miss is the queue's policy-change approval case; in Dev
    // mode it pauses for a one-time approval of this exact command instead.
    if (reason.startsWith("Command is not allowed by project policy:")) {
      return { decision: "awaiting_approval", reason };
    }
    return { decision: "rejected", reason };
  }
  if (approvedActions.has(key)) return { decision: "allowed", reason: "Approved inline by the owner for this turn." };
  if (project.policies.require_approval_for_external_actions) {
    const rule =
      evaluateActionApprovalRule({ project, actionType: "local_command", target: commandLine }) ??
      evaluateActionRiskAutoApproval({ project, actionType: "local_command", target: commandLine });
    if (rule?.effect === "auto_execute") return { decision: "allowed", reason: rule.description };
    return {
      decision: "awaiting_approval",
      reason: rule?.description ?? "Policy requires approval before running this command."
    };
  }
  return { decision: "allowed", reason: "Allowed by the trusted-personal policy." };
}

export async function executeDevTurnActions(input: DevTurnActionContext): Promise<DevTurnActionOutcome> {
  const { session, turnId, projectDir, project } = input;
  let progress = false;

  for (const relativePath of input.output.requestedFileReads ?? []) {
    const seenKey = `file_read:${relativePath}`;
    if (input.seenActions.has(seenKey)) {
      input.toolResults.push(`Read ${relativePath} already ran this turn; using the earlier result.`);
      await input.onEvent({ type: "tool_call", turnId, tool: "file_read", target: relativePath, status: "deferred", detail: "already ran this turn" });
      continue;
    }
    input.seenActions.add(seenKey);
    progress = true;
    try {
      const read = await executeAllowedFileRead({ relativePath, cwd: projectDir, project });
      input.toolResults.push(
        truncateToolResult(`Read ${read.relativePath} (${read.bytesRead} bytes${read.truncated ? ", truncated" : ""}):\n${read.content}`)
      );
      await input.onEvent({ type: "tool_call", turnId, tool: "file_read", target: relativePath, status: "executed" });
      await recordReceipt({
        session,
        turnId,
        actionType: "dev_file_read",
        target: relativePath,
        summary: `Read ${relativePath} (${read.bytesRead} bytes).`,
        metadata: { bytes: read.bytesRead, truncated: read.truncated }
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      input.deferredActions.push({ kind: "file_read", target: relativePath, status: "rejected", detail: reason });
      input.toolResults.push(`Read ${relativePath} failed: ${reason}`);
      await input.onEvent({ type: "tool_call", turnId, tool: "file_read", target: relativePath, status: "rejected", detail: reason });
      await recordReceipt({
        session,
        turnId,
        actionType: "dev_action_rejected",
        target: relativePath,
        summary: `File read rejected: ${reason.slice(0, 200)}`,
        metadata: { actionType: "file_read", reason }
      });
    }
  }

  for (const query of input.output.requestedFileSearches ?? []) {
    const seenKey = `file_search:${query}`;
    if (input.seenActions.has(seenKey)) {
      input.toolResults.push(`File search "${query}" already ran this turn; using the earlier result.`);
      await input.onEvent({ type: "tool_call", turnId, tool: "file_search", target: query, status: "deferred", detail: "already ran this turn" });
      continue;
    }
    input.seenActions.add(seenKey);
    progress = true;
    try {
      const hits = await searchProjectFileIndex(projectDir, query);
      input.toolResults.push(
        hits.length
          ? `File search "${query}" matched:\n${hits.slice(0, 10).map((hit) => `- ${hit.path}`).join("\n")}`
          : `File search "${query}" matched nothing in the project index.`
      );
      await input.onEvent({ type: "tool_call", turnId, tool: "file_search", target: query, status: "executed" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      input.deferredActions.push({ kind: "file_search", target: query, status: "rejected", detail: reason });
      input.toolResults.push(`File search "${query}" failed: ${reason}`);
      await input.onEvent({ type: "tool_call", turnId, tool: "file_search", target: query, status: "rejected", detail: reason });
    }
  }

  for (const commandLine of input.output.requestedCommands ?? []) {
    const seenKey = `local_command:${commandLine.trim()}`;
    if (input.seenActions.has(seenKey)) {
      input.toolResults.push(`Command "${commandLine}" already ran this turn; not re-running it.`);
      await input.onEvent({ type: "tool_call", turnId, tool: "local_command", target: commandLine, status: "deferred", detail: "already ran this turn" });
      continue;
    }
    input.seenActions.add(seenKey);
    progress = true;
    const decision = decideCommand(commandLine, project, input.approvedActions);
    if (decision.decision === "awaiting_approval") {
      const approval = await createDevSessionApproval({
        sessionId: session.id,
        turnId,
        actionType: "local_command",
        target: commandLine,
        rationale: `Policy requires approval before executing a command requested by ${DEV_MODE_AGENT_ID} during a direct turn.`,
        policyDecision: { approvalRequired: true, allowedByPolicy: true, policyProfile: "trusted-personal" },
        payload: { commandLine },
        idempotencyKey: sha256Hex(`${session.id}:${turnId}:local_command:${commandLine}`)
      });
      await recordReceipt({
        session,
        turnId,
        actionType: "dev_approval_requested",
        target: commandLine,
        summary: `Approval requested for command: ${decision.reason.slice(0, 200)}`,
        metadata: { approvalId: approval.id, actionType: "local_command", reason: decision.reason }
      });
      await input.onEvent({
        type: "tool_call",
        turnId,
        tool: "local_command",
        target: commandLine,
        status: "awaiting_approval",
        detail: decision.reason
      });
      return {
        continued: false,
        progress,
        awaitingApproval: {
          approvalId: approval.id,
          actionType: "local_command",
          target: commandLine,
          reason: decision.reason
        }
      };
    }
    if (decision.decision === "rejected") {
      input.deferredActions.push({ kind: "command", target: commandLine, status: "rejected", detail: decision.reason });
      input.toolResults.push(`Command "${commandLine}" was not run: ${decision.reason}`);
      await input.onEvent({ type: "tool_call", turnId, tool: "local_command", target: commandLine, status: "rejected", detail: decision.reason });
      await recordReceipt({
        session,
        turnId,
        actionType: "dev_command_rejected",
        target: commandLine,
        summary: `Command rejected: ${decision.reason.slice(0, 200)}`,
        metadata: { reason: decision.reason }
      });
      continue;
    }
    const key = `local_command:${commandLine.trim()}`;
    const approvalId = input.approvedActions.get(key);
    try {
      const result = await executeAllowedCommand({ commandLine, cwd: projectDir, project });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      input.toolResults.push(
        truncateToolResult(`$ ${commandLine}\n(exit ${result.exitCode ?? "unknown"} in ${result.durationMs}ms)\n${output}`)
      );
      await input.onEvent({ type: "tool_call", turnId, tool: "local_command", target: commandLine, status: "executed" });
      await recordReceipt({
        session,
        turnId,
        actionType: "dev_command_executed",
        target: commandLine,
        summary: `Command exited ${result.exitCode ?? "unknown"} in ${result.durationMs}ms.`,
        metadata: { exitCode: result.exitCode, durationMs: result.durationMs, reason: decision.reason }
      });
      if (approvalId) await consumeDevSessionApproval(approvalId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      input.deferredActions.push({ kind: "command", target: commandLine, status: "rejected", detail: reason });
      input.toolResults.push(`Command "${commandLine}" failed: ${reason}`);
      await input.onEvent({ type: "tool_call", turnId, tool: "local_command", target: commandLine, status: "rejected", detail: reason });
      await recordReceipt({
        session,
        turnId,
        actionType: "dev_command_rejected",
        target: commandLine,
        summary: `Command failed: ${reason.slice(0, 200)}`,
        metadata: { reason }
      });
    }
  }

  for (const write of input.output.requestedFileWrites ?? []) {
    const mutation = normalizeRequestedFileMutation(write);
    if (!mutation) {
      input.deferredActions.push({ kind: "file_write", target: write.path, status: "rejected", detail: "Invalid file write request." });
      input.toolResults.push(`File write to ${write.path} was rejected: the request was invalid.`);
      continue;
    }
    const seenKey = `file_write:${write.path}:${sha256Hex(mutation.payload)}`;
    if (input.seenActions.has(seenKey)) {
      input.toolResults.push(`Change to ${write.path} was already proposed this turn; not proposing it again.`);
      await input.onEvent({ type: "tool_call", turnId, tool: "file_write", target: write.path, status: "deferred", detail: "already proposed this turn" });
      continue;
    }
    input.seenActions.add(seenKey);
    progress = true;
    try {
      assertFileWriteAllowed(write.path, mutation.payload, project);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      input.deferredActions.push({ kind: "file_write", target: write.path, status: "rejected", detail: reason });
      input.toolResults.push(`File write to ${write.path} was rejected: ${reason}`);
      await input.onEvent({ type: "tool_call", turnId, tool: "file_write", target: write.path, status: "rejected", detail: reason });
      await recordReceipt({
        session,
        turnId,
        actionType: "dev_action_rejected",
        target: write.path,
        summary: `File write rejected: ${reason.slice(0, 200)}`,
        metadata: { actionType: "file_write", reason }
      });
      continue;
    }
    const key = `file_write:${write.path}`;
    const rule = evaluateActionApprovalRule({
      project,
      actionType: "file_write",
      target: write.path,
      bytes: mutation.bytes
    });
    if (rule?.effect === "require_approval" && !input.approvedActions.has(key)) {
      const approval = await createDevSessionApproval({
        sessionId: session.id,
        turnId,
        actionType: "file_write",
        target: write.path,
        rationale: `Policy requires approval before proposing a change to ${write.path}.`,
        policyDecision: { approvalRequired: true, allowedByPolicy: true, policyProfile: "trusted-personal" },
        payload: { path: write.path, payloadHash: sha256Hex(mutation.payload) },
        idempotencyKey: sha256Hex(`${session.id}:${turnId}:file_write:${write.path}`)
      });
      await recordReceipt({
        session,
        turnId,
        actionType: "dev_approval_requested",
        target: write.path,
        summary: `Approval requested for a proposed change to ${write.path}.`,
        metadata: { approvalId: approval.id, actionType: "file_write" }
      });
      await input.onEvent({
        type: "tool_call",
        turnId,
        tool: "file_write",
        target: write.path,
        status: "awaiting_approval",
        detail: rule.description
      });
      return {
        continued: false,
        progress,
        awaitingApproval: { approvalId: approval.id, actionType: "file_write", target: write.path, reason: rule.description }
      };
    }

    const absolutePath = path.resolve(projectDir, write.path);
    const original = await fs.readFile(absolutePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const originalContent = original ?? "";
    const originalHash = original === null ? null : sha256Hex(originalContent);
    if (mutation.expectedHash && originalHash && mutation.expectedHash !== originalHash) {
      const reason = `Stale preimage: ${write.path} changed since the proposal was prepared (expected ${mutation.expectedHash.slice(0, 12)}, found ${originalHash.slice(0, 12)}).`;
      input.deferredActions.push({ kind: "file_write", target: write.path, status: "rejected", detail: reason });
      input.toolResults.push(`Proposed change to ${write.path} was rejected: ${reason}`);
      await input.onEvent({ type: "tool_call", turnId, tool: "file_write", target: write.path, status: "rejected", detail: reason });
      await recordReceipt({
        session,
        turnId,
        actionType: "dev_action_rejected",
        target: write.path,
        summary: reason.slice(0, 300),
        metadata: { actionType: "file_write", reason }
      });
      continue;
    }
    let proposedContent: string;
    try {
      proposedContent = mutation.isPatch ? applyUnifiedPatch(originalContent, mutation.payload).content : mutation.payload;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      input.deferredActions.push({ kind: "file_write", target: write.path, status: "rejected", detail: reason });
      input.toolResults.push(`Proposed change to ${write.path} was rejected: ${reason}`);
      await input.onEvent({ type: "tool_call", turnId, tool: "file_write", target: write.path, status: "rejected", detail: reason });
      continue;
    }
    if (proposedContent === originalContent) {
      input.toolResults.push(`No change proposed for ${write.path}: the content is already as requested.`);
      continue;
    }
    const diffText = buildUnifiedDiff(write.path, originalContent, proposedContent);
    const diff = await upsertDevSessionDiff({
      sessionId: session.id,
      turnId,
      path: write.path,
      originalHash,
      proposedContent,
      diffText,
      payloadHash: sha256Hex(mutation.payload)
    });
    input.diffIds.push(diff.id);
    input.toolResults.push(`Proposed a change to ${write.path}. It is not applied; review the diff and accept or reject it.`);
    await input.onEvent({ type: "diff_proposed", turnId, path: write.path, diffId: diff.id });
    await recordReceipt({
      session,
      turnId,
      actionType: "dev_diff_proposed",
      target: write.path,
      summary: `Proposed a change to ${write.path} (diff ${diff.id.slice(0, 8)}).`,
      metadata: { diffId: diff.id, originalHash, payloadHash: sha256Hex(mutation.payload) }
    });
    const writeApprovalId = input.approvedActions.get(key);
    if (writeApprovalId) await consumeDevSessionApproval(writeApprovalId);
  }

  return { continued: true, progress };
}
