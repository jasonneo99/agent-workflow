import type { Dirent } from "node:fs";
import { sourceSubjectHash } from "../../../../packages/workflow-engine/src/source-subject.js";
import type { StructuredAcceptanceContract } from "../../../../packages/model-providers/src/types.js";
import type { CliContext } from "./context.js";
import { influenceHash, type ContextInfluence } from "../../../../packages/project-evidence/src/influence.js";
import type { ArtifactLifecycleAction, DashboardWorkflowGraphReport, ArtifactLifecyclePolicy, DashboardActionApproval, DashboardFollowUpResult, DashboardProjectPathResolution, RunInputSnapshot, SourceSummaryWithHash, TeamRoleCapability, DashboardWorkflowStageRun, FocusedStageDeltaSummary, FocusedStageOutcomeSummary} from "./cli-types.js";
import { byId, loadAgents, loadProjectConfig, loadWorkflows, loadYamlFile } from "../../../../packages/agent-registry/src/loaders.js";
import { buildBundleManifest } from "../../../../packages/agent-registry/src/manifest.js";
import { type AgentCard, type ProjectConfig, type WorkflowDefinition, agentCardSchema, projectConfigSchema } from "../../../../packages/agent-registry/src/schemas.js";
import { compileContext } from "../../../../packages/context-compiler/src/index.js";
import { type ContextRoutingPolicy, buildContextEfficiencyReport, contextRoutingPolicySchema, writeShadowObservationBatch } from "../../../../packages/context-gateway/src/index.js";
import { selectRelevantSourceSummaries } from "../../../../packages/context-selector/src/index.js";
import { optimizeStaticWorkflowForLatency } from "../../../../packages/dynamic-workflow/src/index.js";
import { type ExecutorResult, type ExecutorSnapshot, assertExecutorRegistration, assertSnapshot, executeExecutorSnapshot } from "../../../../packages/executor-adapters/src/index.js";
import { assertCommandAllowed, executeAllowedCommand } from "../../../../packages/local-tools/src/command-executor.js";
import { executeAllowedFileWrite } from "../../../../packages/local-tools/src/file-writer.js";
import { providerFromEnv } from "../../../../packages/model-providers/src/index.js";
import { evaluateAgentAutonomy, resolveExecutionPolicy } from "../../../../packages/policy-engine/src/index.js";
import { indexProjectFiles } from "../../../../packages/project-indexer/src/index.js";
import { reliabilityProtocolVersions } from "../../../../packages/reliability-control/src/index.js";
import { type GovernedReusePlan, buildGovernedReusePlan } from "../../../../packages/reuse-engine/src/index.js";
import { type RoadmapSnapshot, readRoadmapSnapshotFromProject } from "../../../../packages/roadmap-snapshot/src/index.js";
import { type CostQualityReport, buildCostQualityReport } from "../../../../packages/run-reporter/src/index.js";
import { resolveLocalProjectPath } from "../../../../packages/runtime-root/src/index.js";
import { claimActionApprovalExecution, createWorkflowRun, decideActionApproval, deleteProjectFiles, findRunActionByIdempotencyKey, getActionApproval, getArtifactById, getArtifactByUri, getLatestMemory, getProjectIndexState, getWorkflowRunDetails, listActionApprovals, listArtifacts, listProjectFileSummaries, listProjectStorageSummaries, listWorkflowReuseEvidence, markActionApprovalExecution, recordRunAction, resumeWorkflowRunFromCheckpoint, seedRegistry, upsertProject, upsertProjectFiles, upsertProjectIndexState } from "../../../../packages/storage/src/postgres.js";
import { executorApprovalTarget, runExecutorApprovalGate } from "../../../../packages/workflow-engine/src/executor.js";
import { attachCodexOrigin } from "../codex-callback.js";
import { executeContextCorrection } from "../../../../packages/storage/src/context-corrections.js";
import { parsePositiveInteger } from "../numeric-options.js";
import { resolveWorkflow } from "../reference-resolution.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export async function approveAndExecuteAction(ctx: CliContext, input: {
  approvalId: string;
  actor: string;
  approveActorRole: string;
  executeActorRole: string;
  note?: string;
}): Promise<DashboardFollowUpResult> {
  const approvalForGate = await getActionApproval(input.approvalId);
  if (!approvalForGate) {
    return { ok: false, error: "Approval was not found or is no longer pending." };
  }
  if (!isExecutableApprovalAction(approvalForGate.actionType)) {
    return { ok: false, error: `Approval action type cannot be executed inline: ${approvalForGate.actionType}` };
  }
  const project = await loadApprovalProjectConfig(ctx, approvalForGate);
  const approvalGate = evaluateRoleGate(project, input.approveActorRole, "can_approve_actions");
  if (!approvalGate.allowed) {
    return { ok: false, error: approvalGate.message };
  }
  const approval = await decideActionApproval({
    approvalId: input.approvalId,
    decision: "approved",
    actor: input.actor,
    actorRole: input.approveActorRole,
    note: input.note?.trim() || "Approved and queued for immediate execution."
  });
  if (!approval) {
    return { ok: false, error: "Approval was not found or is no longer pending." };
  }
  const execution = await executeApprovedAction(ctx, {
    approvalId: input.approvalId,
    actor: input.actor,
    actorRole: input.executeActorRole
  });
  if (!execution.ok) {
    return {
      ok: false,
      error: [
        "Action was approved, but immediate execution failed.",
        execution.error
      ].join("\n")
    };
  }
  const resumed = await resumeBlockedRunAfterResolvedApprovals(approval.runId);
  return {
    ok: true,
    title: "Action approved and executed",
    runId: resumed.replacementRunId ?? approval.runId,
    redirectToRun: Boolean(resumed.replacementRunId),
    output: [
      `Approval: ${approval.id}`,
      `Action: ${approval.actionType}`,
      `Target: ${approval.target}`,
      `Project: ${approval.projectRootUri}`,
      `Approval role gate: ${approvalGate.message}`,
      execution.output,
      resumed.resumedTasks > 0 ? `Resumed ${resumed.resumedTasks} blocked or unfinished stage${resumed.resumedTasks === 1 ? "" : "s"} in replacement run ${resumed.replacementRunId ?? approval.runId}.` : ""
    ].filter(Boolean).join("\n")
  };
}

export function buildArchivedArtifactContent(input: {
  approval: NonNullable<Awaited<ReturnType<typeof getActionApproval>>>;
  targetArtifact: NonNullable<Awaited<ReturnType<typeof getArtifactByUri>>>;
  policyRecheck: Record<string, unknown>;
  actor: string;
  actorRole?: string;
}): Record<string, unknown> {
  return {
    approvalId: input.approval.id,
    originalActionType: input.approval.actionType,
    lifecycleAction: "archive",
    target: input.approval.target,
    policyDecision: input.approval.policyDecision,
    payload: input.approval.payload,
    policyRecheck: input.policyRecheck,
    skipped: false,
    archivedAt: new Date().toISOString(),
    archivedBy: input.actor,
    archivedByRole: input.actorRole ?? null,
    restoreMetadata: {
      originalArtifactId: input.targetArtifact.id,
      originalRunId: input.targetArtifact.runId,
      originalTaskId: input.targetArtifact.taskId,
      originalKind: input.targetArtifact.kind,
      originalUri: input.targetArtifact.uri,
      originalCreatedAt: input.targetArtifact.createdAt
    },
    archivedContent: input.targetArtifact.content
  };
}

export function buildRestoredArtifactContent(input: {
  approval: NonNullable<Awaited<ReturnType<typeof getActionApproval>>>;
  archivedArtifact: NonNullable<Awaited<ReturnType<typeof getArtifactByUri>>>;
  policyRecheck: Record<string, unknown>;
  actor: string;
  actorRole?: string;
}): Record<string, unknown> {
  const restoreMetadata = objectFromRecord(input.archivedArtifact.content, "restoreMetadata");
  const originalUri = stringFromRecord(restoreMetadata, "originalUri") || stringFromRecord(input.archivedArtifact.content, "target") || input.approval.target;
  return {
    approvalId: input.approval.id,
    originalActionType: input.approval.actionType,
    lifecycleAction: "restore",
    target: input.approval.target,
    restoredTargetUri: originalUri,
    policyDecision: input.approval.policyDecision,
    payload: input.approval.payload,
    policyRecheck: input.policyRecheck,
    skipped: false,
    restoredAt: new Date().toISOString(),
    restoredBy: input.actor,
    restoredByRole: input.actorRole ?? null,
    restoreSource: {
      archivedArtifactId: input.archivedArtifact.id,
      archivedArtifactUri: input.archivedArtifact.uri,
      archivedArtifactRunId: input.archivedArtifact.runId,
      archivedArtifactTaskId: input.archivedArtifact.taskId,
      archivedArtifactCreatedAt: input.archivedArtifact.createdAt
    },
    restoreMetadata,
    restoredContent: input.archivedArtifact.content.archivedContent
  };
}

export async function buildReusePlanForTask(input: {
  projectDir: string;
  task: string;
  workflow: Awaited<ReturnType<typeof loadWorkflows>>[number];
  policySnapshotHash: string;
  sourceSummaries: SourceSummaryWithHash[];
}): Promise<GovernedReusePlan> {
  const target = {
    task: input.task,
    workflowId: input.workflow.id,
    workflowHash: stableHash(input.workflow),
    policySnapshotHash: input.policySnapshotHash,
    selectedSources: input.sourceSummaries.map((summary) => ({
      sourceUri: summary.sourceUri,
      contentHash: summary.contentHash ?? null
    }))
  };
  try {
    const evidence = await listWorkflowReuseEvidence({
      projectRootUri: input.projectDir,
      workflowId: input.workflow.id,
      limit: 100
    });
    return buildGovernedReusePlan({ target, candidates: evidence.runs, memory: evidence.memory });
  } catch {
    return buildGovernedReusePlan({ target, candidates: [], memory: [] });
  }
}

