import type { ProjectConfig } from "../../agent-registry/src/schemas.js";

export interface StageExecutionInput {
  runId: string;
  taskId: string;
  projectConfig: ProjectConfig;
  workflowId: string;
  workflowTask: string;
  stageId: string;
  agentId: string;
  agentName: string;
  agentPrompt: string;
  stageGoal: string;
  compiledBrief: string;
  priorReceipts: Array<{
    agentId: string;
    actionType: string;
    summary: string;
  }>;
}

export interface StageExecutionOutput {
  summary: string;
  artifact: Record<string, unknown>;
  requestedCommands?: string[];
  requestedFileWrites?: Array<{
    path: string;
    content: string;
  }>;
}

export interface FileSummaryInput {
  sourceUri: string;
  content: string;
  deterministicSummary: string;
}

export interface FileSummaryOutput {
  summary: string;
  artifact: Record<string, unknown>;
}

export interface ModelProvider {
  id: string;
  executeStage(input: StageExecutionInput): Promise<StageExecutionOutput>;
  summarizeFile?(input: FileSummaryInput): Promise<FileSummaryOutput>;
}
