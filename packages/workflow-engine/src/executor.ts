import { createHash } from "node:crypto";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { assertCommandAllowed, executeAllowedCommand } from "../../local-tools/src/command-executor.js";
import { assertFileWriteAllowed, executeAllowedFileWrite } from "../../local-tools/src/file-writer.js";
import { providerFromEnv } from "../../model-providers/src/index.js";
import { scoreStageOutput } from "../../model-providers/src/quality.js";
import { selectModelRoute } from "../../model-providers/src/routing.js";
import type { StageExecutionInput } from "../../model-providers/src/types.js";
import { evaluateActionApprovalRule, type ActionApprovalRuleMatch } from "../../policy-engine/src/index.js";
import { resolveLocalProjectPath } from "../../runtime-root/src/index.js";
import {
  claimNextWorkflowTask,
  completeWorkflowTask,
  findRunActionByIdempotencyKey,
  failWorkflowTask,
  recordRunAction,
  requestActionApproval,
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
      const localProjectRootUri = (await resolveLocalProjectPath(task.projectRootUri)).localRootUri;
      const stagePattern = normalizeStagePattern(task.stagePattern);
      const stageInput = {
        ...task,
        stagePattern,
        projectConfig: project,
        modelTier: (task.modelTier as "fast" | "standard" | "reasoning") ?? undefined
      };
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
          stagePattern,
          quality
        }
      });

      const totalRequestedActions = (output.requestedCommands?.length ?? 0) + (output.requestedFileWrites?.length ?? 0);
      let reactIteration = 0;
      for (const commandLine of output.requestedCommands ?? []) {
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

        let commandResult;
        try {
          commandResult = await executeAllowedCommand({
            commandLine,
            cwd: localProjectRootUri,
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

        if (commandResult.exitCode !== 0 || commandResult.timedOut) {
          throw new Error(`Requested command failed: ${commandLine}`);
        }
      }
      for (const fileWrite of output.requestedFileWrites ?? []) {
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

export function buildBoundedReactLoopReceiptContent(input: {
  task: Pick<ClaimedWorkflowTask, "runId" | "taskId" | "workflowId" | "workflowTask" | "stageId" | "stageGoal" | "agentId">;
  stagePattern: StagePattern;
  iteration: number;
  totalRequestedActions: number;
  actionType: "local_command" | "file_write";
  target: string;
  payloadHash: string;
  policyDecision: Record<string, unknown>;
  resultReceipt: Record<string, unknown>;
}): Record<string, unknown> {
  const maxIterations = input.stagePattern.maxIterations ?? Math.max(input.totalRequestedActions, 1);
  const overBudget = input.iteration > maxIterations;
  const stopReason = overBudget
    ? "max_iterations_exceeded"
    : input.iteration >= input.totalRequestedActions
      ? "provider_returned_no_more_actions"
      : "next_action_requested";

  return {
    kind: "agentflow_bounded_react_loop_receipt",
    workflowId: input.task.workflowId,
    stageId: input.task.stageId,
    taskId: input.task.taskId,
    agentId: input.task.agentId,
    goal: input.task.stageGoal || input.task.workflowTask,
    observationSource: "compiled_brief_and_prior_stage_receipts",
    iteration: input.iteration,
    maxIterations,
    overBudget,
    actionRequested: {
      type: input.actionType,
      target: input.target,
      payloadHash: input.payloadHash
    },
    policyDecision: input.policyDecision,
    resultReceipt: input.resultReceipt,
    stopReason,
    configuredStopConditions: input.stagePattern.stopConditions,
    promotionGate: input.stagePattern.promotionGate,
    verifierRequired: input.stagePattern.requiresVerifier
  };
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
