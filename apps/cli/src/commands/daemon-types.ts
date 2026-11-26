// Types shared by the daemon and dashboard commands, moved out of daemon.ts
// without changes so the command module stays reviewable.
import type { CliContext } from "../lib/context.js";
import type { ArtifactLifecycleAction, ArtifactLifecyclePolicy, DashboardActionApproval, DashboardFeedbackTarget, DashboardLearningDaemonStatus, DashboardLocalHoldoutRoutingStatus, DashboardLocalLlmRoutingDecisionTimeline, DashboardLocalLlmRoutingNoteApplicationStatus, DashboardLocalProviderEvidence, DashboardProjectSummary, DashboardRoleAuditExportSummary, DashboardRouteReceiptTrendReport, DashboardRunStatus, DashboardSupervisorStatus, DashboardWorkerLane, DashboardWorkerStatus, LearningActionReceiptLog, LearningDaemonMode, LocalLlmBenchmarkReceiptReport, LocalLlmCacheTrendReport, LocalLlmCostLedgerReport, LocalLlmDownloadRecommendationReport, LocalLlmInstallationPlanReport, LocalLlmInventoryReport, LocalLlmPrunePlanReport, LocalLlmRoutingDecisionSnapshotReport, LocalLlmRoutingRecommendationReport, LocalLlmSetupChecklistReport, LocalLlmSetupGuideReport, RuntimeMonitorReport, ServerReadinessCheckStatus, AgentImprovementPendingProject } from "../lib/cli-types.js";
import type { buildGraphHandoffPayload } from "../lib/builders-shared.js";
import type { AgentCard } from "../../../../packages/agent-registry/src/schemas.js";
import type { BundleCompatibilityReport, BundleRegistryReport, BundleUpgradePreview, BundleVerification, ProjectBundlePin } from "../../../../packages/bundle-trust/src/index.js";
import type { ContractTestReport } from "../../../../packages/contract-tests/src/index.js";
import type { FleetProjectScope } from "../../../../packages/daemon-control/src/index.js";
import type { QueueCardActivity } from '../lib/queue-card-activity.js';
import type { QueueWaitReason } from '../lib/queue-wait-reasons.js';
import type { WorkerHeartbeatAttestation } from "../lib/worker-heartbeat-attestation.js";
import type { DefinitionMigrationPlan } from "../../../../packages/definition-migrations/src/index.js";
import type { summarizeFleetUsage } from "../../../../packages/fleet-model-gateway/src/index.js";
import type { ExecutionCapabilityProbe } from "../../../../packages/local-tools/src/command-executor.js";
import type { CatalogCandidate, ModelSelectionPolicy } from "../../../../packages/model-providers/src/catalog.js";
import type { ModelTier } from "../../../../packages/model-providers/src/types.js";
import type { RoadmapSuggestionReport, ServerRoadmapSnapshot } from "../../../../packages/roadmap/src/index.js";
import type { PreferenceScorecard, TuningProposalSet } from "../../../../packages/run-reporter/src/index.js";
import type { checkServices } from "../../../../packages/storage/src/doctor.js";
import type { getLatestMemory, listArtifactLifecycle, listProjectFileSummaries, listWorkflowHandoffs, listWorkflowQueue, listWorkflowRunsForProject, listWorkflowStageHealthForRuns, listWorkflowStageRunsForRuns } from "../../../../packages/storage/src/postgres.js";
import type { WorkflowGraphReport } from "../../../../packages/workflow-inspector/src/index.js";
import type { FailedCardRemoval } from '../lib/queue-removal.js';
import type { QueuePartnerHistorySummary } from '../lib/queue-partner-memory.js';
import type { AggregateRunEta } from "../dashboard/run-eta.js";

export type ArtifactLifecycleActionPlan = {
  mode: "dry-run";
  action: "archive" | "restore";
  generatedAt: string;
  criteria: ArtifactPrunePlan["criteria"];
  totalCandidates: number;
  estimatedBytesRecoverable: number;
  approvalRequired: boolean;
  notes: string[];
  candidates: Array<{
    artifactId: string;
    uri: string;
    runId: string;
    taskId: string | null;
    projectName: string;
    projectRootUri: string;
    workflowId: string;
    runStatus: string;
    kind: string;
    contentBytes: number;
    createdAt: string;
    ageDays: number | null;
    reason: string;
    receiptPreview: ArtifactLifecycleReceiptPreview;
  }>;
};

