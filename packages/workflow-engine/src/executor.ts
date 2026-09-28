import path from "node:path";
import { createHash } from "node:crypto";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { loadProjectConfig } from "../../agent-registry/src/loaders.js";
import { assertCommandAllowed, commandSerializationResource, executeAllowedCommand, type CommandExecutionResult } from "../../local-tools/src/command-executor.js";
import { assertFileWriteAllowed, executeAllowedFileWrite } from "../../local-tools/src/file-writer.js";
import { assertFilePatchAllowed, executeAllowedFileMutation, normalizeRequestedFileMutation, summarizeFileMutation } from "../../local-tools/src/file-patcher.js";
import { executeAllowedFileRead } from "../../local-tools/src/file-reader.js";
import { commandFailureDelta, fileReadDelta, type StateDelta } from "../../model-providers/src/state-deltas.js";
import { classifyProviderFailure, executeWithProviderFallback, providerFallbackPolicyFromEnv, ProviderExecutionError, providerFromEnv, type ProviderFallbackAttempt } from "../../model-providers/src/index.js";
import { scoreStageOutput, unfulfilledCompletionReason, verificationCompletionReason } from "../../model-providers/src/quality.js";
import { selectModelRoute } from "../../model-providers/src/routing.js";
import { buildMemoryContextForStage, recordStageMemoryGraph } from "./memory-graph-wiring.js";
import type { StageExecutionInput, StageExecutionOutput } from "../../model-providers/src/types.js";
import { buildModelRouteReceiptContent } from "./model-route-receipt.js";
import { recordDirectProviderUsage } from "./fleet-usage.js";
import { actionIdempotencyKey, buildBoundedReactLoopReceiptContent } from "./action-receipts.js";
import { fileWriteRejectionRecovered, isRecoverableFileMutationFailure, prepareRejectedPatchRetry } from "./file-mutation-retry.js";
export { isRecoverableFileMutationFailure } from "./file-mutation-retry.js";
export { actionIdempotencyKey, buildBoundedReactLoopReceiptContent } from "./action-receipts.js";
import { evaluateActionApprovalRule, evaluateActionRiskAutoApproval, type ActionApprovalRuleMatch } from "../../policy-engine/src/index.js";
import { resolveLocalProjectPath } from "../../runtime-root/src/index.js";
import { assertExecutorRegistration, executeExecutorSnapshot, type ExecutorOperation, type ExecutorResult } from "../../executor-adapters/src/index.js";
import {
  blockWorkflowTask,
  claimSideEffect,
  claimNextWorkflowTask,
  completeWorkflowTask,
  dismissSupersededActionApprovals,
  findRunActionByIdempotencyKey,
  failWorkflowTask,
  finalizeSideEffect,
  recordRunAction,
  requeueExpiredWorkflowTaskLeases,
  requeueRunningWorkflowTasks,
  renewWorkflowTaskLease,
  assertWorkflowTaskLease,
  requestActionApproval,
  startWorkflowTask,
  withProjectExecutionLock,
  createWorkflowEventSubscriber,
  type ClaimedWorkflowTask
} from "../../storage/src/postgres.js";
import { createRenewingStageAuthority } from "./stage-authority.js";
import { attributeVerifyCommandFailure, commandFailureEligibleForVerifyRetry, commandFailureIsDiagnosticEvidence, commandFailurePrecedesGovernedWrites, formatCommandFailureEvidence, npmPreflightDiagnostic, snapshotGitStatus, truncateCommandOutputForError, verifyRetryBudgetFromEnv } from "./command-failure.js";
export * from "./command-failure.js";
import { createStageTelemetry, flushStageTelemetry } from "./stage-telemetry.js";
import type { WorkerResult, WorkerRunOptions } from "./worker-types.js";
export type { WorkerResult, WorkerRunOptions } from "./worker-types.js";
import { shouldContinuePlanningDeliverableGap, shouldRetryWeakFallbackBlock } from "./stage-outcome.js";
export { shouldContinuePlanningDeliverableGap, shouldRetryWeakFallbackBlock } from "./stage-outcome.js";
import { runWorkerWatchLoop, type WorkerWatchInput } from "./worker-watch.js";
import { applyCurrentAutoApprovalThreshold } from "./approval-threshold.js";
export { applyCurrentAutoApprovalThreshold } from "./approval-threshold.js";

export class LostWorkflowTaskLeaseError extends Error {
  constructor(taskId: string) {
    super(`Worker lost ownership of workflow task ${taskId}; no further side effects may be dispatched.`);
    this.name = "LostWorkflowTaskLeaseError";
  }
}

function isStaleLeaseError(error: unknown): boolean {
  return error instanceof Error && /stale workflow fencing token|expired task lease/iu.test(error.message);
}

export function isInternalWorkflowReceiptWrite(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return /^\.agent-workflow\/receipts\/[a-zA-Z0-9._/-]+\.(?:md|json)$/u.test(normalized)
    && !normalized.split("/").includes("..");
}

