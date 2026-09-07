import { createHash } from "node:crypto";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { assertCommandAllowed, executeAllowedCommand } from "../../local-tools/src/command-executor.js";
import { assertFileWriteAllowed, executeAllowedFileWrite } from "../../local-tools/src/file-writer.js";
import { providerFromEnv } from "../../model-providers/src/index.js";
import { scoreStageOutput } from "../../model-providers/src/quality.js";
import { selectModelRoute } from "../../model-providers/src/routing.js";
import { evaluateActionApprovalRule, type ActionApprovalRuleMatch } from "../../policy-engine/src/index.js";
import { assertExecutorRegistration, executeExecutorSnapshot, type ExecutorOperation, type ExecutorResult } from "../../executor-adapters/src/index.js";
import {
  claimNextWorkflowTask,
  completeWorkflowTask,
  findRunActionByIdempotencyKey,
  failWorkflowTask,
  recordRunAction,
  requestActionApproval
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
};

export async function runWorkerOnce(limit: number, options?: WorkerRunOptions): Promise<WorkerResult> {
  const safeLimit = Math.max(0, Math.floor(limit));
  const requestedConcurrency = Math.floor(options?.concurrency ?? 1);
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(safeLimit || 1, requestedConcurrency, 16))
    : 1;
  if (safeLimit > 1 && concurrency > 1) {
    return runWorkerOnceConcurrently(safeLimit, { ...options, concurrency: 1 }, concurrency);
  }

  const result: WorkerResult = {
    claimed: 0,
    completed: 0,
    failed: 0
  };

  for (let i = 0; i < safeLimit; i += 1) {
    const task = await claimNextWorkflowTask(options);
    if (!task) {
      break;
    }

    result.claimed += 1;

    try {
      const actionResults = [];
      const project = projectConfigSchema.parse(task.projectConfig);
      const stageInput = {
        ...task,
        projectConfig: project,
        modelTier: (task.modelTier as "fast" | "standard" | "reasoning") ?? undefined
      };
      if (task.executorSnapshot) {
        await executeBoundExecutorStage(task, project);
        result.completed += 1;
        continue;
      }
      const route = await selectModelRoute(stageInput);
      const routedStageInput = {
        ...stageInput,
        modelTier: route.modelTier
      };
      let provider = providerFromEnv(route.providerId);
      const startedAt = Date.now();
      let output = await provider.executeStage(routedStageInput);
      let quality = scoreStageOutput(routedStageInput, output);
      const fallbackProviderId = process.env.AGENTFLOW_FALLBACK_PROVIDER;
      let fallbackUsed = false;

      if (!quality.passed && fallbackProviderId && fallbackProviderId !== route.providerId) {
        provider = providerFromEnv(fallbackProviderId);
        const fallbackOutput = await provider.executeStage(routedStageInput);
        const fallbackQuality = scoreStageOutput(routedStageInput, fallbackOutput);
        if (fallbackQuality.score >= quality.score) {
          output = fallbackOutput;
          quality = fallbackQuality;
          fallbackUsed = true;
        }
      }

      await recordRunAction({
        runId: task.runId,
        agentId: task.agentId,
        actionType: "model_route",
        target: `${task.workflowId}/${task.stageId}`,
        summary: `${route.providerId}${fallbackUsed ? ` -> ${fallbackProviderId}` : ""} quality=${quality.score}`,
        artifactKind: "model_route",
        artifactContent: {
          target: `${task.workflowId}/${task.stageId}`,
          workflowId: task.workflowId,
          stageId: task.stageId,
          agentId: task.agentId,
          route,
          fallbackProviderId,
          fallbackUsed,
          latencyMs: Date.now() - startedAt,
          quality
        }
      });

      for (const commandLine of output.requestedCommands ?? []) {
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
            continue;
          }
          commandApprovalRule = evaluateActionApprovalRule({
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
            continue;
          }
        }

        let commandResult;
        try {
          commandResult = await executeAllowedCommand({
            commandLine,
            cwd: task.projectRootUri,
            project
          });
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
        actionResults.push({
          commandLine,
          artifactUri,
          exitCode: commandResult.exitCode,
          timedOut: commandResult.timedOut,
          approvalRule: commandApprovalRule ?? undefined
        });

        if (commandResult.exitCode !== 0 || commandResult.timedOut) {
          throw new Error(`Requested command failed: ${commandLine}`);
        }
      }
      for (const fileWrite of output.requestedFileWrites ?? []) {
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
          continue;
        }

        let fileWriteApprovalRule: ActionApprovalRuleMatch | null = null;
        if (project.policies.require_approval_for_external_actions) {
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
            continue;
          }
          fileWriteApprovalRule = evaluateActionApprovalRule({
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
            continue;
          }
        }

        let writeResult;
        try {
          writeResult = await executeAllowedFileWrite({
            relativePath: fileWrite.path,
            content: fileWrite.content,
            cwd: task.projectRootUri,
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
        actionResults.push({
          type: "file_write",
          path: writeResult.relativePath,
          artifactUri,
          bytesWritten: writeResult.bytesWritten,
          nextHash: writeResult.nextHash,
          approvalRule: fileWriteApprovalRule ?? undefined
        });
      }
      await completeWorkflowTask({
        taskId: task.taskId,
        runId: task.runId,
        agentId: task.agentId,
        summary: output.summary,
        artifact: {
          ...output.artifact,
          routing: {
            ...route,
            fallbackProviderId,
            fallbackUsed
          },
          quality,
          actionResults
        }
      });
      result.completed += 1;
    } catch (error) {
      await failWorkflowTask({
        taskId: task.taskId,
        runId: task.runId,
        agentId: task.agentId,
        error: error instanceof Error ? error.message : String(error)
      });
      result.failed += 1;
    }
  }

  return result;
}

async function executeBoundExecutorStage(task: Awaited<ReturnType<typeof claimNextWorkflowTask>> & {}, project: ReturnType<typeof projectConfigSchema.parse>): Promise<void> {
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
        summary: `Reused ${task.executorSnapshot.operation} result from ${previous.uri}.`,
        artifact: { executor: task.executorSnapshot, execution: previous.content.execution, actionResults: [{ type: "executor_adapter_reused", artifactUri: previous.uri, reuseArtifactUri }] }
      });
      return;
    }
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
        await completeWorkflowTask({
          taskId: task.taskId,
          runId: task.runId,
          agentId: task.agentId,
          summary: `Approval pending for ${approvalTarget}.`,
          artifact: { executor: task.executorSnapshot, actionResults: [{ type: "executor_adapter_approval_pending", approvalId: approval.approvalId, artifactUri: approval.artifactUri, status: approval.status }] }
        });
        return;
    }
    const executorApprovalRule = gated.approvalRule;
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

export function actionIdempotencyKey(input: {
  taskId: string;
  stageId: string;
  agentId: string;
  actionType: string;
  target: string;
  payload: string;
  normalizePayload?: boolean;
}): string {
  const payload = input.normalizePayload ? normalizeActionText(input.payload) : input.payload;
  return createHash("sha256")
    .update(JSON.stringify({
      taskId: input.taskId,
      stageId: input.stageId,
      agentId: input.agentId,
      actionType: input.actionType,
      target: normalizeActionText(input.target),
      payloadHash: createHash("sha256").update(payload).digest("hex")
    }))
    .digest("hex");
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
  shouldStop: () => boolean;
  onTick: (result: WorkerResult) => void | Promise<void>;
}): Promise<void> {
  while (!input.shouldStop()) {
    const result = await runWorkerOnce(input.limitPerTick, {
      workerId: input.workerId,
      leaseSeconds: input.leaseSeconds,
      projectRootUri: input.projectRootUri,
      concurrency: input.concurrency
    });
    await input.onTick(result);
    await sleep(input.intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
