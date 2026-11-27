import { formatNumber } from "../ui/format.js";
import { escapeHtml, renderDashboardDateTime, metricCard, dashboardReturnInput } from "../ui/layout.js";
import type { ArtifactLifecycleAction, ArtifactLifecyclePolicy, DashboardWorkerStatus, RuntimeMonitorReport } from "../../lib/cli-types.js";
import { formatDuration } from "../../lib/builders-learning.js";
import { isLoopbackBind } from "../../lib/builders-server.js";
import { compactDashboardText, countStrings, formatBytes, lifecyclePolicyFromProject, objectFromRecord, pathExists, resolveLocalProjectRootUri, stringFromRecord } from "../../lib/builders-shared.js";
import { loadProjectConfig } from "../../../../../packages/agent-registry/src/loaders.js";
import { defaultServiceEndpoints } from "../../../../../packages/storage/src/config.js";
import { getArtifactByUri, listArtifactLifecycle } from "../../../../../packages/storage/src/postgres.js";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ArtifactLifecycleActionPlan, ArtifactLifecycleReceiptPreview, ArtifactLifecycleReport, ArtifactLifecycleRequestedActionType, ArtifactPrunePlan, DashboardArtifactLifecycleRow } from "../../commands/daemon-types.js";

export function agentWorkflowPluginRoot(): string {
  const sourceRoot = path.join(os.homedir(), "plugins", "agent-workflow");
  if (fsSync.existsSync(path.join(sourceRoot, ".codex-plugin", "plugin.json"))) return sourceRoot;

  const cacheRoot = path.join(os.homedir(), ".codex", "plugins", "cache", "personal", "agent-workflow");
  if (!fsSync.existsSync(cacheRoot)) return sourceRoot;
  const installed = fsSync.readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fsSync.existsSync(path.join(cacheRoot, entry.name, ".codex-plugin", "plugin.json")))
    .map((entry) => ({
      path: path.join(cacheRoot, entry.name),
      modifiedAt: fsSync.statSync(path.join(cacheRoot, entry.name)).mtimeMs
    }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  return installed[0]?.path ?? sourceRoot;
}

export function artifactAgeBucket(value: string): string {
  const ageMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  const days = ageMs / 86_400_000;
  if (days <= 1) return "0-1d";
  if (days <= 7) return "2-7d";
  if (days <= 30) return "8-30d";
  if (days <= 90) return "31-90d";
  return "90d+";
}

export function artifactAgeDays(value: string): number | null {
  const ageMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  return Math.floor(ageMs / 86_400_000);
}

export function artifactLifecycleCandidate(
  artifact: ArtifactLifecycleReport["recentArtifacts"][number],
  ageDays: number | null,
  reason: string,
  action: ArtifactLifecycleAction
): ArtifactLifecycleActionPlan["candidates"][number] {
  return {
    artifactId: artifact.id,
    uri: artifact.uri,
    runId: artifact.runId,
    taskId: artifact.taskId,
    projectName: artifact.projectName,
    projectRootUri: artifact.projectRootUri,
    workflowId: artifact.workflowId,
    runStatus: artifact.runStatus,
    kind: artifact.kind,
    contentBytes: artifact.contentBytes,
    createdAt: artifact.createdAt,
    ageDays,
    reason,
    receiptPreview: artifactLifecycleReceiptPreview({
      action,
      artifactId: artifact.id,
      uri: artifact.uri,
      runId: artifact.runId,
      taskId: artifact.taskId,
      kind: artifact.kind,
      contentBytes: artifact.contentBytes,
      reason
    })
  };
}

export function artifactLifecycleHint(artifact: DashboardArtifactLifecycleRow, ageBucket: string): string {
  if (artifact.kind === "action_approval" || artifact.kind === "run_feedback" || artifact.kind === "command_output" || artifact.kind === "file_write") {
    return "retain for audit";
  }
  if (artifact.runStatus === "failed" || artifact.runStatus === "running" || artifact.runStatus === "queued") {
    return "retain until run reviewed";
  }
  if ((ageBucket === "31-90d" || ageBucket === "90d+") && artifact.contentBytes > 20_000) {
    return "candidate for future prune plan";
  }
  return "retain by default";
}

export function artifactLifecyclePlanForAction(report: ArtifactLifecycleReport, action: ArtifactLifecycleAction): ArtifactPrunePlan | ArtifactLifecycleActionPlan | null {
  if (action === "prune") return report.prunePlan;
  if (action === "archive") return report.archivePlan;
  return report.restorePlan;
}

export function artifactLifecycleReceiptPreview(input: {
  action: ArtifactLifecycleAction;
  artifactId: string;
  uri: string;
  runId: string;
  taskId: string | null;
  kind: string;
  contentBytes: number;
  reason: string;
}): ArtifactLifecycleReceiptPreview {
  const requestedActionType: Record<ArtifactLifecycleAction, ArtifactLifecycleRequestedActionType> = {
    prune: "artifact_prune_requested",
    archive: "artifact_archive_requested",
    restore: "artifact_restore_requested"
  };
  return {
    actionType: requestedActionType[input.action],
    target: input.uri,
    summary: `Would request ${input.action} for ${input.kind} artifact ${input.artifactId}`,
    metadata: {
      mode: "dry-run",
      action: input.action,
      artifactId: input.artifactId,
      runId: input.runId,
      taskId: input.taskId,
      kind: input.kind,
      contentBytes: input.contentBytes,
      reason: input.reason
    }
  };
}

export function artifactPruneReason(artifact: ArtifactLifecycleReport["recentArtifacts"][number], ageDays: number | null, criteria: ArtifactPrunePlan["criteria"]): string | null {
  if (!criteria.includeAudit && isAuditArtifact(artifact)) return null;
  if (artifact.runStatus !== "completed" && artifact.runStatus !== "dismissed" && artifact.runStatus !== "cancelled") return null;
  if (ageDays === null || ageDays < criteria.minAgeDays) return null;
  if (artifact.contentBytes < criteria.minBytes) return null;
  return `${artifact.kind} is ${ageDays} day(s) old, ${formatBytes(artifact.contentBytes)}, and belongs to a ${artifact.runStatus} run.`;
}

export function buildArtifactArchivePlan(artifacts: ArtifactLifecycleReport["recentArtifacts"], criteria: ArtifactPrunePlan["criteria"]): ArtifactLifecycleActionPlan {
  if (criteria.legalHold) {
    return emptyArtifactLifecycleActionPlan("archive", criteria, "Project legal hold is enabled; archive candidates are suppressed.");
  }
  const candidates = artifacts.flatMap((artifact) => {
    const ageDays = artifactAgeDays(artifact.createdAt);
    const reason = artifactPruneReason(artifact, ageDays, criteria);
    if (!reason) return [];
    return [artifactLifecycleCandidate(artifact, ageDays, reason.replace("belongs to", "is ready for archive review and belongs to"), "archive")];
  });
  return {
    mode: "dry-run",
    action: "archive",
    generatedAt: new Date().toISOString(),
    criteria,
    totalCandidates: candidates.length,
    estimatedBytesRecoverable: candidates.reduce((sum, candidate) => sum + candidate.contentBytes + candidate.uri.length, 0),
    approvalRequired: criteria.requireApproval,
    notes: [
      "Dry run only. This plan does not archive, move, delete, or mutate artifacts.",
      "Approved archive execution copies artifacts into archived snapshots, records lifecycle receipts, and preserves restore metadata.",
      criteria.includeAudit ? "Audit artifacts were allowed into archive candidate selection by request." : `${artifacts.filter(isAuditArtifact).length} audit artifact(s) were excluded from archive candidate selection.`,
      ...(candidates.length ? [] : ["No artifacts matched the current archive criteria."])
    ],
    candidates
  };
}

export function buildArtifactLifecycleHints(artifacts: ArtifactLifecycleReport["recentArtifacts"], estimatedBytes: number, limit: number): string[] {
  const hints: string[] = [];
  const futurePruneCandidates = artifacts.filter((artifact) => artifact.lifecycleHint === "candidate for future prune plan");
  const failedRunArtifacts = artifacts.filter((artifact) => artifact.runStatus === "failed").length;
  const auditArtifacts = artifacts.filter((artifact) => artifact.lifecycleHint === "retain for audit").length;
  if (artifacts.length === limit) hints.push("Report hit the inspection limit; increase --limit before making lifecycle decisions.");
  if (futurePruneCandidates.length) hints.push(`${futurePruneCandidates.length} older large artifact(s) look like candidates for a future dry-run prune plan.`);
  if (failedRunArtifacts) hints.push(`${failedRunArtifacts} artifact(s) belong to failed runs; review failures before pruning any related evidence.`);
  if (auditArtifacts) hints.push(`${auditArtifacts} artifact(s) are audit evidence and should be retained unless project retention policy says otherwise.`);
  if (estimatedBytes === 0) hints.push("No artifact storage was found in the inspected window.");
  return hints;
}

export function buildArtifactPrunePlan(artifacts: ArtifactLifecycleReport["recentArtifacts"], criteria: ArtifactPrunePlan["criteria"]): ArtifactPrunePlan {
  if (criteria.legalHold) {
    return {
      mode: "dry-run",
      generatedAt: new Date().toISOString(),
      criteria,
      totalCandidates: 0,
      estimatedBytesRecoverable: 0,
      approvalRequired: criteria.requireApproval,
      notes: [
        "Dry run only. This plan does not delete, archive, or mutate artifacts.",
        "Project legal hold is enabled; prune candidates are suppressed."
      ],
      candidates: []
    };
  }
  const candidates = artifacts.flatMap((artifact) => {
    const ageDays = artifactAgeDays(artifact.createdAt);
    const reason = artifactPruneReason(artifact, ageDays, criteria);
    if (!reason) return [];
    return [{
      artifactId: artifact.id,
      uri: artifact.uri,
      runId: artifact.runId,
      taskId: artifact.taskId,
      projectName: artifact.projectName,
      projectRootUri: artifact.projectRootUri,
      workflowId: artifact.workflowId,
      runStatus: artifact.runStatus,
      kind: artifact.kind,
      contentBytes: artifact.contentBytes,
      createdAt: artifact.createdAt,
      ageDays,
      reason,
      receiptPreview: {
        actionType: "artifact_prune_requested" as const,
        target: artifact.uri,
        summary: `Would request pruning ${artifact.kind} artifact ${artifact.id}`,
        metadata: {
          mode: "dry-run" as const,
          action: "prune" as const,
          artifactId: artifact.id,
          runId: artifact.runId,
          taskId: artifact.taskId,
          kind: artifact.kind,
          contentBytes: artifact.contentBytes,
          reason
        }
      }
    }];
  });
  const estimatedBytesRecoverable = candidates.reduce((sum, candidate) => sum + candidate.contentBytes + candidate.uri.length, 0);
  const auditCount = artifacts.filter(isAuditArtifact).length;
  const notes = [
    "Dry run only. This plan does not delete, archive, or mutate artifacts.",
    "Any future prune execution must recheck current storage state, project policy, and approval requirements.",
    criteria.includeAudit ? "Audit artifacts were allowed into candidate selection by request." : `${auditCount} audit artifact(s) were excluded from candidate selection.`
  ];
  if (!candidates.length) {
    notes.push("No artifacts matched the current prune criteria.");
  }
  return {
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    criteria,
    totalCandidates: candidates.length,
    estimatedBytesRecoverable,
    approvalRequired: criteria.requireApproval,
    notes,
    candidates
  };
}

export async function buildArtifactRestorePlan(artifacts: ArtifactLifecycleReport["recentArtifacts"], criteria: ArtifactPrunePlan["criteria"]): Promise<ArtifactLifecycleActionPlan> {
  if (criteria.legalHold) {
    return emptyArtifactLifecycleActionPlan("restore", criteria, "Project legal hold is enabled; restore candidates are suppressed.");
  }
  const archivedArtifacts = artifacts.filter((artifact) => artifact.kind === "archived_artifact");
  const candidates: ArtifactLifecycleActionPlan["candidates"] = [];
  for (const artifact of archivedArtifacts) {
    const fullArtifact = await getArtifactByUri(artifact.uri);
    if (!fullArtifact || fullArtifact.content.originalActionType !== "artifact_archive") continue;
    const restoreMetadata = objectFromRecord(fullArtifact.content, "restoreMetadata");
    const target = stringFromRecord(restoreMetadata, "originalUri") || stringFromRecord(fullArtifact.content, "target");
    if (!target) continue;
    const ageDays = artifactAgeDays(artifact.createdAt);
    const reason = `Archived artifact snapshot can be reviewed for restore target ${target}.`;
    candidates.push({
      artifactId: artifact.id,
      uri: target,
      runId: artifact.runId,
      taskId: artifact.taskId,
      projectName: artifact.projectName,
      projectRootUri: artifact.projectRootUri,
      workflowId: artifact.workflowId,
      runStatus: artifact.runStatus,
      kind: "archived_artifact",
      contentBytes: artifact.contentBytes,
      createdAt: artifact.createdAt,
      ageDays,
      reason,
      receiptPreview: artifactLifecycleReceiptPreview({
        action: "restore",
        artifactId: artifact.id,
        uri: target,
        runId: artifact.runId,
        taskId: artifact.taskId,
        kind: "archived_artifact",
        contentBytes: artifact.contentBytes,
        reason
      })
    });
  }
  return {
    mode: "dry-run",
    action: "restore",
    generatedAt: new Date().toISOString(),
    criteria,
    totalCandidates: candidates.length,
    estimatedBytesRecoverable: 0,
    approvalRequired: criteria.requireApproval,
    notes: [
      "Dry run only. This plan does not restore, move, delete, or mutate artifacts.",
      "Restore candidates come only from archived artifact snapshots.",
      ...(candidates.length ? [] : ["No archived artifact snapshots were found in the inspected artifact window."])
    ],
    candidates
  };
}

export function buildMcpApprovalDiagnostics(events: Array<Record<string, unknown>>): RuntimeMonitorReport["mcpPipeline"]["approvalDiagnostics"] {
  const recentEvents = events.filter((event) => String(event.event ?? "").startsWith("approval-call-")).slice(-8);
  const lastCall = [...recentEvents].reverse().find((event) => event.event === "approval-call-start");
  const lastResult = [...recentEvents].reverse().find((event) => event.event === "approval-call-result");
  const lastCallAt = typeof lastCall?.ts === "string" ? lastCall.ts : null;
  const lastResultAt = typeof lastResult?.ts === "string" ? lastResult.ts : null;
  const lastExitCode = typeof lastResult?.exitCode === "number" ? lastResult.exitCode : null;
  const lastTimedOut = typeof lastResult?.timedOut === "boolean" ? lastResult.timedOut : null;
  const summary = !recentEvents.length
    ? "No MCP approval calls have been recorded in the recent stdio log window."
    : lastResult
      ? `Last MCP approval call finished with exit code ${lastExitCode ?? "unknown"}${lastTimedOut ? " after timing out" : ""}.`
      : "An MCP approval call started, but no result event is visible in the recent stdio log window; the client pipe may have closed mid-call.";
  return {
    recentEvents,
    lastCallAt,
    lastResultAt,
    lastExitCode,
    lastTimedOut,
    summary,
    fallbackCommand: "npm run agentflow -- approvals --status pending --run <run-id>"
  };
}

export function buildMcpClientReloadGuidance(input: {
  smoke: RuntimeMonitorReport["mcpPipeline"]["smoke"];
  lastSpawnAt: string | null;
  lastExitAt: string | null;
  lastExitCode: number | null;
  recentExitCount: number;
}): RuntimeMonitorReport["mcpPipeline"]["clientReload"] {
  const smokePassed = input.smoke.status === "passed";
  const recentExitAfterSpawn = Boolean(input.lastExitAt && (!input.lastSpawnAt || input.lastExitAt >= input.lastSpawnAt));
  const suspectedStalePipe = smokePassed && (recentExitAfterSpawn || input.recentExitCount > 1);
  const summary = suspectedStalePipe
    ? "Launcher smoke passed, but recent stdio exits suggest a Codex/IDE client pipe may be stale. Restart or reload the client/task if it still reports Transport closed."
    : smokePassed
      ? "Launcher smoke passed. If a specific Codex task still reports Transport closed, that task likely needs a client-side reload."
      : input.smoke.status === "failed"
        ? "Launcher smoke failed. Fix the launcher/server issue before restarting the client."
        : "Run MCP smoke before deciding whether this is an Agent Workflow launcher issue or a stale Codex/IDE pipe.";
  const steps = [
    "Run MCP Smoke from Runtime Monitor or `npm run runtime-monitor -- --check-mcp`.",
    "If smoke passes but Codex still reports `Transport closed`, restart the Codex task/app or reload the IDE MCP client so it creates a fresh stdio subprocess.",
    "If multiple old MCP sessions are shown, preview Cleanup Stale MCP Sessions and terminate only stale Agent Workflow sessions from this checkout.",
    "If smoke fails, inspect `.agent-workflow/runtime/mcp/launcher.log` and `.agent-workflow/runtime/mcp/stdio.log` before changing provider or storage settings."
  ];
  return { suspectedStalePipe, summary, steps };
}

export function buildMcpCommandDiagnostics(events: Array<Record<string, unknown>>): RuntimeMonitorReport["mcpPipeline"]["commandDiagnostics"] {
  const recentEvents = events.filter((event) => String(event.event ?? "").startsWith("command-")).slice(-10);
  const lastStart = [...recentEvents].reverse().find((event) => event.event === "command-start");
  const lastClose = [...recentEvents].reverse().find((event) => event.event === "command-close" || event.event === "command-error" || event.event === "command-timeout");
  const lastStartAt = typeof lastStart?.ts === "string" ? lastStart.ts : null;
  const lastCloseAt = typeof lastClose?.ts === "string" ? lastClose.ts : null;
  const lastOperation = typeof (lastClose ?? lastStart)?.operation === "string" ? String((lastClose ?? lastStart)?.operation) : null;
  const lastExitCode = typeof lastClose?.exitCode === "number" ? lastClose.exitCode : null;
  const lastTimedOut = typeof lastClose?.timedOut === "boolean" ? lastClose.timedOut : null;
  const summary = !recentEvents.length
    ? "No MCP-launched CLI command spans have been recorded in the recent stdio log window."
    : lastClose
      ? `Last MCP-launched CLI operation ${lastOperation ?? "unknown"} finished with exit code ${lastExitCode ?? "unknown"}${lastTimedOut ? " after timing out" : ""}.`
      : `MCP-launched CLI operation ${lastOperation ?? "unknown"} started, but no close event is visible in the recent stdio log window.`;
  return {
    recentEvents,
    lastStartAt,
    lastCloseAt,
    lastOperation,
    lastExitCode,
    lastTimedOut,
    summary
  };
}

export function emptyArtifactLifecycleActionPlan(action: "archive" | "restore", criteria: ArtifactPrunePlan["criteria"], note: string): ArtifactLifecycleActionPlan {
  return {
    mode: "dry-run",
    action,
    generatedAt: new Date().toISOString(),
    criteria,
    totalCandidates: 0,
    estimatedBytesRecoverable: 0,
    approvalRequired: criteria.requireApproval,
    notes: [
      "Dry run only. This plan does not mutate artifacts.",
      note
    ],
    candidates: []
  };
}

export function isAuditArtifact(artifact: { kind: string }): boolean {
  return artifact.kind === "action_approval" || artifact.kind === "run_feedback" || artifact.kind === "command_output" || artifact.kind === "file_write";
}

export async function loadArtifactLifecycleReport(input: { projectRootUri?: string; kind?: string; limit?: number; prunePlan?: boolean; archivePlan?: boolean; restorePlan?: boolean; minAgeDays?: number; minBytes?: number; includeAudit?: boolean } = {}): Promise<ArtifactLifecycleReport> {
  const projectRootUri = input.projectRootUri ? path.resolve(process.cwd(), input.projectRootUri) : null;
  const artifactKind = input.kind?.trim() || null;
  const limit = input.limit ?? 500;
  const retentionPolicy = await resolveArtifactLifecyclePolicy(projectRootUri);
  const artifacts = await listArtifactLifecycle({
    projectRootUri: projectRootUri ?? undefined,
    kind: artifactKind ?? undefined,
    limit
  });
  const recentArtifacts = artifacts.map((artifact) => {
    const ageBucket = artifactAgeBucket(artifact.createdAt);
    return {
      ...artifact,
      ageBucket,
      lifecycleHint: artifactLifecycleHint(artifact, ageBucket)
    };
  });
  const estimatedBytes = recentArtifacts.reduce((sum, artifact) => sum + artifact.contentBytes + artifact.uri.length, 0);
  const reviewHints = buildArtifactLifecycleHints(recentArtifacts, estimatedBytes, limit);
  const policySource = input.minAgeDays !== undefined || input.minBytes !== undefined || input.includeAudit !== undefined ? "override" : retentionPolicy.source;
  const prunePlan = input.prunePlan
    ? buildArtifactPrunePlan(recentArtifacts, {
      policySource,
      minAgeDays: input.minAgeDays ?? retentionPolicy.retentionDays,
      minBytes: input.minBytes ?? retentionPolicy.minPruneBytes,
      includeAudit: input.includeAudit ?? !retentionPolicy.retainAuditArtifacts,
      legalHold: retentionPolicy.legalHold,
      requireApproval: retentionPolicy.requireApprovalForPrune
    })
    : null;
  const archivePlan = input.archivePlan
    ? buildArtifactArchivePlan(recentArtifacts, prunePlan?.criteria ?? {
      policySource,
      minAgeDays: input.minAgeDays ?? retentionPolicy.retentionDays,
      minBytes: input.minBytes ?? retentionPolicy.minPruneBytes,
      includeAudit: input.includeAudit ?? !retentionPolicy.retainAuditArtifacts,
      legalHold: retentionPolicy.legalHold,
      requireApproval: retentionPolicy.requireApprovalForPrune
    })
    : null;
  const restorePlan = input.restorePlan
    ? await buildArtifactRestorePlan(recentArtifacts, prunePlan?.criteria ?? archivePlan?.criteria ?? {
      policySource,
      minAgeDays: input.minAgeDays ?? retentionPolicy.retentionDays,
      minBytes: input.minBytes ?? retentionPolicy.minPruneBytes,
      includeAudit: true,
      legalHold: retentionPolicy.legalHold,
      requireApproval: retentionPolicy.requireApprovalForPrune
    })
    : null;
  return {
    kind: "agentflow_artifact_lifecycle_report",
    generatedAt: new Date().toISOString(),
    projectRootUri,
    artifactKind,
    limit,
    retentionPolicy,
    prunePlan,
    archivePlan,
    restorePlan,
    approvalQueues: [],
    totalArtifacts: recentArtifacts.length,
    estimatedBytes,
    byProject: countStrings(recentArtifacts.map((artifact) => artifact.projectName)),
    byKind: countStrings(recentArtifacts.map((artifact) => artifact.kind)),
    byAgeBucket: countStrings(recentArtifacts.map((artifact) => artifact.ageBucket)),
    byRunStatus: countStrings(recentArtifacts.map((artifact) => artifact.runStatus)),
    reviewHints,
    recentArtifacts
  };
}

export function parseLaunchctlNumber(output: string, key: string): number | null {
  const pattern = new RegExp(`\\b${key}\\s*=\\s*(\\d+)\\b`);
  const match = output.match(pattern);
  return match ? Number.parseInt(match[1] ?? "", 10) : null;
}

export function parseLsofListener(output: string): { command: string; pid: number } | null {
  const line = output.split(/\r?\n/).slice(1).find((item) => item.trim());
  if (!line) return null;
  const parts = line.trim().split(/\s+/);
  const pid = Number.parseInt(parts[1] ?? "", 10);
  return Number.isFinite(pid) ? { command: parts[0] ?? "unknown", pid } : null;
}

export function processMatchesRuntimeRole(args: string, role: RuntimeMonitorReport["processes"][number]["role"]): boolean {
  if (role === "supervisor") return /scripts\/dev-agentflow\.mjs/.test(args);
  if (role === "dashboard") return /apps\/cli\/src\/index\.ts dashboard\b/.test(args) || /npm run agentflow dashboard\b/.test(args);
  if (role === "worker") return /apps\/cli\/src\/index\.ts worker\b/.test(args) || /npm run agentflow worker\b/.test(args);
  if (role === "learning-daemon") return /apps\/cli\/src\/index\.ts learning-daemon\b/.test(args) || /npm run agentflow learning-daemon\b/.test(args);
  if (role === "mcp") return /apps\/mcp\/src\/index\.(ts|js)/.test(args);
  return false;
}

export function renderRuntimeMonitorPanel(report: RuntimeMonitorReport, params: URLSearchParams = new URLSearchParams()): string {
  const sharedHostRows = report.sharedHost.services.map((service) => `
    <tr><td>${escapeHtml(service.endpoint.name)}</td><td><span class="status ${service.reachable ? "completed" : "failed"}">${service.reachable ? "OK" : "MISSING"}</span></td><td>${escapeHtml(service.message)}</td></tr>
  `).join("");
  const localRows = report.localServices.map((service) => `
    <tr><td>${escapeHtml(service.endpoint.name)}</td><td><span class="status ${service.reachable ? "completed" : "failed"}">${service.reachable ? "OK" : "MISSING"}</span></td><td>${escapeHtml(service.message)}</td></tr>
  `).join("");
  const portRows = report.ports.map((port) => `
    <tr><td>${escapeHtml(port.label)}<br><span class="muted">:${port.port}</span></td><td><span class="status ${port.status === "listening" ? "completed" : "queued"}">${escapeHtml(port.status)}</span></td><td>${port.pid ? `pid ${port.pid}` : "none"}</td><td>${escapeHtml(port.command || "")}</td></tr>
  `).join("");
  const processRows = report.processes.map((processGroup) => `
    <tr><td>${escapeHtml(processGroup.role)}</td><td><span class="status ${processGroup.status === "ok" ? "completed" : "queued"}">${escapeHtml(processGroup.status)}</span></td><td>${formatNumber(processGroup.count)}</td><td>${processGroup.pids.map((pid) => `<code>${pid}</code>`).join(" ") || "none"}</td><td>${escapeHtml(processGroup.detail)}</td></tr>
  `).join("");
  const cleanupRows = report.mcpCleanup.candidates.map((candidate) => `
    <label class="bulk-approval-row">
      <input type="checkbox" name="pid" value="${candidate.pid}" checked>
      <span><strong>PID ${candidate.pid}</strong> parent ${candidate.parentPid ?? "n/a"} · <span class="flag ${candidate.autoCleanable ? "good" : "queued"}">${candidate.autoCleanable ? "auto-cleanable" : candidate.risk}</span><br><span class="muted">age ${candidate.ageMs === null ? "n/a" : escapeHtml(formatDuration(candidate.ageMs))} · session ${escapeHtml(candidate.sessionKey)}</span><br><span class="muted">${escapeHtml(candidate.reason)}</span><br><code>${escapeHtml(compactDashboardText(candidate.command, 220))}</code></span>
    </label>
  `).join("");
  const staleRunRows = report.staleRuns.candidates.map((run) => `
    <tr>
      <td><a href="/run?id=${encodeURIComponent(run.runId)}">${escapeHtml(run.runId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(run.workflowId)}</span></td>
      <td><span class="status queued">${escapeHtml(run.runStatus)}</span> -> <span class="status completed">${escapeHtml(run.recommendedStatus)}</span></td>
      <td>${formatNumber(run.completedTasks)}/${formatNumber(run.totalTasks)} completed<br><span class="muted">${formatNumber(run.cancelledTasks)} cancelled</span></td>
      <td>${renderDashboardDateTime(run.startedAt, "n/a")}</td>
      <td>${escapeHtml(compactDashboardText(run.task, 160))}<br><span class="muted">${escapeHtml(run.projectRootUri)}</span></td>
    </tr>
  `).join("");
  const containerRows = report.docker.containers.map((container) => `
    <tr><td>${escapeHtml(container.name)}</td><td>${escapeHtml(container.image)}</td><td>${escapeHtml(container.ports)}</td></tr>
  `).join("");
  const mcpStdioRows = report.mcpPipeline.lastStdioEvents.slice(-6).reverse().map((event) => `
    <tr><td>${escapeHtml(String(event.ts ?? ""))}</td><td>${escapeHtml(String(event.event ?? ""))}</td><td><code>${escapeHtml(JSON.stringify(event))}</code></td></tr>
  `).join("");
  const mcpLauncherRows = report.mcpPipeline.lastLauncherEvents.slice(-6).reverse().map((event) => `
    <tr><td>${escapeHtml(String(event.ts ?? ""))}</td><td>${escapeHtml(String(event.event ?? ""))}</td><td><code>${escapeHtml(JSON.stringify(event))}</code></td></tr>
  `).join("");
  const mcpApprovalRows = report.mcpPipeline.approvalDiagnostics.recentEvents.slice(-6).reverse().map((event) => `
    <tr><td>${escapeHtml(String(event.ts ?? ""))}</td><td>${escapeHtml(String(event.event ?? ""))}</td><td><code>${escapeHtml(JSON.stringify(event))}</code></td></tr>
  `).join("");
  const mcpCommandRows = report.mcpPipeline.commandDiagnostics.recentEvents.slice(-6).reverse().map((event) => `
    <tr><td>${escapeHtml(String(event.ts ?? ""))}</td><td>${escapeHtml(String(event.event ?? ""))}</td><td>${escapeHtml(String(event.operation ?? "unknown"))}</td><td>${escapeHtml(String(event.exitCode ?? event.timedOut ?? ""))}</td><td><code>${escapeHtml(JSON.stringify(event))}</code></td></tr>
  `).join("");
  const mcpReloadSteps = report.mcpPipeline.clientReload.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("");
  const mcpReloadClass = report.mcpPipeline.clientReload.suspectedStalePipe ? "failed" : report.mcpPipeline.smoke.status === "passed" ? "completed" : "queued";
  const recommendations = report.recommendations.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  return `<section class="panel">
    <div class="section-heading">
      <div><h2>Runtime Monitor</h2><span class="muted">Local process inventory plus shared host/shared storage and localhost fallback health.</span></div>
      <a class="button secondary" href="/api/runtime-monitor">JSON</a>
    </div>
    <div class="metric-grid">
      ${metricCard("shared host", report.sharedHost.reachable ? "online" : "attention", report.sharedHost.host ?? "not configured")}
      ${metricCard("Local Fallback", report.localServices.every((service) => service.reachable) ? "ready" : "stopped", "localhost storage services")}
      ${metricCard("Docker", report.docker.status, report.docker.message)}
      ${metricCard("Local Model", report.localModelRuntime.endpointHealthy ? "online" : "attention", `${report.localModelRuntime.serviceStatus} · ${report.localModelRuntime.modelCount} models`)}
      ${metricCard("MCP Processes", report.processes.find((item) => item.role === "mcp")?.count ?? 0, "active local MCP server processes")}
      ${metricCard("MCP Pipeline", report.mcpPipeline.status, report.mcpPipeline.smoke.status === "passed" ? `${report.mcpPipeline.smoke.toolCount ?? 0} tools verified` : report.mcpPipeline.smoke.message)}
      ${metricCard("Stale Runs", report.staleRuns.candidateCount, report.staleRuns.autoReconcile.enabled ? "daemon auto-reconcile on" : "manual reconcile")}
    </div>
    <details class="governance-details"${!report.localModelRuntime.endpointHealthy ? " open" : ""}>
      <summary>Durable Local Model Runtime (${escapeHtml(report.localModelRuntime.serviceStatus)})</summary>
      <p class="muted">A dedicated LaunchAgent owns local inference so model failures do not restart the dashboard, workers, or learning daemon. Its wrapper resolves the current Homebrew Ollama symlink on every start, avoiding version-pinned executable paths after upgrades.</p>
      <div class="meta-grid compact">
        <div><strong>Runtime</strong>${escapeHtml(report.localModelRuntime.runtime)}</div>
        <div><strong>Executable</strong><code>${escapeHtml(report.localModelRuntime.executable ?? "not installed")}</code></div>
        <div><strong>Service</strong>${escapeHtml(report.localModelRuntime.serviceStatus)}${report.localModelRuntime.pid ? ` · pid ${report.localModelRuntime.pid}` : ""}</div>
        <div><strong>Endpoint</strong>${report.localModelRuntime.endpointHealthy ? "healthy" : "unavailable"} · <code>${escapeHtml(report.localModelRuntime.endpoint)}</code></div>
        <div><strong>Models</strong>${formatNumber(report.localModelRuntime.modelCount)}</div>
        <div><strong>Selected Model</strong>${escapeHtml(report.localModelRuntime.selectedModel)}</div>
        <div><strong>Plist</strong><code>${escapeHtml(report.localModelRuntime.plistPath)}</code></div>
        <div><strong>Logs</strong><code>${escapeHtml(report.localModelRuntime.stdoutPath)}</code><br><code>${escapeHtml(report.localModelRuntime.stderrPath)}</code></div>
      </div>
      <div class="callout ${report.localModelRuntime.endpointHealthy ? "completed" : "queued"}"><strong>Next action</strong><p>${escapeHtml(report.localModelRuntime.guidance)}</p></div>
      <p><code>${escapeHtml(report.localModelRuntime.installCommand)}</code></p>
      <p><code>${escapeHtml(report.localModelRuntime.restartCommand)}</code></p>
    </details>
    <div class="meta-grid compact">
      <div><strong>Generated</strong>${renderDashboardDateTime(report.generatedAt)}</div>
      <div><strong>Shared Host Source</strong>${escapeHtml(report.sharedHost.source)}</div>
      <div><strong>Storage Host</strong>${escapeHtml(report.storageHost ?? "not configured")}</div>
      <div><strong>Docker Detail</strong>${escapeHtml(report.docker.message)}</div>
    </div>
    <div class="split-grid">
      <div><h3>shared host / Shared Storage</h3><div class="table-wrap"><table><thead><tr><th>Service</th><th>Status</th><th>Detail</th></tr></thead><tbody>${sharedHostRows || '<tr><td colspan="3">No shared storage host configured.</td></tr>'}</tbody></table></div></div>
      <div><h3>Local Fallback Storage</h3><div class="table-wrap"><table><thead><tr><th>Service</th><th>Status</th><th>Detail</th></tr></thead><tbody>${localRows}</tbody></table></div></div>
    </div>
    <h3>Local Ports</h3>
    <div class="table-wrap"><table><thead><tr><th>Port</th><th>Status</th><th>PID</th><th>Command</th></tr></thead><tbody>${portRows}</tbody></table></div>
    <h3>Agent Workflow Processes</h3>
    <div class="table-wrap"><table><thead><tr><th>Role</th><th>Status</th><th>Count</th><th>PIDs</th><th>Detail</th></tr></thead><tbody>${processRows}</tbody></table></div>
    <details class="governance-details"${report.staleRuns.candidateCount ? " open" : ""}>
      <summary>Reconcile Stale Terminal Runs (${formatNumber(report.staleRuns.candidateCount)} candidate${report.staleRuns.candidateCount === 1 ? "" : "s"})</summary>
      <p class="muted">Repairs parent workflow runs that still show queued/running even though every child task is already terminal. The daemon can do this automatically because it only updates Agent Workflow run bookkeeping and writes a receipt.</p>
      <div class="meta-grid compact">
        <div><strong>Daemon Auto Reconcile</strong>${report.staleRuns.autoReconcile.enabled ? "on" : "off"}</div>
        <div><strong>Limit</strong>${formatNumber(report.staleRuns.autoReconcile.limit)}</div>
        <div><strong>Preview CLI</strong><code>${escapeHtml(report.staleRuns.previewCommand)}</code></div>
        <div><strong>Execute CLI</strong><code>${escapeHtml(report.staleRuns.executeCommand)}</code></div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Run</th><th>Status</th><th>Tasks</th><th>Started</th><th>Task</th></tr></thead><tbody>${staleRunRows || '<tr><td colspan="5">No stale terminal workflow runs found.</td></tr>'}</tbody></table></div>
      ${report.staleRuns.candidateCount ? `<form method="post" action="/api/runtime-monitor-action">
        ${dashboardReturnInput("/server-readiness", params)}
        <input type="hidden" name="action" value="reconcile-stale-runs">
        <button type="submit">Reconcile Stale Runs</button>
      </form>` : ""}
    </details>
    <details class="governance-details"${report.mcpPipeline.status !== "ok" || report.mcpPipeline.smoke.status !== "not-run" ? " open" : ""}>
      <summary>MCP Pipeline (${escapeHtml(report.mcpPipeline.status)})</summary>
      <p class="muted">Codex starts Agent Workflow MCP on demand over stdio, so zero active MCP processes can be normal between tool calls. This section checks the plugin launcher path instead.</p>
      <div class="meta-grid compact">
        <div><strong>Plugin</strong>${report.mcpPipeline.pluginEnabled ? "enabled" : "disabled"}</div>
        <div><strong>Launcher</strong>${report.mcpPipeline.launcherExists ? "found" : "missing"}${report.mcpPipeline.launcherExecutable ? " / executable" : ""}</div>
        <div><strong>Repo</strong>${escapeHtml(report.mcpPipeline.resolvedRepo ?? "not resolved")}</div>
        <div><strong>Built Server</strong>${report.mcpPipeline.serverBuilt ? "yes" : "no"}</div>
        <div><strong>Last Spawn</strong>${renderDashboardDateTime(report.mcpPipeline.lastSpawnAt)}</div>
        <div><strong>Last Exit</strong>${renderDashboardDateTime(report.mcpPipeline.lastExitAt)}${report.mcpPipeline.lastExitCode === null ? "" : ` code ${report.mcpPipeline.lastExitCode}`}</div>
        <div><strong>Smoke</strong>${escapeHtml(report.mcpPipeline.smoke.status)} · ${escapeHtml(report.mcpPipeline.smoke.message)}</div>
        <div><strong>Smoke CLI</strong><code>${escapeHtml(report.mcpPipeline.smoke.command)}</code></div>
        <div><strong>Launcher Log</strong><code>${escapeHtml(report.mcpPipeline.launcherLogPath)}</code></div>
        <div><strong>Stdio Log</strong><code>${escapeHtml(report.mcpPipeline.stdioLogPath)}</code></div>
      </div>
      <div class="callout ${mcpReloadClass}">
        <strong>Codex / IDE Reload Guidance</strong>
        <p>${escapeHtml(report.mcpPipeline.clientReload.summary)}</p>
        <ul>${mcpReloadSteps}</ul>
      </div>
      <div class="callout queued">
        <strong>MCP Approval-Call Diagnostics</strong>
        <p>${escapeHtml(report.mcpPipeline.approvalDiagnostics.summary)}</p>
        <p><code>${escapeHtml(report.mcpPipeline.approvalDiagnostics.fallbackCommand)}</code></p>
      </div>
      <div class="callout queued">
        <strong>MCP Command Spans</strong>
        <p>${escapeHtml(report.mcpPipeline.commandDiagnostics.summary)}</p>
      </div>
      <div class="callout ${report.mcpPipeline.recovery.status === "available" ? "completed" : "queued"}">
        <strong>MCP Recovery Package</strong>
        <p>${escapeHtml(report.mcpPipeline.recovery.recommendedAction)}</p>
        <div class="meta-grid compact">
          <div><strong>Status</strong>${escapeHtml(report.mcpPipeline.recovery.status)}</div>
          <div><strong>Last Written</strong>${renderDashboardDateTime(report.mcpPipeline.recovery.lastWrittenAt)}</div>
          <div><strong>Can Restart Client Pipe</strong>${report.mcpPipeline.recovery.canRestartClientPipe ? "yes" : "no"}</div>
          <div><strong>Reason</strong>${escapeHtml(report.mcpPipeline.recovery.reason)}</div>
          <div><strong>Runbook</strong><code>${escapeHtml(report.mcpPipeline.recovery.markdownPath)}</code></div>
          <div><strong>Script</strong><code>${escapeHtml(report.mcpPipeline.recovery.scriptPath)}</code></div>
        </div>
      </div>
      <div class="button-row">
        <form method="post" action="/api/runtime-monitor-action">
          ${dashboardReturnInput("/server-readiness", params)}
          <input type="hidden" name="action" value="check-mcp">
          <button type="submit">Run MCP Smoke</button>
        </form>
        <form method="post" action="/api/runtime-monitor-action">
          ${dashboardReturnInput("/server-readiness", params)}
          <input type="hidden" name="action" value="write-mcp-recovery">
          <button type="submit">Write Recovery Package</button>
        </form>
      </div>
      <div class="split-grid">
        <div><h3>Launcher Events</h3><div class="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead><tbody>${mcpLauncherRows || '<tr><td colspan="3">No launcher events recorded.</td></tr>'}</tbody></table></div></div>
        <div><h3>Stdio Events</h3><div class="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead><tbody>${mcpStdioRows || '<tr><td colspan="3">No stdio events recorded.</td></tr>'}</tbody></table></div></div>
      </div>
      <h3>Approval Call Events</h3>
      <div class="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead><tbody>${mcpApprovalRows || '<tr><td colspan="3">No MCP approval calls recorded in the recent log window.</td></tr>'}</tbody></table></div>
      <h3>Command Span Events</h3>
      <div class="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Operation</th><th>Exit/Timeout</th><th>Detail</th></tr></thead><tbody>${mcpCommandRows || '<tr><td colspan="5">No MCP command spans recorded in the recent log window.</td></tr>'}</tbody></table></div>
    </details>
    <details class="governance-details"${report.mcpCleanup.candidateCount ? " open" : ""}>
      <summary>Cleanup Stale MCP Sessions (${formatNumber(report.mcpCleanup.candidateCount)} candidate${report.mcpCleanup.candidateCount === 1 ? "" : "s"})</summary>
      <p class="muted">Preview-only by default. These candidates are limited to Agent Workflow MCP commands from this checkout.</p>
      <div class="meta-grid compact">
        <div><strong>Daemon Auto Cleanup</strong>${report.mcpCleanup.autoCleanup.enabled ? escapeHtml(report.mcpCleanup.autoCleanup.mode) : "off"}</div>
        <div><strong>Stale Threshold</strong>${formatNumber(report.mcpCleanup.autoCleanup.staleMinutes)} min</div>
        <div><strong>Auto-cleanable</strong>${formatNumber(report.mcpCleanup.candidates.filter((candidate) => candidate.autoCleanable).length)}</div>
        <div><strong>Preview CLI</strong><code>${escapeHtml(report.mcpCleanup.previewCommand)}</code></div>
        <div><strong>Execute CLI</strong><code>${escapeHtml(report.mcpCleanup.executeCommand)}</code></div>
        <div><strong>Auto Low Risk CLI</strong><code>${escapeHtml(`${report.mcpCleanup.executeCommand} --auto-low-risk`)}</code></div>
      </div>
      ${cleanupRows ? `<form class="bulk-approval-form" method="post" action="/api/runtime-monitor-action">
        ${dashboardReturnInput("/server-readiness", params)}
        <input type="hidden" name="action" value="cleanup-mcp">
        <div class="bulk-approval-list">${cleanupRows}</div>
        <label class="checkbox-row"><input type="checkbox" name="confirmed" required> Confirm terminating the selected Agent Workflow MCP candidate processes</label>
        <button class="danger" type="submit">Terminate Selected MCP Candidates</button>
      </form>` : `<p>No Agent Workflow MCP cleanup candidates found.</p>`}
    </details>
    ${containerRows ? `<details class="governance-details"><summary>Docker Containers</summary><div class="table-wrap"><table><thead><tr><th>Name</th><th>Image</th><th>Ports</th></tr></thead><tbody>${containerRows}</tbody></table></div></details>` : ""}
    <ul>${recommendations}</ul>
  </section>`;
}

export function renderWorkerStatusHtml(worker: DashboardWorkerStatus, options: { compact?: boolean } = {}): string {
  const age = worker.ageMs === null ? "n/a" : formatDuration(Math.max(0, worker.ageMs));
  const extraLanes = worker.lanes.filter((lane) => lane.heartbeatPath !== worker.heartbeatPath);
  const activeLanes = worker.lanes.filter((lane) => lane.status === "running").length;
  const displayedLanes = [
    ...worker.lanes.filter((lane) => lane.status === "running"),
    ...worker.lanes.filter((lane) => lane.status !== "running")
  ].slice(0, 3);
  const hiddenLanes = Math.max(0, worker.lanes.length - displayedLanes.length);
  const probeSummary=(worker.executionCapabilityProbes??[]).map(probe=>`${probe.id}: ${probe.status} · runtime ${probe.runtimeVersion} · ${probe.digest.slice(0,12)}${probe.reason?` · ${probe.reason}`:""}`).join(" | ")||"none recorded";
  const remoteFleetRows=(worker.remoteFleetTrust??[]).map(host=>`<tr><td>${escapeHtml(host.hostId)}</td><td><span class="status ${host.state==="trusted"?"completed":host.state==="not-delivered"?"queued":"failed"}">${escapeHtml(host.state)}</span><br><span class="muted">${escapeHtml(host.trustState)}</span></td><td>${host.deliveryLagMs===null?"n/a":escapeHtml(formatDuration(host.deliveryLagMs))}</td><td>${host.workerFreshnessMs===null?"n/a":escapeHtml(formatDuration(host.workerFreshnessMs))}</td><td>${escapeHtml(host.runtimeBuildDigest?.slice(0,16)??"none")}</td><td>${escapeHtml(host.keyLifecycle)}${host.nextKeyExpiryAt?`<br><span class="muted">${renderDashboardDateTime(host.nextKeyExpiryAt)}</span>`:""}</td><td>${escapeHtml(host.trustReason)}</td></tr>`).join("");
  const detail = `
    <div class="meta-grid">
      <div><strong>Status</strong><span class="status ${worker.status === "running" ? "completed" : worker.status === "missing" ? "queued" : "failed"}">${escapeHtml(worker.status)}</span></div>
      <div><strong>Worker ID</strong>${escapeHtml(worker.workerId ?? "none")}</div>
      <div><strong>Host Identity</strong>${escapeHtml(worker.hostId ?? "legacy local")}</div>
      <div><strong>Heartbeat Trust</strong>${escapeHtml(worker.heartbeatTrustState ?? "unknown")} · ${escapeHtml(worker.heartbeatTrustReason ?? "no trust decision")}</div>
      <div><strong>Runtime Build</strong>${escapeHtml(worker.runtimeBuildDigest?.slice(0,16) ?? "not attested")}</div>
      <div><strong>PID</strong>${worker.pid ?? "none"}</div>
      <div><strong>Process</strong>${worker.processAlive ? "alive" : "not running"}</div>
      <div><strong>Last Heartbeat</strong>${renderDashboardDateTime(worker.lastHeartbeatAt, "none")}</div>
      <div><strong>Heartbeat Age</strong>${escapeHtml(age)}</div>
      <div><strong>Tick Count</strong>${formatNumber(worker.ticks)}</div>
      <div><strong>Worker Limit</strong>${worker.limit ?? "n/a"}</div>
      <div><strong>Project Scope</strong>${escapeHtml(worker.projectRootUri ?? "all projects")}</div>
      <div><strong>Project Identity</strong>${escapeHtml(worker.projectIdentityId ?? (worker.projectRootUri ? "unavailable" : "all projects"))}</div>
      <div><strong>Identity Generation</strong>${worker.projectIdentityGeneration ?? "n/a"}</div>
      <div><strong>Source Revision</strong>${escapeHtml(worker.sourceRevision?.slice(0,12) ?? (worker.projectRootUri ? "unavailable" : "not scoped"))}</div>
      <div><strong>Concurrency</strong>${worker.concurrency ?? "n/a"}</div>
      <div><strong>Per-project cap</strong>${worker.perProjectConcurrency ?? "n/a"}</div>
      <div><strong>Interval</strong>${worker.intervalMs ? formatDuration(worker.intervalMs) : "n/a"}</div>
      <div><strong>Ready Providers</strong>${escapeHtml(worker.providerIds?.join(", ") || "legacy/unknown")}</div>
      <div><strong>Unavailable Providers</strong>${escapeHtml(worker.unavailableProviderIds?.join(", ") || "none")}</div>
      <div><strong>Execution Capabilities</strong>${escapeHtml(worker.executionCapabilities?.join(", ") || "none")}</div>
      <div><strong>Capability Probes</strong>${escapeHtml(probeSummary)}</div>
    </div>
    <div class="meta-grid compact">
      <div><strong>Last Tick</strong>${worker.claimed} claimed / ${worker.completed} completed / ${worker.failed} failed</div>
      <div><strong>Heartbeat File</strong>${escapeHtml(worker.heartbeatPath)}</div>
      <div><strong>Start Command</strong><code>${escapeHtml(worker.command || "npm run worker:daemon")}</code></div>
    </div>
    ${worker.lanes.length > 1 ? `<h3>Worker Lanes</h3><div class="table-wrap"><table><thead><tr><th>Worker</th><th>Status / trust</th><th>Providers</th><th>Project</th><th>Concurrency</th><th>Last heartbeat</th><th>Last tick</th></tr></thead><tbody>${displayedLanes.map((lane) => `<tr><td>${escapeHtml(lane.workerId ?? "unknown")}<br><span class="muted">${escapeHtml(lane.hostId ?? "legacy local")}</span></td><td><span class="status ${lane.status === "running" ? "completed" : lane.status === "stopped" ? "queued" : "failed"}">${escapeHtml(lane.status)}</span><br><span class="muted">${escapeHtml(lane.heartbeatTrustState ?? "unknown")}</span></td><td>${escapeHtml(lane.providerIds?.join(", ") || "legacy/unknown")}</td><td>${escapeHtml(lane.projectRootUri ?? "all projects")}</td><td>${lane.concurrency ?? "n/a"}</td><td>${renderDashboardDateTime(lane.lastHeartbeatAt, "none")}</td><td>${lane.claimed} / ${lane.completed} / ${lane.failed}</td></tr>`).join("")}</tbody></table></div>` : ""}
    <h3>Remote Fleet Attestation</h3>${remoteFleetRows?`<div class="table-wrap"><table><thead><tr><th>Host</th><th>State / trust</th><th>Delivery lag</th><th>Worker freshness</th><th>Runtime build</th><th>Key lifecycle</th><th>Evidence</th></tr></thead><tbody>${remoteFleetRows}</tbody></table></div>`:`<p class="muted">No remote fleet hosts are enrolled. Local live-process trust remains separate.</p>`}
    ${extraLanes.length ? `<p class="muted">Showing ${formatNumber(displayedLanes.length)} of ${formatNumber(worker.lanes.length)} discovered worker lane${worker.lanes.length === 1 ? "" : "s"} from the local heartbeat registry${hiddenLanes ? `; ${formatNumber(hiddenLanes)} older inactive lane${hiddenLanes === 1 ? "" : "s"} hidden.` : "."}</p>` : ""}
  `;
  if (!options.compact) return detail;
  return `
    <div class="worker-summary">
      <div><strong><span class="status ${worker.status === "running" ? "completed" : worker.status === "missing" ? "queued" : "failed"}">${escapeHtml(worker.status)}</span></strong><span>${escapeHtml(workerStatusDetail(worker))}</span></div>
      <div><strong>${formatNumber(activeLanes || Number(worker.status === "running"))}</strong><span>active lane${(activeLanes || Number(worker.status === "running")) === 1 ? "" : "s"}</span></div>
      <div><strong>${worker.claimed} / ${worker.completed} / ${worker.failed}</strong><span>last tick</span></div>
      <div><strong>${escapeHtml(age)}</strong><span>heartbeat age</span></div>
    </div>
    <details class="governance-details compact-details">
      <summary>Worker details and lanes</summary>
      ${detail}
    </details>
  `;
}

export async function resolveArtifactLifecyclePolicy(projectRootUri: string | null): Promise<ArtifactLifecyclePolicy> {
  const fallback: ArtifactLifecyclePolicy = {
    source: "default",
    retentionDays: 30,
    minPruneBytes: 20_000,
    retainAuditArtifacts: true,
    legalHold: false,
    requireApprovalForPrune: true,
    allowArchiveExecution: false,
    allowRestoreExecution: false,
    allowPruneExecution: false
  };
  const localProjectRootUri = projectRootUri ? await resolveLocalProjectRootUri(projectRootUri) : null;
  if (!localProjectRootUri || !await pathExists(path.join(localProjectRootUri, ".agent-workflow", "project.yaml"))) {
    return fallback;
  }
  try {
    const project = await loadProjectConfig(localProjectRootUri);
    return lifecyclePolicyFromProject(project, "project");
  } catch {
    return fallback;
  }
}

export function resolveSharedHostStorageTarget(): { host: string | null; source: RuntimeMonitorReport["sharedHost"]["source"] } {
  if (process.env.AGENTFLOW_SHARED_STORAGE_HOST?.trim()) {
    return { host: process.env.AGENTFLOW_SHARED_STORAGE_HOST.trim(), source: "AGENTFLOW_SHARED_STORAGE_HOST" };
  }
  const configured = defaultServiceEndpoints();
  const nonLocal = configured.find((service) => !isLoopbackBind(service.host));
  return nonLocal ? { host: nonLocal.host, source: "configured-endpoints" } : { host: null, source: "not-configured" };
}

export function runtimeMonitorRecommendations(input: {
  sharedHostReachable: boolean;
  localServicesReachable: boolean;
  docker: RuntimeMonitorReport["docker"];
  processes: RuntimeMonitorReport["processes"];
  mcpPipeline: RuntimeMonitorReport["mcpPipeline"];
  staleRunCount: number;
  localModelRuntime?: RuntimeMonitorReport["localModelRuntime"];
}): string[] {
  const notes: string[] = [];
  if (input.sharedHostReachable) notes.push("shared host/shared storage is reachable and can remain the primary state plane.");
  else notes.push("shared host/shared storage is not fully reachable; use offline fallback before queueing new shared-state work.");
  if (!input.localServicesReachable) notes.push("Local Postgres/Redis/MinIO fallback services are stopped or incomplete, which is expected while shared host is healthy.");
  if (input.docker.status === "unavailable") notes.push("Docker/Colima is unavailable from this shell, so local fallback containers cannot be inspected here.");
  const mcp = input.processes.find((processGroup) => processGroup.role === "mcp");
  if (mcp && mcp.count > 4) notes.push("Consider restarting Codex or cleaning stale MCP sessions if MCP calls behave inconsistently.");
  if (input.mcpPipeline.status !== "ok") notes.push("MCP pipeline needs attention; run npm run runtime-monitor -- --check-mcp and restart Codex if the launcher passes but Codex still reports Transport closed.");
  else notes.push("MCP pipeline is configured for on-demand stdio launch; zero active MCP processes can be normal between Codex calls.");
  if (input.staleRunCount > 0) notes.push(`${input.staleRunCount} stale terminal workflow run(s) can be reconciled because all child tasks are already terminal.`);
  if (input.localModelRuntime && !input.localModelRuntime.endpointHealthy) notes.push(input.localModelRuntime.guidance);
  return notes;
}

export function runtimeProcessDetail(role: RuntimeMonitorReport["processes"][number]["role"], count: number, physicalCount = count): string {
  if (role === "mcp" && count > 4) return "Multiple MCP server processes are active. This can be normal across Codex sessions, but stale duplicates are worth cleaning up.";
  if (role === "mcp" && count === 0) return "No MCP process is currently active; Codex starts the stdio MCP server on demand.";
  if (count === 0) return `${role} process was not found locally.`;
  const physical = physicalCount > count ? ` (${physicalCount} wrapper/child processes)` : "";
  return `${count} logical ${role} process${count === 1 ? "" : "es"} found locally${physical}.`;
}

export function runtimeProcessGroupKey(
  row: { pid: number; parentPid: number | null; args: string },
  role: RuntimeMonitorReport["processes"][number]["role"],
  rowsByPid: Map<number, { pid: number; parentPid: number | null; args: string }>
): string {
  let current = row;
  let root = row;
  const seen = new Set<number>();
  while (current.parentPid && !seen.has(current.parentPid)) {
    seen.add(current.pid);
    const parent = rowsByPid.get(current.parentPid);
    if (!parent || !processMatchesRuntimeRole(parent.args, role)) {
      break;
    }
    root = parent;
    current = parent;
  }
  return `${role}:${root.pid}`;
}

export async function tailJsonl(filePath: string, maxLines: number): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) return [];
  return raw.trim().split(/\r?\n/).slice(-maxLines).map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { event: "unparseable", detail: compactDashboardText(line, 240) };
    }
  });
}

export function workerStatusDetail(worker: DashboardWorkerStatus): string {
  if (worker.status === "running") {
    return `Worker ${worker.workerId ?? "unknown"} is processing queued stages. Last heartbeat ${worker.ageMs === null ? "unknown" : `${formatDuration(Math.max(0, worker.ageMs))} ago`}.`;
  }
  if (worker.status === "missing") {
    return "No worker heartbeat found. Start one with npm run worker:daemon.";
  }
  if (worker.status === "stopped") {
    return "Worker stopped cleanly. Start one with npm run worker:daemon.";
  }
  return "Worker heartbeat is stale. Restart with npm run worker:daemon, or requeue interrupted stages from Queue.";
}
