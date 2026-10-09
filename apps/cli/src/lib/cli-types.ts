import type { WorkflowGraphReport } from "../../../../packages/workflow-inspector/src/index.js";
import type { CliContext } from "./context.js";
import { type AgentCard, type ProjectConfig } from "../../../../packages/agent-registry/src/schemas.js";
import { type ConversationRequest, type classifyConversationIntent } from "../../../../packages/conversation-contract/src/index.js";
import { type DaemonTrustSettings } from "../../../../packages/daemon-control/src/index.js";
import { type FailureTriageRisk } from "../../../../packages/failure-triage/src/index.js";
import { type LearningApplicationAction, type LearningProposalPriority, type LearningRiskLevel } from "../../../../packages/learning-governance/src/index.js";
import { type LocalRoutingFeedbackRating, type LocalRoutingRecommendation } from "../../../../packages/model-providers/src/local-routing-recommendations.js";
import { type ModelTier } from "../../../../packages/model-providers/src/types.js";
import { type RoadmapSuggestionReport } from "../../../../packages/roadmap-planner/src/index.js";
import { type CandidateComparisonPlan, type CandidateVariantPlan, type CostQualityReport, type ModelImprovementPlan } from "../../../../packages/run-reporter/src/index.js";
import type { checkServices } from "../../../../packages/storage/src/doctor.js";
import type { listActionApprovals, listProjectStorageSummaries, listWorkflowRuns, reconcileStaleTerminalWorkflowRuns, listWorkflowStageRunsForRuns, listWorkflowHandoffs, listWorkflowStageHealthForRuns } from "../../../../packages/storage/src/postgres.js";
import { type TrainingDiscoveryReport } from "../../../../packages/training-discovery/src/index.js";
import path from "node:path";

export type AgentImprovementCandidate = {
  id: string;
  agentId: string;
  displayName: string;
  scope: "shared" | "project-local";
  category: AgentCard["category"];
  priority: LearningProposalPriority;
  riskLevel: LearningRiskLevel;
  sourcePath: string;
  currentRoleSummary: string;
  evidence: string[];
  recommendation: string;
  suggestedMutableFields: Array<"purpose" | "use_when" | "avoid_when" | "can" | "cannot" | "requires_approval" | "context_budget" | "outputs" | "prompt">;
  safeResearchQueries: string[];
  validationPlan: string[];
  autoApplyEligible: boolean;
  approvalRequired: boolean;
  patternId: string;
  outcomeWeight: number;
  outcomeEvidence: { approvals: number; rejections: number } | null;
};

export type AgentImprovementEval = {
  id: string;
  patchId: string;
  candidateId: string;
  agentId: string;
  displayName: string;
  scope: "shared" | "project-local";
  sourcePath: string;
  priority: LearningProposalPriority;
  riskLevel: LearningRiskLevel;
  score: number;
  status: "pass" | "warn" | "fail";
  promotionReady: boolean;
  autoApplyReady: boolean;
  holdoutTasks: Array<{
    runId: string;
    workflowId: string;
    task: string;
    status: string;
    startedAt: string;
    evidence: string;
  }>;
  gates: Array<{
    id: string;
    passed: boolean;
    weight: number;
    message: string;
  }>;
  rollback: AgentImprovementPatch["rollback"] & {
    sourceHashCurrent: boolean;
  };
  recommendation: string;
};

export type AgentImprovementEvalPlan = {
  kind: "agentflow_agent_improvement_eval_plan";
  generatedAt: string;
  projectRootUri: string;
  sourcePatchPlanGeneratedAt: string;
  selectedIds: string[];
  skippedIds: string[];
  evaluations: AgentImprovementEval[];
  summary: string[];
  promotionPolicy: {
    passThreshold: number;
    autoApplyThreshold: number;
    minimumHoldoutTasks: number;
    maxRiskForAutoApply: LearningRiskLevel;
  };
  ownedLearningFiles: string[];
};

export type AgentImprovementOutcomeWeight = {
  weight: number;
  approvals: number;
  rejections: number;
};

export type AgentImprovementPatch = {
  id: string;
  candidateId: string;
  agentId: string;
  displayName: string;
  scope: "shared" | "project-local";
  sourcePath: string;
  sourceHash: string;
  priority: LearningProposalPriority;
  riskLevel: LearningRiskLevel;
  approvalRequired: boolean;
  autoApplyEligible: boolean;
  changedFields: AgentImprovementCandidate["suggestedMutableFields"];
  patternId: string;
  rationale: string;
  validation: {
    schemaValid: boolean;
    errors: string[];
  };
  unifiedDiff: string;
  proposedYaml: string;
  rollback: {
    restoreSourceHash: string;
    restorePath: string;
  };
};

export type AgentImprovementPatchPlan = {
  kind: "agentflow_agent_improvement_patch_plan";
  generatedAt: string;
  projectRootUri: string;
  sourceReportGeneratedAt: string;
  selectedIds: string[];
  skippedIds: string[];
  patches: AgentImprovementPatch[];
  summary: string[];
  ownedLearningFiles: string[];
};

export type AgentImprovementPromotionDecisionResult = {
  queue: AgentImprovementPromotionQueue;
  receipts: AgentImprovementPromotionReceiptLog;
  selectedIds: string[];
  skippedIds: string[];
};

export type AgentImprovementPromotionItem = {
  id: string;
  patchId: string;
  evalId: string;
  candidateId: string;
  agentId: string;
  displayName: string;
  scope: "shared" | "project-local";
  status: AgentImprovementPromotionStatus;
  createdAt: string;
  decidedAt: string | null;
  reviewer: string | null;
  note: string | null;
  score: number;
  promotionReady: boolean;
  autoApplyReady: boolean;
  priority: LearningProposalPriority;
  riskLevel: LearningRiskLevel;
  sourcePath: string;
  sourceHash: string;
  diff: string;
  rollback: AgentImprovementPatch["rollback"] & { sourceHashCurrent: boolean };
  approvalRequired: boolean;
  recommendation: string;
  rationale: string;
  patternId: string;
};

export type AgentImprovementPromotionQueue = {
  kind: "agentflow_agent_improvement_promotion_queue";
  generatedAt: string;
  updatedAt: string;
  projectRootUri: string;
  sourceEvalPlanGeneratedAt: string;
  selectedIds: string[];
  skippedIds: string[];
  summary: string[];
  items: AgentImprovementPromotionItem[];
  ownedLearningFiles: string[];
};

export type AgentImprovementPromotionReceipt = {
  id: string;
  promotionId: string;
  patchId: string;
  evalId: string;
  agentId: string;
  status: Extract<AgentImprovementPromotionStatus, "approved" | "rejected" | "deferred">;
  score: number;
  riskLevel: LearningRiskLevel;
  scope: "shared" | "project-local";
  actor: string;
  note: string;
  sourcePath: string;
  sourceHash: string;
  rollback: AgentImprovementPromotionItem["rollback"];
  createdAt: string;
  patternId: string;
};

export type AgentImprovementPromotionReceiptLog = {
  kind: "agentflow_agent_improvement_promotion_receipts";
  projectRootUri: string;
  updatedAt: string;
  events: AgentImprovementPromotionReceipt[];
};

export type AgentImprovementPromotionStatus = "pending" | "deferred" | "approved" | "rejected" | "applied" | "superseded";

export type AgentImprovementReport = {
  kind: "agentflow_agent_improvement_report";
  generatedAt: string;
  projectRootUri: string;
  limit: number;
  mode: "read-only" | "write-owned-learning-state";
  agentsAnalyzed: number;
  candidates: AgentImprovementCandidate[];
  evidenceSummary: {
    runsAnalyzed: number;
    workflowReferences: number;
    projectLocalAgents: number;
    sharedAgents: number;
    feedbackCounts: Record<string, number>;
    failedRuns: number;
  };
  ownedLearningFiles: string[];
  autonomyBoundary: {
    automatic: string[];
    approvalRequired: string[];
  };
  privacyBoundaries: string[];
  nextCommands: string[];
};

export type ApprovalAutopilotResult = {
  kind: "agentflow_approval_autopilot_result";
  generatedAt: string;
  mode: "dry-run" | "execute";
  maxRisk: ApprovalAutopilotRisk;
  scanned: number;
  approved: number;
  executed: number;
  skipped: number;
  items: Array<{
    approvalId: string;
    actionType: string;
    target: string;
    risk: ApprovalAutopilotRisk;
    status: "would_execute" | "executed" | "skipped" | "failed";
    summary: string;
    reasons: string[];
  }>;
};

export type ApprovalAutopilotRisk = "low" | "medium" | "high";

export type ApprovalBacklogCategory = "missing_tool" | "resolved_missing_tool" | "command_failed" | "ready_to_execute" | "stale_review" | "manual_decision" | "historical_info" | "needs_review";

export type ApprovalBacklogItem = {
  approvalId: string;
  status: string;
  actionType: string;
  target: string;
  runId: string;
  workflowId: string;
  stageId: string;
  agentId: string;
  projectRootUri: string;
  createdAt: string;
  updatedAt: string;
  ageMinutes: number | null;
  severity: ApprovalBacklogSeverity;
  reason: string;
  category: ApprovalBacklogCategory;
  nextAction: string;
  autopilotRisk?: ApprovalAutopilotRisk;
  autopilotEligible?: boolean;
};

export type ApprovalBacklogReport = {
  kind: "agentflow_approval_backlog_report";
  generatedAt: string;
  projectRootUri: string | null;
  statusFilter: string | null;
  staleMinutes: number;
  total: number;
  limit: number;
  truncated: boolean;
  scanned: number;
  counts: Record<string, number>;
  severityCounts: Record<ApprovalBacklogSeverity, number>;
  categoryCounts: Record<ApprovalBacklogCategory, number>;
  items: ApprovalBacklogItem[];
};

export type ApprovalBacklogSeverity = "info" | "warning" | "error";

export type ArtifactLifecycleAction = "prune" | "archive" | "restore";

export type ArtifactLifecyclePolicy = {
  source: "project" | "default";
  retentionDays: number;
  minPruneBytes: number;
  retainAuditArtifacts: boolean;
  legalHold: boolean;
  requireApprovalForPrune: boolean;
  allowArchiveExecution: boolean;
  allowRestoreExecution: boolean;
  allowPruneExecution: boolean;
};

export type DashboardActionApproval = Awaited<ReturnType<typeof listActionApprovals>>[number];

export type DashboardApprovalRuleSummary = {
  projectName: string;
  projectRootUri: string;
  configPath: string;
  id: string;
  description: string;
  actionType: "local_command" | "file_write" | "executor_adapter";
  target: string;
  functionLabel: string;
  effect: "auto_execute";
  maxBytes?: number;
};

