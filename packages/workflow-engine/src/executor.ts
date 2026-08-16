import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { executeAllowedCommand } from "../../local-tools/src/command-executor.js";
import { executeAllowedFileWrite } from "../../local-tools/src/file-writer.js";
import { providerFromEnv } from "../../model-providers/src/index.js";
import { scoreStageOutput } from "../../model-providers/src/quality.js";
import { selectModelRoute } from "../../model-providers/src/routing.js";
import {
  claimNextWorkflowTask,
  completeWorkflowTask,
  failWorkflowTask,
  recordRunAction
} from "../../storage/src/postgres.js";

export interface WorkerResult {
  claimed: number;
  completed: number;
  failed: number;
}

export async function runWorkerOnce(limit: number): Promise<WorkerResult> {
  const result: WorkerResult = {
    claimed: 0,
    completed: 0,
    failed: 0
  };

  for (let i = 0; i < limit; i += 1) {
    const task = await claimNextWorkflowTask();
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
          agentId: task.agentId,
          actionType: "local_command",
          target: commandResult.commandLine,
          summary,
          artifactKind: "command_output",
          artifactContent: {
            ...commandResult,
            requestedByTaskId: task.taskId,
            requestedByStageId: task.stageId
          }
        });
        actionResults.push({
          commandLine,
          artifactUri,
          exitCode: commandResult.exitCode,
          timedOut: commandResult.timedOut
        });

        if (commandResult.exitCode !== 0 || commandResult.timedOut) {
          throw new Error(`Requested command failed: ${commandLine}`);
        }
      }
      for (const fileWrite of output.requestedFileWrites ?? []) {
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
          agentId: task.agentId,
          actionType: "file_write",
          target: writeResult.relativePath,
          summary,
          artifactKind: "file_write",
          artifactContent: {
            ...writeResult,
            requestedByTaskId: task.taskId,
            requestedByStageId: task.stageId
          }
        });
        actionResults.push({
          type: "file_write",
          path: writeResult.relativePath,
          artifactUri,
          bytesWritten: writeResult.bytesWritten,
          nextHash: writeResult.nextHash
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

export async function runWorkerWatch(input: {
  limitPerTick: number;
  intervalMs: number;
  shouldStop: () => boolean;
  onTick: (result: WorkerResult) => void | Promise<void>;
}): Promise<void> {
  while (!input.shouldStop()) {
    const result = await runWorkerOnce(input.limitPerTick);
    await input.onTick(result);
    await sleep(input.intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
