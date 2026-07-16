import type { FileSummaryInput, FileSummaryOutput, ModelProvider, StageExecutionInput, StageExecutionOutput } from "./types.js";

export class MockProvider implements ModelProvider {
  id = "mock";

  async executeStage(input: StageExecutionInput): Promise<StageExecutionOutput> {
    const summary = `${input.agentName} completed stage ${input.stageId} for workflow ${input.workflowId}.`;
    const requestedCommands = parseMockRequestedCommands(input.workflowTask);
    const requestedFileWrites = parseMockRequestedFileWrites(input.workflowTask);

    return {
      summary,
      requestedCommands,
      requestedFileWrites,
      artifact: {
        provider: this.id,
        runId: input.runId,
        taskId: input.taskId,
        workflowId: input.workflowId,
        workflowTask: input.workflowTask,
        stageId: input.stageId,
        agentId: input.agentId,
        agentName: input.agentName,
        stageGoal: input.stageGoal,
        compiledBriefAvailable: input.compiledBrief.length > 0,
        priorReceiptCount: input.priorReceipts.length,
        summary,
        nextAction: "Advance to the next queued stage.",
        requestedCommands,
        requestedFileWrites
      }
    };
  }

  async summarizeFile(input: FileSummaryInput): Promise<FileSummaryOutput> {
    return {
      summary: input.deterministicSummary,
      artifact: {
        provider: this.id,
        sourceUri: input.sourceUri,
        refined: false
      }
    };
  }
}

function parseMockRequestedCommands(task: string): string[] {
  const matches = [...task.matchAll(/\[request-command:([^\]]+)\]/g)];
  return matches.map((match) => match[1].trim()).filter(Boolean);
}

function parseMockRequestedFileWrites(task: string): Array<{ path: string; content: string }> {
  const matches = [...task.matchAll(/\[write-file:([^:\]]+)::([^\]]*)\]/g)];
  return matches
    .map((match) => ({
      path: match[1].trim(),
      content: match[2]
    }))
    .filter((write) => write.path.length > 0);
}
