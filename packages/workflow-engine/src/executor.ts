import { createHash } from "node:crypto";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { assertCommandAllowed, commandSerializationResource, executeAllowedCommand } from "../../local-tools/src/command-executor.js";
import { assertFileWriteAllowed, executeAllowedFileWrite } from "../../local-tools/src/file-writer.js";
import { classifyProviderFailure, executeWithProviderFallback, providerFallbackPolicyFromEnv, ProviderExecutionError, providerFromEnv, type ProviderFallbackAttempt } from "../../model-providers/src/index.js";
import { scoreStageOutput, unfulfilledCompletionReason } from "../../model-providers/src/quality.js";
import { selectModelRoute } from "../../model-providers/src/routing.js";
import type { StageExecutionInput, StageExecutionOutput } from "../../model-providers/src/types.js";
import { buildModelRouteReceiptContent } from "./model-route-receipt.js";
import { recordDirectProviderUsage } from "./fleet-usage.js";
import { actionIdempotencyKey, buildBoundedReactLoopReceiptContent } from "./action-receipts.js";
export { actionIdempotencyKey, buildBoundedReactLoopReceiptContent } from "./action-receipts.js";
import { evaluateActionApprovalRule, evaluateActionRiskAutoApproval, type ActionApprovalRuleMatch } from "../../policy-engine/src/index.js";
import { resolveLocalProjectPath } from "../../runtime-root/src/index.js";
import { assertExecutorRegistration, executeExecutorSnapshot, type ExecutorOperation, type ExecutorResult } from "../../executor-adapters/src/index.js";
import {
  blockWorkflowTask,
  claimSideEffect,
  claimNextWorkflowTask,
  completeWorkflowTask,
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
  type ClaimedWorkflowTask
} from "../../storage/src/postgres.js";

export interface WorkerResult {
  claimed: number;
  completed: number;
  failed: number;
}

export type WorkerRunOptions = {
  workerId?: string;
  leaseSeconds?: number;
  projectRootUri?: string;
  concurrency?: number;
  recoverExpiredLeases?: boolean;
  providerIds?: string[];
  unavailableProjectRootUris?: Set<string>;
};

export class LostWorkflowTaskLeaseError extends Error {
  constructor(taskId: string) {
    super(`Worker lost ownership of workflow task ${taskId}; no further side effects may be dispatched.`);
    this.name = "LostWorkflowTaskLeaseError";
  }
}

function isStaleLeaseError(error: unknown): boolean {
  return error instanceof Error && /stale workflow fencing token|expired task lease/iu.test(error.message);
}

export function shouldRetryWeakFallbackBlock(input: {
  fallbackUsed: boolean;
  actualProviderId: string;
  output: StageExecutionOutput;
  qualityReasons: string[];
}): boolean {
  if (!input.fallbackUsed || input.output.outcome !== "blocked") return false;
  if (input.actualProviderId !== "local" && input.actualProviderId !== "byo" && input.actualProviderId !== "openai-compatible") return false;
  const reason = `${input.output.blockedReason ?? ""} ${input.output.summary}`.toLowerCase();
  const genericBlocker = /missing (?:project )?context|working tree details|collaboration service|could not resolve (?:this )?thread|insufficient context|more context is needed/u.test(reason);
  return genericBlocker || input.qualityReasons.includes("no concrete findings") || input.qualityReasons.includes("limited project-specific evidence");
}

