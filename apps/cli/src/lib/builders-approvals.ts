import type { CliContext } from "./context.js";
import type { ApprovalAutopilotResult, ApprovalAutopilotRisk, ApprovalBacklogCategory, ApprovalBacklogItem, ApprovalBacklogReport, ApprovalBacklogSeverity, DashboardActionApproval, DashboardApprovalRuleSummary, DashboardFollowUpResult } from "./cli-types.js";
import { approveAndExecuteAction, commandAvailable, countStrings, ensureProjectSubdir, evaluateRoleGate, executeApprovedAction, isDismissedApproval, isExecutableApprovalAction, isRecord, loadApprovalProjectConfig, loadLocalProjectConfig, normalizeActorRole, resolveLocalProjectRootUri, resumeBlockedRunAfterResolvedApprovals, stringFromRecord, truncateText } from "./builders-shared.js";
import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { type ProjectConfig, projectConfigSchema } from "../../../../packages/agent-registry/src/schemas.js";
import { assertCommandAllowed } from "../../../../packages/local-tools/src/command-executor.js";
import { assertFileWriteAllowed } from "../../../../packages/local-tools/src/file-writer.js";
import { resolveLocalProjectPath } from "../../../../packages/runtime-root/src/index.js";
import { countActionApprovals, decideActionApproval, getActionApproval, getWorkflowRunDetails, listActionApprovals, listPendingRunNotifications, listProjectStorageSummaries, markActionApprovalExecution, markRunNotificationDelivered, recordRunAction, retryFailedWorkflowRun } from "../../../../packages/storage/src/postgres.js";
import { codexThreadId } from "../codex-callback.js";
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export async function appendProjectApprovalRule(input: {
  projectRootUri: string;
  actionType: "local_command" | "file_write" | "executor_adapter";
  target: string;
  description: string;
  payload: Record<string, unknown>;
}): Promise<{ id: string; configPath: string; created: boolean }> {
  const projectRoot = await resolveLocalProjectRootUri(input.projectRootUri);
  const configPath = path.join(projectRoot, ".agent-workflow", "project.yaml");
  const expectedDir = path.join(projectRoot, ".agent-workflow");
  await ensureProjectSubdir(projectRoot, expectedDir, ".agent-workflow");
  const raw = await fs.readFile(configPath, "utf8");
  const current = YAML.parse(raw) as Record<string, unknown>;
  const actions = isRecord(current.actions) ? current.actions : {};
  const currentProject = projectConfigSchema.parse(current);
  const approvalRules = Array.isArray(actions.approval_rules) ? actions.approval_rules : [];
  const existing = approvalRules.find((rule) =>
    isRecord(rule)
    && rule.action_type === input.actionType
    && rule.target === input.target
    && rule.effect === "auto_execute"
  );
  if (isRecord(existing) && typeof existing.id === "string") {
    return { id: existing.id, configPath, created: false };
  }

  const baseId = `always-${safeId(input.actionType)}-${safeId(input.target).slice(0, 52)}`;
  const existingIds = new Set(approvalRules.filter(isRecord).map((rule) => typeof rule.id === "string" ? rule.id : "").filter(Boolean));
  const id = uniqueApprovalRuleId(baseId, existingIds);
  const rule: Record<string, unknown> = {
    id,
    description: input.description,
    action_type: input.actionType,
    target: input.target,
    effect: "auto_execute"
  };
  if (input.actionType === "file_write") {
    const bytes = typeof input.payload.bytes === "number" ? input.payload.bytes : undefined;
    rule.max_bytes = input.target === "**"
      ? currentProject.actions.max_write_bytes
      : bytes && bytes > 0
        ? Math.max(4096, bytes)
        : 4096;
  }
  const next = {
    ...current,
    actions: {
      ...actions,
      approval_rules: [...approvalRules, rule]
    }
  };
  projectConfigSchema.parse(next);
  await fs.writeFile(configPath, YAML.stringify(next), "utf8");
  return { id, configPath, created: true };
}

export function approvalAgeMinutes(approval: DashboardActionApproval, nowIso: string): number | null {
  const reference = approval.status === "approved" ? approval.decidedAt ?? approval.updatedAt : approval.updatedAt ?? approval.createdAt;
  const now = Date.parse(nowIso);
  const then = Date.parse(reference);
  if (!Number.isFinite(now) || !Number.isFinite(then)) return null;
  return Math.max(0, Math.round((now - then) / 60000));
}

export function approvalAutopilotRiskRank(value: ApprovalAutopilotRisk): number {
  return value === "low" ? 1 : value === "medium" ? 2 : 3;
}

export function approvalBacklogSeverityRank(severity: ApprovalBacklogSeverity): number {
  if (severity === "error") return 3;
  if (severity === "warning") return 2;
  return 1;
}

export function approvalOneLineSummary(approval: Awaited<ReturnType<typeof listActionApprovals>>[number]): string {
  const rationale = approval.rationale ? ` - ${approval.rationale}` : "";
  return truncateText(`${approval.actionType} ${approval.target} for ${approval.stageId} (${approval.agentId})${rationale}`, 180);
}

