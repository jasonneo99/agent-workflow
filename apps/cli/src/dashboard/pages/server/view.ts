import { artifactLifecyclePlanForAction } from "../../data/runtime-monitor.js";
import { titleCase, formatNumber } from "../../ui/format.js";
import { escapeHtml, dashboardNav, renderDashboardFlash, renderDashboardActionHistory, renderDashboardDateTime, metricCard, dashboardReturnInput } from "../../ui/layout.js";
import type { ArtifactLifecycleAction, DashboardProjectSummary, ObjectArtifactProofReport, OfflineFallbackReport, RuntimeMonitorReport, ServerApprovalActionPlanReport, ServerApprovalActionTestAdapterReport, ServerAuthHardeningReport, ServerMutationControlReport, ServerReadinessReport, ServerRequestAuditEvent, ServerRequestAuditReport, StorageMergeEvidenceListing } from "../../../lib/cli-types.js";
import { classifyApprovalAutopilotRisk } from "../../../lib/builders-approvals.js";
import { formatDashboardDateTimeText } from "../../../lib/builders-runs.js";
import { firstHeader, hashAuditValue, rejectProjectIdReason, requestContentLength, serverAuditErrorCode, validateServerMutationAuth } from "../../../lib/builders-server.js";
import { formatBytes, formatInlineCounts, isOpenApproval, loadLocalProjectConfig, shellQuote, stableHash, stringValue, truncateText } from "../../../lib/builders-shared.js";
import { type ProjectConfig } from "../../../../../../packages/agent-registry/src/schemas.js";
import { type HighRiskApprovalInbox, buildHighRiskApprovalInbox, redactApprovalCardText } from "../../../../../../packages/governance/src/high-risk-approval-inbox.js";
import { parseRoadmapSnapshot, serverRoadmapSnapshot } from "../../../../../../packages/roadmap/src/index.js";
import { checkServices } from "../../../../../../packages/storage/src/doctor.js";
import { getProjectIndexState, getWorkflowRunDetails, listActionApprovals, listArtifactLifecycle, listArtifacts, listProjectStorageSummaries, listWorkflowQueue, listWorkflowRunsForProject } from "../../../../../../packages/storage/src/postgres.js";
import { type StorageVerificationReport } from "../../../../../../packages/storage/src/verification.js";
import { type AggregateRunEta, aggregateRunEtas, estimateRunEta } from "../../run-eta.js";
import { dashboardCss } from "../../styles.js";
import http from "node:http";
import type { ArtifactLifecycleActionPlan, ArtifactLifecycleReport, ArtifactPrunePlan, BackupRestoreReport, ServerOrchestrationStatusReport, ServerRoadmapSnapshotReport, SharedStatePlaneProof } from "../../../commands/daemon-types.js";

export function backupRestoreCommands(projectRootUri?: string): string[] {
  const projectArg = projectRootUri ? ` --project ${shellQuote(projectRootUri)}` : "";
  return [
    `agentflow backup-report${projectArg} --json`,
    `agentflow artifact-lifecycle${projectArg} --archive-plan`,
    `agentflow artifact-lifecycle${projectArg} --restore-plan`,
    `agentflow approvals${projectArg} --status all`
  ];
}

export function backupRestoreNotes(input: {
  status: "ready" | "attention";
  projectRootUri?: string;
  projectRegistered: boolean;
  archivedArtifacts: number;
  restoredArtifacts: number;
  pendingLifecycleApprovals: number;
  activeQueueItems: number;
}): string[] {
  const notes: string[] = [];
  if (input.projectRootUri && !input.projectRegistered) {
    notes.push("Run project onboarding or index the project before relying on project-scoped backup inventory.");
  }
  if (!input.archivedArtifacts) {
    notes.push("Run an archive-plan and approved archive execution to create a copied snapshot before restore-drill validation.");
  }
  if (!input.restoredArtifacts) {
    notes.push("Run a restore-plan from an archived snapshot to prove restore lineage without overwriting existing artifacts.");
  }
  if (input.pendingLifecycleApprovals) {
    notes.push("Resolve pending, approved, or failed lifecycle approvals before treating backup posture as clean.");
  }
  if (input.activeQueueItems) {
    notes.push("Clear queued, running, or failed workflow stages before taking a backup intended for handoff.");
  }
  if (!notes.length && input.status === "ready") {
    notes.push("Read-only backup inventory and restore-drill evidence are present for the inspected scope.");
  }
  return notes;
}

export function buildServerRequestBodyErrorAuditEvent(request: http.IncomingMessage, error: unknown, requestPath = "/api/server-queue"): ServerRequestAuditEvent {
  const generatedAt = new Date().toISOString();
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    kind: "agentflow_server_request_audit_event",
    version: 1,
    generatedAt,
    requestId: `req_body_${stableHash([generatedAt, request.method, request.url, requestContentLength(request)]).slice(0, 16)}`,
    method: request.method ?? "UNKNOWN",
    path: requestPath,
    status: "rejected",
    dryRun: true,
    executeRequested: false,
    projectId: null,
    projectRootHash: null,
    workflowId: null,
    taskHash: null,
    taskBytes: 0,
    actorHash: null,
    actorRole: null,
    auth: {
      method: process.env.AGENTFLOW_SERVER_AUTH?.trim() || "token",
      accepted: false,
      errorCode: serverAuditErrorCode(errorMessage)
    },
    rateLimit: {
      accepted: null,
      keyHash: null,
      limit: null,
      remaining: null,
      resetAt: null
    },
    idempotencyKeyHash: null,
    clientProvidedIdempotency: false,
    queuedRunId: null,
    reusedRun: null,
    bodyBytes: requestContentLength(request),
    remoteHash: hashAuditValue(request.socket.remoteAddress),
    originHash: hashAuditValue(firstHeader(request.headers.origin)),
    userAgentHash: hashAuditValue(firstHeader(request.headers["user-agent"])),
    checks: [{ label: "Request body", status: "fail" }]
  };
}