export async function buildRunInputSnapshot(ctx: CliContext, input: {
  projectConfig: ProjectConfig;
  policySnapshotHash: string;
  workflow: WorkflowDefinition;
  sourceSummaries: SourceSummaryWithHash[];
}): Promise<RunInputSnapshot> {
  const manifest = await buildBundleManifest(ctx.rootDir).catch(() => null);
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    bundle: manifest
      ? {
        version: manifest.bundle.version,
        checksum: manifest.checksum.value
      }
      : null,
    projectConfigHash: stableHash(input.projectConfig),
    policySnapshotHash: input.policySnapshotHash,
    workflowHash: stableHash(input.workflow),
    selectedSources: input.sourceSummaries.map((summary) => ({
      sourceUri: summary.sourceUri,
      contentHash: summary.contentHash ?? null
    }))
  };
}

export async function buildStoredRoadmapSnapshot(input: {
  projectId: string;
  projectDir: string;
  project: ProjectConfig;
}): Promise<RoadmapSnapshot> {
  const source = input.project.project.roadmap_path?.trim() || "docs/roadmap.md";
  return readRoadmapSnapshotFromProject({
    projectId: input.projectId,
    projectName: input.project.project.name,
    projectRootUri: input.projectDir,
    source,
    publishingHost: os.hostname()
  });
}

export async function commandAvailable(ctx: CliContext, command: string): Promise<boolean> {
  const result = await execFileText(ctx, "sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], { allowFailure: true });
  return result.exitCode === 0;
}

export function compactDashboardText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

export function countStrings(items: string[]): Record<string, number> {
  return mergeCounts(items.map((item) => ({ [item]: 1 })));
}

export async function ensureProjectSubdir(projectDir: string, targetDir: string, label: string): Promise<void> {
  const projectRoot = path.resolve(projectDir);
  const resolved = path.resolve(targetDir);
  if (!resolved.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`Refusing to write outside project ${label}: ${targetDir}`);
  }
  await fs.mkdir(resolved, { recursive: true });
}

export function evaluateRoleGate(project: ProjectConfig, actorRole: string, capability: TeamRoleCapability): { allowed: boolean; message: string } {
  const mode = project.team.enforcement ?? "preview";
  const role = project.team.roles[actorRole];
  const hasCapability = Boolean(role?.[capability]);
  const capabilityLabel = capability.replace(/^can_/, "").replaceAll("_", " ");
  if (mode === "enforce" && !hasCapability) {
    return {
      allowed: false,
      message: `Role gate blocked: ${actorRole} is not configured to ${capabilityLabel}. Set team.enforcement: preview or grant ${capability} in .agent-workflow/project.yaml.`
    };
  }
  return {
    allowed: true,
    message: `${mode === "enforce" ? "Role gate passed" : "Role gate preview"}: ${actorRole} ${hasCapability ? "can" : "is not configured to"} ${capabilityLabel}.`
  };
}

export function evaluateSeparationOfDuties(project: ProjectConfig, approval: DashboardActionApproval, actor: string): { allowed: boolean; message: string } {
  const config = project.team.separation_of_duties;
  if (config.mode === "off" || !config.prevent_same_actor_approval_execution) {
    return { allowed: true, message: "off" };
  }
  if (!approval.decidedBy || approval.decidedBy !== actor) {
    return {
      allowed: true,
      message: `${config.mode}: approver and executor are distinct or the approver is unrecorded.`
    };
  }
  const message = `Separation of duties ${config.mode}: ${actor} approved this action and is now executing it.`;
  return {
    allowed: config.mode !== "enforce",
    message: config.mode === "enforce"
      ? `${message} Use a different executor or set team.separation_of_duties.mode to preview/off.`
      : message
  };
}