export type ArtifactLifecycleApprovalActionType = "artifact_prune" | "artifact_archive" | "artifact_restore";

export type ArtifactLifecycleApprovalQueue = {
  mode: "approval-request";
  action: ArtifactLifecycleAction;
  generatedAt: string;
  requestedBy: string;
  requestedByRole: string;
  totalRequested: number;
  skipped: string[];
  approvals: Array<{
    approvalId: string;
    status: string;
    artifactUri: string;
    runId: string;
    target: string;
    artifactId: string;
    idempotencyKey: string;
  }>;
};

export type ArtifactLifecycleReceiptPreview = {
  actionType: ArtifactLifecycleRequestedActionType;
      target: string;
      summary: string;
      metadata: {
        mode: "dry-run";
        action: ArtifactLifecycleAction;
        artifactId: string;
        runId: string;
        taskId: string | null;
        kind: string;
        contentBytes: number;
        reason: string;
      };
};

export type ArtifactLifecycleReport = {
  kind: "agentflow_artifact_lifecycle_report";
  generatedAt: string;
  projectRootUri: string | null;
  artifactKind: string | null;
  limit: number;
  retentionPolicy: ArtifactLifecyclePolicy;
  prunePlan: ArtifactPrunePlan | null;
  archivePlan: ArtifactLifecycleActionPlan | null;
  restorePlan: ArtifactLifecycleActionPlan | null;
  approvalQueues: ArtifactLifecycleApprovalQueue[];
  totalArtifacts: number;
  estimatedBytes: number;
  byProject: Record<string, number>;
  byKind: Record<string, number>;
  byAgeBucket: Record<string, number>;
  byRunStatus: Record<string, number>;
  reviewHints: string[];
  recentArtifacts: Array<DashboardArtifactLifecycleRow & {
    ageBucket: string;
    lifecycleHint: string;
  }>;
};

export type ArtifactLifecycleRequestedActionType = "artifact_prune_requested" | "artifact_archive_requested" | "artifact_restore_requested";

export type ArtifactPrunePlan = {
  mode: "dry-run";
  generatedAt: string;
  criteria: {
    policySource: "project" | "default" | "override";
    minAgeDays: number;
    minBytes: number;
    includeAudit: boolean;
    legalHold: boolean;
    requireApproval: boolean;
  };
  totalCandidates: number;
  estimatedBytesRecoverable: number;
  approvalRequired: boolean;
  notes: string[];
  candidates: Array<{
    artifactId: string;
    uri: string;
    runId: string;
    taskId: string | null;
    projectName: string;
    projectRootUri: string;
    workflowId: string;
    runStatus: string;
    kind: string;
    contentBytes: number;
    createdAt: string;
    ageDays: number | null;
    reason: string;
    receiptPreview: ArtifactLifecycleReceiptPreview;
  }>;
};

export type BackupRestoreReport = {
  kind: "agentflow_backup_restore_report";
  generatedAt: string;
  projectRootUri: string | null;
  limit: number;
  services: Awaited<ReturnType<typeof checkServices>>;
  inventory: {
    projects: number;
    runs: number;
    completedRuns: number;
    failedRuns: number;
    queuedRuns: number;
    runningRuns: number;
    indexedFiles: number;
    indexedTokens: number;
    memoryItems: number;
    artifacts: number;
    estimatedArtifactBytes: number;
    archivedArtifacts: number;
    restoredArtifacts: number;
    byKind: Record<string, { count: number; bytes: number }>;
    byProject: Record<string, { artifacts: number; bytes: number }>;
  };
  restoreDrill: {
    status: "ready" | "attention";
    servicesReachable: boolean;
    projectRegistered: boolean;
    archivedSnapshotsAvailable: boolean;
    restoredSnapshotsAvailable: boolean;
    pendingLifecycleApprovals: number;
    activeQueueItems: number;
    latestArtifactAt: string | null;
    checks: Array<{ label: string; status: "pass" | "warn"; detail: string }>;
  };
  recommendedCommands: string[];
  notes: string[];
};

