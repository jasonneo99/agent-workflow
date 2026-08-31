import { createHash } from "node:crypto";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { assertCommandAllowed, executeAllowedCommand } from "../../local-tools/src/command-executor.js";
import { assertFileWriteAllowed, executeAllowedFileWrite } from "../../local-tools/src/file-writer.js";
import { providerFromEnv } from "../../model-providers/src/index.js";
import { scoreStageOutput } from "../../model-providers/src/quality.js";
import { selectModelRoute } from "../../model-providers/src/routing.js";
import { evaluateActionApprovalRule, type ActionApprovalRuleMatch } from "../../policy-engine/src/index.js";
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

export async function runWorkerOnce(limit: number, options?: { workerId?: string; leaseSeconds?: number }): Promise<WorkerResult> {
  const result: WorkerResult = {
    claimed: 0,
    completed: 0,
    failed: 0
  };

  for (let i = 0; i < limit; i += 1) {
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
  shouldStop: () => boolean;
  onTick: (result: WorkerResult) => void | Promise<void>;
}): Promise<void> {
  while (!input.shouldStop()) {
    const result = await runWorkerOnce(input.limitPerTick, {
      workerId: input.workerId,
      leaseSeconds: input.leaseSeconds
    });
    await input.onTick(result);
    await sleep(input.intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