export async function execFileText(ctx: CliContext, command: string, args: string[], options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: ctx.rootDir, env: options.env ?? process.env, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const rawCode = (error as NodeJS.ErrnoException | null)?.code;
      const exitCode = typeof rawCode === "number" ? rawCode : error ? 1 : 0;
      if (error && !options.allowFailure) {
        reject(error);
        return;
      }
      resolve({ exitCode, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

export async function executeApprovedAction(ctx: CliContext, input: {
  approvalId: string;
  actor: string;
  actorRole?: string;
}): Promise<DashboardFollowUpResult> {
  const approval = await getActionApproval(input.approvalId);
  if (!approval) {
    return { ok: false, error: `Unknown approval: ${input.approvalId}` };
  }
  if (approval.status === "executed") {
    return {
      ok: true,
      title: "Action already executed",
      runId: approval.runId,
      output: [
        `Approval: ${approval.id}`,
        `Action: ${approval.actionType}`,
        `Target: ${approval.target}`,
        "Existing execution status was preserved."
      ].join("\n")
    };
  }
  if (approval.status !== "approved" && approval.status !== "failed" && approval.status !== "executing") {
    return { ok: false, error: `Approval must be approved before execution. Current status: ${approval.status}` };
  }
  const project = await loadApprovalProjectConfig(ctx, approval);
  const executionRoleGate = evaluateRoleGate(project, input.actorRole ?? project.team.default_actor_role, "can_execute_approved_actions");
  if (!executionRoleGate.allowed) {
    return { ok: false, error: executionRoleGate.message };
  }
  const separationGate = evaluateSeparationOfDuties(project, approval, input.actor);
  if (!separationGate.allowed) {
    return { ok: false, error: separationGate.message };
  }

  if (approval.actionType === "deployment" || approval.actionType === "autonomy") {
    return {
      ok: true,
      title: "Approval decision recorded",
      runId: approval.runId,
      output: [
        `Approval: ${approval.id}`,
        `Action: ${approval.actionType}`,
        `Target: ${approval.target}`,
        `Role gate: ${executionRoleGate.message}`,
        `Separation of duties: ${separationGate.message}`,
        "This approval records a human decision; it does not execute a local command.",
        "Run any deployment or autonomy-changing command separately under project policy."
      ].join("\n")
    };
  }
  if (!["context_correction", "artifact_prune", "artifact_archive", "artifact_restore", "object_mirror", "local_command", "file_write", "executor_adapter", "project_policy_change"].includes(approval.actionType)) {
    return { ok: false, error: `Unsupported approval action type: ${approval.actionType}` };
  }

  const executionClaim = await claimActionApprovalExecution({
    approvalId: approval.id,
    actor: input.actor,
    actorRole: input.actorRole,
    claimSeconds: 3600
  });
  if (!executionClaim) {
    return { ok: false, error: "Approved action is already being executed by another caller or is no longer executable." };
  }
  const executionClaimToken = executionClaim.claimToken;

  if (approval.actionType === "artifact_prune" || approval.actionType === "artifact_archive" || approval.actionType === "artifact_restore") {
    return executeLifecycleApproval({
      approval,
      project,
      actor: input.actor,
      actorRole: input.actorRole,
      executionRoleGate: executionRoleGate.message,
      separationGate: separationGate.message,
      executionClaimToken
    });
  }

  if (approval.actionType === "object_mirror") {
    return executeObjectMirrorApproval(ctx, {
      approval,
      actor: input.actor,
      actorRole: input.actorRole,
      executionRoleGate: executionRoleGate.message,
      separationGate: separationGate.message,
      executionClaimToken
    });
  }

  const artifactKind = approval.actionType === "context_correction" ? "context_correction" : approval.actionType === "local_command" ? "command_output" : approval.actionType === "file_write" ? "file_write" : approval.actionType === "executor_adapter" ? "executor_output" : approval.actionType === "project_policy_change" ? "project_policy_change" : "";
  if (!artifactKind) {
    return { ok: false, error: `Unsupported approval action type: ${approval.actionType}` };
  }

  const previous = await findRunActionByIdempotencyKey({
    runId: approval.runId,
    artifactKind,
    idempotencyKey: approval.idempotencyKey
  });
  if (previous) {
    await markActionApprovalExecution({
      approvalId: approval.id,
      status: "executed",
      actor: input.actor,
      actorRole: input.actorRole,
      summary: `Approved action already had an execution artifact: ${previous.uri}`,
      artifactUri: previous.uri,
      executionClaimToken
    });
    return {
      ok: true,
      title: "Approved action reused",
      runId: approval.runId,
      output: [
        `Approval: ${approval.id}`,
        `Action: ${approval.actionType}`,
        `Target: ${approval.target}`,
        `Artifact: ${previous.uri}`
      ].join("\n")
    };
  }

  try {
    if (approval.actionType === "context_correction") {
      const artifactUri = await executeContextCorrection({approvalId:approval.id, claimToken:executionClaimToken, actor:input.actor});
      await markActionApprovalExecution({approvalId:approval.id,status:"executed",actor:input.actor,actorRole:input.actorRole,summary:"Attributed context correction recorded.",artifactUri,executionClaimToken});
      return {ok:true,title:"Context correction recorded",runId:approval.runId,output:`Approval: ${approval.id}\nArtifact: ${artifactUri}`};
    }
    if (approval.actionType === "project_policy_change") {
      return executeProjectPolicyChangeApproval({ approval, actor: input.actor, actorRole: input.actorRole, executionClaimToken });
    }
    if (approval.actionType === "executor_adapter") {
      const snapshot = approval.payload.snapshot as ExecutorSnapshot | undefined;
      if (!snapshot) throw new Error("Approved executor action is missing its immutable snapshot.");
      assertSnapshot(snapshot);
      if (snapshot.registeredProjectRoot !== approval.projectRootUri) throw new Error("Approved executor snapshot project root does not match the registered project.");
      assertExecutorRegistration(snapshot, project, approval.projectRootUri);
      if (approval.target !== executorApprovalTarget(snapshot)) throw new Error("Approved executor target does not match its immutable snapshot.");
      const commandLine = snapshot.operation === "typecheck" ? "npm run typecheck" : snapshot.operation === "validate" ? "npm run validate" : "npm test";
      assertCommandAllowed(commandLine, project);
      const gated = await runExecutorApprovalGate({ project, target: approval.target, approved: true, execute: () => executeExecutorSnapshot(snapshot, {
          localFallback: snapshot.localFallback === "explicit"
            ? async (): Promise<ExecutorResult> => {
                const result = await executeAllowedCommand({ commandLine, cwd: approval.projectRootUri, project });
                return { ...result, status: result.exitCode === 0 && !result.timedOut ? "passed" : "failed", requestedHost: snapshot.requestedHost, executionHost: "local", fallbackUsed: true, artifactReference: null };
              }
            : undefined
        }) });
      if (gated.status !== "executed") throw new Error("Approved executor action remained pending.");
      const execution = gated.result;
      const summary = `${execution.status} on ${execution.executionHost}${execution.fallbackUsed ? " via explicit local fallback" : ""}`;
      const artifactUri = await recordRunAction({
        runId: approval.runId, taskId: approval.taskId, agentId: approval.agentId,
        actionType: "executor_adapter", target: approval.target, summary, artifactKind: "executor_output",
        artifactContent: { snapshot, execution, executedFromApprovalId: approval.id }, idempotencyKey: approval.idempotencyKey
      });
      const passed = execution.status === "passed";
      await markActionApprovalExecution({ approvalId: approval.id, status: passed ? "executed" : "failed", actor: input.actor, actorRole: input.actorRole, summary, artifactUri, executionClaimToken });
      return passed
        ? { ok: true, title: "Approved executor action executed", runId: approval.runId, output: `Approval: ${approval.id}\n${summary}\nArtifact: ${artifactUri}` }
        : { ok: false, error: `Approved executor action failed. ${summary}` };
    }
    if (approval.actionType === "local_command") {
      const commandLine = stringFromRecord(approval.payload, "commandLine") ?? approval.target;
      const localProjectRootUri = await resolveLocalProjectRootUri(approval.projectRootUri);
      const result = await executeAllowedCommand({
        commandLine,
        cwd: localProjectRootUri,
        project
      });
      const summary = [
        `Command \`${result.commandLine}\` exited with ${result.exitCode}`,
        result.timedOut ? "after timing out" : `in ${result.durationMs}ms`
      ].join(" ");
      const artifactUri = await recordRunAction({
        runId: approval.runId,
        taskId: approval.taskId,
        agentId: approval.agentId,
        actionType: "local_command",
        target: result.commandLine,
        summary,
        artifactKind: "command_output",
        artifactContent: {
          ...result,
          executedFromApprovalId: approval.id,
          requestedByTaskId: approval.taskId,
          requestedByStageId: approval.stageId
        },
        idempotencyKey: approval.idempotencyKey
      });
      if (result.exitCode !== 0 || result.timedOut) {
        await markActionApprovalExecution({
          approvalId: approval.id,
          status: "failed",
          actor: input.actor,
          actorRole: input.actorRole,
          summary: `Approved command failed: ${summary}`,
          artifactUri,
          executionClaimToken
        });
        return { ok: false, error: `Approved command failed. ${summary}` };
      }
      await markActionApprovalExecution({
        approvalId: approval.id,
        status: "executed",
        actor: input.actor,
        actorRole: input.actorRole,
        summary: `Approved command executed. ${summary}`,
        artifactUri,
        executionClaimToken
      });
      return {
        ok: true,
        title: "Approved command executed",
        runId: approval.runId,
        output: [
          `Approval: ${approval.id}`,
          summary,
          `Artifact: ${artifactUri}`
        ].join("\n")
      };
    }

    const fileWrite = await loadApprovedFileWrite(approval);
    const localProjectRootUri = await resolveLocalProjectRootUri(approval.projectRootUri);
    const result = await executeAllowedFileWrite({
      relativePath: fileWrite.path,
      content: fileWrite.content,
      cwd: localProjectRootUri,
      project
    });
    const summary = [
      `Wrote ${result.bytesWritten} bytes to \`${result.relativePath}\`.`,
      result.existed ? "Updated existing file." : "Created new file."
    ].join(" ");
    const artifactUri = await recordRunAction({
      runId: approval.runId,
      taskId: approval.taskId,
      agentId: approval.agentId,
      actionType: "file_write",
      target: result.relativePath,
      summary,
      artifactKind: "file_write",
      artifactContent: {
        ...result,
        executedFromApprovalId: approval.id,
        requestedByTaskId: approval.taskId,
        requestedByStageId: approval.stageId
      },
      idempotencyKey: approval.idempotencyKey
    });
    await markActionApprovalExecution({
      approvalId: approval.id,
      status: "executed",
      actor: input.actor,
      actorRole: input.actorRole,
      summary: `Approved file write executed. ${summary}`,
      artifactUri,
      executionClaimToken
    });
    return {
      ok: true,
      title: "Approved file write executed",
      runId: approval.runId,
      output: [
        `Approval: ${approval.id}`,
        summary,
        `Artifact: ${artifactUri}`
      ].join("\n")
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markActionApprovalExecution({
      approvalId: approval.id,
      status: "failed",
      actor: input.actor,
      actorRole: input.actorRole,
      summary: `Approved action execution failed: ${message}`,
      error: message,
      executionClaimToken
    });
    return { ok: false, error: message };
  }
}

export async function executeLifecycleApproval(input: {
  approval: NonNullable<Awaited<ReturnType<typeof getActionApproval>>>;
  project: ProjectConfig;
  actor: string;
  actorRole?: string;
  executionRoleGate: string;
  separationGate: string;
  executionClaimToken: string;
}): Promise<DashboardFollowUpResult> {
  const lifecycleAction = input.approval.actionType.replace(/^artifact_/, "") as ArtifactLifecycleAction;
  const currentPolicy = lifecyclePolicyFromProject(input.project, "project");
  const capabilityEnabled = lifecycleExecutionCapabilityEnabled(currentPolicy, lifecycleAction);
  const targetArtifact = await loadLifecycleExecutionArtifact(input.approval, lifecycleAction);
  const restoreReady = lifecycleAction === "restore" && isRestorableArchivedArtifact(targetArtifact);
  const lifecycleExecutionAvailable = lifecycleAction === "archive" || lifecycleAction === "restore";
  const destructiveLifecycleAction = lifecycleAction === "prune";
  const destructiveApprovalRequired = destructiveLifecycleAction ? currentPolicy.requireApprovalForPrune : false;
  const policyRecheck = {
    checkedAt: new Date().toISOString(),
    projectRootUri: input.approval.projectRootUri,
    lifecycleAction,
    approvalId: input.approval.id,
    approvalStatus: input.approval.status,
    explicitApprovalPresent: input.approval.status === "approved" || input.approval.status === "failed",
    currentPolicy,
    requestedPolicyDecision: input.approval.policyDecision,
    targetArtifactFound: Boolean(targetArtifact),
    targetArtifactKind: targetArtifact?.kind ?? null,
    targetArtifactCreatedAt: targetArtifact?.createdAt ?? null,
    capabilityEnabled,
    lifecycleExecutionAvailable,
    destructiveLifecycleAction,
    destructiveApprovalRequired,
    destructiveExecutionAvailable: false
  };
  const skipReasons = [
    currentPolicy.legalHold ? "Project legal hold is enabled." : "",
    capabilityEnabled ? "" : `Project policy has allow_${lifecycleAction}_execution disabled.`,
    destructiveLifecycleAction && !currentPolicy.requireApprovalForPrune ? "Project policy must require explicit prune approval before destructive prune execution can be considered." : "",
    targetArtifact ? "" : lifecycleAction === "restore" ? "Archived source snapshot is no longer present in storage." : "Target artifact is no longer present in storage.",
    lifecycleExecutionAvailable ? "" : "Destructive prune/delete execution is not implemented in this version.",
    lifecycleAction === "restore" && targetArtifact && !restoreReady ? "Archived source snapshot is missing restorable content metadata." : ""
  ].filter(Boolean);
  const skipped = currentPolicy.legalHold || !capabilityEnabled || !targetArtifact || !lifecycleExecutionAvailable || (destructiveLifecycleAction && !currentPolicy.requireApprovalForPrune) || (lifecycleAction === "restore" && !restoreReady);
  const archived = !skipped && lifecycleAction === "archive" && targetArtifact;
  const restored = !skipped && lifecycleAction === "restore" && targetArtifact;
  const summary = skipped
    ? `Lifecycle ${lifecycleAction} skipped after policy recheck: ${skipReasons.join(" ")}`
    : archived
      ? `Lifecycle archive recorded for ${input.approval.target}; original artifact retained and archived snapshot created.`
      : restored
        ? `Lifecycle restore recorded for ${input.approval.target}; restored copy created from archived snapshot.`
    : `Lifecycle ${lifecycleAction} policy recheck passed; recorded no-op receipt because execution is not implemented.`;
  const artifactUri = await recordRunAction({
    runId: input.approval.runId,
    taskId: input.approval.taskId,
    agentId: input.approval.agentId,
    actionType: skipped ? `artifact_${lifecycleAction}_skipped` : archived ? "artifact_archive_executed" : restored ? "artifact_restore_executed" : `artifact_${lifecycleAction}_noop`,
    target: input.approval.target,
    summary,
    artifactKind: skipped ? "lifecycle_skipped" : archived ? "archived_artifact" : restored ? "restored_artifact" : "lifecycle_action",
    artifactContent: archived ? buildArchivedArtifactContent({
      approval: input.approval,
      targetArtifact,
      policyRecheck,
      actor: input.actor,
      actorRole: input.actorRole
    }) : restored ? buildRestoredArtifactContent({
      approval: input.approval,
      archivedArtifact: targetArtifact,
      policyRecheck,
      actor: input.actor,
      actorRole: input.actorRole
    }) : {
      approvalId: input.approval.id,
      originalActionType: input.approval.actionType,
      lifecycleAction,
      target: input.approval.target,
      policyDecision: input.approval.policyDecision,
      payload: input.approval.payload,
      policyRecheck,
      skipReasons,
      skipped,
      executedBy: input.actor,
      executedByRole: input.actorRole ?? null
    },
    idempotencyKey: input.approval.idempotencyKey
  });
  await markActionApprovalExecution({
    approvalId: input.approval.id,
    status: "executed",
    actor: input.actor,
    actorRole: input.actorRole,
    summary,
    artifactUri,
    executionClaimToken: input.executionClaimToken
  });
  return {
    ok: true,
    title: skipped ? "Lifecycle skip receipt recorded" : archived ? "Lifecycle archive snapshot recorded" : restored ? "Lifecycle restore snapshot recorded" : "Lifecycle no-op receipt recorded",
    runId: input.approval.runId,
    output: [
      `Approval: ${input.approval.id}`,
      `Action: ${input.approval.actionType}`,
      `Target: ${input.approval.target}`,
      `Artifact: ${artifactUri}`,
      `Role gate: ${input.executionRoleGate}`,
      `Separation of duties: ${input.separationGate}`,
      `Policy recheck: legalHold=${currentPolicy.legalHold} capabilityEnabled=${capabilityEnabled} targetFound=${Boolean(targetArtifact)} lifecycleExecutionAvailable=${lifecycleExecutionAvailable} destructiveExecutionAvailable=false`,
      skipped ? `Skipped: ${skipReasons.join(" ")}` : archived ? "Archived snapshot created; the original artifact remains present." : restored ? "Restored copy created as a new artifact; existing artifacts remain present." : "This execution recorded a no-op lifecycle receipt only.",
      archived
        ? "No artifact was deleted or modified. Restore metadata was recorded with the archived snapshot."
        : restored
          ? "No artifact was deleted or overwritten. Restore lineage was recorded with the restored snapshot."
        : destructiveLifecycleAction
          ? "Destructive prune/delete execution is not implemented yet, so no artifact was deleted, archived, restored, or modified."
        : `Artifact ${lifecycleAction} execution is not implemented yet, so no artifact was deleted, archived, restored, or modified.`
    ].join("\n")
  };
}

export async function executeObjectMirrorApproval(ctx: CliContext, input: {
  approval: Awaited<ReturnType<typeof getActionApproval>>;
  actor: string;
  actorRole?: string;
  executionRoleGate: string;
  separationGate: string;
  executionClaimToken: string;
}): Promise<DashboardFollowUpResult> {
  const approval = input.approval;
  if (!approval) {
    return { ok: false, error: "Approval was not found." };
  }
  const previous = await findRunActionByIdempotencyKey({
    runId: approval.runId,
    artifactKind: "object_mirror",
    idempotencyKey: approval.idempotencyKey
  });
  if (previous) {
    await markActionApprovalExecution({
      approvalId: approval.id,
      status: "executed",
      actor: input.actor,
      actorRole: input.actorRole,
      summary: `Object mirror already had an execution artifact: ${previous.uri}`,
      artifactUri: previous.uri,
      executionClaimToken: input.executionClaimToken
    });
    return {
      ok: true,
      title: "Object mirror reused",
      runId: approval.runId,
      output: [
        `Approval: ${approval.id}`,
        `Artifact: ${previous.uri}`
      ].join("\n")
    };
  }

  const payload = approval.payload;
  let sourceEndpoint: string;
  let targetEndpoint: string;
  try {
    sourceEndpoint = validateObjectMirrorEndpoint(String(payload.sourceEndpoint ?? ""));
    targetEndpoint = validateObjectMirrorEndpoint(String(payload.targetEndpoint ?? ""));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markActionApprovalExecution({
      approvalId: approval.id,
      status: "failed",
      actor: input.actor,
      actorRole: input.actorRole,
      summary: `Object mirror approval payload is invalid: ${message}`,
      error: message,
      executionClaimToken: input.executionClaimToken
    });
    return { ok: false, error: message };
  }
  const sourceBucket = String(payload.sourceBucket ?? "").trim();
  const targetBucket = String(payload.targetBucket ?? "").trim();
  if (!sourceBucket || !targetBucket) {
    return { ok: false, error: "Object mirror approval payload is missing sourceBucket or targetBucket." };
  }
  const sourceAccessKey = process.env.SOURCE_OBJECT_STORAGE_ACCESS_KEY ?? process.env.OBJECT_STORAGE_ACCESS_KEY;
  const sourceSecretKey = process.env.SOURCE_OBJECT_STORAGE_SECRET_KEY ?? process.env.OBJECT_STORAGE_SECRET_KEY;
  const targetAccessKey = process.env.TARGET_OBJECT_STORAGE_ACCESS_KEY ?? process.env.OBJECT_STORAGE_ACCESS_KEY;
  const targetSecretKey = process.env.TARGET_OBJECT_STORAGE_SECRET_KEY ?? process.env.OBJECT_STORAGE_SECRET_KEY;
  const mcAvailable = await commandAvailable(ctx, "mc");
  const missingConfig = [
    !mcAvailable ? "mc" : "",
    !sourceAccessKey ? "SOURCE_OBJECT_STORAGE_ACCESS_KEY or OBJECT_STORAGE_ACCESS_KEY" : "",
    !sourceSecretKey ? "SOURCE_OBJECT_STORAGE_SECRET_KEY or OBJECT_STORAGE_SECRET_KEY" : "",
    !targetAccessKey ? "TARGET_OBJECT_STORAGE_ACCESS_KEY or OBJECT_STORAGE_ACCESS_KEY" : "",
    !targetSecretKey ? "TARGET_OBJECT_STORAGE_SECRET_KEY or OBJECT_STORAGE_SECRET_KEY" : ""
  ].filter(Boolean);
  if (missingConfig.length) {
    const message = `Object mirror execution needs ${missingConfig.join(", ")}.`;
    await markActionApprovalExecution({
      approvalId: approval.id,
      status: "failed",
      actor: input.actor,
      actorRole: input.actorRole,
      summary: message,
      error: message,
      executionClaimToken: input.executionClaimToken
    });
    return { ok: false, error: message };
  }

  const mcConfigDir = path.join(ctx.rootDir, ".agent-workflow", "runtime", "mc-object-mirror");
  await fs.mkdir(mcConfigDir, { recursive: true, mode: 0o700 });
  const env = { ...process.env, MC_CONFIG_DIR: mcConfigDir };
  const sourceAlias = `agentflow-mirror-source-${approval.id.slice(0, 8)}`;
  const targetAlias = `agentflow-mirror-target-${approval.id.slice(0, 8)}`;
  const sourceAliasResult = await execFileText(ctx, "mc", ["alias", "set", sourceAlias, sourceEndpoint, sourceAccessKey!, sourceSecretKey!], { allowFailure: true, env });
  const targetAliasResult = await execFileText(ctx, "mc", ["alias", "set", targetAlias, targetEndpoint, targetAccessKey!, targetSecretKey!], { allowFailure: true, env });
  if (sourceAliasResult.exitCode !== 0 || targetAliasResult.exitCode !== 0) {
    const message = compactDashboardText(sourceAliasResult.stderr || sourceAliasResult.stdout || targetAliasResult.stderr || targetAliasResult.stdout || "mc alias setup failed", 500);
    await markActionApprovalExecution({
      approvalId: approval.id,
      status: "failed",
      actor: input.actor,
      actorRole: input.actorRole,
      summary: `Object mirror alias setup failed: ${message}`,
      error: message,
      executionClaimToken: input.executionClaimToken
    });
    return { ok: false, error: message };
  }
  const mirrorResult = await execFileText(ctx, "mc", [
    "mirror",
    "--overwrite=false",
    `${sourceAlias}/${sourceBucket}`,
    `${targetAlias}/${targetBucket}`
  ], { allowFailure: true, env });
  const summary = mirrorResult.exitCode === 0
    ? `Object mirror completed from ${sourceBucket} to ${targetBucket}.`
    : `Object mirror failed with exit ${mirrorResult.exitCode}.`;
  const artifactUri = await recordRunAction({
    runId: approval.runId,
    taskId: approval.taskId,
    agentId: approval.agentId,
    actionType: "object_mirror",
    target: approval.target,
    summary,
    artifactKind: "object_mirror",
    artifactContent: {
      approvalId: approval.id,
      sourceEndpoint: redactDashboardUrl(sourceEndpoint),
      sourceBucket,
      targetEndpoint: redactDashboardUrl(targetEndpoint),
      targetBucket,
      overwrite: false,
      exitCode: mirrorResult.exitCode,
      stdout: compactDashboardText(mirrorResult.stdout, 1000),
      stderr: compactDashboardText(mirrorResult.stderr, 1000),
      executionRoleGate: input.executionRoleGate,
      separationGate: input.separationGate,
      requestedMissingInTarget: typeof payload.missingInTarget === "number" ? payload.missingInTarget : null,
      sampledMissingKeys: Array.isArray(payload.sampledMissingKeys) ? payload.sampledMissingKeys.slice(0, 25) : []
    },
    idempotencyKey: approval.idempotencyKey
  });
  await markActionApprovalExecution({
    approvalId: approval.id,
    status: mirrorResult.exitCode === 0 ? "executed" : "failed",
    actor: input.actor,
    actorRole: input.actorRole,
    summary,
    artifactUri,
    error: mirrorResult.exitCode === 0 ? undefined : compactDashboardText(mirrorResult.stderr || mirrorResult.stdout, 500),
    executionClaimToken: input.executionClaimToken
  });
  if (mirrorResult.exitCode !== 0) {
    return { ok: false, error: `${summary} ${compactDashboardText(mirrorResult.stderr || mirrorResult.stdout, 500)}` };
  }
  return {
    ok: true,
    title: "Object mirror executed",
    runId: approval.runId,
    output: [
      `Approval: ${approval.id}`,
      summary,
      `Source: ${sourceEndpoint}/${sourceBucket}`,
      `Target: ${targetEndpoint}/${targetBucket}`,
      `Artifact: ${artifactUri}`,
      `Role gate: ${input.executionRoleGate}`,
      `Separation of duties: ${input.separationGate}`
    ].join("\n")
  };
}

export async function executeProjectPolicyChangeApproval(input: {
  approval: NonNullable<Awaited<ReturnType<typeof getActionApproval>>>;
  actor: string;
  actorRole?: string;
  executionClaimToken: string;
}): Promise<DashboardFollowUpResult> {
  const changeKind = stringFromRecord(input.approval.payload, "changeKind");
  const proposedRule = stringFromRecord(input.approval.payload, "proposedRule")?.trim();
  const field = changeKind === "allowed_command" ? "allowed_commands" : changeKind === "allowed_write_path" ? "allowed_write_paths" : null;
  if (!field || !proposedRule) throw new Error("Project policy change approval is missing a supported exact rule.");
  const projectRoot = await resolveLocalProjectRootUri(input.approval.projectRootUri);
  const configPath = path.join(projectRoot, ".agent-workflow", "project.yaml");
  const [before, configStat] = await Promise.all([fs.readFile(configPath, "utf8"), fs.stat(configPath)]);
  const document = YAML.parseDocument(before);
  const parsed = objectValue(document.toJS());
  const actions = objectValue(parsed.actions);
  const existing = Array.isArray(actions[field]) ? actions[field].filter((value): value is string => typeof value === "string") : [];
  const alreadyPresent = existing.includes(proposedRule);
  if (!alreadyPresent) document.setIn(["actions", field], [...existing, proposedRule]);
  const next = document.toJS();
  projectConfigSchema.parse(next);
  const nextYaml = document.toString();
  const evidenceDir = path.join(projectRoot, ".agent-workflow", "runtime", "policy-changes");
  await fs.mkdir(evidenceDir, { recursive: true });
  const backupPath = path.join(evidenceDir, `${input.approval.id}.before.yaml`);
  await fs.writeFile(backupPath, before, { mode: 0o600, flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!alreadyPresent) {
    const temporaryPath = `${configPath}.${input.approval.id}.tmp`;
    await fs.writeFile(temporaryPath, nextYaml, { mode: configStat.mode });
    await fs.rename(temporaryPath, configPath);
  }
  const summary = alreadyPresent
    ? `Exact ${field} rule was already present: ${proposedRule}`
    : `Added exact ${field} rule after approval: ${proposedRule}`;
  const artifactUri = await recordRunAction({
    runId: input.approval.runId,
    taskId: input.approval.taskId,
    agentId: input.approval.agentId,
    actionType: "project_policy_change",
    target: input.approval.target,
    summary,
    artifactKind: "project_policy_change",
    artifactContent: {
      approvalId: input.approval.id,
      changeKind,
      field,
      proposedRule,
      alreadyPresent,
      beforeHash: createHash("sha256").update(before).digest("hex"),
      afterHash: createHash("sha256").update(alreadyPresent ? before : nextYaml).digest("hex"),
      rollbackPath: path.relative(projectRoot, backupPath),
      executedByRole: input.actorRole ?? null
    },
    idempotencyKey: input.approval.idempotencyKey
  });
  await markActionApprovalExecution({ approvalId: input.approval.id, status: "executed", actor: input.actor, actorRole: input.actorRole, summary, artifactUri, executionClaimToken: input.executionClaimToken });
  return { ok: true, title: "Project policy updated", runId: input.approval.runId, output: `${summary}\nRollback snapshot: ${path.relative(projectRoot, backupPath)}\nArtifact: ${artifactUri}` };
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? value : Math.round(value * 10) / 10} ${units[unitIndex]}`;
}

export function formatInlineCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([key, value]) => `${key}: ${value}`).join(", ") : "none";
}

export async function indexProjectForRun(ctx: CliContext, input: {
  projectDir: string;
  maxFiles: number;
  refine: boolean;
  forceRefine: boolean;
  fullIndex?: boolean;
}): Promise<{
  projectName: string;
  count: number;
  skipped: number;
  refined: number;
  reused: number;
  changed: number;
  deleted: number;
  incremental: boolean;
  fullIndexFallback: boolean;
  truncated: boolean;
  headCommit?: string;
  contextObservations: number;
  projectedContextSavingsPercent: number;
}> {
  const project = await loadProjectConfig(input.projectDir);
  const projectId = await upsertProject({
    name: project.project.name,
    rootUri: input.projectDir,
    profile: project.project.autonomy === "wide-open" ? "enterprise" : "custom",
    config: project
  });

  return indexProjectWithStorage(ctx, {
    projectId,
    projectDir: input.projectDir,
    project,
    maxFiles: input.maxFiles,
    refineProvider: input.refine ? providerFromEnv() : undefined,
    forceRefine: input.forceRefine,
    incremental: !input.fullIndex && !input.forceRefine
  });
}

export async function indexProjectWithStorage(ctx: CliContext, input: {
  projectId: string;
  projectDir: string;
  project: ProjectConfig;
  maxFiles: number;
  refineProvider?: ReturnType<typeof providerFromEnv>;
  forceRefine: boolean;
  incremental: boolean;
  sinceCommit?: string;
}): Promise<{
  projectName: string;
  count: number;
  skipped: number;
  refined: number;
  reused: number;
  changed: number;
  deleted: number;
  incremental: boolean;
  fullIndexFallback: boolean;
  truncated: boolean;
  headCommit?: string;
  contextObservations: number;
  projectedContextSavingsPercent: number;
}> {
  const existingSummaries = await listProjectFileSummaries({
    projectRootUri: input.projectDir,
    limit: 100_000
  });
  const state = await getProjectIndexState({ projectId: input.projectId });
  const sinceCommit = input.sinceCommit ?? state?.headCommit ?? undefined;
  const shouldIncrement = input.incremental && Boolean(sinceCommit);
  const contextPolicy = await loadContextRoutingPolicy(ctx, input.projectDir);
  const result = await indexProjectFiles({
    projectDir: input.projectDir,
    project: input.project,
    maxFiles: input.maxFiles,
    refineProvider: input.refineProvider,
    existingSummaries,
    forceRefine: input.forceRefine,
    deltaOnly: shouldIncrement,
    sinceCommit,
    contextGateway: { projectId: input.projectId, policy: contextPolicy }
  });

  const observationFile = await writeShadowObservationBatch({
    projectRoot: input.projectDir,
    projectId: input.projectId,
    observations: result.contextObservations
  });
  const contextReport = buildContextEfficiencyReport(result.contextObservations);

  const count = await upsertProjectFiles({ projectId: input.projectId, files: result.files });
  const deleted = await deleteProjectFiles({
    projectId: input.projectId,
    sourceUris: result.deletedSourceUris
  });
  const storedSourceUris = new Set(existingSummaries.map((summary) => summary.sourceUri));
  for (const sourceUri of result.deletedSourceUris) {
    storedSourceUris.delete(sourceUri);
  }
  for (const file of result.files) {
    storedSourceUris.add(file.sourceUri);
  }
  const roadmapSnapshot = await buildStoredRoadmapSnapshot({
    projectId: input.projectId,
    projectDir: input.projectDir,
    project: input.project
  });
  await upsertProjectIndexState({
    projectId: input.projectId,
    headCommit: result.headCommit,
    indexedFiles: storedSourceUris.size,
    deletedFiles: deleted,
    metadata: {
      mode: result.incremental ? "incremental" : "full",
      fullIndexFallback: result.fullIndexFallback,
      indexedFilesThisRun: count,
      indexedFilesTotal: storedSourceUris.size,
      changed: result.changed,
      reused: result.reused,
      truncated: result.truncated,
      sinceCommit: shouldIncrement ? sinceCommit : null,
      roadmapSnapshot,
      contextGateway: {
        mode: contextPolicy.mode,
        observationFile: observationFile ? path.relative(input.projectDir, observationFile) : null,
        ...contextReport
      }
    }
  });
  return {
    projectName: input.project.project.name,
    count,
    skipped: result.files.filter((file) => file.metadata.skipped).length,
    refined: result.refined,
    reused: result.reused,
    changed: result.changed,
    deleted,
    incremental: result.incremental,
    fullIndexFallback: result.fullIndexFallback,
    truncated: result.truncated,
    headCommit: result.headCommit,
    contextObservations: result.contextObservations.length,
    projectedContextSavingsPercent: contextReport.projectedSavingsPercent
  };
}

export function isDismissedApproval(approval: Pick<DashboardActionApproval, "decisionNote">): boolean {
  return /Approved action dismissed without execution:/iu.test(approval.decisionNote ?? "");
}

export function isExecutableApprovalAction(actionType: string): boolean {
  return actionType === "context_correction" || actionType === "local_command" || actionType === "file_write" || actionType === "executor_adapter" || actionType === "project_policy_change" || actionType === "artifact_prune" || actionType === "artifact_archive" || actionType === "artifact_restore" || actionType === "object_mirror";
}

export function isOpenApproval(approval: DashboardActionApproval): boolean {
  return approval.status === "pending"
    || (approval.status === "approved" && isExecutableApprovalAction(approval.actionType))
    || (approval.status === "failed" && isExecutableApprovalAction(approval.actionType) && !isDismissedApproval(approval));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isRestorableArchivedArtifact(artifact: Awaited<ReturnType<typeof getArtifactByUri>>): artifact is NonNullable<Awaited<ReturnType<typeof getArtifactByUri>>> {
  return Boolean(artifact && artifact.kind === "archived_artifact" && Object.prototype.hasOwnProperty.call(artifact.content, "archivedContent"));
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function lifecycleExecutionCapabilityEnabled(policy: ArtifactLifecyclePolicy, action: ArtifactLifecycleAction): boolean {
  if (action === "archive") return policy.allowArchiveExecution;
  if (action === "restore") return policy.allowRestoreExecution;
  return policy.allowPruneExecution;
}

export function lifecyclePolicyFromProject(project: ProjectConfig, source: ArtifactLifecyclePolicy["source"]): ArtifactLifecyclePolicy {
  return {
    source,
    retentionDays: project.storage.artifact_lifecycle.retention_days,
    minPruneBytes: project.storage.artifact_lifecycle.min_prune_bytes,
    retainAuditArtifacts: project.storage.artifact_lifecycle.retain_audit_artifacts,
    legalHold: project.storage.artifact_lifecycle.legal_hold,
    requireApprovalForPrune: project.storage.artifact_lifecycle.require_approval_for_prune,
    allowArchiveExecution: project.storage.artifact_lifecycle.allow_archive_execution,
    allowRestoreExecution: project.storage.artifact_lifecycle.allow_restore_execution,
    allowPruneExecution: project.storage.artifact_lifecycle.allow_prune_execution
  };
}

export async function loadAgentsForProject(ctx: CliContext, projectDir: string): Promise<AgentCard[]> {
  const builtins = await loadAgents(ctx.rootDir);
  const projectAgentsDir = path.join(projectDir, ".agent-workflow", "agents");
  const projectAgents: AgentCard[] = [];

  try {
    const entries = await fs.readdir(projectAgentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
        continue;
      }
      const agent = await loadYamlFile(path.join(projectAgentsDir, entry.name), agentCardSchema);
      projectAgents.push(agent);
    }
  } catch {
    return builtins;
  }

  const merged = new Map<string, AgentCard>();
  for (const agent of builtins) {
    merged.set(agent.id, agent);
  }
  for (const agent of projectAgents) {
    merged.set(agent.id, agent);
  }
  return [...merged.values()];
}

export async function loadApprovalProjectConfig(ctx: CliContext, approval: DashboardActionApproval): Promise<ProjectConfig> {
  try {
    return await loadLocalProjectConfig(approval.projectRootUri);
  } catch (primaryError) {
    const hostProject = await loadProjectConfig(ctx.rootDir).catch(() => null);
    if (hostProject?.project.name === approval.projectName) return hostProject;
    const summaries = await listProjectStorageSummaries(1000).catch(() => []);
    const candidates: string[] = [];
    for (const summary of summaries) {
      if (summary.name !== approval.projectName) continue;
      const resolution = await resolveLocalProjectPath(summary.rootUri);
      if (!resolution.localPathExists) continue;
      const configPath = path.join(resolution.localRootUri, ".agent-workflow", "project.yaml");
      if (await pathExists(configPath)) candidates.push(resolution.localRootUri);
    }
    const preferred = [...new Set(candidates)].sort((left, right) => {
      const leftWorktree = left.includes(`${path.sep}.codex${path.sep}worktrees${path.sep}`) ? 1 : 0;
      const rightWorktree = right.includes(`${path.sep}.codex${path.sep}worktrees${path.sep}`) ? 1 : 0;
      return leftWorktree - rightWorktree || left.length - right.length || left.localeCompare(right);
    })[0];
    if (preferred) return loadProjectConfig(preferred);
    throw primaryError;
  }
}

export async function loadApprovedFileWrite(approval: NonNullable<Awaited<ReturnType<typeof getActionApproval>>>): Promise<{ path: string; content: string }> {
  if (!approval.taskId) {
    throw new Error("Approved file write is missing the source task id.");
  }
  const expectedHash = stringFromRecord(approval.payload, "payloadHash");
  const artifacts = await listArtifacts({ runId: approval.runId, kind: "stage_output" });
  const source = artifacts.find((artifact) => artifact.taskId === approval.taskId);
  const writes = Array.isArray(source?.content.requestedFileWrites) ? source.content.requestedFileWrites : [];
  for (const item of writes) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const filePath = stringFromRecord(record, "path");
    const content = stringFromRecord(record, "content");
    if (!filePath || content === undefined) continue;
    if (filePath === approval.target && (!expectedHash || textHash(content) === expectedHash)) {
      return { path: filePath, content };
    }
  }
  throw new Error("Approved file write content was not found in the source stage artifact.");
}

export async function loadContextRoutingPolicy(ctx: CliContext, projectDir?: string): Promise<ContextRoutingPolicy> {
  if (projectDir) {
    const localPath = path.join(projectDir, ".agent-workflow", "context-routing.yaml");
    try { return contextRoutingPolicySchema.parse(YAML.parse(await fs.readFile(localPath, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return contextRoutingPolicySchema.parse(YAML.parse(await fs.readFile(path.join(ctx.rootDir, "policies", "context-routing.yaml"), "utf8")));
}

export async function loadCostQualityReport(runId: string): Promise<CostQualityReport | null> {
  const details = await getWorkflowRunDetails(runId);
  if (!details.run) {
    return null;
  }

  const artifacts = await listArtifacts({ runId });
  return buildCostQualityReport({
    run: details.run,
    tasks: details.tasks,
    receipts: details.receipts,
    artifacts
  });
}

export async function loadExactSourceExcerpts(projectDir: string, summaries: SourceSummaryWithHash[]): Promise<Array<{ sourceUri: string; content: string; kind: "source_file"; originalChars: number; contentSha256: string; truncated: boolean }>> {
  const codeExtensions = new Set([".swift", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".cpp", ".c", ".h"]);
  const ordered = [...summaries].sort((left, right) => Number(codeExtensions.has(path.extname(right.sourceUri).toLowerCase())) - Number(codeExtensions.has(path.extname(left.sourceUri).toLowerCase())));
  const excerpts: Array<{ sourceUri: string; content: string; kind: "source_file"; originalChars: number; contentSha256: string; truncated: boolean }> = [];
  let remainingChars = 60_000;
  for (const summary of ordered) {
    if (excerpts.length >= 8 || remainingChars <= 0) break;
    const absolutePath = path.resolve(projectDir, summary.sourceUri);
    const relative = path.relative(projectDir, absolutePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const raw = await fs.readFile(absolutePath, "utf8").catch(() => "");
    if (!raw || raw.includes("\u0000")) continue;
    const content = raw.slice(0, Math.min(12_000, remainingChars));
    excerpts.push({
      sourceUri: summary.sourceUri,
      content,
      kind: "source_file",
      originalChars: raw.length,
      contentSha256: createHash("sha256").update(raw).digest("hex"),
      truncated: content.length < raw.length
    });
    remainingChars -= content.length;
  }
  return excerpts;
}

export async function loadLifecycleExecutionArtifact(
  approval: NonNullable<Awaited<ReturnType<typeof getActionApproval>>>,
  lifecycleAction: ArtifactLifecycleAction
): Promise<Awaited<ReturnType<typeof getArtifactByUri>>> {
  if (lifecycleAction !== "restore") {
    return getArtifactByUri(approval.target);
  }
  const artifactId = stringFromRecord(approval.payload, "artifactId");
  if (artifactId && isUuid(artifactId)) {
    const archivedArtifact = await getArtifactById(artifactId);
    if (archivedArtifact?.kind === "archived_artifact") return archivedArtifact;
  }
  const directTarget = await getArtifactByUri(approval.target);
  return directTarget?.kind === "archived_artifact" ? directTarget : null;
}

export async function loadLocalProjectConfig(projectRootUri: string): Promise<ProjectConfig> {
  return loadProjectConfig(await resolveLocalProjectRootUri(projectRootUri));
}

export async function loadNamedCommitEvidence(projectDir: string, task: string): Promise<Array<{ sourceUri: string; content: string; kind: "named_commit"; originalChars: number; contentSha256: string; truncated: boolean }>> {
  const candidates = [...new Set(task.match(/(?<![A-Fa-f0-9])[A-Fa-f0-9]{7,40}(?![A-Fa-f0-9])/gu) ?? [])].slice(0, 8);
  const evidence: Array<{ sourceUri: string; content: string; kind: "named_commit"; originalChars: number; contentSha256: string; truncated: boolean }> = [];
  let remainingChars = 16_000;
  for (const candidate of candidates) {
    if (remainingChars <= 0) break;
    const exists = await new Promise<boolean>((resolve) => {
      execFile("git", ["-C", projectDir, "cat-file", "-e", `${candidate}^{commit}`], { timeout: 5_000 }, (error) => resolve(!error));
    });
    if (!exists) continue;
    const content = await new Promise<string>((resolve) => {
      execFile(
        "git",
        ["-C", projectDir, "show", "--format=fuller", "--stat", "--patch", "--no-ext-diff", "--no-color", "--max-count=1", candidate],
        // Read enough of a large commit for git to exit cleanly, then enforce the
        // much smaller per-commit context cap below. A subprocess buffer overflow
        // must not make an existing commit look like missing review evidence.
        { timeout: 10_000, maxBuffer: 10_000_000 },
        (error, stdout) => resolve(error ? "" : stdout)
      );
    });
    if (!content) continue;
    const bounded = content.slice(0, Math.min(8_000, remainingChars));
    evidence.push({
      sourceUri: `git-commit/${candidate}.patch`,
      content: bounded,
      kind: "named_commit",
      originalChars: content.length,
      contentSha256: createHash("sha256").update(content).digest("hex"),
      truncated: bounded.length < content.length
    });
    remainingChars -= bounded.length;
  }
  return evidence;
}

export async function loadPreferenceNotes(projectDir: string): Promise<string[]> {
  const tuningNotes = await loadProjectTuningNotes(projectDir);
  try {
    const memory = await getLatestMemory({
      projectRootUri: projectDir,
      limit: 25
    });
    const feedbackItems = memory
      .filter((item) => item.metadata?.kind === "run_feedback")
      .slice(0, 8);

    return [
      ...tuningNotes,
      ...feedbackItems.map((item) => {
      const rating = typeof item.metadata.rating === "string" ? item.metadata.rating : "unknown";
      const workflowId = typeof item.metadata.workflowId === "string" ? item.metadata.workflowId : "unknown-workflow";
      const note = typeof item.metadata.note === "string" && item.metadata.note.trim() ? ` Note: ${item.metadata.note.trim()}` : "";
      return `${rating} feedback for ${workflowId}.${note} (${item.updatedAt})`;
      })
    ];
  } catch {
    return tuningNotes;
  }
}

export async function loadProjectTuningNotes(projectDir: string): Promise<string[]> {
  const files = [
    ".agent-workflow/tuning/agent-notes.md",
    ".agent-workflow/tuning/context-budget-notes.md",
    ".agent-workflow/tuning/routing-preferences.md",
    ".agent-workflow/tuning/proposals.md"
  ];
  const notes: string[] = [];
  for (const relativePath of files) {
    const absolutePath = path.join(projectDir, relativePath);
    if (!await pathExists(absolutePath)) continue;
    const raw = await fs.readFile(absolutePath, "utf8").catch(() => "");
    const compact = raw.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .slice(0, 16)
      .join(" ");
    if (compact) {
      notes.push(`${relativePath}: ${compact.slice(0, 1200)}`);
    }
  }
  return notes;
}

// Import guard: unit tests import pure helpers from this module, which must
// not launch the CLI as a side effect. Only parse argv when this file is the
// process entry point (both `tsx apps/cli/src/index.ts` and the compiled
// dist bin resolve through symlinks, so realpath the entry before comparing).

export async function loadSourceSummaries(input: {
  projectDir: string;
  project: Awaited<ReturnType<typeof loadProjectConfig>>;
  workflow: Awaited<ReturnType<typeof loadWorkflows>>[number];
  agents: Awaited<ReturnType<typeof loadAgents>>;
  task: string;
  sourceTokenBudget?: string;
  sourceMaxFiles?: string;
  preferImplementationSources?: boolean;
}): Promise<SourceSummaryWithHash[]> {
  try {
    const summaries = await listProjectFileSummaries({
      projectRootUri: input.projectDir,
      limit: 500
    });
    const tokenBudget = Number.parseInt(input.sourceTokenBudget ?? "", 10);
    const maxFiles = Number.parseInt(input.sourceMaxFiles ?? "", 10);
    const eligibleSummaries = input.preferImplementationSources
      ? summaries.filter((summary) => !/^\.agent-workflow\/(?:exports|receipts|reports|runs)\//u.test(summary.sourceUri))
      : summaries;
    return selectRelevantSourceSummaries({
      task: input.task,
      project: input.project,
      workflow: input.workflow,
      agents: input.agents,
      summaries: eligibleSummaries,
      maxTokens: Number.isFinite(tokenBudget) && tokenBudget > 0 ? tokenBudget : undefined,
      maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : undefined
    });
  } catch {
    return [];
  }
}

export function mergeCounts(items: Record<string, number>[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      result[key] = (result[key] ?? 0) + value;
    }
  }
  return result;
}

export function normalizeActorRole(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

export function normalizeWorkerId(value?: string): string {
  const configured = value?.trim() || process.env.AGENTFLOW_WORKER_ID?.trim();
  if (configured) {
    return configured;
  }
  const host = os.hostname().replace(/[^a-zA-Z0-9_.-]/g, "-") || "local";
  return `${host}:${process.pid}`;
}

export function objectFromRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function pathIsFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}


export async function queueWorkflow(ctx: CliContext, input: {
  acceptanceRequirementsFile?: string;
  workflowId: string;
  projectPath: string;
  task: string;
  policyProfile?: string;
  requester?: string;
  requesterChannel?: string;
  modelTierOverride?: "fast" | "standard" | "reasoning";
  providerOverride?: string;
  evaluationMetadata?: Record<string, unknown>;
  workflowOverride?: Awaited<ReturnType<typeof loadWorkflows>>[number];
  sourceTokenBudget?: string;
  sourceMaxFiles?: string;
  registeredProjectRootUri?: string;
  includeExactSourceExcerpts?: boolean;
  preferImplementationSources?: boolean;
}): Promise<
  | {
    ok: true;
    projectDir: string;
    workflow: Awaited<ReturnType<typeof loadWorkflows>>[number];
    brief: string;
    run: Awaited<ReturnType<typeof createWorkflowRun>>;
  }
  | { ok: false; error: string }
> {
  const projectDir = path.resolve(process.cwd(), input.projectPath);
  const [agents, workflows] = await Promise.all([loadAgentsForProject(ctx, projectDir), loadWorkflows(ctx.rootDir)]);
  const resolvedWorkflow = input.workflowOverride ?? resolveWorkflow(workflows, input.workflowId);
  if (!resolvedWorkflow) return { ok: false, error: `Unknown workflow: ${input.workflowId}` };
  const latencyOptimization = input.workflowOverride || /^(?:0|false|off|no)$/iu.test(process.env.AGENTFLOW_ADAPTIVE_STATIC_WORKFLOWS?.trim() ?? "")
    ? { workflow: resolvedWorkflow, optimization: { applied: false, complexity: "complex" as const, originalStages: resolvedWorkflow.stages.map((stage) => stage.id), selectedStages: resolvedWorkflow.stages.map((stage) => stage.id), rationale: "Explicit workflow overrides retain their authored stage graph." } }
    : optimizeStaticWorkflowForLatency(resolvedWorkflow, input.task);
  const workflow = latencyOptimization.workflow;
  if (input.workflowOverride) {
    await seedRegistry([], [{ path: `runtime/${workflow.id}.yaml`, value: workflow }]);
  }
  const configuredProject = await loadProjectConfig(projectDir);
  let resolvedPolicy: ReturnType<typeof resolveExecutionPolicy>;
  try {
    resolvedPolicy = resolveExecutionPolicy(configuredProject, input.policyProfile);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const project = resolvedPolicy.project;
  const selectedAgents = selectWorkflowAgents(agents, workflow);

  for (const agent of selectedAgents.values()) {
    const decision = evaluateAgentAutonomy(agent, project);
    if (!decision.allowed) {
      return {
        ok: false,
        error: `Policy rejected ${agent.id}: ${decision.reasons.join("; ")}`
      };
    }
  }

  const selectedAgentList = [...selectedAgents.values()];
  let sourceSummaries = await loadSourceSummaries({
    projectDir,
    project,
    workflow,
    agents: selectedAgentList,
    task: input.task,
    sourceTokenBudget: input.sourceTokenBudget,
    sourceMaxFiles: input.sourceMaxFiles,
    preferImplementationSources: input.preferImplementationSources
  });
  if (sourceSummaries.length === 0) {
    await indexProjectForRun(ctx, {
      projectDir,
      maxFiles: parsePositiveInteger(input.sourceMaxFiles || "120", 120),
      refine: false,
      forceRefine: false
    });
    sourceSummaries = await loadSourceSummaries({
      projectDir,
      project,
      workflow,
      agents: selectedAgentList,
      task: input.task,
      sourceTokenBudget: input.sourceTokenBudget,
      sourceMaxFiles: input.sourceMaxFiles,
      preferImplementationSources: input.preferImplementationSources
    });
  }
  const exactSourceExcerpts = input.includeExactSourceExcerpts
    ? await loadExactSourceExcerpts(projectDir, sourceSummaries)
    : [];
  const namedCommitEvidence = await loadNamedCommitEvidence(projectDir, input.task);
  const governedReusePlan = await buildReusePlanForTask({
    projectDir,
    task: input.task,
    workflow,
    policySnapshotHash: resolvedPolicy.snapshotHash,
    sourceSummaries
  });
  const reuseAdvisory = governedReusePlan.candidates[0]
    ? [`Governed reuse advisory only: ${governedReusePlan.recommendation} from run ${governedReusePlan.candidates[0].runId}; operator approval is required before any stage or result is reused.`]
    : [];
  let compiledInfluence: ContextInfluence | undefined;
  const brief = await compileContext({
    onInfluence: value => {
      if (reuseAdvisory.length && governedReusePlan.candidates[0]) value.references.push({ kind: "prior_run", key: governedReusePlan.candidates[0].runId, includedHash: influenceHash(reuseAdvisory.join("\n")), observedAt: null, freshness: "historical", confidence: "recorded", target: { type: "run", value: governedReusePlan.candidates[0].runId } });
      compiledInfluence = value;
    },
    task: input.task,
    projectDir,
    project,
    workflow,
    agents: selectedAgentList,
    sourceSummaries,
    sourceExcerpts: [...namedCommitEvidence, ...exactSourceExcerpts],
    preferenceNotes: [...await loadPreferenceNotes(projectDir), ...reuseAdvisory]
  });
  const runInputSnapshot = await buildRunInputSnapshot(ctx, {
    projectConfig: configuredProject,
    policySnapshotHash: resolvedPolicy.snapshotHash,
    workflow,
    sourceSummaries
  });

  let acceptanceRequirements: Pick<StructuredAcceptanceContract, "subjectHash" | "sourcePaths" | "deliverables"> | undefined;
  if (input.acceptanceRequirementsFile) {
    const file = path.resolve(input.acceptanceRequirementsFile);
    if ((await fs.stat(file)).size > 256_000) throw new Error("Acceptance requirements exceed 256000 bytes.");
    const requirements = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(requirements.sourcePaths) || !Array.isArray(requirements.deliverables)) throw new Error("Acceptance requirements need sourcePaths and pending deliverables.");
    acceptanceRequirements = { sourcePaths: requirements.sourcePaths, deliverables: requirements.deliverables,
      subjectHash: await sourceSubjectHash(projectDir, requirements.sourcePaths) };
  }
  const run = await createWorkflowRun({
    acceptanceRequirements,
    projectName: project.project.name,
    projectRootUri: input.registeredProjectRootUri ?? projectDir,
    projectProfile: project.project.autonomy === "wide-open" ? "enterprise" : "custom",
    projectConfig: configuredProject,
    workflow,
    task: input.task,
    autonomy: String(project.project.autonomy),
    policyProfile: resolvedPolicy.profile,
    policySnapshot: resolvedPolicy.snapshot,
    policySnapshotHash: resolvedPolicy.snapshotHash,
    workflowVersion: workflow.dynamic?.version,
    workflowHash: workflow.dynamic?.definition_hash,
    constructionRationale: workflow.dynamic?.construction_rationale,
    modelTierOverride: input.modelTierOverride,
    providerOverride: input.providerOverride,
    evaluationMetadata: attachCodexOrigin({ ...(input.evaluationMetadata ?? {}), latencyOptimization: latencyOptimization.optimization }),
    requester: input.requester ?? resolveDefaultRequester() ?? undefined,
    requesterChannel: input.requesterChannel ?? resolveDefaultRequesterChannel(),
    compiledBrief: brief,
    compiledBriefMetadata: {
      contextInfluence: compiledInfluence,
      runInputSnapshot,
      governedReusePlan,
      latencyOptimization: latencyOptimization.optimization
    }
  });

  return {
    ok: true,
    projectDir,
    workflow,
    brief,
    run
  };
}

export function redactDashboardUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "user";
    if (url.password) url.password = "redacted";
    return url.toString();
  } catch {
    return value.replace(/:\/\/[^:@\s]+:[^@\s]+@/g, "://user:redacted@");
  }
}

export function requiredAgent<T extends { id: string }>(agents: Map<string, T>, id: string): T {
  const agent = agents.get(id);
  if (!agent) {
    throw new Error(`Missing required agent: ${id}`);
  }
  return agent;
}

export async function resolveDashboardProjectPath(rootUri: string): Promise<DashboardProjectPathResolution> {
  return resolveLocalProjectPath(rootUri);
}

export function resolveDefaultRequester(): string | null {
  return process.env.AGENTFLOW_REQUESTER?.trim()
    || process.env.USER?.trim()
    || process.env.LOGNAME?.trim()
    || null;
}

export function resolveDefaultRequesterChannel(): string {
  const configured = process.env.AGENTFLOW_REQUESTER_CHANNEL?.trim();
  if (configured) return configured;
  if (process.env.CODEX_THREAD_ID?.trim()) return "codex";
  if (process.env.AGENTFLOW_NOTIFY_COMMAND?.trim()) return "command";
  return "cli";
}

export async function resolveLocalProjectRootUri(projectRootUri: string): Promise<string> {
  return (await resolveLocalProjectPath(projectRootUri)).localRootUri;
}

export async function resumeBlockedRunAfterResolvedApprovals(runId: string): Promise<{ resumedTasks: number; replacementRunId?: string }> {
  const details = await getWorkflowRunDetails(runId);
  if (details.run?.status !== "blocked") return { resumedTasks: 0 };
  const unresolved = (await listActionApprovals({ runId, limit: 100 })).filter(isOpenApproval);
  if (unresolved.length) return { resumedTasks: 0 };
  const resumed = await resumeWorkflowRunFromCheckpoint({
    runId,
    actor: "dashboard",
    reason: "Final required approval resolved; resume from completed checkpoints.",
    includeFailed: true
  });
  return { resumedTasks: resumed.requeuedTasks, replacementRunId: resumed.replacementRunId };
}

export function selectWorkflowAgents<T extends { id: string }>(agents: T[], workflow: { lead: string; stages: Array<{ agent: string; subagents: string[] }> }): Map<string, T> {
  const agentIndex = byId(agents);
  const selectedAgents = new Map<string, T>();
  selectedAgents.set(workflow.lead, requiredAgent(agentIndex, workflow.lead));
  for (const stage of workflow.stages) {
    selectedAgents.set(stage.agent, requiredAgent(agentIndex, stage.agent));
    for (const subagent of stage.subagents) {
      selectedAgents.set(subagent, requiredAgent(agentIndex, subagent));
    }
  }
  return selectedAgents;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function textHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
}

export function validateObjectMirrorEndpoint(value: string, label = "endpoint"): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Object mirror ${label} is required.`);
  const url = new URL(trimmed);
  if (url.username || url.password) {
    throw new Error(`Object mirror ${label} must not include credentials.`);
  }
  return url.toString().replace(/\/$/u, "");
}

export async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

export async function scanDirectorySize(dir: string, options: { maxEntries: number; maxDepth: number }): Promise<{
  sizeBytes: number;
  entriesScanned: number;
  latestMtimeMs: number | null;
  truncated: boolean;
  error: string | null;
}> {
  let sizeBytes = 0;
  let entriesScanned = 0;
  let latestMtimeMs: number | null = null;
  let truncated = false;
  let error: string | null = null;
  async function walk(current: string, depth: number): Promise<void> {
    if (truncated || entriesScanned >= options.maxEntries || depth > options.maxDepth) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const entryPath = path.join(current, entry.name);
      entriesScanned += 1;
      const stat = await fs.stat(entryPath).catch(() => null);
      if (stat) {
        sizeBytes += stat.isFile() ? stat.size : 0;
        latestMtimeMs = latestMtimeMs === null ? stat.mtimeMs : Math.max(latestMtimeMs, stat.mtimeMs);
      }
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
      }
      if (entriesScanned >= options.maxEntries) {
        truncated = true;
        return;
      }
    }
  }
  await walk(dir, 0);
  return { sizeBytes, entriesScanned, latestMtimeMs, truncated, error };
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

export function safeDisplayUrl(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, parsed.pathname === "/" ? "/" : "");
  } catch {
    return value.replace(/:\/\/[^/@]+@/, "://[REDACTED]@").replace(/[?].*$/, "");
  }
}