export type DashboardAgentSource = "shared" | "project-local";

export type DashboardAgentSummary = {
  id: string;
  displayName: string;
  category: AgentCard["category"];
  autonomy: AgentCard["autonomy"];
  modelStrategy: string;
  modelTier: string;
  purpose: string;
  useWhen: string[];
  can: string[];
  requiresApproval: string[];
  contextMaxTokens: number;
  source: DashboardAgentSource;
  sourcePath: string;
  modifiedAt: string | null;
  overridesShared: boolean;
};

export type DashboardAgentsReport = {
  generatedAt: string;
  projectRootUri: string | null;
  sharedAgents: DashboardAgentSummary[];
  projectAgents: DashboardAgentSummary[];
  effectiveAgents: DashboardAgentSummary[];
  warnings: string[];
};

export type DashboardArtifactLifecycleRow = Awaited<ReturnType<typeof listArtifactLifecycle>>[number];

export type DashboardBundleReadiness = {
  generatedAt: string;
  projectDir: string | null;
  verification: BundleVerification;
  compatibility: BundleCompatibilityReport;
  registry: BundleRegistryReport;
  pin: { path: string; value: ProjectBundlePin | null } | null;
  upgradePreview: BundleUpgradePreview;
  migrationPlan: DefinitionMigrationPlan;
  contractTests: ContractTestReport;
  errors: string[];
};

export type DashboardFleetUsageReport = ReturnType<typeof summarizeFleetUsage> & { dashboardSource: "authoritative-gateway" | "local-ledger" | "local-fallback"; dashboardNotice?: string };

export type DashboardGraphExportSummary = {
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

export type DashboardGraphHandoffViewResult =
  | {
    ok: true;
    projectDir: string;
    fileName: string;
    markdownPath: string;
    jsonPath: string | null;
    markdown: string;
    summary: DashboardGraphExportSummary | null;
  }
  | { ok: false; error: string; projectDir?: string };

export type DashboardGraphPreset = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  filters: DashboardGraphPresetFilters;
};

export type DashboardGraphPresetActionResult =
  | { ok: true; href: string }
  | { ok: false; error: string };