export async function runWorkerOnce(limit: number, options?: WorkerRunOptions): Promise<WorkerResult> {
  const safeLimit = Math.max(0, Math.floor(limit));
  const requestedConcurrency = Math.floor(options?.concurrency ?? 1);
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(safeLimit || 1, requestedConcurrency, 16))
    : 1;
  if (options?.recoverExpiredLeases !== false) {
    const workerId = options?.workerId?.trim() || "worker";
    await requeueExpiredWorkflowTaskLeases({
      projectRootUri: options?.projectRootUri,
      actor: workerId,
      reason: "Worker automatically recovered expired task leases before claiming new work."
    });
  }
  if (safeLimit > 1 && concurrency > 1) {
    return runWorkerOnceConcurrently(safeLimit, { ...options, concurrency: 1, recoverExpiredLeases: false }, concurrency);
  }

  const result: WorkerResult = {
    claimed: 0,
    completed: 0,
    failed: 0,
    providerFailures: []
  };

  for (let i = 0; i < safeLimit; i += 1) {
    if (options?.shouldStop?.()) break;
    const task = await claimNextWorkflowTask({
      ...options,
      excludedProjectRootUris: [...(options?.unavailableProjectRootUris ?? [])]
    });
    if (!task) {
      break;
    }

    result.claimed += 1;

    let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
    let attemptedProviderId: string | undefined;
    let stageTelemetry: ReturnType<typeof createStageTelemetry> | undefined;
    try {
      const projectResolution = await resolveLocalProjectPath(task.projectRootUri);
      if (!projectResolution.localPathExists) {
        options?.unavailableProjectRootUris?.add(task.projectRootUri);
        await requeueRunningWorkflowTasks(task.runId);
        await recordRunAction({
          runId: task.runId,
          agentId: "workflow-orchestrator",
          actionType: "worker_project_unavailable",
          target: task.projectRootUri,
          summary: `Worker ${task.workerId ?? "unknown"} released the task because this project checkout is unavailable on that host.`,
          artifactKind: "worker_capability",
          artifactContent: { workerId: task.workerId, storageRootUri: task.projectRootUri, localPathExists: false },
          idempotencyKey: `worker-project-unavailable-${task.taskId}-${task.workerId ?? "unknown"}`
        });
        continue;
      }
      await startWorkflowTask({ taskId: task.taskId, runId: task.runId, workerId: task.workerId!, fencingToken: task.fencingToken });
      const leaseSeconds = Math.max(30, Math.min(3600, options?.leaseSeconds ?? 120));
      let leaseLost = false;
      leaseHeartbeat = setInterval(() => {
        void renewWorkflowTaskLease({
          taskId: task.taskId,
          runId: task.runId,
          workerId: task.workerId!,
          fencingToken: task.fencingToken,
          leaseSeconds
        }).then((renewed) => {
          if (!renewed) leaseLost = true;
        }).catch(() => {
          leaseLost = true;
        });
      }, Math.max(10_000, Math.floor(leaseSeconds * 1000 / 3)));
      leaseHeartbeat.unref();
      const assertLeaseOwned = async (): Promise<void> => {
        if (leaseLost) throw new LostWorkflowTaskLeaseError(task.taskId);
        await assertWorkflowTaskLease({ taskId: task.taskId, workerId: task.workerId!, fencingToken: task.fencingToken });
      };
      const localProjectRootUri = projectResolution.localRootUri;
      const actionResults: unknown[] = [];
      const snapshotProject = projectConfigSchema.parse(task.projectConfig);
      const currentProject = await loadProjectConfig(localProjectRootUri).catch(() => snapshotProject);
      const project = applyCurrentAutoApprovalThreshold(snapshotProject, currentProject);
      const stagePattern = normalizeStagePattern(task.stagePattern);
      stageTelemetry = createStageTelemetry(task, stagePattern);
      // Footprint-scoped verify attribution: snapshot the working tree before
      // the agent acts, so verify failures on pre-existing dirty state are not
      // blamed on the agent. Read-only; never touches the working tree.
      const verifyFootprintBefore = commandFailureEligibleForVerifyRetry(stagePattern)
        ? await snapshotGitStatus(localProjectRootUri)
        : null;
      const stageInput = {
        ...task,
        projectRootUri: localProjectRootUri,
        stagePattern,
        projectConfig: project,
        modelTier: (task.modelTier as "fast" | "standard" | "reasoning") ?? undefined
      };
      if (task.executorSnapshot) {
        const assertExecutorAuthority = await createRenewingStageAuthority({ projectId: task.projectRootUri, runId: task.runId, stageId: task.stageId, workflowId: task.workflowId, agentId: task.agentId, providerId: "executor", project, evidence: task.compiledBrief || task.stageGoal, leaseSeconds, assertLeaseOwned });
        await assertExecutorAuthority(true);
        await executeBoundExecutorStage(task, project, assertLeaseOwned);
        clearInterval(leaseHeartbeat);
        result.completed += 1;
        continue;
      }
      const route = await selectModelRoute(stageInput, { allowedProviderIds: options?.providerIds });
      const assertStageGuard = await createRenewingStageAuthority({ projectId: task.projectRootUri, runId: task.runId, stageId: task.stageId, workflowId: task.workflowId, agentId: task.agentId, providerId: route.providerId, project, evidence: task.compiledBrief || task.stageGoal, leaseSeconds, assertLeaseOwned });
      attemptedProviderId = route.providerId;
      const memoryContext = await buildMemoryContextForStage({
        projectId: localProjectRootUri,
        stageGoal: task.stageGoal,
        taskLabel: task.workflowTask
      });
      const routedStageInput = {
        ...stageInput,
        modelTier: route.modelTier,
        modelOverride: route.modelOverride,
        memoryContext
      };
      const startedAt = Date.now();
      const fallbackPolicy = providerFallbackPolicyFromEnv();
      let execution;
      try {
        await assertStageGuard(false);
        execution = await executeWithProviderFallback({ providerId: route.providerId, stageInput: routedStageInput, policy: fallbackPolicy, providerFactory: providerFromEnv });
      } catch (error) {
        const failure = classifyProviderFailure(error);
        await recordDirectProviderUsage({ stage: routedStageInput, attempts: failure.attempts, latencyMs: Date.now() - startedAt }).catch(() => 0);
        await recordRunAction({
          runId: task.runId,
          agentId: task.agentId,
          actionType: "model_route_failed",
          target: `${task.workflowId}/${task.stageId}`,
          summary: `${route.providerId} failed (${failure.kind})`,
          artifactKind: "model_route",
          artifactContent: { workflowId: task.workflowId, stageId: task.stageId, agentId: task.agentId, route, status: "failed", failureKind: failure.kind, failureReason: failure.message, attempts: failure.attempts, latencyMs: Date.now() - startedAt }
        });
        throw failure;
      }
      await recordDirectProviderUsage({ stage: routedStageInput, attempts: execution.attempts, output: execution.output, latencyMs: Date.now() - startedAt }).catch(() => 0);
      let output = execution.output;
      let quality = scoreStageOutput(routedStageInput, output);
      let fallbackProviderId = execution.fallbackUsed ? execution.actualProvider : undefined;
      let actualProviderId = execution.actualProvider;
      let actualModel = execution.actualModel;
      let fallbackAttempts: ProviderFallbackAttempt[] = [...execution.attempts];
      let fallbackUsed = execution.fallbackUsed;
      const qualityFallbackProviderId = process.env.AGENTFLOW_FALLBACK_PROVIDER;

      const initialCompletionViolation = unfulfilledCompletionReason(routedStageInput, output);
      if (initialCompletionViolation) {
        await assertStageGuard(false);
        const contractRetry = await executeWithProviderFallback({
          providerId: route.providerId,
          stageInput: routedStageInput,
          policy: { ...fallbackPolicy, chains: {}, maxRetries: Math.max(1, fallbackPolicy.maxRetries) },
          providerFactory: providerFromEnv
        });
        fallbackAttempts = [...fallbackAttempts, ...contractRetry.attempts];
        output = contractRetry.output;
        quality = scoreStageOutput(routedStageInput, output);
        fallbackUsed = false;
        fallbackProviderId = undefined;
        actualProviderId = contractRetry.actualProvider;
        actualModel = contractRetry.actualModel;
        const repeatedViolation = unfulfilledCompletionReason(routedStageInput, output);
        if (repeatedViolation) {
          output = { ...output, outcome: "blocked", blockedReason: repeatedViolation };
          quality = scoreStageOutput(routedStageInput, output);
        }
      }

      if (shouldRetryWeakFallbackBlock({ fallbackUsed, actualProviderId, output, qualityReasons: quality.reasons })) {
        const fallbackOutput = output;
        const fallbackQuality = quality;
        try {
          await assertStageGuard(false);
          const primaryRetry = await executeWithProviderFallback({
            providerId: route.providerId,
            stageInput: routedStageInput,
            policy: { ...fallbackPolicy, chains: {}, maxRetries: Math.max(1, fallbackPolicy.maxRetries) },
            providerFactory: providerFromEnv
          });
          fallbackAttempts = [...fallbackAttempts, ...primaryRetry.attempts];
          output = primaryRetry.output;
          quality = scoreStageOutput(routedStageInput, output);
          fallbackUsed = false;
          fallbackProviderId = undefined;
          actualProviderId = primaryRetry.actualProvider;
          actualModel = primaryRetry.actualModel;
        } catch (error) {
          const failure = classifyProviderFailure(error);
          fallbackAttempts = [...fallbackAttempts, ...failure.attempts];
          output = {
            ...fallbackOutput,
            outcome: "blocked",
            blockedReason: `Provider recovery is required: the fallback blocker was not sufficiently evidenced and the primary retry failed (${failure.kind}).`
          };
          quality = fallbackQuality;
        }
      }

      if (!quality.passed && qualityFallbackProviderId && qualityFallbackProviderId !== actualProviderId) {
        try {
          await assertStageGuard(false);
          const qualityExecution = await executeWithProviderFallback({ providerId: qualityFallbackProviderId, stageInput: routedStageInput, policy: { ...fallbackPolicy, chains: {} }, providerFactory: providerFromEnv });
          const fallbackOutput = qualityExecution.output;
          const fallbackQuality = scoreStageOutput(routedStageInput, fallbackOutput);
          await recordDirectProviderUsage({ stage: routedStageInput, attempts: qualityExecution.attempts, output: fallbackOutput, latencyMs: Date.now() - startedAt }).catch(() => 0);
          fallbackAttempts = [...fallbackAttempts, ...qualityExecution.attempts];
          if (fallbackQuality.score >= quality.score) {
            output = fallbackOutput;
            quality = fallbackQuality;
            fallbackUsed = true;
            fallbackProviderId = qualityExecution.actualProvider;
            actualProviderId = qualityExecution.actualProvider;
            actualModel = qualityExecution.actualModel;
          }
        } catch (error) {
          if (error instanceof ProviderExecutionError) fallbackAttempts = [...fallbackAttempts, ...error.attempts];
        }
      }

      if (shouldContinuePlanningDeliverableGap({ stageId: task.stageId, output })) {
        output = {
          ...output,
          outcome: "completed",
          blockedReason: undefined,
          summary: `${output.summary} Recorded as implementation scope rather than a workflow prerequisite.`,
          artifact: { ...output.artifact, planningDeliverableGapReclassifiedAsFinding: true }
        };
        quality = scoreStageOutput(routedStageInput, output);
      }

      // Bounded file-read rounds: give API-backed providers the source-inspection
      // ability codex-cli has natively. The model lists files it needs, the
      // executor reads them under the read-path policy, and the model is asked
      // again with the contents in context. Reads are informational: a denied
      // or missing file is reported back, never a stage blocker.
      const stageFileReads: Array<{ path: string; content: string; truncated: boolean; sha256?: string; error?: string }> = [];
      const stageStateDeltas: StateDelta[] = [];
      const seenReadPaths = new Set<string>();
      const maxReadRounds = Math.min(Math.max(stagePattern.maxIterations ?? 5, 1), 10);
      let fileReadIteration = 0;
      const countRequestedActions = (out: typeof output): number =>
        (out.requestedCommands?.length ?? 0) + (out.requestedFileWrites?.length ?? 0) + (out.requestedFileReads?.length ?? 0);
      let readRounds = 0;
      while (readRounds < maxReadRounds) {
        const pendingReads = (output.requestedFileReads ?? []).filter((readPath) => {
          const key = readPath.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
          if (!key || seenReadPaths.has(key)) return false;
          seenReadPaths.add(key);
          return true;
        });
        if (pendingReads.length === 0) break;
        readRounds += 1;
        for (const readPath of pendingReads) {
          await assertLeaseOwned();
          fileReadIteration += 1;
          const fileReadIdempotencyKey = actionIdempotencyKey({
            taskId: task.taskId,
            stageId: task.stageId,
            agentId: task.agentId,
            actionType: "file_read",
            target: readPath,
            payload: readPath,
            normalizePayload: true
          });
          const readReceiptBase = {
            task,
            stagePattern,
            iteration: fileReadIteration,
            totalRequestedActions: countRequestedActions(output),
            actionType: "file_read" as const,
            target: readPath,
            payloadHash: hashText(normalizeActionText(readPath))
          };
          try {
            const readResult = await executeAllowedFileRead({
              relativePath: readPath,
              cwd: localProjectRootUri,
              project
            });
            const readArtifactUri = await recordRunAction({
              runId: task.runId,
              taskId: task.taskId,
              agentId: task.agentId,
              actionType: "file_read",
              target: readResult.relativePath,
              summary: `Read ${readResult.bytesRead} bytes from \`${readResult.relativePath}\`${readResult.truncated ? " (truncated at policy max)" : ""}.`,
              artifactKind: "file_read",
              artifactContent: {
                actionType: "file_read",
                path: readResult.relativePath,
                bytesRead: readResult.bytesRead,
                truncated: readResult.truncated,
                sha256: readResult.sha256,
                contentPreview: readResult.content.slice(0, 20000),
                requestedByTaskId: task.taskId,
                requestedByStageId: task.stageId
              },
              idempotencyKey: fileReadIdempotencyKey
            });
            stageFileReads.push({
              path: readResult.relativePath,
              content: readResult.content,
              truncated: readResult.truncated,
              sha256: readResult.sha256
            });
            stageStateDeltas.push(fileReadDelta({
              path: readResult.relativePath,
              bytesRead: readResult.bytesRead,
              truncated: readResult.truncated,
              sha256: readResult.sha256,
              provenance: { stageId: task.stageId, agentId: task.agentId, actionType: "file_read", taskId: task.taskId, artifactUri: readArtifactUri }
            }));
            actionResults.push({
              type: "file_read",
              path: readResult.relativePath,
              artifactUri: readArtifactUri,
              bytesRead: readResult.bytesRead,
              truncated: readResult.truncated
            });
            await recordBoundedReactLoopReceipt({
              ...readReceiptBase,
              policyDecision: {
                status: "allowed",
                approvalRequired: false,
                allowedByPolicy: true,
                policyProfile: project.execution.policy_profile
              },
              resultReceipt: {
                status: "completed",
                artifactUri: readArtifactUri,
                bytesRead: readResult.bytesRead,
                truncated: readResult.truncated
              }
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const denialArtifactUri = await recordRunAction({
              runId: task.runId,
              taskId: task.taskId,
              agentId: task.agentId,
              actionType: "file_read_rejected",
              target: readPath,
              summary: message,
              artifactKind: "action_rejection",
              artifactContent: {
                actionType: "file_read",
                target: readPath,
                error: message,
                requestedByTaskId: task.taskId,
                requestedByStageId: task.stageId
              }
            });
            stageFileReads.push({ path: readPath, content: "", truncated: false, error: message });
            stageStateDeltas.push(fileReadDelta({
              path: readPath,
              error: message,
              provenance: { stageId: task.stageId, agentId: task.agentId, actionType: "file_read_rejected", taskId: task.taskId, artifactUri: denialArtifactUri }
            }));
            actionResults.push({
              type: "file_read_rejected",
              path: readPath,
              artifactUri: denialArtifactUri,
              error: message
            });
            await recordBoundedReactLoopReceipt({
              ...readReceiptBase,
              policyDecision: {
                status: "rejected",
                approvalRequired: false,
                allowedByPolicy: false,
                policyProfile: project.execution.policy_profile
              },
              resultReceipt: {
                status: "rejected",
                artifactUri: denialArtifactUri
              }
            });
          }
        }
        await assertLeaseOwned();
        await assertStageGuard(false);
        const readRoundStartedAt = Date.now();
        const reread = await executeWithProviderFallback({
          providerId: route.providerId,
          stageInput: { ...routedStageInput, fileReads: stageFileReads, stateDeltas: stageStateDeltas },
          policy: { ...fallbackPolicy, chains: {}, maxRetries: Math.max(1, fallbackPolicy.maxRetries) },
          providerFactory: providerFromEnv
        });
        await recordDirectProviderUsage({ stage: routedStageInput, attempts: reread.attempts, output: reread.output, latencyMs: Date.now() - readRoundStartedAt }).catch(() => 0);
        fallbackAttempts = [...fallbackAttempts, ...reread.attempts];
        output = reread.output;
        quality = scoreStageOutput(routedStageInput, output);
        fallbackUsed = false;
        fallbackProviderId = undefined;
        actualProviderId = reread.actualProvider;
        actualModel = reread.actualModel;
      }

      const routeReceipt = buildModelRouteReceiptContent({ workflowId: task.workflowId, stageId: task.stageId, agentId: task.agentId, route, fallbackProviderId, fallbackUsed, actualProviderId, actualModel, attempts: fallbackAttempts, output, latencyMs: Date.now() - startedAt, stagePattern, quality });
      await recordRunAction({
        runId: task.runId,
        agentId: task.agentId,
        actionType: "model_route",
        target: `${task.workflowId}/${task.stageId}`,
        summary: `${route.providerId}${actualProviderId !== route.providerId ? ` -> ${actualProviderId}` : ""} quality=${quality.score}`,
        artifactKind: "model_route",
        artifactContent: routeReceipt
      });
      const routeUsage = routeReceipt.usage && typeof routeReceipt.usage === "object" && !Array.isArray(routeReceipt.usage) ? routeReceipt.usage as Record<string, unknown> : {};
      stageTelemetry.setRoute({
        providerId: actualProviderId ?? route.providerId,
        modelId: actualModel,
        inputTokens: finiteTelemetryNumber(routeUsage.inputTokens),
        outputTokens: finiteTelemetryNumber(routeUsage.outputTokens),
        cachedInputTokens: finiteTelemetryNumber(routeUsage.cachedInputTokens),
        reasoningTokens: finiteTelemetryNumber(routeUsage.reasoningTokens),
        costUsd: finiteTelemetryNumber(routeUsage.costUsd),
        costSource: typeof routeUsage.costSource === "string" ? routeUsage.costSource : undefined
      });

      if (output.outcome === "blocked") {
        const blockedReason = output.blockedReason?.trim() || output.summary;
        await blockWorkflowTask({
          taskId: task.taskId,
          runId: task.runId,
          agentId: task.agentId,
          workerId: task.workerId!,
          fencingToken: task.fencingToken,
          summary: output.summary,
          reason: blockedReason,
          artifact: {
            ...output.artifact,
            outcome: "blocked",
            blockedReason,
            routing: {
              ...route,
              fallbackProviderId,
              fallbackUsed,
              actualProviderId,
              actualModel,
              attempts: fallbackAttempts
            },
            quality,
            actionResults: []
          }
        });
        stageTelemetry.end("blocked", blockedReason);
        result.failed += 1;
        continue;
      }
      const verifyRetryBudget = verifyRetryBudgetFromEnv();
      let verifyRetriesRemaining = verifyRetryBudget;
      let mutationRetriesRemaining = Math.min(2, verifyRetryBudget);
      let verifyRetryRound = 0;
      let verifyRetryRequested = false;
      let verifyEnvironmentalBlock: { summary: string; reason: string; files: string[] } | null = null;
      verifyActionRounds:
      do {
        verifyRetryRequested = false;
        const totalRequestedActions = countRequestedActions(output);
        let reactIteration = 0;
        for (const commandLine of output.requestedCommands ?? []) {
          await assertLeaseOwned();
          reactIteration += 1;
          const commandIdempotencyKey = actionIdempotencyKey({
            taskId: task.taskId,
            stageId: task.stageId,
            agentId: task.agentId,
            actionType: "local_command",
            target: commandLine,
            payload: verifyRetryRound > 0 ? `${commandLine}\n# agentflow-verify-retry-round:${verifyRetryRound}` : commandLine,
            normalizePayload: true
          });
          const previousCommand = await findRunActionByIdempotencyKey({
            runId: task.runId,
            artifactKind: "command_output",
            idempotencyKey: commandIdempotencyKey
          });
          if (previousCommand) {
            const reuseArtifactUri = await recordRunAction({
              runId: task.runId,
              taskId: task.taskId,
              agentId: task.agentId,
              actionType: "local_command_reused",
              target: commandLine,
              summary: `Skipped duplicate command; reused receipt ${previousCommand.uri}.`,
              artifactKind: "action_reuse",
              artifactContent: {
                actionType: "local_command",
                target: commandLine,
                originalArtifactUri: previousCommand.uri,
                requestedByTaskId: task.taskId,
                requestedByStageId: task.stageId
              }
            });
            actionResults.push({
              type: "local_command_reused",
              commandLine,
              artifactUri: previousCommand.uri,
              reuseArtifactUri
            });
            await recordBoundedReactLoopReceipt({
              task,
              stagePattern,
              iteration: reactIteration,
              totalRequestedActions,
              actionType: "local_command",
              target: commandLine,
              payloadHash: hashText(normalizeActionText(commandLine)),
              policyDecision: {
                status: "reused",
                approvalRequired: false,
                allowedByPolicy: true,
                policyProfile: project.execution.policy_profile
              },
              resultReceipt: {
                status: "reused",
                artifactUri: reuseArtifactUri,
                originalArtifactUri: previousCommand.uri
              }
            });
            continue;
          }

          let commandApprovalRule: ActionApprovalRuleMatch | null = null;
          try {
              assertCommandAllowed(commandLine, project);
            } catch (error) {
              const policyError = error instanceof Error ? error.message : String(error);
              const rejectionArtifactUri = await recordRunAction({
                runId: task.runId,
                taskId: task.taskId,
                agentId: task.agentId,
                actionType: "local_command_rejected",
                target: commandLine,
                summary: policyError,
                artifactKind: "action_rejection",
                artifactContent: {
                  actionType: "local_command",
                  target: commandLine,
                  error: policyError,
                  requestedByTaskId: task.taskId,
                  requestedByStageId: task.stageId
                }
              });
              const approval = await requestActionApproval({
                runId: task.runId,
                taskId: task.taskId,
                stageId: task.stageId,
                agentId: task.agentId,
                actionType: "project_policy_change",
                target: `actions.allowed_commands:${normalizeActionText(commandLine)}`,
                rationale: `The requested command is outside the project allowlist. Approve this exact policy addition to continue ${task.stageId}.`,
                policyDecision: { approvalRequired: true, allowedByPolicy: false, policyProfile: project.execution.policy_profile },
                payload: { changeKind: "allowed_command", proposedRule: normalizeActionText(commandLine), requestedActionType: "local_command", requestedTarget: normalizeActionText(commandLine), policyError, rejectionArtifactUri },
                idempotencyKey: `policy-change-${commandIdempotencyKey}`
              });
              actionResults.push({
                type: "project_policy_change_approval_pending",
                commandLine,
                approvalId: approval.approvalId,
                artifactUri: rejectionArtifactUri,
                approvalArtifactUri: approval.artifactUri,
                error: policyError
              });
              await recordBoundedReactLoopReceipt({
                task,
                stagePattern,
                iteration: reactIteration,
                totalRequestedActions,
                actionType: "local_command",
                target: commandLine,
                payloadHash: hashText(normalizeActionText(commandLine)),
                policyDecision: {
                  status: "approval_required",
                  approvalRequired: true,
                  allowedByPolicy: false,
                  policyProfile: project.execution.policy_profile
                },
                resultReceipt: {
                  status: "approval_pending",
                  approvalId: approval.approvalId,
                  artifactUri: rejectionArtifactUri,
                  error: policyError
                }
              });
              continue;
          }
          if (project.policies.require_approval_for_external_actions) {
            commandApprovalRule = evaluateActionApprovalRule({
              project,
              actionType: "local_command",
              target: commandLine
            }) ?? evaluateActionRiskAutoApproval({
              project,
              actionType: "local_command",
              target: commandLine
            });
            if (!commandApprovalRule) {
              const approval = await requestActionApproval({
                runId: task.runId,
                taskId: task.taskId,
                stageId: task.stageId,
                agentId: task.agentId,
                actionType: "local_command",
                target: normalizeActionText(commandLine),
                rationale: `Policy requires approval before executing command requested by ${task.agentId} during ${task.stageId}.`,
                policyDecision: {
                  approvalRequired: true,
                  allowedByPolicy: true,
                  policyProfile: project.execution.policy_profile
                },
                payload: {
                  commandLine: normalizeActionText(commandLine),
                  payloadHash: hashText(normalizeActionText(commandLine))
                },
                idempotencyKey: commandIdempotencyKey
              });
              actionResults.push({
                type: "local_command_approval_pending",
                commandLine,
                approvalId: approval.approvalId,
                artifactUri: approval.artifactUri,
                status: approval.status
              });
              await recordBoundedReactLoopReceipt({
                task,
                stagePattern,
                iteration: reactIteration,
                totalRequestedActions,
                actionType: "local_command",
                target: commandLine,
                payloadHash: hashText(normalizeActionText(commandLine)),
                policyDecision: {
                  status: "approval_required",
                  approvalRequired: true,
                  allowedByPolicy: true,
                  policyProfile: project.execution.policy_profile
                },
                resultReceipt: {
                  status: "approval_pending",
                  approvalId: approval.approvalId,
                  artifactUri: approval.artifactUri
                }
              });
              continue;
            }
          }

          await assertStageGuard(true);
          const commandSideEffect = await claimSideEffect({ projectId: task.runId, idempotencyKey: commandIdempotencyKey, operation: "local_command", target: commandLine, claimSeconds: 3600 });
          if (commandSideEffect.status !== "claimed" || !commandSideEffect.claimToken) {
            actionResults.push({ type: `local_command_side_effect_${commandSideEffect.status}`, commandLine, receipt: commandSideEffect.receipt });
            continue;
          }
          await assertLeaseOwned();
          let commandResult: CommandExecutionResult;
          try {
            const serializationResource = commandSerializationResource(commandLine, localProjectRootUri);
            const executeCommand = () => {
              // Fix 3 pre-flight: `npm run` without a package.json in the
              // resolved cwd fails with npm's ENOENT. Fail fast with a clear
              // diagnostic naming the cwd and the missing file instead.
              const npmPreflightError = npmPreflightDiagnostic(commandLine, localProjectRootUri);
              if (npmPreflightError) {
                const preflightResult: CommandExecutionResult = {
                  commandLine,
                  cwd: localProjectRootUri,
                  exitCode: 1,
                  signal: null,
                  stdout: "",
                  stderr: npmPreflightError,
                  durationMs: 0,
                  timedOut: false
                };
                return Promise.resolve(preflightResult);
              }
              return executeAllowedCommand({ commandLine, cwd: localProjectRootUri, project });
            };
            commandResult = serializationResource
              ? await withProjectExecutionLock({ projectRootUri: task.projectRootUri, resource: serializationResource }, executeCommand)
              : await executeCommand();
          } catch (error) {
            const rejectionMessage = error instanceof Error ? error.message : String(error);
            const rejectionArtifactUri = await recordRunAction({
              runId: task.runId,
              taskId: task.taskId,
              agentId: task.agentId,
              actionType: "local_command_rejected",
              target: commandLine,
              summary: rejectionMessage,
              artifactKind: "action_rejection",
              artifactContent: {
                actionType: "local_command",
                target: commandLine,
                error: rejectionMessage,
                requestedByTaskId: task.taskId,
                requestedByStageId: task.stageId
              }
            });
            actionResults.push({
              type: "local_command_rejected",
              commandLine,
              artifactUri: rejectionArtifactUri,
              error: rejectionMessage
            });
            await recordBoundedReactLoopReceipt({
              task,
              stagePattern,
              iteration: reactIteration,
              totalRequestedActions,
              actionType: "local_command",
              target: commandLine,
              payloadHash: hashText(normalizeActionText(commandLine)),
              policyDecision: {
                status: "rejected",
                approvalRequired: false,
                allowedByPolicy: false,
                policyProfile: project.execution.policy_profile,
                approvalRule: commandApprovalRule ?? undefined
              },
              resultReceipt: {
                status: "rejected",
                artifactUri: rejectionArtifactUri,
                error: rejectionMessage
              }
            });
            continue;
          }
          const summary = [
            `Command \`${commandResult.commandLine}\` exited with ${commandResult.exitCode}`,
            commandResult.timedOut ? "after timing out" : `in ${commandResult.durationMs}ms`
          ].join(" ");
          const artifactUri = await recordRunAction({
            runId: task.runId,
            taskId: task.taskId,
            agentId: task.agentId,
            actionType: "local_command",
            target: commandResult.commandLine,
            summary,
            artifactKind: "command_output",
            artifactContent: {
              ...commandResult,
              approvalRule: commandApprovalRule ?? undefined,
              requestedByTaskId: task.taskId,
              requestedByStageId: task.stageId
            },
            idempotencyKey: commandIdempotencyKey
          });
          const commandFinalized = await finalizeSideEffect({ projectId: task.runId, idempotencyKey: commandIdempotencyKey, claimToken: commandSideEffect.claimToken, receipt: { artifactUri, exitCode: commandResult.exitCode, timedOut: commandResult.timedOut } });
          if (!commandFinalized) throw new Error(`Command side-effect claim could not be finalized for ${commandLine}.`);
          await dismissSupersededActionApprovals({ runId: task.runId, taskId: task.taskId, actionType: "local_command", target: commandLine, actor: task.workerId! });
          actionResults.push({
            commandLine,
            artifactUri,
            exitCode: commandResult.exitCode,
            timedOut: commandResult.timedOut,
            approvalRule: commandApprovalRule ?? undefined
          });
          await recordBoundedReactLoopReceipt({
            task,
            stagePattern,
            iteration: reactIteration,
            totalRequestedActions,
            actionType: "local_command",
            target: commandResult.commandLine,
            payloadHash: hashText(normalizeActionText(commandResult.commandLine)),
            policyDecision: {
              status: commandApprovalRule ? "auto_approved_by_rule" : "allowed",
              approvalRequired: false,
              allowedByPolicy: true,
              policyProfile: project.execution.policy_profile,
              approvalRule: commandApprovalRule ?? undefined
            },
            resultReceipt: {
              status: commandResult.exitCode === 0 && !commandResult.timedOut ? "completed" : "failed",
              artifactUri,
              exitCode: commandResult.exitCode,
              timedOut: commandResult.timedOut
            }
          });

          if (
            (commandResult.exitCode !== 0 || commandResult.timedOut)
            && !commandFailureIsDiagnosticEvidence(stagePattern)
            && !commandFailurePrecedesGovernedWrites(stagePattern, output)
          ) {
            // Fix 1: the thrown error carries the truncated command output so
            // failures are self-diagnosing instead of a bare command line.
            const failureEvidence = formatCommandFailureEvidence({
              commandLine,
              exitCode: commandResult.exitCode,
              timedOut: commandResult.timedOut,
              stdout: commandResult.stdout,
              stderr: commandResult.stderr
            });
            const truncatedOutput = truncateCommandOutputForError(
              [commandResult.stdout, commandResult.stderr].filter(Boolean).join("\n")
            );
            // Footprint-scoped attribution: when the failure is confined to
            // pre-existing dirty state the agent never touched, it is
            // environmental -- block the stage without burning the agent retry
            // budget. The developer's working tree is never modified.
            const verifyAttribution = await attributeVerifyCommandFailure({
              outputLines: truncatedOutput.split("\n"),
              cwd: localProjectRootUri,
              footprintBefore: verifyFootprintBefore
            });
            if (verifyAttribution.kind === "environmental") {
              const envFiles = verifyAttribution.files.join(", ");
              const envSummary =
                `ENVIRONMENTAL_VERIFY_FAILURE: verify command \`${commandLine}\` failed on ` +
                `files with pre-existing uncommitted changes outside this run's footprint (${envFiles}); ` +
                `not counted against the agent retry budget.`;
              await recordRunAction({
                runId: task.runId,
                taskId: task.taskId,
                agentId: task.agentId,
                actionType: "local_command_verify_environmental",
                target: commandLine,
                summary: envSummary,
                artifactKind: "command_output",
                artifactContent: {
                  commandLine,
                  exitCode: commandResult.exitCode,
                  timedOut: commandResult.timedOut,
                  environmentalFiles: verifyAttribution.files,
                  failureEvidence,
                  previousArtifactUri: artifactUri
                }
              });
              verifyEnvironmentalBlock = {
                summary: envSummary,
                reason: `Verify failed on pre-existing uncommitted changes outside this run's footprint: ${envFiles}.`,
                files: verifyAttribution.files
              };
              stageTelemetry.event("agentflow.verify.environmental_block", {
                "agentflow.verify.environmental.reason": `Verify failed on pre-existing uncommitted changes outside this run's footprint: ${envFiles}.`,
                "agentflow.verify.environmental.files": verifyAttribution.files.join(",")
              });
              break verifyActionRounds;
            }
            // Fix 2: in verify-type stages, feed the failure back to the agent
            // with a bounded retry budget instead of failing the run outright.
            // Planner/react stages keep their diagnostic-evidence behavior.
            if (verifyRetriesRemaining > 0 && commandFailureEligibleForVerifyRetry(stagePattern, commandLine)) {
              verifyRetriesRemaining -= 1;
              verifyRetryRound += 1;
              await recordRunAction({
                runId: task.runId,
                taskId: task.taskId,
                agentId: task.agentId,
                actionType: "local_command_verify_retry",
                target: commandLine,
                summary: `Verify retry ${verifyRetryRound} of ${verifyRetryBudget}: feeding command failure back to ${task.agentId} (${verifyRetriesRemaining} ${verifyRetriesRemaining === 1 ? "retry" : "retries"} left).`,
                artifactKind: "command_retry",
                artifactContent: {
                  commandLine,
                  exitCode: commandResult.exitCode,
                  timedOut: commandResult.timedOut,
                  truncatedOutput,
                  retryRound: verifyRetryRound,
                  retriesRemaining: verifyRetriesRemaining,
                  previousArtifactUri: artifactUri
                }
              });
              stageStateDeltas.push(commandFailureDelta({
                commandLine,
                exitCode: commandResult.exitCode,
                timedOut: commandResult.timedOut,
                truncatedOutput,
                retryRound: verifyRetryRound,
                retriesRemaining: verifyRetriesRemaining,
                provenance: {
                  stageId: task.stageId,
                  agentId: task.agentId,
                  actionType: "local_command",
                  taskId: task.taskId,
                  artifactUri
                }
              }));
              await assertLeaseOwned();
              await assertStageGuard(false);
              const verifyRetryStartedAt = Date.now();
              const verifyRetry = await executeWithProviderFallback({
                providerId: route.providerId,
                stageInput: { ...routedStageInput, fileReads: stageFileReads, stateDeltas: stageStateDeltas },
                policy: { ...fallbackPolicy, chains: {}, maxRetries: Math.max(1, fallbackPolicy.maxRetries) },
                providerFactory: providerFromEnv
              });
              await recordDirectProviderUsage({
                stage: routedStageInput,
                attempts: verifyRetry.attempts,
                output: verifyRetry.output,
                latencyMs: Date.now() - verifyRetryStartedAt
              }).catch(() => 0);
              fallbackAttempts = [...fallbackAttempts, ...verifyRetry.attempts];
              output = verifyRetry.output;
              quality = scoreStageOutput(routedStageInput, output);
              actualProviderId = verifyRetry.actualProvider;
              actualModel = verifyRetry.actualModel;
              verifyRetryRequested = true;
              stageTelemetry.event("agentflow.verify.retry", {
                "agentflow.verify.retry.round": verifyRetryRound + 1,
                "agentflow.verify.command": commandLine
              });
              continue verifyActionRounds;
            }
            throw new Error(`Requested command failed: ${commandLine}\n${failureEvidence}`);
          }
        }
        for (const fileWrite of output.requestedFileWrites ?? []) {
          await assertLeaseOwned();
          reactIteration += 1;
          const mutation = normalizeRequestedFileMutation(fileWrite);
          if (!mutation) continue;
          const { isPatch, payload: filePayload, expectedHash, bytes: actionBytes } = mutation;
          const fileWriteIdempotencyKey = actionIdempotencyKey({
            taskId: task.taskId,
            stageId: task.stageId,
            agentId: task.agentId,
            actionType: "file_write",
            target: fileWrite.path,
            payload: mutation.idempotencyPayload
          });
          const previousWrite = await findRunActionByIdempotencyKey({
            runId: task.runId,
            artifactKind: "file_write",
            idempotencyKey: fileWriteIdempotencyKey
          });
          if (previousWrite) {
            const reuseArtifactUri = await recordRunAction({
              runId: task.runId,
              taskId: task.taskId,
              agentId: task.agentId,
              actionType: "file_write_reused",
              target: fileWrite.path,
              summary: `Skipped duplicate file write; reused receipt ${previousWrite.uri}.`,
              artifactKind: "action_reuse",
              artifactContent: {
                actionType: "file_write",
                target: fileWrite.path,
                originalArtifactUri: previousWrite.uri,
                requestedByTaskId: task.taskId,
                requestedByStageId: task.stageId
              }
            });
            actionResults.push({
              type: "file_write_reused",
              path: fileWrite.path,
              artifactUri: previousWrite.uri,
              reuseArtifactUri
            });
            await recordBoundedReactLoopReceipt({
              task,
              stagePattern,
              iteration: reactIteration,
              totalRequestedActions,
              actionType: "file_write",
              target: fileWrite.path,
              payloadHash: hashText(filePayload),
              policyDecision: {
                status: "reused",
                approvalRequired: false,
                allowedByPolicy: true,
                policyProfile: project.execution.policy_profile
              },
              resultReceipt: {
                status: "reused",
                artifactUri: reuseArtifactUri,
                originalArtifactUri: previousWrite.uri
              }
            });
            continue;
          }

          let fileWriteApprovalRule: ActionApprovalRuleMatch | null = null;
          if (!isInternalWorkflowReceiptWrite(fileWrite.path)) {
            try {
              if (isPatch) assertFilePatchAllowed(fileWrite.path, filePayload, expectedHash!, project);
              else assertFileWriteAllowed(fileWrite.path, filePayload, project);
            } catch (error) {
              const policyError = error instanceof Error ? error.message : String(error);
              const rejectionArtifactUri = await recordRunAction({
                runId: task.runId,
                taskId: task.taskId,
                agentId: task.agentId,
                actionType: "file_write_rejected",
                target: fileWrite.path,
                summary: policyError,
                artifactKind: "action_rejection",
                artifactContent: {
                  actionType: "file_write",
                  target: fileWrite.path,
                  error: policyError,
                  requestedByTaskId: task.taskId,
                  requestedByStageId: task.stageId
                }
              });
              const approval = await requestActionApproval({
                runId: task.runId,
                taskId: task.taskId,
                stageId: task.stageId,
                agentId: task.agentId,
                actionType: "project_policy_change",
                target: `actions.allowed_write_paths:${fileWrite.path}`,
                rationale: `The requested file is outside the project write allowlist. Approve this exact policy addition to continue ${task.stageId}.`,
                policyDecision: { approvalRequired: true, allowedByPolicy: false, policyProfile: project.execution.policy_profile },
                payload: { changeKind: "allowed_write_path", proposedRule: fileWrite.path, requestedActionType: "file_write", requestedTarget: fileWrite.path, policyError, rejectionArtifactUri },
                idempotencyKey: `policy-change-${fileWriteIdempotencyKey}`
              });
              actionResults.push({
                type: "project_policy_change_approval_pending",
                path: fileWrite.path,
                approvalId: approval.approvalId,
                artifactUri: rejectionArtifactUri,
                approvalArtifactUri: approval.artifactUri,
                error: policyError
              });
              await recordBoundedReactLoopReceipt({
                task,
                stagePattern,
                iteration: reactIteration,
                totalRequestedActions,
                actionType: "file_write",
                target: fileWrite.path,
                payloadHash: hashText(filePayload),
                policyDecision: {
                  status: "approval_required",
                  approvalRequired: true,
                  allowedByPolicy: false,
                  policyProfile: project.execution.policy_profile
                },
                resultReceipt: {
                  status: "approval_pending",
                  approvalId: approval.approvalId,
                  artifactUri: rejectionArtifactUri,
                  error: policyError
                }
              });
              continue;
            }
          }
          if (project.policies.require_approval_for_external_actions && !isInternalWorkflowReceiptWrite(fileWrite.path)) {
            fileWriteApprovalRule = evaluateActionApprovalRule({
              project,
              actionType: "file_write",
              target: fileWrite.path,
              bytes: actionBytes
            }) ?? evaluateActionRiskAutoApproval({
              project,
              actionType: "file_write",
              target: fileWrite.path,
              bytes: actionBytes
            });
            if (!fileWriteApprovalRule) {
              const approval = await requestActionApproval({
                runId: task.runId,
                taskId: task.taskId,
                stageId: task.stageId,
                agentId: task.agentId,
                actionType: "file_write",
                target: fileWrite.path,
                rationale: `Policy requires approval before writing a file requested by ${task.agentId} during ${task.stageId}.`,
                policyDecision: {
                  approvalRequired: true,
                  allowedByPolicy: true,
                  policyProfile: project.execution.policy_profile
                },
                payload: {
                  relativePath: fileWrite.path,
                  bytes: actionBytes,
                  payloadHash: hashText(filePayload),
                  mode: isPatch ? "patch" : "replace",
                  expectedHash
                },
                idempotencyKey: fileWriteIdempotencyKey
              });
              actionResults.push({
                type: "file_write_approval_pending",
                path: fileWrite.path,
                approvalId: approval.approvalId,
                artifactUri: approval.artifactUri,
                status: approval.status
              });
              await recordBoundedReactLoopReceipt({
                task,
                stagePattern,
                iteration: reactIteration,
                totalRequestedActions,
                actionType: "file_write",
                target: fileWrite.path,
                payloadHash: hashText(filePayload),
                policyDecision: {
                  status: "approval_required",
                  approvalRequired: true,
                  allowedByPolicy: true,
                  policyProfile: project.execution.policy_profile
                },
                resultReceipt: {
                  status: "approval_pending",
                  approvalId: approval.approvalId,
                  artifactUri: approval.artifactUri
                }
              });
              continue;
            }
          }

          await assertStageGuard(true);
          const fileSideEffect = await claimSideEffect({ projectId: task.runId, idempotencyKey: fileWriteIdempotencyKey, operation: "file_write", target: fileWrite.path, claimSeconds: 3600 });
          if (fileSideEffect.status !== "claimed" || !fileSideEffect.claimToken) {
            actionResults.push({ type: `file_write_side_effect_${fileSideEffect.status}`, path: fileWrite.path, receipt: fileSideEffect.receipt });
            continue;
          }
          await assertLeaseOwned();
          let writeResult;
          try {
            writeResult = await withProjectExecutionLock(
              { projectRootUri: task.projectRootUri, resource: `file:${fileWrite.path.replace(/\\/gu, "/")}` },
              () => executeAllowedFileMutation({ request: fileWrite, payload: filePayload, isPatch, expectedHash, cwd: localProjectRootUri, project })
            );
          } catch (error) {
            const rejectionMessage = error instanceof Error ? error.message : String(error);
            const rejectionArtifactUri = await recordRunAction({
              runId: task.runId,
              taskId: task.taskId,
              agentId: task.agentId,
              actionType: "file_write_rejected",
              target: fileWrite.path,
              summary: rejectionMessage,
              artifactKind: "action_rejection",
              artifactContent: {
                actionType: "file_write",
                target: fileWrite.path,
                error: rejectionMessage,
                requestedByTaskId: task.taskId,
                requestedByStageId: task.stageId
              }
            });
            actionResults.push({
              type: "file_write_rejected",
              path: fileWrite.path,
              artifactUri: rejectionArtifactUri,
              error: rejectionMessage
            });
            await recordBoundedReactLoopReceipt({
              task,
              stagePattern,
              iteration: reactIteration,
              totalRequestedActions,
              actionType: "file_write",
              target: fileWrite.path,
              payloadHash: hashText(filePayload),
              policyDecision: {
                status: "rejected",
                approvalRequired: false,
                allowedByPolicy: false,
                policyProfile: project.execution.policy_profile,
                approvalRule: fileWriteApprovalRule ?? undefined
              },
              resultReceipt: {
                status: "rejected",
                artifactUri: rejectionArtifactUri,
                error: rejectionMessage
              }
            });
            if (isPatch && mutationRetriesRemaining > 0 && isRecoverableFileMutationFailure(rejectionMessage)) {
              mutationRetriesRemaining -= 1;
              await prepareRejectedPatchRetry({ path: fileWrite.path, cwd: localProjectRootUri, project, rejectionMessage, rejectionArtifactUri, runId: task.runId, stageId: task.stageId, agentId: task.agentId, taskId: task.taskId, retriesRemaining: mutationRetriesRemaining, reads: stageFileReads, deltas: stageStateDeltas });
              await assertLeaseOwned();
              await assertStageGuard(false);
              const retryStartedAt = Date.now();
              const retry = await executeWithProviderFallback({
                providerId: route.providerId,
                stageInput: { ...routedStageInput, fileReads: stageFileReads, stateDeltas: stageStateDeltas },
                policy: { ...fallbackPolicy, chains: {}, maxRetries: 0 },
                providerFactory: providerFromEnv
              });
              await recordDirectProviderUsage({ stage: routedStageInput, attempts: retry.attempts, output: retry.output, latencyMs: Date.now() - retryStartedAt }).catch(() => 0);
              fallbackAttempts = [...fallbackAttempts, ...retry.attempts];
              output = retry.output;
              quality = scoreStageOutput(routedStageInput, output);
              actualProviderId = retry.actualProvider;
              actualModel = retry.actualModel;
              verifyRetryRequested = true;
              continue verifyActionRounds;
            }
            continue;
          }
          const summary = summarizeFileMutation(writeResult, isPatch);
          const artifactUri = await recordRunAction({
            runId: task.runId,
            taskId: task.taskId,
            agentId: task.agentId,
            actionType: "file_write",
            target: writeResult.relativePath,
            summary,
            artifactKind: "file_write",
            artifactContent: {
              ...writeResult,
              approvalRule: fileWriteApprovalRule ?? undefined,
              mode: isPatch ? "patch" : "replace",
              requestedByTaskId: task.taskId,
              requestedByStageId: task.stageId
            },
            idempotencyKey: fileWriteIdempotencyKey
          });
          const fileWriteFinalized = await finalizeSideEffect({ projectId: task.runId, idempotencyKey: fileWriteIdempotencyKey, claimToken: fileSideEffect.claimToken, receipt: { artifactUri, path: writeResult.relativePath, nextHash: writeResult.nextHash } });
          if (!fileWriteFinalized) throw new Error(`File-write side-effect claim could not be finalized for ${fileWrite.path}.`);
          await dismissSupersededActionApprovals({ runId: task.runId, taskId: task.taskId, actionType: "file_write", target: fileWrite.path, actor: task.workerId! });
          actionResults.push({
            type: "file_write",
            path: writeResult.relativePath,
            artifactUri,
            bytesWritten: writeResult.bytesWritten,
            nextHash: writeResult.nextHash,
            approvalRule: fileWriteApprovalRule ?? undefined
          });
          await recordBoundedReactLoopReceipt({
            task,
            stagePattern,
            iteration: reactIteration,
            totalRequestedActions,
            actionType: "file_write",
            target: writeResult.relativePath,
            payloadHash: hashText(filePayload),
            policyDecision: {
              status: fileWriteApprovalRule ? "auto_approved_by_rule" : "allowed",
              approvalRequired: false,
              allowedByPolicy: true,
              policyProfile: project.execution.policy_profile,
              approvalRule: fileWriteApprovalRule ?? undefined
            },
            resultReceipt: {
              status: "completed",
              artifactUri,
              bytesWritten: writeResult.bytesWritten,
              previousHash: writeResult.previousHash,
              nextHash: writeResult.nextHash
            }
          });
        }
      } while (verifyRetryRequested);
      if (verifyEnvironmentalBlock) {
        await blockWorkflowTask({
          taskId: task.taskId,
          runId: task.runId,
          agentId: task.agentId,
          workerId: task.workerId!,
          fencingToken: task.fencingToken,
          summary: verifyEnvironmentalBlock.summary,
          reason: verifyEnvironmentalBlock.reason,
          artifact: {
            ...output.artifact,
            outcome: "blocked",
            blockedReason: verifyEnvironmentalBlock.reason,
            environmentalFiles: verifyEnvironmentalBlock.files,
            actionResults
          }
        });
        stageTelemetry.end("blocked", verifyEnvironmentalBlock.reason);
        clearInterval(leaseHeartbeat);
        result.failed += 1;
        continue;
      }
      const incompleteActions = actionResults.filter((action) => {
        const type = typeof action === "object" && action && "type" in action ? String(action.type) : "";
        if (type === "file_read_rejected") return false;
        if (type === "file_write_rejected" && fileWriteRejectionRecovered(actionResults, action)) return false;
        return type.endsWith("_approval_pending") || type.endsWith("_rejected") || type.includes("_side_effect_");
      });
      if (incompleteActions.length > 0) {
        await blockWorkflowTask({
          taskId: task.taskId,
          runId: task.runId,
          agentId: task.agentId,
          workerId: task.workerId!,
          fencingToken: task.fencingToken,
          summary: `Stage is waiting on ${incompleteActions.length} required action${incompleteActions.length === 1 ? "" : "s"}.`,
          reason: "Required actions were rejected or are awaiting approval; the stage cannot complete until they have durable successful receipts.",
          artifact: {
            ...output.artifact,
            outcome: "blocked",
            blockedReason: "Required actions were rejected or are awaiting approval.",
            actionResults
          }
        });
        stageTelemetry.end("blocked", "Required actions were rejected or are awaiting approval.");
        clearInterval(leaseHeartbeat);
        result.failed += 1;
        continue;
      }
      const verificationViolation = verificationCompletionReason(routedStageInput, actionResults);
      if (verificationViolation) {
        await blockWorkflowTask({
          taskId: task.taskId,
          runId: task.runId,
          agentId: task.agentId,
          workerId: task.workerId!,
          fencingToken: task.fencingToken,
          summary: verificationViolation,
          reason: verificationViolation,
          artifact: { ...output.artifact, outcome: "blocked", blockedReason: verificationViolation, actionResults }
        });
        stageTelemetry.end("blocked", verificationViolation);
        clearInterval(leaseHeartbeat);
        result.failed += 1;
        continue;
      }
      await assertLeaseOwned();
      await completeWorkflowTask({
        taskId: task.taskId,
        runId: task.runId,
        agentId: task.agentId,
        workerId: task.workerId!,
        fencingToken: task.fencingToken,
        summary: output.summary,
        artifact: {
          ...output.artifact,
          routing: {
            ...route,
            fallbackProviderId,
            fallbackUsed,
            actualProviderId,
            actualModel,
            attempts: fallbackAttempts
          },
          quality,
          actionResults
        }
      });
      // Memory graph write path: advisory, idempotent, never breaks completion.
      await recordStageMemoryGraph({
        projectId: localProjectRootUri,
        runId: task.runId,
        taskId: task.taskId,
        goalTitle: task.workflowTask,
        taskTitle: task.stageGoal,
        decisionSummary: route.reason,
        resultSummary: output.summary
      });
      stageTelemetry.end("completed");
      clearInterval(leaseHeartbeat);
      result.completed += 1;
    } catch (error) {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      const providerFailure = classifyProviderFailure(error);
      if (attemptedProviderId && (providerFailure.kind === "authentication" || providerFailure.kind === "configuration")) {
        result.providerFailures.push({ providerId: attemptedProviderId, kind: providerFailure.kind });
        if (options?.providerIds) {
          options.providerIds.splice(
            0,
            options.providerIds.length,
            ...options.providerIds.filter((providerId) => providerId !== attemptedProviderId)
          );
        }
      }
      if (!(error instanceof LostWorkflowTaskLeaseError) && !isStaleLeaseError(error)) {
        await failWorkflowTask({
          taskId: task.taskId,
          runId: task.runId,
          agentId: task.agentId,
          workerId: task.workerId!,
          fencingToken: task.fencingToken,
          error: error instanceof Error ? error.message : String(error)
        }).catch((failureError) => {
          if (!isStaleLeaseError(failureError)) throw failureError;
        });
      }
      stageTelemetry?.end("failed", error instanceof Error ? error.message : String(error));
      result.failed += 1;
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    }
  }

  await flushStageTelemetry();
  return result;
}

async function executeBoundExecutorStage(task: Awaited<ReturnType<typeof claimNextWorkflowTask>> & {}, project: ReturnType<typeof projectConfigSchema.parse>, assertLeaseOwned: () => Promise<void> = async () => {}): Promise<void> {
  if (!task?.executorSnapshot) throw new Error("Executor stage is missing immutable executor evidence.");
  if (task.executorSnapshot.registeredProjectRoot !== task.projectRootUri) throw new Error("Executor snapshot project root does not match the registered workflow project.");
  assertExecutorRegistration(task.executorSnapshot, project, task.projectRootUri);
  const commandLine = operationCommand(task.executorSnapshot.operation);
  assertCommandAllowed(commandLine, project);
  const approvalTarget = executorApprovalTarget(task.executorSnapshot);
  try {
    const previous = await findRunActionByIdempotencyKey({
      runId: task.runId,
      artifactKind: "executor_output",
      idempotencyKey: task.executorSnapshot.snapshotHash
    });
    const previousExecution = previous?.content.execution as { status?: string } | undefined;
    if (previous && previousExecution?.status === "passed") {
      await assertLeaseOwned();
      const reuseArtifactUri = await recordRunAction({
        runId: task.runId,
        taskId: task.taskId,
        agentId: task.agentId,
        actionType: "executor_adapter_reused",
        target: `${task.executorSnapshot.executorId}/${task.executorSnapshot.operation}`,
        summary: `Skipped duplicate executor request; reused receipt ${previous.uri}.`,
        artifactKind: "action_reuse",
        artifactContent: { snapshot: task.executorSnapshot, originalArtifactUri: previous.uri }
      });
      await completeWorkflowTask({
        taskId: task.taskId,
        runId: task.runId,
        agentId: task.agentId,
        workerId: task.workerId!,
        fencingToken: task.fencingToken,
        summary: `Reused ${task.executorSnapshot.operation} result from ${previous.uri}.`,
        artifact: { executor: task.executorSnapshot, execution: previous.content.execution, actionResults: [{ type: "executor_adapter_reused", artifactUri: previous.uri, reuseArtifactUri }] }
      });
      return;
    }
    await assertLeaseOwned();
    const gated = await runExecutorApprovalGate({
      project,
      target: approvalTarget,
      approved: false,
      execute: () => executeExecutorSnapshot(task.executorSnapshot!, {
        localFallback: task.executorSnapshot!.localFallback === "explicit"
          ? async () => localFallbackResult(commandLine, task.projectRootUri, project, task.executorSnapshot!.requestedHost)
          : undefined
      })
    });
    if (gated.status === "pending") {
        const approval = await requestActionApproval({
          runId: task.runId,
          taskId: task.taskId,
          stageId: task.stageId,
          agentId: task.agentId,
          actionType: "executor_adapter",
          target: approvalTarget,
          rationale: `Policy requires approval before executing ${approvalTarget}.`,
          policyDecision: {
            approvalRequired: true,
            allowedByPolicy: true,
            policyProfile: project.execution.policy_profile
          },
          payload: {
            snapshot: task.executorSnapshot,
            commandLine,
            payloadHash: hashText(JSON.stringify(task.executorSnapshot))
          },
          idempotencyKey: task.executorSnapshot.snapshotHash
        });
        await blockWorkflowTask({
          taskId: task.taskId,
          runId: task.runId,
          agentId: task.agentId,
          workerId: task.workerId!,
          fencingToken: task.fencingToken,
          summary: `Approval pending for ${approvalTarget}.`,
          reason: `Required executor action ${approvalTarget} is awaiting approval.`,
          artifact: { executor: task.executorSnapshot, actionResults: [{ type: "executor_adapter_approval_pending", approvalId: approval.approvalId, artifactUri: approval.artifactUri, status: approval.status }] }
        });
        return;
    }
    const executorApprovalRule = gated.approvalRule;
    await assertLeaseOwned();
    const execution = gated.result;
    const artifactUri = await recordRunAction({
      runId: task.runId,
      taskId: task.taskId,
      agentId: task.agentId,
      actionType: "executor_adapter",
      target: `${task.executorSnapshot.executorId}/${task.executorSnapshot.operation}`,
      summary: `${execution.status} on ${execution.executionHost}${execution.fallbackUsed ? " via explicit local fallback" : ""}`,
      artifactKind: "executor_output",
      artifactContent: { snapshot: task.executorSnapshot, execution, approvalRule: executorApprovalRule ?? undefined },
      idempotencyKey: task.executorSnapshot.snapshotHash
    });
    if (execution.status !== "passed") throw new Error(`Executor ${task.executorSnapshot.executorId} failed on ${execution.executionHost}.`);
    await completeWorkflowTask({
      taskId: task.taskId,
      runId: task.runId,
      agentId: task.agentId,
      workerId: task.workerId!,
      fencingToken: task.fencingToken,
      summary: `Executed ${task.executorSnapshot.operation} on ${execution.executionHost}.`,
      artifact: { executor: task.executorSnapshot, execution, actionResults: [{ type: "executor_adapter", artifactUri }] }
    });
  } catch (error) {
    await recordRunAction({
      runId: task.runId,
      taskId: task.taskId,
      agentId: task.agentId,
      actionType: "executor_adapter_failed",
      target: `${task.executorSnapshot.executorId}/${task.executorSnapshot.operation}`,
      summary: error instanceof Error ? error.message : String(error),
      artifactKind: "executor_failure",
      artifactContent: { snapshot: task.executorSnapshot, error: error instanceof Error ? error.message : String(error) },
      idempotencyKey: `${task.executorSnapshot.snapshotHash}:failure`
    });
    throw error;
  }
}

export function executorApprovalTarget(snapshot: { executorId: string; operation: string; requestedHost: string; revision: string; registeredProjectRoot: string }): string {
  return `${snapshot.executorId}/${snapshot.operation}@${snapshot.requestedHost}#${snapshot.revision}:${snapshot.registeredProjectRoot}`;
}

export async function runExecutorApprovalGate<T>(input: {
  project: ReturnType<typeof projectConfigSchema.parse>;
  target: string;
  approved: boolean;
  execute: () => Promise<T>;
}): Promise<{ status: "pending" } | { status: "executed"; result: T; approvalRule: ActionApprovalRuleMatch | null }> {
  const approvalRule = input.project.policies.require_approval_for_external_actions
    ? evaluateActionApprovalRule({ project: input.project, actionType: "executor_adapter", target: input.target })
    : null;
  if (input.project.policies.require_approval_for_external_actions && !input.approved && !approvalRule) return { status: "pending" };
  return { status: "executed", result: await input.execute(), approvalRule };
}

function operationCommand(operation: ExecutorOperation): string {
  return operation === "typecheck" ? "npm run typecheck" : operation === "validate" ? "npm run validate" : "npm test";
}

async function localFallbackResult(commandLine: string, cwd: string, project: ReturnType<typeof projectConfigSchema.parse>, requestedHost: string): Promise<ExecutorResult> {
  const result = await executeAllowedCommand({ commandLine, cwd, project });
  return {
    ...result,
    status: result.exitCode === 0 && !result.timedOut ? "passed" : "failed",
    requestedHost,
    executionHost: "local",
    fallbackUsed: true,
    artifactReference: null
  };
}

async function runWorkerOnceConcurrently(limit: number, options: WorkerRunOptions, concurrency: number): Promise<WorkerResult> {
  const result: WorkerResult = { claimed: 0, completed: 0, failed: 0, providerFailures: [] };
  let remaining = limit;
  const runLane = async (): Promise<void> => {
    while (remaining > 0) {
      remaining -= 1;
      const tick = await runWorkerOnce(1, options);
      result.claimed += tick.claimed;
      result.completed += tick.completed;
      result.failed += tick.failed;
      result.providerFailures.push(...tick.providerFailures);
      if (tick.claimed === 0) {
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, runLane));
  return result;
}

type StagePattern = NonNullable<StageExecutionInput["stagePattern"]>;

function normalizeStagePattern(value: unknown): StagePattern {
  if (!value || typeof value !== "object") {
    return {
      type: "executor",
      requiresVerifier: false,
      promotionGate: "none",
      stopConditions: []
    };
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "executor";
  const maxIterations = Number.isInteger(record.max_iterations)
    ? Number(record.max_iterations)
    : Number.isInteger(record.maxIterations)
      ? Number(record.maxIterations)
      : undefined;
  const promotionGate = typeof record.promotion_gate === "string"
    ? record.promotion_gate
    : typeof record.promotionGate === "string"
      ? record.promotionGate
      : "none";
  const requiresVerifier = typeof record.requires_verifier === "boolean"
    ? record.requires_verifier
    : typeof record.requiresVerifier === "boolean"
      ? record.requiresVerifier
      : false;
  const rawStopConditions = Array.isArray(record.stop_conditions)
    ? record.stop_conditions
    : Array.isArray(record.stopConditions)
      ? record.stopConditions
      : [];
  return {
    type,
    maxIterations: maxIterations && maxIterations > 0 ? Math.min(maxIterations, 25) : undefined,
    requiresVerifier,
    promotionGate,
    stopConditions: rawStopConditions.filter((item): item is string => typeof item === "string")
  };
}

async function recordBoundedReactLoopReceipt(input: {
  task: Pick<ClaimedWorkflowTask, "runId" | "taskId" | "workflowId" | "workflowTask" | "stageId" | "stageGoal" | "agentId">;
  stagePattern: StagePattern;
  iteration: number;
  totalRequestedActions: number;
  actionType: "local_command" | "file_write" | "file_read";
  target: string;
  payloadHash: string;
  policyDecision: Record<string, unknown>;
  resultReceipt: Record<string, unknown>;
}): Promise<void> {
  if (input.stagePattern.type !== "react") return;

  const receipt = buildBoundedReactLoopReceiptContent(input);

  await recordRunAction({
    runId: input.task.runId,
    taskId: input.task.taskId,
    agentId: input.task.agentId,
    actionType: "react_loop_step",
    target: `${receipt.workflowId}/${receipt.stageId}#${receipt.iteration}`,
    summary: `ReAct step ${receipt.iteration}/${receipt.maxIterations}: ${input.actionType} ${input.target} -> ${String(input.resultReceipt.status ?? "recorded")}; stop=${receipt.stopReason}.`,
    artifactKind: "react_loop_receipt",
    artifactContent: receipt
  });
}

function normalizeActionText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function finiteTelemetryNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export async function runWorkerWatch(input: WorkerWatchInput): Promise<void> {
  const subscriber = await createWorkflowEventSubscriber().catch(() => null);
  try {
    return await runWorkerWatchLoop({ ...input, waitForWake: subscriber ? (timeoutMs) => subscriber.wait(timeoutMs) : undefined }, runWorkerOnce);
  } finally {
    await subscriber?.close();
  }
}