export type DashboardCandidateComparisonReport = {
  generatedAt: string;
  projectDir: string;
  modelPlanPath: string;
  comparisonPlanPath: string;
  modelPlanExists: boolean;
  comparisonPlanExists: boolean;
  modelPlanError: string | null;
  comparisonPlanError: string | null;
  modelPlan: Omit<ModelImprovementPlan, "files"> | null;
  comparisonPlan: Omit<CandidateComparisonPlan, "files"> | null;
  suiteFiles: Array<{
    path: string;
    exists: boolean;
  }>;
  outcomes: Array<{
    suiteId: string;
    runs: number;
    leader: string | null;
    latestAt: string | null;
    baselineRuns: number;
    candidateRuns: number;
    baselineQuality: number | null;
    candidateQuality: number | null;
    qualityDelta: number | null;
    baselineLatencyMs: number | null;
    candidateLatencyMs: number | null;
    latencyDeltaMs: number | null;
    gateReady: boolean;
  }>;
  promotionRecommendations: Array<{
    suiteId: string;
    decision: "keep_baseline" | "run_more_evals" | "propose_routing_note";
    severity: "info" | "warning" | "ready";
    rationale: string[];
    nextAction: string;
  }>;
  promotionNoteFiles: DashboardPromotionNoteFileSummary[];
  localHoldoutRouting: DashboardLocalHoldoutRoutingStatus;
  routeReceiptTrends: DashboardRouteReceiptTrendReport;
  readiness: string[];
  nextCommands: string[];
};

export type DashboardEvaluationRun = {
  runId: string;
  projectRootUri: string;
  suiteId: string;
  suiteName: string;
  caseId: string;
  variantId: string;
  workflowId: string;
  provider: string;
  modelTier: string;
  status: string;
  averageQuality: number | null;
  totalLatencyMs: number;
  fallbackCount: number;
  estimatedCostMix: Record<string, number>;
  feedback: string | null;
  startedAt: string;
};

export type DashboardEvaluationSuite = {
  id: string;
  name: string;
  workflowId: string;
  runs: DashboardEvaluationRun[];
  variants: DashboardEvaluationVariant[];
  leader: string | null;
  latestAt: string;
};

export type DashboardEvaluationVariant = {
  id: string;
  provider: string;
  modelTier: string;
  runs: number;
  completed: number;
  averageQuality: number | null;
  averageLatencyMs: number | null;
  fallbackRate: number;
  estimatedCostMix: Record<string, number>;
  feedbackCounts: Record<string, number>;
};

export type DashboardFeedbackBucket = "probably_accept" | "probably_revise" | "probably_reject";

export type DashboardFeedbackClassification = {
  bucket: DashboardFeedbackBucket;
  reason: string;
};

export type DashboardFeedbackInboxItem = DashboardFeedbackTarget & {
  classification: DashboardFeedbackClassification;
};

export type DashboardFeedbackInboxReport = {
  generatedAt: string;
  projectRootUri: string | null;
  limit: number;
  totalCandidates: number;
  totalTargets: number;
  counts: Record<DashboardFeedbackBucket, number>;
  groups: Record<DashboardFeedbackBucket, DashboardFeedbackInboxItem[]>;
};

export type DashboardFeedbackTarget = {
  runId: string;
  workflowId: string;
  status: string;
  task: string;
  startedAt: string;
  finishedAt: string | null;
  provider: string | null;
  modelTier: string | null;
  summary: {
    completedTasks: number;
    failedTasks: number;
    totalTasks: number;
    keyFindings: string[];
    failures: string[];
    recommendedNextAction: string;
  } | null;
  quality: {
    averageQuality: number | null;
    qualityPassCount: number;
    qualityFailCount: number;
    fallbackCount: number;
    averageLatencyMs: number | null;
  } | null;
};

export type DashboardFollowUpResult =
  | { ok: true; title: string; output: string; runId?: string; redirectToRun?: boolean }
  | { ok: false; error: string };

export type DashboardInfo = {
  app: {
    name: string;
    version: string;
    rootDir: string;
    dashboardUrl: string;
  };
  provider: {
    selected: string;
    adapter: string;
    model?: string;
    modelEnv?: string;
    baseUrl?: string;
    apiKeyConfigured?: boolean;
    authStatus?: string;
    awsProfile?: string;
    canSelectModel: boolean;
    availableModels: string[];
    availableModelsError?: string;
    tierModels?: Array<{
      tier: string;
      model: string;
      source: "env" | "catalog" | "unavailable";
    }>;
    catalogHint?: string;
    autoRoutes?: Array<{
      tier: string;
      providerId: string;
      estimatedCostTier: string;
      reason: string;
    }>;
    providerStatuses?: Array<{
      providerId: string;
      label: string;
      configured: boolean;
      status: "ready" | "missing" | "not configured";
      model?: string;
      baseUrl?: string;
      apiKeyStatus?: string;
      awsProfile?: string;
      awsRegion?: string;
      details: string[];
      tierModels?: Array<{
        tier: string;
        model: string;
        source: "env" | "catalog" | "unavailable";
      }>;
    }>;
    routingConfig: {
      provider: string;
      autoProviders: string;
      fastProvider: string;
      standardProvider: string;
      reasoningProvider: string;
      fallbackProvider: string;
      qualityThreshold: string;
      modelPolicy: string;
    };
  };
  services: Array<{
    name: string;
    reachable: boolean;
    message: string;
    requiredFor: string;
  }>;
  registry: {
    agents: number;
    workflows: number;
  };
  bundle: {
    version: string;
    checksum: string;
    files: number;
    source: string;
  } | null;
  storage: {
    databaseUrlConfigured: boolean;
    redisUrlConfigured: boolean;
    objectStorageConfigured: boolean;
  };
  worker: DashboardWorkerStatus;
  supervisor: DashboardSupervisorStatus;
  launchAgent: DashboardLaunchAgentStatus;
  runtimeMonitor: RuntimeMonitorReport;
  commands: string[];
};

export type DashboardLaunchAgentStatus = {
  platform: string;
  supported: boolean;
  label: string;
  plistPath: string;
  installed: boolean;
  status: "running" | "installed" | "missing" | "unavailable" | "error";
  pid: number | null;
  runs: number | null;
  stdoutPath: string;
  stderrPath: string;
  stdoutExists: boolean;
  stderrExists: boolean;
  lastError: string;
  installCommand: string;
  uninstallCommand: string;
};

export type DashboardLearningDaemonStatus = {
  heartbeatPath: string;
  configured: boolean;
  projectPathExists: boolean;
  projectRootUri: string;
  daemonId: string | null;
  mode: LearningDaemonMode | null;
  status: "running" | "stale" | "stopped" | "missing" | "failed";
  pid: number | null;
  processAlive: boolean;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastReportAt: string | null;
  ageMs: number | null;
  intervalMs: number | null;
  limit: number | null;
  ticks: number;
  proposals: number;
  roadmapSnapshotStatus: RoadmapSnapshotPublication["status"] | null;
  roadmapSnapshotPublishedAt: string | null;
  roadmapSnapshotDigest: string | null;
  inboxItems: number;
  applicationActions: number;
  autonomousAppliedActions: number;
  autonomousApplyMaxRisk: LearningRiskLevel;
  agentImprovementCandidates: number;
  agentImprovementPatchPreviews: number;
  agentImprovementEvalPasses: number;
  agentImprovementPromotions: number;
  agentImprovementPromotionPending: number;
  agentImprovementApplied: number;
  agentImprovementApplySkipped: number;
  workflowShapeRecommendations?: number;
  workflowShapeAutoUpdate?: boolean;
  approvalAutopilotEnabled: boolean;
  approvalAutopilotMaxRisk: ApprovalAutopilotRisk;
  approvalAutopilotExecuted: number;
  approvalAutopilotSkipped: number;
  approvalBacklogWarnings: number;
  approvalBacklogErrors: number;
  approvalBacklogScanned: number;
  mcpCleanupEnabled: boolean;
  mcpCleanupMode: RuntimeMonitorReport["mcpCleanup"]["autoCleanup"]["mode"];
  mcpCleanupStaleMinutes: number;
  mcpCleanupCandidates: number;
  mcpCleanupAutoCleanable: number;
  mcpCleanupTerminated: number;
  mcpCleanupWarnings: number;
  lastMcpCleanupAt: string | null;
  staleRunReconcileEnabled: boolean;
  staleRunReconcileCandidates: number;
  staleRunReconciled: number;
  lastStaleRunReconcileAt: string | null;
  trainingDiscoveryStatus: TrainingDiscoveryReport["status"] | null;
  trainingDiscoveryLastRunAt: string | null;
  trainingDiscoveryNextRunAfter: string | null;
  trainingDiscoveryProposals: number;
  trainingDiscoveryErrors: number;
  lastError: string;
  command: string;
};

export type DashboardLocalHoldoutRoutingStatus = {
  status: "not-started" | "needs-evidence" | "needs-promotion" | "blocked" | "approved" | "active" | "error";
  generatedAt: string;
  projectRootUri: string;
  resultsPath: string;
  promotionPath: string;
  resultsExists: boolean;
  promotionExists: boolean;
  resultsDecision: LocalHoldoutResultSummary["decision"] | null;
  promotionStatus: LocalHoldoutRoutingPromotion["status"] | null;
  approved: boolean;
  maxRisk: "low" | null;
  evidenceSuites: string[];
  thresholdSummary: string | null;
  evidenceSummary: string | null;
  promotableSuites: string[];
  localStageCount: number;
  hostedStageCount: number;
  localFallbackRate: number | null;
  hostedFallbackBoundary: string;
  recommendation: string;
  error: string | null;
};

export type DashboardLocalLlmRoutingDecisionTimeline = {
  generatedAt: string;
  projectRootUri: string;
  status: "recommended" | "planned" | "active" | "monitoring";
  sourceRecommendationGeneratedAt: string;
  sourceNotePlanGeneratedAt: string | null;
  sourceApplicationGeneratedAt: string | null;
  summary: string[];
  items: DashboardLocalLlmRoutingDecisionTimelineItem[];
};

export type DashboardLocalLlmRoutingDecisionTimelineItem = {
  recommendationId: string;
  state: "recommended" | "planned" | "applied" | "skipped" | "monitoring";
  action: LocalLlmRoutingRecommendation["action"];
  priority: LocalLlmRoutingRecommendation["priority"];
  target: string;
  agentId: string;
  noteId: string | null;
  routeClass: DashboardRouteReceiptTrendGroup["classification"];
  providerTier: string;
  runs: number;
  fallbackRate: number;
  quality: number | null;
  netSavingsUsd: number;
  outcome: string;
};

export type DashboardLocalLlmRoutingNoteApplicationStatus = {
  exists: boolean;
  path: ".agent-workflow/tuning/local-routing-note-application.json";
  targetFile: ".agent-workflow/tuning/routing-preferences.md";
  generatedAt: string | null;
  sourcePlanGeneratedAt: string | null;
  approved: boolean;
  selectedNoteIds: string[];
  appliedNoteIds: string[];
  skippedNoteIds: string[];
  beforeHash: string | null;
  afterHash: string | null;
  rollback: string | null;
  activePreferenceExists: boolean;
  activePreferenceBytes: number;
  activePreferenceHash: string | null;
  activePreferencePreview: string | null;
  activeLocalRoutingNoteMarkers: number;
  error: string | null;
};