export function shouldContinuePlanningDeliverableGap(input: { stageId: string; output: StageExecutionOutput }): boolean {
  if (input.output.outcome !== "blocked" || !/^(?:orient|plan|inspect|collect)$/u.test(input.stageId)) return false;
  const reason = `${input.output.blockedReason ?? ""} ${input.output.summary}`.toLowerCase();
  if (/\b(?:approval|permission|credential|authentication|authorization|quota|secret|user decision|ambiguous target)\b/u.test(reason)) return false;
  return /\b(?:missing|not provided|not present|requires?|needs?)\b/u.test(reason)
    && /\b(?:project map|memory records?|implementation|deliverables?|architecture|dependencies|data flows?|tests?|source|details|context)\b/u.test(reason);
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
    failed: 0
  };

  for (let i = 0; i < safeLimit; i += 1) {
    const task = await claimNextWorkflowTask({
      ...options,
      excludedProjectRootUris: [...(options?.unavailableProjectRootUris ?? [])]
    });
    if (!task) {
      break;
    }

    result.claimed += 1;

    let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
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
      const actionResults = [];
      const project = projectConfigSchema.parse(task.projectConfig);
      const localProjectRootUri = projectResolution.localRootUri;
      const stagePattern = normalizeStagePattern(task.stagePattern);
      const stageInput = {
        ...task,
        projectRootUri: localProjectRootUri,
        stagePattern,
        projectConfig: project,
        modelTier: (task.modelTier as "fast" | "standard" | "reasoning") ?? undefined
      };
      if (task.executorSnapshot) {
        await executeBoundExecutorStage(task, project, assertLeaseOwned);
        clearInterval(leaseHeartbeat);
        result.completed += 1;
        continue;
      }
      const route = await selectModelRoute(stageInput);
      const routedStageInput = {
        ...stageInput,
        modelTier: route.modelTier
      };
      const startedAt = Date.now();
      const fallbackPolicy = providerFallbackPolicyFromEnv();
      let execution;
      try {
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

      await recordRunAction({
        runId: task.runId,
        agentId: task.agentId,
        actionType: "model_route",
        target: `${task.workflowId}/${task.stageId}`,
        summary: `${route.providerId}${actualProviderId !== route.providerId ? ` -> ${actualProviderId}` : ""} quality=${quality.score}`,
        artifactKind: "model_route",
        artifactContent: buildModelRouteReceiptContent({ workflowId: task.workflowId, stageId: task.stageId, agentId: task.agentId, route, fallbackProviderId, fallbackUsed, actualProviderId, actualModel, attempts: fallbackAttempts, output, latencyMs: Date.now() - startedAt, stagePattern, quality })
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
        result.failed += 1;
        continue;
      }

      const totalRequestedActions = (output.requestedCommands?.length ?? 0) + (output.requestedFileWrites?.length ?? 0);
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
          payload: commandLine,
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
        if (project.policies.require_approval_for_external_actions) {
          try {
            assertCommandAllowed(commandLine, project);
          } catch (error) {
            const rejectionArtifactUri = await recordRunAction({
              runId: task.runId,
              taskId: task.taskId,
              agentId: task.agentId,
              actionType: "local_command_rejected",
              target: commandLine,
              summary: error instanceof Error ? error.message : String(error),
              artifactKind: "action_rejection",
              artifactContent: {
                actionType: "local_command",
                target: commandLine,
                error: error instanceof Error ? error.message : String(error),
                requestedByTaskId: task.taskId,
                requestedByStageId: task.stageId
              }
            });
            actionResults.push({
              type: "local_command_rejected",
              commandLine,
              artifactUri: rejectionArtifactUri,
              error: error instanceof Error ? error.message : String(error)
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
                policyProfile: project.execution.policy_profile
              },
              resultReceipt: {
                status: "rejected",
                artifactUri: rejectionArtifactUri,
                error: error instanceof Error ? error.message : String(error)
              }
            });
            continue;
          }
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

        const commandSideEffect = await claimSideEffect({ projectId: task.runId, idempotencyKey: commandIdempotencyKey, operation: "local_command", target: commandLine, claimSeconds: 3600 });
        if (commandSideEffect.status !== "claimed" || !commandSideEffect.claimToken) {
          actionResults.push({ type: `local_command_side_effect_${commandSideEffect.status}`, commandLine, receipt: commandSideEffect.receipt });
          continue;
        }
        await assertLeaseOwned();
        let commandResult;
        try {
          const serializationResource = commandSerializationResource(commandLine, localProjectRootUri);
          const executeCommand = () => executeAllowedCommand({ commandLine, cwd: localProjectRootUri, project });
          commandResult = serializationResource
            ? await withProjectExecutionLock({ projectRootUri: task.projectRootUri, resource: serializationResource }, executeCommand)
            : await executeCommand();
        } catch (error) {
          const rejectionArtifactUri = await recordRunAction({
            runId: task.runId,
            taskId: task.taskId,
            agentId: task.agentId,
            actionType: "local_command_rejected",
            target: commandLine,
            summary: error instanceof Error ? error.message : String(error),
            artifactKind: "action_rejection",
            artifactContent: {
              actionType: "local_command",
              target: commandLine,
              error: error instanceof Error ? error.message : String(error),
              requestedByTaskId: task.taskId,
              requestedByStageId: task.stageId
            }
          });
          actionResults.push({
            type: "local_command_rejected",
            commandLine,
            artifactUri: rejectionArtifactUri,
            error: error instanceof Error ? error.message : String(error)
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
              error: error instanceof Error ? error.message : String(error)
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
          throw new Error(`Requested command failed: ${commandLine}`);
        }
      }
      for (const fileWrite of output.requestedFileWrites ?? []) {
        await assertLeaseOwned();
        reactIteration += 1;
        const fileWriteIdempotencyKey = actionIdempotencyKey({
          taskId: task.taskId,
          stageId: task.stageId,
          agentId: task.agentId,
          actionType: "file_write",
          target: fileWrite.path,
          payload: fileWrite.content
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
            payloadHash: hashText(fileWrite.content),
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
        if (project.policies.require_approval_for_external_actions && !isInternalWorkflowReceiptWrite(fileWrite.path)) {
          try {
            assertFileWriteAllowed(fileWrite.path, fileWrite.content, project);
          } catch (error) {
            const rejectionArtifactUri = await recordRunAction({
              runId: task.runId,
              taskId: task.taskId,
              agentId: task.agentId,
              actionType: "file_write_rejected",
              target: fileWrite.path,
              summary: error instanceof Error ? error.message : String(error),
              artifactKind: "action_rejection",
              artifactContent: {
                actionType: "file_write",
                target: fileWrite.path,
                error: error instanceof Error ? error.message : String(error),
                requestedByTaskId: task.taskId,
                requestedByStageId: task.stageId
              }
            });
            actionResults.push({
              type: "file_write_rejected",
              path: fileWrite.path,
              artifactUri: rejectionArtifactUri,
              error: error instanceof Error ? error.message : String(error)
            });
            await recordBoundedReactLoopReceipt({
              task,
              stagePattern,
              iteration: reactIteration,
              totalRequestedActions,
              actionType: "file_write",
              target: fileWrite.path,
              payloadHash: hashText(fileWrite.content),
              policyDecision: {
                status: "rejected",
                approvalRequired: false,
                allowedByPolicy: false,
                policyProfile: project.execution.policy_profile
              },
              resultReceipt: {
                status: "rejected",
                artifactUri: rejectionArtifactUri,
                error: error instanceof Error ? error.message : String(error)
              }
            });
            continue;
          }
          fileWriteApprovalRule = evaluateActionApprovalRule({
            project,
            actionType: "file_write",
            target: fileWrite.path,
            bytes: Buffer.byteLength(fileWrite.content, "utf8")
          }) ?? evaluateActionRiskAutoApproval({
            project,
            actionType: "file_write",
            target: fileWrite.path,
            bytes: Buffer.byteLength(fileWrite.content, "utf8")
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
                bytes: Buffer.byteLength(fileWrite.content, "utf8"),
                payloadHash: hashText(fileWrite.content)
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
              payloadHash: hashText(fileWrite.content),
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

        const fileSideEffect = await claimSideEffect({ projectId: task.runId, idempotencyKey: fileWriteIdempotencyKey, operation: "file_write", target: fileWrite.path, claimSeconds: 3600 });
        if (fileSideEffect.status !== "claimed" || !fileSideEffect.claimToken) {
          actionResults.push({ type: `file_write_side_effect_${fileSideEffect.status}`, path: fileWrite.path, receipt: fileSideEffect.receipt });
          continue;
        }
        await assertLeaseOwned();
        let writeResult;
        try {
          writeResult = await executeAllowedFileWrite({
            relativePath: fileWrite.path,
            content: fileWrite.content,
            cwd: localProjectRootUri,
            project
          });
        } catch (error) {
          const rejectionArtifactUri = await recordRunAction({
            runId: task.runId,
            taskId: task.taskId,
            agentId: task.agentId,
            actionType: "file_write_rejected",
            target: fileWrite.path,
            summary: error instanceof Error ? error.message : String(error),
            artifactKind: "action_rejection",
            artifactContent: {
              actionType: "file_write",
              target: fileWrite.path,
              error: error instanceof Error ? error.message : String(error),
              requestedByTaskId: task.taskId,
              requestedByStageId: task.stageId
            }
          });
          actionResults.push({
            type: "file_write_rejected",
            path: fileWrite.path,
            artifactUri: rejectionArtifactUri,
            error: error instanceof Error ? error.message : String(error)
          });
          await recordBoundedReactLoopReceipt({
            task,
            stagePattern,
            iteration: reactIteration,
            totalRequestedActions,
            actionType: "file_write",
            target: fileWrite.path,
            payloadHash: hashText(fileWrite.content),
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
              error: error instanceof Error ? error.message : String(error)
            }
          });
          continue;
        }
        const summary = [
          `Wrote ${writeResult.bytesWritten} bytes to \`${writeResult.relativePath}\`.`,
          writeResult.existed ? "Updated existing file." : "Created new file."
        ].join(" ");
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
            requestedByTaskId: task.taskId,
            requestedByStageId: task.stageId
          },
          idempotencyKey: fileWriteIdempotencyKey
        });
        const fileWriteFinalized = await finalizeSideEffect({ projectId: task.runId, idempotencyKey: fileWriteIdempotencyKey, claimToken: fileSideEffect.claimToken, receipt: { artifactUri, path: writeResult.relativePath, nextHash: writeResult.nextHash } });
        if (!fileWriteFinalized) throw new Error(`File-write side-effect claim could not be finalized for ${fileWrite.path}.`);
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
          payloadHash: hashText(fileWrite.content),
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
      const incompleteActions = actionResults.filter((action) => {
        const type = typeof action === "object" && action && "type" in action ? String(action.type) : "";
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
      clearInterval(leaseHeartbeat);
      result.completed += 1;
    } catch (error) {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
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
      result.failed += 1;
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    }
  }

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
  const result: WorkerResult = { claimed: 0, completed: 0, failed: 0 };
  let remaining = limit;
  const runLane = async (): Promise<void> => {
    while (remaining > 0) {
      remaining -= 1;
      const tick = await runWorkerOnce(1, options);
      result.claimed += tick.claimed;
      result.completed += tick.completed;
      result.failed += tick.failed;
      if (tick.claimed === 0) {
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, runLane));
  return result;
}

type StagePattern = NonNullable<StageExecutionInput["stagePattern"]>;

export function commandFailureIsDiagnosticEvidence(stagePattern: Pick<StagePattern, "type">): boolean {
  return stagePattern.type === "planner" || stagePattern.type === "react";
}

export function commandFailurePrecedesGovernedWrites(
  stagePattern: Pick<StagePattern, "type">,
  output: Pick<StageExecutionOutput, "requestedFileWrites">
): boolean {
  return stagePattern.type === "executor" && (output.requestedFileWrites?.length ?? 0) > 0;
}

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
  actionType: "local_command" | "file_write";
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

export async function runWorkerWatch(input: {
  limitPerTick: number;
  intervalMs: number;
  workerId?: string;
  leaseSeconds?: number;
  projectRootUri?: string;
  concurrency?: number;
  providerIds?: string[];
  shouldStop: () => boolean;
  onTick: (result: WorkerResult) => void | Promise<void>;
}): Promise<void> {
  const unavailableProjectRootUris = new Set<string>();
  while (!input.shouldStop()) {
    const result = await runWorkerOnce(input.limitPerTick, {
      workerId: input.workerId,
      leaseSeconds: input.leaseSeconds,
      projectRootUri: input.projectRootUri,
      concurrency: input.concurrency,
      providerIds: input.providerIds,
      unavailableProjectRootUris
    });
    await input.onTick(result);
    await sleep(input.intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
