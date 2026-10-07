import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import type { StateDelta } from "./state-deltas.js";

export type ModelTier = "fast" | "standard" | "reasoning";

export type AcceptanceGate = "implementation" | "verification" | "packaging" | "supervision";
export type DeliverableStatus = "pending" | "delivered" | "verified" | "failed" | "blocked";

/** References are claims until the runtime resolves their governed artifacts. */
export interface AcceptanceReceiptReference {
  artifactUri: string;
  runId: string;
  taskId: string;
  stageId: string;
  kind: "file_write" | "command_output" | "acceptance_audit";
  contentHash: string;
  observedAt: string;
  subjectHash: string;
}

export interface AcceptanceDeliverable {
  id: string;
  description: string;
  /** Only explicitly advisory criteria may warn or inform instead of blocking. */
  advisory?: boolean;
  severity?: "block" | "warn" | "info";
  requiredGates: AcceptanceGate[];
  status: DeliverableStatus;
  receipts: Partial<Record<AcceptanceGate, AcceptanceReceiptReference[]>>;
  gaps: string[];
}

/** Persisted separately from narrative completion and provider quality scores. */
export interface StructuredAcceptanceContract {
  /** Exact approved source scope for runtime-generated command provenance. */
  sourcePaths?: string[];
  version: 1;
  contractId: string;
  projectId: string;
  originRunId: string;
  taskHash: string;
  subjectHash: string;
  deliverables: AcceptanceDeliverable[];
}

export interface StageExecutionInput {
  runId: string;
  taskId: string;
  /** Governed run snapshot; provider output cannot replace this contract. */
  acceptanceContract?: StructuredAcceptanceContract;
  /** Runtime task graph, excluding this stage and completed/cancelled tasks. */
  remainingStageIds?: string[];
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
    /** Full-file digest, even when the policy-limited content is truncated. */
    sha256?: string;
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
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    costSource?: "provider-reported" | "catalog-estimate" | "unavailable";
    pricingVersion?: string;
  };
  requestedCommands?: string[];
  requestedFileWrites?: Array<{
    path: string;
    content?: string | null;
    patch?: string | null;
    expectedHash?: string | null;
  }>;
  requestedFileReads?: string[];
  requestedFileSearches?: string[];
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