export type DashboardLocalProviderEvidence = {
  status: "not-configured" | "needs-runs" | "watch" | "candidate" | "ready";
  configured: boolean;
  providerIds: string[];
  localStageCount: number;
  hostedStageCount: number;
  localAccepted: number;
  localRevised: number;
  localRejected: number;
  localFallbackRate: number | null;
  localAverageLatencyMs: number | null;
  localAverageQuality: number | null;
  hostedAverageLatencyMs: number | null;
  hostedAverageQuality: number | null;
  estimatedAvoidedHostedCalls: number;
  recommendation: string;
};

export type DashboardProjectAliasMergeGroup = {
  canonicalRootUri: string;
  target: DashboardProjectAliasMergeProject;
  sources: DashboardProjectAliasMergeProject[];
  impactedRows: {
    projectRows: number;
    workflowRuns: number;
    activeRuns: number;
    failedRuns: number;
    projectFiles: number;
    memoryItems: number;
    indexedTokens: number;
    indirectRunArtifacts: string;
  };
  risk: "low" | "medium" | "high";
  conflictWarnings: string[];
  preflightChecks: string[];
  rollbackOutline: string[];
};

export type DashboardProjectAliasMergePlan = {
  kind: "agentflow_project_alias_merge_plan";
  generatedAt: string;
  dryRun: true;
  identityCount: number;
  projectCount: number;
  candidateCount: number;
  sourceProjectCount: number;
  groups: DashboardProjectAliasMergeGroup[];
  summary: string[];
};

export type DashboardProjectAliasMergeProject = {
  id: string;
  name: string;
  rootUri: string;
  profile: string;
  indexedFiles: number;
  indexedTokens: number;
  memoryItems: number;
  runCount: number;
  completedRuns: number;
  failedRuns: number;
  activeRuns: number;
  lastRunAt: string | null;
};

export type DashboardProjectIdentityGroup = {
  canonicalRootUri: string;
  primaryRootUri: string;
  canonicalName: string;
  localPathExists: boolean;
  source: DashboardProjectPathResolution["source"];
  visibility: "canonical" | "supporting";
  projects: DashboardProjectSummary[];
  totalRuns: number;
  totalIndexedFiles: number;
  totalMemoryItems: number;
  activeRuns: number;
  failedRuns: number;
  lastRunAt: string | null;
  aliases: Array<{
    rootUri: string;
    mapped: boolean;
    source: DashboardProjectPathResolution["source"];
  }>;
};

export type DashboardProjectPathResolution = {
  storageRootUri: string;
  localRootUri: string;
  localPathExists: boolean;
  mapped: boolean;
  source: "exact" | "env" | "mac-home" | "linux-home" | "projects-basename" | "missing";
  note: string;
};

export type DashboardProjectSummary = Awaited<ReturnType<typeof listProjectStorageSummaries>>[number];

export type DashboardPromotionNoteFileSummary = {
  path: string;
  exists: boolean;
  bytes: number;
  modifiedAt: string | null;
  preview: string | null;
  error: string | null;
};