export function approvalRuleBroadTarget(approval: Awaited<ReturnType<typeof listActionApprovals>>[number]): string {
  const exact = approvalRuleExactTarget(approval);
  if (approval.actionType === "local_command") {
    const parts = exact.split(" ").filter(Boolean);
    if (parts.length >= 2) {
      return `${parts.slice(0, 2).join(" ")} *`;
    }
    if (parts.length === 1) {
      return `${parts[0]} *`;
    }
    return exact;
  }
  if (approval.actionType === "file_write") {
    return "**";
  }
  return exact;
}

export function approvalRuleDisplayFromParts(actionType: string, target: string): string {
  if (actionType === "local_command") {
    return `shell ${target}`;
  }
  if (actionType === "file_write") {
    return target === "**" ? "fswrite*" : `fswrite ${target}`;
  }
  return `${actionType} ${target}`;
}

export function approvalRuleDisplayTarget(
  approval: Awaited<ReturnType<typeof listActionApprovals>>[number],
  target: string
): string {
  return approvalRuleDisplayFromParts(approval.actionType, target);
}

export function approvalRuleExactTarget(approval: Awaited<ReturnType<typeof listActionApprovals>>[number]): string {
  if (approval.actionType === "local_command" && typeof approval.payload.commandLine === "string") {
    return normalizeApprovalRuleCommand(approval.payload.commandLine);
  }
  if (approval.actionType === "file_write" && typeof approval.payload.relativePath === "string") {
    return normalizeApprovalRulePath(approval.payload.relativePath);
  }
  if (approval.actionType === "executor_adapter") return approval.target.trim();
  return approval.actionType === "local_command"
    ? normalizeApprovalRuleCommand(approval.target)
    : normalizeApprovalRulePath(approval.target);
}

export async function buildApprovalBacklogReport(ctx: CliContext, input: {
  status?: string;
  projectRootUri?: string;
  limit: number;
  staleMinutes: number;
}): Promise<ApprovalBacklogReport> {
  const [approvals, total] = await Promise.all([
    listActionApprovalsForProjectAliases({
      status: input.status,
      projectRootUri: input.projectRootUri,
      limit: input.limit,
      order: "recent"
    }),
    countActionApprovalsForProjectAliases({
      status: input.status,
      projectRootUri: input.projectRootUri
    })
  ]);
  const generatedAt = new Date().toISOString();
  const projectConfigs = new Map<string, ProjectConfig | null>();
  const items: ApprovalBacklogItem[] = [];
  for (const approval of approvals) {
    const ageMinutes = approvalAgeMinutes(approval, generatedAt);
    const approvedExecutableNotRun = approval.status === "approved" && isExecutableApprovalAction(approval.actionType) && !approval.executedAt;
    let severity: ApprovalBacklogSeverity = "info";
    let reason = "No action needed.";
    let resolvedMissingTool: string | null = null;
    if (approval.status === "failed" && !isDismissedApproval(approval)) {
      severity = "error";
      reason = approval.decisionNote ? `Execution failed: ${approval.decisionNote}` : "Approval execution failed.";
      if (/spawn\s+\S+\s+ENOENT|command executable is not available|command not found|ENOENT/iu.test(reason)) {
        const missingExecutable = await missingApprovalCommandExecutable(ctx, approval);
        if (missingExecutable === null) {
          resolvedMissingTool = firstCommandToken(stringFromRecord(approval.payload, "commandLine") ?? approval.target) ?? "required tool";
          severity = "warning";
          reason = `Earlier execution failed because ${resolvedMissingTool} was missing on PATH. ${resolvedMissingTool} is now available; retry if the approval is still relevant, or dismiss it as historical.`;
        }
      }
    } else if (approval.status === "dismissed" || isDismissedApproval(approval)) {
      severity = "info";
      reason = approval.decisionNote ?? "Approval was dismissed without execution.";
    } else if (approvedExecutableNotRun) {
      severity = "warning";
      reason = "Approved executable action has not been executed.";
    } else if (approval.status === "pending" && ageMinutes !== null && ageMinutes >= input.staleMinutes) {
      severity = "warning";
      reason = `${approval.status} approval is stale after ${Math.floor(ageMinutes)} minute(s).`;
    } else if (approval.status === "pending") {
      reason = "Pending approval is waiting for decision.";
    } else if (approval.status === "approved" && !isExecutableApprovalAction(approval.actionType)) {
      reason = "Approved decision is recorded as audit history; this action type does not execute inline.";
    }

    let autopilotRisk: ApprovalAutopilotRisk | undefined;
    let autopilotEligible: boolean | undefined;
    if (approval.status === "pending") {
      if (!projectConfigs.has(approval.projectRootUri)) {
        projectConfigs.set(approval.projectRootUri, await loadLocalProjectConfig(approval.projectRootUri).catch(() => null));
      }
      const project = projectConfigs.get(approval.projectRootUri);
      if (project) {
        const classification = classifyApprovalAutopilotRisk(approval, project);
        autopilotRisk = classification.risk;
        autopilotEligible = classification.eligible;
        if (classification.eligible && severity === "info") {
          reason = `Pending approval is eligible for approval autopilot as ${classification.risk} risk.`;
        } else if (!classification.eligible && severity === "info") {
          severity = "warning";
          reason = `Pending approval is not autopilot eligible: ${classification.reasons.join(" ")}`;
        }
      } else if (severity === "info") {
        severity = "warning";
        reason = "Project config could not be loaded for autopilot classification.";
      }
    }

    const triage = classifyApprovalBacklogTriage({
      status: approval.status,
      actionType: approval.actionType,
      target: approval.target,
      reason,
      resolvedMissingTool: Boolean(resolvedMissingTool)
    });

    items.push({
      approvalId: approval.id,
      status: approval.status,
      actionType: approval.actionType,
      target: approval.target,
      runId: approval.runId,
      workflowId: approval.workflowId,
      stageId: approval.stageId,
      agentId: approval.agentId,
      projectRootUri: approval.projectRootUri,
      createdAt: approval.createdAt,
      updatedAt: approval.updatedAt,
      ageMinutes,
      severity,
      reason,
      category: triage.category,
      nextAction: triage.nextAction,
      autopilotRisk,
      autopilotEligible
    });
  }
  return {
    kind: "agentflow_approval_backlog_report",
    generatedAt,
    projectRootUri: input.projectRootUri ?? null,
    statusFilter: input.status ?? null,
    staleMinutes: input.staleMinutes,
    total,
    limit: input.limit,
    truncated: total > approvals.length,
    scanned: approvals.length,
    counts: countStrings(approvals.map((approval) => approval.status)),
    severityCounts: {
      info: items.filter((item) => item.severity === "info").length,
      warning: items.filter((item) => item.severity === "warning").length,
      error: items.filter((item) => item.severity === "error").length
    },
    categoryCounts: countStrings(items.map((item) => item.category)) as Record<ApprovalBacklogCategory, number>,
    items: items.sort((left, right) => approvalBacklogSeverityRank(right.severity) - approvalBacklogSeverityRank(left.severity) || String(right.updatedAt).localeCompare(String(left.updatedAt)))
  };
}