export function buildGraphHandoffPayload(input: {
  report: DashboardWorkflowGraphReport;
  generatedAt: string;
  graphPath: string;
  filters: Record<string, string | number>;
}) {
  const stageHealth = input.report.stageHealth.map((health) => ({
    stageId: health.stageId,
    totalTasks: health.totalTasks,
    completedTasks: health.completedTasks,
    failedTasks: health.failedTasks,
    activeTasks: health.queuedTasks + health.runningTasks,
    cancelledTasks: health.cancelledTasks
  }));
  const focusedStage = input.report.focusedStageId
    ? {
      id: input.report.focusedStageId,
      historyRows: input.report.focusedStageRuns.length,
      suggestedFixRuns: input.report.focusedStageFixRuns.map((run) => ({
        id: run.id,
        status: run.status,
        startedAt: run.startedAt
      })),
      verificationRuns: input.report.focusedStageVerificationRuns.map((run) => ({
        id: run.id,
        status: run.status,
        sourceFixRunId: stringValue(run.evaluationMetadata.sourceFixRunId),
        startedAt: run.startedAt
      })),
      delta: summarizeFocusedStageDelta(
        input.report.focusedStageRuns.filter((run) => !input.report.focusedStageVerificationRuns.some((verification) => verification.id === run.runId)),
        input.report.focusedStageRuns.filter((run) => input.report.focusedStageVerificationRuns.some((verification) => verification.id === run.runId))
      )
    }
    : null;
  return {
    kind: "agentflow_graph_handoff",
    generatedAt: input.generatedAt,
    graphPath: input.graphPath,
    filters: input.filters,
    workflow: input.report.workflow,
    project: input.report.project,
    totals: {
      ...input.report.totals,
      patternMix: countBy(input.report.stages.map((stage) => stage.pattern.type))
    },
    runs: input.report.runs.map((run) => ({
      id: run.id,
      workflowId: run.workflowId,
      status: run.status,
      projectName: run.projectName,
      projectRootUri: run.projectRootUri,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt
    })),
    stageHealth,
    focusedStage
  };
}

