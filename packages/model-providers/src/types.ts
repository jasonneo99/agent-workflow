import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import type { StateDelta } from "./state-deltas.js";

export type ModelTier = "fast" | "standard" | "reasoning";

export interface StageExecutionInput {
  runId: string;
  taskId: string;
  /** Resolved local checkout used only by providers that support governed read-only inspection. */
  projectRootUri?: string;
  projectConfig: ProjectConfig;
  workflowId: string;
  workflowTask: string;
  stageId: string;
  agentId: string;
  agentName: string;
  agentPrompt: string;
  stageGoal: string;
  stagePattern?: {
    type: string;
    maxIterations?: number;
    requiresVerifier: boolean;
    promotionGate: string;
    stopConditions: string[];
  };
  compiledBrief: string;
  modelTier?: ModelTier;
  providerOverride?: string | null;
  modelOverride?: string;
  priorReceipts: Array<{
    agentId: string;
    actionType: string;
    summary: string;
  }>;
  priorStageArtifacts?: Array<{
    stageId: string;
    agentId: string;
    summary: string;
    artifact: Record<string, unknown>;
  }>;
  /** File contents fetched in earlier read rounds of this stage; appended to the prompt on re-prompt. */
  fileReads?: Array<{
    path: string;
    content: string;
    truncated: boolean;
    error?: string;
  }>;
  /** Typed state deltas recorded by the runtime this stage (AIR phase-1 spike).
   *  Folded machine state the next turn consumes instead of re-reading history. */
  stateDeltas?: StateDelta[];
  /** Relevant past context selected from the memory graph (AIR phase-3).
   *  Rendered as a PAST CONTEXT section; empty when the graph is disabled. */
  memoryContext?: string[];
}

export interface StageExecutionOutput {
  outcome?: "completed" | "blocked";
  blockedReason?: string;
  summary: string;
  artifact: Record<string, unknown>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number };
  requestedCommands?: string[];
  requestedFileWrites?: Array<{
    path: string;
    content: string;
  }>;
  requestedFileReads?: string[];
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
  check?(): Promise<{
    ready: boolean;
    details: string[];
  }>;
  executeStage(input: StageExecutionInput): Promise<StageExecutionOutput>;
  summarizeFile?(input: FileSummaryInput): Promise<FileSummaryOutput>;
}