export function classifyApprovalAutopilotRisk(approval: DashboardActionApproval, project: ProjectConfig): { eligible: boolean; risk: ApprovalAutopilotRisk; reasons: string[] } {
  if (!isExecutableApprovalAction(approval.actionType)) {
    return { eligible: false, risk: "high", reasons: [`${approval.actionType} is not an executable local approval action.`] };
  }
  if (approval.actionType === "deployment" || approval.actionType === "autonomy" || approval.actionType === "artifact_prune") {
    return { eligible: false, risk: "high", reasons: [`${approval.actionType} always requires an explicit human decision.`] };
  }
  if (approval.actionType === "artifact_archive" || approval.actionType === "artifact_restore") {
    return { eligible: true, risk: "medium", reasons: [`${approval.actionType} is non-destructive but still policy rechecked at execution.`] };
  }
  if (approval.actionType === "local_command") {
    const commandLine = stringFromRecord(approval.payload, "commandLine") ?? approval.target;
    try {
      assertCommandAllowed(commandLine, project);
    } catch (error) {
      return { eligible: false, risk: "high", reasons: [`Policy recheck failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
    const normalized = commandLine.toLowerCase();
    if (/(\bsudo\b|\brm\b|\bgit\s+(reset|clean|checkout)\b|\bchmod\b|\bchown\b|\bcurl\b|\bwget\b|\bssh\b|\bscp\b|\bdeploy\b|\bpublish\b|\bprisma\s+migrate\b|\bdocker\b|\blaunchctl\b)/u.test(normalized)) {
      return { eligible: false, risk: "high", reasons: ["Command matched a high-risk autopilot deny pattern."] };
    }
    if (/^(npm|pnpm|yarn)\s+(test|run\s+(test|typecheck|lint|validate|check|build)|exec\s+tsc)\b/u.test(normalized)) {
      return { eligible: true, risk: "low", reasons: ["Policy-allowed verification command."] };
    }
    return { eligible: true, risk: "medium", reasons: ["Policy-allowed finite local command."] };
  }
  if (approval.actionType === "file_write") {
    const relativePath = stringFromRecord(approval.payload, "relativePath") ?? approval.target;
    const bytes = numberFromRecord(approval.payload, "bytes") ?? 0;
    if (/(^|\/)(\.env|\.env\..*|id_rsa|id_ed25519|secrets?|credentials?|token|key)(\/|$)/iu.test(relativePath)) {
      return { eligible: false, risk: "high", reasons: ["File path looks secret-bearing or credential-related."] };
    }
    if (bytes > project.actions.max_write_bytes) {
      return { eligible: false, risk: "high", reasons: [`Policy recheck failed: payload is ${bytes} bytes, max is ${project.actions.max_write_bytes}.`] };
    }
    try {
      assertFileWriteAllowed(relativePath, "x".repeat(Math.min(bytes || 1, 1024)), project);
    } catch (error) {
      return { eligible: false, risk: "high", reasons: [`Policy recheck failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
    if (bytes <= 20_000 && /^(\.agent-workflow\/|docs\/|README\.md$|CHANGELOG\.md$)/u.test(relativePath)) {
      return { eligible: true, risk: "low", reasons: ["Small policy-allowed docs or Agent Workflow-owned file write."] };
    }
    return { eligible: true, risk: "medium", reasons: ["Policy-allowed file write below project byte limits."] };
  }
  return { eligible: false, risk: "high", reasons: [`Unsupported autopilot action type: ${approval.actionType}`] };
}

export function classifyApprovalBacklogTriage(input: {
  status: string;
  actionType: string;
  target: string;
  reason: string;
  resolvedMissingTool?: boolean;
}): { category: ApprovalBacklogCategory; nextAction: string } {
  const text = `${input.reason}\n${input.target}`.toLowerCase();
  if (input.status === "executed" || input.status === "dismissed" || input.status === "rejected") {
    return {
      category: "historical_info",
      nextAction: "No action needed. This row is retained for the approval audit trail."
    };
  }
  if (input.actionType === "deployment" || input.actionType === "autonomy") {
    return {
      category: "manual_decision",
      nextAction: "Decision is recorded. Run any deployment or autonomy-changing action separately under project policy."
    };
  }
  if (input.resolvedMissingTool) {
    return {
      category: "resolved_missing_tool",
      nextAction: "The executable is now on PATH. Retry this approval if it is still useful, or dismiss it as historical."
    };
  }
  if (/spawn\s+\S+\s+enoent|command executable is not available|command not found|enoent/u.test(text)) {
    const missing = /spawn\s+([^\s]+)\s+enoent/u.exec(text)?.[1]
      ?? /command not found:\s*([^\s]+)/u.exec(text)?.[1]
      ?? "required tool";
    return {
      category: "missing_tool",
      nextAction: `Install or expose ${missing} on PATH, then retry the approval action.`
    };
  }
  if (/exited with\s+\d+|approved command failed|execution failed/u.test(text) && input.status === "failed") {
    return {
      category: "command_failed",
      nextAction: "Open the run details, fix the failing command or inputs, then retry or dismiss the reviewed failure."
    };
  }
  if (/stale|out of date/u.test(text)) {
    return {
      category: "stale_review",
      nextAction: "Refresh the run evidence before executing, or dismiss if this approval is no longer relevant."
    };
  }
  if (input.status === "approved" && isExecutableApprovalAction(input.actionType)) {
    return {
      category: "ready_to_execute",
      nextAction: "Execute the approved side effect, run approval autopilot, or dismiss it if it is no longer needed."
    };
  }
  return {
    category: "needs_review",
    nextAction: "Review the approval reason and choose approve, execute, reject, or dismiss."
  };
}

export async function countActionApprovalsForProjectAliases(input: {
  status?: string;
  runId?: string;
  projectRootUri?: string;
}): Promise<number> {
  const rootUris = await resolveStorageRootUrisForLocalProject(input.projectRootUri);
  if (!rootUris) {
    return countActionApprovals({ status: input.status, runId: input.runId });
  }
  const counts = await Promise.all(rootUris.map((projectRootUri) => countActionApprovals({
    status: input.status,
    runId: input.runId,
    projectRootUri
  })));
  return counts.reduce((sum, count) => sum + count, 0);
}

export async function deliverCodexWorkflowCallback(input: {
  threadId: string;
  projectDir: string;
  prompt: string;
}): Promise<{ transportDelivered: boolean; acknowledged: false }> {
  // CLI completion is a transport result, not evidence of desktop-task arrival.
  // Only an independently correlated originating-task acknowledgment can prove that.
  return new Promise((resolve) => {
    execFile(
      process.env.CODEX_CLI_PATH?.trim() || "codex",
      ["exec", "resume", "--all", input.threadId, input.prompt],
      { cwd: input.projectDir, env: process.env, timeout: 90_000, maxBuffer: 1024 * 1024 },
      (error) => resolve({ transportDelivered: !error, acknowledged: false })
    );
  });
}

export async function deliverOneRunNotification(
  projectDir: string,
  notification: { id: string; runId: string; channel: string; kind: string; title: string; body: string; originTaskId?: string | null }
): Promise<boolean> {
  const channel = notification.channel || "dashboard";
  if (channel === "codex") {
    try {
      const details = await getWorkflowRunDetails(notification.runId);
      const threadId = codexThreadId(details.run?.evaluationMetadata);
      if (!threadId) return false;
      if (notification.originTaskId !== undefined && (!notification.originTaskId
        || notification.originTaskId.toLowerCase() !== threadId.toLowerCase())) return false;
      const result = await deliverCodexWorkflowCallback({
        threadId,
        projectDir,
        prompt: ["Agent Workflow callback: inspect evidence only. This message grants no approval, repair, retry, or execution authority.",
          `Notification: ${notification.id}; run: ${notification.runId}; originating task: ${threadId}`,
          notification.title, notification.body].join("\n\n")
      });
      return result.transportDelivered;
    } catch {
      return false;
    }
  }
  const notifyCommand = process.env.AGENTFLOW_NOTIFY_COMMAND?.trim();
  if (notifyCommand) {
    const payload = JSON.stringify({
      notificationId: notification.id,
      runId: notification.runId,
      kind: notification.kind,
      title: notification.title,
      body: notification.body
    });
    // The command may be a bare executable path (possibly containing
    // spaces); only split into argv when it is not directly executable.
    let binary = notifyCommand;
    let args: string[] = [];
    try {
      await fs.access(notifyCommand, fsSync.constants.X_OK);
    } catch {
      [binary, ...args] = notifyCommand.split(/\s+/);
    }
    return await new Promise((resolve) => {
      const child = execFile(binary, args, { timeout: 30_000, maxBuffer: 256 * 1024 }, (error) => resolve(!error));
      child.stdin?.write(payload);
      child.stdin?.end();
    });
  }
  // No bridge configured: try the bundled notify bridge (phone push + macOS notification).
  // Surfaced in the dashboard and via `notifications` regardless.
  try {
    const bridgeUrl = new URL('../../../scripts/notify-requester.py', import.meta.url);
    const payload = JSON.stringify({
      notificationId: notification.id,
      runId: notification.runId,
      kind: notification.kind,
      title: notification.title,
      body: notification.body
    });
    const delivered: boolean = await new Promise<boolean>((resolve) => {
      const child = execFile('python3', [bridgeUrl.pathname], { timeout: 30_000, maxBuffer: 256 * 1024 }, (error) => resolve(!error));
      child.stdin?.write(payload);
      child.stdin?.end();
    });
    return delivered;
  } catch {
    return true;
  }
}

export async function deliverRunNotifications(projectDir: string): Promise<number> {
  const { dispatchRunNotifications } = await import("../run-notification-dispatcher.js");
  const { claimRunNotifications, settleRunNotification } = await import("../../../../packages/storage/src/run-notifications.js");
  const claimed = new Map<string, import("../run-notification-dispatcher.js").DispatchNotification>();
  return dispatchRunNotifications({ projectRootUri: projectDir, owner: `notification-dispatcher:${process.pid}` }, {
    claim: claimRunNotifications,
    async transport(notification) {
      claimed.set(notification.id, notification);
      return deliverOneRunNotification(projectDir, notification);
    },
    async settle(input) {
      const settled = await settleRunNotification(input);
      const notification = claimed.get(input.notificationId);
      claimed.delete(input.notificationId);
      if (settled && input.transportDelivered && notification) {
        await recordRunAction({
          runId: notification.runId,
          agentId: "workflow-orchestrator",
          actionType: "requester_notified",
          target: notification.id,
          summary: `Requester transport completed via ${notification.channel}; acknowledgment remains unverified.`,
          artifactKind: "run_notification",
          artifactContent: { kind: notification.kind, channel: notification.channel, transportDelivered: true, acknowledged: false }
        }).catch(() => undefined);
      }
      return settled;
    }
  });
}

export async function dismissApprovedAction(ctx: CliContext, input: {
  approvalId: string;
  actor: string;
  actorRole?: string;
  note?: string;
}): Promise<DashboardFollowUpResult> {
  const approval = await getActionApproval(input.approvalId);
  if (!approval) {
    return { ok: false, error: `Unknown approval: ${input.approvalId}` };
  }
  if (approval.status !== "approved" && approval.status !== "failed" && approval.status !== "dismissed") {
    return { ok: false, error: `Approval must be approved or failed before dismissal. Current status: ${approval.status}` };
  }
  const project = await loadApprovalProjectConfig(ctx, approval);
  const actorRole = input.actorRole ?? project.team.default_actor_role;
  const executionRoleGate = evaluateRoleGate(project, actorRole, "can_execute_approved_actions");
  if (!executionRoleGate.allowed) {
    return { ok: false, error: executionRoleGate.message };
  }
  const summary = input.note?.trim()
    ? `Approved action dismissed without execution: ${input.note.trim()}`
    : "Approved action dismissed without execution.";
  const dismissed = await markActionApprovalExecution({
    approvalId: approval.id,
    status: "dismissed",
    actor: input.actor,
    actorRole,
    summary
  });
  if (!dismissed) {
    return { ok: false, error: "Approval was not found or could not be dismissed." };
  }
  return {
    ok: true,
    title: "Approved action dismissed",
    runId: approval.runId,
    output: [
      `Approval: ${approval.id}`,
      `Action: ${approval.actionType}`,
      `Target: ${approval.target}`,
      `Project: ${approval.projectRootUri}`,
      `Role gate: ${executionRoleGate.message}`,
      summary,
      "Receipt recorded; the action was not executed.",
      "Open: /approvals?status=dismissed"
    ].join("\n")
  };
}

export function firstCommandToken(commandLine: string): string | null {
  const match = /"([^"]*)"|'([^']*)'|[^\s]+/u.exec(commandLine.trim());
  return match ? match[1] ?? match[2] ?? match[0] : null;
}

export function formatApprovalAutopilotResult(result: ApprovalAutopilotResult): string {
  return [
    `Approval autopilot: ${result.mode}`,
    `Max risk: ${result.maxRisk}`,
    `Scanned: ${result.scanned}`,
    `Approved: ${result.approved}`,
    `Executed: ${result.executed}`,
    `Skipped: ${result.skipped}`,
    "",
    ...result.items.map((item) => [
      `- ${item.status} ${item.risk}: ${item.actionType} ${item.target}`,
      `  id: ${item.approvalId}`,
      `  ${item.summary}`,
      ...item.reasons.map((reason) => `  - ${reason}`)
    ].join("\n"))
  ].join("\n");
}

export async function listActionApprovalsForProjectAliases(input: {
  status?: string;
  runId?: string;
  projectRootUri?: string;
  limit: number;
  order?: "priority" | "recent";
}): Promise<DashboardActionApproval[]> {
  const rootUris = await resolveStorageRootUrisForLocalProject(input.projectRootUri);
  if (!rootUris) {
    return listActionApprovals({
      status: input.status,
      runId: input.runId,
      limit: input.limit,
      order: input.order
    });
  }
  const rows: DashboardActionApproval[] = [];
  for (const rootUri of rootUris) {
    rows.push(...await listActionApprovals({
      status: input.status,
      runId: input.runId,
      projectRootUri: rootUri,
      limit: input.limit,
      order: input.order
    }));
  }
  return rows
    .filter((approval, index, list) => list.findIndex((item) => item.id === approval.id) === index)
    .sort((left, right) => input.order === "recent"
      ? String(right.createdAt).localeCompare(String(left.createdAt))
      : 0)
    .slice(0, input.limit);
}

export async function loadProjectApprovalRules(projectRootUri: string): Promise<DashboardApprovalRuleSummary[]> {
  const projectRoot = path.resolve(projectRootUri);
  const configPath = path.join(projectRoot, ".agent-workflow", "project.yaml");
  const project = await loadProjectConfig(projectRoot);
  return project.actions.approval_rules.map((rule) => ({
    projectName: project.project.name,
    projectRootUri: projectRoot,
    configPath,
    id: rule.id,
    description: rule.description,
    actionType: rule.action_type,
    target: rule.target,
    functionLabel: approvalRuleDisplayFromParts(rule.action_type, rule.target),
    effect: rule.effect,
    maxBytes: rule.max_bytes
  }));
}

export async function missingApprovalCommandExecutable(ctx: CliContext, approval: DashboardActionApproval): Promise<string | null> {
  const commandLine = stringFromRecord(approval.payload, "commandLine") ?? approval.target;
  const executable = firstCommandToken(commandLine);
  if (!executable) return "unknown";
  return await commandAvailable(ctx, executable) ? null : executable;
}

export function normalizeApprovalRuleCommand(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeApprovalRulePath(value: string): string {
  return value.trim().replace(/^\.\//, "").replaceAll(path.sep, "/");
}

export function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseApprovalAutopilotRisk(value: string | undefined): ApprovalAutopilotRisk {
  const normalized = value?.trim().toLowerCase();
  return normalized === "low" || normalized === "medium" || normalized === "high" ? normalized : "medium";
}

export async function processDashboardApprovalRuleAction(ctx: CliContext, input: {
  approvalId: string;
  target: string;
  actor?: string;
  actorRole: string;
  note: string;
  approveCurrent: boolean;
}): Promise<DashboardFollowUpResult> {
  const approvalId = input.approvalId.trim();
  const target = input.target.trim();
  if (!approvalId) {
    return { ok: false, error: "Missing approval id." };
  }
  if (!target) {
    return { ok: false, error: "Missing approval rule target." };
  }
  const approvalForGate = await getActionApproval(approvalId);
  if (!approvalForGate) {
    return { ok: false, error: "Approval was not found or is no longer pending." };
  }
  if (approvalForGate.actionType !== "local_command" && approvalForGate.actionType !== "file_write" && approvalForGate.actionType !== "executor_adapter") {
    return { ok: false, error: "Always approve rules are only supported for local_command, file_write, and executor_adapter approvals." };
  }
  const actorRole = normalizeActorRole(input.actorRole, "approver");
  const project = await loadApprovalProjectConfig(ctx, approvalForGate);
  const gate = evaluateRoleGate(project, actorRole, "can_approve_actions");
  if (!gate.allowed) {
    return { ok: false, error: gate.message };
  }
  const rule = await appendProjectApprovalRule({
    projectRootUri: approvalForGate.projectRootUri,
    actionType: approvalForGate.actionType,
    target,
    description: input.note.trim() || `Always approve ${approvalRuleDisplayTarget(approvalForGate, target)}.`,
    payload: approvalForGate.payload
  });
  let approval: DashboardActionApproval | null = null;
  if (input.approveCurrent) {
    approval = await decideActionApproval({
      approvalId,
      decision: "approved",
      actor: input.actor ?? "dashboard",
      actorRole,
      note: input.note.trim() || `Approved current request and added approval rule ${rule.id}.`
    });
    if (!approval) {
      return { ok: false, error: "Approval rule was written, but the current approval was no longer pending." };
    }
  }
  return {
    ok: true,
    title: rule.created ? "Approval rule added" : "Approval rule already exists",
    runId: approvalForGate.runId,
    output: [
      `Rule: ${rule.id}`,
      `Function: ${approvalRuleDisplayTarget(approvalForGate, target)}`,
      `Stored action: ${approvalForGate.actionType}`,
      `Stored target pattern: ${target}`,
      `Project: ${approvalForGate.projectRootUri}`,
      `Config: ${rule.configPath}`,
      `Current approval: ${approval ? `approved ${approval.id}` : "left pending"}`,
      "Future matching actions must still pass allowed command/path policy and blocklists.",
      "Open: /approvals"
    ].join("\n")
  };
}

export async function processRequesterApprovalReply(input: {
  approvalId: string;
  decision: string;
  actor: string;
  note?: string;
}): Promise<DashboardFollowUpResult> {
  const approvalId = input.approvalId.trim();
  const normalized = input.decision.trim().toLowerCase();
  if (!approvalId) return { ok: false, error: "Missing approval id." };
  if (normalized !== "approve" && normalized !== "reject") {
    return { ok: false, error: `Decision must be "approve" or "reject", got: ${input.decision}` };
  }
  const decided = await decideActionApproval({
    approvalId,
    decision: normalized === "approve" ? "approved" : "rejected",
    actor: input.actor.trim() || "requester",
    note: input.note?.trim() || `Requester reply: ${normalized}`
  });
  if (!decided) return { ok: false, error: `Approval not found or already decided: ${approvalId}` };
  if (normalized === "reject") {
    return { ok: true, title: "Approval rejected", runId: decided.runId, output: `Approval ${approvalId}: rejected.\nRun ${decided.runId} remains blocked.` };
  }
  const resumed = await resumeBlockedRunAfterResolvedApprovals(decided.runId);
  return {
    ok: true,
    title: "Approval accepted",
    runId: resumed.replacementRunId ?? decided.runId,
    redirectToRun: Boolean(resumed.replacementRunId),
    output: resumed.resumedTasks > 0
      ? `Approval ${approvalId}: approved.\nRun ${decided.runId} resumed (${resumed.resumedTasks} task(s))${resumed.replacementRunId ? ` as ${resumed.replacementRunId}` : ""}.`
      : `Approval ${approvalId}: approved.\nRun ${decided.runId} had no blocked tasks eligible to resume.`
  };
}

export async function removeProjectApprovalRule(input: {
  projectRootUri: string;
  ruleId: string;
  actor: string;
}): Promise<DashboardFollowUpResult> {
  const projectRoot = path.resolve(input.projectRootUri);
  const configPath = path.join(projectRoot, ".agent-workflow", "project.yaml");
  const expectedDir = path.join(projectRoot, ".agent-workflow");
  await ensureProjectSubdir(projectRoot, expectedDir, ".agent-workflow");
  const raw = await fs.readFile(configPath, "utf8");
  const current = YAML.parse(raw) as Record<string, unknown>;
  const actions = isRecord(current.actions) ? current.actions : {};
  const approvalRules = Array.isArray(actions.approval_rules) ? actions.approval_rules : [];
  const rule = approvalRules.find((item) => isRecord(item) && item.id === input.ruleId);
  if (!isRecord(rule)) {
    return { ok: false, error: `Unknown approval rule: ${input.ruleId}` };
  }
  const nextRules = approvalRules.filter((item) => !(isRecord(item) && item.id === input.ruleId));
  const next = {
    ...current,
    actions: {
      ...actions,
      approval_rules: nextRules
    }
  };
  projectConfigSchema.parse(next);
  await fs.writeFile(configPath, YAML.stringify(next), "utf8");
  const actionType = rule.action_type === "local_command" || rule.action_type === "file_write" || rule.action_type === "executor_adapter" ? rule.action_type : "local_command";
  const target = typeof rule.target === "string" ? rule.target : "";
  return {
    ok: true,
    title: "Approval rule removed",
    output: [
      `Rule: ${input.ruleId}`,
      `Function: ${approvalRuleDisplayFromParts(actionType, target)}`,
      `Project: ${projectRoot}`,
      `Config: ${configPath}`,
      `Actor: ${input.actor}`,
      "Future matching actions will require approval again unless another rule matches.",
      "Open: /approval-rules"
    ].join("\n")
  };
}

export async function resolveStorageRootUrisForLocalProject(projectRootUri?: string): Promise<string[] | undefined> {
  if (!projectRootUri?.trim()) {
    return undefined;
  }
  const requestedResolution = await resolveLocalProjectPath(projectRootUri);
  const localRootUri = path.resolve(requestedResolution.localRootUri);
  const rootUris = new Set<string>([
    requestedResolution.storageRootUri,
    requestedResolution.localRootUri,
    path.resolve(process.cwd(), projectRootUri)
  ]);
  const summaries = await listProjectStorageSummaries(1000).catch(() => []);
  for (const summary of summaries) {
    const resolution = await resolveLocalProjectPath(summary.rootUri);
    if (path.resolve(resolution.localRootUri) === localRootUri) {
      rootUris.add(summary.rootUri);
    }
  }
  return [...rootUris];
}

export function rolePreviewForApproval(approval: Awaited<ReturnType<typeof listActionApprovals>>[number]): string {
  if (approval.status === "pending") {
    return "Role preview: approval decision expects approver.";
  }
  if (approval.status === "approved" && isExecutableApprovalAction(approval.actionType)) {
    return "Role preview: execution expects operator.";
  }
  if (approval.actionType === "deployment" || approval.actionType === "autonomy") {
    return "Role preview: request expects operator; decision expects approver.";
  }
  return approval.decidedRole
    ? `Role preview: recorded as ${approval.decidedRole}.`
    : "Role preview: no decision role recorded yet.";
}

export async function runApprovalAutopilot(ctx: CliContext, input: {
  projectRootUri?: string;
  runId?: string;
  limit: number;
  maxRisk: ApprovalAutopilotRisk;
  execute: boolean;
  actor: string;
  actorRole: string;
}): Promise<ApprovalAutopilotResult> {
  const pendingApprovals = await listActionApprovalsForProjectAliases({
    status: "pending",
    runId: input.runId,
    projectRootUri: input.projectRootUri,
    limit: input.limit
  });
  const approvedApprovals = await listActionApprovalsForProjectAliases({
    status: "approved",
    runId: input.runId,
    projectRootUri: input.projectRootUri,
    limit: input.limit
  });
  const approvals = [...pendingApprovals, ...approvedApprovals]
    .filter((approval, index, list) => list.findIndex((item) => item.id === approval.id) === index)
    .filter((approval) => approval.status === "pending" || approval.status === "approved" && isExecutableApprovalAction(approval.actionType) && !approval.executedAt)
    .slice(0, input.limit);
  const items: ApprovalAutopilotResult["items"] = [];
  const resumedRuns = new Set<string>();
  const generatedAt = new Date().toISOString();
  for (const approval of approvals) {
    const project = await loadLocalProjectConfig(approval.projectRootUri);
    const classification = classifyApprovalAutopilotRisk(approval, project);
    const unavailableCommand = approval.actionType === "local_command"
      ? await missingApprovalCommandExecutable(ctx, approval)
      : null;
    const approvedAgeMinutes = approval.status === "approved" ? approvalAgeMinutes(approval, generatedAt) : null;
    const staleApprovedFileWrite = approval.status === "approved"
      && approval.actionType === "file_write"
      && approvedAgeMinutes !== null
      && approvedAgeMinutes >= 60;
    const allowedByThreshold = approvalAutopilotRiskRank(classification.risk) <= approvalAutopilotRiskRank(input.maxRisk);
    if (!classification.eligible || !allowedByThreshold || staleApprovedFileWrite || unavailableCommand) {
      items.push({
        approvalId: approval.id,
        actionType: approval.actionType,
        target: approval.target,
        risk: staleApprovedFileWrite || unavailableCommand ? "high" : classification.risk,
        status: "skipped",
        summary: unavailableCommand
          ? `Command executable is not available on this machine: ${unavailableCommand}`
          : staleApprovedFileWrite
          ? "Already-approved file write is stale and needs fresh review before execution."
          : classification.eligible ? "Above autopilot risk threshold." : "Not eligible for approval autopilot.",
        reasons: [
          ...classification.reasons,
          unavailableCommand ? `command not found: ${unavailableCommand}` : "",
          staleApprovedFileWrite ? `approved file_write is ${Math.floor(approvedAgeMinutes ?? 0)} minute(s) old` : "",
          allowedByThreshold ? "" : `risk ${classification.risk} is above max ${input.maxRisk}`
        ].filter(Boolean)
      });
      continue;
    }
    if (!input.execute) {
      items.push({
        approvalId: approval.id,
        actionType: approval.actionType,
        target: approval.target,
        risk: classification.risk,
        status: "would_execute",
        summary: approvalOneLineSummary(approval),
        reasons: classification.reasons
      });
      continue;
    }
    const result = approval.status === "approved"
      ? await executeApprovedAction(ctx, {
        approvalId: approval.id,
        actor: input.actor,
        actorRole: "operator"
      })
      : await approveAndExecuteAction(ctx, {
        approvalId: approval.id,
        actor: input.actor,
        approveActorRole: input.actorRole,
        executeActorRole: "operator",
        note: `Autopilot approved and requested immediate execution: risk=${classification.risk}, max=${input.maxRisk}.`
      });
    items.push({
      approvalId: approval.id,
      actionType: approval.actionType,
      target: approval.target,
      risk: classification.risk,
      status: result.ok ? "executed" : "failed",
      summary: result.ok ? result.title : result.error,
      reasons: result.ok ? classification.reasons : [...classification.reasons, result.error]
    });
    // approveAndExecuteAction already creates the checkpoint-preserving
    // replacement after the final approval. Remember that result so the
    // autopilot does not replay the same blocked source run a second time.
    if (result.ok && "runId" in result && result.runId && result.runId !== approval.runId) {
      resumedRuns.add(approval.runId);
    }
    if (result.ok && !resumedRuns.has(approval.runId)) {
      const details = await getWorkflowRunDetails(approval.runId);
      if (details.run?.status === "blocked") {
        const unresolved = (await listActionApprovals({ runId: approval.runId, status: "all", limit: 500 }))
          .some((item) => item.status === "pending" || item.status === "approved" && !item.executedAt);
        if (!unresolved) {
          const replayedTasks = await retryFailedWorkflowRun(approval.runId);
          if (replayedTasks > 0) resumedRuns.add(approval.runId);
        }
      }
    }
  }
  return {
    kind: "agentflow_approval_autopilot_result",
    generatedAt: new Date().toISOString(),
    mode: input.execute ? "execute" : "dry-run",
    maxRisk: input.maxRisk,
    scanned: approvals.length,
    approved: items.filter((item) => item.status === "would_execute" || item.status === "executed").length,
    executed: items.filter((item) => item.status === "executed").length,
    skipped: items.filter((item) => item.status === "skipped" || item.status === "failed").length,
    items
  };
}

export function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

export function uniqueApprovalRuleId(baseId: string, existingIds: Set<string>): string {
  let id = baseId || "always-approve";
  let index = 2;
  while (existingIds.has(id)) {
    id = `${baseId}-${index}`;
    index += 1;
  }
  return id;
}