export function summarizeFocusedStageDelta(baselineRows: DashboardWorkflowStageRun[], verificationRows: DashboardWorkflowStageRun[]): FocusedStageDeltaSummary {
  const baseline = summarizeFocusedStageOutcomes(baselineRows);
  const verification = summarizeFocusedStageOutcomes(verificationRows);
  const completedDelta = rateDelta(verification.completedRate, baseline.completedRate);
  const failedDelta = rateDelta(verification.failedRate, baseline.failedRate);
  const activeDelta = rateDelta(verification.activeRate, baseline.activeRate);
  let label = "Need verification";
  if (verification.total > 0 && completedDelta !== null && failedDelta !== null) {
    if (failedDelta < 0 || completedDelta > 0) {
      label = "Improved";
    } else if (failedDelta > 0 || completedDelta < 0) {
      label = "Regressed";
    } else {
      label = "No change";
    }
  }
  return { baseline, verification, completedDelta, failedDelta, activeDelta, label };
}

export function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

export function summarizeFocusedStageOutcomes(rows: DashboardWorkflowStageRun[]): FocusedStageOutcomeSummary {
  const total = rows.length;
  const completed = rows.filter((row) => row.taskStatus === "completed").length;
  const failed = rows.filter((row) => row.taskStatus === "failed").length;
  const active = rows.filter((row) => row.taskStatus === "queued" || row.taskStatus === "running").length;
  const cancelled = rows.filter((row) => row.taskStatus === "cancelled").length;
  return {
    total,
    completed,
    failed,
    active,
    cancelled,
    completedRate: percentRate(completed, total),
    failedRate: percentRate(failed, total),
    activeRate: percentRate(active, total)
  };
}

export function percentRate(count: number, total: number): number | null {
  if (!total) return null;
  return Math.round((count / total) * 1000) / 10;
}

export function rateDelta(after: number | null, before: number | null): number | null {
  if (after === null || before === null) return null;
  return Math.round((after - before) * 10) / 10;
}