export type DashboardGraphPresetFile = {
  kind: "agentflow_graph_presets";
  projectRootUri: string;
  updatedAt: string;
  presets: DashboardGraphPreset[];
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

export type DashboardHomeHealth = {
  worker: DashboardWorkerStatus;
  supervisor: DashboardSupervisorStatus;
  runtimeMonitor: RuntimeMonitorReport;
  roadmap: RoadmapDashboardReport;
  queue: DashboardQueueItem[];
  projects: DashboardProjectSummary[];
  services: Awaited<ReturnType<typeof checkServices>>;
  provider: string;
  latestFailedRun: DashboardRunStatus | null;
  pendingApprovals: DashboardActionApproval[];
  approvedExecutableApprovals: DashboardActionApproval[];
  learningDaemon: DashboardLearningDaemonStatus | null;
  learningReceipts: LearningActionReceiptLog | null;
  agentImprovementPendingPromotions: AgentImprovementPendingProject[];
};

export type DashboardModelCatalogProvider = {
  providerId: "openai" | "anthropic" | "deepseek" | "gemini" | "groq" | "openrouter" | "nvidia" | "byo" | "openai-compatible" | "bedrock";
  label: string;
  configured: boolean;
  status: "ready" | "missing" | "not configured";
  catalogSource: string;
  modelsListed: number;
  configuredModel: string;
  modelEnv: string;
  baseUrl?: string;
  apiKeyStatus?: string;
  awsProfile?: string;
  awsRegion?: string;
  error?: string;
  tierSelections: DashboardModelTierExplanation[];
};

export type DashboardModelCatalogReport = {
  kind: "agentflow_model_catalog_report";
  generatedAt: string;
  selectedProvider: string;
  modelPolicy: ModelSelectionPolicy;
  providers: DashboardModelCatalogProvider[];
};

export type DashboardModelImprovementReport = {
  generatedAt: string;
  projectDir: string;
  scorecard: PreferenceScorecard;
  proposals: TuningProposalSet;
  localProviderEvidence: DashboardLocalProviderEvidence;
  localHoldoutRouting: DashboardLocalHoldoutRoutingStatus;
  routeReceiptTrends: DashboardRouteReceiptTrendReport;
  localLlmSetup: LocalLlmSetupChecklistReport;
  localLlmSetupGuide: LocalLlmSetupGuideReport;
  localLlmDownloadRecommendations: LocalLlmDownloadRecommendationReport;
  localLlmBenchmarks: LocalLlmBenchmarkReceiptReport;
  localLlmInstallationPlan: LocalLlmInstallationPlanReport;
  localLlmInventory: LocalLlmInventoryReport;
  localLlmPrunePlan: LocalLlmPrunePlanReport;
  localLlmCacheTrends: LocalLlmCacheTrendReport;
  localLlmCostLedger: LocalLlmCostLedgerReport;
  localLlmRoutingRecommendations: LocalLlmRoutingRecommendationReport;
  localLlmRoutingNoteApplication: DashboardLocalLlmRoutingNoteApplicationStatus;
  localLlmRoutingDecisionTimeline: DashboardLocalLlmRoutingDecisionTimeline;
  localLlmRoutingDecisionSnapshots: LocalLlmRoutingDecisionSnapshotReport;
  evaluationRuns: number;
  latestEvaluationAt: string | null;
  proposalCounts: Record<string, number>;
  highPriorityProposals: number;
  feedbackNeeded: number;
  routingProposals: number;
  promotionReady: boolean;
  readiness: string[];
  tuningOverlay: DashboardTuningOverlayStatus;
  feedbackTargets: DashboardFeedbackTarget[];
  nextCommands: string[];
};

export type DashboardModelTierExplanation = {
  tier: ModelTier;
  selectedModel: string;
  source: "env" | "catalog" | "unavailable";
  configuredModel: string;
  estimatedCostClass: "low" | "medium" | "high" | "unknown";
  policyScore: number | null;
  tierFit: number | null;
  providerAvailability: "ready" | "missing" | "not configured";
  overrideSource: string;
  candidates: Array<CatalogCandidate & { selected: boolean }>;
  excludedCount: number;
};

export type DashboardProjectDetail = {
  project: DashboardProjectSummary;
  files: Awaited<ReturnType<typeof listProjectFileSummaries>>;
  memory: Awaited<ReturnType<typeof getLatestMemory>>;
  runs: Awaited<ReturnType<typeof listWorkflowRunsForProject>>;
  contextFiles: Array<{
    label: string;
    relativePath: string;
    exists: boolean;
    preview: string;
  }>;
  initialized: boolean;
  allowWrites: boolean;
  roadmapSuggestions: RoadmapSuggestionReport | null;
  roadmapSuggestionDecisions: RoadmapSuggestionDecisionLog;
  learningDaemon: DashboardLearningDaemonStatus | null;
};

export type RoadmapSuggestionDecision = {
  suggestionId: string;
  proposalId: string | null;
  title: string;
  decision: "approved" | "deferred" | "dismissed";
  decidedAt: string;
  note: string;
};

export type RoadmapSuggestionDecisionLog = {
  kind: "agentflow_roadmap_suggestion_decisions";
  projectRootUri: string;
  updatedAt: string | null;
  decisions: RoadmapSuggestionDecision[];
};

export type DashboardQueueItem = Awaited<ReturnType<typeof listWorkflowQueue>>[number]&{liveActivity?:QueueCardActivity;waitReason?:QueueWaitReason;failedRemovalCandidates?:FailedCardRemoval[]};
export type DashboardQueueSnapshot = {
  queue: DashboardQueueItem[];
  historicalRuns: DashboardRunStatus[];
  partnerProjects: Array<{id:string;name:string;rootUri:string}>;
  partnerHistory: Record<string,QueuePartnerHistorySummary>;
};

export type DashboardRoleAuditViewResult =
  | {
    ok: true;
    projectDir: string | null;
    fileName: string;
    markdownPath: string;
    jsonPath: string | null;
    markdown: string;
    summary: DashboardRoleAuditExportSummary | null;
  }
  | { ok: false; error: string; projectDir?: string | null };

export type DashboardTrustedCommandSummary = {
  scope: "global" | "project";
  pattern: string;
  projectName?: string;
  projectRootUri?: string;
  configPath: string;
};

export type DashboardTuningOverlayStatus = {
  exists: boolean;
  path: string;
  generatedAt: string | null;
  sourceGeneratedAt: string | null;
  sourceRunsAnalyzed: number | null;
  selectedIds: string[];
  appliedProposalIds: string[];
  proposalCount: number;
  proposalKinds: Record<string, number>;
  latestAppliedAt: string | null;
  appliedEvents: number;
  duplicateAppliedEvents: number;
  error: string | null;
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

export type DashboardWorkflowStageRun = Awaited<ReturnType<typeof listWorkflowStageRunsForRuns>>[number];

export type FailedRunResolution = {
  headline: string;
  summary: string;
  instructions: string[];
  automaticRepair: "eligible" | "operator-required";
};

export type FocusedStageDeltaSummary = {
  baseline: FocusedStageOutcomeSummary;
  verification: FocusedStageOutcomeSummary;
  completedDelta: number | null;
  failedDelta: number | null;
  activeDelta: number | null;
  label: string;
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

export type GraphHandoffPayload = ReturnType<typeof buildGraphHandoffPayload>;

export type RestoreDrillCheck = {
  restoredArtifactId: string;
  restoredArtifactUri: string;
  runId: string;
  sourceArchiveUri: string | null;
  originalUri: string | null;
  status: "pass" | "warn";
  contentHashMatches: boolean;
  originalStillPresent: boolean | null;
  detail: string;
};

export type RestoreDrillReport = {
  kind: "agentflow_restore_drill_report";
  generatedAt: string;
  projectRootUri: string | null;
  limit: number;
  status: "pass" | "attention";
  services: Awaited<ReturnType<typeof checkServices>>;
  restoredSnapshotsInspected: number;
  passed: number;
  warnings: number;
  checks: RestoreDrillCheck[];
  recommendedCommands: string[];
  notes: string[];
};

export type RoadmapDashboardReport = {
  kind: "agentflow_roadmap_dashboard";
  generatedAt: string;
  roadmapPath: string;
  milestones: RoadmapMilestone[];
  tasks: RoadmapTask[];
  bugs: RoadmapTask[];
  summary: {
    milestoneCount: number;
    taskCount: number;
    bugCount: number;
    openCount: number;
    doneCount: number;
    nextCount: number;
    explicitMilestoneCount: number;
    inferredMilestoneCount: number;
    unlinkedCount: number;
    priorityCounts: Record<RoadmapPriority, number>;
  };
};

export type RoadmapMilestone = {
  number: number;
  title: string;
  workstreams: string[];
  status: string;
};

export type RoadmapMilestoneSource = "explicit" | "inferred" | "missing";

export type RoadmapPriority = "critical" | "high" | "medium" | "low";

export type RoadmapTask = {
  id: string;
  kind: RoadmapTaskKind;
  status: RoadmapTaskStatus;
  phase: string;
  title: string;
  milestoneNumber: number | null;
  milestoneTitle: string | null;
  milestoneSource: RoadmapMilestoneSource;
  priority: RoadmapPriority;
  sourceLine: number;
  details: string[];
};

export type RoadmapTaskKind = "task" | "bug";

export type RoadmapTaskStatus = "done" | "open" | "next";

export type RunDecisionExplanation = {
  title: string;
  status: "good" | "warn" | "bad";
  detail: string;
  evidence: string[];
};

export type RunUsageEstimate = {
  runId: string;
  routedStages: number;
  indexedProjectTokens: number;
  compiledBriefTokens: number;
  selectedSourceTokens: number;
  estimatedPromptTokens: number;
  estimatedBaselineTokens: number;
  estimatedTokensSaved: number;
  tokenReductionPercent: number | null;
  runDurationMs: number | null;
};

export interface ScheduleEntry {
  id: string;
  enabled?: boolean;
  every_minutes?: number;
  workflow?: string;
  agent?: string;
  task: string;
  index_max_files?: number;
  worker_limit?: number;
}

export type ServerDaemonFleetHealthReport = {
  kind: "agentflow_server_daemon_fleet_health";
  generatedAt: string;
  status: "healthy" | "attention";
  counts: { projects: number; tracked: number; excluded: number; remote: number; ephemeral: number; running: number; paused: number; disabled: number; unavailable: number; workerLanes: number; activeWorkerLanes: number; daemonLanes: number; attention: number };
  supervisor: { status: DashboardSupervisorStatus["status"]; lastHeartbeatAt: string | null; heartbeatAgeMs: number | null; message: string };
  worker: { status: DashboardWorkerStatus["status"]; lastHeartbeatAt: string | null; heartbeatAgeMs: number | null; lanes: Array<{ id: string; status: DashboardWorkerLane["status"]; lastHeartbeatAt: string | null; heartbeatAgeMs: number | null; claimed: number; completed: number; failed: number }> };
  daemonLanes: Array<{ id: string; name: string; purpose: string; trust: "low" | "medium" | "high"; status: "running" | "attention" }>;
  projects: Array<{ projectId: string; name: string; scheduling: "enabled" | "paused" | "disabled"; scope: FleetProjectScope; availabilityTracked: boolean; available: boolean; availabilityReason: string; daemonStatus: DashboardLearningDaemonStatus["status"]; mode: LearningDaemonMode; runLimit: number; heartbeatAgeMs: number | null; lastHeartbeatAt: string | null; lastError: string | null }>;
  attention: Array<{ eventId: string; severity: "warning" | "critical"; projectId: string; projectName: string; category: string; title: string; summary: string; action: string; generatedAt: string }>;
};

export type ServerOrchestrationReport = {
  kind: "agentflow_server_orchestration_report";
  generatedAt: string;
  status: "queued" | "ready" | "blocked";
  operationId: string;
  projectId: string;
  projectName: string | null;
  goalHash: string;
  workflowId: string | null;
  runGroup: { runIds: string[]; aggregateStatus: "queued" | "running" | "completed" | "blocked" | "failed" };
  receiptUri: string | null;
  reused: boolean;
  checks: Array<{ label: string; status: ServerReadinessCheckStatus; detail: string }>;
  links: { status: string; events: string; run: string | null };
};

export type ServerOrchestrationStatusReport = {
  kind: "agentflow_server_orchestration_status";
  generatedAt: string;
  operationId: string;
  projectId: string;
  status: "queued" | "leased" | "running" | "completed" | "blocked" | "failed" | "missing";
  runGroup: Array<{ runId: string; workflowId: string; status: string; startedAt: string; finishedAt: string | null }>;
  progress: {
    totalStages: number;
    completedStages: number;
    runningStages: number;
    queuedStages: number;
    blockedStages: number;
    failedStages: number;
    cancelledStages: number;
    percent: number;
    currentStages: Array<{ runId: string; stageId: string; agentId: string; status: string; attempts: number }>;
    pendingApprovals: number;
    approvals: Array<{
      approvalId: string;
      runId: string;
      stageId: string;
      actionType: string;
      target: string;
      rationale: string;
      status: string;
      allowedDecisions: Array<"approve" | "approve-and-execute" | "reject">;
      actionEndpoint: "/api/server-approval-action";
    }>;
  };
  eta: AggregateRunEta;
  cursor: string;
  result: null | { outcome: "completed" | "blocked" | "failed"; summary: string; artifactUri: string | null };
};

export type ServerRoadmapSnapshotReport = {
  kind: "agentflow_server_roadmap_snapshot";
  generatedAt: string;
  projectId: string;
  projectName: string | null;
  status: "current" | "stale" | "missing" | "invalid";
  snapshot: ServerRoadmapSnapshot | null;
  reason: string | null;
};

export type SharedStatePlaneProof = {
  kind: "agentflow_shared_state_plane_proof";
  generatedAt: string;
  status: "ready" | "attention" | "blocked";
  summary: string;
  sharedHost: string | null;
  localFallbackCanStayStopped: boolean;
  checks: Array<{
    label: string;
    status: ServerReadinessCheckStatus;
    detail: string;
  }>;
  recommendedActions: string[];
};

export type StorageMigrationPlanListing = {
  kind: "agentflow_storage_migration_plan_listing";
  generatedAt: string;
  directory: string;
  plans: Array<{
    jsonPath: string;
    markdownPath: string | null;
    scriptPath: string | null;
    generatedAt: string;
    status: string;
    mode: string;
    sourceDatabaseUrl: string;
    targetDatabaseUrl: string;
    targetObjectStorageEndpoint: string;
    targetObjectStorageBucket: string;
    warningCount: number;
    stepCount: number;
  }>;
  warnings: string[];
};

export type SupervisorHeartbeat = {
  runtimeVersion: string;
  bundleVersion: string;
  protocolVersions: CliContext["protocolVersions"];
  pid: number;
  status: "starting" | "running" | "stopping" | "stopped" | "failed";
  message: string;
  startedAt: string;
  lastHeartbeatAt: string;
  ticks: number;
  dashboardPort: number;
  dashboardManaged: boolean;
  workerManaged: boolean;
  learningManaged?: boolean;
  learningEnabled?: boolean;
  learningScope?: "project" | "all-projects";
  learningProject?: string;
  learningMode?: LearningDaemonMode;
  learningHeartbeatPath?: string;
  workerLimit: number;
  workerIntervalMs: number;
  monitorIntervalMs: number;
  command: string;
};

export type TrainingProposalEvaluationView = {
  runId: string;
  status: string;
  summary: string | null;
  artifactUri: string | null;
  evidenceHref: string | null;
  evidenceComplete: boolean;
  recoveryRunId: string | null;
  recoveryStatus: string | null;
};

export type TuningOverlayDocument = {
  kind: "agentflow_tuning_overlay";
  projectRootUri: string;
  generatedAt: string;
  sourceGeneratedAt: string;
  sourceRunsAnalyzed: number;
  selectedIds: string[];
  proposals: TuningProposalSet["proposals"];
};

export type UnifiedActivityEvent = {
  id: string;
  occurredAt: string;
  projectName: string;
  projectRootUri: string | null;
  runId: string | null;
  category: "workflow" | "stage" | "action" | "approval" | "learning" | "daemon" | "roadmap" | "server";
  eventType: string;
  severity: "info" | "warning" | "error";
  status: string;
  actor: string | null;
  title: string;
  detail: string;
  source: string;
  href: string | null;
};

export type UnifiedActivityReport = {
  kind: "agentflow_unified_activity";
  generatedAt: string;
  filters: { project: string | null; category: string | null; severity: string | null; status: string | null; query: string | null; limit: number };
  counts: { returned: number; byCategory: Record<string, number>; bySeverity: Record<string, number>; byStatus: Record<string, number> };
  events: UnifiedActivityEvent[];
  notes: string[];
};

export type WorkerHeartbeat = {
  runtimeVersion: string;
  bundleVersion: string;
  protocolVersions: CliContext["protocolVersions"];
  pid: number;
  workerId: string;
  workerLabel?: string;
  hostId?: string;
  runtimeBuildDigest?: string;
  attestation?: WorkerHeartbeatAttestation;
  projectRootUri: string | null;
  projectId?: string | null;
  projectIdentityId?: string | null;
  projectIdentityGeneration?: number | null;
  sourceRevision?: string | null;
  concurrency: number;
  perProjectConcurrency: number;
  startedAt: string;
  lastHeartbeatAt: string;
  limit: number;
  intervalMs: number;
  ticks: number;
  claimed: number;
  completed: number;
  failed: number;
  providerIds: string[];
  unavailableProviderIds: string[];
  executionCapabilities?: string[];
  executionCapabilityProbes?: Array<ExecutionCapabilityProbe&{runtimeVersion:string}>;
  executionCapabilityProbeIntervalMs?: number;
  status: "starting" | "running" | "stopping" | "stopped";
  command: string;
};