export type DashboardPromotionRoutingNotePlan = {
  kind: "agentflow_promotion_routing_note_plan";
  projectRootUri: string;
  generatedAt: string;
  sourceComparisonPlanGeneratedAt: string | null;
  selectedSuiteIds: string[];
  skippedSuiteIds: string[];
  notes: Array<{
    suiteId: string;
    workflowId: string;
    baseline: CandidateVariantPlan | null;
    candidate: CandidateVariantPlan | null;
    qualityDelta: number | null;
    latencyDeltaMs: number | null;
    gateCommand: string | null;
    rationale: string[];
    draftNote: string;
  }>;
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type DashboardRoleAuditExportSummary = {
  jsonPath: string;
  markdownPath: string | null;
  fileName: string;
  generatedAt: string;
  projectPath: string | null;
  role: string | null;
  status: string;
  actionType: string | null;
  approvalCount: number;
  projectCount: number;
  roleCount: number;
};

export type DashboardRoleDecisionSummary = {
  role: string;
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  executed: number;
  failed: number;
  other: number;
};

export type DashboardRoleGovernanceReport = {
  kind: "agentflow_role_governance_report";
  generatedAt: string;
  projectRootUri: string | null;
  limit: number;
  filters: {
    role: string | null;
    status: string;
    actionType: string | null;
  };
  projects: DashboardRoleProject[];
  statusCounts: Record<string, number>;
  actionCounts: Record<string, number>;
  decisionsByRole: DashboardRoleDecisionSummary[];
  recentApprovals: DashboardActionApproval[];
  recentRoleAuditExports: DashboardRoleAuditExportSummary[];
};

export type DashboardRoleProject = {
  id: string;
  name: string;
  rootUri: string;
  configStatus: "valid" | "missing" | "invalid";
  enforcement: "preview" | "enforce";
  separationOfDuties: "off" | "preview" | "enforce";
  defaultActorRole: string;
  roles: Array<{
    id: string;
    description: string;
    readOnly: boolean;
    capabilities: string[];
  }>;
};

export type DashboardRouteReceiptTrendGroup = {
  workflowId: string;
  stageId: string;
  agentId: string;
  providerId: string;
  modelTier: string;
  classification: "local-selected" | "local-skipped" | "hosted-fallback" | "hosted-selected";
  runs: number;
  fallbackCount: number;
  latencySamples: number;
  qualitySamples: number;
  averageLatencyMs: number | null;
  averageQuality: number | null;
  latestReason: string;
};

export type DashboardRouteReceiptTrendReport = {
  generatedAt: string;
  projectRootUri: string;
  reportsAnalyzed: number;
  totalReceipts: number;
  localSelected: number;
  localSkipped: number;
  hostedFallback: number;
  hostedSelected: number;
  fallbackRate: number | null;
  localSelectionRate: number | null;
  topGroups: DashboardRouteReceiptTrendGroup[];
};

export type DashboardRunStatus = Awaited<ReturnType<typeof listWorkflowRuns>>[number];

export type DashboardSupervisorStatus = {
  runtimeVersion: string | null;
  bundleVersion: string | null;
  protocolVersions: Partial<CliContext["protocolVersions"]> | null;
  heartbeatPath: string;
  configured: boolean;
  status: "running" | "stale" | "stopped" | "missing" | "failed";
  pid: number | null;
  processAlive: boolean;
  message: string;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  ageMs: number | null;
  ticks: number;
  dashboardPort: number | null;
  dashboardManaged: boolean;
  workerManaged: boolean;
  learningManaged: boolean;
  learningEnabled: boolean;
  learningScope: "project" | "all-projects" | null;
  learningProject: string | null;
  learningMode: LearningDaemonMode | null;
  learningHeartbeatPath: string | null;
  command: string;
};

export type DashboardWorkerLane = Omit<DashboardWorkerStatus, "lanes">;

export type DashboardWorkerStatus = {
  runtimeVersion: string | null;
  bundleVersion: string | null;
  protocolVersions: Partial<CliContext["protocolVersions"]> | null;
  heartbeatPath: string;
  configured: boolean;
  workerId: string | null;
  projectRootUri: string | null;
  concurrency: number | null;
  perProjectConcurrency: number | null;
  status: "running" | "stale" | "stopped" | "missing";
  pid: number | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  ageMs: number | null;
  limit: number | null;
  intervalMs: number | null;
  ticks: number;
  claimed: number;
  completed: number;
  failed: number;
  processAlive: boolean;
  command: string;
  providerIds?: string[];
  unavailableProviderIds?: string[];
  lanes: DashboardWorkerLane[];
};

export type FeedbackRating = "accepted" | "revised" | "rejected";

export type LearningActionReceipt = {
  id: string;
  status: LearningActionReceiptStatus;
  actionId: string;
  proposalId: string;
  planGeneratedAt: string;
  createdAt: string;
  actor: string;
  note: string;
  title: string;
  actionType: LearningApplicationAction["actionType"];
  dangerGate: LearningApplicationAction["dangerGate"];
  writesOwnedLearningStateOnly: boolean;
};

export type LearningActionReceiptCompactionResult = {
  kind: "agentflow_learning_action_receipt_compaction";
  projectRootUri: string;
  generatedAt: string;
  before: LearningActionReceiptHealth;
  after: LearningActionReceiptHealth;
  removedReceipts: number;
  backupPaths: string[];
};

export type LearningActionReceiptHealth = {
  kind: "agentflow_learning_action_receipt_health";
  projectRootUri: string;
  generatedAt: string;
  updatedAt: string;
  totalReceipts: number;
  counts: Record<string, number>;
  daemonOpenReceipts: number;
  uniqueDaemonOpenReceipts: number;
  duplicateDaemonOpenReceipts: number;
  compactableReceiptCount: number;
  latestReceiptAt: string | null;
  latestBackupPath: string | null;
  recommendation: string;
};

export type LearningActionReceiptLog = {
  kind: "agentflow_learning_action_receipts";
  projectRootUri: string;
  updatedAt: string;
  events: LearningActionReceipt[];
};

export type LearningActionReceiptStatus = "planned" | "applied" | "superseded" | "rejected";

export type LearningDaemonHeartbeat = {
  runtimeVersion: string;
  bundleVersion: string;
  protocolVersions: CliContext["protocolVersions"];
  kind: "agentflow_learning_daemon_status";
  pid: number;
  daemonId: string;
  projectRootUri: string;
  scope?: "project" | "all-projects";
  mode: LearningDaemonMode;
  status: "starting" | "running" | "stopping" | "stopped" | "failed";
  startedAt: string;
  lastHeartbeatAt: string;
  lastReportAt: string | null;
  lastError?: string;
  intervalMs: number;
  limit: number;
  ticks: number;
  proposals: number;
  roadmapPath?: string;
  roadmapStatus?: RoadmapSuggestionReport["status"];
  roadmapOpenItems?: number;
  roadmapSuggestions?: number;
  roadmapSnapshotStatus?: RoadmapSnapshotPublication["status"];
  roadmapSnapshotPublishedAt?: string | null;
  roadmapSnapshotDigest?: string;
  inboxItems: number;
  applicationActions: number;
  autonomousAppliedActions?: number;
  autonomousApplyMaxRisk?: LearningRiskLevel;
  agentImprovementCandidates?: number;
  agentImprovementPatchPreviews?: number;
  agentImprovementEvalPasses?: number;
  agentImprovementPromotions?: number;
  agentImprovementPromotionPending?: number;
  agentImprovementApplied?: number;
  agentImprovementApplySkipped?: number;
  workflowShapeRecommendations?: number;
  workflowShapeAutoUpdate?: boolean;
  approvalAutopilotEnabled?: boolean;
  approvalAutopilotMaxRisk?: ApprovalAutopilotRisk;
  approvalAutopilotExecuted?: number;
  approvalAutopilotSkipped?: number;
  approvalBacklogWarnings?: number;
  approvalBacklogErrors?: number;
  approvalBacklogScanned?: number;
  mcpCleanupEnabled?: boolean;
  mcpCleanupMode?: RuntimeMonitorReport["mcpCleanup"]["autoCleanup"]["mode"];
  mcpCleanupStaleMinutes?: number;
  mcpCleanupCandidates?: number;
  mcpCleanupAutoCleanable?: number;
  mcpCleanupTerminated?: number;
  mcpCleanupWarnings?: number;
  lastMcpCleanupAt?: string | null;
  staleRunReconcileEnabled?: boolean;
  staleRunReconcileCandidates?: number;
  staleRunReconciled?: number;
  lastStaleRunReconcileAt?: string | null;
  trainingDiscoveryStatus?: TrainingDiscoveryReport["status"];
  trainingDiscoveryLastRunAt?: string | null;
  trainingDiscoveryNextRunAfter?: string | null;
  trainingDiscoveryProposals?: number;
  trainingDiscoveryErrors?: number;
  offlineSyncStatus?: OfflineSyncSchedulerStatus | null;
  command: string;
};

export type LearningDaemonMode = "observe" | "propose" | "apply-approved";

export type LearningFailureTriageReport = {
  kind: "agentflow_learning_failure_triage";
  generatedAt: string;
  projectRootUri: string;
  observation: string;
  failedRuns: number;
  groups: Array<{
    signature: string;
    category: string;
    diagnosis: string;
    risk: FailureTriageRisk;
    runIds: string[];
    verification: string;
    verificationPassed: boolean;
    action: "retried" | "reported" | "escalated" | "retry_failed";
    detail: string;
  }>;
  retriedRuns: string[];
  withheldRuns: string[];
};

export type LearningReport = {
  kind: "agentflow_learning_report";
  generatedAt: string;
  projectDir: string;
  limit: number;
  autonomyMode: "autonomous-local";
  runsAnalyzed: number;
  runStatusCounts: Record<string, number>;
  feedbackCounts: Record<string, number>;
  routeFeedback: LearningRouteFeedbackSummary;
  evaluationRuns: number;
  latestEvaluationAt: string | null;
  failedRuns: Array<{
    runId: string;
    workflowId: string;
    task: string;
    startedAt: string;
  }>;
  repeatedFailurePatterns: Array<{
    workflowId: string;
    stageId: string;
    agentId: string;
    failedTasks: number;
    totalTasks: number;
    failureRate: number;
  }>;
  costOpportunities: Array<{
    workflowId: string;
    stageId: string;
    agentId: string;
    providerId: string;
    modelTier: string;
    runs: number;
    fallbackRate: number;
    averageLatencyMs: number | null;
    recommendation: string;
  }>;
  proposalPreview: {
    total: number;
    highPriority: number;
    byKind: Record<string, number>;
  };
  evalGaps: string[];
  safeAutomaticActions: string[];
  approvalRequiredActions: string[];
  privacyBoundaries: string[];
  nextCommands: string[];
  failureTriage?: LearningFailureTriageReport;
};

export type LearningRouteFeedbackGroup = {
  target: string;
  route: string;
  routeClass: DashboardRouteReceiptTrendGroup["classification"];
  total: number;
  helpful: number;
  costly: number;
  neutral: number;
  latestAt: string | null;
};

export type LearningRouteFeedbackSummary = {
  total: number;
  counts: Record<string, number>;
  latestAt: string | null;
  costlyGroups: LearningRouteFeedbackGroup[];
  helpfulGroups: LearningRouteFeedbackGroup[];
};

export type LearningSettings = {
  kind: "agentflow_learning_settings";
  projectRootUri: string;
  updatedAt: string;
  workflowShapeAutoUpdate: boolean;
  agentImprovementProjectLocalAutoApply: boolean;
  autonomousApplyMaxRisk: LearningRiskLevel;
  approvalAutopilotEnabled: boolean;
  approvalAutopilotMaxRisk: ApprovalAutopilotRisk;
  daemonTrustLevels: DaemonTrustSettings;
  daemonEnabled: boolean;
  daemonPaused: boolean;
  daemonMode: LearningDaemonMode;
  daemonRunLimit: number;
};

export type LocalHoldoutResultSummary = {
  kind: "agentflow_local_holdout_results";
  projectRootUri: string;
  generatedAt: string;
  sourceComparisonPlanGeneratedAt: string | null;
  decision: "no_plan" | "needs_evidence" | "prefer_hosted" | "eligible_for_review" | "mixed";
  summary: {
    suites: number;
    gateReady: number;
    promotable: number;
    preferHosted: number;
    needsEvidence: number;
  };
  results: Array<{
    suiteId: string;
    decision: DashboardCandidateComparisonReport["promotionRecommendations"][number]["decision"];
    gateReady: boolean;
    baselineRuns: number;
    candidateRuns: number;
    qualityDelta: number | null;
    latencyDeltaMs: number | null;
    latestAt: string | null;
    rationale: string[];
    nextAction: string;
  }>;
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type LocalHoldoutRoutingPromotion = {
  kind: "agentflow_local_holdout_routing_promotion";
  projectRootUri: string;
  generatedAt: string;
  sourceResultsGeneratedAt: string | null;
  status: "blocked" | "ready";
  approved: boolean;
  reason: string;
  preference: {
    provider: "local";
    maxRisk: "low";
    scope: string;
    evidenceSuites: string[];
    thresholds: {
      minEvidenceSuites: number;
      minQualityDelta: number;
      maxLatencyRegressionMs: number;
      maxFallbackRate: number;
    };
    evidence: {
      gateReadySuites: number;
      promotableSuites: number;
      worstQualityDelta: number | null;
      worstLatencyDeltaMs: number | null;
      fallbackRate: number | null;
    };
    rollback: string;
  } | null;
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type LocalLlmBenchmarkReceipt = {
  id: string;
  generatedAt: string;
  startedAt: string;
  finishedAt: string | null;
  status: "planned" | "skipped" | "completed" | "failed";
  modelId: string;
  runtime: {
    id: string;
    label: string;
    baseUrl: string;
  } | null;
  taskId: string;
  taskLabel: string;
  latencyMs: number | null;
  outputChars: number | null;
  rubricScore: number | null;
  verdict: "needs-runtime" | "measured" | "failed";
  evidence: string[];
  error: string | null;
};

export type LocalLlmBenchmarkReceiptReport = {
  kind: "agentflow_local_llm_benchmark_receipts";
  generatedAt: string;
  projectRootUri: string;
  status: "runtime-needed" | "no-installed-models" | "planned" | "partial" | "completed";
  execute: boolean;
  timeoutMs: number;
  runtime: {
    id: string;
    label: string;
    baseUrl: string;
    modelCount: number;
  } | null;
  candidateModels: Array<{
    modelId: string;
    installed: boolean;
    primaryTier: ModelTier;
    hardwareFit: LocalLlmDownloadRecommendation["hardwareFit"];
  }>;
  tasks: Array<{
    id: string;
    label: string;
    rubric: string;
  }>;
  summary: {
    receipts: number;
    completed: number;
    failed: number;
    planned: number;
    skipped: number;
    averageLatencyMs: number | null;
    averageRubricScore: number | null;
  };
  receipts: LocalLlmBenchmarkReceipt[];
  nextAction: string;
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type LocalLlmBenchmarkTask = {
  id: string;
  label: string;
  prompt: string;
  rubric: string;
};

export type LocalLlmCacheTrendComparison = {
  previousAt: string | null;
  cacheDeltaBytes: number | null;
  cacheDeltaLabel: string;
  freeDeltaBytes: number | null;
  freeDeltaLabel: string;
  modelDelta: number | null;
  pruneCandidateDelta: number | null;
  localRouteDelta: number | null;
  hostedRouteDelta: number | null;
};

export type LocalLlmCacheTrendPoint = {
  capturedAt: string;
  totalCacheBytes: number;
  totalCacheLabel: string;
  freeBytes: number | null;
  freeRatio: number | null;
  storageStatus: LocalLlmInventoryStorage["status"];
  modelCount: number;
  pruneCandidateCount: number;
  reclaimableBytes: number;
  reclaimableLabel: string;
  localSelected: number;
  localSkipped: number;
  hostedFallback: number;
  hostedSelected: number;
};

export type LocalLlmCacheTrendReport = {
  kind: "agentflow_local_llm_cache_trends";
  generatedAt: string;
  projectRootUri: string;
  status: "no-history" | "started" | "tracking";
  current: LocalLlmCacheTrendPoint;
  history: LocalLlmCacheTrendPoint[];
  comparison: LocalLlmCacheTrendComparison;
  recommendation: string;
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type LocalLlmCostAssumptions = {
  currency: "USD";
  unit: string;
  source: string;
  hostedUsdPerStageByTier: Record<string, number>;
  localStorageUsdPerGbMonth: number;
};

export type LocalLlmCostLedgerComparison = {
  previousAt: string | null;
  netSavingsDeltaUsd: number | null;
  avoidedHostedDeltaUsd: number | null;
  storageDeltaUsd: number | null;
  localStageDelta: number | null;
};

export type LocalLlmCostLedgerPoint = {
  capturedAt: string;
  localSelectedStages: number;
  localSkippedStages: number;
  hostedFallbackStages: number;
  hostedSelectedStages: number;
  avoidedHostedUsd: number;
  fallbackHostedUsd: number;
  observedHostedUsd: number;
  storageUsdPerMonth: number;
  netEstimatedSavingsUsd: number;
  totalCacheBytes: number;
  totalCacheLabel: string;
  benchmarkAverageLatencyMs: number | null;
  benchmarkAverageScore: number | null;
};

export type LocalLlmCostLedgerReport = {
  kind: "agentflow_local_llm_cost_ledger";
  generatedAt: string;
  projectRootUri: string;
  status: "needs-local-routes" | "saving" | "watch";
  assumptions: LocalLlmCostAssumptions;
  current: LocalLlmCostLedgerPoint;
  history: LocalLlmCostLedgerPoint[];
  comparison: LocalLlmCostLedgerComparison;
  recommendation: string;
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type LocalLlmDownloadRecommendation = {
  id: string;
  priority: "high" | "medium" | "low";
  modelId: string;
  label: string;
  runtime: string;
  tierFit: ModelTier[];
  primaryTier: ModelTier;
  hardwareFit: "excellent" | "good" | "stretch" | "hosted-fallback";
  installed: boolean;
  downloadCommand: string;
  configEnv: string[];
  rationale: string[];
};

export type LocalLlmDownloadRecommendationReport = {
  kind: "agentflow_local_llm_download_recommendations";
  generatedAt: string;
  projectRootUri: string;
  status: "runtime-needed" | "download-needed" | "ready";
  hardware: {
    platform: NodeJS.Platform;
    arch: string;
    cpuCount: number;
    memoryGb: number;
    class: "small" | "medium" | "large";
  };
  taskMix: {
    runsAnalyzed: number;
    dominantTier: ModelTier;
    tierCounts: Record<string, number>;
    topWorkflows: Array<{ workflowId: string; runs: number }>;
    costSavingsGoal: string;
  };
  runtime: {
    id: string;
    label: string;
    baseUrl: string;
    modelCount: number;
  } | null;
  checklistStatus: LocalLlmSetupChecklistStatus;
  firstLocalSmokeSuccessAt: string | null;
  latestSmokeIssue: string | null;
  recommendedModelId: string | null;
  recommendations: LocalLlmDownloadRecommendation[];
  nextAction: string;
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type LocalLlmInstallationAction = {
  id: string;
  modelId: string;
  runtime: string;
  primaryTier: ModelTier;
  priority: LocalLlmDownloadRecommendation["priority"];
  installed: boolean;
  hardwareFit: LocalLlmDownloadRecommendation["hardwareFit"];
  diskEstimateGb: number;
  risk: "low" | "medium" | "high";
  commands: LocalLlmInstallationCommand[];
  envHints: string[];
  notes: string[];
};

export type LocalLlmInstallationCommand = {
  id: "download" | "verify" | "benchmark";
  label: string;
  command: string;
  requiresApproval: boolean;
  reason: string;
};

export type LocalLlmInstallationPlanReport = {
  kind: "agentflow_local_llm_installation_plan";
  generatedAt: string;
  projectRootUri: string;
  status: "no-selection" | "ready-for-review" | "already-installed";
  selectedModels: string;
  recommendationSourceGeneratedAt: string;
  runtimeStatus: LocalLlmDownloadRecommendationReport["status"];
  recommendedModelId: string | null;
  missingIds: string[];
  actions: LocalLlmInstallationAction[];
  safety: {
    executesDownloads: boolean;
    editsProviderSettings: boolean;
    writesProjectSource: boolean;
    approvalBoundary: string;
  };
  nextAction: string;
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type LocalLlmInventoryCacheRoot = {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  sizeBytes: number;
  sizeLabel: string;
  modelDirectories: number;
  lastModifiedAt: string | null;
  error: string | null;
};

export type LocalLlmInventoryModel = {
  modelId: string;
  source: "runtime-catalog" | "cache-directory";
  cacheRoot: string;
  cachePath: string | null;
  sizeBytes: number | null;
  sizeLabel: string;
  installed: boolean;
  recommended: boolean;
  lastUsedAt: string | null;
  pruneCandidate: boolean;
  reason: string;
};

export type LocalLlmInventoryReport = {
  kind: "agentflow_local_llm_inventory";
  generatedAt: string;
  projectRootUri: string;
  status: "no-cache-found" | "storage-pressure" | "ready";
  storage: LocalLlmInventoryStorage;
  cacheRoots: LocalLlmInventoryCacheRoot[];
  totalCacheBytes: number;
  totalCacheLabel: string;
  models: LocalLlmInventoryModel[];
  pruneCandidates: LocalLlmInventoryModel[];
  recommendation: string;
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type LocalLlmInventoryStorage = {
  path: string;
  totalBytes: number | null;
  freeBytes: number | null;
  freeRatio: number | null;
  status: "ok" | "watch" | "pressure" | "unknown";
};

export type LocalLlmPruneAction = {
  id: string;
  modelId: string;
  cacheRoot: string;
  cachePath: string | null;
  sizeBytes: number | null;
  sizeLabel: string;
  lastUsedAt: string | null;
  recommended: boolean;
  pruneCandidate: boolean;
  risk: "medium" | "high";
  command: string;
  requiresApproval: boolean;
  reason: string;
};

export type LocalLlmPrunePlanReport = {
  kind: "agentflow_local_llm_prune_plan";
  generatedAt: string;
  projectRootUri: string;
  status: "no-candidates" | "ready-for-review" | "needs-review";
  selectedModels: string;
  inventoryGeneratedAt: string;
  actions: LocalLlmPruneAction[];
  missingIds: string[];
  reclaimableBytes: number;
  reclaimableLabel: string;
  safety: {
    executesDeletes: boolean;
    editsProviderSettings: boolean;
    writesProjectSource: boolean;
    approvalBoundary: string;
  };
  nextAction: string;
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type LocalLlmRouteSmokeResult = {
  kind: "agentflow_local_llm_route_smoke";
  generatedAt: string;
  projectRootUri: string;
  status: "completed" | "failed";
  runId: string | null;
  workflowId: string;
  routeClass: DashboardRouteReceiptTrendGroup["classification"] | "missing";
  route: CostQualityReport["stages"][number] | null;
  checklist: LocalLlmSetupChecklistReport;
  summary: string;
  nextAction: string;
  exportMarkdownPath: string | null;
  exportJsonPath: string | null;
};

export type LocalLlmRoutingDecisionSnapshot = {
  generatedAt: string;
  sourceTimelineGeneratedAt: string;
  decisionHash: string;
  status: DashboardLocalLlmRoutingDecisionTimeline["status"];
  counts: Record<string, number>;
  totalNetSavingsUsd: number;
  summary: string[];
  items: LocalLlmRoutingDecisionSnapshotItem[];
};

export type LocalLlmRoutingDecisionSnapshotDelta = {
  previousAt: string | null;
  changed: boolean;
  added: number;
  removed: number;
  changedItems: number;
  netSavingsDeltaUsd: number;
  stateChanges: string[];
};

export type LocalLlmRoutingDecisionSnapshotItem = Omit<DashboardLocalLlmRoutingDecisionTimelineItem, "noteId">;

export type LocalLlmRoutingDecisionSnapshotLog = {
  kind: "agentflow_local_llm_routing_decision_snapshots";
  projectRootUri: string;
  updatedAt: string;
  snapshots: LocalLlmRoutingDecisionSnapshot[];
  latestDelta: LocalLlmRoutingDecisionSnapshotDelta;
};

export type LocalLlmRoutingDecisionSnapshotReport = LocalLlmRoutingDecisionSnapshotLog & {
  captured: boolean;
  currentSnapshot: LocalLlmRoutingDecisionSnapshot;
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type LocalLlmRoutingNoteApplicationPlan = {
  kind: "agentflow_local_llm_routing_note_application";
  generatedAt: string;
  projectRootUri: string;
  sourcePlanGeneratedAt: string;
  approved: boolean;
  selectedNoteIds: string[];
  appliedNoteIds: string[];
  skippedNoteIds: string[];
  targetFile: ".agent-workflow/tuning/routing-preferences.md";
  beforeHash: string;
  afterHash: string;
  rollback: string;
  summary: string[];
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type LocalLlmRoutingNotePlan = {
  kind: "agentflow_local_llm_routing_note_plan";
  generatedAt: string;
  projectRootUri: string;
  sourceRecommendationsGeneratedAt: string;
  selectedRecommendationIds: string[];
  skippedRecommendationIds: string[];
  summary: string[];
  notes: Array<{
    id: string;
    recommendationId: string;
    action: "expand" | "retreat";
    priority: LocalLlmRoutingRecommendation["priority"];
    workflowId: string;
    stageId: string;
    agentId: string;
    direction: "prefer_local_trial" | "prefer_hosted_fallback";
    targetFile: ".agent-workflow/tuning/routing-preferences.md";
    draftNote: string;
    reasons: string[];
  }>;
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type LocalLlmRoutingNotePlanDocument = Omit<LocalLlmRoutingNotePlan, "files">;

export type LocalLlmRoutingRecommendation = LocalRoutingRecommendation;

export type LocalLlmRoutingRecommendationReport = {
  kind: "agentflow_local_llm_routing_recommendations";
  generatedAt: string;
  projectRootUri: string;
  status: "needs-local-provider" | "needs-route-evidence" | "expand" | "hold" | "retreat";
  summary: string[];
  recommendations: LocalLlmRoutingRecommendation[];
  evidence: {
    localProviderStatus: DashboardLocalProviderEvidence["status"];
    configured: boolean;
    netEstimatedSavingsUsd: number;
    storageStatus: LocalLlmInventoryStorage["status"];
    pruneCandidateCount: number;
    routeReceipts: number;
    localSelected: number;
    localSkipped: number;
    hostedFallback: number;
    hostedSelected: number;
    routeFeedbackEvents: number;
    routeFeedbackCounts: Record<string, number>;
  };
  nextAction: string;
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type LocalLlmRuntimeProbe = {
  id: string;
  label: string;
  baseUrl: string;
  commandHint: string;
  status: "ready" | "missing" | "empty";
  models: string[];
  modelCount: number;
  selectedTierModels: Array<{
    tier: ModelTier;
    model: string;
    source: "env" | "catalog" | "unavailable";
  }>;
  detail: string;
  nextAction: string;
};

export type LocalLlmSetupChecklistItem = {
  id: string;
  label: string;
  status: LocalLlmSetupChecklistStatus;
  detail: string;
  nextAction: string;
};

export type LocalLlmSetupChecklistReport = {
  kind: "agentflow_local_llm_setup_checklist";
  generatedAt: string;
  projectRootUri: string;
  status: LocalLlmSetupChecklistStatus;
  localProvider: {
    configured: boolean;
    baseUrl: string;
    model: string;
    apiKeyConfigured: boolean;
    status: "ready" | "missing" | "not configured";
    modelsListed: number;
    selectedTierModels: Array<{
      tier: ModelTier;
      model: string;
      source: "env" | "catalog" | "unavailable";
    }>;
    details: string[];
  };
  routing: {
    defaultProvider: string;
    autoProviders: string;
    fastProvider: string;
    standardProvider: string;
    reasoningProvider: string;
    localHoldoutStatus: DashboardLocalHoldoutRoutingStatus["status"];
    localHoldoutApproved: boolean;
    localRouteReceipts: number;
    localSkippedReceipts: number;
    hostedFallbackReceipts: number;
  };
  smokeOutcomes: LocalLlmSmokeOutcomeTrend;
  checks: LocalLlmSetupChecklistItem[];
  nextCommands: string[];
};

export type LocalLlmSetupChecklistStatus = "pass" | "warning" | "fail";

export type LocalLlmSetupGuideReport = {
  kind: "agentflow_local_llm_setup_guide";
  generatedAt: string;
  projectRootUri: string;
  approved: boolean;
  status: "blocked" | "ready";
  routingNoteEligible: boolean;
  recommendedRuntime: LocalLlmRuntimeProbe | null;
  blockers: string[];
  runtimes: LocalLlmRuntimeProbe[];
  checklistStatus: LocalLlmSetupChecklistStatus;
  firstLocalSmokeSuccessAt: string | null;
  latestSmokeIssue: string | null;
  recommendation: string;
  files: Array<{
    relativePath: string;
    content: string;
  }>;
};

export type LocalLlmSmokeOutcome = {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  routeClass: DashboardRouteReceiptTrendGroup["classification"] | "missing";
  providerId: string | null;
  model: string | null;
  modelTier: string | null;
  requestedModelTier: string | null;
  routeReason: string | null;
  qualityScore: number | null;
  fallbackUsed: boolean;
};

export type LocalLlmSmokeOutcomeTrend = {
  kind: "agentflow_local_llm_smoke_outcomes";
  generatedAt: string;
  projectRootUri: string;
  runsAnalyzed: number;
  smokeRuns: number;
  counts: Record<DashboardRouteReceiptTrendGroup["classification"] | "missing" | "failed", number>;
  firstSuccessAt: string | null;
  latestSuccessAt: string | null;
  latestSmokeAt: string | null;
  latestFailureReason: string | null;
  latestOutcomes: LocalLlmSmokeOutcome[];
  recommendation: string;
};

export type McRunner = {
  mode: McRunnerMode;
  command: string;
  argsPrefix: string[];
  env: NodeJS.ProcessEnv;
  mapEndpoint: (endpoint: string) => string;
};

export type McRunnerMode = "mc" | "docker-mc";

export type ObjectArtifactProofReport = {
  kind: "agentflow_object_artifact_proof_report";
  generatedAt: string;
  projectRootUri: string | null;
  limit: number;
  status: "metadata-only" | "verified" | "missing" | "blocked";
  endpoint: string;
  bucket: string;
  inspectedArtifacts: number;
  referencedObjects: number;
  verifiedObjects: number;
  missingObjects: number;
  verification: "disabled" | "mc" | "docker-mc" | "unavailable";
  bucketParity: ObjectBucketParityProof | null;
  objects: ObjectArtifactReferenceProof[];
  warnings: string[];
  recommendations: string[];
};

export type ObjectArtifactReferenceProof = {
  key: string;
  artifactId: string;
  artifactUri: string;
  artifactKind: string;
  runId: string;
  source: string;
  status: "not-checked" | "present" | "missing";
  message: string;
};

export type ObjectBucketParityProof = {
  status: "not-checked" | "verified" | "missing" | "blocked";
  sourceEndpoint: string;
  sourceBucket: string;
  targetEndpoint: string;
  targetBucket: string;
  sourceObjects: number;
  targetObjects: number;
  missingInTarget: number;
  extraInTarget: number;
  verifier: "mc" | "docker-mc" | "unavailable";
  sampledMissingKeys: string[];
  sampledExtraKeys: string[];
  mirrorPlan: string[];
  message: string;
};

export type OfflineFallbackQueue = {
  kind: "agentflow_offline_fallback_queue";
  version: 1;
  updatedAt: string;
  items: OfflineFallbackQueueItem[];
};

export type OfflineFallbackQueueAction = "start-local" | "offline-run" | "sync-back" | "use-shared";

export type OfflineFallbackQueueItem = {
  id: string;
  action: OfflineFallbackQueueAction;
  status: "pending" | "synced";
  createdAt: string;
  updatedAt: string;
  actor: string;
  projectRootUri: string | null;
  runId: string | null;
  note: string;
};

export type OfflineFallbackReport = {
  kind: "agentflow_offline_fallback_report";
  generatedAt: string;
  currentServicesReachable: boolean;
  currentServices: Awaited<ReturnType<typeof checkServices>>;
  localServicesReachable: boolean;
  localServices: Awaited<ReturnType<typeof checkServices>>;
  mode: "shared-online" | "local-fallback-ready" | "local-fallback-stopped" | "offline-blocked";
  queue: OfflineFallbackQueue;
  scheduler: OfflineSyncSchedulerStatus;
  commands: {
    stopLocal: string;
    startLocal: string;
    useShared: string[];
    useLocal: string[];
    syncBack: string[];
  };
  notes: string[];
};

export type OfflineFallbackSyncResult = {
  kind: "agentflow_offline_sync_result";
  generatedAt: string;
  mode: "dry-run" | "execute";
  status: "ready" | "completed" | "blocked";
  sourceDatabaseUrl: string;
  targetDatabaseUrl: string;
  pendingQueueItems: number;
  syncedQueueItems: number;
  manifest: {
    path: string | null;
    status: string | null;
    sourceOnlyRows: number;
    conflictRows: number;
    projectIdRewriteRows: number;
  };
  importResult: {
    path: string | null;
    status: string | null;
    affectedRows: number;
    staleManifest: boolean | null;
  };
  written: {
    manifestMarkdownPath?: string;
    manifestJsonPath?: string;
    importMarkdownPath?: string;
    importJsonPath?: string;
    receiptPath?: string;
  };
  notes: string[];
  warnings: string[];
};

export type OfflineSyncSchedulerStatus = {
  kind: "agentflow_offline_sync_scheduler_status";
  updatedAt: string;
  status: "idle" | "waiting" | "ready" | "blocked" | "synced" | "error";
  mode: "dry-run" | "execute";
  pendingQueueItems: number;
  lastRunAt: string | null;
  nextRunAfter: string | null;
  lastResultPath: string | null;
  message: string;
};

export type OnboardingResult = {
  projectDir: string;
  profile: "enterprise" | "simple";
  detected: {
    name: string;
    packageManager?: string;
    frameworks: string[];
    languages: string[];
    markers: string[];
    roadmapPath: string;
    roadmapExists: boolean;
  };
  recommendations: {
    contextInclude: string[];
    contextExclude: string[];
    allowedCommands: string[];
    blockedCommands: string[];
    suggestedAgents: string[];
    defaultWorkflows: string[];
    nextCommands: string[];
  };
  config: ProjectConfig;
  dryRun: {
    valid: boolean;
    notes: string[];
  };
  written?: string[];
  skipped?: string[];
};

export type ProjectDiscoveryAdoptionItem = {
  rootUri: string;
  name: string;
  initializedBefore: boolean;
  registeredBefore: boolean;
  actions: string[];
  status: "planned" | "completed" | "skipped" | "failed";
  message: string;
};

export type ProjectDiscoveryAdoptionResult = {
  kind: "agentflow_project_discovery_adoption";
  ok: boolean;
  generatedAt: string;
  dryRun: boolean;
  selected: number;
  initialized: number;
  indexed: number;
  skipped: number;
  failed: number;
  items: ProjectDiscoveryAdoptionItem[];
  warnings: string[];
};

export type ProjectDiscoveryCandidate = {
  rootUri: string;
  name: string;
  markers: string[];
  source: "spotlight" | "filesystem" | "combined";
  confidence: "high" | "medium" | "low";
  initialized: boolean;
  registered: boolean;
  suggestedCommands: string[];
};

export type ProjectDiscoveryReport = {
  kind: "agentflow_project_discovery_report";
  generatedAt: string;
  roots: string[];
  maxDepth: number;
  maxCandidates: number;
  spotlight: {
    requested: SpotlightMode;
    used: boolean;
    available: boolean;
  };
  excludes: string[];
  candidates: ProjectDiscoveryCandidate[];
  warnings: string[];
  nextCommands: string[];
};

export type RoadmapSnapshotPublication = {
  status: "published" | "unchanged" | "unavailable";
  projectId: string;
  source: string;
  digest: string;
  sourceModifiedAt: string | null;
  publishedAt: string;
  reason: string;
};

export type RouteDecisionFeedbackEvent = {
  id: string;
  createdAt: string;
  source: "cli" | "dashboard";
  rating: RouteDecisionFeedbackRating;
  note: string;
  workflowId: string;
  stageId: string;
  agentId: string;
  providerId: string;
  modelTier: string;
  routeClass: DashboardRouteReceiptTrendGroup["classification"];
  runs: number;
  fallbackCount: number;
  averageQuality: number | null;
  averageLatencyMs: number | null;
};

export type RouteDecisionFeedbackLog = {
  kind: "agentflow_route_decision_feedback";
  projectRootUri: string;
  updatedAt: string;
  events: RouteDecisionFeedbackEvent[];
};

export type RouteDecisionFeedbackRating = LocalRoutingFeedbackRating;

export type RouteDecisionFeedbackResult =
  | {
    ok: true;
    event: RouteDecisionFeedbackEvent;
    artifactUri: string;
    totalEvents: number;
  }
  | {
    ok: false;
    error: string;
  };

export type RunInputSnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  bundle: {
    version: string;
    checksum: string;
  } | null;
  projectConfigHash: string;
  policySnapshotHash: string;
  workflowHash: string;
  selectedSources: Array<{
    sourceUri: string;
    contentHash: string | null;
  }>;
};

export type RunStaleInputReport = {
  available: boolean;
  warnings: string[];
  snapshot: RunInputSnapshot | null;
};

export interface RunSummary {
  runId: string;
  status: string;
  workflowId: string;
  task: string;
  projectName: string;
  projectRootUri: string;
  completedTasks: number;
  failedTasks: number;
  totalTasks: number;
  stageResults: Array<{
    stageId: string;
    agentId: string;
    status: string;
    attempts: number;
  }>;
  keyFindings: string[];
  failures: string[];
  pendingApprovals: Array<{
    id: string;
    actionType: string;
    target: string;
    stageId: string;
    agentId: string;
    executable: boolean;
  }>;
  artifactUris: string[];
  recommendedNextAction: string;
}

export type RuntimeMcpCleanupResult = {
  kind: "agentflow_mcp_cleanup_result";
  generatedAt: string;
  mode: "preview" | "execute";
  candidates: RuntimeMonitorReport["mcpCleanup"]["candidates"];
  terminated: Array<{ pid: number; status: "sent" | "skipped" | "failed"; message: string }>;
  warnings: string[];
};

export type RuntimeMonitorReport = {
  kind: "agentflow_runtime_monitor_report";
  generatedAt: string;
  storageHost: string | null;
  sharedHost: {
    host: string | null;
    source: "AGENTFLOW_SHARED_STORAGE_HOST" | "configured-endpoints" | "not-configured";
    reachable: boolean;
    services: Awaited<ReturnType<typeof checkServices>>;
  };
  localServices: Awaited<ReturnType<typeof checkServices>>;
  localModelRuntime: {
    runtime: string;
    executable: string | null;
    label: string;
    plistPath: string;
    installed: boolean;
    serviceStatus: "running" | "installed" | "missing" | "unavailable";
    pid: number | null;
    runs: number | null;
    endpoint: string;
    endpointHealthy: boolean;
    modelCount: number;
    selectedModel: string;
    stdoutPath: string;
    stderrPath: string;
    installCommand: string;
    uninstallCommand: string;
    restartCommand: string;
    guidance: string;
  };
  docker: {
    status: "running" | "unavailable";
    message: string;
    containers: Array<{ name: string; image: string; ports: string }>;
  };
  ports: Array<{
    label: string;
    port: number;
    status: "listening" | "closed";
    pid: number | null;
    command: string;
  }>;
  processes: Array<{
    role: "dashboard" | "worker" | "learning-daemon" | "mcp" | "supervisor" | "other";
    status: "ok" | "attention";
    count: number;
    pids: number[];
    detail: string;
  }>;
  mcpPipeline: {
    status: "ok" | "attention";
    pluginEnabled: boolean;
    pluginRoot: string;
    manifestPath: string;
    launcherPath: string;
    launcherExists: boolean;
    launcherExecutable: boolean;
    repoResolved: boolean;
    resolvedRepo: string | null;
    serverBuilt: boolean;
    stdioLogPath: string;
    launcherLogPath: string;
    lastStdioEvents: Array<Record<string, unknown>>;
    lastLauncherEvents: Array<Record<string, unknown>>;
    lastSpawnAt: string | null;
    lastExitAt: string | null;
    lastExitCode: number | null;
    smoke: {
      status: "not-run" | "passed" | "failed";
      toolCount: number | null;
      message: string;
      command: string;
      checkedAt: string | null;
    };
    clientReload: {
      suspectedStalePipe: boolean;
      summary: string;
      steps: string[];
    };
    approvalDiagnostics: {
      recentEvents: Array<Record<string, unknown>>;
      lastCallAt: string | null;
      lastResultAt: string | null;
      lastExitCode: number | null;
      lastTimedOut: boolean | null;
      summary: string;
      fallbackCommand: string;
    };
    commandDiagnostics: {
      recentEvents: Array<Record<string, unknown>>;
      lastStartAt: string | null;
      lastCloseAt: string | null;
      lastOperation: string | null;
      lastExitCode: number | null;
      lastTimedOut: boolean | null;
      summary: string;
    };
    recovery: {
      status: "not-written" | "available";
      directory: string;
      markdownPath: string;
      jsonPath: string;
      scriptPath: string;
      lastWrittenAt: string | null;
      writeCommand: string;
      recommendedAction: string;
      canRestartClientPipe: boolean;
      reason: string;
    };
  };
  mcpCleanup: {
    candidateCount: number;
    candidates: Array<{
      pid: number;
      parentPid: number | null;
      command: string;
      reason: string;
      ageMs: number | null;
      startedAt: string | null;
      sessionKey: string;
      risk: "low" | "medium";
      autoCleanable: boolean;
    }>;
    autoCleanup: {
      enabled: boolean;
      mode: "preview" | "auto-low-risk";
      staleMinutes: number;
    };
    previewCommand: string;
    executeCommand: string;
  };
  staleRuns: {
    candidateCount: number;
    candidates: Array<{
      runId: string;
      workflowId: string;
      runStatus: string;
      task: string;
      projectRootUri: string;
      totalTasks: number;
      completedTasks: number;
      cancelledTasks: number;
      recommendedStatus: "completed" | "cancelled";
      startedAt: string | null;
    }>;
    autoReconcile: {
      enabled: boolean;
      limit: number;
    };
    previewCommand: string;
    executeCommand: string;
  };
  recommendations: string[];
};

export type RuntimeStaleRunReconciliationResult = Awaited<ReturnType<typeof reconcileStaleTerminalWorkflowRuns>>;

export type RuntimeVersionMetadata = { runtimeVersion: string; bundleVersion: string; protocolVersions: CliContext["protocolVersions"] };

export type ServerApprovalActionPlanReport = {
  kind: "agentflow_server_approval_action_plan";
  generatedAt: string;
  status: "ready" | "attention" | "blocked";
  canEnableApprovalActions: boolean;
  summary: {
    decisions: number;
    ready: number;
    blocked: number;
    receiptPlanReady: boolean;
    idempotencyReuseReady: boolean;
    rollbackEvidenceReady: boolean;
  };
  decisions: Array<{
    decision: ServerApprovalPreviewReport["envelope"]["decision"];
    mutatesApprovalState: boolean;
    executesSideEffect: boolean;
    requiredReceiptKinds: string[];
    idempotencyReuseKey: string;
    replayBehavior: string;
    rollbackEvidence: string[];
    missingControls: string[];
    status: "ready" | "blocked";
  }>;
  implementationPhases: Array<{
    phase: string;
    status: "done" | "next" | "future";
    detail: string;
  }>;
  notes: string[];
};

export type ServerApprovalActionReport = {
  kind: "agentflow_server_approval_action_report";
  generatedAt: string;
  status: "ready" | "attention" | "blocked";
  dryRun: boolean;
  envelope: Omit<ServerApprovalPreviewReport["envelope"], "source"> & {
    source: "server-approval-action";
  };
  approval: ServerApprovalPreviewReport["approval"];
  controls: Omit<ServerApprovalPreviewReport["controls"], "wouldMutate"> & {
    executeRequested: boolean;
    approvalActionExecutionEnabled: boolean;
    clientProvidedIdempotency: boolean;
    requestBodyMaxBytes: number;
    rateLimitPerMinute: number;
    rateLimitAccepted: boolean;
    perActionReceiptGate: boolean;
    wouldMutate: boolean;
  };
  mutation: null | {
    receiptUri: string;
    receiptHash: string;
    requestHash: string;
    replayed: boolean;
    outcome: "completed" | "failed";
    title: string;
    output: string;
    beforeStatus: string | null;
    afterStatus: string | null;
    rollbackEvidence: string[];
  };
  checks: ServerApprovalPreviewReport["checks"];
  notes: string[];
};

export type ServerApprovalActionTestAdapterReport = {
  kind: "agentflow_server_approval_action_test_adapter";
  generatedAt: string;
  status: "pass" | "fail";
  dryRun: true;
  liveSideEffects: false;
  summary: {
    decisions: number;
    passed: number;
    failed: number;
    replayed: number;
    simulatedSideEffects: number;
  };
  decisions: Array<{
    decision: ServerApprovalPreviewReport["envelope"]["decision"];
    status: "pass" | "fail";
    firstReceiptKinds: string[];
    replayReceiptKinds: string[];
    replayMatched: boolean;
    sideEffectExecutions: number;
    rollbackEvidence: string[];
    errors: string[];
  }>;
  notes: string[];
};

export type ServerApprovalPreviewReport = {
  kind: "agentflow_server_approval_preview";
  generatedAt: string;
  status: "ready" | "attention" | "blocked";
  dryRun: true;
  envelope: {
    requestId: string;
    idempotencyKey: string;
    actor: string;
    actorRole: string;
    projectId: string;
    approvalId: string;
    decision: "approve" | "reject" | "execute" | "approve-and-execute" | "dismiss" | "always-approve";
    source: "server-approval-preview";
  };
  approval: null | {
    id: string;
    runId: string;
    workflowId: string;
    stageId: string;
    agentId: string;
    status: string;
    actionType: string;
    target: string;
    projectRootHash: string;
    executable: boolean;
  };
  controls: {
    serverModeEnabled: boolean;
    authMode: string;
    authConfigured: boolean;
    authAccepted: boolean | null;
    projectResolved: boolean;
    approvalResolved: boolean;
    projectMatchesApproval: boolean;
    roleGate: "pass" | "warn" | "fail";
    executionRoleGate: "pass" | "warn" | "fail" | "not-applicable";
    separationOfDuties: "pass" | "warn" | "fail" | "not-applicable";
    policyRecheck: "pass" | "warn" | "fail" | "not-applicable";
    idempotencyProvided: boolean;
    wouldMutate: false;
  };
  checks: Array<{
    label: string;
    status: ServerReadinessCheckStatus;
    detail: string;
  }>;
  notes: string[];
};

export type ServerAuthHardeningReport = {
  status: ServerReadinessStatus;
  summary: string;
  readyControls: number;
  warningControls: number;
  failingControls: number;
  checks: Array<{
    label: string;
    status: ServerReadinessCheckStatus;
    detail: string;
  }>;
  recommendedActions: string[];
};

export type ServerConversationReport = {
  kind: "agentflow_server_conversation_report";
  generatedAt: string;
  status: "completed" | "operation-required" | "queued" | "blocked";
  requestId: string;
  idempotencyKey: string;
  replayed: boolean;
  capabilityMode: ConversationRequest["capabilityMode"];
  intent: ReturnType<typeof classifyConversationIntent>;
  assistant: null | { text: string; actualProvider: string; actualModel: string | null; fallbackUsed: boolean };
  operation: null | { workflowId: string; queued: boolean; runId: string | null; runUrl: string | null; reused: boolean };
  receipt: {
    metadataOnly: true;
    requestHash: string;
    messageHash: string;
    historyTurns: number;
    historyChars: number;
    attempts: Array<{ provider: string; model: string | null; attempt: number; outcome: string; failureKind: string | null; attemptId: string }>;
  };
  error?: string;
};

export type ServerMutationControlReport = {
  kind: "agentflow_server_mutation_control_report";
  generatedAt: string;
  status: "ready" | "attention" | "blocked";
  mode: {
    serverModeEnabled: boolean;
    bind: string;
    networkExposed: boolean;
    authMode: string;
    tokenConfigured: boolean;
    queueExecutionEnabled: boolean;
    approvalActionExecutionEnabled: boolean;
    requestBodyMaxBytes: number;
    rateLimitPerMinute: number;
  };
  summary: {
    endpoints: number;
    remoteMutationEndpoints: number;
    readyRemoteMutations: number;
    blockedRemoteMutations: number;
    localOnlyMutations: number;
  };
  endpoints: Array<{
    name: string;
    method: string;
    path: string;
    exposure: "read-only" | "local-mutation" | "remote-mutation";
    implemented: boolean;
    remoteEligible: boolean;
    dryRunDefault: boolean;
    executionGate: string;
    roleCapability: string | null;
    receipt: string | null;
    requiredControls: string[];
    presentControls: string[];
    missingControls: string[];
    status: "ready" | "attention" | "blocked";
    notes: string[];
  }>;
  recommendedActions: string[];
};

export type ServerProjectRegistryReport = {
  kind: "agentflow_server_project_registry_report";
  generatedAt: string;
  projectRootUri: string | null;
  limit: number;
  includeRoots: boolean;
  services: Awaited<ReturnType<typeof checkServices>>;
  projects: Array<{
    projectId: string;
    name: string;
    rootUri: string | null;
    rootHash: string;
    configStatus: "valid" | "missing" | "invalid";
    defaultWorkflows: string[];
    policyProfile: string;
    roleEnforcement: "preview" | "enforce";
    requestExample: {
      projectId: string;
      workflow: string;
      task: string;
    };
  }>;
  checks: Array<{
    label: string;
    status: ServerReadinessCheckStatus;
    detail: string;
  }>;
  notes: string[];
};

export type ServerProjectResolution = {
  kind: "agentflow_server_project_resolution";
  generatedAt: string;
  projectId: string;
  resolved: boolean;
  reason: string | null;
  project: null | {
    projectId: string;
    name: string;
    rootUri: string | null;
    rootHash: string;
    configStatus: "valid" | "missing" | "invalid";
    defaultWorkflows: string[];
    policyProfile: string;
    roleEnforcement: "preview" | "enforce";
  };
  checks: Array<{
    label: string;
    status: ServerReadinessCheckStatus;
    detail: string;
  }>;
};

export type ServerQueueReport = {
  kind: "agentflow_server_queue_report";
  generatedAt: string;
  status: "queued" | "ready" | "attention" | "blocked";
  dryRun: boolean;
  envelope: ServerRequestPreviewReport["envelope"];
  route: ServerRoutePreviewReport["route"];
  queuedRun: null | {
    runId: string;
    projectId: string;
    projectRootUri: string;
    workflowId: string;
    tasks: number;
    runUrl: string;
    actorReceiptUri: string | null;
    reused: boolean;
  };
  controls: Omit<ServerRequestPreviewReport["controls"], "wouldQueue"> & {
    authAccepted: boolean;
    executeRequested: boolean;
    queueExecutionEnabled: boolean;
    clientProvidedIdempotency: boolean;
    requestBodyMaxBytes: number;
    rateLimitPerMinute: number;
    rateLimitAccepted: boolean;
    wouldQueue: boolean;
  };
  checks: ServerRequestPreviewReport["checks"];
  notes: string[];
};

export type ServerReadinessCheckStatus = "pass" | "warn" | "fail";

export type ServerReadinessReport = {
  kind: "agentflow_server_readiness_report";
  generatedAt: string;
  status: ServerReadinessStatus;
  projectRootUri: string | null;
  limit: number;
  mode: {
    enabled: boolean;
    bind: string;
    port: string;
    networkExposed: boolean;
    authMode: string;
    tokenConfigured: boolean;
    allowedOrigins: string[];
  };
  services: Awaited<ReturnType<typeof checkServices>>;
  projects: Array<{
    id: string;
    name: string;
    rootUri: string;
    configStatus: "valid" | "missing" | "invalid";
    roleEnforcement: "preview" | "enforce";
    separationOfDuties: "off" | "preview" | "enforce";
    roles: string[];
  }>;
  endpointClasses: Array<{
    name: string;
    exposure: "read-only" | "mutation";
    requiredControls: string[];
    implemented: boolean;
    ready: boolean;
  }>;
  authHardening: ServerAuthHardeningReport;
  checks: Array<{
    label: string;
    status: ServerReadinessCheckStatus;
    detail: string;
  }>;
  recommendedCommands: string[];
  notes: string[];
};

export type ServerReadinessStatus = "local-only" | "ready" | "attention" | "blocked";

export type ServerRequestAuditEvent = {
  kind: "agentflow_server_request_audit_event";
  version: 1;
  generatedAt: string;
  requestId: string | null;
  method: string;
  path: string;
  status: "queued" | "ready" | "attention" | "blocked" | "rejected";
  dryRun: boolean;
  executeRequested: boolean;
  projectId: string | null;
  projectRootHash: string | null;
  workflowId: string | null;
  taskHash: string | null;
  taskBytes: number;
  actorHash: string | null;
  actorRole: string | null;
  auth: {
    method: string;
    accepted: boolean;
    errorCode: string | null;
  };
  rateLimit: {
    accepted: boolean | null;
    keyHash: string | null;
    limit: number | null;
    remaining: number | null;
    resetAt: string | null;
  };
  idempotencyKeyHash: string | null;
  clientProvidedIdempotency: boolean;
  queuedRunId: string | null;
  reusedRun: boolean | null;
  bodyBytes: number | null;
  remoteHash: string | null;
  originHash: string | null;
  userAgentHash: string | null;
  checks: Array<{ label: string; status: string }>;
};

export type ServerRequestAuditReport = {
  kind: "agentflow_server_request_audit_report";
  generatedAt: string;
  logPath: string;
  limit: number;
  totalRead: number;
  invalidLines: number;
  latestAt: string | null;
  statusCounts: Record<string, number>;
  authCounts: Record<string, number>;
  rateLimited: number;
  queued: number;
  blocked: number;
  dryRuns: number;
  events: ServerRequestAuditEvent[];
  notes: string[];
};

export type ServerRequestPreviewReport = {
  kind: "agentflow_server_request_preview";
  generatedAt: string;
  status: "ready" | "attention" | "blocked";
  envelope: {
    requestId: string;
    idempotencyKey: string;
    actor: string;
    actorRole: string;
    projectId: string;
    workflow: string;
    task: string;
    policyProfile: string | null;
    source: "server-request-preview";
  };
  controls: {
    serverModeEnabled: boolean;
    authMode: string;
    authConfigured: boolean;
    projectResolved: boolean;
    roleGate: "pass" | "warn" | "fail";
    workflowFound: boolean;
    idempotencyProvided: boolean;
    wouldQueue: false;
  };
  checks: Array<{
    label: string;
    status: ServerReadinessCheckStatus;
    detail: string;
  }>;
  notes: string[];
};

export type ServerRoutePreviewReport = {
  kind: "agentflow_server_route_preview";
  generatedAt: string;
  status: "ready" | "attention" | "blocked";
  dryRun: true;
  envelope: ServerRequestPreviewReport["envelope"];
  controls: ServerRequestPreviewReport["controls"];
  route: null | {
    projectId: string;
    projectName: string;
    projectRootUri: string;
    workflowId: string;
    task: string;
    policyProfile: string;
    actor: string;
    actorRole: string;
    idempotencyKey: string;
    commandPreview: string;
  };
  checks: ServerRequestPreviewReport["checks"];
  notes: string[];
};

export type SourceSummaryWithHash = {
  sourceUri: string;
  tokenEstimate: number;
  summary: string;
  contentHash?: string;
  score?: number;
  matchedTerms?: string[];
  selectionReason?: string;
};

export type SpotlightMode = "auto" | "on" | "off";

export type StorageMergeEvidenceListing = {
  kind: "agentflow_storage_merge_evidence_listing";
  generatedAt: string;
  directory: string;
  latestManifest: {
    jsonPath: string;
    markdownPath: string | null;
    generatedAt: string;
    status: string;
    sourceOnlyRows: number;
    conflictRows: number;
    projectIdRewriteRows: number;
    legacyDefinitionReferences: number;
    legacyReadabilityWarnings: number;
    changedDefinitionReferences: number;
    tableCount: number;
    projectMappings: Array<{
      rootUri: string;
      sourceProjectId: string;
      targetProjectId: string | null;
      action: string;
      sourceName?: string | null;
      targetName?: string | null;
    }>;
    tables: Array<{
      table: string;
      sourceRows: number;
      insertRows: number;
      conflictRows: number;
      projectIdRewriteRows: number;
      sampleSourceKeys: string[];
      sampleExistingKeys: string[];
      sampleInsertKeys: string[];
      sampleConflictKeys: string[];
    }>;
  } | null;
  latestImport: {
    jsonPath: string;
    markdownPath: string | null;
    generatedAt: string;
    status: string;
    mode: string;
    affectedRows: number;
    staleManifest: boolean;
  } | null;
  latestBackup: {
    path: string;
    generatedAt: string | null;
    files: Array<{ name: string; sizeBytes: number }>;
  } | null;
  latestObjectProof: {
    jsonPath: string;
    markdownPath: string | null;
    generatedAt: string;
    status: string;
    referencedObjects: number;
    verifiedObjects: number;
    missingObjects: number;
    bucketParityStatus: string | null;
    missingInTarget: number | null;
    extraInTarget: number | null;
  } | null;
  latestProjectDecisions: {
    jsonPath: string;
    generatedAt: string;
    decisions: Array<{
      rootUri: string;
      action: string;
      sourceProjectId: string | null;
      targetProjectId: string | null;
      reviewer: string;
      note: string;
      decidedAt: string;
    }>;
  } | null;
  switchOverProof: {
    status: "ready" | "attention";
    checks: Array<{
      label: string;
      status: "pass" | "warn" | "fail";
      detail: string;
    }>;
    recommendedCommands: string[];
  };
  conflictClassification: {
    criticalRows: number;
    derivedRows: number;
    informationalRows: number;
    rows: Array<{
      table: string;
      severity: "critical" | "warning" | "info";
      class: "canonical-project-conflict" | "derived-index-cache" | "approval-lifecycle-conflict" | "historical-state-conflict";
      conflictRows: number;
      sampleConflictKeys: string[];
      resolution: string;
      reviewedDecision?: string;
    }>;
  };
  safePrimaryStatePlane: boolean;
  warnings: string[];
};

export type StorageProjectDecisionEntry = NonNullable<StorageMergeEvidenceListing["latestProjectDecisions"]>["decisions"][number];

export type TeamRoleCapability =
  | "can_request_approvals"
  | "can_approve_actions"
  | "can_reject_actions"
  | "can_execute_approved_actions"
  | "can_author_workflows";

export type WorkflowPreset = {
  id: string;
  aliases: string[];
  label: string;
  description: string;
  project: string;
  task: string;
  kind: "agent" | "workflow";
  target: string;
};

export type AgentImprovementPendingProject = {
  projectRootUri: string;
  name: string;
  pending: number;
  deferred: number;
  current: boolean;
};

export type AgentImprovementPendingSummary = {
  projects: AgentImprovementPendingProject[];
};

export type DashboardWorkflowStageRun = Awaited<ReturnType<typeof listWorkflowStageRunsForRuns>>[number];

type DashboardGraphExportSummary = {
  jsonPath: string;
  markdownPath: string | null;
  fileName: string;
  generatedAt: string;
  graphPath: string;
  projectPath: string;
  workflowId: string;
  workflowName: string;
  projectName: string;
  focusedStageId: string | null;
  runCount: number;
  stageHealthCount: number;
};

export type DashboardWorkflowGraphReport = WorkflowGraphReport & {
  handoffPackets: Awaited<ReturnType<typeof listWorkflowHandoffs>>;
  runs: DashboardWorkflowGraphRun[];
  liveStageRuns: DashboardWorkflowStageRun[];
  runScope: "project" | "all-projects";
  runStatusFilter: string;
  runWarnings: string[];
  stageHealth: DashboardWorkflowStageHealth[];
  focusedStageId: string;
  focusedStageRuns: DashboardWorkflowStageRun[];
  focusedStageFixRuns: DashboardWorkflowGraphRun[];
  focusedStageVerificationRuns: DashboardWorkflowGraphRun[];
  recentGraphExports: DashboardGraphExportSummary[];
  graphPresets: DashboardGraphPreset[];
};

export type FocusedStageDeltaSummary = {
  baseline: FocusedStageOutcomeSummary;
  verification: FocusedStageOutcomeSummary;
  completedDelta: number | null;
  failedDelta: number | null;
  activeDelta: number | null;
  label: string;
};

export type DashboardGraphPresetFilters = {
  workflow: string;
  project: string;
  policyProfile: string;
  view: "graph" | "mind-map" | "network";
  orientation: "horizontal" | "radial";
  category: string;
  approval: string;
  policyStatus: string;
  runStatus: string;
  runLimit: string;
  runScope: "project" | "all-projects";
  stage: string;
};

export type DashboardGraphPresetFile = {
  kind: "agentflow_graph_presets";
  projectRootUri: string;
  updatedAt: string;
  presets: DashboardGraphPreset[];
};

export type DashboardWorkflowGraphRun = {
  id: string;
  status: string;
  workflowId: string;
  task: string;
  projectName: string;
  projectRootUri: string;
  startedAt: string;
  finishedAt: string | null;
  providerOverride: string | null;
  modelTierOverride: string | null;
  evaluationMetadata: Record<string, unknown>;
};

export type DashboardWorkflowStageHealth = Awaited<ReturnType<typeof listWorkflowStageHealthForRuns>>[number];

export type DashboardGraphPreset = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  filters: DashboardGraphPresetFilters;
};

export type FocusedStageOutcomeSummary = {
  total: number;
  completed: number;
  failed: number;
  active: number;
  cancelled: number;
  completedRate: number | null;
  failedRate: number | null;
  activeRate: number | null;
};