export function buildSharedStatePlaneProof(input: {
  server: ServerReadinessReport;
  storageVerification: StorageVerificationReport;
  mergeEvidence: StorageMergeEvidenceListing;
  offlineFallback: OfflineFallbackReport;
  objectProof: ObjectArtifactProofReport;
  runtimeMonitor: RuntimeMonitorReport;
}): SharedStatePlaneProof {
  const checks: SharedStatePlaneProof["checks"] = [];
  const sharedReachable = input.runtimeMonitor.sharedHost.reachable || input.offlineFallback.currentServicesReachable;
  const sharedConfigured = Boolean(input.runtimeMonitor.storageHost || input.runtimeMonitor.sharedHost.host);
  const sameSharedStatePlane = input.storageVerification.status === "attention" &&
    input.storageVerification.diffs.every((diff) => diff.status === "match") &&
    input.storageVerification.warnings.some((warning) => warning.includes("source and target database URLs point to the same endpoint")) &&
    sharedConfigured;
  checks.push({
    label: "Shared storage host",
    status: sharedConfigured && sharedReachable ? "pass" : sharedConfigured ? "fail" : "warn",
    detail: sharedConfigured
      ? `${input.runtimeMonitor.storageHost ?? input.runtimeMonitor.sharedHost.host} is ${sharedReachable ? "reachable" : "not fully reachable"}.`
      : "No shared storage host is configured; this machine is still local-only."
  });
  checks.push({
    label: "Current storage points shared",
    status: input.runtimeMonitor.sharedHost.source === "not-configured" ? "warn" : "pass",
    detail: input.runtimeMonitor.sharedHost.source === "not-configured"
      ? "Configured storage does not identify a shared/non-loopback state plane."
      : `Shared state plane inferred from ${input.runtimeMonitor.sharedHost.source}.`
  });
  checks.push({
    label: "Post-merge evidence",
    status: input.mergeEvidence.safePrimaryStatePlane ? "pass" : "warn",
    detail: input.mergeEvidence.safePrimaryStatePlane
      ? "Latest merge evidence shows zero source-only rows, completed import, and backups."
      : "Need latest manifest with zero source-only rows, completed import result, and source/target backups."
  });
  checks.push({
    label: "Storage row parity",
    status: input.storageVerification.status === "match" || sameSharedStatePlane ? "pass" : input.storageVerification.status === "blocked" ? "fail" : "warn",
    detail: sameSharedStatePlane
      ? "Source and target resolve to the same shared storage plane; durable table fingerprints match within that plane."
      : input.storageVerification.status === "match"
      ? "Durable table counts and compact fingerprints match."
      : `${input.storageVerification.status}: review table diffs before declaring shared storage primary.`
  });
  checks.push({
    label: "Object artifact parity",
    status: input.objectProof.status === "verified" || input.objectProof.status === "metadata-only"
      ? "pass"
      : input.objectProof.status === "missing"
        ? "fail"
        : "warn",
    detail: input.objectProof.status === "verified"
      ? "Object-backed artifact references and/or bucket parity are verified."
      : input.objectProof.status === "metadata-only"
        ? "No object-backed references required verification in the inspected window, or verification was intentionally metadata-only."
        : input.objectProof.status === "missing"
          ? "Object-backed artifacts or source bucket keys are missing from the target."
          : "Object proof is blocked or unavailable; run with mc verification/enumeration when object-backed artifacts matter."
  });
  const pendingOfflineItems = input.offlineFallback.queue.items.filter((item) => item.status === "pending").length;
  checks.push({
    label: "Offline sync queue",
    status: pendingOfflineItems === 0 ? "pass" : "warn",
    detail: pendingOfflineItems === 0
      ? "No pending offline fallback items need sync-back."
      : `${pendingOfflineItems} pending offline fallback item(s) should be synced back to shared storage.`
  });
  checks.push({
    label: "Local fallback posture",
    status: sharedReachable ? "pass" : input.offlineFallback.localServicesReachable ? "warn" : "fail",
    detail: sharedReachable
      ? input.offlineFallback.localServicesReachable
        ? "Shared storage is online. Local fallback services are available but can stay stopped unless needed."
        : "Shared storage is online. Local fallback services can stay stopped."
      : input.offlineFallback.localServicesReachable
        ? "Shared storage is offline; local fallback is available for offline work."
        : "Shared storage is offline and local fallback is not fully available."
  });
  checks.push({
    label: "Server controls",
    status: !input.server.mode.enabled
      ? "warn"
      : input.server.status === "ready"
        ? "pass"
        : input.server.status === "blocked"
          ? "fail"
          : "warn",
    detail: !input.server.mode.enabled
      ? "Server mode is disabled; CLI, MCP stdio, dashboard, and worker remain local-first."
      : `Server mode readiness is ${input.server.status}; auth=${input.server.mode.authMode}, bind=${input.server.mode.bind}:${input.server.mode.port}.`
  });
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const status: SharedStatePlaneProof["status"] = failures ? "blocked" : warnings ? "attention" : "ready";
  const recommendedActions = checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.label}: ${check.detail}`);
  if (input.objectProof.bucketParity?.status === "missing") {
    recommendedActions.push("Run the object mirror plan after review, then rerun object-artifact-proof with bucket enumeration.");
  }
  if (input.offlineFallback.mode === "shared-online" && input.offlineFallback.localServicesReachable) {
    recommendedActions.push("Local fallback services are optional while shared storage is healthy; stop them to reduce local resource use.");
  }
  return {
    kind: "agentflow_shared_state_plane_proof",
    generatedAt: new Date().toISOString(),
    status,
    summary: status === "ready"
      ? "Shared storage has enough evidence to act as the primary Agent Workflow state plane."
      : status === "attention"
        ? "Shared storage is usable for local-first development, but some proof or governance checks still need review."
        : "Shared storage should not be treated as primary until blocking checks are resolved.",
    sharedHost: input.runtimeMonitor.storageHost ?? input.runtimeMonitor.sharedHost.host,
    localFallbackCanStayStopped: sharedReachable && pendingOfflineItems === 0,
    checks,
    recommendedActions
  };
}

export function emptyBackupRestoreReport(input: {
  projectRootUri?: string;
  limit: number;
  services: Awaited<ReturnType<typeof checkServices>>;
  note: string;
}): BackupRestoreReport {
  return {
    kind: "agentflow_backup_restore_report",
    generatedAt: new Date().toISOString(),
    projectRootUri: input.projectRootUri ?? null,
    limit: input.limit,
    services: input.services,
    inventory: {
      projects: 0,
      runs: 0,
      completedRuns: 0,
      failedRuns: 0,
      queuedRuns: 0,
      runningRuns: 0,
      indexedFiles: 0,
      indexedTokens: 0,
      memoryItems: 0,
      artifacts: 0,
      estimatedArtifactBytes: 0,
      archivedArtifacts: 0,
      restoredArtifacts: 0,
      byKind: {},
      byProject: {}
    },
    restoreDrill: {
      status: "attention",
      servicesReachable: false,
      projectRegistered: false,
      archivedSnapshotsAvailable: false,
      restoredSnapshotsAvailable: false,
      pendingLifecycleApprovals: 0,
      activeQueueItems: 0,
      latestArtifactAt: null,
      checks: input.services.map((service) => ({
        label: service.endpoint.name,
        status: service.reachable ? "pass" as const : "warn" as const,
        detail: service.message
      }))
    },
    recommendedCommands: backupRestoreCommands(input.projectRootUri),
    notes: [input.note]
  };
}

export function emptyServerOrchestrationEta(reason: string): AggregateRunEta {
  return { state: "learning", estimatedCompletionAt: null, remainingMs: null, projectedTotalMs: null, confidence: "none", source: "none", sampleCount: 0, completedTasks: 0, totalTasks: 0, reason, runs: [] };
}

export function emptyServerOrchestrationProgress(): ServerOrchestrationStatusReport["progress"] {
  return { totalStages: 0, completedStages: 0, runningStages: 0, queuedStages: 0, blockedStages: 0, failedStages: 0, cancelledStages: 0, percent: 0, currentStages: [], pendingApprovals: 0, approvals: [] };
}

export async function loadBackupRestoreReport(input: {
  projectRootUri?: string;
  limit: number;
}): Promise<BackupRestoreReport> {
  const projectRootUri = input.projectRootUri?.trim() || undefined;
  const services = await checkServices();
  const servicesReachable = services.every((service) => service.reachable);
  if (!servicesReachable) {
    return emptyBackupRestoreReport({
      projectRootUri,
      limit: input.limit,
      services,
      note: "Enterprise services are not all reachable. Start local services before collecting a complete backup inventory."
    });
  }

  const [allProjects, artifacts, approvals, queue] = await Promise.all([
    listProjectStorageSummaries(500),
    listArtifactLifecycle({ projectRootUri, limit: input.limit }),
    listActionApprovals({ projectRootUri, limit: input.limit }),
    listWorkflowQueue(Math.min(input.limit, 500), { projectRootUri })
  ]);
  const projects = projectRootUri ? allProjects.filter((project) => project.rootUri === projectRootUri) : allProjects;
  const byKind: BackupRestoreReport["inventory"]["byKind"] = {};
  const byProject: BackupRestoreReport["inventory"]["byProject"] = {};
  for (const artifact of artifacts) {
    const kind = byKind[artifact.kind] ?? { count: 0, bytes: 0 };
    kind.count += 1;
    kind.bytes += artifact.contentBytes;
    byKind[artifact.kind] = kind;

    const project = byProject[artifact.projectName] ?? { artifacts: 0, bytes: 0 };
    project.artifacts += 1;
    project.bytes += artifact.contentBytes;
    byProject[artifact.projectName] = project;
  }

  const lifecycleApprovals = approvals.filter((approval) => approval.actionType.startsWith("artifact_"));
  const pendingLifecycleApprovals = lifecycleApprovals.filter((approval) => approval.status === "pending" || approval.status === "approved" || approval.status === "failed").length;
  const activeQueueItems = queue.filter((item) => item.queuedTasks > 0 || item.runningTasks > 0 || item.failedTasks > 0).length;
  const archivedArtifacts = artifacts.filter((artifact) => artifact.kind === "archived_artifact").length;
  const restoredArtifacts = artifacts.filter((artifact) => artifact.kind === "restored_artifact").length;
  const projectRegistered = projectRootUri ? projects.some((project) => project.rootUri === projectRootUri) : projects.length > 0;
  const checks = [
    {
      label: "Enterprise services",
      status: servicesReachable ? "pass" as const : "warn" as const,
      detail: servicesReachable ? "Postgres, Redis, and object storage endpoints are reachable." : "One or more enterprise services are unreachable."
    },
    {
      label: "Project registration",
      status: projectRegistered ? "pass" as const : "warn" as const,
      detail: projectRootUri ? (projectRegistered ? "Selected project is registered in local storage." : "Selected project is not registered yet.") : `${projects.length} project(s) are registered.`
    },
    {
      label: "Backup inventory",
      status: artifacts.length ? "pass" as const : "warn" as const,
      detail: artifacts.length ? `${artifacts.length} recent artifact(s) are visible for backup planning.` : "No artifacts were found in the inspected window."
    },
    {
      label: "Restore drill source",
      status: archivedArtifacts ? "pass" as const : "warn" as const,
      detail: archivedArtifacts ? `${archivedArtifacts} archived artifact snapshot(s) can be used for restore drills.` : "No archived artifact snapshots are available yet."
    },
    {
      label: "Operational blockers",
      status: pendingLifecycleApprovals || activeQueueItems ? "warn" as const : "pass" as const,
      detail: `${pendingLifecycleApprovals} pending/approved lifecycle approval(s); ${activeQueueItems} active queue item(s).`
    }
  ];
  const status = checks.every((check) => check.status === "pass") ? "ready" : "attention";
  return {
    kind: "agentflow_backup_restore_report",
    generatedAt: new Date().toISOString(),
    projectRootUri: projectRootUri ?? null,
    limit: input.limit,
    services,
    inventory: {
      projects: projects.length,
      runs: projects.reduce((sum, project) => sum + project.runCount, 0),
      completedRuns: projects.reduce((sum, project) => sum + project.completedRuns, 0),
      failedRuns: projects.reduce((sum, project) => sum + project.failedRuns, 0),
      queuedRuns: projects.reduce((sum, project) => sum + project.queuedRuns, 0),
      runningRuns: projects.reduce((sum, project) => sum + project.runningRuns, 0),
      indexedFiles: projects.reduce((sum, project) => sum + project.indexedFiles, 0),
      indexedTokens: projects.reduce((sum, project) => sum + project.indexedTokens, 0),
      memoryItems: projects.reduce((sum, project) => sum + project.memoryItems, 0),
      artifacts: artifacts.length,
      estimatedArtifactBytes: artifacts.reduce((sum, artifact) => sum + artifact.contentBytes + artifact.uri.length, 0),
      archivedArtifacts,
      restoredArtifacts,
      byKind,
      byProject
    },
    restoreDrill: {
      status,
      servicesReachable,
      projectRegistered,
      archivedSnapshotsAvailable: archivedArtifacts > 0,
      restoredSnapshotsAvailable: restoredArtifacts > 0,
      pendingLifecycleApprovals,
      activeQueueItems,
      latestArtifactAt: artifacts[0]?.createdAt ?? null,
      checks
    },
    recommendedCommands: backupRestoreCommands(projectRootUri),
    notes: backupRestoreNotes({ status, projectRootUri, projectRegistered, archivedArtifacts, restoredArtifacts, pendingLifecycleApprovals, activeQueueItems })
  };
}

export async function loadServerHighRiskApprovalInbox(limit: number): Promise<HighRiskApprovalInbox> {
  const boundedLimit = Math.max(1, Math.min(limit, 25));
  const approvals = (await listActionApprovals({ limit: Math.max(100, boundedLimit * 8) }))
    .filter(isOpenApproval);
  const projects = await listProjectStorageSummaries(1000);
  const projectIds = new Map(projects.map((project) => [project.rootUri, project.id]));
  const projectConfigs = new Map<string, ProjectConfig | null>();
  const items: HighRiskApprovalInbox["items"] = [];
  for (const approval of approvals) {
    if (items.length >= boundedLimit) break;
    if (!projectConfigs.has(approval.projectRootUri)) {
      projectConfigs.set(approval.projectRootUri, await loadLocalProjectConfig(approval.projectRootUri).catch(() => null));
    }
    const project = projectConfigs.get(approval.projectRootUri);
    const classification = project
      ? classifyApprovalAutopilotRisk(approval, project)
      : { eligible: false, risk: "high" as const, reasons: ["Project policy could not be loaded; manual review is required."] };
    if (classification.risk !== "high") continue;
    items.push({
      approvalId: approval.id,
      projectId: projectIds.get(approval.projectRootUri) ?? null,
      projectName: approval.projectName,
      workflowId: approval.workflowId,
      runId: approval.runId,
      approvalStatus: approval.status,
      actionType: approval.actionType,
      target: redactApprovalCardText(approval.target, 240),
      rationale: redactApprovalCardText(approval.rationale, 360),
      risk: "high",
      riskReasons: classification.reasons.map((reason) => redactApprovalCardText(reason, 240)).slice(0, 5),
      requestedAt: approval.createdAt,
      dashboardPath: `/approvals?status=open&run=${encodeURIComponent(approval.runId)}`
    });
  }
  return buildHighRiskApprovalInbox({ scanned: approvals.length, open: approvals.length, items });
}

export async function loadServerOrchestrationStatus(request: http.IncomingMessage, projectId: string, operationId: string): Promise<{ statusCode: number; report: ServerOrchestrationStatusReport }> {
  const auth = validateServerMutationAuth(request);
  const emptyProgress = emptyServerOrchestrationProgress();
  if (!auth.ok) return { statusCode: 403, report: { kind: "agentflow_server_orchestration_status", generatedAt: new Date().toISOString(), operationId, projectId, status: "missing", runGroup: [], progress: emptyProgress, eta: emptyServerOrchestrationEta("Authentication is required before ETA evidence can be read."), cursor: stableHash([operationId, "missing"]), result: null } };
  const summary = (await listProjectStorageSummaries(500)).find((item) => item.id === projectId);
  const projectRuns = summary ? await listWorkflowRunsForProject({ projectRootUri: summary.rootUri, limit: 500 }) : [];
  const runs = projectRuns.filter((run) => stringValue(run.evaluationMetadata?.source) === "server-orchestration" && stringValue(run.evaluationMetadata?.operationId) === operationId);
  if (!runs.length) return { statusCode: 404, report: { kind: "agentflow_server_orchestration_status", generatedAt: new Date().toISOString(), operationId, projectId, status: "missing", runGroup: [], progress: emptyProgress, eta: emptyServerOrchestrationEta("No matching orchestration runs were found."), cursor: stableHash([operationId, "missing"]), result: null } };
  const statuses = runs.map((run) => run.status);
  const status: ServerOrchestrationStatusReport["status"] = statuses.includes("blocked") ? "blocked" : statuses.includes("failed") ? "failed" : statuses.some((item) => item === "queued" || item === "leased" || item === "running") ? (statuses.includes("running") || statuses.includes("leased") ? "running" : "queued") : "completed";
  const latest = runs[0];
  const details = await Promise.all(runs.map((run) => getWorkflowRunDetails(run.id)));
  const eta = aggregateRunEtas(runs.map((run, index) => ({ runId: run.id, eta: estimateRunEta({ run, tasks: details[index]?.tasks ?? [], historicalRuns: projectRuns }) })));
  const tasks = details.flatMap((detail) => detail.tasks.map((task) => ({ ...task, runId: detail.run?.id ?? "" })));
  const count = (taskStatus: string): number => tasks.filter((task) => task.status === taskStatus).length;
  const completedStages = count("completed");
  const blockedStages = count("blocked");
  const failedStages = count("failed");
  const cancelledStages = count("cancelled");
  const terminalStages = completedStages + blockedStages + failedStages + cancelledStages;
  const openApprovals = (await Promise.all(runs.map((run) => listActionApprovals({ runId: run.id, limit: 100 })))).flat().filter((approval) => isOpenApproval(approval));
  const progress: ServerOrchestrationStatusReport["progress"] = {
    totalStages: tasks.length,
    completedStages,
    runningStages: count("running"),
    queuedStages: count("queued"),
    blockedStages,
    failedStages,
    cancelledStages,
    percent: tasks.length ? Math.round((terminalStages / tasks.length) * 100) : 0,
    currentStages: tasks.filter((task) => task.status === "running" || task.status === "leased" || task.status === "queued" || task.status === "blocked" || task.status === "failed").slice(0, 8).map((task) => ({ runId: task.runId, stageId: task.stageId, agentId: task.agentId, status: task.status, attempts: task.attempts })),
    pendingApprovals: openApprovals.length,
    approvals: openApprovals.slice(0, 20).map((approval) => ({
      approvalId: approval.id,
      runId: approval.runId,
      stageId: approval.stageId,
      actionType: approval.actionType,
      target: approval.target,
      rationale: approval.rationale,
      status: approval.status,
      allowedDecisions: ["approve", "approve-and-execute", "reject"],
      actionEndpoint: "/api/server-approval-action"
    }))
  };
  const artifacts = await listArtifacts({ runId: latest.id, kind: "stage_output" });
  const finalArtifact = artifacts.at(-1) ?? null;
  const result = serverOrchestrationStatusIsTerminal(status)
    ? { outcome: status as "completed" | "blocked" | "failed", summary: (stringValue(finalArtifact?.content?.summary) ?? "").slice(0, 2000), artifactUri: finalArtifact?.uri ?? null }
    : null;
  const cursor = stableHash([operationId, status, JSON.stringify(progress), finalArtifact?.uri ?? ""]);
  return { statusCode: 200, report: {
    kind: "agentflow_server_orchestration_status",
    generatedAt: new Date().toISOString(), operationId, projectId, status,
    runGroup: runs.map((run) => ({ runId: run.id, workflowId: run.workflowId, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt })),
    progress,
    eta,
    cursor,
    result
  } };
}

export async function loadServerRoadmapSnapshot(projectIdInput: string): Promise<{ statusCode: number; report: ServerRoadmapSnapshotReport }> {
  const projectId = projectIdInput.trim();
  const generatedAt = new Date().toISOString();
  const rejectedReason = rejectProjectIdReason(projectId);
  if (rejectedReason) {
    return { statusCode: 400, report: { kind: "agentflow_server_roadmap_snapshot", generatedAt, projectId, projectName: null, status: "invalid", snapshot: null, reason: rejectedReason } };
  }
  const summary = (await listProjectStorageSummaries(500)).find((project) => project.id === projectId);
  if (!summary) {
    return { statusCode: 404, report: { kind: "agentflow_server_roadmap_snapshot", generatedAt, projectId, projectName: null, status: "missing", snapshot: null, reason: "project id is not registered" } };
  }
  const state = await getProjectIndexState({ projectId });
  if (!state || !("roadmapSnapshot" in state.metadata)) {
    return { statusCode: 200, report: { kind: "agentflow_server_roadmap_snapshot", generatedAt, projectId, projectName: summary.name, status: "missing", snapshot: null, reason: "roadmap snapshot has not been published" } };
  }
  const parsed = parseRoadmapSnapshot(state.metadata.roadmapSnapshot, projectId);
  if (!parsed) {
    return { statusCode: 200, report: { kind: "agentflow_server_roadmap_snapshot", generatedAt, projectId, projectName: summary.name, status: "invalid", snapshot: null, reason: "stored roadmap snapshot failed validation" } };
  }
  const snapshot = serverRoadmapSnapshot(parsed);
  return { statusCode: 200, report: { kind: "agentflow_server_roadmap_snapshot", generatedAt, projectId, projectName: summary.name, status: snapshot.freshness, snapshot, reason: snapshot.reason } };
}

export function renderArtifactLifecycleHtml(report: ArtifactLifecycleReport, projects: DashboardProjectSummary[], params: URLSearchParams): string {
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}"${report.projectRootUri === project.rootUri ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  const kinds = [...new Set(report.recentArtifacts.map((artifact) => artifact.kind))].sort();
  const kindOptions = kinds.map((kind) => `<option value="${escapeHtml(kind)}"${report.artifactKind === kind ? " selected" : ""}>${escapeHtml(kind)}</option>`).join("");
  const hintRows = report.reviewHints.map((hint) => `<li>${escapeHtml(hint)}</li>`).join("");
  const activeLifecycleCriteria = report.prunePlan?.criteria ?? report.archivePlan?.criteria ?? report.restorePlan?.criteria ?? null;
  const renderLifecycleActionRows = (plan: ArtifactPrunePlan | ArtifactLifecycleActionPlan | null) => plan?.candidates.slice(0, 100).map((candidate) => `
    <tr>
      <td><code>${escapeHtml(candidate.artifactId)}</code><br><span class="muted">${escapeHtml(candidate.kind)}</span></td>
      <td>${escapeHtml(candidate.projectName)}<br><span class="muted">${escapeHtml(candidate.workflowId)} / ${escapeHtml(candidate.runStatus)}</span></td>
      <td><a href="/run?id=${encodeURIComponent(candidate.runId)}">${escapeHtml(candidate.runId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(candidate.taskId?.slice(0, 8) ?? "run-level")}</span></td>
      <td>${candidate.ageDays === null ? "unknown" : `${candidate.ageDays}d`}<br><span class="muted">${escapeHtml(formatBytes(candidate.contentBytes))}</span></td>
      <td>${escapeHtml(candidate.reason)}</td>
      <td><code>${escapeHtml(candidate.receiptPreview.actionType)}</code><br><span class="muted">${escapeHtml(candidate.receiptPreview.summary)}</span></td>
      <td><code>${escapeHtml(candidate.uri)}</code></td>
    </tr>`).join("") ?? "";
  const pruneRows = report.prunePlan?.candidates.slice(0, 100).map((candidate) => `
    <tr>
      <td><code>${escapeHtml(candidate.artifactId)}</code><br><span class="muted">${escapeHtml(candidate.kind)}</span></td>
      <td>${escapeHtml(candidate.projectName)}<br><span class="muted">${escapeHtml(candidate.workflowId)} / ${escapeHtml(candidate.runStatus)}</span></td>
      <td><a href="/run?id=${encodeURIComponent(candidate.runId)}">${escapeHtml(candidate.runId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(candidate.taskId?.slice(0, 8) ?? "run-level")}</span></td>
      <td>${candidate.ageDays === null ? "unknown" : `${candidate.ageDays}d`}<br><span class="muted">${escapeHtml(formatBytes(candidate.contentBytes))}</span></td>
      <td>${escapeHtml(candidate.reason)}</td>
      <td><code>${escapeHtml(candidate.receiptPreview.actionType)}</code><br><span class="muted">${escapeHtml(candidate.receiptPreview.summary)}</span></td>
      <td><code>${escapeHtml(candidate.uri)}</code></td>
    </tr>`).join("") ?? "";
  const pruneNotes = report.prunePlan?.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("") ?? "";
  const renderQueueApprovalForm = (action: ArtifactLifecycleAction) => report.projectRootUri ? `<form class="inline-form" method="post" action="/api/artifact-lifecycle-action">
    ${dashboardReturnInput("/artifact-lifecycle", params)}
    <input type="hidden" name="action" value="queue-${escapeHtml(action)}-approvals">
    <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
    <input type="hidden" name="kind" value="${escapeHtml(report.artifactKind ?? "")}">
    <input type="hidden" name="limit" value="${escapeHtml(String(report.limit))}">
    <input type="hidden" name="minAgeDays" value="${escapeHtml(params.get("minAgeDays") ?? "")}">
    <input type="hidden" name="minBytes" value="${escapeHtml(params.get("minBytes") ?? "")}">
    <input type="hidden" name="includeAudit" value="${artifactLifecyclePlanForAction(report, action)?.criteria.includeAudit ? "true" : "false"}">
    <label>Requester role<input name="actorRole" value="operator"></label>
    <button type="submit">Queue ${escapeHtml(titleCase(action))} Approvals</button>
  </form>` : "";
  const queueApprovalForm = report.prunePlan ? renderQueueApprovalForm("prune") : "";
  const renderLifecyclePlanPanel = (plan: ArtifactLifecycleActionPlan | null) => plan ? `<section class="panel"><div class="section-heading"><div><h2>Dry-run ${escapeHtml(titleCase(plan.action))} Plan</h2><span class="muted">Preview only. No artifacts are moved, restored, archived, deleted, or modified.</span></div><div class="meta-grid"><div><strong>Candidates</strong>${plan.totalCandidates}</div><div><strong>Recoverable</strong>${escapeHtml(formatBytes(plan.estimatedBytesRecoverable))}</div><div><strong>Criteria</strong>${escapeHtml(plan.criteria.policySource)}</div><div><strong>Approval</strong>${plan.approvalRequired ? "required" : "not required by policy"}</div></div></div><ul>${plan.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>${renderQueueApprovalForm(plan.action) || '<p class="muted">Select a project to queue lifecycle approvals for this plan.</p>'}<div class="table-wrap"><table><thead><tr><th>Artifact</th><th>Project</th><th>Run</th><th>Age/Size</th><th>Reason</th><th>Receipt Preview</th><th>URI</th></tr></thead><tbody>${renderLifecycleActionRows(plan) || '<tr><td colspan="7">No artifacts matched the current lifecycle criteria.</td></tr>'}</tbody></table></div></section>` : "";
  const artifactRows = report.recentArtifacts.slice(0, 100).map((artifact) => `
    <tr>
      <td><strong>${escapeHtml(artifact.kind)}</strong><br><span class="muted">${escapeHtml(artifact.lifecycleHint)}</span></td>
      <td>${escapeHtml(artifact.projectName)}<br><span class="muted">${escapeHtml(artifact.workflowId)} / ${escapeHtml(artifact.runStatus)}</span></td>
      <td><a href="/run?id=${encodeURIComponent(artifact.runId)}">${escapeHtml(artifact.runId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(artifact.taskId?.slice(0, 8) ?? "run-level")}</span></td>
      <td>${escapeHtml(artifact.ageBucket)}<br><span class="muted">${renderDashboardDateTime(artifact.createdAt)}</span></td>
      <td>${escapeHtml(formatBytes(artifact.contentBytes))}</td>
      <td><code>${escapeHtml(artifact.uri)}</code></td>
    </tr>`).join("");
  const filters = `<form method="get" class="form-grid">
    <label>Project<select name="project"><option value="">all registered projects</option>${projectOptions}</select></label>
    <label>Kind<select name="kind"><option value="">all artifact kinds</option>${kindOptions}</select></label>
    <label>Recent artifacts<input name="limit" inputmode="numeric" value="${escapeHtml(String(report.limit))}"></label>
    <label>Min age days<input name="minAgeDays" inputmode="numeric" placeholder="${escapeHtml(String(report.retentionPolicy.retentionDays))}" value="${escapeHtml(params.get("minAgeDays") ?? "")}"></label>
    <label>Min bytes<input name="minBytes" inputmode="numeric" placeholder="${escapeHtml(String(report.retentionPolicy.minPruneBytes))}" value="${escapeHtml(params.get("minBytes") ?? "")}"></label>
    <label class="check-row"><input type="checkbox" name="prunePlan" value="true"${report.prunePlan ? " checked" : ""}> Show dry-run prune plan</label>
    <label class="check-row"><input type="checkbox" name="archivePlan" value="true"${report.archivePlan ? " checked" : ""}> Show dry-run archive plan</label>
    <label class="check-row"><input type="checkbox" name="restorePlan" value="true"${report.restorePlan ? " checked" : ""}> Show dry-run restore plan</label>
    <label class="check-row"><input type="checkbox" name="includeAudit" value="true"${activeLifecycleCriteria?.includeAudit ? " checked" : ""}> Include audit artifacts</label>
    <div class="form-actions"><button type="submit">Filter</button></div>
  </form>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Artifact Lifecycle</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("artifact-lifecycle")}
  <main id="main-content"><div class="topbar"><div><a href="/">Dashboard</a><h1>Artifact Lifecycle</h1><p class="muted">Read-only storage inventory for run artifacts. This page does not prune, archive, or delete anything.</p></div><a class="button secondary" href="/api/artifact-lifecycle?${escapeHtml(params.toString())}">JSON</a></div>
  ${renderDashboardFlash(params)}
  ${renderDashboardActionHistory()}
  <section class="panel">${filters}<div class="meta-grid"><div><strong>Artifacts</strong>${report.totalArtifacts}</div><div><strong>Estimated JSON</strong>${escapeHtml(formatBytes(report.estimatedBytes))}</div><div><strong>Kinds</strong>${Object.keys(report.byKind).length}</div><div><strong>Projects</strong>${Object.keys(report.byProject).length}</div></div></section>
  <section class="panel"><div class="section-heading"><div><h2>Retention Policy</h2><span class="muted">Project-local defaults from .agent-workflow/project.yaml. Empty filter fields use this policy; filled fields become preview-only overrides.</span></div></div><div class="meta-grid"><div><strong>Source</strong>${escapeHtml(report.retentionPolicy.source)}</div><div><strong>Retention</strong>${report.retentionPolicy.retentionDays} days</div><div><strong>Minimum size</strong>${escapeHtml(formatBytes(report.retentionPolicy.minPruneBytes))}</div><div><strong>Audit artifacts</strong>${report.retentionPolicy.retainAuditArtifacts ? "retained by default" : "eligible by policy"}</div><div><strong>Legal hold</strong>${report.retentionPolicy.legalHold ? "enabled" : "off"}</div><div><strong>Approval</strong>${report.retentionPolicy.requireApprovalForPrune ? "required" : "project policy allows approval-free preview"}</div><div><strong>Archive execution</strong>${report.retentionPolicy.allowArchiveExecution ? "enabled" : "disabled"}</div><div><strong>Restore execution</strong>${report.retentionPolicy.allowRestoreExecution ? "enabled" : "disabled"}</div><div><strong>Prune execution</strong>${report.retentionPolicy.allowPruneExecution ? "enabled" : "disabled"}</div></div></section>
  <section class="panel"><div class="section-heading"><div><h2>Lifecycle Hints</h2><span class="muted">Hints are conservative and non-destructive. Future prune plans should cite exact ids and require approval.</span></div></div><ul>${hintRows || "<li>No lifecycle concerns found in the inspected artifact window.</li>"}</ul></section>
  ${report.prunePlan ? `<section class="panel"><div class="section-heading"><div><h2>Dry-run Prune Plan</h2><span class="muted">Preview only. No artifacts are deleted, archived, or modified.</span></div><div class="meta-grid"><div><strong>Candidates</strong>${report.prunePlan.totalCandidates}</div><div><strong>Recoverable</strong>${escapeHtml(formatBytes(report.prunePlan.estimatedBytesRecoverable))}</div><div><strong>Criteria</strong>${escapeHtml(report.prunePlan.criteria.policySource)}</div><div><strong>Approval</strong>${report.prunePlan.approvalRequired ? "required" : "not required by policy"}</div></div></div><ul>${pruneNotes}</ul>${queueApprovalForm || '<p class="muted">Select a project to queue lifecycle approvals for this prune plan.</p>'}<div class="table-wrap"><table><thead><tr><th>Artifact</th><th>Project</th><th>Run</th><th>Age/Size</th><th>Reason</th><th>Receipt Preview</th><th>URI</th></tr></thead><tbody>${pruneRows || '<tr><td colspan="7">No artifacts matched the current prune criteria.</td></tr>'}</tbody></table></div></section>` : ""}
  ${renderLifecyclePlanPanel(report.archivePlan)}
  ${renderLifecyclePlanPanel(report.restorePlan)}
  <section class="panel"><div class="meta-grid"><div><strong>By Kind</strong>${escapeHtml(formatInlineCounts(report.byKind) || "none")}</div><div><strong>By Age</strong>${escapeHtml(formatInlineCounts(report.byAgeBucket) || "none")}</div><div><strong>By Run Status</strong>${escapeHtml(formatInlineCounts(report.byRunStatus) || "none")}</div></div></section>
  <section class="panel"><div class="section-heading"><div><h2>Recent Artifacts</h2><span class="muted">Showing up to 100 newest rows from the inspected window.</span></div></div><div class="table-wrap"><table><thead><tr><th>Kind</th><th>Project</th><th>Run</th><th>Age</th><th>Size</th><th>URI</th></tr></thead><tbody>${artifactRows || '<tr><td colspan="6">No artifacts found.</td></tr>'}</tbody></table></div></section></main></body></html>`;
}

export function renderBackupRestoreHtml(report: BackupRestoreReport, projects: DashboardProjectSummary[], params: URLSearchParams): string {
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}"${report.projectRootUri === project.rootUri ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  const statusClass = report.restoreDrill.status === "ready" ? "completed" : "queued";
  const serviceRows = report.services.map((service) => `
    <tr><td>${escapeHtml(service.endpoint.name)}</td><td><span class="status ${service.reachable ? "completed" : "failed"}">${service.reachable ? "OK" : "MISSING"}</span></td><td>${escapeHtml(service.message)}</td></tr>
  `).join("");
  const checkRows = report.restoreDrill.checks.map((check) => `
    <tr><td>${escapeHtml(check.label)}</td><td><span class="status ${check.status === "pass" ? "completed" : "queued"}">${escapeHtml(check.status)}</span></td><td>${escapeHtml(check.detail)}</td></tr>
  `).join("");
  const kindRows = Object.entries(report.inventory.byKind)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, value]) => `<tr><td>${escapeHtml(kind)}</td><td>${formatNumber(value.count)}</td><td>${escapeHtml(formatBytes(value.bytes))}</td></tr>`)
    .join("");
  const commandRows = report.recommendedCommands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
  const noteRows = report.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  const jsonParams = new URLSearchParams();
  if (report.projectRootUri) jsonParams.set("project", report.projectRootUri);
  jsonParams.set("limit", String(report.limit));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Backup Readiness</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("backup-report")}
  <main id="main-content"><div class="topbar"><div><a href="/">Dashboard</a><h1>Backup Readiness</h1><p class="muted">Read-only local enterprise storage inventory and restore-drill posture. This page does not create backups, restore data, or mutate storage.</p></div><a class="button secondary" href="/api/backup-report?${escapeHtml(jsonParams.toString())}">JSON</a></div>
  ${renderDashboardFlash(params)}
  ${renderDashboardActionHistory()}
  <section class="panel"><form method="get" class="workflow-form"><label>Project<select name="project"><option value="">all registered projects</option>${projectOptions}</select></label><label>Limit<input name="limit" value="${escapeHtml(params.get("limit") ?? String(report.limit))}" inputmode="numeric"></label><div class="form-actions"><button type="submit">Inspect</button></div></form></section>
  <section class="panel"><div class="metric-grid">
    ${metricCard("Status", report.restoreDrill.status, "restore-drill readiness")}
    ${metricCard("Projects", report.inventory.projects, "registered in local storage")}
    ${metricCard("Runs", report.inventory.runs, `${report.inventory.completedRuns} completed / ${report.inventory.failedRuns} failed`)}
    ${metricCard("Artifacts", report.inventory.artifacts, formatBytes(report.inventory.estimatedArtifactBytes))}
    ${metricCard("Archives", report.inventory.archivedArtifacts, "archived_artifact snapshots")}
    ${metricCard("Restores", report.inventory.restoredArtifacts, "restored_artifact snapshots")}
    ${metricCard("Lifecycle Approvals", report.restoreDrill.pendingLifecycleApprovals, "pending / approved / failed")}
    ${metricCard("Queue Items", report.restoreDrill.activeQueueItems, "queued / running / failed")}
  </div><p class="muted">Generated ${renderDashboardDateTime(report.generatedAt)}. Current status: <span class="status ${statusClass}">${escapeHtml(report.restoreDrill.status)}</span>.</p></section>
  <section class="panel"><h2>Services</h2><div class="table-wrap"><table><thead><tr><th>Service</th><th>Status</th><th>Detail</th></tr></thead><tbody>${serviceRows || '<tr><td colspan="3">No service checks were recorded.</td></tr>'}</tbody></table></div></section>
  <section class="panel"><h2>Restore Drill Checks</h2><div class="table-wrap"><table><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>${checkRows || '<tr><td colspan="3">No restore-drill checks were recorded.</td></tr>'}</tbody></table></div></section>
  <section class="panel"><h2>Artifact Kinds</h2><div class="table-wrap"><table><thead><tr><th>Kind</th><th>Count</th><th>Bytes</th></tr></thead><tbody>${kindRows || '<tr><td colspan="3">No artifacts found in the inspected window.</td></tr>'}</tbody></table></div></section>
  <section class="panel"><h2>Recommended Commands</h2><ul>${commandRows}</ul></section>
  <section class="panel"><h2>Notes</h2><ul>${noteRows || '<li>No backup or restore drill concerns found in the inspected window.</li>'}</ul></section></main></body></html>`;
}

export function renderOfflineFallbackPanel(report: OfflineFallbackReport, params: URLSearchParams = new URLSearchParams()): string {
  const statusClass = report.mode === "shared-online" || report.mode === "local-fallback-ready" ? "completed" : report.mode === "offline-blocked" ? "failed" : "queued";
  const currentRows = report.currentServices.map((service) => `<tr><td>${escapeHtml(service.endpoint.name)}</td><td><span class="status ${service.reachable ? "completed" : "failed"}">${service.reachable ? "OK" : "MISSING"}</span></td><td>${escapeHtml(service.message)}</td></tr>`).join("");
  const localRows = report.localServices.map((service) => `<tr><td>${escapeHtml(service.endpoint.name)}</td><td><span class="status ${service.reachable ? "completed" : "failed"}">${service.reachable ? "OK" : "MISSING"}</span></td><td>${escapeHtml(service.message)}</td></tr>`).join("");
  const commandList = [
    `Stop local fallback: ${report.commands.stopLocal}`,
    `Start local fallback: ${report.commands.startLocal}`,
    ...report.commands.syncBack.map((command) => `Sync back: ${command}`)
  ].map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
  const notes = report.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  const pendingItems = report.queue.items.filter((item) => item.status === "pending");
  const queueRows = pendingItems.map((item) => `<tr>
    <td>${escapeHtml(item.action)}<br><span class="muted">${renderDashboardDateTime(item.createdAt)}</span></td>
    <td>${item.projectRootUri ? `<code>${escapeHtml(item.projectRootUri)}</code>` : "all/local"}${item.runId ? `<br><span class="muted">run ${escapeHtml(item.runId)}</span>` : ""}</td>
    <td>${escapeHtml(item.note || "")}</td>
    <td><form method="post" action="/api/offline-fallback-action">${dashboardReturnInput("/server-readiness", params)}<input type="hidden" name="action" value="mark-synced"><input type="hidden" name="itemId" value="${escapeHtml(item.id)}"><button type="submit">Mark Synced</button></form></td>
  </tr>`).join("");
  return `<section class="panel">
    <div class="section-heading">
      <div><h2>Offline Fallback</h2><span class="muted">Read-only health for shared storage and localhost fallback services.</span></div>
      <a class="button secondary" href="/api/offline-fallback">JSON</a>
    </div>
    <div class="metric-grid">
      ${metricCard("Mode", report.mode, "fallback posture")}
      ${metricCard("Shared", report.currentServicesReachable ? "online" : "offline", "current configured storage")}
      ${metricCard("Local Fallback", report.localServicesReachable ? "ready" : "stopped", "localhost Docker services")}
      ${metricCard("Sync Queue", pendingItems.length, "pending local fallback items")}
      ${metricCard("Scheduler", report.scheduler.status, `${report.scheduler.mode}; ${report.scheduler.nextRunAfter ? `next ${formatDashboardDateTimeText(report.scheduler.nextRunAfter)}` : "daemon check"}`)}
    </div>
    <p class="muted">Generated ${renderDashboardDateTime(report.generatedAt)}. Current fallback status: <span class="status ${statusClass}">${escapeHtml(report.mode)}</span>.</p>
    <div class="meta-grid compact">
      <div><strong>Scheduler Status</strong>${escapeHtml(report.scheduler.status)}<br><span class="muted">${escapeHtml(report.scheduler.mode)} mode. ${escapeHtml(report.scheduler.message)}</span></div>
      <div><strong>Last Scheduler Run</strong>${report.scheduler.lastRunAt ? renderDashboardDateTime(report.scheduler.lastRunAt) : "none"}</div>
      <div><strong>Next Scheduler Run</strong>${report.scheduler.nextRunAfter ? renderDashboardDateTime(report.scheduler.nextRunAfter) : "n/a"}</div>
      <div><strong>Last Receipt</strong>${report.scheduler.lastResultPath ? `<code>${escapeHtml(report.scheduler.lastResultPath)}</code>` : "none"}</div>
    </div>
    <div class="split-grid">
      <form class="inline-form" method="post" action="/api/offline-fallback-action">
        ${dashboardReturnInput("/server-readiness", params)}
        <input type="hidden" name="action" value="start-local">
        <input name="note" value="Start localhost fallback services if shared host/shared storage is down." aria-label="Fallback note">
        <button type="submit">Record Local Fallback</button>
      </form>
      <form class="inline-form" method="post" action="/api/offline-fallback-action">
        ${dashboardReturnInput("/server-readiness", params)}
        <input type="hidden" name="action" value="sync-back">
        <input name="note" value="Merge local fallback rows back into shared storage when shared host returns." aria-label="Sync note">
        <button type="submit">Record Sync Needed</button>
      </form>
    </div>
    <div class="split-grid">
      <form class="inline-form" method="post" action="/api/offline-sync-action">
        ${dashboardReturnInput("/server-readiness", params)}
        <input type="hidden" name="out" value=".agent-workflow/migrations">
        <button type="submit">Prepare Sync Dry Run</button>
      </form>
      <form class="inline-form" method="post" action="/api/offline-sync-action">
        ${dashboardReturnInput("/server-readiness", params)}
        <input type="hidden" name="out" value=".agent-workflow/migrations">
        <label class="check-row"><input type="checkbox" name="execute" required> Execute insert-only sync into shared storage</label>
        <button type="submit">Execute Sync</button>
      </form>
    </div>
    <div class="split-grid">
      <div><h3>Configured Storage</h3><div class="table-wrap"><table><thead><tr><th>Service</th><th>Status</th><th>Detail</th></tr></thead><tbody>${currentRows}</tbody></table></div></div>
      <div><h3>Local Fallback</h3><div class="table-wrap"><table><thead><tr><th>Service</th><th>Status</th><th>Detail</th></tr></thead><tbody>${localRows}</tbody></table></div></div>
    </div>
    <h3>Offline Sync Queue</h3>
    <div class="table-wrap"><table><thead><tr><th>Action</th><th>Scope</th><th>Note</th><th></th></tr></thead><tbody>${queueRows || '<tr><td colspan="4">No pending offline fallback items.</td></tr>'}</tbody></table></div>
    <details class="governance-details"><summary>Operator Commands</summary><ul>${commandList}</ul></details>
    <ul>${notes}</ul>
  </section>`;
}

export function renderPostMergeEvidencePanel(evidence: StorageMergeEvidenceListing): string {
  const statusClass = evidence.safePrimaryStatePlane ? "completed" : "queued";
  const manifest = evidence.latestManifest;
  const importResult = evidence.latestImport;
  const backup = evidence.latestBackup;
  const objectProof = evidence.latestObjectProof;
  const projectDecisions = evidence.latestProjectDecisions;
  const projectMappingByRoot = new Map((manifest?.projectMappings ?? []).map((mapping) => [mapping.rootUri, mapping]));
  const backupFiles = backup?.files.map((file) => `<li><code>${escapeHtml(file.name)}</code> ${escapeHtml(formatBytes(file.sizeBytes))}</li>`).join("") ?? "";
  const warningRows = evidence.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  const proofRows = evidence.switchOverProof.checks.map((check) => `<tr><td>${escapeHtml(check.label)}</td><td><span class="status ${check.status === "pass" ? "completed" : check.status === "fail" ? "failed" : "queued"}">${escapeHtml(check.status)}</span></td><td>${escapeHtml(check.detail)}</td></tr>`).join("");
  const conflictRows = evidence.conflictClassification.rows.map((row) => {
    const decisionForms = row.class === "canonical-project-conflict" && row.conflictRows > 0
      ? row.sampleConflictKeys.slice(0, 5).map((rootUri) => {
          const mapping = projectMappingByRoot.get(rootUri);
          return `<form method="post" action="/api/storage-project-decision" class="inline-form compact-form">
            ${dashboardReturnInput("/server-readiness", new URLSearchParams())}
            <input type="hidden" name="rootUri" value="${escapeHtml(rootUri)}">
            <input type="hidden" name="sourceProjectId" value="${escapeHtml(mapping?.sourceProjectId ?? "")}">
            <input type="hidden" name="targetProjectId" value="${escapeHtml(mapping?.targetProjectId ?? "")}">
            <input type="hidden" name="action" value="preserve-target-project">
            <input type="hidden" name="out" value="${escapeHtml(evidence.directory)}">
            <input name="note" value="Reviewed source/target metadata; shared target is canonical." aria-label="Decision note for ${escapeHtml(rootUri)}">
            <button type="submit">Preserve Target</button>
          </form>`;
        }).join("")
      : "";
    return `<tr>
    <td>${escapeHtml(row.table)}<br><span class="muted">${escapeHtml(row.class)}</span></td>
    <td><span class="status ${row.severity === "critical" ? "failed" : row.severity === "warning" ? "queued" : "completed"}">${escapeHtml(row.severity)}</span></td>
    <td>${formatNumber(row.conflictRows)}</td>
    <td>${row.sampleConflictKeys.slice(0, 3).map((sample) => `<code>${escapeHtml(truncateText(sample, 92))}</code>`).join("<br>") || "<span class=\"muted\">No sampled conflict keys.</span>"}</td>
    <td>${escapeHtml(row.resolution)}${row.reviewedDecision ? `<br><span class="muted">${escapeHtml(row.reviewedDecision)}</span>` : ""}${decisionForms}</td>
  </tr>`;
  }).join("");
  const sampleRows = (manifest?.tables ?? [])
    .filter((table) => ["workflow_runs", "artifacts", "action_approvals", "action_receipts", "memory_items", "project_files", "project_index_state", "projects"].includes(table.table))
    .map((table) => {
      const samples = table.sampleConflictKeys.length
        ? table.sampleConflictKeys
        : table.sampleExistingKeys.length
          ? table.sampleExistingKeys
          : table.sampleSourceKeys;
      return `<tr>
        <td>${escapeHtml(table.table)}</td>
        <td>${formatNumber(table.sourceRows)}</td>
        <td>${formatNumber(table.insertRows)} / ${formatNumber(table.conflictRows)}</td>
        <td>${samples.slice(0, 3).map((sample) => `<code>${escapeHtml(truncateText(sample, 92))}</code>`).join("<br>") || "<span class=\"muted\">Regenerate the merge manifest to capture row samples.</span>"}</td>
      </tr>`;
    }).join("");
  const commandRows = evidence.switchOverProof.recommendedCommands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
  return `<section class="panel">
    <div class="section-heading">
      <div><h2>Post-Merge Evidence</h2><span class="muted">Local operator proof for using shared storage as the primary state plane.</span></div>
      <a class="button secondary" href="/api/storage-merge-evidence?dir=${encodeURIComponent(evidence.directory)}">JSON</a>
    </div>
    <div class="metric-grid">
      ${metricCard("Primary State", evidence.safePrimaryStatePlane ? "proven" : "needs proof", evidence.safePrimaryStatePlane ? "shared storage is safe for normal use" : "review the missing evidence below")}
      ${metricCard("Source-Only Rows", manifest ? manifest.sourceOnlyRows : "unknown", "remaining rows from last manifest")}
      ${metricCard("Last Import", importResult ? importResult.status : "none", importResult ? `${importResult.mode}, ${formatNumber(importResult.affectedRows)} affected` : "no persisted import result")}
      ${metricCard("Backup", backup ? "present" : "missing", backup ? `${backup.files.length} file(s)` : "source and target backups not found")}
      ${metricCard("Object Proof", objectProof ? objectProof.status : "missing", objectProof ? `${objectProof.bucketParityStatus ?? "bucket not checked"}, ${formatNumber(objectProof.missingObjects)} missing refs` : "run object-artifact-proof --write")}
      ${metricCard("Project Decisions", projectDecisions ? projectDecisions.decisions.length : 0, projectDecisions ? `latest ${formatDashboardDateTimeText(projectDecisions.generatedAt)}` : "none recorded")}
    </div>
    <div class="table-wrap"><table><thead><tr><th>Switch-Over Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>${proofRows}</tbody></table></div>
    <details class="governance-details" open><summary>Conflict Classification</summary>
      <div class="meta-grid compact">
        <div><strong>Critical</strong>${formatNumber(evidence.conflictClassification.criticalRows)}<br><span class="muted">must resolve before primary proof</span></div>
        <div><strong>Refreshable</strong>${formatNumber(evidence.conflictClassification.derivedRows)}<br><span class="muted">derived project index/cache rows</span></div>
        <div><strong>Reviewed</strong>${formatNumber(projectDecisions?.decisions.length ?? 0)}<br><span class="muted">local project decisions</span></div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Table</th><th>Severity</th><th>Rows</th><th>Samples</th><th>Resolution</th></tr></thead><tbody>${conflictRows || "<tr><td colspan=\"5\">No conflicts remain in the latest manifest.</td></tr>"}</tbody></table></div>
    </details>
    <details class="governance-details" open><summary>Sampled Historical Evidence</summary><div class="table-wrap"><table><thead><tr><th>Table</th><th>Source Rows</th><th>Insert / Conflict</th><th>Representative Keys</th></tr></thead><tbody>${sampleRows || "<tr><td colspan=\"4\">No manifest table samples found.</td></tr>"}</tbody></table></div></details>
    <div class="meta-grid compact">
      <div><strong>Manifest</strong>${manifest ? `${renderDashboardDateTime(manifest.generatedAt)}<br><code>${escapeHtml(manifest.jsonPath)}</code>` : "none"}</div>
      <div><strong>Conflicts</strong>${manifest ? `${formatNumber(manifest.conflictRows)}<br><span class="muted">${formatNumber(manifest.projectIdRewriteRows)} project-id rewrites, ${formatNumber(manifest.legacyReadabilityWarnings)} legacy warnings</span>` : "unknown"}</div>
      <div><strong>Import Result</strong>${importResult ? `${renderDashboardDateTime(importResult.generatedAt)}<br><code>${escapeHtml(importResult.jsonPath)}</code>` : "none"}</div>
      <div><strong>Backup Path</strong>${backup ? `${renderDashboardDateTime(backup.generatedAt)}<br><code>${escapeHtml(backup.path)}</code>` : "none"}</div>
      <div><strong>Object Proof</strong>${objectProof ? `${renderDashboardDateTime(objectProof.generatedAt)}<br><code>${escapeHtml(objectProof.jsonPath)}</code>` : "none"}</div>
      <div><strong>Project Decisions</strong>${projectDecisions ? `${renderDashboardDateTime(projectDecisions.generatedAt)}<br><code>${escapeHtml(projectDecisions.jsonPath)}</code>` : "none"}</div>
    </div>
    <details class="governance-details"><summary>Recommended Commands</summary><ul>${commandRows}</ul></details>
    ${backupFiles ? `<details class="governance-details"><summary>Backup Files</summary><ul>${backupFiles}</ul></details>` : ""}
    ${warningRows ? `<details class="governance-details" open><summary>Evidence Notes</summary><ul>${warningRows}</ul></details>` : ""}
    <p class="muted">Current state: <span class="status ${statusClass}">${evidence.safePrimaryStatePlane ? "ready" : "attention"}</span>.</p>
  </section>`;
}

export function renderPrimaryStatePlaneOperatorPanel(
  mergeEvidence: StorageMergeEvidenceListing,
  offlineFallback: OfflineFallbackReport,
  runtimeMonitor: RuntimeMonitorReport
): string {
  const primaryReady = mergeEvidence.safePrimaryStatePlane && offlineFallback.currentServicesReachable;
  const statusClass = primaryReady ? "completed" : "queued";
  const sharedHost = runtimeMonitor.storageHost ?? runtimeMonitor.sharedHost.host ?? "not configured";
  const pendingOfflineItems = offlineFallback.queue.items.filter((item) => item.status === "pending").length;
  const warningChecks = mergeEvidence.switchOverProof.checks.filter((check) => check.status === "warn");
  const warningRows = warningChecks.map((check) => `<li><strong>${escapeHtml(check.label)}</strong>: ${escapeHtml(check.detail)}</li>`).join("");
  const commandRows = [
    "docker compose -f infra/docker-compose.yml stop postgres redis minio",
    "npm run doctor",
    "npm run storage-merge-evidence",
    "npm run offline-fallback"
  ].map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
  const summary = primaryReady
    ? "shared host/shared storage is the primary state plane. Local Docker storage should stay stopped unless shared storage is unavailable."
    : "Shared storage is not fully proven as the primary state plane yet; review the checks below before switching clients.";
  return `<section class="panel">
    <div class="section-heading">
      <div>
        <h2>Primary State Plane</h2>
        <span class="muted">Operator note for which storage plane Agent Workflow should use day to day.</span>
      </div>
      <span class="status ${statusClass}">${primaryReady ? "shared primary" : "needs review"}</span>
    </div>
    <div class="metric-grid">
      ${metricCard("Primary", primaryReady ? "shared host" : "not proven", summary)}
      ${metricCard("Shared Host", sharedHost, offlineFallback.currentServicesReachable ? "reachable" : "not reachable")}
      ${metricCard("Local Storage", offlineFallback.localServicesReachable ? "running" : "stopped", primaryReady ? "fallback-only while shared host is online" : "fallback may be needed")}
      ${metricCard("Offline Queue", pendingOfflineItems, "pending local fallback items")}
      ${metricCard("Proof", mergeEvidence.switchOverProof.status, `${mergeEvidence.conflictClassification.criticalRows} critical conflict row(s)`)}
      ${metricCard("Warnings", warningChecks.length, "visible audit/refresh items")}
    </div>
    <p>${escapeHtml(summary)}</p>
    ${warningRows ? `<details class="governance-details" open><summary>Visible Non-Blocking Warnings</summary><ul>${warningRows}</ul></details>` : '<p class="muted">No non-blocking switch-over warnings are currently reported.</p>'}
    <details class="governance-details"><summary>Operator Commands</summary><ul>${commandRows}</ul></details>
  </section>`;
}

export function renderReadinessGroup(id: string, title: string, summary: string, content: string): string { return `<details class="readiness-group" id="${escapeHtml(id)}"><summary><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(summary)}</small></span><span class="readiness-group-action">View details</span></summary><div class="readiness-group-content">${content}</div></details>`; }

export function renderServerApprovalActionPlanPanel(report: ServerApprovalActionPlanReport, testAdapter: ServerApprovalActionTestAdapterReport): string {
  const statusClass = report.status === "ready" ? "completed" : report.status === "blocked" ? "failed" : "queued";
  const testStatusClass = testAdapter.status === "pass" ? "completed" : "failed";
  const decisionRows = report.decisions.map((decision) => {
    const rowStatusClass = decision.status === "ready" ? "completed" : "failed";
    const receipts = decision.requiredReceiptKinds.map((receipt) => `<code>${escapeHtml(receipt)}</code>`).join(" ");
    const missing = decision.missingControls.length
      ? decision.missingControls.map((control) => `<code>${escapeHtml(control)}</code>`).join(" ")
      : '<span class="muted">none</span>';
    return `
    <tr>
      <td><strong>${escapeHtml(decision.decision)}</strong><br><span class="muted">${decision.executesSideEffect ? "executes side effect" : "approval state only"}</span></td>
      <td><span class="status ${rowStatusClass}">${escapeHtml(decision.status)}</span><br><span class="muted">${decision.mutatesApprovalState ? "mutates approval state" : "read-only"}</span></td>
      <td>${receipts}</td>
      <td><code>${escapeHtml(decision.idempotencyReuseKey)}</code><br><span class="muted">${escapeHtml(decision.replayBehavior)}</span></td>
      <td>${decision.rollbackEvidence.map((item) => escapeHtml(item)).join("<br>")}</td>
      <td>${missing}</td>
    </tr>`;
  }).join("");
  const phaseRows = report.implementationPhases.map((phase) => `<li><strong>${escapeHtml(phase.phase)}</strong> <span class="status ${phase.status === "done" ? "completed" : phase.status === "next" ? "queued" : "pending"}">${escapeHtml(phase.status)}</span> ${escapeHtml(phase.detail)}</li>`).join("");
  return `<section class="panel"><div class="section-heading"><div><h2>Approval Action Plan</h2><span class="muted">Per-decision receipt, replay, and rollback checklist before remote approval mutations can be enabled.</span></div><div class="actions"><a class="button secondary" href="/api/server-approval-action-plan">Plan JSON</a><a class="button secondary" href="/api/server-approval-action-test-adapter">Test JSON</a></div></div>
  <div class="metric-grid">
    ${metricCard("Plan", report.status, "remote approval mutation")}
    ${metricCard("Decisions", report.summary.decisions, "approval actions")}
    ${metricCard("Ready", report.summary.ready, "decision paths")}
    ${metricCard("Blocked", report.summary.blocked, "decision paths")}
    ${metricCard("Test Adapter", testAdapter.status, `${testAdapter.summary.passed}/${testAdapter.summary.decisions} decisions`)}
    ${metricCard("Replay Proof", testAdapter.summary.replayed, "idempotent fixture paths")}
    ${metricCard("Receipts", report.summary.receiptPlanReady ? "ready" : "blocked", "per-action")}
    ${metricCard("Idempotency", report.summary.idempotencyReuseReady ? "ready" : "blocked", "replay")}
  </div>
  <p class="muted">Generated ${renderDashboardDateTime(report.generatedAt)}. Current status: <span class="status ${statusClass}">${escapeHtml(report.status)}</span>. Enablement: ${report.canEnableApprovalActions ? "allowed" : "blocked"}. Test adapter: <span class="status ${testStatusClass}">${escapeHtml(testAdapter.status)}</span>, ${formatNumber(testAdapter.summary.simulatedSideEffects)} simulated side effect(s), no live effects.</p>
  <div class="table-wrap"><table><thead><tr><th>Decision</th><th>Status</th><th>Receipts</th><th>Idempotency Replay</th><th>Rollback Evidence</th><th>Missing Controls</th></tr></thead><tbody>${decisionRows}</tbody></table></div>
  ${phaseRows ? `<details class="governance-details" open><summary>Implementation Phases</summary><ul>${phaseRows}</ul></details>` : ""}
  </section>`;
}

export function renderServerAuthHardeningPanel(report: ServerAuthHardeningReport): string {
  const statusClass = report.status === "ready" || report.status === "local-only" ? "completed" : report.status === "blocked" ? "failed" : "queued";
  const checkRows = report.checks.map((check) => `
    <tr>
      <td>${escapeHtml(check.label)}</td>
      <td><span class="status ${check.status === "pass" ? "completed" : check.status === "fail" ? "failed" : "queued"}">${escapeHtml(check.status)}</span></td>
      <td>${escapeHtml(check.detail)}</td>
    </tr>
  `).join("");
  const actionRows = report.recommendedActions.map((action) => `<li>${escapeHtml(action)}</li>`).join("");
  return `<section class="panel"><div class="section-heading"><div><h2>Auth Hardening</h2><span class="muted">Operator checklist before Agent Workflow is exposed as a shared server surface.</span></div><span class="status ${statusClass}">${escapeHtml(report.status)}</span></div>
  <div class="metric-grid">
    ${metricCard("Ready", report.readyControls, "controls passing")}
    ${metricCard("Warnings", report.warningControls, "review before shared use")}
    ${metricCard("Blocked", report.failingControls, "must fix first")}
    ${metricCard("Posture", report.status, "server auth")}
  </div>
  <p class="muted">${escapeHtml(report.summary)}</p>
  <div class="table-wrap"><table><thead><tr><th>Control</th><th>Status</th><th>Detail</th></tr></thead><tbody>${checkRows}</tbody></table></div>
  ${actionRows ? `<details class="governance-details" open><summary>Recommended Actions</summary><ul>${actionRows}</ul></details>` : ""}
  </section>`;
}

export function renderServerMutationControlsPanel(report: ServerMutationControlReport): string {
  const statusClass = report.status === "ready" ? "completed" : report.status === "blocked" ? "failed" : "queued";
  const endpointRows = report.endpoints.map((endpoint) => {
    const endpointStatusClass = endpoint.status === "ready" ? "completed" : endpoint.status === "blocked" ? "failed" : "queued";
    const missingControls = endpoint.missingControls.length
      ? endpoint.missingControls.map((control) => `<code>${escapeHtml(control)}</code>`).join(" ")
      : '<span class="muted">none</span>';
    return `
    <tr>
      <td>${escapeHtml(endpoint.name)}<br><code>${escapeHtml(`${endpoint.method} ${endpoint.path}`)}</code></td>
      <td><span class="status ${endpointStatusClass}">${escapeHtml(endpoint.status)}</span><br><span class="muted">${escapeHtml(endpoint.exposure)}</span></td>
      <td>${endpoint.remoteEligible ? "yes" : "local-only"}<br><span class="muted">${endpoint.dryRunDefault ? "dry-run default" : "executes when submitted"}</span></td>
      <td>${escapeHtml(endpoint.executionGate)}</td>
      <td>${endpoint.roleCapability ? `<code>${escapeHtml(endpoint.roleCapability)}</code>` : '<span class="muted">n/a</span>'}</td>
      <td>${endpoint.receipt ? `<code>${escapeHtml(endpoint.receipt)}</code>` : '<span class="muted">n/a</span>'}</td>
      <td>${missingControls}</td>
    </tr>`;
  }).join("");
  const actionRows = report.recommendedActions.map((action) => `<li>${escapeHtml(action)}</li>`).join("");
  return `<section class="panel"><div class="section-heading"><div><h2>Mutation Controls</h2><span class="muted">Read-only audit of server-mode and local operator mutation surfaces.</span></div><a class="button secondary" href="/api/server-mutation-controls">JSON</a></div>
  <div class="metric-grid">
    ${metricCard("Controls", report.status, "remote mutation posture")}
    ${metricCard("Remote Mutations", report.summary.remoteMutationEndpoints, `${report.summary.readyRemoteMutations} ready`)}
    ${metricCard("Blocked", report.summary.blockedRemoteMutations, "remote mutations gated")}
    ${metricCard("Local Actions", report.summary.localOnlyMutations, "dashboard/operator only")}
    ${metricCard("Approval Gate", report.mode.approvalActionExecutionEnabled ? "on" : "off", "server approval actions")}
    ${metricCard("Body Limit", `${report.mode.requestBodyMaxBytes} bytes`, "remote JSON mutation")}
    ${metricCard("Rate Limit", report.mode.rateLimitPerMinute <= 0 ? "off" : `${report.mode.rateLimitPerMinute}/min`, "per actor/IP")}
  </div>
  <p class="muted">Generated ${renderDashboardDateTime(report.generatedAt)}. Current status: <span class="status ${statusClass}">${escapeHtml(report.status)}</span>.</p>
  <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>Status</th><th>Exposure</th><th>Execution Gate</th><th>Role</th><th>Receipt</th><th>Missing Controls</th></tr></thead><tbody>${endpointRows}</tbody></table></div>
  ${actionRows ? `<details class="governance-details"><summary>Recommended Actions</summary><ul>${actionRows}</ul></details>` : ""}
  </section>`;
}

export function renderServerRequestAuditPanel(report: ServerRequestAuditReport): string {
  const rows = report.events.slice(0, 25).map((event) => `
    <tr>
      <td>${renderDashboardDateTime(event.generatedAt)}<br><code>${escapeHtml(event.requestId ?? "n/a")}</code></td>
      <td><span class="status ${event.status === "queued" || event.status === "ready" ? "completed" : event.status === "blocked" || event.status === "rejected" ? "failed" : "queued"}">${escapeHtml(event.status)}</span><br><span class="muted">${event.dryRun ? "dry-run" : "executed"}</span></td>
      <td><code>${escapeHtml(event.method)} ${escapeHtml(event.path)}</code><br><span class="muted">${event.projectId ? `project ${escapeHtml(event.projectId)}` : "project n/a"}</span></td>
      <td>${escapeHtml(event.workflowId ?? "n/a")}<br><span class="muted">task ${escapeHtml(event.taskHash ?? "n/a")} (${event.taskBytes} bytes)</span></td>
      <td>${escapeHtml(event.auth.method)}<br><span class="status ${event.auth.accepted ? "completed" : "failed"}">${event.auth.accepted ? "accepted" : escapeHtml(event.auth.errorCode ?? "rejected")}</span></td>
      <td>${event.rateLimit.accepted === null ? "n/a" : `<span class="status ${event.rateLimit.accepted ? "completed" : "failed"}">${event.rateLimit.accepted ? "accepted" : "limited"}</span>`}<br><span class="muted">${event.rateLimit.remaining === null ? "" : `${event.rateLimit.remaining} remaining`}</span></td>
      <td>${event.queuedRunId ? `<a href="/run?id=${encodeURIComponent(event.queuedRunId)}">${escapeHtml(event.queuedRunId.slice(0, 8))}</a>` : "none"}<br><span class="muted">${event.reusedRun === null ? "" : event.reusedRun ? "reused" : "new"}</span></td>
    </tr>
  `).join("");
  return `<section class="panel"><div class="section-heading"><div><h2>Remote Request Audit</h2><span class="muted">Redacted JSONL evidence for governed server queue requests. No task text, tokens, credentials, local roots, actor names, IPs, origins, or user agents are stored raw.</span></div><a class="button secondary" href="/api/server-request-log">JSON</a></div>
  <div class="metric-grid">
    ${metricCard("Events", report.totalRead, "redacted request records")}
    ${metricCard("Queued", report.queued, "workflow requests")}
    ${metricCard("Blocked", report.blocked, "blocked or rejected")}
    ${metricCard("Dry Runs", report.dryRuns, "preview-only requests")}
    ${metricCard("Rate Limited", report.rateLimited, "request decisions")}
    ${metricCard("Invalid Lines", report.invalidLines, "skipped while reading")}
  </div>
  <div class="meta-grid compact"><div><strong>Log Path</strong><code>${escapeHtml(report.logPath)}</code></div><div><strong>Latest</strong>${report.latestAt ? renderDashboardDateTime(report.latestAt) : "none"}</div><div><strong>Status Counts</strong>${escapeHtml(formatInlineCounts(report.statusCounts) || "none")}</div><div><strong>Auth Counts</strong>${escapeHtml(formatInlineCounts(report.authCounts) || "none")}</div></div>
  <div class="table-wrap"><table><thead><tr><th>Time</th><th>Status</th><th>Endpoint</th><th>Workflow</th><th>Auth</th><th>Rate Limit</th><th>Run</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No governed server request audit events found.</td></tr>'}</tbody></table></div></section>`;
}

export function renderSharedStatePlaneProofPanel(proof: SharedStatePlaneProof): string {
  const statusClass = proof.status === "ready" ? "completed" : proof.status === "blocked" ? "failed" : "queued";
  const checkRows = proof.checks.map((check) => `
    <tr>
      <td>${escapeHtml(check.label)}</td>
      <td><span class="status ${check.status === "pass" ? "completed" : check.status === "fail" ? "failed" : "queued"}">${escapeHtml(check.status)}</span></td>
      <td>${escapeHtml(check.detail)}</td>
    </tr>
  `).join("");
  const actions = proof.recommendedActions.map((action) => `<li>${escapeHtml(action)}</li>`).join("");
  return `<section class="panel">
    <div class="section-heading">
      <div>
        <h2>Shared State Plane</h2>
        <span class="muted">One verdict for shared host/shared storage, post-merge proof, offline fallback, object parity, and server controls.</span>
      </div>
      <span class="status ${statusClass}">${escapeHtml(proof.status)}</span>
    </div>
    <div class="metric-grid">
      ${metricCard("State Plane", proof.status, proof.summary)}
      ${metricCard("Shared Host", proof.sharedHost ?? "not configured", "configured durable storage target")}
      ${metricCard("Local Fallback", proof.localFallbackCanStayStopped ? "can stay stopped" : "keep available", "based on shared health and sync queue")}
      ${metricCard("Open Items", proof.recommendedActions.length, "operator follow-up")}
    </div>
    <p class="muted">Generated ${renderDashboardDateTime(proof.generatedAt)}. ${escapeHtml(proof.summary)}</p>
    <div class="table-wrap"><table><thead><tr><th>Proof</th><th>Status</th><th>Detail</th></tr></thead><tbody>${checkRows}</tbody></table></div>
    ${actions ? `<details class="governance-details" open><summary>Recommended Actions</summary><ul>${actions}</ul></details>` : `<p class="muted">No state-plane follow-up actions are currently recommended.</p>`}
  </section>`;
}

export function serverOrchestrationStatusIsTerminal(status: ServerOrchestrationStatusReport["status"]): boolean {
  return status === "completed" || status === "blocked" || status === "failed" || status === "missing";
}
