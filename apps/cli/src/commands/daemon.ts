import { renderWorkflowGraphDashboardHtml, normalizeDashboardGraphPreset, listDashboardGraphHandoffExports, isFocusedStageVerificationRun, isFocusedStageFixRun, dashboardWorkflowGraphRunFromStorage, dashboardRunMatchesStatus, renderDashboardGraphHandoffView, loadDashboardGraphHandoffView } from "../dashboard/pages/workflow-graph/view.js";
import { renderReadinessGroup, renderSharedStatePlaneProofPanel, renderPrimaryStatePlaneOperatorPanel, renderOfflineFallbackPanel, renderPostMergeEvidencePanel, renderServerRequestAuditPanel, renderServerApprovalActionPlanPanel, renderServerMutationControlsPanel, renderServerAuthHardeningPanel, renderBackupRestoreHtml, loadBackupRestoreReport, renderArtifactLifecycleHtml, serverOrchestrationStatusIsTerminal, loadServerOrchestrationStatus, buildServerRequestBodyErrorAuditEvent, loadServerHighRiskApprovalInbox, loadServerRoadmapSnapshot, buildSharedStatePlaneProof } from "../dashboard/pages/server/view.js";
import { renderModelImprovementHtml } from "../dashboard/pages/model-improvement/view.js";
import { withoutWorkflowPrefix, dashboardRunPresentation, runsPageStatusMatches, renderRunLiveProgressScript, renderRunUsageEstimateHtml, renderObservabilityHtml, renderCostQualityHtml, renderRunDecisionExplanationsHtml, renderFeedbackHtml, runActionForm, renderFailedRunResolutionPanel, renderGovernedReusePanel, renderRunCommandCenterBody, renderRunStageTimeline, renderRunContinuationBanner, readGovernedReusePlan, buildRunDecisionExplanations, loadRunApprovalCeiling, buildRunUsageEstimate } from "../dashboard/pages/runs/view.js";
import { renderApprovalRulesHtml, loadDashboardTrustedCommands, renderBulkApprovalsHtml, renderApprovalsHtml, loadDashboardApprovalRules, approvalOneLineSummaryFromBacklog } from "../dashboard/pages/approvals/view.js";
import { renderModelCatalogHtml, fallbackDashboardModelCatalogReport, renderProvidersHtml, loadDashboardModelCatalogReport } from "../dashboard/pages/providers/view.js";
import { queueDismissAllForm, queueRecoverExpiredLeasesForm, queueProcessForm, queueItemSecondaryForms, queueItemPrimaryForms, hasExpiredLease, queueSnapshotHeaders, dashboardResultRunPath } from "../dashboard/pages/queue/view.js";
import { renderBundleTrustHtml } from "../dashboard/pages/bundles/view.js";
import { renderContextGatewayHtml } from "../dashboard/pages/context-gateway/view.js";
import { renderFleetModelUsageHtml, readBoundedDashboardResponse } from "../dashboard/pages/fleet-usage/view.js";
import { renderUnifiedActivityHtml } from "../dashboard/pages/activity/view.js";
import { renderDiscoveryHtml } from "../dashboard/pages/discovery/view.js";
import { renderProjectDetailHtml, loadDashboardProjectContextFiles, renderProjectsHtml } from "../dashboard/pages/projects/view.js";
import { renderAgentsHtml, compareAgentSummaries, loadDashboardAgentSummaries } from "../dashboard/pages/agents/view.js";
import { renderDashboardInfoHtml, renderLaunchAgentLogHtml, tailText } from "../dashboard/pages/settings/view.js";
import { renderRoadmapDashboardHtml } from "../dashboard/pages/roadmap/view.js";
import { renderRolesHtml, renderGovernanceHtml, filterGovernanceReport, renderDashboardRoleAuditView } from "../dashboard/pages/governance/view.js";
import { readRoadmapSuggestionDecisions } from "../dashboard/data/roadmap-decisions.js";
import { inspectProviderStatus, inspectBedrockStatus, loadBedrockModelIds, inspectCodexCliStatus, inspectOpenAIStatus, loadOpenAITierModelPreview, loadOpenAIModelIds } from "../dashboard/data/provider-status.js";
import { renderRuntimeMonitorPanel, renderWorkerStatusHtml, runtimeMonitorRecommendations, buildMcpCommandDiagnostics, buildMcpApprovalDiagnostics, buildMcpClientReloadGuidance, tailJsonl, agentWorkflowPluginRoot, runtimeProcessDetail, runtimeProcessGroupKey, processMatchesRuntimeRole, parseLsofListener, parseLaunchctlNumber, resolveSharedHostStorageTarget, artifactLifecyclePlanForAction, loadArtifactLifecycleReport } from "../dashboard/data/runtime-monitor.js";
import { graphPresetHref, workflowGraphDashboardHref, normalizeDashboardGraphPresetFilters, dashboardGraphPresetsPath, summarizeFocusedStageDelta } from "../dashboard/ui/graph-links.js";
import { renderRouteReceiptTrendsHtml, renderLocalRouteDecisionDrilldownHtml, renderLocalHoldoutRoutingStatusHtml } from "../dashboard/ui/routing-components.js";
import { renderFeedbackTargetActionForms, feedbackTargetActionForm, renderFeedbackTargetEvidenceHtml, loadDashboardFeedbackTargets, loadDashboardTuningOverlayStatus, renderTuningProposalsHtml } from "../dashboard/ui/feedback-components.js";
import { formatPendingApprovalNotice } from "../dashboard/ui/approval-components.js";
import { queueRunActionForm, renderRunInfoDialog, estimateQueueItemEta, dashboardRunCanProgress, workerEligibilityReason, workerEligibleForQueueProject } from "../dashboard/ui/run-actions.js";
import { readFormBody, readJsonBody, respondDashboardAction, renderDashboardActionResult, dashboardUrlFromRequest, renderDashboardLoadingPage, parseDashboardRunScope, parseDashboardRunStatusFilter } from "../dashboard/ui/http.js";
import { titleCase, formatNumber, formatSignedRate, countBy, runApprovalLevelLabel, runApprovalLevelRank, withTimeout } from "../dashboard/ui/format.js";
import { escapeHtml, dashboardNav, iconLabel, renderDashboardFlash, renderDashboardActionHistory, renderDashboardDateTime, metricCard, renderDashboardStatusPage, dashboardReturnInput, renderDashboardFlashValues } from "../dashboard/ui/layout.js";
import type { CliContext } from "../lib/context.js";
import { withClient } from "../../../../packages/storage/src/client.js";
import { finishDashboardError, workflowDisplayName } from "../dashboard-http.js";
import { runStateCounts } from "../dashboard/run-state.js";
import type { Command } from "commander";
import type { AgentImprovementEvalPlan, AgentImprovementPromotionQueue, AgentImprovementReport, ApprovalAutopilotRisk, ApprovalBacklogCategory, ArtifactLifecycleAction, DashboardActionApproval, DashboardCandidateComparisonReport, DashboardEvaluationSuite, DashboardFeedbackBucket, DashboardFeedbackInboxItem, DashboardFeedbackInboxReport, DashboardFollowUpResult, DashboardInfo, DashboardLaunchAgentStatus, DashboardLearningDaemonStatus, DashboardProjectPathResolution, DashboardProjectSummary, DashboardRoleAuditExportSummary, DashboardRunStatus, DashboardSupervisorStatus, DashboardWorkerLane, DashboardWorkerStatus, FeedbackRating, LearningActionReceiptHealth, LearningActionReceiptLog, LearningFailureTriageReport, LearningReport, LearningRouteFeedbackGroup, LearningRouteFeedbackSummary, LearningSettings, ObjectArtifactProofReport, OfflineFallbackReport, RunSummary, RuntimeMcpCleanupResult, RuntimeMonitorReport, RuntimeStaleRunReconciliationResult, ServerApprovalActionPlanReport, ServerApprovalActionTestAdapterReport, ServerMutationControlReport, ServerProjectRegistryReport, ServerReadinessReport, ServerRequestAuditReport, StorageMergeEvidenceListing, AgentImprovementPendingProject, AgentImprovementPendingSummary } from "../lib/cli-types.js";
import {countAgentImprovementPendingPromotions, renderAgentImprovementPendingBannerHtml} from "../lib/builders-learning.js";
import { approvalOneLineSummary, buildApprovalBacklogReport, dismissApprovedAction, formatApprovalAutopilotResult, parseApprovalAutopilotRisk, processDashboardApprovalRuleAction, processRequesterApprovalReply, removeProjectApprovalRule, rolePreviewForApproval, runApprovalAutopilot } from "../lib/builders-approvals.js";
import { loadContextOperatorReport } from "../lib/builders-context.js";
import { appendLearningActionRejectionReceipts, buildAgentImprovementEvalPlan, buildAgentImprovementPatchPlan, buildAgentImprovementPromotionQueue, buildDashboardLocalProviderEvidence, buildDashboardRouteReceiptTrends, buildLocalLlmCacheTrendReport, buildLocalLlmCostLedgerReport, buildLocalLlmDownloadRecommendationReport, buildLocalLlmInstallationPlanReport, buildLocalLlmInventoryReport, buildLocalLlmPrunePlanReport, buildLocalLlmRoutingRecommendationReport, buildLocalLlmSmokeOutcomeTrend, buildPromotionRoutingNotePlan, cleanupRuntimeMcpProcesses, compactLearningActionReceiptFiles, decideAgentImprovementPromotions, defaultFeedbackNote, discoverModelIds, emptyLearningActionReceipts, envFlag, formatDuration, formatDurationDelta, formatPromotionRoutingNotePlan, inspectOpenAICompatibleStatus, isProcessAlive, loadAgentImprovementReport, loadCostQualityReportsForDashboardRuns, loadDashboardCandidateComparisonReport, loadDashboardEvaluations, loadDashboardFeedbackInboxReport, loadDashboardLocalHoldoutRoutingStatus, loadLearningActionReceiptHealth, loadLearningDaemonStatus, loadLearningReport, loadLocalLlmRoutingRecommendationReport, loadLocalLlmSetupChecklistReport, loadLocalLlmSetupGuideReport, loadOpenAICompatibleModelIds, loadPreferenceScorecard, loadRoutingConfig, loadRuntimeMcpCleanupCandidates, loadTuningProposals, loadWorkflowShapeOptimization, orderedUnique, parseLearningDaemonMode, parseLearningRiskLevel, parseOfflineFallbackQueueAction, parseProposalIds, parseRuntimeMcpStaleMinutes, parseStaleRunReconcileLimit, readAgentImprovementPromotionQueue, readDashboardJsonFile, readLearningActionReceipts, readLearningApprovalQueue, readLearningSettings, readRouteDecisionFeedbackLog, recordRunFeedback, runOfflineFallbackSync, runtimeMcpCleanupConfig, staleRunReconcileConfig, summarizeWorkflowRun, uniqueSorted, writeAgentImprovementPromotionQueue, writeCandidateComparisonPlan, writeLearningActionReceipts, writeLocalLlmRoutingRecommendationReport } from "../lib/builders-learning.js";
import { buildDashboardLocalLlmRoutingDecisionTimeline, buildLocalHoldoutResultSummary, buildLocalHoldoutRoutingPromotion, buildLocalLlmBenchmarkReceiptReport, buildLocalLlmRoutingDecisionSnapshotReport, buildLocalLlmRoutingNoteApplicationPlan, buildLocalLlmRoutingNotePlan, emptyLocalHoldoutResultSummary, exportWorkflowRun, formatLocalHoldoutResultSummary, formatLocalHoldoutRoutingPromotion, formatLocalLlmBenchmarkReceiptReport, formatLocalLlmCacheTrendReport, formatLocalLlmCostLedgerReport, formatLocalLlmDownloadRecommendationReport, formatLocalLlmInstallationPlanReport, formatLocalLlmInventoryReport, formatLocalLlmPrunePlanReport, formatLocalLlmRouteSmokeResult, formatLocalLlmRoutingDecisionSnapshotReport, formatLocalLlmRoutingNoteApplicationPlan, formatLocalLlmRoutingNotePlan, formatLocalLlmRoutingRecommendationReport, formatLocalLlmSetupGuideReport, formatRouteDecisionFeedbackResult, loadDashboardLocalLlmRoutingNoteApplicationStatus, loadLocalHoldoutModelPlan, loadLocalLlmBenchmarkReceiptReport, loadLocalLlmCacheTrendReport, loadLocalLlmCostLedgerReport, loadLocalLlmInstallationPlanReport, loadLocalLlmInventoryReport, loadLocalLlmRoutingDecisionSnapshotReport, readLocalHoldoutResultSummary, readLocalLlmRoutingNotePlan, recordRouteDecisionFeedback, runLocalLlmRouteSmoke, watchWorkflowRun, writeLocalHoldoutResultSummary, writeLocalHoldoutRoutingPromotion, writeLocalLlmBenchmarkReceiptReport, writeLocalLlmDownloadRecommendationReport, writeLocalLlmInstallationPlanReport, writeLocalLlmInventoryReport, writeLocalLlmPrunePlanReport, writeLocalLlmRoutingNotePlan, writeLocalLlmSetupGuideReport } from "../lib/builders-local-llm.js";
import { adoptDiscoveredProjects, buildDashboardProjectAliasMergePlan, discoverLocalProjects, formatDiscoveryAdoptionResult, isPathInside, loadDashboardProjectIdentityGroups, parseSpotlightMode, splitCommaList } from "../lib/builders-project.js";
import { assessRunStaleInputs, createAgentTaskWorkflow, formatDashboardDateTimeText, formatIndexResult, formatRunEta, formatRunSummary, formatStaleInputWarnings, loadObservabilityReport, resolveWorkflowPreset, runDashboardAgentTask, runDashboardWorkflow, runWorkflowPreset } from "../lib/builders-runs.js";
import { buildServerApprovalActionPlanReport, buildServerApprovalActionTestAdapterReport, buildServerMutationControlReport, checkServerQueueRateLimit, firstHeader, loadRegisteredProjectConfig, loadServerApprovalActionReport, loadServerApprovalPreview, loadServerProjectRegistryReport, loadServerReadinessReport, loadServerRequestAuditLog, loadServerRequestPreview, loadServerRoutePreview, processServerQueueRequest, processSynchronousConversation, resolveServerProjectReference, safeAppendServerRequestAuditEvent, serverAuditErrorCode, serverRequestLimits, validateServerMutationAuth } from "../lib/builders-server.js";
import { approveAndExecuteAction, compactDashboardText, countStrings, ensureProjectSubdir, evaluateRoleGate, execFileText, executeApprovedAction, formatBytes, formatInlineCounts, indexProjectForRun, isExecutableApprovalAction, isOpenApproval, isRecord, lifecycleExecutionCapabilityEnabled, loadAgentsForProject, loadApprovalProjectConfig, loadCostQualityReport, loadLocalProjectConfig, normalizeActorRole, normalizeWorkerId, objectFromRecord, objectValue, pathExists, pathIsFile, queueWorkflow, resolveDashboardProjectPath, resolveLocalProjectRootUri, resumeBlockedRunAfterResolvedApprovals, shellQuote, sleep, stableHash, stringFromRecord, stringValue, truncateText, buildGraphHandoffPayload, safeDisplayUrl } from "../lib/builders-shared.js";
import { buildObjectArtifactProofReport, formatOfflineFallbackQueue, formatOfflineFallbackSyncResult, loadOfflineFallbackReport, loadStorageMergeEvidenceListing, markOfflineFallbackQueueItemSynced, queueObjectMirrorApproval, recordOfflineFallbackQueueItem, writeStorageProjectConflictDecision } from "../lib/builders-storage.js";
import { loadAutoRoutePreviews, loadGovernanceReport, loadRoleGovernanceReport, roleAuditSummaryFromPayload, safeFileSegment, updateEnvValue, writeRoleAuditSnapshot } from "../lib/builders-system.js";
import { loadAgentRecords, loadAgents, loadProjectConfig, loadWorkflowRecords, loadWorkflows } from "../../../../packages/agent-registry/src/loaders.js";
import { loadCommittedBundleManifest } from "../../../../packages/agent-registry/src/manifest.js";
import { type ProjectConfig, projectConfigSchema } from "../../../../packages/agent-registry/src/schemas.js";
import { addGlobalTrustedCommand, normalizeTrustedCommandPattern, removeGlobalTrustedCommand } from "../../../../packages/agent-registry/src/trusted-commands.js";
import { type BundleRegistryReport, type ProjectBundlePin, type ProjectBundleState, buildBundleCompatibilityReport, buildBundleLifecyclePlan, buildBundleRegistryReport, buildBundleUpgradePreview, formatBundleLifecyclePlan, loadBundleRegistry, normalizePolicy, verifyBundle, writeBundleLifecyclePlan } from "../../../../packages/bundle-trust/src/index.js";
import { buildClientCapabilityContract } from "../../../../packages/client-capabilities/src/index.js";
import { runDefinitionContractTests } from "../../../../packages/contract-tests/src/index.js";
import { type DaemonTrustSettings, classifyFleetProject, daemonLanes, defaultDaemonTrustSettings, fleetProjectAvailable } from "../../../../packages/daemon-control/src/index.js";
import { buildDaemonControlStatus } from "../../../../packages/daemon-control/src/status.js";
import { isDurableDashboardReportKey, readDashboardReportSnapshot, writeDashboardReportSnapshot } from "../../../../packages/dashboard/src/report-cache.js";
import { queueSnapshotSignature, queueWatcherScript } from "../../../../packages/dashboard/src/queue-watcher.js";
import {resolveRunExecutionRoot} from '../../../../packages/storage/src/run-pipeline.js';
import { withQueueCardActivity } from '../lib/queue-card-activity.js';
import { withQueueWaitReasons } from '../lib/queue-wait-reasons.js';
import {QueueCardSnapshotCache,type QueueCardSnapshot} from '../lib/queue-card-snapshot.js';
import {queueLatencyBudget} from '../lib/queue-latency-budget.js';
import { signWorkerHeartbeat, verifyWorkerHeartbeat, workerRuntimeBuildDigest, type WorkerHeartbeatTrustDecision, type WorkerHeartbeatTrustStore } from "../lib/worker-heartbeat-attestation.js";
import { applyWorkerHostRegistryPlan, buildWorkerHostRegistryPlan, type WorkerHostRegistryAction } from "../lib/worker-host-registry.js";
import { ingestRemoteWorkerHeartbeat, loadRemoteWorkerHeartbeatHealth } from "../lib/worker-heartbeat-ingestion.js";
import {queueCardActivityScript,renderQueueCardActivityLine} from '../dashboard/queue-card-activity.js';
import {queueCardRefreshScript} from '../dashboard/queue-card-refresh.js';
import {renderApprovalWait} from '../dashboard/approval-waits.js';
import { buildDefinitionMigrationPlan, loadDefinitionMigrationCatalog } from "../../../../packages/definition-migrations/src/index.js";
import { constructDynamicWorkflow } from "../../../../packages/dynamic-workflow/src/index.js";
import { readFleetUsageReceipts, summarizeFleetUsage } from "../../../../packages/fleet-model-gateway/src/index.js";
import { redactApprovalCardText } from "../../../../packages/governance/src/high-risk-approval-inbox.js";
import { type LearningApplicationPlan, type LearningApprovalQueue, type LearningRiskLevel, buildLearningApplicationPlan as buildGovernedLearningApplicationPlan, buildLearningApprovalQueue, decideLearningApprovals } from "../../../../packages/learning-loop/src/governance.js";
import { type LearningLoopDashboard, buildLearningLoopDashboard, readLearningLoopState, recordReviewerCalibration, reviewLearningEvidence } from "../../../../packages/learning-loop/src/index.js";
import { buildLearningProposalSet } from "../../../../packages/learning-loop/src/proposals.js";
import { executeAllowedCommand, probeCommandExecutionCapabilities, type ExecutionCapabilityProbe } from "../../../../packages/local-tools/src/command-executor.js";
import { normalizeModelSelectionPolicy } from "../../../../packages/model-providers/src/catalog.js";
import { providerFromEnv } from "../../../../packages/model-providers/src/index.js";
import { type ObservabilityReport, buildObservabilityReport } from "../../../../packages/observability/src/index.js";
import { canonicalJsonHash, resolveExecutionPolicy } from "../../../../packages/policy-engine/src/index.js";
import { resolveContainedProjectPath, type RoadmapSuggestionReport } from "../../../../packages/roadmap/src/index.js";
import { type CostQualityReport, type PreferenceScorecard, type TuningProposalSet, type WorkflowShapeOptimizationReport, buildCandidateComparisonPlan, buildTuningApplicationPlan, buildTuningProposals, formatCandidateComparisonPlan, formatTuningApplicationPlan } from "../../../../packages/run-reporter/src/index.js";
import { defaultServiceEndpoints } from "../../../../packages/storage/src/config.js";
import { checkServices } from "../../../../packages/storage/src/doctor.js";
import { type StorageMigrationPlan } from "../../../../packages/storage/src/migration-plan.js";
import { acquireWorkIntent, cancelWorkflowRun, decideActionApproval, dismissAllFailedWorkflowRuns, dismissFailedWorkflowRun, getActionApproval, getArtifactByUri, getLatestMemory, getWorkflowRunDetails, listActionApprovals, listActivityEvents, listArtifactLifecycle, listArtifacts, listProjectFileSummaries, listProjectStorageSummaries, listStaleTerminalWorkflowRuns, listWorkflowHandoffs, listWorkflowQueue, listWorkflowRuns, listWorkflowRunsForProject, listWorkflowStageHealthForRuns, listWorkflowStageRunsForRuns, reconcileStaleTerminalWorkflowRuns, recordRunAction, releaseWorkIntent, replayWorkflowRun, requestActionApproval, requeueExpiredWorkflowTaskLeases, requeueRunningWorkflowTasks, resumeWorkflowRunFromCheckpoint, retryFailedWorkflowRun, seedRegistry, setQueuedWorkflowRunAutonomy } from "../../../../packages/storage/src/postgres.js";
import { acceptanceDigest } from "../../../../packages/storage/src/acceptance.js";
import { PartnerManagedRunRecoveryError } from "../../../../packages/storage/src/managed-run-recovery.js";
import { WITHDRAW_RUN_CONFIRMATION, withdrawUnacceptedRun } from "../../../../packages/storage/src/operator-run-withdrawal.js";
import { authorizeCoordinatorHistoryAction, prepareCoordinatorHistoryAction } from "../../../../packages/storage/src/coordinator-history-archive.js";
import { legacyGuideEvidenceInventory, legacyGuideEvidenceInventoryPage, reduceLegacyGuideEvidenceSnapshot } from "../../../../packages/storage/src/queue-partner-guide-legacy-inventory.js";
import { queuePartnerGuideRegistryHoldMetrics } from "../../../../packages/storage/src/queue-partner-guide-holds.js";
import { buildQueueCardTitle } from "../../../../packages/storage/src/run-presentation.js";
import { type StorageVerificationReport, buildStorageVerificationReport } from "../../../../packages/storage/src/verification.js";
import { type WorkflowThroughputBucket, listWorkflowRunThroughput } from "../../../../packages/storage/src/workflow-throughput.js";
import { type TrainingDiscoveryReport, type TrainingProposalDecisionStatus, type TrainingProposalInbox, decideTrainingProposal, linkTrainingProposalEvaluation, readLatestTrainingDiscoveryReport, readTrainingProposalInbox } from "../../../../packages/training-discovery/src/index.js";
import { buildTrainingHoldoutDesign, isCompleteTrainingHoldoutReport, persistTrainingHoldoutDesign, readTrainingHoldoutReport } from "../training-holdout-runner.js";
import { runWorkerOnce, runWorkerWatch } from "../../../../packages/workflow-engine/src/executor.js";
import { buildWorkflowGraphReport } from "../../../../packages/workflow-inspector/src/index.js";
import { authenticateSharedBrainRequest, createAssistantIntent, optimizerDashboardReport, previewAssistantPlan, readOptimizerEvents, readOptimizerState, sharedBrainSummary } from "../../../../packages/workflow-optimizer/src/index.js";
import { inheritedCodexOrigin } from "../codex-callback.js";
import { describeAnthropicProvider, describeAnthropicProviderFast, inspectAnthropicStatus, loadGenericTierModelPreview } from "../dashboard/anthropic-provider.js";
import { codexCliModelSummary, codexCliTierModelPreview } from "../dashboard/codex-provider.js";
import { renderDaemonControl } from "../dashboard/daemon-control.js";
import { learningViewNeedsSettings, parseLearningSettingsSection, selectDaemonTrustSettings, selectLearningProjectRoot } from "../dashboard/daemon-settings.js";
import { dashboardRunDurationMs, formatDashboardDuration } from "../dashboard/home-metrics.js";
import { buildHumanInterventionItems } from "../dashboard/human-intervention.js";
import { dashboardIcon } from "../dashboard/icons.js";
import { renderLearningLoopHtml } from "../dashboard/learning-loop.js";
import { renderPreferenceScorecardHtml } from "../dashboard/outcome-accuracy.js";
import { isTrustedLocalDashboardRequest } from "../dashboard/question-chat.js";
import { renderQueuePartnerOverlay } from "../dashboard/queue-partner-overlay.js";
import {renderQueuePartnerHistory} from '../dashboard/queue-partner-history.js';
import {queueHistoryScript,renderQueueHistoryPanel} from '../dashboard/queue-history.js';
import {queueLifecyclePresentation} from '../dashboard/queue-lifecycle.js';
import {queueHistoryRangeMinutes,recordAndLoadQueueHistory} from '../lib/queue-history.js';
import { queueRemovalRefusal, parseFailedCardRemovals, removeReviewedFailedCards, withFailedCardRemovalCandidates } from '../lib/queue-removal.js';
import {discardGuideEvidenceReductionCheckpoint,guideEvidenceCheckpointStorageKey,loadOrCreateGuideEvidenceCheckpointKey,persistGuideEvidenceReductionCheckpoint,readGuideEvidenceReductionCheckpoint} from '../lib/guide-evidence-checkpoint-store.js';
import {loadQueuePartnerHistoryForRuns,type QueuePartnerHistorySummary} from '../lib/queue-partner-memory.js';
import { buildQueuePartnerActivity } from "../lib/queue-partner-activity.js";
import {readPartnerQueueObservation} from '../lib/queue-partner-observation.js';
import { buildPartnerWorkHistory } from '../lib/partner-work-history.js';
import { parsePartnerMessage, processPartnerMessage, isPartnerStatusMessage } from "../lib/queue-partner-chat.js";
import { buildPartnerConversationHistory } from "../lib/queue-partner-context.js";
import { createPartnerChatAdapter, hasPartnerApprovalEffect, isTrustedPartnerCommandRequest } from "../lib/queue-partner-chat-storage.js";
import { createQueuePartnerAdapter, createQueuePartnerRequestLedger, queuePartnerItems, queuePartnerOwner } from "../lib/queue-partner-queue.js";
import { loadPartnerProject, partnerProjectAccess } from "../lib/queue-partner-projects.js";
import type { PartnerMessage, PartnerItem } from "../lib/queue-partner-chat.js";
import { buildQueueStatusReport, parseQueueStatusProject } from "../lib/queue-status.js";
import { renderQueueStatusHtml } from "../dashboard/queue-status.js";
import { type RunEta, estimateRunEta, withWorkerAvailability } from "../dashboard/run-eta.js";
import { publicHttpError, serializeInlineScriptJson } from "../dashboard/security.js";
import { renderStudioHtml } from "../dashboard/studio.js";
import { createDevSessionFromBody, decideDevSessionApprovalFromBody, decideDevSessionDiffFromBody, getDevSessionDetail, listDevSessionsForBody, parseDevSessionPath, streamDevSessionMessage } from "./dev-session-routes.js";
import { renderProjectEvidenceHtml } from "../dashboard/project-evidence.js";
import { renderContextInfluenceHtml } from "../dashboard/context-influence.js";
import { readContextInfluence } from "../../../../packages/storage/src/context-influence.js";
import { renderEvidenceSource } from "../dashboard/project-evidence-source.js";
import { readProjectEvidenceGraph } from "../../../../packages/storage/src/project-evidence.js";
import type { ProjectEvidenceGraph } from "../../../../packages/project-evidence/src/index.js";
import { dashboardCss } from "../dashboard/styles.js";
import { resolveTrainingProjectChoices } from "../dashboard/training-projects.js";
import { parseBoundedPositiveInteger, parseDashboardRunLimit, parseNonNegativeInteger, parseOptionalNumber, parsePositiveInteger } from "../numeric-options.js";
import { type OrchestrationPlan, type OrchestrationStep, createOrchestrationPlan } from "../orchestration-plan.js";
import { normalizeLookup, normalizeProviderRef, resolveAgent, resolveWorkflow } from "../reference-resolution.js";
import { buildRunOutcomeContract } from "../run-outcome.js";
import { probeWorkerProviderCapabilities, probeWorkerProviderExecution } from "../worker-provider-capabilities.js";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWorkerIdentity } from "../../../../packages/workflow-engine/src/worker-identity.js";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import YAML from "yaml";
import type { ArtifactLifecycleActionPlan, ArtifactLifecycleApprovalActionType, ArtifactLifecycleApprovalQueue, ArtifactLifecycleReport, BackupRestoreReport, DashboardAgentSummary, DashboardAgentsReport, DashboardBundleReadiness, DashboardFleetUsageReport, DashboardGraphExportSummary, DashboardGraphPreset, DashboardGraphPresetActionResult, DashboardGraphPresetFile, DashboardHomeHealth, DashboardModelImprovementReport, DashboardProjectDetail, RoadmapSuggestionDecision, DashboardQueueItem, DashboardQueueSnapshot, DashboardRoleAuditViewResult, DashboardWorkflowGraphReport, DashboardWorkflowGraphRun, DashboardWorkflowStageHealth, DashboardWorkflowStageRun, GraphHandoffPayload, RestoreDrillCheck, RestoreDrillReport, RoadmapDashboardReport, RoadmapPriority, RoadmapTaskKind, RunUsageEstimate, ScheduleEntry, ServerDaemonFleetHealthReport, ServerOrchestrationReport, SharedStatePlaneProof, StorageMigrationPlanListing, SupervisorHeartbeat, TrainingProposalEvaluationView, UnifiedActivityEvent, UnifiedActivityReport, WorkerHeartbeat } from "./daemon-types.js";
import { cleanRoadmapFormText, parseRoadmapMilestones, parseRoadmapPriority, parseRoadmapTasks, roadmapPriorityOrder } from "../lib/roadmap-tasks.js";

export function registerDaemonCommands(program: Command, ctx: CliContext): void {
  const RUN_APPROVAL_LEVELS = ["0", "1", "2", "3", "4", "5", "wide-open"] as const;
  const acceptedRemoteHeartbeatSequence = new Map<string,string>();
  const workerTrustStorePath = path.resolve(process.env.AGENTFLOW_WORKER_TRUST_STORE ?? path.join(ctx.rootDir,".agent-workflow","runtime","trusted-worker-hosts.json"));

  async function loadWorkerTrustStore():Promise<WorkerHeartbeatTrustStore>{
    try{
      const parsed=JSON.parse(await fs.readFile(workerTrustStorePath,"utf8")) as WorkerHeartbeatTrustStore;
      return parsed?.schemaVersion===1&&Array.isArray(parsed.hosts)?parsed:{schemaVersion:1,hosts:[]};
    }catch{return {schemaVersion:1,hosts:[]};}
  }

  function evaluateWorkerHeartbeatTrust(heartbeat:Partial<WorkerHeartbeat>,trustStore:WorkerHeartbeatTrustStore):Omit<WorkerHeartbeatTrustDecision,"state">&{state:WorkerHeartbeatTrustDecision["state"]|"trusted-local"}{
    const hostId=typeof heartbeat.hostId==="string"?heartbeat.hostId:null;
    const localProcess=typeof heartbeat.pid==="number"&&isProcessAlive(heartbeat.pid)&&(hostId===null||hostId===os.hostname());
    if(localProcess)return {trusted:true,state:"trusted-local",reason:"Heartbeat belongs to a live process on this host.",hostId:hostId??os.hostname(),runtimeBuildDigest:typeof heartbeat.runtimeBuildDigest==="string"?heartbeat.runtimeBuildDigest:null,sequence:heartbeat.attestation?.sequence??null};
    const remote=verifyWorkerHeartbeat({heartbeat:heartbeat as Record<string,unknown>,trustStore,latestSequenceByHost:acceptedRemoteHeartbeatSequence});
    if(remote.trusted&&remote.hostId&&remote.sequence){
      const prior=acceptedRemoteHeartbeatSequence.get(remote.hostId);
      if(prior===undefined||BigInt(remote.sequence)>BigInt(prior))acceptedRemoteHeartbeatSequence.set(remote.hostId,remote.sequence);
    }
    return remote;
  }

  async function acquireDashboardRequestSlot(): Promise<() => void> {
    if (dashboardActiveRequests >= dashboardMaxConcurrentRequests) {
      await new Promise<void>((resolve) => dashboardRequestWaiters.push(resolve));
    }
    dashboardActiveRequests += 1;
    return () => {
      dashboardActiveRequests -= 1;
      dashboardRequestWaiters.shift()?.();
    };
  }

  async function appendRoadmapRegisterItem(form: URLSearchParams): Promise<DashboardFollowUpResult> {
    const kind: RoadmapTaskKind = form.get("kind") === "bug" ? "bug" : "task";
    const title = cleanRoadmapFormText(form.get("title") ?? "");
    if (!title) return { ok: false, error: "Roadmap item title is required." };
    const milestone = parsePositiveInteger(form.get("milestone") ?? "", 0);
    if (milestone < 1 || milestone > 12) return { ok: false, error: "Roadmap item needs a milestone from 1 through 12." };
    const priority = parseRoadmapPriority(form.get("priority") ?? "") ?? (kind === "bug" ? "high" : "medium");
    const note = cleanRoadmapFormText(form.get("note") ?? "");
    const status = form.get("status") === "done" ? "x" : " ";
    const roadmapPath = path.join(ctx.rootDir, "docs", "roadmap.md");
    const markdown = await fs.readFile(roadmapPath, "utf8");
    const marker = "\n## Contribution Boundary";
    const itemTitle = title.match(/^(Task|Bug):/iu) ? title : `${kind === "bug" ? "Bug" : "Task"}: ${title}`;
    const item = [
      `- [${status}] ${itemTitle}`,
      `  - Milestone: ${milestone}`,
      `  - Priority: ${priority}`,
      `  - Status: ${status === "x" ? "done" : "open"}`,
      ...(note ? [`  - Note: ${note}`] : []),
      ""
    ].join("\n");
    const nextMarkdown = markdown.includes(marker)
      ? markdown.replace(marker, `\n${item}${marker}`)
      : `${markdown.trimEnd()}\n\n## Roadmap Task And Bug Register\n\n${item}`;
    await fs.writeFile(roadmapPath, nextMarkdown, "utf8");
    return {
      ok: true,
      title: "Roadmap item recorded",
      output: `${itemTitle} was added to docs/roadmap.md with milestone ${milestone} and ${priority} priority.`
    };
  }

  async function decideRoadmapSuggestion(form: URLSearchParams): Promise<DashboardFollowUpResult> {
    const projectPath = await resolveDashboardProjectPath(form.get("project") ?? "");
    const projectDir = projectPath.localRootUri;
    const suggestionId = cleanRoadmapFormText(form.get("suggestionId") ?? "");
    const decision = form.get("decision");
    if (!suggestionId || !["approved", "deferred", "dismissed"].includes(decision ?? "")) {
      return { ok: false, error: "A valid roadmap suggestion and decision are required." };
    }
    const suggestionResult = await readDashboardJsonFile<RoadmapSuggestionReport>(
      path.join(projectDir, ".agent-workflow", "learning", "roadmap-suggestions.json"),
      (value) => value.kind === "agentflow_roadmap_suggestions" && Array.isArray(value.suggestions)
    );
    const suggestion = suggestionResult.value?.suggestions.find((item) => item.id === suggestionId);
    if (!suggestion) return { ok: false, error: "That suggestion is no longer present. Refresh the project page." };
    const note = cleanRoadmapFormText(form.get("note") ?? "");
    const log = await readRoadmapSuggestionDecisions(projectDir);
    const entry: RoadmapSuggestionDecision = {
      suggestionId,
      proposalId: suggestion.proposalId ?? null,
      title: suggestion.title,
      decision: decision as RoadmapSuggestionDecision["decision"],
      decidedAt: new Date().toISOString(),
      note
    };
    log.projectRootUri = projectDir;
    log.updatedAt = entry.decidedAt;
    log.decisions = [...log.decisions.filter((item) => item.suggestionId !== suggestionId), entry];
    const learningDir = path.join(projectDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
    await fs.writeFile(path.join(learningDir, "roadmap-suggestion-decisions.json"), `${JSON.stringify(log, null, 2)}\n`, "utf8");

    if (entry.decision === "approved" && suggestion.source === "learning-evidence") {
      const config = await loadProjectConfig(projectDir);
      const roadmapPath = await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: config.project.roadmap_path, label: "project.roadmap_path" });
      const markdown = await fs.readFile(roadmapPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "# Roadmap\n";
        throw error;
      });
      const normalizedTitle = suggestion.title.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
      const alreadyPresent = markdown.split(/\r?\n/u).some((line) => line.toLowerCase().replace(/[^a-z0-9]+/gu, " ").includes(normalizedTitle));
      if (!alreadyPresent) {
        const evidence = (suggestion.evidence ?? []).slice(0, 3).join("; ");
        const item = `\n- [ ] ${suggestion.title}\n  - Priority: ${suggestion.priority ?? "medium"}\n  - Source: ${suggestion.proposalId ?? suggestion.id}\n  - Rationale: ${suggestion.rationale ?? "Evidence-backed daemon proposal."}${evidence ? `\n  - Evidence: ${evidence}` : ""}\n`;
        const heading = "## Agent Workflow Suggestions";
        const nextMarkdown = markdown.includes(heading)
          ? markdown.replace(heading, `${heading}${item}`)
          : `${markdown.trimEnd()}\n\n${heading}\n${item}`;
        await fs.writeFile(roadmapPath, nextMarkdown, "utf8");
      }
    }
    return { ok: true, title: `Suggestion ${entry.decision}`, output: `${suggestion.title} was ${entry.decision}${entry.decision === "approved" ? " and added to the configured project roadmap" : ""}.` };
  }

  function artifactLifecycleApprovalActionType(action: ArtifactLifecycleAction): ArtifactLifecycleApprovalActionType {
    if (action === "archive") return "artifact_archive";
    if (action === "restore") return "artifact_restore";
    return "artifact_prune";
  }

  function buildGraphHandoffPayload(input: {
    report: DashboardWorkflowGraphReport;
    generatedAt: string;
    graphPath: string;
    filters: Record<string, string | number>;
  }) {
    const stageHealth = input.report.stageHealth.map((health) => ({
      stageId: health.stageId,
      totalTasks: health.totalTasks,
      completedTasks: health.completedTasks,
      failedTasks: health.failedTasks,
      activeTasks: health.queuedTasks + health.runningTasks,
      cancelledTasks: health.cancelledTasks
    }));
    const focusedStage = input.report.focusedStageId
      ? {
        id: input.report.focusedStageId,
        historyRows: input.report.focusedStageRuns.length,
        suggestedFixRuns: input.report.focusedStageFixRuns.map((run) => ({
          id: run.id,
          status: run.status,
          startedAt: run.startedAt
        })),
        verificationRuns: input.report.focusedStageVerificationRuns.map((run) => ({
          id: run.id,
          status: run.status,
          sourceFixRunId: stringValue(run.evaluationMetadata.sourceFixRunId),
          startedAt: run.startedAt
        })),
        delta: summarizeFocusedStageDelta(
          input.report.focusedStageRuns.filter((run) => !input.report.focusedStageVerificationRuns.some((verification) => verification.id === run.runId)),
          input.report.focusedStageRuns.filter((run) => input.report.focusedStageVerificationRuns.some((verification) => verification.id === run.runId))
        )
      }
      : null;
    return {
      kind: "agentflow_graph_handoff",
      generatedAt: input.generatedAt,
      graphPath: input.graphPath,
      filters: input.filters,
      workflow: input.report.workflow,
      project: input.report.project,
      totals: {
        ...input.report.totals,
        patternMix: countBy(input.report.stages.map((stage) => stage.pattern.type))
      },
      runs: input.report.runs.map((run) => ({
        id: run.id,
        workflowId: run.workflowId,
        status: run.status,
        projectName: run.projectName,
        projectRootUri: run.projectRootUri,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt
      })),
      stageHealth,
      focusedStage
    };
  }

  function cliOptionValue<T extends string | number | undefined>(value: T, flags: string[], fallback: T): T {
    const wasProvided = process.argv.some((arg) => flags.includes(arg) || flags.some((flag) => arg.startsWith(`${flag}=`)));
    return wasProvided ? value : fallback;
  }

  function configureDashboardResponse(request: http.IncomingMessage, response: http.ServerResponse): void {
    response.setHeader("cache-control", "no-store");
    response.setHeader("vary", "Accept-Encoding");
    if (request.method !== "GET" || !/\bgzip\b/u.test(request.headers["accept-encoding"] ?? "")) return;

    response.setHeader("content-encoding", "gzip");
    const originalEnd = response.end.bind(response);
    response.end = ((chunk?: string | Uint8Array, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) => {
      if (chunk === undefined) return originalEnd(callback ?? (typeof encodingOrCallback === "function" ? encodingOrCallback : undefined));
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
      const body = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      return originalEnd(gzipSync(body, { level: 4 }), done);
    }) as typeof response.end;
  }

  let dashboardActiveRequests = 0;

  const dashboardMaxConcurrentRequests = 6;

  const dashboardReportCache = new Map<string, { expiresAt: number; value: unknown }>();
  const dashboardReportCacheTtlMs = 30_000;
  const DASHBOARD_LOADING_WAIT_MS = 400;
  const queueCardSnapshots = new QueueCardSnapshotCache<DashboardQueueSnapshot>(750,30_000);

  const dashboardReportLoads = new Map<string, Promise<unknown>>();

  const dashboardRequestWaiters: Array<() => void> = [];

  async function deleteDashboardGraphPreset(form: URLSearchParams): Promise<DashboardGraphPresetActionResult> {
    const projectInput = form.get("project")?.trim() || "";
    const presetId = form.get("presetId")?.trim() || "";
    if (!projectInput) return { ok: false, error: "Missing project path." };
    if (!presetId) return { ok: false, error: "Missing preset id." };
    const projectDir = path.resolve(process.cwd(), projectInput);
    const presetFile = await readDashboardGraphPresets(projectDir);
    presetFile.presets = presetFile.presets.filter((preset) => preset.id !== presetId);
    await writeDashboardGraphPresets(projectDir, presetFile);
    return { ok: true, href: workflowGraphDashboardHref(form.get("workflow")?.trim() || "build-feature", projectInput, form.get("policyProfile")?.trim() || "local", {
      view: form.get("view")?.trim() || "graph",
      orientation: form.get("orientation") === "radial" ? "radial" : "horizontal",
      category: form.get("category")?.trim() || "",
      approval: form.get("approval")?.trim() || "all",
      policyStatus: form.get("policyStatus")?.trim() || "all",
      runLimit: String(parseDashboardRunLimit(form.get("runLimit") ?? "50", 50)),
      runStatus: parseDashboardRunStatusFilter(form.get("runStatus") ?? "all"),
      runScope: parseDashboardRunScope(form.get("runScope") ?? "project"),
      capture: false,
      stage: form.get("stage")?.trim() || ""
    }) };
  }

  async function describeProvider(selected: string, adapter: string): Promise<DashboardInfo["provider"]> {
    if (selected === "auto") {
      return {
        selected,
        adapter,
        model: "tier-based",
        modelEnv: "AGENTFLOW_PROVIDER_*",
        canSelectModel: false,
        availableModels: [],
        autoRoutes: await loadAutoRoutePreviews(ctx),
        providerStatuses: await loadAutoProviderStatuses(),
        routingConfig: loadRoutingConfig(ctx)
      };
    }

    if (selected === "openai") {
      const currentModel = process.env.OPENAI_MODEL || "auto";
      const discovered = await discoverModelIds(() => loadOpenAIModelIds());
      const tierModels = await loadOpenAITierModelPreview(discovered.models);
      return {
        selected,
        adapter,
        model: currentModel,
        modelEnv: "OPENAI_MODEL",
        apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
        canSelectModel: Boolean(process.env.OPENAI_API_KEY),
        availableModels: uniqueSorted(["auto", currentModel, ...discovered.models]),
        availableModelsError: discovered.error,
        tierModels,
        catalogHint: discovered.models.length
          ? "OpenAI model choices are refreshed from the live /v1/models catalog. Use auto to adopt newly available releases without editing Agent Workflow."
          : "OpenAI model choices will refresh from /v1/models after the API key can list models.",
        routingConfig: loadRoutingConfig(ctx)
      };
    }
    if (selected === "codex-cli") {
      const configuredModel = process.env.CODEX_CLI_MODEL?.trim();
      const tierModels = codexCliTierModelPreview();
      const status = await inspectCodexCliStatus();
      return {
        selected,
        adapter,
        model: codexCliModelSummary(tierModels),
        modelEnv: configuredModel ? "CODEX_CLI_MODEL" : "CODEX_CLI_MODEL_*",
        authStatus: status.apiKeyStatus,
        canSelectModel: false,
        availableModels: [...new Set(tierModels.filter((item) => item.source === "env").map((item) => item.model))],
        providerStatuses: [{ ...status, tierModels }],
        tierModels,
        catalogHint: tierModels.some((item) => item.source === "env")
          ? "Codex CLI models are pinned by workflow tier. New runs use the effective fast, standard, or reasoning model shown above."
          : "Codex CLI chooses its authenticated default model for every tier. No placeholder model value is written to configuration.",
        routingConfig: loadRoutingConfig(ctx)
      };
    }
    if (selected === "anthropic") {
      return describeAnthropicProvider(adapter, loadRoutingConfig(ctx));
    }
    if (selected === "deepseek") {
      const currentModel = process.env.DEEPSEEK_MODEL || "deepseek-flash";
      const baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
      const discovered = await discoverModelIds(() => loadOpenAICompatibleModelIds(baseUrl, process.env.DEEPSEEK_API_KEY));
      const tierModels = loadGenericTierModelPreview({ catalog: discovered.models, provider: "compatible", baseModel: currentModel, tierEnvPrefix: "DEEPSEEK_MODEL" });
      return {
        selected, adapter, model: currentModel, modelEnv: "DEEPSEEK_MODEL",
        baseUrl: safeDisplayUrl(baseUrl), apiKeyConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
        canSelectModel: Boolean(process.env.DEEPSEEK_API_KEY),
        availableModels: uniqueSorted([currentModel, ...discovered.models]),
        availableModelsError: discovered.error, tierModels,
        catalogHint: discovered.models.length
          ? "DeepSeek choices are refreshed from its hosted /models endpoint. Keep Flash in comparison routing until holdout gates pass."
          : "DeepSeek choices will refresh after DEEPSEEK_API_KEY can list models.",
        routingConfig: loadRoutingConfig(ctx)
      };
    }
    if (selected === "gemini") {
      const currentModel = process.env.GEMINI_MODEL || "gemini-3.8-flash";
      const geminiBaseUrl = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/";
      const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      const discovered = await discoverModelIds(() => loadOpenAICompatibleModelIds(geminiBaseUrl, geminiApiKey));
      const tierModels = loadGenericTierModelPreview({ catalog: discovered.models, provider: "compatible", baseModel: currentModel, tierEnvPrefix: "GEMINI_MODEL" });
      return {
        selected,
        adapter,
        model: currentModel,
        modelEnv: "GEMINI_MODEL",
        baseUrl: safeDisplayUrl(geminiBaseUrl),
        apiKeyConfigured: Boolean(geminiApiKey),
        canSelectModel: Boolean(geminiApiKey),
        availableModels: uniqueSorted(["auto", currentModel, ...discovered.models]),
        availableModelsError: discovered.error,
        tierModels,
        catalogHint: discovered.models.length
          ? "Gemini model choices are refreshed from Google's official OpenAI-compatible /models endpoint."
          : "Gemini model choices will refresh after GEMINI_API_KEY or GOOGLE_API_KEY can list models.",
        routingConfig: loadRoutingConfig(ctx)
      };
    }
    if (selected === "local") {
      const currentModel = process.env.LOCAL_MODEL_NAME || "auto";
      const localBaseUrl = process.env.LOCAL_MODEL_BASE_URL || "http://localhost:11434/v1";
      const discovered = await discoverModelIds(() => loadOpenAICompatibleModelIds(localBaseUrl, process.env.LOCAL_MODEL_API_KEY));
      const tierModels = loadGenericTierModelPreview({
        catalog: discovered.models,
        provider: "compatible",
        baseModel: currentModel,
        tierEnvPrefix: "LOCAL_MODEL"
      });
      return {
        selected,
        adapter,
        model: currentModel,
        modelEnv: "LOCAL_MODEL_NAME",
        baseUrl: safeDisplayUrl(localBaseUrl),
        apiKeyConfigured: Boolean(process.env.LOCAL_MODEL_API_KEY),
        canSelectModel: true,
        availableModels: uniqueSorted(["auto", currentModel, ...discovered.models]),
        availableModelsError: discovered.error,
        tierModels,
        catalogHint: discovered.models.length
          ? "Local model choices are refreshed from the localhost /models catalog. Use auto to adopt newly downloaded local models."
          : "Local model choices will refresh after Ollama, LM Studio, or another localhost runtime exposes /models.",
        routingConfig: loadRoutingConfig(ctx)
      };
    }
    if (selected === "byo") {
      const currentModel = process.env.BYO_MODEL_NAME || "auto";
      const discovered = await discoverModelIds(() => loadOpenAICompatibleModelIds(process.env.BYO_MODEL_BASE_URL, process.env.BYO_MODEL_API_KEY));
      const tierModels = loadGenericTierModelPreview({
        catalog: discovered.models,
        provider: "compatible",
        baseModel: currentModel,
        tierEnvPrefix: "BYO_MODEL"
      });
      return {
        selected,
        adapter,
        model: currentModel,
        modelEnv: "BYO_MODEL_NAME",
        baseUrl: safeDisplayUrl(process.env.BYO_MODEL_BASE_URL),
        apiKeyConfigured: Boolean(process.env.BYO_MODEL_API_KEY),
        canSelectModel: Boolean(process.env.BYO_MODEL_BASE_URL),
        availableModels: uniqueSorted(["auto", currentModel, ...discovered.models]),
        availableModelsError: discovered.error,
        tierModels,
        catalogHint: discovered.models.length
          ? "BYO model choices are refreshed from the endpoint /models catalog. Use auto to adopt newly available local or gateway models."
          : "BYO model choices will refresh after the endpoint exposes /models.",
        routingConfig: loadRoutingConfig(ctx)
      };
    }
    if (selected === "openai-compatible") {
      const currentModel = process.env.OPENAI_COMPATIBLE_MODEL || "auto";
      const discovered = await discoverModelIds(() => loadOpenAICompatibleModelIds(process.env.OPENAI_COMPATIBLE_BASE_URL, process.env.OPENAI_COMPATIBLE_API_KEY));
      const tierModels = loadGenericTierModelPreview({
        catalog: discovered.models,
        provider: "compatible",
        baseModel: currentModel,
        tierEnvPrefix: "OPENAI_COMPATIBLE_MODEL"
      });
      return {
        selected,
        adapter,
        model: currentModel,
        modelEnv: "OPENAI_COMPATIBLE_MODEL",
        baseUrl: safeDisplayUrl(process.env.OPENAI_COMPATIBLE_BASE_URL),
        apiKeyConfigured: Boolean(process.env.OPENAI_COMPATIBLE_API_KEY),
        canSelectModel: Boolean(process.env.OPENAI_COMPATIBLE_BASE_URL),
        availableModels: uniqueSorted(["auto", currentModel, ...discovered.models]),
        availableModelsError: discovered.error,
        tierModels,
        catalogHint: discovered.models.length
          ? "OpenAI-compatible model choices are refreshed from the endpoint /models catalog. Use auto to adopt newly available gateway models."
          : "OpenAI-compatible model choices will refresh after the endpoint exposes /models.",
        routingConfig: loadRoutingConfig(ctx)
      };
    }
    if (selected === "bedrock") {
      const currentModel = process.env.BEDROCK_MODEL_ID || process.env.BEDROCK_MODEL || "auto";
      const discovered = await discoverModelIds(() => loadBedrockModelIds());
      const tierModels = loadGenericTierModelPreview({
        catalog: discovered.models,
        provider: "bedrock",
        baseModel: currentModel,
        tierEnvPrefix: "BEDROCK_MODEL"
      });
      return {
        selected,
        adapter,
        model: currentModel,
        modelEnv: "BEDROCK_MODEL",
        awsProfile: process.env.AWS_PROFILE || "default",
        canSelectModel: true,
        availableModels: uniqueSorted(["auto", currentModel, ...discovered.models]),
        availableModelsError: discovered.error,
        tierModels,
        catalogHint: discovered.models.length
          ? "Bedrock model choices are refreshed from ListFoundationModels for your AWS region. Use auto to adopt newly available models without changing Agent Workflow."
          : "Bedrock model choices will refresh when AWS credentials and region can list foundation models.",
        routingConfig: loadRoutingConfig(ctx)
      };
    }
    if (selected === "muse") {
      const currentModel = process.env.MUSE_MODEL || "muse-spark-1.1";
      const museBaseUrl = process.env.MUSE_BASE_URL || "https://api.meta.ai/v1";
      const discovered = await discoverModelIds(() => loadOpenAICompatibleModelIds(museBaseUrl, process.env.MUSE_API_KEY));
      const tierModels = loadGenericTierModelPreview({
        catalog: discovered.models,
        provider: "compatible",
        baseModel: currentModel,
        tierEnvPrefix: "MUSE_MODEL"
      });
      return {
        selected,
        adapter,
        model: currentModel,
        modelEnv: "MUSE_MODEL",
        baseUrl: safeDisplayUrl(museBaseUrl),
        apiKeyConfigured: Boolean(process.env.MUSE_API_KEY),
        canSelectModel: true,
        availableModels: uniqueSorted(["auto", currentModel, ...discovered.models]),
        availableModelsError: discovered.error,
        tierModels,
        catalogHint: discovered.models.length
          ? "Muse model choices are refreshed from the Meta Model API /models catalog."
          : "Muse model choices will refresh from /v1/models after the API key can list models.",
        providerStatuses: await loadAutoProviderStatuses(),
        routingConfig: loadRoutingConfig(ctx)
      };
    }
    const model = selected === "kiro" ? "kiro-cli" : "mock";
    return {
      selected,
      adapter,
      model,
      canSelectModel: false,
      availableModels: [model],
      routingConfig: loadRoutingConfig(ctx)
    };
  }

  function describeProviderFast(selected: string, adapter: string): DashboardInfo["provider"] {
    const routingConfig = loadRoutingConfig(ctx);
    if (selected === "auto") {
      const openAiConfigured = Boolean(process.env.OPENAI_API_KEY);
      return {
        selected,
        adapter,
        model: "tier-based",
        modelEnv: "AGENTFLOW_PROVIDER_*",
        canSelectModel: false,
        availableModels: [],
        availableModelsError: "Live provider readiness was skipped for fast page load. Use provider-check or Providers for full validation.",
        providerStatuses: [
          {
            providerId: "openai",
            label: "OpenAI",
            configured: openAiConfigured,
            status: openAiConfigured ? "ready" : "not configured",
            model: process.env.OPENAI_MODEL || "auto",
            apiKeyStatus: openAiConfigured ? "configured" : "missing",
            details: [openAiConfigured ? "Configured; live tier model catalog is checked on the Providers page." : "OPENAI_API_KEY is not configured."]
          }
        ],
        routingConfig
      };
    }
    if (selected === "local") {
      const currentModel = process.env.LOCAL_MODEL_NAME || "auto";
      return {
        selected,
        adapter,
        model: currentModel,
        modelEnv: "LOCAL_MODEL_NAME",
        baseUrl: safeDisplayUrl(process.env.LOCAL_MODEL_BASE_URL || "http://localhost:11434/v1"),
        apiKeyConfigured: Boolean(process.env.LOCAL_MODEL_API_KEY),
        canSelectModel: true,
        availableModels: uniqueSorted(["auto", currentModel]),
        availableModelsError: "Live model listing was skipped for fast page load.",
        catalogHint: "Use the Providers page or provider-check to refresh local tier choices from Ollama, LM Studio, vLLM, or another localhost model catalog.",
        routingConfig
      };
    }
    if (selected === "openai") {
      const currentModel = process.env.OPENAI_MODEL || "auto";
      return {
        selected,
        adapter,
        model: currentModel,
        modelEnv: "OPENAI_MODEL",
        apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
        canSelectModel: Boolean(process.env.OPENAI_API_KEY),
        availableModels: uniqueSorted(["auto", currentModel]),
        availableModelsError: "Live model listing was skipped for fast page load.",
        catalogHint: "Use the Providers page or provider-check to refresh OpenAI tier choices from the live model catalog.",
        routingConfig
      };
    }
    if (selected === "codex-cli") {
      const configuredModel = process.env.CODEX_CLI_MODEL?.trim();
      const tierModels = codexCliTierModelPreview();
      return {
        selected,
        adapter,
        model: codexCliModelSummary(tierModels),
        modelEnv: configuredModel ? "CODEX_CLI_MODEL" : "CODEX_CLI_MODEL_*",
        authStatus: "Run provider-check to verify ChatGPT authentication",
        canSelectModel: false,
        availableModels: [...new Set(tierModels.filter((item) => item.source === "env").map((item) => item.model))],
        tierModels,
        catalogHint: "Provider readiness could not be refreshed in time. Tier model settings shown here still reflect this process configuration.",
        routingConfig
      };
    }
    if (selected === "anthropic") {
      return describeAnthropicProviderFast(adapter, routingConfig);
    }
    if (selected === "deepseek") {
      const currentModel = process.env.DEEPSEEK_MODEL || "deepseek-flash";
      return {
        selected, adapter, model: currentModel, modelEnv: "DEEPSEEK_MODEL",
        baseUrl: safeDisplayUrl(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1"),
        apiKeyConfigured: Boolean(process.env.DEEPSEEK_API_KEY), canSelectModel: Boolean(process.env.DEEPSEEK_API_KEY),
        availableModels: [currentModel], availableModelsError: "Live DeepSeek model listing was skipped for fast page load.",
        catalogHint: "Use the Providers page or provider-check to refresh DeepSeek choices from the hosted model catalog.", routingConfig
      };
    }
    if (selected === "gemini") {
      const currentModel = process.env.GEMINI_MODEL || "gemini-3.8-flash";
      const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      return {
        selected,
        adapter,
        model: currentModel,
        modelEnv: "GEMINI_MODEL",
        baseUrl: safeDisplayUrl(process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/"),
        apiKeyConfigured: Boolean(geminiApiKey),
        canSelectModel: Boolean(geminiApiKey),
        availableModels: uniqueSorted(["auto", currentModel]),
        availableModelsError: "Live Gemini model listing was skipped for fast page load.",
        catalogHint: "Use the Providers page or provider-check to refresh Gemini choices from Google's model catalog.",
        routingConfig
      };
    }
    if (selected === "byo") {
      const currentModel = process.env.BYO_MODEL_NAME || "auto";
      return {
        selected,
        adapter,
        model: currentModel,
        modelEnv: "BYO_MODEL_NAME",
        baseUrl: safeDisplayUrl(process.env.BYO_MODEL_BASE_URL),
        apiKeyConfigured: Boolean(process.env.BYO_MODEL_API_KEY),
        canSelectModel: Boolean(process.env.BYO_MODEL_BASE_URL),
        availableModels: uniqueSorted(["auto", currentModel]),
        availableModelsError: "Live model listing was skipped for fast page load.",
        catalogHint: "Use the Providers page or provider-check to refresh BYO tier choices from the endpoint model catalog.",
        routingConfig
      };
    }
    if (selected === "openai-compatible") {
      const currentModel = process.env.OPENAI_COMPATIBLE_MODEL || "auto";
      return {
        selected,
        adapter,
        model: currentModel,
        modelEnv: "OPENAI_COMPATIBLE_MODEL",
        baseUrl: safeDisplayUrl(process.env.OPENAI_COMPATIBLE_BASE_URL),
        apiKeyConfigured: Boolean(process.env.OPENAI_COMPATIBLE_API_KEY),
        canSelectModel: Boolean(process.env.OPENAI_COMPATIBLE_BASE_URL),
        availableModels: uniqueSorted(["auto", currentModel]),
        availableModelsError: "Live model listing was skipped for fast page load.",
        catalogHint: "Use the Providers page or provider-check to refresh OpenAI-compatible tier choices from the endpoint model catalog.",
        routingConfig
      };
    }
    if (selected === "bedrock") {
      const currentModel = process.env.BEDROCK_MODEL_ID || process.env.BEDROCK_MODEL || "auto";
      return {
        selected,
        adapter,
        model: currentModel,
        modelEnv: "BEDROCK_MODEL",
        awsProfile: process.env.AWS_PROFILE || "default",
        canSelectModel: true,
        availableModels: uniqueSorted(["auto", currentModel]),
        availableModelsError: "Live Bedrock model listing was skipped for fast page load.",
        catalogHint: "Use the Providers page or provider-check to refresh Bedrock tier choices from AWS ListFoundationModels.",
        routingConfig
      };
    }
    const model = selected === "kiro" ? "kiro-cli" : "mock";
    return {
      selected,
      adapter,
      model,
      canSelectModel: false,
      availableModels: [model],
      routingConfig
    };
  }

  async function exportDashboardWorkflowGraphHandoff(form: URLSearchParams): Promise<DashboardFollowUpResult> {
    const params = new URLSearchParams();
    const copyFields = ["workflow", "project", "policyProfile", "view", "orientation", "category", "approval", "policyStatus", "runStatus", "runLimit", "runScope", "stage"];
    for (const field of copyFields) {
      const value = form.get(field);
      if (value !== null) params.set(field, value);
    }

    const report = await loadDashboardWorkflowGraph(params);
    const projectDir = path.resolve(process.cwd(), params.get("project")?.trim() || process.env.AGENTFLOW_DASHBOARD_PROJECT || "templates/project");
    const view = params.get("view") || "graph";
    const orientation = params.get("orientation") === "radial" ? "radial" : "horizontal";
    const graphPath = workflowGraphDashboardHref(report.workflow.id, params.get("project")?.trim() || projectDir, params.get("policyProfile")?.trim() || report.project.policyProfile, {
      view,
      orientation,
      category: params.get("category")?.trim() || "",
      approval: params.get("approval")?.trim() || "all",
      policyStatus: params.get("policyStatus")?.trim() || "all",
      runLimit: String(parseDashboardRunLimit(params.get("runLimit") ?? "50", 50)),
      runStatus: report.runStatusFilter,
      runScope: report.runScope,
      capture: true,
      stage: report.focusedStageId
    });
    const generatedAt = new Date().toISOString();
    const exportDir = path.join(projectDir, ".agent-workflow", "exports", "graphs");
    const fileBase = [
      generatedAt.replace(/[:.]/g, "-"),
      safeFileSegment(report.workflow.id),
      report.focusedStageId ? safeFileSegment(report.focusedStageId) : "all-stages"
    ].join("-");
    const jsonPath = path.join(exportDir, `${fileBase}.json`);
    const markdownPath = path.join(exportDir, `${fileBase}.md`);
    const payload = buildGraphHandoffPayload({
      report,
      generatedAt,
      graphPath,
      filters: {
        view,
        orientation,
        category: params.get("category")?.trim() || "all",
        approval: params.get("approval")?.trim() || "all",
        policyStatus: params.get("policyStatus")?.trim() || "all",
        runStatus: report.runStatusFilter,
        runLimit: parseDashboardRunLimit(params.get("runLimit") ?? "50", 50),
        runScope: report.runScope,
        stage: report.focusedStageId || "all"
      }
    });
    await fs.mkdir(exportDir, { recursive: true });
    await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.writeFile(markdownPath, formatGraphHandoffMarkdown(payload), "utf8");
    return {
      ok: true,
      title: "Graph Handoff Exported",
      output: [
        `Markdown: ${markdownPath}`,
        `JSON: ${jsonPath}`,
        `Graph URL: ${graphPath}`,
        `Workflow: ${report.workflow.id}`,
        `Runs included: ${report.runs.length}`,
        report.focusedStageId ? `Focused stage: ${report.focusedStageId}` : "Focused stage: all",
        `Open: ${graphPath}`
      ].join("\n")
    };
  }

  function feedbackRatingForBucket(bucket: DashboardFeedbackBucket): FeedbackRating {
    if (bucket === "probably_accept") return "accepted";
    if (bucket === "probably_reject") return "rejected";
    return "revised";
  }

  function formatArtifactLifecycleActionPlan(plan: ArtifactLifecycleActionPlan): string[] {
    return [
      "",
      `Dry-run ${plan.action} plan:`,
      `- Candidates: ${plan.totalCandidates}`,
      `- Estimated recoverable: ${formatBytes(plan.estimatedBytesRecoverable)}`,
      `- Criteria: source=${plan.criteria.policySource} minAgeDays=${plan.criteria.minAgeDays} minBytes=${plan.criteria.minBytes} includeAudit=${plan.criteria.includeAudit} legalHold=${plan.criteria.legalHold} requireApproval=${plan.criteria.requireApproval}`,
      ...plan.notes.map((note) => `- ${note}`),
      ...plan.candidates.slice(0, 20).map((candidate) => `- ${candidate.artifactId} ${candidate.uri} (${formatBytes(candidate.contentBytes)}): ${candidate.reason} [receipt=${candidate.receiptPreview.actionType}]`)
    ];
  }

  function formatArtifactLifecycleReport(report: ArtifactLifecycleReport): string {
    const lines = [
      `Artifact lifecycle (${report.generatedAt})`,
      `Project: ${report.projectRootUri ?? "all registered projects"}`,
      `Kind: ${report.artifactKind ?? "all"}`,
      `Artifacts inspected: ${report.totalArtifacts}`,
      `Estimated JSON storage: ${formatBytes(report.estimatedBytes)}`,
      "",
      "Retention policy:",
      `- Source: ${report.retentionPolicy.source}`,
      `- Retention days: ${report.retentionPolicy.retentionDays}`,
      `- Minimum prune bytes: ${report.retentionPolicy.minPruneBytes}`,
      `- Retain audit artifacts: ${report.retentionPolicy.retainAuditArtifacts}`,
      `- Legal hold: ${report.retentionPolicy.legalHold}`,
      `- Approval required: ${report.retentionPolicy.requireApprovalForPrune}`,
      `- Archive execution enabled: ${report.retentionPolicy.allowArchiveExecution}`,
      `- Restore execution enabled: ${report.retentionPolicy.allowRestoreExecution}`,
      `- Prune execution enabled: ${report.retentionPolicy.allowPruneExecution}`,
      "",
      `By kind: ${formatInlineCounts(report.byKind) || "none"}`,
      `By age: ${formatInlineCounts(report.byAgeBucket) || "none"}`,
      `By run status: ${formatInlineCounts(report.byRunStatus) || "none"}`,
      "",
      "Review hints:",
      ...(report.reviewHints.length ? report.reviewHints.map((hint) => `- ${hint}`) : ["- No lifecycle concerns found in the inspected artifact window."]),
      ...(report.prunePlan ? [
        "",
        "Dry-run prune plan:",
        `- Candidates: ${report.prunePlan.totalCandidates}`,
        `- Estimated recoverable: ${formatBytes(report.prunePlan.estimatedBytesRecoverable)}`,
        `- Criteria: source=${report.prunePlan.criteria.policySource} minAgeDays=${report.prunePlan.criteria.minAgeDays} minBytes=${report.prunePlan.criteria.minBytes} includeAudit=${report.prunePlan.criteria.includeAudit} legalHold=${report.prunePlan.criteria.legalHold} requireApproval=${report.prunePlan.criteria.requireApproval}`,
        ...report.prunePlan.notes.map((note) => `- ${note}`),
        ...report.prunePlan.candidates.slice(0, 20).map((candidate) => `- ${candidate.artifactId} ${candidate.uri} (${formatBytes(candidate.contentBytes)}): ${candidate.reason} [receipt=${candidate.receiptPreview.actionType}]`)
      ] : []),
      ...(report.archivePlan ? formatArtifactLifecycleActionPlan(report.archivePlan) : []),
      ...(report.restorePlan ? formatArtifactLifecycleActionPlan(report.restorePlan) : []),
      ...report.approvalQueues.flatMap((queue) => [
        "",
        `Lifecycle ${queue.action} approval queue:`,
        `- Requested: ${queue.totalRequested}`,
        `- Requested by: ${queue.requestedBy} (${queue.requestedByRole})`,
        ...queue.skipped.map((item) => `- Skipped: ${item}`),
        ...queue.approvals.slice(0, 20).map((approval) => `- ${approval.approvalId} ${approval.status} ${approval.target}`)
      ]),
      "",
      "Recent artifacts:",
      ...report.recentArtifacts.slice(0, 20).map((artifact) => `- ${artifact.kind} ${artifact.uri} (${artifact.ageBucket}, ${formatBytes(artifact.contentBytes)}, ${artifact.lifecycleHint})`)
    ];
    return lines.join("\n");
  }

  function formatBackupKindCounts(counts: BackupRestoreReport["inventory"]["byKind"]): string {
    return Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, value]) => `${kind}=${value.count}/${formatBytes(value.bytes)}`)
      .join(", ");
  }

  function formatBackupRestoreReport(report: BackupRestoreReport): string {
    return [
      `Backup and restore readiness (${report.generatedAt})`,
      `Project: ${report.projectRootUri ?? "all registered projects"}`,
      `Status: ${report.restoreDrill.status}`,
      "",
      "Services:",
      ...report.services.map((service) => `- ${service.endpoint.name}: ${service.reachable ? "OK" : "MISSING"} (${service.message})`),
      "",
      "Inventory:",
      `- Projects: ${report.inventory.projects}`,
      `- Runs: ${report.inventory.runs} (${report.inventory.completedRuns} completed, ${report.inventory.failedRuns} failed, ${report.inventory.queuedRuns + report.inventory.runningRuns} active)`,
      `- Context: ${report.inventory.indexedFiles} indexed files, ${report.inventory.indexedTokens} estimated tokens, ${report.inventory.memoryItems} memory items`,
      `- Artifacts: ${report.inventory.artifacts} inspected, ${formatBytes(report.inventory.estimatedArtifactBytes)} estimated JSON payload`,
      `- Archive snapshots: ${report.inventory.archivedArtifacts}`,
      `- Restore snapshots: ${report.inventory.restoredArtifacts}`,
      `- Artifact kinds: ${formatBackupKindCounts(report.inventory.byKind) || "none"}`,
      "",
      "Restore drill checks:",
      ...report.restoreDrill.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
      "",
      "Recommended commands:",
      ...report.recommendedCommands.map((command) => `- ${command}`),
      "",
      "Notes:",
      ...(report.notes.length ? report.notes.map((note) => `- ${note}`) : ["- No backup or restore drill concerns found in the inspected window."])
    ].join("\n");
  }

  function formatGraphHandoffMarkdown(payload: GraphHandoffPayload): string {
    const stageRows = payload.stageHealth.map((stage) => (
      `| ${stage.stageId} | ${stage.totalTasks} | ${stage.completedTasks} | ${stage.failedTasks} | ${stage.activeTasks} | ${stage.cancelledTasks} |`
    )).join("\n") || "| none | 0 | 0 | 0 | 0 | 0 |";
    const runRows = payload.runs.slice(0, 20).map((run) => (
      `| ${run.id} | ${run.workflowId} | ${run.status} | ${run.projectName} | ${run.startedAt} |`
    )).join("\n") || "| none | none | none | none | none |";
    const focused = payload.focusedStage
      ? [
        "## Focused Stage",
        "",
        `Stage: ${payload.focusedStage.id}`,
        `History rows: ${payload.focusedStage.historyRows}`,
        `Suggested fix runs: ${payload.focusedStage.suggestedFixRuns.length}`,
        `Verification reruns: ${payload.focusedStage.verificationRuns.length}`,
        `After signal: ${payload.focusedStage.delta.label}`,
        `Completed delta: ${formatSignedRate(payload.focusedStage.delta.completedDelta) || "n/a"}`,
        `Failed delta: ${formatSignedRate(payload.focusedStage.delta.failedDelta) || "n/a"}`,
        ""
      ].join("\n")
      : "";
    return [
      `# Agent Workflow Graph Handoff`,
      "",
      `Generated: ${payload.generatedAt}`,
      `Graph URL: ${payload.graphPath}`,
      `Workflow: ${payload.workflow.id} (${payload.workflow.name})`,
      `Project: ${payload.project.name}`,
      "",
      "## Filters",
      "",
      ...Object.entries(payload.filters).map(([key, value]) => `- ${key}: ${value}`),
      "",
      "## Totals",
      "",
      `- stages: ${payload.totals.stages}`,
      `- subagent links: ${payload.totals.subagentLinks}`,
      `- approval stages: ${payload.totals.approvalStages}`,
      `- blocked stages: ${payload.totals.blockedStages}`,
      `- context budget tokens: ${payload.totals.contextBudgetTokens}`,
      `- runs: ${payload.runs.length}`,
      `- pattern mix: ${Object.entries(payload.totals.patternMix).map(([pattern, count]) => `${pattern}=${count}`).join(", ") || "none"}`,
      "",
      focused,
      "## Stage Health",
      "",
      "| Stage | Tasks | Completed | Failed | Active | Cancelled |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      stageRows,
      "",
      "## Runs",
      "",
      "| Run | Workflow | Status | Project | Started |",
      "| --- | --- | --- | --- | --- |",
      runRows,
      payload.runs.length > 20 ? `\n${payload.runs.length - 20} additional runs are available in the JSON export.` : "",
      ""
    ].filter((line) => line !== undefined).join("\n");
  }

  function formatMcpPipelineStatus(pipeline: RuntimeMonitorReport["mcpPipeline"]): string {
    const launcherEvents = pipeline.lastLauncherEvents.slice(-5).map((event) => `- ${String(event.ts ?? "")} ${String(event.event ?? "")} ${compactDashboardText(JSON.stringify(event), 300)}`);
    const stdioEvents = pipeline.lastStdioEvents.slice(-5).map((event) => `- ${String(event.ts ?? "")} ${String(event.event ?? "")} ${compactDashboardText(JSON.stringify(event), 300)}`);
    return [
      `MCP pipeline: ${pipeline.status}`,
      `Plugin enabled: ${pipeline.pluginEnabled ? "yes" : "no"}`,
      `Launcher: ${pipeline.launcherExists ? "found" : "missing"}${pipeline.launcherExecutable ? ", executable" : ""}`,
      `Repo: ${pipeline.resolvedRepo ?? "not resolved"}`,
      `Built server: ${pipeline.serverBuilt ? "yes" : "no"}`,
      `Last spawn: ${pipeline.lastSpawnAt ?? "none"}`,
      `Last exit: ${pipeline.lastExitAt ?? "none"}${pipeline.lastExitCode === null ? "" : ` code=${pipeline.lastExitCode}`}`,
      `Smoke: ${pipeline.smoke.status} - ${pipeline.smoke.message}`,
      `Command: ${pipeline.smoke.command}`,
      `Client reload: ${pipeline.clientReload.summary}`,
      ...pipeline.clientReload.steps.map((step) => `- ${step}`),
      `Approval diagnostics: ${pipeline.approvalDiagnostics.summary}`,
      `Approval fallback: ${pipeline.approvalDiagnostics.fallbackCommand}`,
      `Recovery package: ${pipeline.recovery.status}${pipeline.recovery.lastWrittenAt ? ` (${pipeline.recovery.lastWrittenAt})` : ""}`,
      `Recovery command: ${pipeline.recovery.writeCommand}`,
      `Recovery runbook: ${pipeline.recovery.markdownPath}`,
      "",
      "Recent launcher events:",
      ...(launcherEvents.length ? launcherEvents : ["- none"]),
      "",
      "Recent stdio events:",
      ...(stdioEvents.length ? stdioEvents : ["- none"])
    ].join("\n");
  }

  function formatMcpRecoveryMarkdown(payload: {
    generatedAt: string;
    repo: string;
    status: string;
    smoke: RuntimeMonitorReport["mcpPipeline"]["smoke"];
    clientReload: RuntimeMonitorReport["mcpPipeline"]["clientReload"];
    approvalDiagnostics: RuntimeMonitorReport["mcpPipeline"]["approvalDiagnostics"];
    logs: { launcher: string; stdio: string };
    recentLauncherEvents: Array<Record<string, unknown>>;
    recentStdioEvents: Array<Record<string, unknown>>;
    safeCommands: string[];
    note: string;
  }): string {
    const launcherEvents = payload.recentLauncherEvents.slice(-6).map((event) => `- ${String(event.ts ?? "")} ${String(event.event ?? "")}`).join("\n") || "- none";
    const stdioEvents = payload.recentStdioEvents.slice(-6).map((event) => `- ${String(event.ts ?? "")} ${String(event.event ?? "")}`).join("\n") || "- none";
    const commands = payload.safeCommands.map((command) => `- \`${command}\``).join("\n");
    const steps = payload.clientReload.steps.map((step) => `- ${step}`).join("\n");
    return `# MCP Recovery Package

  Generated: ${payload.generatedAt}

  Repository: \`${payload.repo}\`

  ## Current Signal

  - Pipeline: ${payload.status}
  - Smoke: ${payload.smoke.status} - ${payload.smoke.message}
  - Approval diagnostics: ${payload.approvalDiagnostics.summary}
  - Recovery boundary: ${payload.note}

  ## Recovery Steps

  ${steps}

  ## Safe Commands

  ${commands}

  ## Logs

  - Launcher: \`${payload.logs.launcher}\`
  - Stdio: \`${payload.logs.stdio}\`

  ## Recent Launcher Events

  ${launcherEvents}

  ## Recent Stdio Events

  ${stdioEvents}
  `;
  }

  function formatMcpRecoveryScript(): string {
    return `#!/usr/bin/env bash
  set -euo pipefail
  cd ${JSON.stringify(ctx.rootDir)}
  echo "Agent Workflow MCP recovery"
  echo
  echo "1. Checking launcher smoke..."
  npm run runtime-monitor -- --check-mcp
  echo
  echo "2. Previewing stale MCP sessions..."
  npm run runtime-monitor -- --cleanup-mcp || true
  echo
  echo "If the smoke check passed but Codex or your IDE still reports 'Transport closed', reload that client/task so it creates a fresh stdio MCP subprocess."
  echo "If stale duplicate MCP sessions are listed, run:"
  echo "  npm run runtime-monitor -- --cleanup-mcp --confirm --auto-low-risk"
  `;
  }

  async function formatPendingApprovalInboxNotice(projectRootUri?: string): Promise<string> {
    const approvals = await listActionApprovals({
      projectRootUri,
      status: "pending",
      limit: 5
    });
    if (!approvals.length) {
      return "";
    }

    const lines = [
      `Approval required: ${approvals.length} pending side effect${approvals.length === 1 ? "" : "s"} need a decision.`,
      "The workflow may continue around them, but these requested actions will stay skipped until approved."
    ];
    for (const approval of approvals) {
      const executable = isExecutableApprovalAction(approval.actionType);
      lines.push(
        `- ${approval.actionType} ${approval.target}`,
        `  run: ${approval.runId}`,
        `  id: ${approval.id}`,
        `  approve: npm run agentflow -- approvals --approve ${approval.id} --actor "Your Name" --actor-role approver`,
        executable ? `  approve and execute: npm run agentflow -- approvals --approve-execute ${approval.id} --actor "Your Name" --actor-role approver` : "",
        approval.actionType === "local_command" || approval.actionType === "file_write" || approval.actionType === "executor_adapter" ? `  always exact: npm run agentflow -- approvals --always ${approval.id} --always-scope exact --actor "Your Name" --actor-role approver` : "",
        approval.actionType === "local_command" || approval.actionType === "file_write" ? `  always broad: npm run agentflow -- approvals --always ${approval.id} --always-scope broad --actor "Your Name" --actor-role approver` : "",
        executable ? `  execute: npm run agentflow -- approvals --execute ${approval.id} --actor "Your Name" --actor-role operator` : "",
        "  MCP/Codex: ask the user to choose approve and execute, approve only, reject, always exact, always broad, execute, or dismiss; then call agentflow_approvals with the matching field and id."
      );
    }
    return lines.filter(Boolean).join("\n");
  }

  function formatRestoreDrillReport(report: RestoreDrillReport): string {
    return [
      `Restore drill (${report.generatedAt})`,
      `Project: ${report.projectRootUri ?? "all registered projects"}`,
      `Status: ${report.status}`,
      `Restored snapshots inspected: ${report.restoredSnapshotsInspected}`,
      `Passed: ${report.passed}`,
      `Warnings: ${report.warnings}`,
      "",
      "Services:",
      ...report.services.map((service) => `- ${service.endpoint.name}: ${service.reachable ? "OK" : "MISSING"} (${service.message})`),
      "",
      "Lineage checks:",
      ...(report.checks.length ? report.checks.map((check) => [
        `- ${check.status.toUpperCase()} ${check.restoredArtifactId}`,
        `  restored: ${check.restoredArtifactUri}`,
        `  archive: ${check.sourceArchiveUri ?? "missing"}`,
        `  original: ${check.originalUri ?? "missing"}${check.originalStillPresent === null ? "" : ` (${check.originalStillPresent ? "present" : "not present"})`}`,
        `  content hash: ${check.contentHashMatches ? "match" : "mismatch"}`,
        `  detail: ${check.detail}`
      ].join("\n")) : ["- No restored artifact snapshots found."]),
      "",
      "Recommended commands:",
      ...report.recommendedCommands.map((command) => `- ${command}`),
      "",
      "Notes:",
      ...(report.notes.length ? report.notes.map((note) => `- ${note}`) : ["- No restore drill notes."])
    ].join("\n");
  }

  function formatRoadmapAuditReport(report: RoadmapDashboardReport): string {
    const unlinked = report.tasks.filter((task) => task.milestoneSource === "missing");
    const inferred = report.tasks.filter((task) => task.milestoneSource === "inferred");
    return [
      `Roadmap audit (${report.generatedAt})`,
      `Path: ${report.roadmapPath}`,
      "",
      "Summary:",
      `- milestones: ${report.summary.milestoneCount}`,
      `- tasks/bugs: ${report.summary.taskCount}`,
      `- explicit milestone links: ${report.summary.explicitMilestoneCount}`,
      `- inferred milestone links: ${report.summary.inferredMilestoneCount}`,
      `- unlinked items: ${report.summary.unlinkedCount}`,
      "",
      "Unlinked items:",
      ...(unlinked.length ? unlinked.map((task) => `- docs/roadmap.md:${task.sourceLine} ${task.title}`) : ["- none"]),
      "",
      "Inferred links to review:",
      ...(inferred.slice(0, 25).map((task) => `- docs/roadmap.md:${task.sourceLine} milestone ${task.milestoneNumber}: ${task.title}`)),
      ...(inferred.length > 25 ? [`- ${inferred.length - 25} more inferred item(s)`] : []),
      "",
      unlinked.length
        ? "Result: attention needed. Add explicit Milestone lines for unlinked roadmap rows."
        : "Result: pass. Every roadmap row is linked to a milestone explicitly or by inference."
    ].join("\n");
  }

  function formatRuntimeMcpCleanupResult(result: RuntimeMcpCleanupResult): string {
    const candidateRows = result.candidates.map((candidate) => `- ${candidate.pid} parent=${candidate.parentPid ?? "n/a"} risk=${candidate.risk} autoCleanable=${candidate.autoCleanable ? "yes" : "no"} age=${candidate.ageMs === null ? "n/a" : formatDuration(candidate.ageMs)}\n  ${candidate.reason}\n  ${candidate.command}`);
    const terminatedRows = result.terminated.map((item) => `- ${item.pid}: ${item.status} (${item.message})`);
    return [
      `MCP cleanup ${result.mode} (${result.generatedAt})`,
      "",
      "Candidates:",
      ...(candidateRows.length ? candidateRows : ["- none"]),
      "",
      "Terminated:",
      ...(terminatedRows.length ? terminatedRows : ["- none; rerun with --confirm to terminate candidates."]),
      "",
      "Warnings:",
      ...(result.warnings.length ? result.warnings.map((warning) => `- ${warning}`) : ["- none"])
    ].join("\n");
  }

  function formatRuntimeMonitorReport(report: RuntimeMonitorReport): string {
    return [
      `Runtime monitor (${report.generatedAt})`,
      `shared host/shared host: ${report.sharedHost.host ?? "not configured"} (${report.sharedHost.source})`,
      `shared host/shared storage: ${report.sharedHost.reachable ? "reachable" : "attention"}`,
      `Docker: ${report.docker.status} - ${report.docker.message}`,
      "",
      "shared host/shared services:",
      ...(report.sharedHost.services.length ? report.sharedHost.services.map((service) => `- ${service.endpoint.name}: ${service.reachable ? "OK" : "MISSING"} (${service.message})`) : ["- No shared storage host configured."]),
      "",
      "Local service listeners:",
      ...report.ports.map((port) => `- ${port.label} :${port.port}: ${port.status}${port.pid ? ` pid=${port.pid} ${port.command}` : ""}`),
      "",
      "Agent Workflow processes:",
      ...report.processes.map((processGroup) => `- ${processGroup.role}: ${processGroup.count} (${processGroup.detail})`),
      "",
      "Local model runtime:",
      `- runtime: ${report.localModelRuntime.runtime}`,
      `- service: ${report.localModelRuntime.serviceStatus}${report.localModelRuntime.pid ? ` pid=${report.localModelRuntime.pid}` : ""}`,
      `- endpoint: ${report.localModelRuntime.endpointHealthy ? "healthy" : "attention"} (${report.localModelRuntime.endpoint})`,
      `- models: ${report.localModelRuntime.modelCount}; selected=${report.localModelRuntime.selectedModel}`,
      `- guidance: ${report.localModelRuntime.guidance}`,
      "",
      "MCP pipeline:",
      `- status: ${report.mcpPipeline.status}`,
      `- plugin enabled: ${report.mcpPipeline.pluginEnabled ? "yes" : "no"}`,
      `- launcher: ${report.mcpPipeline.launcherExists ? "found" : "missing"}${report.mcpPipeline.launcherExecutable ? ", executable" : ""}`,
      `- repo: ${report.mcpPipeline.resolvedRepo ?? "not resolved"}`,
      `- built server: ${report.mcpPipeline.serverBuilt ? "yes" : "no"}`,
      `- last spawn: ${report.mcpPipeline.lastSpawnAt ?? "none"}`,
      `- last exit: ${report.mcpPipeline.lastExitAt ?? "none"}${report.mcpPipeline.lastExitCode === null ? "" : ` code=${report.mcpPipeline.lastExitCode}`}`,
      `- smoke: ${report.mcpPipeline.smoke.status} (${report.mcpPipeline.smoke.message})`,
      `- smoke command: ${report.mcpPipeline.smoke.command}`,
      `- client reload: ${report.mcpPipeline.clientReload.summary}`,
      `- approval diagnostics: ${report.mcpPipeline.approvalDiagnostics.summary}`,
      `- command diagnostics: ${report.mcpPipeline.commandDiagnostics.summary}`,
      `- recovery package: ${report.mcpPipeline.recovery.status}${report.mcpPipeline.recovery.lastWrittenAt ? ` (${report.mcpPipeline.recovery.lastWrittenAt})` : ""}`,
      `- recovery command: ${report.mcpPipeline.recovery.writeCommand}`,
      "",
      "Stale terminal runs:",
      `- candidates: ${report.staleRuns.candidateCount}`,
      `- auto reconcile: ${report.staleRuns.autoReconcile.enabled ? "on" : "off"} (limit ${report.staleRuns.autoReconcile.limit})`,
      `- preview: ${report.staleRuns.previewCommand}`,
      `- execute: ${report.staleRuns.executeCommand}`,
      "",
      "Recommendations:",
      ...report.recommendations.map((note) => `- ${note}`)
    ].join("\n");
  }

  function formatRuntimeStaleRunReconciliationResult(result: RuntimeStaleRunReconciliationResult): string {
    const candidateRows = result.candidates.map((candidate) => `- ${candidate.runId}: ${candidate.runStatus} -> ${candidate.recommendedStatus} (${candidate.workflowId}) ${candidate.completedTasks}/${candidate.totalTasks} completed, ${candidate.cancelledTasks} cancelled\n  ${candidate.task}\n  ${candidate.projectRootUri}`);
    const reconciledRows = result.reconciled.map((item) => `- ${item.runId}: ${item.updated ? "updated" : "skipped"} as ${item.status}`);
    return [
      `Stale run reconciliation ${result.mode} (${result.generatedAt})`,
      "",
      "Candidates:",
      ...(candidateRows.length ? candidateRows : ["- none"]),
      "",
      "Reconciled:",
      ...(reconciledRows.length ? reconciledRows : ["- none; rerun with --confirm to update eligible runs."])
    ].join("\n");
  }

  async function handleDashboardRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    configureDashboardResponse(request, response);
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST" && requestUrl.pathname.startsWith("/api/bundle")) {
      for (const key of [...dashboardReportCache.keys()]) if (key.startsWith("bundles:")) dashboardReportCache.delete(key);
    }
    const brandingAsset = {
      "/assets/agent-workflow-logo.png": "agent-workflow-logo-v1.png",
      "/assets/agent-workflow-mark.png": "agent-workflow-mark-v1.png",
      "/assets/agent-workflow-favicon.png": "agent-workflow-favicon-v1.png"
    }[requestUrl.pathname];
    if (brandingAsset) {
      const asset = await fs.readFile(path.join(ctx.rootDir, "docs", "assets", "branding", brandingAsset));
      response.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      response.end(asset);
      return;
    }
    if (requestUrl.pathname === "/assets/queue-watcher.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(queueWatcherScript());
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/run-worker") {
      const form = await readFormBody(request);
      const result = await processDashboardRun({
        runId: form.get("runId") ?? "",
        mode: form.get("mode") ?? "batch",
        workerLimit: form.get("workerLimit") ?? "",
        workerConcurrency: form.get("workerConcurrency") ?? "",
        timeoutMs: form.get("timeoutMs") ?? ""
      });
      respondDashboardAction(request, response, form, result, dashboardResultRunPath(result, "/queue"));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/learning-loop-evidence") {
      const form = await readFormBody(request);
      try {
        const projectPath = await resolveDashboardProjectPath(form.get("project") ?? "");
        await reviewLearningEvidence({
          projectDir: projectPath.localRootUri,
          questionId: form.get("questionId") ?? "",
          deterministicReceipt: form.get("deterministicReceipt") ?? "",
          deterministicChecksPassed: form.get("deterministicChecksPassed") === "on",
          humanFeedbackConfirmed: form.get("humanFeedbackConfirmed") === "on",
          confirmedBy: form.get("confirmedBy") ?? "dashboard-operator"
        });
        respondDashboardAction(request, response, form, { ok: true, title: "Learning evidence gates updated", output: "The aggregate was recomputed from durable evidence and current reviewer calibration." }, "/learning?view=learning-loop");
      } catch (error) {
        respondDashboardAction(request, response, form, { ok: false, error: error instanceof Error ? error.message : String(error) }, "/learning?view=learning-loop");
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/learning-approval-decision") {
      const form = await readFormBody(request);
      try {
        const projectPath = await resolveDashboardProjectPath(form.get("project") ?? "");
        const approvalId = form.get("approvalId") ?? "";
        const decision = form.get("decision") ?? "";
        if (!approvalId || (decision !== "approved" && decision !== "rejected")) {
          throw new Error("Missing approvalId or invalid decision");
        }
        const queue = await readLearningApprovalQueue(projectPath.localRootUri);
        const result = decideLearningApprovals({
          queue,
          ids: [approvalId],
          status: decision as "approved" | "rejected",
          reviewer: "dashboard-operator",
          note: `Decision via dashboard: ${decision}`
        });
        const queuePath = path.join(projectPath.localRootUri, ".agent-workflow", "learning", "approval-inbox.json");
        await fs.writeFile(queuePath, JSON.stringify(result.queue, null, 2), "utf8");
        respondDashboardAction(request, response, form, { ok: true, title: `Proposal ${decision}`, output: `Learning proposal ${approvalId} marked as ${decision}.` }, "/learning?view=approvals");
      } catch (error) {
        respondDashboardAction(request, response, form, { ok: false, error: error instanceof Error ? error.message : String(error) }, "/learning?view=approvals");
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/learning-loop-calibration") {
      const form = await readFormBody(request);
      try {
        const projectPath = await resolveDashboardProjectPath(form.get("project") ?? "");
        await recordReviewerCalibration(projectPath.localRootUri, {
          reviewerAgentId: form.get("reviewerAgentId")?.trim() ?? "",
          sampleCount: parsePositiveInteger(form.get("sampleCount") ?? "0", 0),
          verifiedAgreement: Number(form.get("verifiedAgreement")),
          humanAgreement: Number(form.get("humanAgreement"))
        });
        respondDashboardAction(request, response, form, { ok: true, title: "Reviewer calibration recorded", output: "Affected learning conclusions were recomputed." }, "/learning?view=learning-loop");
      } catch (error) {
        respondDashboardAction(request, response, form, { ok: false, error: error instanceof Error ? error.message : String(error) }, "/learning?view=learning-loop");
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/run-approval-level") {
      const form = await readFormBody(request);
      const result = await processDashboardRunApprovalLevel({
        runId: form.get("runId") ?? "",
        level: form.get("level") ?? "",
        reason: form.get("reason") ?? ""
      });
      respondDashboardAction(request, response, form, result, dashboardResultRunPath(result, `/run?id=${encodeURIComponent(form.get("runId") ?? "")}`));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/queue-action") {
      const form = await readFormBody(request);
      const result = await processDashboardQueueAction({
        action: form.get("action") ?? "",
        runId: form.get("runId") ?? "",
        workerLimit: form.get("workerLimit") ?? "",
        workerConcurrency: form.get("workerConcurrency") ?? "",
        project: form.get("project") ?? "",
        reason: form.get("reason") ?? "",
        removals:form.get('removals')??'',expectedTaskDigest:form.get('expectedTaskDigest')??undefined,
        confirmed: form.get("confirmed") === "on"
      });
      const removalAction=['withdraw-unaccepted','remove-failed-visible'].includes(form.get('action')??'');
      if(removalAction&&result.ok)queueCardSnapshots.invalidate();
      respondDashboardAction(request, response, form, result, removalAction?'/queue':dashboardResultRunPath(result, "/queue"));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/approval-action") {
      const form = await readFormBody(request);
      const result = await processDashboardApprovalAction({
        approvalId: form.get("approvalId") ?? "",
        decision: form.get("decision") ?? "",
        actorRole: form.get("actorRole") ?? "",
        note: form.get("note") ?? ""
      });
      respondDashboardAction(request, response, form, result, "/approvals");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/approval-bulk-action") {
      const form = await readFormBody(request);
      const decision = form.get("decision") ?? "";
      const result = await processDashboardBulkApprovalAction({
        approvalIds: form.getAll("approvalId"),
        actorRole: form.get("actorRole") ?? "",
        note: form.get("note") ?? "",
        executeAfterApproval: decision === "approve_execute" || form.get("executeAfterApproval") === "on"
      });
      respondDashboardAction(request, response, form, result, "/approvals");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/approval-autopilot") {
      const form = await readFormBody(request);
      const result = await processDashboardApprovalAutopilotAction({
        project: form.get("project") ?? "",
        runId: form.get("runId") ?? "",
        limit: form.get("limit") ?? "",
        maxRisk: form.get("maxRisk") ?? "",
        execute: form.get("execute") === "on"
      });
      respondDashboardAction(request, response, form, result, "/approvals");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/approval-triage-action") {
      const form = await readFormBody(request);
      const result = await processDashboardApprovalTriageAction(form);
      respondDashboardAction(request, response, form, result, "/approvals");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/approval-rule-action") {
      const form = await readFormBody(request);
      const result = await processDashboardApprovalRuleAction(ctx, {
        approvalId: form.get("approvalId") ?? "",
        target: form.get("target") ?? "",
        actorRole: form.get("actorRole") ?? "",
        note: form.get("note") ?? "",
        approveCurrent: form.get("approveCurrent") === "on"
      });
      respondDashboardAction(request, response, form, result, "/approvals");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/approval-rule-remove") {
      const form = await readFormBody(request);
      const result = await removeProjectApprovalRule({
        projectRootUri: form.get("project") ?? "",
        ruleId: form.get("ruleId") ?? "",
        actor: "dashboard"
      });
      respondDashboardAction(request, response, form, result, "/approval-rules");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/trusted-command-add") {
      const form = await readFormBody(request);
      const result = await processDashboardTrustedCommand(form, "add");
      respondDashboardAction(request, response, form, result, "/approval-rules");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/trusted-command-remove") {
      const form = await readFormBody(request);
      const result = await processDashboardTrustedCommand(form, "remove");
      respondDashboardAction(request, response, form, result, "/approval-rules");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/artifact-lifecycle-action") {
      const form = await readFormBody(request);
      const result = await processDashboardArtifactLifecycleAction({
        action: form.get("action") ?? "",
        project: form.get("project") ?? "",
        kind: form.get("kind") ?? "",
        limit: form.get("limit") ?? "",
        minAgeDays: form.get("minAgeDays") ?? "",
        minBytes: form.get("minBytes") ?? "",
        includeAudit: form.get("includeAudit") === "true",
        actorRole: form.get("actorRole") ?? ""
      });
      respondDashboardAction(request, response, form, result, "/artifact-lifecycle");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/workflow-run") {
      const form = await readFormBody(request);
      const result = await queueDashboardWorkflowRun({
        workflowId: form.get("workflowId") ?? "",
        project: form.get("project") ?? "",
        task: form.get("task") ?? "",
        sourceTokenBudget: form.get("sourceTokenBudget") ?? "",
        sourceMaxFiles: form.get("sourceMaxFiles") ?? "",
        watch: form.get("watch") === "on",
        workerLimit: form.get("workerLimit") ?? "",
        workerConcurrency: form.get("workerConcurrency") ?? "",
        timeoutMs: form.get("timeoutMs") ?? ""
      });
      respondDashboardAction(request, response, form, result, dashboardResultRunPath(result, "/"));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/studio-task") {
      const form = await readFormBody(request);
      const project = form.get("project") ?? "";
      const task = form.get("task") ?? "";
      const requestedWorkflow = form.get("workflowId") ?? "auto";
      const runNow = form.get("submitMode") === "run-now";
      let workflowId = requestedWorkflow;
      let routeTitle = "Studio task";

      let result: DashboardFollowUpResult;
      if (requestedWorkflow === "auto") {
        const projectDir = path.resolve(process.cwd(), project);
        try {
          const configuredProject = await loadProjectConfig(projectDir);
          const generated = constructDynamicWorkflow({ goal: task, project: configuredProject, agents: await loadAgentsForProject(ctx, projectDir), executionProfile: "adaptive" });
          const requestedStages = splitCommaList(form.get("planStages") ?? "");
          const generatedIds = generated.stages.map((stage) => stage.id);
          const selectedIds = requestedStages.length ? requestedStages : generatedIds;
          if (!selectedIds.length || selectedIds.some((id) => !generatedIds.includes(id))) throw new Error("The edited plan contains an unknown stage.");
          const templateOrder = selectedIds.map((id) => id.replace(/-\d+$/u, ""));
          const removed = generatedIds.filter((id) => !selectedIds.includes(id)).map((id) => id.replace(/-\d+$/u, ""));
          const workflow = constructDynamicWorkflow({
            goal: task,
            project: configuredProject,
            agents: await loadAgentsForProject(ctx, projectDir),
            executionProfile: "adaptive",
            changes: { remove: [...new Set(removed)], order: templateOrder }
          });
          await seedRegistry([], [{ path: `runtime/${workflow.id}.yaml`, value: workflow }]);
          const queued = await queueWorkflow(ctx, { workflowId: workflow.id, projectPath: projectDir, task, workflowOverride: workflow });
          if (queued.ok && runNow) {
            startStudioRunNowWatch(queued.run.runId, projectDir);
          }
          result = queued.ok
            ? { ok: true, title: runNow ? `Running now: ${workflow.stages.length}-stage agent plan` : `Queued ${workflow.stages.length}-stage agent plan`, runId: queued.run.runId, output: `Run: ${queued.run.runId}\nPlan: ${workflow.stages.map((stage) => stage.id).join(" → ")}\nOpen: /studio?run=${encodeURIComponent(queued.run.runId)}${runNow ? "\nRun now: a live watch is driving this run in the daemon; watch stages progress in the task pane." : ""}` }
            : { ok: false, error: queued.error };
          routeTitle = result.ok ? result.title : "Studio task";
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      } else {
        result = await queueDashboardWorkflowRun({
          workflowId,
          project,
          task,
          sourceTokenBudget: form.get("sourceTokenBudget") ?? "",
          sourceMaxFiles: form.get("sourceMaxFiles") ?? "",
          watch: false,
          workerLimit: form.get("workerLimit") ?? "6",
          workerConcurrency: form.get("workerConcurrency") ?? "1",
          timeoutMs: form.get("timeoutMs") ?? "60000"
        });
        if (runNow && result.ok && result.runId) {
          startStudioRunNowWatch(result.runId, path.resolve(process.cwd(), project));
          routeTitle = "Running now — watch live progress in Studio";
        }
      }
      respondDashboardAction(
        request,
        response,
        form,
        result.ok ? { ...result, title: routeTitle } : result,
        "/studio"
      );
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/studio-route") {
      const project = requestUrl.searchParams.get("project") ?? "";
      const task = requestUrl.searchParams.get("task")?.trim() ?? "";
      if (!task) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Missing natural-language task." }));
        return;
      }
      const projectDir = path.resolve(process.cwd(), project);
      const plan = createOrchestrationPlan({ projectDir, task });
      const primary = primaryWorkflowStep(plan);
      const configuredProject = await loadProjectConfig(projectDir);
      const workflow = constructDynamicWorkflow({ goal: task, project: configuredProject, agents: await loadAgentsForProject(ctx, projectDir), executionProfile: "adaptive" });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({
        workflowId: primary?.target ?? "review-pr",
        title: primary?.title ?? "General project review",
        reason: primary?.reason ?? "No narrow route matched, so Agent Workflow selected a conservative project review.",
        steps: plan.steps.map((step) => ({ kind: step.kind, target: step.target, title: step.title, reason: step.reason })),
        archetype: workflow.dynamic?.archetype,
        executionProfile: workflow.dynamic?.execution_profile,
        complexity: workflow.dynamic?.complexity,
        latencyBudgetMs: workflow.dynamic?.latency_budget_ms,
        targetDirectRatio: workflow.dynamic?.target_direct_ratio,
        constructionRationale: workflow.dynamic?.construction_rationale,
        stages: workflow.stages.map((stage) => ({ id: stage.id, agent: stage.agent, goal: stage.goal, modelTier: stage.routing?.model_tier ?? "standard", contextTokens: stage.context.max_tokens, approvalRequired: stage.approval_required, parallelGroup: stage.parallel_group, removable: stage.id !== "verify" && !(workflow.dynamic?.archetype === "security-hardening" && stage.id.startsWith("security")) }))
      }));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/studio-run-action") {
      const form = await readFormBody(request);
      const action = form.get("action") ?? "";
      const result = await processDashboardQueueAction({
        action: action === "pause" ? "cancel" : action,
        runId: form.get("runId") ?? "",
        workerLimit: "6",
        workerConcurrency: "1",
        project: form.get("project") ?? "",
        reason: form.get("reason") ?? "Studio run control",
        confirmed: true
      });
      respondDashboardAction(request, response, form, result.ok && action === "pause" ? { ...result, title: "Run paused at checkpoint" } : result, "/studio");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/coordinator-history") {
      if (!isTrustedLocalDashboardRequest(request)) {
        response.writeHead(403,{"content-type":"text/plain; charset=utf-8"}); response.end("Coordinator history actions require the trusted local dashboard."); return;
      }
      const form=await readFormBody(request),action=form.get("action")==="restore"?"restore":"archive";
      const sourceRunId=form.get("sourceRunId")??"",replacementRunId=form.get("replacementRunId")??"";
      const plan=await prepareCoordinatorHistoryAction(sourceRunId,replacementRunId);
      const owner=`dashboard-coordinator-history:${randomUUID()}`;
      const intent=await acquireWorkIntent({projectId:plan.projectId,owner,objective:`Human-authorized coordinator history ${action}`,
        fileScopes:plan.fileScopes,ttlSeconds:300});
      try {
        const runIds=(form.get("runIds")??"").split(",").map(value=>value.trim()).filter(Boolean);
        const changed=await authorizeCoordinatorHistoryAction({...plan,owner,intentFence:intent.fencingToken,runIds,
          actor:form.get("actor")??"dashboard-user",reason:form.get("reason")??"",confirmation:form.get("confirmation")??""},action);
        respondDashboardAction(request,response,form,{ok:true,title:action==="archive"?"Archived from active views":"Restored to active views",
          output:`${changed.length} terminal attempt(s) updated in view projections. Immutable status and evidence were preserved; the accepted replacement remains visible.`},"/runs");
      } finally { await releaseWorkIntent({projectId:plan.projectId,owner,fencingToken:intent.fencingToken}); }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/studio-reply") {
      const form = await readFormBody(request);
      const result = await processRequesterApprovalReply({
        approvalId: form.get("approvalId") ?? "",
        decision: form.get("decision") ?? "",
        actor: form.get("actor") ?? "dashboard-requester",
        note: form.get("note") ?? undefined
      });
      respondDashboardAction(request, response, form, result, "/studio");
      return;
    }

    // Dev mode (direct agent turns): session + streaming API. No workflow
    // run is created; turns run session-scoped via runDirectTurn.
    if (request.method === "POST" && requestUrl.pathname === "/api/dev-session") {
      if (!isTrustedLocalDashboardRequest(request)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Dev sessions require the trusted local dashboard.");
        return;
      }
      try {
        const body = objectValue(await readJsonBody(request, 64_000));
        const { session } = await createDevSessionFromBody(body);
        response.writeHead(201, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ session }));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: publicHttpError(error instanceof Error ? error.message : "Could not create the dev session.") }));
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/dev-sessions") {
      if (!isTrustedLocalDashboardRequest(request)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Dev sessions require the trusted local dashboard.");
        return;
      }
      try {
        const sessions = await listDevSessionsForBody(Object.fromEntries(requestUrl.searchParams));
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ sessions }));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: publicHttpError(error instanceof Error ? error.message : "Could not list dev sessions.") }));
      }
      return;
    }

    const devSessionPath = parseDevSessionPath(requestUrl.pathname);
    if (devSessionPath) {
      if (!isTrustedLocalDashboardRequest(request)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Dev sessions require the trusted local dashboard.");
        return;
      }
      try {
        if (request.method === "GET" && !devSessionPath.action) {
          const detail = await getDevSessionDetail(devSessionPath.id);
          response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify(detail));
        } else if (request.method === "POST" && devSessionPath.action === "message") {
          const body = objectValue(await readJsonBody(request, 64_000));
          await streamDevSessionMessage({ sessionId: devSessionPath.id, body, request, response });
        } else if (request.method === "POST" && devSessionPath.action === "approval") {
          const body = objectValue(await readJsonBody(request, 64_000));
          const decided = await decideDevSessionApprovalFromBody({ sessionId: devSessionPath.id, body });
          response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify(decided));
        } else if (request.method === "POST" && devSessionPath.action === "diff" && devSessionPath.target) {
          const body = objectValue(await readJsonBody(request, 64_000));
          const decided = await decideDevSessionDiffFromBody({ sessionId: devSessionPath.id, diffId: devSessionPath.target, body });
          response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify(decided));
        } else {
          response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "Unknown dev session route." }));
        }
      } catch (error) {
        if (!response.writableEnded) {
          response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: publicHttpError(error instanceof Error ? error.message : "Dev session request failed.") }));
        }
      }
      return;
    }

    if (requestUrl.pathname === "/api/studio-workspace") {
      const projectDir = path.resolve(process.cwd(), requestUrl.searchParams.get("project")?.trim() || process.env.AGENTFLOW_DASHBOARD_PROJECT || "templates/project");
      const requestedFile = requestUrl.searchParams.get("file")?.trim();
      const resolveInside = (relative: string): string => {
        const resolved = path.resolve(projectDir, relative);
        if (resolved !== projectDir && !resolved.startsWith(`${projectDir}${path.sep}`)) throw new Error("File path leaves the selected project.");
        return resolved;
      };
      try {
        const entries = await fs.readdir(projectDir, { withFileTypes: true });
        const files = entries.filter((entry) => !entry.name.startsWith(".")).slice(0, 80).map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" }));
        let file: { path: string; content: string } | null = null;
        if (requestedFile) file = { path: requestedFile, content: (await fs.readFile(resolveInside(requestedFile), "utf8")).slice(0, 200_000) };
        const diff = await new Promise<string>((resolve) => execFile("git", ["-C", projectDir, "diff", "--no-ext-diff", "--", "."], { maxBuffer: 2_000_000 }, (error, stdout) => resolve(error ? "Git diff is unavailable for this project." : stdout.slice(0, 500_000))));
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ project: projectDir, files, file, diff }));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: publicHttpError("The requested project file could not be read.") }));
      }
      return;
    }

    if (requestUrl.pathname === "/api/studio-events") {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
      const send = (): void => { response.write(`event: refresh\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`); };
      send();
      const timer = setInterval(send, 2500);
      request.on("close", () => clearInterval(timer));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/project-index") {
      const form = await readFormBody(request);
      const result = await indexDashboardProject({
        project: form.get("project") ?? "",
        maxFiles: form.get("maxFiles") ?? "",
        refine: form.get("refine") === "on"
      });
      respondDashboardAction(request, response, form, result, form.get("project") ? `/project?root=${encodeURIComponent(form.get("project") ?? "")}` : "/projects");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/discovery-adopt") {
      const form = await readFormBody(request);
      const result = await adoptDiscoveredProjects(ctx, {
        roots: splitCommaList(form.get("roots") || path.join(os.homedir(), "Projects")).map((item) => path.resolve(process.cwd(), item)),
        paths: splitCommaList(form.get("paths") ?? ""),
        all: form.get("all") === "on",
        initialize: form.get("initialize") === "on",
        index: form.get("index") === "on",
        profile: form.get("profile") === "simple" ? "simple" : "enterprise",
        maxDepth: parsePositiveInteger(form.get("maxDepth") || "5", 5),
        maxCandidates: parsePositiveInteger(form.get("maxCandidates") || "200", 200),
        maxFiles: parsePositiveInteger(form.get("maxFiles") || "100", 100),
        spotlight: parseSpotlightMode(form.get("spotlight") || "auto"),
        write: true
      });
      respondDashboardAction(request, response, form, result.ok
        ? {
          ok: true,
          title: "Discovery action completed",
          output: formatDiscoveryAdoptionResult(result)
        }
        : {
          ok: false,
          error: formatDiscoveryAdoptionResult(result)
        }, "/discovery");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/learning-settings") {
      const form = await readFormBody(request);
      const settingsSection = parseLearningSettingsSection(form);
      const project = form.get("project") ?? "";
      if (!project) { respondDashboardAction(request, response, form, { ok: false, error: "Missing project." }, "/learning"); return; }
      const projectPath = await resolveDashboardProjectPath(project);
      if (!projectPath.localPathExists) {
        respondDashboardAction(request, response, form, { ok: false, error: "Daemon settings require a mutable local project checkout." }, "/learning?view=settings");
        return;
      }
      if (!settingsSection) { respondDashboardAction(request, response, form, { ok: false, error: "This settings form is stale. Reload the page before saving so unrelated daemon settings are not overwritten." }, "/learning?view=settings"); return; }
      const projectDir = projectPath.localRootUri;
      const existingLearningSettings = await readLearningSettings(projectDir).catch(() => null);
      const daemonTrustLevels = selectDaemonTrustSettings(settingsSection, form, existingLearningSettings?.daemonTrustLevels);
      await writeLearningSettings(projectDir, {
        kind: "agentflow_learning_settings",
        projectRootUri: projectDir,
        updatedAt: new Date().toISOString(),
        workflowShapeAutoUpdate: settingsSection === "workflow-shape" ? form.get("workflowShapeAutoUpdate") === "on" : existingLearningSettings?.workflowShapeAutoUpdate ?? true,
        agentImprovementProjectLocalAutoApply: settingsSection === "workflow-shape" ? form.get("agentImprovementProjectLocalAutoApply") === "on" : existingLearningSettings?.agentImprovementProjectLocalAutoApply ?? true,
        autonomousApplyMaxRisk: settingsSection === "workflow-shape" ? parseLearningRiskLevel(form.get("autonomousApplyMaxRisk") ?? "medium") : existingLearningSettings?.autonomousApplyMaxRisk ?? "medium",
        approvalAutopilotEnabled: settingsSection === "workflow-shape" ? form.get("approvalAutopilotEnabled") === "on" : existingLearningSettings?.approvalAutopilotEnabled ?? false,
        approvalAutopilotMaxRisk: settingsSection === "workflow-shape" ? parseApprovalAutopilotRisk(form.get("approvalAutopilotMaxRisk") ?? "medium") : existingLearningSettings?.approvalAutopilotMaxRisk ?? "medium",
        daemonTrustLevels,
        daemonEnabled: existingLearningSettings?.daemonEnabled ?? true,
        daemonPaused: existingLearningSettings?.daemonPaused ?? false,
        daemonMode: existingLearningSettings?.daemonMode ?? "apply-approved",
        daemonRunLimit: existingLearningSettings?.daemonRunLimit ?? 50
      });
      const query = new URLSearchParams({
        project: projectDir,
        limit: form.get("limit") ?? "50",
        workflow: form.get("workflow") ?? "", view: "settings"
      });
      response.writeHead(303, { location: `/learning?${query.toString()}` });
      response.end();
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/learning-action-receipts") {
      const form = await readFormBody(request);
      const project = form.get("project") ?? "";
      if (!project) {
        respondDashboardAction(request, response, form, { ok: false, error: "Missing project." }, "/learning");
        return;
      }
      const action = form.get("action") ?? "";
      if (action === "compact") {
        const projectDir = path.resolve(process.cwd(), project);
        const result = await compactLearningActionReceiptFiles(projectDir);
        const query = new URLSearchParams({
          project: projectDir,
          limit: form.get("limit") ?? "50",
          notice: result.removedReceipts > 0
            ? `Compacted ${result.removedReceipts} duplicate daemon-owned receipt${result.removedReceipts === 1 ? "" : "s"}; backup created.`
            : "Receipt health is already clean; no duplicate daemon-owned receipts were removed."
        });
        if (form.get("workflow")) query.set("workflow", form.get("workflow") ?? "");
        response.writeHead(303, { location: `/learning?${query.toString()}` });
        response.end();
        return;
      }
      const rejectIds = form.get("reject") ?? "";
      if (!rejectIds.trim()) {
        respondDashboardAction(request, response, form, { ok: false, error: "Missing action id to reject." }, "/learning");
        return;
      }
      const projectDir = path.resolve(process.cwd(), project);
      const receipts = await readLearningActionReceipts(projectDir).catch(() => emptyLearningActionReceipts(projectDir));
      const nextReceipts = appendLearningActionRejectionReceipts(
        receipts,
        parseProposalIds(rejectIds),
        form.get("actor") ?? "dashboard",
        form.get("note") ?? "Rejected planned learning action from dashboard."
      );
      await writeLearningActionReceipts(projectDir, nextReceipts);
      const query = new URLSearchParams({
        project: projectDir,
        limit: form.get("limit") ?? "50"
      });
      response.writeHead(303, { location: `/learning?${query.toString()}` });
      response.end();
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/agent-improvement-promotion-decision") {
      const form = await readFormBody(request);
      const project = form.get("project") ?? "";
      const promotionId = form.get("promotionId") ?? "";
      const decision = form.get("decision") ?? "";
      if (!project || !promotionId || !["approved", "rejected", "deferred"].includes(decision)) {
        respondDashboardAction(request, response, form, { ok: false, error: "Project, promotion, and a valid decision are required." }, "/learning?view=agent-improvements");
        return;
      }
      try {
        const projectDir = path.resolve(process.cwd(), project);
        const queue = await readAgentImprovementPromotionQueue(projectDir);
        const result = await decideAgentImprovementPromotions({
          projectDir,
          queue,
          ids: [promotionId],
          status: decision as "approved" | "rejected" | "deferred",
          reviewer: form.get("reviewer") ?? "dashboard",
          note: form.get("note") ?? undefined
        });
        if (!result.selectedIds.length) {
          respondDashboardAction(request, response, form, { ok: false, error: "Promotion is not pending/deferred or no longer exists." }, "/learning?view=agent-improvements");
          return;
        }
        await writeAgentImprovementPromotionQueue(projectDir, result.queue);
        respondDashboardAction(request, response, form, {
          ok: true,
          title: `Promotion ${decision}`,
          output: `${promotionId} was ${decision}; the reversible decision receipt was recorded.`
        }, `/learning?project=${encodeURIComponent(projectDir)}&view=agent-improvements`);
      } catch (error) {
        respondDashboardAction(request, response, form, { ok: false, error: error instanceof Error ? error.message : String(error) }, "/learning?view=agent-improvements");
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/learning-daemon-target") {
      const form = await readFormBody(request);
      const result = await processDashboardLearningDaemonTarget({
        project: form.get("project") ?? "",
        mode: form.get("mode") ?? "apply-approved",
        scope: form.get("scope") ?? "project"
      });
      respondDashboardAction(request, response, form, result, "/learning");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/launchagent-action") {
      const form = await readFormBody(request);
      const result = await processDashboardLaunchAgentAction(form.get("action") ?? "");
      respondDashboardAction(request, response, form, result, "/settings");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/offline-fallback-action") {
      const form = await readFormBody(request);
      const result = await processDashboardOfflineFallbackAction(form);
      respondDashboardAction(request, response, form, result, "/server-readiness");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/offline-sync-action") {
      const form = await readFormBody(request);
      const result = await processDashboardOfflineSyncAction(form);
      respondDashboardAction(request, response, form, result, "/server-readiness");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/object-mirror-approval") {
      const form = await readFormBody(request);
      const result = await processDashboardObjectMirrorApproval(form);
      respondDashboardAction(request, response, form, result, "/server-readiness");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/storage-project-decision") {
      const form = await readFormBody(request);
      const result = await processDashboardStorageProjectDecisionAction(form);
      respondDashboardAction(request, response, form, result, "/server-readiness");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/runtime-monitor-action") {
      const form = await readFormBody(request);
      const result = await processDashboardRuntimeMonitorAction(form);
      respondDashboardAction(request, response, form, result, "/server-readiness");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/graph-handoff-export") {
      const form = await readFormBody(request);
      const result = await exportDashboardWorkflowGraphHandoff(form);
      respondDashboardAction(request, response, form, result, "/workflow-graph");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/graph-preset-save") {
      const form = await readFormBody(request);
      const result = await saveDashboardGraphPreset(form);
      response.writeHead(result.ok ? 303 : 400, result.ok ? { location: result.href } : { "content-type": "text/html; charset=utf-8" });
      response.end(result.ok ? "" : renderDashboardActionResult(result));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/graph-preset-delete") {
      const form = await readFormBody(request);
      const result = await deleteDashboardGraphPreset(form);
      response.writeHead(result.ok ? 303 : 400, result.ok ? { location: result.href } : { "content-type": "text/html; charset=utf-8" });
      response.end(result.ok ? "" : renderDashboardActionResult(result));
      return;
    }

    if (requestUrl.pathname === "/graph-handoff") {
      const result = await loadDashboardGraphHandoffView(requestUrl.searchParams);
      response.writeHead(result.ok ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      response.end(renderDashboardGraphHandoffView(result));
      return;
    }

    if (requestUrl.pathname === "/role-audit") {
      const result = await loadDashboardRoleAuditView(requestUrl.searchParams);
      response.writeHead(result.ok ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      response.end(renderDashboardRoleAuditView(result));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/routing") {
      const form = await readFormBody(request);
      const result = await updateDashboardRouting({
        provider: form.get("provider") ?? "",
        autoProviders: form.get("autoProviders") ?? "",
        fastProvider: form.get("fastProvider") ?? "",
        standardProvider: form.get("standardProvider") ?? "",
        reasoningProvider: form.get("reasoningProvider") ?? "",
        fallbackProvider: form.get("fallbackProvider") ?? "",
        qualityThreshold: form.get("qualityThreshold") ?? "",
        modelPolicy: form.get("modelPolicy") ?? ""
      });
      respondDashboardAction(request, response, form, result, "/settings");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/model") {
      const form = await readFormBody(request);
      const result = await updateDashboardModel({
        provider: form.get("provider") ?? "",
        model: form.get("model") ?? ""
      });
      respondDashboardAction(request, response, form, result, "/settings");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/bundle-lifecycle-plan") {
      const form = await readFormBody(request);
      const result = await processDashboardBundleLifecyclePlan({
        project: form.get("project") ?? "",
        bundleId: form.get("bundleId") ?? "",
        mode: form.get("mode") ?? "",
        targetVersion: form.get("targetVersion") ?? "",
        registry: form.get("registry") ?? "",
        write: form.get("write") === "on"
      });
      respondDashboardAction(request, response, form, result, "/bundles");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/role-audit-export") {
      const form = await readFormBody(request);
      const result = await processDashboardRoleAuditExport({
        project: form.get("project") ?? "",
        limit: form.get("limit") ?? "",
        role: form.get("role") ?? "",
        status: form.get("status") ?? "",
        actionType: form.get("action") ?? "",
        out: form.get("out") ?? ""
      });
      respondDashboardAction(request, response, form, result, "/roles");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/feedback-bulk-action") {
      const form = await readFormBody(request);
      const result = await processDashboardBulkFeedbackAction(form);
      respondDashboardAction(request, response, form, result, "/feedback-inbox");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/follow-up") {
      const form = await readFormBody(request);
      const result = await runDashboardFollowUp({
        action: form.get("action") ?? "",
        runId: form.get("runId") ?? undefined,
        project: form.get("project") ?? undefined,
        workflowId: form.get("workflowId") ?? undefined,
        stageId: form.get("stageId") ?? undefined,
        agentId: form.get("agentId") ?? undefined,
        providerId: form.get("providerId") ?? undefined,
        modelTier: form.get("modelTier") ?? undefined,
        routeClass: form.get("routeClass") ?? undefined,
        runs: form.get("runs") ?? undefined,
        fallbackCount: form.get("fallbackCount") ?? undefined,
        averageQuality: form.get("averageQuality") ?? undefined,
        averageLatencyMs: form.get("averageLatencyMs") ?? undefined,
        ids: form.get("ids") ?? undefined,
        model: form.get("model") ?? undefined,
        rating: form.get("rating") ?? undefined,
        note: form.get("note") ?? undefined
      });
      respondDashboardAction(request, response, form, result, dashboardResultRunPath(result, "/"));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/roadmap-item") {
      const form = await readFormBody(request);
      const result = await appendRoadmapRegisterItem(form);
      respondDashboardAction(request, response, form, result, "/roadmap");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/project-roadmap-suggestion") {
      const form = await readFormBody(request);
      const result = await decideRoadmapSuggestion(form);
      const project = form.get("project") ?? "";
      respondDashboardAction(request, response, form, result, `/project?root=${encodeURIComponent(project)}`);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/roadmap-status") {
      const form = await readFormBody(request);
      const result = await updateRoadmapTaskStatus(form);
      respondDashboardAction(request, response, form, result, "/roadmap");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/roadmap-priority") {
      const form = await readFormBody(request);
      const result = await updateRoadmapTaskPriority(form);
      respondDashboardAction(request, response, form, result, "/roadmap");
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/training-proposal-evaluation") {
      const form = await readFormBody(request);
      const project = form.get("project")?.trim() ?? "";
      const id = form.get("id")?.trim() ?? "";
      try {
        if (!project || !id) throw new Error("Project and proposal are required.");
        const { selected: projectDir } = await resolveTrainingProjectChoices(await listProjectStorageSummaries(100), project, process.cwd());
        const inbox = await readTrainingProposalInbox(projectDir);
        const item = inbox.items.find((candidate) => candidate.id === id);
        if (!item) throw new Error(`Unknown training proposal: ${id}`);
        if (!["approved", "needs-evidence"].includes(item.status)) throw new Error("Only approved training proposals or proposals needing evidence can start an evaluation.");
        if (item.evaluation?.runId) {
          const existing = await getWorkflowRunDetails(item.evaluation.runId);
          if (existing.run && ["queued", "leased", "running", "completed"].includes(existing.run.status)) {
            respondDashboardAction(request, response, form, { ok: true, title: "Evaluation already exists", runId: existing.run.id, output: `Linked evaluation run ${existing.run.id} is ${existing.run.status}.` }, "/training-proposals");
            return;
          }
        }
        const design = buildTrainingHoldoutDesign({
          id: item.id,
          targets: item.proposal.targets,
          publisher: item.proposal.publisher,
          claimedBenefit: item.proposal.claimedBenefit,
          risks: item.proposal.risks,
          holdoutEvaluation: item.proposal.holdoutEvaluation
        });
        const designPath = await persistTrainingHoldoutDesign(projectDir, design);
        const relativeDesignPath = path.relative(projectDir, designPath);
        const task = [
          `Evaluate approved training proposal ${item.id}.`,
          `Publisher: ${item.proposal.publisher}`,
          `Source: ${item.proposal.url}`,
          `Targets: ${item.proposal.targets.join(", ")}`,
          `Claimed benefit: ${item.proposal.claimedBenefit}`,
          `Known risks: ${item.proposal.risks}`,
          `Required holdout: ${item.proposal.holdoutEvaluation}`,
          `Expected cost: ${item.proposal.expectedCost}`,
          `Rollback plan: ${item.proposal.rollbackPlan}`,
          `Authoritative holdout design: ${relativeDesignPath}`,
          `Execute exactly: npm run agentflow -- training-holdout --project . --proposal ${item.id} --design ${relativeDesignPath} --write`,
          "Use only public-source concepts and local synthetic/project-safe evidence. Do not change shared agent definitions, tools, authority, routing, executable code, or production behavior. Produce a PASS, FAIL, or INCONCLUSIVE verdict with cited artifacts and measured evidence."
        ].join("\n");
        const trainingWorkflow = resolveWorkflow(await loadWorkflows(ctx.rootDir), "training-evaluation");
        if (!trainingWorkflow) throw new Error("The training-evaluation workflow is not installed.");
        const queued = await queueWorkflow(ctx, {
          workflowId: "training-evaluation",
          workflowOverride: trainingWorkflow,
          projectPath: projectDir,
          task,
          evaluationMetadata: {
            source: "training-proposal",
            trainingProposalId: item.id,
            trainingProposalSourceId: item.sourceId,
            trainingProposalContentSha256: item.contentSha256,
            suiteId: `training-proposal:${item.id}`
          }
        });
        if (!queued.ok) throw new Error(queued.error);
        await linkTrainingProposalEvaluation({ projectDir, id, runId: queued.run.runId, reviewer: "dashboard-operator" });
        respondDashboardAction(request, response, form, { ok: true, title: "Training evaluation queued", runId: queued.run.runId, output: `Run ${queued.run.runId} will generate the proposal evidence.` }, "/training-proposals");
      } catch (error) {
        respondDashboardAction(request, response, form, { ok: false, error: error instanceof Error ? error.message : String(error) }, "/training-proposals");
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/training-proposal-decision") {
      const form = await readFormBody(request);
      const project = form.get("project")?.trim() ?? "";
      const id = form.get("id")?.trim() ?? "";
      const status = form.get("status")?.trim() ?? "";
      const allowed = new Set<TrainingProposalDecisionStatus>(["approved", "needs-evidence", "rejected", "stale", "unsafe", "evaluated", "promoted"]);
      try {
        if (!project || !id || !allowed.has(status as TrainingProposalDecisionStatus)) throw new Error("Project, proposal, and a valid decision are required.");
        const { selected: projectDir } = await resolveTrainingProjectChoices(await listProjectStorageSummaries(100), project, process.cwd());
        const current = (await readTrainingProposalInbox(projectDir)).items.find((item) => item.id === id);
        if (current?.status === status) {
          respondDashboardAction(request, response, form, {
            ok: true,
            title: `Training proposal already ${status}`,
            output: `No state change was needed for ${id}.`
          }, "/training-proposals");
          return;
        }
        let decisionNote = form.get("note")?.trim() || undefined;
        if (status === "evaluated") {
          if (current?.status !== "approved" || !current.evaluation?.runId) throw new Error("A linked approved evaluation run is required.");
          const details = await getWorkflowRunDetails(current.evaluation.runId);
          if (details.run?.status !== "completed") throw new Error(`Evaluation run ${current.evaluation.runId} is ${details.run?.status ?? "missing"}; only completed evidence can be accepted.`);
          const report = await readTrainingHoldoutReport(projectDir, id);
          if (!isCompleteTrainingHoldoutReport(report)) {
            await decideTrainingProposal({
              projectDir,
              id,
              status: "needs-evidence",
              reviewer: form.get("reviewer")?.trim() || "dashboard-operator",
              note: `Run ${current.evaluation.runId} completed without a nonzero, complete measured holdout report.`
            });
            respondDashboardAction(request, response, form, { ok: true, title: "Training proposal needs evidence", output: `Run ${current.evaluation.runId} was not accepted because measured coverage is missing or incomplete.` }, "/training-proposals");
            return;
          }
          const artifacts = await listArtifacts({ runId: current.evaluation.runId, kind: "stage_output" });
          const finalArtifact = artifacts.at(-1);
          const summary = stringValue(finalArtifact?.content?.summary) ?? stringValue(finalArtifact?.content?.output) ?? "Completed evaluation evidence is attached to the linked run.";
          decisionNote = `Accepted completed evaluation run ${current.evaluation.runId}. Evidence: ${finalArtifact?.uri ?? "run stage outputs"}. ${summary}`.slice(0, 2000);
        }
        if (status === "promoted") {
          if (current?.status !== "evaluated" || !current.evaluation?.runId) throw new Error("Only an evaluated proposal can record a promotion decision.");
          const report = await readTrainingHoldoutReport(projectDir, id);
          if (!isCompleteTrainingHoldoutReport(report) || report.verdict !== "PASS") throw new Error("Only a complete measured PASS evaluation is eligible for promotion. Run another holdout after resolving the recorded evidence gaps.");
        }
        await decideTrainingProposal({
          projectDir,
          id,
          status: status as Exclude<TrainingProposalDecisionStatus, "pending">,
          reviewer: form.get("reviewer")?.trim() || "dashboard-operator",
          note: decisionNote
        });
        respondDashboardAction(request, response, form, { ok: true, title: `Training proposal marked ${status}`, output: `Recorded ${status} decision for ${id}.` }, "/training-proposals");
      } catch (error) {
        respondDashboardAction(request, response, form, { ok: false, error: error instanceof Error ? error.message : String(error) }, "/training-proposals");
      }
      return;
    }

    if (requestUrl.pathname === "/api/nav-counts") {
      const pendingApprovals = await loadCachedDashboardReport("nav-counts:pending-approvals", async () => (await listActionApprovals({ status: "pending", limit: 100 })).length, 5_000);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ pendingApprovals }));
      return;
    }

    if (requestUrl.pathname === "/api/runs") {
      const runs = await loadCachedDashboardReport("api:runs:50", () => listWorkflowRuns(50), 2_000);
      const runsWithEta = runs.map((run) => ({
        ...run,
        eta: estimateRunEta({ run, tasks: [{ status: run.status }], historicalRuns: runs })
      }));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(runsWithEta, null, 2));
      return;
    }
    if (requestUrl.pathname === "/api/guide-evidence-diagnostics") {
      const requested = requestUrl.searchParams.get("project") ?? "";
      const taskClass = requestUrl.searchParams.get("taskClass")?.trim() || null;
      const status = requestUrl.searchParams.get("status")?.trim() || null;
      if (!requested) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "An exact registered project is required." }));
        return;
      }
      if (status && status !== "legacy-compatible" && status !== "quarantined") {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "Status must be legacy-compatible or quarantined." }));
        return;
      }
      const requestedRoot = path.resolve(process.cwd(), requested);
      const projects = await listProjectStorageSummaries(500);
      const resolved = await Promise.all(projects.map(async (project) => ({
        project,
        localRoot: path.resolve(await resolveLocalProjectRootUri(project.rootUri))
      })));
      const selected = resolved.find((candidate) => candidate.localRoot === requestedRoot)?.project;
      if (!selected) {
        response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "Guide diagnostics require an exact registered project." }));
        return;
      }
      const cursor = requestUrl.searchParams.get("cursor") ?? undefined;
      if (requestUrl.searchParams.get("reduce") === "true") {
        const resumeCheckpointHandle = firstHeader(request.headers["x-agentflow-guide-checkpoint"])?.trim() || undefined;
        try {
          const pageSize = Math.min(parsePositiveInteger(requestUrl.searchParams.get("pageSize") ?? "100", 100), 200);
          const signingKey = await loadOrCreateGuideEvidenceCheckpointKey(ctx.rootDir);
          const resumeCheckpoint = resumeCheckpointHandle ? await readGuideEvidenceReductionCheckpoint({ rootDir: ctx.rootDir, projectId: selected.id, handle: resumeCheckpointHandle, signingKey }) : undefined;
          const reduced = await reduceLegacyGuideEvidenceSnapshot(selected.id, pageSize, { checkpoint: resumeCheckpoint, signingKey, maxPages: 1 });
          if (reduced.complete && resumeCheckpointHandle) await discardGuideEvidenceReductionCheckpoint({ rootDir: ctx.rootDir, projectId: selected.id, handle: resumeCheckpointHandle, signingKey });
          const output = reduced.complete ? reduced.manifest : { ...reduced, checkpoint: await persistGuideEvidenceReductionCheckpoint({ rootDir: ctx.rootDir, projectId: selected.id, checkpoint: reduced.checkpoint, expiresAt: reduced.expiresAt, signingKey }) };
          response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify(output, null, 2));
        } catch (error) {
          response.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: publicHttpError("The guide evidence checkpoint could not be resumed."), restartRequired: true, checkpointRejected: Boolean(resumeCheckpointHandle), authority: "resume-only", grants: { repair: false, replay: false, approval: false, promotion: false, acceptance: false } }));
        }
        return;
      }
      if (cursor || requestUrl.searchParams.has("pageSize")) {
        const pageSize = Math.min(parsePositiveInteger(requestUrl.searchParams.get("pageSize") ?? "100", 100), 200);
        try {
          const page = await legacyGuideEvidenceInventoryPage(selected.id, { cursor, pageSize });
          response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify(page, null, 2));
        } catch (error) {
          response.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: publicHttpError("The guide evidence inventory could not be read."), restartRequired: true, authority: "inventory-only" }));
        }
        return;
      }
      const inventory = await legacyGuideEvidenceInventory(selected.id);
      const findings = inventory.findings.filter((item) =>
        (!taskClass || item.taskClass === taskClass) && (!status || item.status === status));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({
        ...inventory,
        findings,
        filters: { projectId: selected.id, taskClass, status },
        displaySemantics: {
          quarantined: "audit-only evidence integrity issue",
          workflowFailure: false,
          approvalRequest: false,
          automaticRepairAuthority: false
        }
      }, null, 2));
      return;
    }
    if (requestUrl.pathname === "/api/guide-adoption-hold-metrics") {
      const requested = requestUrl.searchParams.get("project") ?? "";
      if (!requested) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "An exact registered project is required." }));
        return;
      }
      const requestedRoot = path.resolve(process.cwd(), requested);
      const projects = await listProjectStorageSummaries(500);
      const resolved = await Promise.all(projects.map(async (project) => ({ project, localRoot: path.resolve(await resolveLocalProjectRootUri(project.rootUri)) })));
      const selected = resolved.find((candidate) => candidate.localRoot === requestedRoot)?.project;
      if (!selected) {
        response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "Guide adoption metrics require an exact registered project." }));
        return;
      }
      const requestedThreshold = requestUrl.searchParams.get("staleMinutes") ?? "auto";
      const explicitThresholdMinutes = requestedThreshold === "auto" ? null : Math.min(parsePositiveInteger(requestedThreshold, 15), 1440);
      const report = await queuePartnerGuideRegistryHoldMetrics(selected.id, { staleAfterMs: explicitThresholdMinutes === null ? undefined : explicitThresholdMinutes * 60_000 });
      const staleAfterMinutes = report.calibration.selectedThresholdMs / 60_000;
      const alertAfterMinutes = report.calibration.alertThresholdMs / 60_000;
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ...report, projectId: selected.id, staleAfterMinutes, alertAfterMinutes, displaySemantics: { adoptionLagAlert: "observational deployment lag", workflowFailure: false, restartAuthority: false, replayAuthority: false, primaryOutcomeAccepted: false } }, null, 2));
      return;
    }
    if (requestUrl.pathname === "/api/training-proposals") {
      const requested = requestUrl.searchParams.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT;
      const { selected } = await resolveTrainingProjectChoices(await listProjectStorageSummaries(100), requested, process.cwd());
      const inbox = await readTrainingProposalInbox(selected);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(inbox, null, 2));
      return;
    }
    if (requestUrl.pathname === "/api/training-holdout-evidence") {
      const requested = requestUrl.searchParams.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT;
      const id = requestUrl.searchParams.get("id") ?? "";
      const { selected } = await resolveTrainingProjectChoices(await listProjectStorageSummaries(100), requested, process.cwd());
      const reportPath = path.join(selected, ".agent-workflow", "evaluations", id.replace(/[^a-zA-Z0-9._-]+/gu, "-"), "measured-holdout.json");
      try { response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(await fs.readFile(reportPath, "utf8")); }
      catch { response.writeHead(404, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ error: "Measured holdout evidence is not available." })); }
      return;
    }

    if (requestUrl.pathname === "/api/activity") {
      const report = await loadUnifiedActivityReport(requestUrl.searchParams);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/evaluations") {
      const suites = await loadDashboardEvaluations();
      const suiteId = requestUrl.searchParams.get("suite");
      const payload = suiteId ? suites.find((suite) => suite.id === suiteId) ?? null : suites;
      response.writeHead(payload ? 200 : 404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(payload, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/context-gateway") {
      const project = requestUrl.searchParams.get("project") ?? ctx.rootDir;
      const report = await loadContextOperatorReport(ctx, await resolveLocalProjectRootUri(project));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/queue-status" || requestUrl.pathname === "/api/queue-status") {
      if (request.method !== "GET") { response.writeHead(405, { allow: "GET" }); response.end(); return; }
      if (!isTrustedLocalDashboardRequest(request)) { response.writeHead(403); response.end(); return; }
      if (requestUrl.pathname === "/queue-status") { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(renderQueueStatusHtml()); return; }
      let projectId: string | undefined;
      const scope = requestUrl.searchParams.get("scope") ?? "all";
      try { projectId = parseQueueStatusProject(requestUrl.searchParams.get("project")); if (!["partner", "all"].includes(scope)) throw Error("Invalid scope"); }
      catch { response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify({ error: "Choose a valid registered project and queue scope." })); return; }
      try {
        const snapshot = await loadQueueCardSnapshot(undefined);
        const report = await buildQueueStatusReport(projectId, undefined, scope === "all", {
          items: snapshot.value.queue, capturedAt: snapshot.capturedAt, ageMs: snapshot.ageMs, refreshing: snapshot.refreshing, limit: 100
        });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...queueSnapshotHeaders(snapshot) }); response.end(JSON.stringify(report));
      } catch { response.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify({ error: "Queue data is unavailable. No queue state was changed." })); }
      return;
    }

    if (requestUrl.pathname === '/api/partner-work-history') {
      if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
      if (!isTrustedPartnerCommandRequest(request)) { response.writeHead(403); response.end(); return; }
      try {
        const runId = requestUrl.searchParams.get('run') ?? '';
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(runId)) { response.writeHead(400); response.end(); return; }
        const projectId = await queuePartnerOwner('run', runId), project = projectId ? await loadPartnerProject(projectId) : null;
        if (!project || await partnerProjectAccess(project)) { response.writeHead(404); response.end(); return; }
        const report = await buildPartnerWorkHistory({ projectId: project!.id, runId, after: requestUrl.searchParams.get('after') ?? undefined, before: requestUrl.searchParams.get('before') ?? undefined });
        response.writeHead(report ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(report));
      } catch { response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: 'Work history is unavailable. The last recorded steps are preserved.' })); }
      return;
    }

    if (requestUrl.pathname === "/api/queue-partner-activity") {
      if (request.method !== "GET") { response.writeHead(405, {allow:"GET"}); response.end(); return; }
      if (!isTrustedLocalDashboardRequest(request)) { response.writeHead(403); response.end(); return; }
      if (requestUrl.searchParams.get("scope") === "queue") {
        try {
          const snapshot = await loadQueueCardSnapshot(undefined);
          const report = await buildQueueStatusReport(undefined, undefined, true, {
            items: snapshot.value.queue, capturedAt: snapshot.capturedAt, ageMs: snapshot.ageMs, refreshing: snapshot.refreshing, limit: 100
          },true);
          response.writeHead(200, {"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
          response.end(JSON.stringify({version:1,authority:"evidence-only",scope:{kind:"queue"},observedAt:report.observedAt,coordinator:await readPartnerQueueObservation(ctx.rootDir),capacity:{repair:5,verifier:1},
            entries:report.rows.slice(0,12).map(row=>({id:row.id,familyId:row.id,runId:row.runId,title:`${row.projectName} · ${row.name}`,state:row.status,kind:"observation",
              what:`${row.status} in ${row.projectName}.`,why:row.issue,how:"Queue-wide storage observation; owning-project policy, claims and receipts still govern each action.",next:row.fix,requiresPermission:row.status==="Awaiting approval",evidence:[{label:"View owning run",url:`/run?id=${row.runId}`}]})),
            watching:[`Following ${report.rows.length} queue items across ${new Set(report.rows.map(row=>row.projectId)).size} registered projects. Project filters change the view, not Partner's purview.`],truncated:report.truncated||report.rows.length>12}));
        } catch { response.writeHead(503, {"cache-control":"no-store"}); response.end(); }
        return;
      }
      const root = requestUrl.searchParams.get("project") ?? ctx.rootDir;
      const runId = requestUrl.searchParams.get("run") ?? undefined;
      if (root.length > 4096 || (runId && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(runId))) { response.writeHead(400); response.end(); return; }
      // Display family links never transfer execution-project visibility.
      const registered = (await listProjectStorageSummaries(100)).find(project => project.rootUri === root);
      if (!registered) { response.writeHead(404); response.end(); return; }
      const report = await buildQueuePartnerActivity(registered.id, registered.rootUri, runId);
      response.writeHead(200, {"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
      response.end(JSON.stringify(report)); return;
    }

    if (requestUrl.pathname === "/api/queue-resolution-metrics") {
      if(request.method!=="GET"){response.writeHead(405,{allow:"GET"});response.end();return;}
      if(!isTrustedLocalDashboardRequest(request)){response.writeHead(403);response.end();return;}
      const {queuePartnerResolutionYield}=await import("../../../../packages/storage/src/queue-partner-resolution-metrics.js");
      const metrics=await queuePartnerResolutionYield();
      response.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
      response.end(JSON.stringify(metrics));return;
    }
    if (requestUrl.pathname === "/api/queue") {
      const projectRootUri = requestUrl.searchParams.get("project") ?? undefined;
      const snapshot = await loadQueueCardSnapshot(projectRootUri, requestUrl.searchParams.get("fresh") === "1");
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...queueSnapshotHeaders(snapshot) });
      response.end(JSON.stringify(snapshot.value.queue.map((item) => ({ ...item, eta: estimateQueueItemEta(item, snapshot.value.historicalRuns) })), null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/queue-history") {
      if (request.method !== "GET") { response.writeHead(405, { allow: "GET" }); response.end(); return; }
      if (!isTrustedLocalDashboardRequest(request)) { response.writeHead(403); response.end(); return; }
      const projectRootUri = requestUrl.searchParams.get("project")?.trim() || undefined;
      if (projectRootUri && projectRootUri.length > 4096) { response.writeHead(400); response.end(); return; }
      try {
        const snapshot = await loadQueueCardSnapshot(projectRootUri, requestUrl.searchParams.get("fresh") === "1");
        const points = await recordAndLoadQueueHistory({queue:snapshot.value.queue,projectRootUri,rangeMinutes:queueHistoryRangeMinutes(requestUrl.searchParams.get("range"))});
        response.writeHead(200, {"content-type":"application/json; charset=utf-8","cache-control":"no-store",...queueSnapshotHeaders(snapshot)});
        response.end(JSON.stringify({range:requestUrl.searchParams.get("range")||"1h",resolution:"minute",points}));
      } catch { response.writeHead(503, {"content-type":"application/json; charset=utf-8","cache-control":"no-store"}); response.end(JSON.stringify({error:"Queue history is unavailable. No queue state was changed."})); }
      return;
    }

    if (requestUrl.pathname === "/api/approvals") {
      const status = requestUrl.searchParams.get("status") ?? "open";
      const approvals = (await listActionApprovals({
        status: status === "all" || status === "open" ? undefined : status,
        runId: requestUrl.searchParams.get("run") ?? undefined,
        projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "100", 100)
      })).filter((approval) => status !== "open" || isOpenApproval(approval));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(approvals, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/approval-backlog") {
      const status = requestUrl.searchParams.get("status") ?? "all";
      const report = await buildApprovalBacklogReport(ctx, {
        status: status === "all" ? undefined : status,
        projectRootUri: requestUrl.searchParams.get("project") ? path.resolve(process.cwd(), requestUrl.searchParams.get("project") ?? "") : undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "500", 500),
        staleMinutes: parsePositiveInteger(requestUrl.searchParams.get("staleMinutes") ?? "60", 60)
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/approval-rules") {
      const rules = await loadDashboardApprovalRules(requestUrl.searchParams.get("project") ?? undefined);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(rules, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/projects") {
      const projects = await listProjectStorageSummaries(100);
      const identities = await loadDashboardProjectIdentityGroups(projects);
      const canonicalProjects = identities.filter((identity) => identity.visibility === "canonical").map((identity) => ({
        ...identity.projects.find((project) => project.rootUri === identity.primaryRootUri)!,
        rootUri: identity.canonicalRootUri,
        name: identity.canonicalName,
        indexedFiles: identity.totalIndexedFiles,
        memoryItems: identity.totalMemoryItems,
        runCount: identity.totalRuns,
        queuedRuns: identity.projects.reduce((sum, project) => sum + project.queuedRuns, 0),
        runningRuns: identity.projects.reduce((sum, project) => sum + project.runningRuns, 0),
        failedRuns: identity.failedRuns,
        lastRunAt: identity.lastRunAt,
        aliases: identity.aliases
      }));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(canonicalProjects, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/project-identities") {
      const projects = await listProjectStorageSummaries(100);
      const identities = await loadDashboardProjectIdentityGroups(projects);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        kind: "agentflow_project_identities",
        generatedAt: new Date().toISOString(),
        identityCount: identities.length,
        projectCount: projects.length,
        identities
      }, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/project-alias-merge-plan") {
      const limit = parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "500", 500);
      const projects = await listProjectStorageSummaries(limit);
      const identities = await loadDashboardProjectIdentityGroups(projects);
      const plan = buildDashboardProjectAliasMergePlan(projects, identities);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(plan, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/agents") {
      const agents = await loadDashboardAgents(requestUrl.searchParams.get("project") ?? undefined);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(agents, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/discovery") {
      const report = await discoverLocalProjects(ctx, {
        roots: splitCommaList(requestUrl.searchParams.get("roots") ?? path.join(os.homedir(), "Projects")).map((item) => path.resolve(process.cwd(), item)),
        maxDepth: parsePositiveInteger(requestUrl.searchParams.get("maxDepth") ?? "5", 5),
        maxCandidates: parsePositiveInteger(requestUrl.searchParams.get("maxCandidates") ?? "200", 200),
        spotlight: parseSpotlightMode(requestUrl.searchParams.get("spotlight") ?? "auto")
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/governance") {
      const report = await loadGovernanceReport(ctx, parsePositiveInteger(requestUrl.searchParams.get("staleMinutes") ?? "15", 15), requestUrl.searchParams.get("includeEphemeral") === "true");
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(filterGovernanceReport(report, requestUrl.searchParams), null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/roles") {
      const report = await loadRoleGovernanceReport(ctx, {
        projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50),
        role: requestUrl.searchParams.get("role") ?? undefined,
        status: requestUrl.searchParams.get("status") ?? undefined,
        actionType: requestUrl.searchParams.get("action") ?? undefined
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/artifact-lifecycle") {
      const report = await loadArtifactLifecycleReport({
        projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
        kind: requestUrl.searchParams.get("kind") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "500", 500),
        prunePlan: requestUrl.searchParams.get("prunePlan") === "true",
        archivePlan: requestUrl.searchParams.get("archivePlan") === "true",
        restorePlan: requestUrl.searchParams.get("restorePlan") === "true",
        minAgeDays: requestUrl.searchParams.has("minAgeDays") ? parseNonNegativeInteger(requestUrl.searchParams.get("minAgeDays") ?? "", 30) : undefined,
        minBytes: requestUrl.searchParams.has("minBytes") ? parseNonNegativeInteger(requestUrl.searchParams.get("minBytes") ?? "", 20_000) : undefined,
        includeAudit: requestUrl.searchParams.has("includeAudit") ? requestUrl.searchParams.get("includeAudit") === "true" : undefined
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/backup-report") {
      const report = await loadBackupRestoreReport({
        projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "500", 500)
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/server-readiness") {
      const migrationDir = requestUrl.searchParams.get("migrationDir") ?? undefined;
      const projectRootUri = requestUrl.searchParams.get("project") ?? undefined;
      const report = await loadServerReadinessReport({
        projectRootUri,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "100", 100)
      });
      const mergeEvidence = await loadStorageMergeEvidenceListing(ctx, migrationDir);
      const offlineFallback = await loadOfflineFallbackReport(ctx);
      const objectProof = await buildObjectArtifactProofReport(ctx, {
        projectRootUri: projectRootUri || undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("objectLimit") ?? "500", 500),
        enumerateBuckets: requestUrl.searchParams.get("enumerateBuckets") === "1",
        verify: requestUrl.searchParams.get("verifyObjects") === "1"
      });
      const runtimeMonitor = await loadRuntimeMonitorReport();
      const statePlaneProof = buildSharedStatePlaneProof({
        server: report,
        storageVerification: await buildStorageVerificationReport({
          targetHost: requestUrl.searchParams.get("storageHost") ?? requestUrl.searchParams.get("targetHost") ?? undefined
        }),
        mergeEvidence,
        offlineFallback,
        objectProof,
        runtimeMonitor
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      const requestAudit = await loadServerRequestAuditLog(ctx, parsePositiveInteger(requestUrl.searchParams.get("requestLogLimit") ?? "50", 50));
      response.end(JSON.stringify({ ...report, statePlaneProof, mutationControls: buildServerMutationControlReport(), approvalActionPlan: buildServerApprovalActionPlanReport(), approvalActionTestAdapter: buildServerApprovalActionTestAdapterReport(), mergeEvidence, offlineFallback, objectProof, runtimeMonitor, requestAudit }, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/server-mutation-controls") {
      const report = buildServerMutationControlReport();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/server-approval-action-plan") {
      const report = buildServerApprovalActionPlanReport();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/server-approval-action-test-adapter") {
      const report = buildServerApprovalActionTestAdapterReport();
      response.writeHead(report.status === "pass" ? 200 : 500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/runtime-monitor") {
      const report = await loadRuntimeMonitorReport({ checkMcp: requestUrl.searchParams.get("checkMcp") === "1" || requestUrl.searchParams.get("check-mcp") === "1" });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/storage-verify") {
      const report = await buildStorageVerificationReport({
        targetHost: requestUrl.searchParams.get("storageHost") ?? requestUrl.searchParams.get("targetHost") ?? undefined,
        sourceDatabaseUrl: requestUrl.searchParams.get("sourceDatabaseUrl") ?? undefined,
        sourceRedisUrl: requestUrl.searchParams.get("sourceRedisUrl") ?? undefined,
        sourceObjectStorageEndpoint: requestUrl.searchParams.get("sourceObjectStorageEndpoint") ?? undefined,
        sourceObjectStorageBucket: requestUrl.searchParams.get("sourceObjectStorageBucket") ?? undefined,
        targetDatabaseUrl: requestUrl.searchParams.get("targetDatabaseUrl") ?? undefined,
        targetRedisUrl: requestUrl.searchParams.get("targetRedisUrl") ?? undefined,
        targetObjectStorageEndpoint: requestUrl.searchParams.get("targetObjectStorageEndpoint") ?? undefined,
        targetObjectStorageBucket: requestUrl.searchParams.get("targetObjectStorageBucket") ?? undefined
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/storage-migrations") {
      const listing = await loadStorageMigrationPlanListing(requestUrl.searchParams.get("dir") ?? undefined);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(listing, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/storage-merge-evidence") {
      const listing = await loadStorageMergeEvidenceListing(ctx, requestUrl.searchParams.get("dir") ?? undefined);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(listing, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/offline-fallback") {
      const report = await loadOfflineFallbackReport(ctx);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/object-artifact-proof") {
      const report = await buildObjectArtifactProofReport(ctx, {
        projectRootUri: requestUrl.searchParams.get("project") || undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "500", 500),
        enumerateBuckets: requestUrl.searchParams.get("enumerateBuckets") === "1",
        verify: requestUrl.searchParams.get("verify") === "1"
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/server-request-log") {
      const report = await loadServerRequestAuditLog(ctx, parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/server-projects") {
      const report = await loadServerProjectRegistryReport({
        projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "100", 100),
        includeRoots: requestUrl.searchParams.get("includeRoots") === "true"
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/server-project") {
      const projectId = requestUrl.searchParams.get("projectId") ?? "";
      const result = await resolveServerProjectReference({
        projectId,
        includeRoot: requestUrl.searchParams.get("includeRoot") === "true"
      });
      response.writeHead(result.resolved ? 200 : 404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/server-daemon-fleet-health") {
      const auth = validateServerMutationAuth(request);
      if (!auth.ok) {
        response.writeHead(401, { "content-type": "application/json; charset=utf-8", "www-authenticate": "Bearer" });
        response.end(JSON.stringify({ kind: "agentflow_server_daemon_fleet_health", status: "invalid", error: "authenticated server access is required" }));
        return;
      }
      const report = await loadCachedDashboardReport(
        "server-daemon-fleet-health",
        () => loadServerDaemonFleetHealth(),
        2_000
      );
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if(request.method==="POST"&&requestUrl.pathname==="/api/worker-heartbeat-ingest"){
      const auth=validateServerMutationAuth(request);
      if(!auth.ok){response.writeHead(401,{"content-type":"application/json; charset=utf-8","www-authenticate":"Bearer"});response.end(JSON.stringify({kind:"agentflow_worker_heartbeat_ingestion",status:"rejected",error:"authenticated server access is required"}));return;}
      try{
        const limits=serverRequestLimits();const body=await readJsonBody(request,limits.maxBodyBytes);
        if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("JSON worker heartbeat object is required.");
        const result=await ingestRemoteWorkerHeartbeat({heartbeat:body as Record<string,unknown>,trustStore:await loadWorkerTrustStore(),heartbeatDir:ctx.defaultWorkerHeartbeatDir,cursorPath:path.join(ctx.defaultWorkerHeartbeatDir,"remote-ingestion-cursors.state")});
        response.writeHead(result.accepted?202:200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});response.end(JSON.stringify({kind:"agentflow_worker_heartbeat_ingestion",status:result.idempotent?"idempotent":"accepted",...result},null,2));return;
      }catch{response.writeHead(422,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});response.end(JSON.stringify({kind:"agentflow_worker_heartbeat_ingestion",status:"rejected",error:publicHttpError("The worker heartbeat was invalid or could not be verified.")},null,2));return;}
    }

    if (requestUrl.pathname === "/api/server-roadmap") {
      const auth = validateServerMutationAuth(request);
      if (!auth.ok) {
        response.writeHead(401, { "content-type": "application/json; charset=utf-8", "www-authenticate": "Bearer" });
        response.end(JSON.stringify({
          kind: "agentflow_server_roadmap_snapshot",
          generatedAt: new Date().toISOString(),
          status: "invalid",
          reason: "authenticated server access is required"
        }, null, 2));
        return;
      }
      const result = await loadServerRoadmapSnapshot(requestUrl.searchParams.get("projectId") ?? "");
      response.writeHead(result.statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(result.report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/server-high-risk-approvals") {
      const auth = validateServerMutationAuth(request);
      if (!auth.ok) {
        response.writeHead(401, { "content-type": "application/json; charset=utf-8", "www-authenticate": "Bearer" });
        response.end(JSON.stringify({ kind: "agentflow_server_high_risk_approval_inbox", status: "invalid", error: "authenticated server access is required" }));
        return;
      }
      const report = await loadServerHighRiskApprovalInbox(parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "25", 25));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/server-request-preview") {
      const report = await loadServerRequestPreview(ctx, {
        projectId: requestUrl.searchParams.get("projectId") ?? "",
        workflowId: requestUrl.searchParams.get("workflow") ?? "",
        task: requestUrl.searchParams.get("task") ?? "",
        actor: requestUrl.searchParams.get("actor") ?? "dashboard-preview",
        actorRole: requestUrl.searchParams.get("actorRole") ?? "operator",
        idempotencyKey: requestUrl.searchParams.get("idempotencyKey") ?? undefined
      });
      response.writeHead(report.status === "blocked" ? 400 : 200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/server-route-preview") {
      const report = await loadServerRoutePreview(ctx, {
        projectId: requestUrl.searchParams.get("projectId") ?? "",
        workflowId: requestUrl.searchParams.get("workflow") ?? "",
        task: requestUrl.searchParams.get("task") ?? "",
        actor: requestUrl.searchParams.get("actor") ?? "dashboard-preview",
        actorRole: requestUrl.searchParams.get("actorRole") ?? "operator",
        idempotencyKey: requestUrl.searchParams.get("idempotencyKey") ?? undefined
      });
      response.writeHead(report.status === "blocked" ? 400 : 200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/server-approval-preview") {
      const isPost = request.method === "POST";
      let payload: Record<string, unknown> = {};
      if (isPost) {
        try {
          payload = objectValue(await readJsonBody(request, serverRequestLimits().maxBodyBytes));
        } catch (error) {
          await safeAppendServerRequestAuditEvent(ctx, buildServerRequestBodyErrorAuditEvent(request, error, "/api/server-approval-preview"));
          response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({
            kind: "agentflow_server_approval_preview",
            generatedAt: new Date().toISOString(),
            status: "blocked",
            dryRun: true,
            error: publicHttpError("Request body must be valid JSON within the configured size limit."),
            checks: [{ label: "Request body", status: "fail", detail: "Request body must be valid JSON within the configured size limit." }]
          }, null, 2));
          return;
        }
      }
      const report = await loadServerApprovalPreview(ctx, {
        projectId: isPost ? stringValue(payload.projectId) ?? "" : requestUrl.searchParams.get("projectId") ?? "",
        approvalId: isPost ? stringValue(payload.approvalId) ?? "" : requestUrl.searchParams.get("approvalId") ?? "",
        decision: isPost ? stringValue(payload.decision) ?? "approve-and-execute" : requestUrl.searchParams.get("decision") ?? "approve-and-execute",
        actor: isPost ? stringValue(payload.actor) ?? "server-preview" : requestUrl.searchParams.get("actor") ?? "server-preview",
        actorRole: isPost ? stringValue(payload.actorRole) ?? "approver" : requestUrl.searchParams.get("actorRole") ?? "approver",
        idempotencyKey: isPost ? stringValue(payload.idempotencyKey) ?? undefined : requestUrl.searchParams.get("idempotencyKey") ?? undefined,
        request
      });
      response.writeHead(report.status === "blocked" ? 400 : 200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/server-approval-action") {
      const limits = serverRequestLimits();
      let payload: Record<string, unknown>;
      try {
        payload = objectValue(await readJsonBody(request, limits.maxBodyBytes));
      } catch (error) {
        await safeAppendServerRequestAuditEvent(ctx, buildServerRequestBodyErrorAuditEvent(request, error, "/api/server-approval-action"));
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({
          kind: "agentflow_server_approval_action_report",
          generatedAt: new Date().toISOString(),
          status: "blocked",
          dryRun: true,
          error: publicHttpError("Request body must be valid JSON within the configured size limit."),
          checks: [{ label: "Request body", status: "fail", detail: "Request body must be valid JSON within the configured size limit." }]
        }, null, 2));
        return;
      }
      const report = await loadServerApprovalActionReport(ctx, {
        projectId: stringValue(payload.projectId) ?? "",
        approvalId: stringValue(payload.approvalId) ?? "",
        decision: stringValue(payload.decision) ?? "approve-and-execute",
        actor: stringValue(payload.actor) ?? "server-client",
        actorRole: stringValue(payload.actorRole) ?? "approver",
        idempotencyKey: stringValue(payload.idempotencyKey) ?? undefined,
        request,
        limits
      });
      response.writeHead(report.status === "blocked" ? 403 : 200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/server-orchestrations") {
      const limits = serverRequestLimits();
      try {
        const body = await readJsonBody(request, limits.maxBodyBytes);
        const report = await processServerOrchestrationRequest(request, body, limits);
        response.writeHead(report.status === "blocked" ? 400 : report.status === "queued" ? 202 : 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(report, null, 2));
      } catch (error) {
        await safeAppendServerRequestAuditEvent(ctx, buildServerRequestBodyErrorAuditEvent(request, error, "/api/server-orchestrations"));
        response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ kind: "agentflow_server_orchestration_report", status: "blocked", error: publicHttpError("The orchestration request was invalid.") }, null, 2));
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/notification-ack") {
      const { handleNotificationAcknowledgment } = await import("../notification-ack-http.js");
      await handleNotificationAcknowledgment(request, response);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/server-run-events") {
      if (!validateServerMutationAuth(request).ok) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Authentication required." }));
        return;
      }
      try {
        const projectId = requestUrl.searchParams.get("projectId") ?? "";
        const runId = requestUrl.searchParams.get("runId") ?? "";
        const project = (await listProjectStorageSummaries(500)).find(item => item.id === projectId);
        if (!project) {
          response.writeHead(404).end();
          return;
        }
        const { replayRecordedLifecycleEvents } = await import("../../../../packages/storage/src/recorded-lifecycle.js");
        const cursor = request.headers["last-event-id"];
        const events = await replayRecordedLifecycleEvents({ projectRootUri: project.rootUri, runId,
          after: typeof cursor === "string" ? cursor : requestUrl.searchParams.get("after") ?? undefined });
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
        response.write("retry: 2000\n\n");
        for (const event of events) response.write(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        // Bounded replay response. Reconnect using Last-Event-ID for the next page.
        response.end();
      } catch {
        if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Lifecycle replay request failed." }));
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/server-orchestration-status") {
      const result = await loadServerOrchestrationStatus(request, requestUrl.searchParams.get("projectId") ?? "", requestUrl.searchParams.get("operationId") ?? "");
      response.writeHead(result.statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(result.report, null, 2));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/server-orchestration-events") {
      const projectId = requestUrl.searchParams.get("projectId") ?? "";
      const operationId = requestUrl.searchParams.get("operationId") ?? "";
      const initial = await loadServerOrchestrationStatus(request, projectId, operationId);
      if (initial.statusCode !== 200) {
        response.writeHead(initial.statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(initial.report, null, 2));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      let closed = false;
      let events = 0;
      let lastCursor = "";
      const startedAt = Date.now();
      let timer: NodeJS.Timeout | null = null;
      request.on("close", () => { closed = true; if (timer) clearTimeout(timer); });
      const send = async (): Promise<void> => {
        if (closed) return;
        const current = events === 0 ? initial : await loadServerOrchestrationStatus(request, projectId, operationId);
        const report = current.report;
        if (report.cursor !== lastCursor) {
          response.write(`id: ${report.cursor}\nevent: orchestration\ndata: ${JSON.stringify(report)}\n\n`);
          lastCursor = report.cursor;
          events += 1;
        } else {
          response.write(`event: heartbeat\ndata: ${JSON.stringify({ operationId, generatedAt: new Date().toISOString() })}\n\n`);
        }
        if (serverOrchestrationStatusIsTerminal(report.status) || events >= 31 || Date.now() - startedAt >= 60_000) {
          response.end();
          return;
        }
        timer = setTimeout(() => { void send(); }, 2_000);
      };
      await send();
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/server-queue") {
      const limits = serverRequestLimits();
      let body: unknown;
      try {
        body = await readJsonBody(request, limits.maxBodyBytes);
      } catch (error) {
        await safeAppendServerRequestAuditEvent(ctx, buildServerRequestBodyErrorAuditEvent(request, error));
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({
          kind: "agentflow_server_queue_report",
          generatedAt: new Date().toISOString(),
          status: "blocked",
          dryRun: true,
          error: publicHttpError("Request body must be valid JSON within the configured size limit."),
          checks: [{ label: "Request body", status: "fail", detail: "Request body must be valid JSON within the configured size limit." }]
        }, null, 2));
        return;
      }
      const report = await processServerQueueRequest(ctx, request, body, limits);
      response.writeHead(report.status === "blocked" ? 400 : report.status === "queued" ? 201 : 200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/queue-partner-message") {
      const send = (code: number, report: unknown) => { response.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(report)); };
      if (!isTrustedPartnerCommandRequest(request)) { send(403, { kind: "queue_partner_chat_report", status: "blocked", text: "Queue Partner commands require the trusted same-origin local dashboard.", items: [] }); return; }
      let parsedMessage:PartnerMessage|undefined;
      try {
        const limits = serverRequestLimits(), parsed = parsePartnerMessage(await readJsonBody(request, limits.maxBodyBytes));
        parsedMessage=parsed;
        let queueSnapshot:Promise<PartnerItem[]>|undefined;
        const readQueueItems=()=>queueSnapshot??=queuePartnerItems();
        if (!checkServerQueueRateLimit({ request, actor: "dashboard-user", limitPerMinute: limits.rateLimitPerMinute }).ok) { send(429, { kind: "queue_partner_chat_report", status: "blocked", text: "Too many messages. Wait briefly before sending another instruction.", items: [] }); return; }
        const converseQueue = async (message: PartnerMessage): Promise<string> => {
          // This project selects provider/configuration only, not queue jurisdiction.
          // Model prose remains conversation-only and never authorizes effects.
          const selectedOwner = message.runId ? await queuePartnerOwner("run", message.runId) : undefined;
          const contextId = selectedOwner ?? message.projectId ?? await withClient(async c=>(await c.query('select id::text from projects where root_uri=$1 limit 1',[ctx.rootDir])).rows[0]?.id);
          if (!contextId) return "Queue-wide lists and exact item commands are available. Conversation provider configuration is unavailable.";
          const fallback = await resolveServerProjectReference({projectId:contextId,includeRoot:true});
          if (!fallback.resolved || !fallback.project?.rootUri) return "Queue-wide lists and exact item commands are available. Conversation provider configuration is unavailable.";
          const config = await loadProjectConfig(fallback.project.rootUri), role = config.team.default_actor_role;
          const report = await processSynchronousConversation(ctx, {message:message.message,history:buildPartnerConversationHistory(message,await readQueueItems()),
            idempotencyKey:message.idempotencyKey,projectId:fallback.project.projectId,actor:"dashboard-user",actorRole:role,capabilityMode:"conversation",assistantMode:"queue-partner"},request,{trustedLocalDashboard:true});
          return report.assistant?.text ?? report.error ?? "Ask for items, blockers and fixes, select an item and say ‘fix it’, or pick up the next blocked item across the queue.";
        };
        const adapterForProject = async (projectId: string) => {
          const project = await loadPartnerProject(projectId);
          if (!project || await partnerProjectAccess(project)) return null;
          const root=project.rootUri, config=await loadProjectConfig(root), role=config.team.default_actor_role;
          return createPartnerChatAdapter(projectId, root, {
          async stop(item, message) {
            const gate = evaluateRoleGate(config, role, 'can_execute_approved_actions');
            if (!gate.allowed || config.team.roles[role]?.read_only) return { status: 'blocked', text: 'The configured dashboard role cannot stop workflow runs.' };
            const result = await processDashboardQueueAction({ action: 'cancel', runId: item.runId, workerLimit: '1', workerConcurrency: '1', project: root, reason: message, confirmed: true, actor: 'queue-partner-dashboard' });
            return result.ok ? { status: 'requested', runId: item.runId, text: 'Stop recorded for this exact run. In-flight commands may take time to stop; follow its recorded state. History and evidence are preserved.' } : { status: 'blocked', text: result.error };
          },
          async repair(item, message) {
            const gate = evaluateRoleGate(config, role, "can_request_approvals");
            if (!gate.allowed || config.team.roles[role]?.read_only) return { status: "blocked", text: "The configured dashboard role cannot request repair work." };
            const result = await processDashboardQueueAction({ action: "repair-blocked", runId: item.runId, workerLimit: "6", workerConcurrency: "1", project: root, reason: message, confirmed: false, actor: "queue-partner-dashboard" });
            return result.ok ? { status: "queued", text: `${result.title}\n${result.output}`, runId: result.runId } : { status: "blocked", text: result.error };
          },
          async approve(approval) {
            const result = approval.status === "approved"
              ? await executeApprovedAction(ctx, { approvalId: approval.id, actor: "queue-partner-dashboard", actorRole: role })
              : await approveAndExecuteAction(ctx, { approvalId: approval.id, actor: "queue-partner-dashboard", approveActorRole: role, executeActorRole: role, note: "Explicit approval of the exact displayed Queue Partner proposal." });
            if (!result.ok) return { status: "blocked", text: result.error };
            const current = await getActionApproval(approval.id);
            const applied = current?.status === "executed" && await hasPartnerApprovalEffect(projectId,approval.id);
            return applied ? { status: "completed", text: `Exact action effect verified against its recorded artifact and receipt. This is not product acceptance.\n${result.output}`, runId: result.runId }
              : { status: "requested", text: `Approval recorded; status is ${current?.status ?? "unconfirmed"}, but an applied effect is not verified. This is not a deployment or product-acceptance claim.\n${result.output}`, runId: result.runId };
          },
          converse: converseQueue
        }, !config.team.roles[role]?.read_only && evaluateRoleGate(config, role, "can_request_approvals").allowed);
        };
        const controlProjectId=await withClient(async c=>(await c.query('select id::text from projects where root_uri=$1 limit 1',[ctx.rootDir])).rows[0]?.id);
        if(!controlProjectId)throw Error('The dashboard control project is not registered.');
        const adapter = createQueuePartnerAdapter({items:readQueueItems,owner:queuePartnerOwner,adapter:adapterForProject,converse:converseQueue,onceMessage:createQueuePartnerRequestLedger(controlProjectId)});
        const report = await processPartnerMessage(parsed, adapter);
        send(report.status === "queued" ? 201 : report.status === "requested" ? 202 : report.status === "blocked" ? 403 : 200, report);
      } catch(error) {
        const statusOnly=parsedMessage&&isPartnerStatusMessage(parsedMessage.message);
        console.error('Queue Partner request failed', {phase:parsedMessage?'handling':'validation',code:serverAuditErrorCode(error instanceof Error?error.message:'request error')});
        send(statusOnly?503:400, { kind: "queue_partner_chat_report", status: "review", text: statusOnly?"Queue status is temporarily unavailable. No workflow action was requested. Refresh status shortly.":"The instruction could not be confirmed. Check the item's current state before retrying; no automatic retry was performed.", items: [] });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/server-conversation") {
      const limits = serverRequestLimits();
      try {
        const body = await readJsonBody(request, limits.maxBodyBytes);
        const report = await processSynchronousConversation(ctx, body, request, { trustedLocalDashboard: isTrustedLocalDashboardRequest(request) });
        const statusCode = report.status === "blocked" ? 403 : report.status === "queued" ? 201 : 200;
        response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(report, null, 2));
      } catch (error) {
        await safeAppendServerRequestAuditEvent(ctx, buildServerRequestBodyErrorAuditEvent(request, error, "/api/server-conversation"));
        response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ kind: "agentflow_server_conversation_report", status: "blocked", error: publicHttpError("The conversation request was invalid.") }, null, 2));
      }
      return;
    }

    if (requestUrl.pathname === "/api/bundles") {
      const readiness = await loadDashboardBundleReadiness(requestUrl.searchParams);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(readiness, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/bundle-registry") {
      const report = await loadDashboardBundleRegistry(requestUrl.searchParams);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/workflow-graph") {
      const report = await loadCachedDashboardReport(
        `workflow-graph:${requestUrl.searchParams.toString()}`,
        () => loadDashboardWorkflowGraph(requestUrl.searchParams),
        2_000
      );
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/dynamic-workflow") {
      const projectDir = path.resolve(process.cwd(), requestUrl.searchParams.get("project")?.trim() || process.env.AGENTFLOW_DASHBOARD_PROJECT || "templates/project");
      const goal = requestUrl.searchParams.get("task")?.trim() || "Create a local web app";
      const project = await loadProjectConfig(projectDir);
      const workflow = constructDynamicWorkflow({ goal, project, agents: await loadAgentsForProject(ctx, projectDir), executionProfile: "adaptive" });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(workflow, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/model-catalog") {
      const report = await loadDashboardModelCatalogReport();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/roadmap") {
      const report = await loadRoadmapDashboardReport();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/client-capabilities") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(buildClientCapabilityContract(ctx.packageVersion), null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/fleet-model-usage") {
      const report = await loadDashboardFleetUsageReport();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/info" || requestUrl.pathname === "/api/settings") {
      const info = await loadDashboardInfo(dashboardUrlFromRequest(request));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(info, null, 2));
      return;
    }

    if (requestUrl.pathname === "/launchagent-log") {
      const kind = requestUrl.searchParams.get("kind") === "stderr" ? "stderr" : "stdout";
      const view = await loadDashboardLaunchAgentLog(kind);
      response.writeHead(view.ok ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      response.end(renderLaunchAgentLogHtml(view));
      return;
    }

    if (requestUrl.pathname === "/api/run") {
      const runId = requestUrl.searchParams.get("id");
      if (!runId) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing id");
        return;
      }
      const [details, artifacts, handoffs, historicalRuns, approvals, workAvailable] = await Promise.all([
        getWorkflowRunDetails(runId),
        listArtifacts({ runId }),
        listWorkflowHandoffs({ runId }),
        listWorkflowRuns(250),
        listActionApprovals({ runId, limit: 100 }),
        loadDashboardWorkAvailable()
      ]);
      const canProgress = details.run ? dashboardRunCanProgress(workAvailable, details.run, details.tasks) : true;
      const eta = details.run ? withWorkerAvailability(estimateRunEta({ run: details.run, tasks: details.tasks, historicalRuns }), canProgress) : null;
      const lineageRunIds: string[] = [];
      let lineageCursor = details.run ? stringValue(details.run.evaluationMetadata?.sourceRunId) : undefined;
      while (lineageCursor && lineageRunIds.length < 12 && !lineageRunIds.includes(lineageCursor)) {
        lineageRunIds.push(lineageCursor);
        const source = historicalRuns.find((candidate) => candidate.id === lineageCursor);
        lineageCursor = source ? stringValue(source.evaluationMetadata?.sourceRunId) : undefined;
      }
      const lineageArtifacts = (await Promise.all(lineageRunIds.map((sourceRunId) => listArtifacts({ runId: sourceRunId })))).flat();
      const outcome = details.run ? buildRunOutcomeContract({
        run: details.run,
        artifacts: [...artifacts, ...lineageArtifacts],
        tasks: details.tasks,
        lineageRunIds,
        openApprovalCount: approvals.filter(isOpenApproval).length,
        workerAvailable: canProgress
      }) : null;
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ...details, eta, outcome, artifacts, handoffs, approvals }, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/run-progress") {
      const runId = requestUrl.searchParams.get("id")?.trim();
      if (!runId) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "Missing id" }));
        return;
      }
      const [details, events, approvals, artifacts, historicalRuns, workAvailable] = await Promise.all([
        getWorkflowRunDetails(runId),
        listActivityEvents({ runId, limit: 250 }),
        listActionApprovals({ runId, limit: 100 }),
        listArtifacts({ runId }),
        listWorkflowRuns(250),
        loadDashboardWorkAvailable()
      ]);
      if (!details.run) {
        response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "Run not found" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({
        generatedAt: new Date().toISOString(),
        run: { status: details.run.status, finishedAt: details.run.finishedAt },
        eta: withWorkerAvailability(estimateRunEta({ run: details.run, tasks: details.tasks, historicalRuns }), dashboardRunCanProgress(workAvailable, details.run, details.tasks)),
        tasks: details.tasks.map((task) => ({
          stageId: task.stageId,
          agentId: task.agentId,
          status: task.status,
          skipped: task.skipped === true,
          attempts: task.attempts,
          executor: task.executorSnapshot ? `${task.executorSnapshot.executorId}/${task.executorSnapshot.operation}@${task.executorSnapshot.requestedHost}` : "local model"
        })),
        stageTimelineHtml: renderRunStageTimeline(details.tasks),
        continuationHtml: renderRunContinuationBanner(details.run),
        commandCenterHtml: renderRunCommandCenterBody(details.run, details.tasks, approvals),
        events: events.reverse(),
        receipts: details.receipts.map((receipt) => ({ id: receipt.id, actionType: receipt.actionType, summary: receipt.summary, createdAt: receipt.createdAt })),
        approvals: approvals.map((approval) => ({
          id: approval.id,
          actionType: approval.actionType,
          target: approval.target,
          rationale: approval.rationale,
          status: approval.status,
          createdAt: approval.createdAt,
          allowedDecisions: ["approve", "approve-and-execute", "reject"],
          actionEndpoint: "/api/server-approval-action"
        })),
        artifacts: artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, uri: artifact.uri, createdAt: artifact.createdAt }))
      }));
      return;
    }

    if (requestUrl.pathname === "/api/run-stage") {
      const runId = requestUrl.searchParams.get("id")?.trim();
      const stageId = requestUrl.searchParams.get("stage")?.trim();
      if (!runId || !stageId) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "Missing id or stage" }));
        return;
      }
      const [details, artifacts, approvals, events] = await Promise.all([
        getWorkflowRunDetails(runId),
        listArtifacts({ runId }),
        listActionApprovals({ runId, limit: 100 }),
        listActivityEvents({ runId, limit: 250 })
      ]);
      const task = details.tasks.find((candidate) => candidate.stageId === stageId);
      if (!details.run || !task) {
        response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "Run stage not found" }));
        return;
      }
      const stageArtifacts = artifacts.filter((artifact) => artifact.taskId === task.id || artifact.content?.stageId === stageId);
      const stageReceipts = details.receipts.filter((receipt) => receipt.target === task.id || receipt.target === stageId);
      const stageApprovals = approvals.filter((approval) => approval.taskId === task.id || approval.stageId === stageId);
      const stageEvents = events.filter((event) =>
        (event.category === "stage" && (event.title.includes(stageId) || event.actor === task.agentId))
        || (event.category === "action" && stageReceipts.some((receipt) => event.id === `receipt:${receipt.id}`))
        || (event.category === "approval" && stageApprovals.some((approval) => event.id === `approval:${approval.id}`))
      ).reverse();
      const stageOutput = [...stageArtifacts].reverse().find((artifact) => artifact.kind === "stage_output")?.content;
      const outputText = stageOutput
        ? JSON.stringify(stageOutput, null, 2).slice(0, 16_000)
        : "No stage output has been recorded yet.";
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({
        generatedAt: new Date().toISOString(),
        runStatus: details.run.status,
        task: {
          stageId: task.stageId,
          agentId: task.agentId,
          status: task.skipped ? "skipped" : task.status,
          attempts: task.attempts,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
          executor: task.executorSnapshot ? `${task.executorSnapshot.executorId}/${task.executorSnapshot.operation}@${task.executorSnapshot.requestedHost}` : "local model"
        },
        events: stageEvents,
        receipts: stageReceipts.map((receipt) => ({ actionType: receipt.actionType, summary: receipt.summary, createdAt: receipt.createdAt })),
        approvals: stageApprovals.map((approval) => ({ actionType: approval.actionType, target: approval.target, status: approval.status, createdAt: approval.createdAt })),
        artifacts: stageArtifacts.map((artifact) => ({ kind: artifact.kind, uri: artifact.uri, createdAt: artifact.createdAt })),
        outputText,
        truncated: Boolean(stageOutput && JSON.stringify(stageOutput, null, 2).length > 16_000)
      }));
      return;
    }

    if (requestUrl.pathname === "/api/quality") {
      const runId = requestUrl.searchParams.get("id");
      if (!runId) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing id");
        return;
      }
      const report = await loadCostQualityReport(runId);
      if (!report) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Run not found");
        return;
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/observability") {
      const runId = requestUrl.searchParams.get("id");
      if (!runId) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing id");
        return;
      }
      const report = await loadObservabilityReport(ctx, runId);
      if (!report) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Run not found");
        return;
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/preferences") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const limit = parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "25", 25);
      const scorecard = await loadPreferenceScorecard({
        projectDir: project,
        limit
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(scorecard, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/tuning") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const limit = parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "25", 25);
      const proposals = await loadTuningProposals({
        projectDir: project,
        limit
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(proposals, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/model-improvement") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const report = await loadDashboardModelImprovementReport({
        projectDir: project,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/local-llm-checklist") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const report = await loadDashboardModelImprovementReport({
        projectDir: project,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report.localLlmSetup, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/feedback-inbox") {
      const report = await loadDashboardFeedbackInboxReport({
        projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/learning-report") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const report = await loadLearningReport({
        projectDir: project,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/learning-loop") {
      const project = requestUrl.searchParams.get("project");
      if (!project) { response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); response.end("Missing project"); return; }
      const projectPath = await resolveDashboardProjectPath(project);
      const state = await readLearningLoopState(projectPath.localRootUri);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(buildLearningLoopDashboard(state, projectPath.localRootUri), null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/learning-proposals") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const report = await loadLearningReport({
        projectDir: project,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
      });
      const proposalSet = buildLearningProposalSet(report);
      const existingQueue = await readLearningApprovalQueue(project).catch(() => undefined);
      const queue = buildLearningApprovalQueue(proposalSet, parseProposalIds(requestUrl.searchParams.get("ids") ?? "all"), existingQueue);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ...proposalSet, approvalQueue: queue, mode: "dry-run" }, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/learning-daemon-status") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const status = await loadLearningDaemonStatus(ctx, project);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(status, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/optimizer-status") {
      const project = requestUrl.searchParams.get("project");
      if (!project) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Missing project" })); return; }
      const projectDir = path.resolve(process.cwd(), project);
      const state = await readOptimizerState(projectDir);
      const events = await readOptimizerEvents(projectDir);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(optimizerDashboardReport(state, state.approvals, events), null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/daemon-control-status") {
      const project = requestUrl.searchParams.get("project");
      if (!project) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Missing project" })); return; }
      const projectDir = path.resolve(process.cwd(), project);
      const settings = await readLearningSettings(projectDir).catch(() => null);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(buildDaemonControlStatus(settings?.daemonTrustLevels), null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/server-shared-brain/status") {
      if (!authenticateSharedBrainRequest(firstHeader(request.headers.authorization) ?? undefined, process.env.AGENTFLOW_SERVER_TOKEN)) { response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }); response.end(JSON.stringify({ error: "authenticated server access is required" })); return; }
      const projectId = requestUrl.searchParams.get("projectId") ?? "";
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ projectId, ...sharedBrainSummary({ activeGoals: [], recentDecisions: [], openApprovalCount: 0, learnedPreferenceCount: 0, degradedServices: [] }) }, null, 2));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/server-shared-brain/intent") {
      if (!authenticateSharedBrainRequest(firstHeader(request.headers.authorization) ?? undefined, process.env.AGENTFLOW_SERVER_TOKEN)) { response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }); response.end(JSON.stringify({ error: "authenticated server access is required" })); return; }
      try {
        const payload = objectValue(await readJsonBody(request, serverRequestLimits().maxBodyBytes));
        const intent = createAssistantIntent({ requestId: stringValue(payload.requestId) ?? randomUUID(), conversationId: stringValue(payload.conversationId) ?? "server", projectId: stringValue(payload.projectId) ?? undefined, goal: stringValue(payload.goal) ?? "", requestedAutonomy: parseLearningDaemonMode(stringValue(payload.requestedAutonomy) ?? "propose"), createdAt: new Date().toISOString() });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ intent, preview: previewAssistantPlan(intent, []) }, null, 2));
      } catch { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: publicHttpError("The assistant intent request was invalid.") })); }
      return;
    }

    if (requestUrl.pathname === "/api/learning-application-plan") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const queue = await readLearningApprovalQueue(project).catch(() => null);
      const plan = queue ? buildGovernedLearningApplicationPlan(queue, parseProposalIds(requestUrl.searchParams.get("ids") ?? "all")) : null;
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(plan ?? { kind: "agentflow_learning_application_plan", projectRootUri: project, actions: [], summary: ["No learning approval inbox found."] }, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/learning-action-receipts") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      if (requestUrl.searchParams.get("health") === "1") {
        const health = await loadLearningActionReceiptHealth(path.resolve(process.cwd(), project));
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(health, null, 2));
        return;
      }
      const receipts = await readLearningActionReceipts(project).catch(() => emptyLearningActionReceipts(path.resolve(process.cwd(), project)));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(receipts, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/learning-workflow-shape") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const report = await loadWorkflowShapeOptimization(ctx, {
        projectDir: project,
        workflowId: requestUrl.searchParams.get("workflow") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/agent-improvement-report") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const report = await loadAgentImprovementReport(ctx, {
        projectDir: project,
        agentId: requestUrl.searchParams.get("agent") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50),
        mode: "read-only"
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/agent-improvement-patches") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const report = await loadAgentImprovementReport(ctx, {
        projectDir: project,
        agentId: requestUrl.searchParams.get("agent") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50),
        mode: "read-only"
      });
      const plan = await buildAgentImprovementPatchPlan(ctx, path.resolve(process.cwd(), project), report, parseProposalIds(requestUrl.searchParams.get("ids") ?? "all"));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(plan, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/agent-improvement-evals") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const limit = parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50);
      const report = await loadAgentImprovementReport(ctx, {
        projectDir: project,
        agentId: requestUrl.searchParams.get("agent") ?? undefined,
        limit,
        mode: "read-only"
      });
      const ids = parseProposalIds(requestUrl.searchParams.get("ids") ?? "all");
      const patchPlan = await buildAgentImprovementPatchPlan(ctx, path.resolve(process.cwd(), project), report, ids);
      const evalPlan = await buildAgentImprovementEvalPlan(ctx, path.resolve(process.cwd(), project), patchPlan, ids, limit);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(evalPlan, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/agent-improvement-promotions") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const limit = parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50);
      const ids = parseProposalIds(requestUrl.searchParams.get("ids") ?? "all");
      const projectDir = path.resolve(process.cwd(), project);
      const report = await loadAgentImprovementReport(ctx, {
        projectDir,
        agentId: requestUrl.searchParams.get("agent") ?? undefined,
        limit,
        mode: "read-only"
      });
      const patchPlan = await buildAgentImprovementPatchPlan(ctx, projectDir, report, ids);
      const evalPlan = await buildAgentImprovementEvalPlan(ctx, projectDir, patchPlan, ids, limit);
      const existingQueue = await readAgentImprovementPromotionQueue(projectDir).catch(() => undefined);
      const queue = buildAgentImprovementPromotionQueue(projectDir, patchPlan, evalPlan, ids, existingQueue);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(queue, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/candidate-comparisons") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const bucket = ["minute", "hour", "day", "week", "month"].includes(requestUrl.searchParams.get("bucket") ?? "") ? requestUrl.searchParams.get("bucket") as "minute" | "hour" | "day" | "week" | "month" : "day";
      const range = ["1h", "6h", "24h", "7d", "30d", "90d", "180d", "365d", "all"].includes(requestUrl.searchParams.get("range") ?? "") ? requestUrl.searchParams.get("range") as "1h" | "6h" | "24h" | "7d" | "30d" | "90d" | "180d" | "365d" | "all" : "90d";
      const report = await loadDashboardCandidateComparisonReport({ projectDir: project, bucket, range, from: requestUrl.searchParams.get("from"), to: requestUrl.searchParams.get("to") });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(report, null, 2));
      return;
    }

    if (requestUrl.pathname === "/api/apply-tuning") {
      const project = requestUrl.searchParams.get("project");
      if (!project) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing project");
        return;
      }
      const limit = parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "25", 25);
      const proposals = await loadTuningProposals({
        projectDir: project,
        limit
      });
      const plan = buildTuningApplicationPlan(proposals, parseProposalIds(requestUrl.searchParams.get("ids") ?? "all"));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ...plan, mode: "dry-run" }, null, 2));
      return;
    }

    if (requestUrl.pathname === "/studio/influence" || requestUrl.pathname === "/api/context-influence") {
      if (request.method !== "GET") { response.writeHead(405, { allow: "GET" }); response.end(); return; }
      const project = path.resolve(requestUrl.searchParams.get("project") || process.env.AGENTFLOW_DASHBOARD_PROJECT || "templates/project");
      const run = requestUrl.searchParams.get("run") ?? "";
      if (!/^[a-f0-9-]{36}$/i.test(run)) { response.writeHead(400); response.end("A workflow run identifier is required."); return; }
      try {
        const view = await readContextInfluence(project,run);
        const json = requestUrl.pathname === "/api/context-influence";
        response.writeHead(200, { "content-type": json ? "application/json; charset=utf-8" : "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(json ? JSON.stringify(view) : renderContextInfluenceHtml(view));
      } catch { response.writeHead(503, { "content-type": "text/plain; charset=utf-8" }); response.end("Context influence history is unavailable. Check storage health and retry."); }
      return;
    }

    if (requestUrl.pathname === "/studio/context" || requestUrl.pathname === "/api/project-evidence") {
      if (request.method !== "GET") { response.writeHead(405, { allow: "GET" }); response.end(); return; }
      const project = path.resolve(requestUrl.searchParams.get("project")?.trim() || process.env.AGENTFLOW_DASHBOARD_PROJECT || "templates/project");
      let graph: ProjectEvidenceGraph;
      try { graph = await readProjectEvidenceGraph(project); }
      catch { graph = { schemaVersion: 1, project, generatedAt: new Date().toISOString(), authority: "none", status: "unavailable", truncated: false, nodes: [], relationships: [], warnings: [] }; }
      const json = requestUrl.pathname === "/api/project-evidence";
      if (!json && requestUrl.searchParams.get("source") === "1") {
        const node = graph.nodes.find(node => node.id === requestUrl.searchParams.get("node"));
        try {
          if (!node) throw new Error("Evidence not found");
          const html = await renderEvidenceSource(project, node);
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(html);
        } catch { response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); response.end("Evidence source is unavailable or outside the preview boundary. Return to project context and refresh the index."); }
        return;
      }
      response.writeHead(graph.status === "unavailable" ? 503 : 200, { "content-type": json ? "application/json; charset=utf-8" : "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(json ? JSON.stringify(graph) : renderProjectEvidenceHtml(graph, { kind: requestUrl.searchParams.get("kind") ?? undefined, selected: requestUrl.searchParams.get("node") ?? undefined }));
      return;
    }

    if (requestUrl.pathname === "/studio") {
      const workflows = await loadWorkflows(ctx.rootDir);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(renderStudioHtml({
        workflows,
        defaultProject: process.env.AGENTFLOW_DASHBOARD_PROJECT ?? "templates/project"
      }));
      return;
    }

    if (requestUrl.pathname === "/run") {
      const runId = requestUrl.searchParams.get("id");
      if (!runId) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing id");
        return;
      }
      const details = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(runId)
        ? await getWorkflowRunDetails(runId)
        : { run: null, tasks: [], receipts: [] };
      if (!details.run) {
        response.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(renderDashboardStatusPage(404, "Run not found", `No run has the id ${runId}. It may have been mistyped or removed. The Runs page lists every run.`));
        return;
      }
      const [artifacts, approvals, historicalRuns,partnerHistory] = await Promise.all([
        listArtifacts({ runId }),
        listActionApprovals({ runId, limit: 100 }),
        listWorkflowRuns(250),
        loadQueuePartnerHistoryForRuns([runId])
      ]);
      const summary = await summarizeWorkflowRun(runId);
      const qualityReport = await loadCostQualityReport(runId);
      const observabilityReport = buildObservabilityReport({
        run: details.run,
        tasks: details.tasks,
        receipts: details.receipts,
        artifacts,
        version: program.version()
      });
      const usageEstimate = qualityReport
        ? await buildRunUsageEstimate({
          run: details.run,
          artifacts,
          routedStages: qualityReport.routedStages
        })
        : null;
      const preferenceScorecard = await loadPreferenceScorecard({
        projectDir: details.run.projectRootUri,
        limit: 25
      }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      const tuningProposals = preferenceScorecard ? buildTuningProposals(preferenceScorecard) : null;
      const approvalCeiling = await loadRunApprovalCeiling(details.run).catch(() => details.run!.autonomy);
      const eta = withWorkerAvailability(estimateRunEta({ run: details.run, tasks: details.tasks, historicalRuns }), dashboardRunCanProgress(await loadDashboardWorkAvailable(), details.run, details.tasks));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderRunDetailHtml({
        run: details.run,
        partnerProjects: (await listProjectStorageSummaries(100)).filter(project => project.rootUri === details.run!.projectRootUri),
        tasks: details.tasks,
        receipts: details.receipts,
        artifacts,
        approvals,
        params: requestUrl.searchParams,
        summary: summary.ok ? summary.value : null,
        qualityReport,
        observabilityReport,
        usageEstimate,
        eta,
        preferenceScorecard,
        tuningProposals,
        approvalCeiling
        ,partnerHistory:partnerHistory[runId]
      }));
      return;
    }

    if (requestUrl.pathname === "/queue") {
      const requestedProjectRootUri = requestUrl.searchParams.get("project")?.trim() || undefined;
      let projectRootUri: string | undefined;
      if (requestedProjectRootUri) {
        const requestedLocalRoot = path.resolve(await resolveLocalProjectRootUri(requestedProjectRootUri));
        const registeredProjects = await listProjectStorageSummaries(500);
        const registeredRoots = await Promise.all(registeredProjects.map(async (project) => ({
          project,
          localRoot: path.resolve(await resolveLocalProjectRootUri(project.rootUri))
        })));
        projectRootUri = registeredRoots.find((candidate) => candidate.localRoot === requestedLocalRoot)?.project.rootUri;
        if (!projectRootUri) {
          response.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          response.end(renderDashboardActionResult({ ok: false, error: "Queue filtering requires an exact registered project." }));
          return;
        }
      }
      const freshSnapshot = requestUrl.searchParams.get("_queue_snapshot") === "fresh";
      const snapshot = await loadQueueCardSnapshot(projectRootUri, freshSnapshot);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...queueSnapshotHeaders(snapshot),
        ...(freshSnapshot ? { "x-agentflow-queue-snapshot": snapshot.ageMs <= 750 ? "fresh" : "bounded-stale" } : {})
      });
      const requestedActionRun = requestUrl.searchParams.get("actionRun") ?? "";
      const flash = {
        notice: requestUrl.searchParams.get("notice")?.slice(0, 180) || undefined,
        error: requestUrl.searchParams.get("error")?.slice(0, 240) || undefined,
        actionRun: /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(requestedActionRun) ? requestedActionRun : undefined
      };
      response.end(renderQueueHtml(snapshot.value.queue, projectRootUri, flash, snapshot.value.historicalRuns, snapshot.value.partnerProjects, snapshot.value.partnerHistory, await loadDashboardWorkAvailable()));
      return;
    }

    if (requestUrl.pathname === "/approvals") {
      const status = requestUrl.searchParams.get("status") ?? "open";
      const [approvals, backlog] = await Promise.all([
        listActionApprovals({
        status: status === "all" || status === "open" ? undefined : status,
        runId: requestUrl.searchParams.get("run") ?? undefined,
        projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "100", 100)
        }),
        buildApprovalBacklogReport(ctx, {
          status: undefined,
          projectRootUri: requestUrl.searchParams.get("project") ? path.resolve(process.cwd(), requestUrl.searchParams.get("project") ?? "") : undefined,
          limit: parsePositiveInteger(requestUrl.searchParams.get("backlogLimit") ?? "500", 500),
          staleMinutes: parsePositiveInteger(requestUrl.searchParams.get("staleMinutes") ?? "60", 60)
        })
      ]);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderApprovalsHtml(
        approvals.filter((approval) => status !== "open" || isOpenApproval(approval)),
        status,
        requestUrl.searchParams,
        backlog
      ));
      return;
    }

    if (requestUrl.pathname === "/approvals/bulk") {
      const approvals = await listActionApprovals({
        status: "pending",
        runId: requestUrl.searchParams.get("run") ?? undefined,
        projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "100", 100)
      });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderBulkApprovalsHtml(approvals, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/approval-rules") {
      const projects = await listProjectStorageSummaries(100);
      const project = requestUrl.searchParams.get("project") ?? undefined;
      const [rules, trustedCommands] = await Promise.all([
        loadDashboardApprovalRules(project),
        loadDashboardTrustedCommands(projects, project)
      ]);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderApprovalRulesHtml(rules, trustedCommands, projects, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/evaluations") {
      const loaded = await loadReportOrLoadingPage(response, { title: "Evaluations", nav: "evaluations" }, "evaluations-page", () => Promise.all([loadCachedDashboardReport("evaluations:250", () => loadDashboardEvaluations()), loadCachedDashboardReport("evaluation-provider-statuses", () => loadAutoProviderStatuses())]), 5_000);
      if (!loaded) return;
      const [suites, providerStatuses] = loaded;
      const requestedSuite = requestUrl.searchParams.get("suite"), selected = requestedSuite ? suites.find((suite) => suite.id === requestedSuite) ?? null : suites[0] ?? null;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderEvaluationsHtml(suites, selected, providerStatuses));
      return;
    }

    if (requestUrl.pathname === "/workflow-graph") {
      const report = await loadDashboardWorkflowGraph(requestUrl.searchParams);
      const workflows = await loadWorkflows(ctx.rootDir);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderWorkflowGraphDashboardHtml(report, workflows, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/model-improvement") {
      const projects = await listProjectStorageSummaries(100);
      const project = requestUrl.searchParams.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT ?? projects[0]?.rootUri ?? "";
      const report = project
        ? await loadCachedDashboardReport(`model-improvement:${project}:${requestUrl.searchParams.get("limit") ?? "50"}:${requestUrl.searchParams.get("canary") ?? "default"}`, () => loadDashboardModelImprovementReport({
          projectDir: project,
          limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
        }))
        : null;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderModelImprovementHtml(report, projects, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/feedback-inbox") {
      const feedbackKey = `feedback-inbox:${requestUrl.searchParams.toString()}`;
      const report = await loadCachedDashboardReport(feedbackKey, () => loadDashboardFeedbackInboxReport({
        projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
      }));
      const projects = await listProjectStorageSummaries(100);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderFeedbackInboxHtml(report, projects, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/feedback-inbox/bulk") {
      const report = await loadDashboardFeedbackInboxReport({
        projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
      });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderFeedbackBulkReviewHtml(report, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/learning") {
      const requestedLearningView = requestUrl.searchParams.get("view") ?? "overview";
      const learningView = ["overview", "learning-loop", "recommendations", "approvals", "agent-improvements", "diagnostics", "settings"].includes(requestedLearningView)
        ? requestedLearningView
        : "overview";
      const projects = await listProjectStorageSummaries(100);
      const project = selectLearningProjectRoot({
        requested: requestUrl.searchParams.get("project"),
        configured: process.env.AGENTFLOW_DASHBOARD_PROJECT,
        runtimeRoot: ctx.rootDir,
        projects
      });
      const projectPath = project ? await resolveDashboardProjectPath(project) : null;
      const localLearningDir = projectPath?.localRootUri ?? project;
      const reportPromise = project && learningView !== "overview"
        ? loadLearningReport({
          projectDir: projectPath?.storageRootUri ?? project,
          limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
        }).then(async (report) => {
          report.failureTriage = await ctx.readJsonFile<LearningFailureTriageReport>(path.join(localLearningDir, ".agent-workflow", "learning", "failure-triage.json")) ?? undefined;
          return report;
        })
        : Promise.resolve(null);
      const learningQueuePromise = project && learningView === "approvals" ? readLearningApprovalQueue(localLearningDir).catch(() => null) : Promise.resolve(null);
      const learningDaemonPromise = project && (learningView === "diagnostics" || learningView === "settings") ? loadLearningDaemonStatus(ctx, localLearningDir) : Promise.resolve(null);
      const learningSettingsPromise = project && learningViewNeedsSettings(learningView) ? readLearningSettings(localLearningDir).catch(() => null) : Promise.resolve(null);
      const learningActionReceiptsPromise = project && learningView === "diagnostics"
        ? readLearningActionReceipts(localLearningDir).catch(() => emptyLearningActionReceipts(path.resolve(process.cwd(), localLearningDir)))
        : Promise.resolve(null);
      const learningActionReceiptHealthPromise = project && learningView === "diagnostics"
        ? loadLearningActionReceiptHealth(path.resolve(process.cwd(), localLearningDir))
        : Promise.resolve(null);
      const workflowShapePromise = project && learningView === "recommendations"
        ? loadWorkflowShapeOptimization(ctx, {
          projectDir: localLearningDir,
          workflowId: requestUrl.searchParams.get("workflow") ?? undefined,
          limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
        }).catch(() => null)
        : Promise.resolve(null);
      const agentImprovementPromise = project && learningView === "agent-improvements"
        ? loadAgentImprovementReport(ctx, {
          projectDir: localLearningDir,
          agentId: requestUrl.searchParams.get("agent") ?? undefined,
          limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50),
          mode: "read-only"
        }).catch(() => null)
        : Promise.resolve(null);
      const learningLoopPromise: Promise<LearningLoopDashboard | null> = project && learningView === "learning-loop"
        ? readLearningLoopState(localLearningDir).then((state) => buildLearningLoopDashboard(state, localLearningDir))
        : Promise.resolve(null);
      const agentImprovementPendingPromise = project
        ? loadAgentImprovementPendingSummary(projects, path.resolve(process.cwd(), localLearningDir))
        : Promise.resolve(null);
      const [report, learningQueue, learningDaemon, learningSettings, learningActionReceipts, learningActionReceiptHealth, supervisor, workflowShape, agentImprovement, learningLoop, agentImprovementPending] = await Promise.all([
        reportPromise,
        learningQueuePromise,
        learningDaemonPromise,
        learningSettingsPromise,
        learningActionReceiptsPromise,
        learningActionReceiptHealthPromise,
        loadDashboardSupervisorStatus(),
        workflowShapePromise,
        agentImprovementPromise,
        learningLoopPromise,
        agentImprovementPendingPromise
      ]);
      const learningApplicationPlan = learningQueue ? buildGovernedLearningApplicationPlan(learningQueue, "all") : null;
      const agentImprovementEval = agentImprovement
        ? await buildAgentImprovementPatchPlan(ctx, path.resolve(process.cwd(), localLearningDir), agentImprovement, "all")
          .then((patchPlan) => buildAgentImprovementEvalPlan(ctx, path.resolve(process.cwd(), localLearningDir), patchPlan, "all", parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)))
          .catch(() => null)
        : null;
      const agentImprovementPromotion = agentImprovement && agentImprovementEval
        ? await buildAgentImprovementPatchPlan(ctx, path.resolve(process.cwd(), localLearningDir), agentImprovement, "all")
          .then(async (patchPlan) => buildAgentImprovementPromotionQueue(
            path.resolve(process.cwd(), localLearningDir),
            patchPlan,
            agentImprovementEval,
            "all",
            await readAgentImprovementPromotionQueue(path.resolve(process.cwd(), localLearningDir)).catch(() => undefined)
          ))
          .catch(() => null)
        : null;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderLearningDashboardHtml(report, learningQueue, learningDaemon, learningApplicationPlan, learningActionReceipts, learningActionReceiptHealth, workflowShape, agentImprovement, agentImprovementEval, agentImprovementPromotion, learningSettings, supervisor, projects, requestUrl.searchParams, projectPath, learningLoop, agentImprovementPending));
      return;
    }

    if (requestUrl.pathname === "/candidate-comparisons") {
      const projects = await listProjectStorageSummaries(100);
      const project = requestUrl.searchParams.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT ?? projects[0]?.rootUri ?? "";
      const bucket = ["minute", "hour", "day", "week", "month"].includes(requestUrl.searchParams.get("bucket") ?? "") ? requestUrl.searchParams.get("bucket") as "minute" | "hour" | "day" | "week" | "month" : "day";
      const range = ["1h", "6h", "24h", "7d", "30d", "90d", "180d", "365d", "all"].includes(requestUrl.searchParams.get("range") ?? "") ? requestUrl.searchParams.get("range") as "1h" | "6h" | "24h" | "7d" | "30d" | "90d" | "180d" | "365d" | "all" : "90d";
      const from = requestUrl.searchParams.get("from");
      const to = requestUrl.searchParams.get("to");
      const report = project
        ? await loadCachedDashboardReport(`candidate-comparisons:${project}:${bucket}:${range}:${from ?? ""}:${to ?? ""}`, () => loadDashboardCandidateComparisonReport({ projectDir: project, bucket, range, from, to }))
        : null;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderCandidateComparisonsHtml(report, projects, requestUrl.searchParams));
      return;
    }
    if (requestUrl.pathname === "/training-proposals") {
      const projects = await listProjectStorageSummaries(100);
      const { projects: localProjects, selected: projectDir } = await resolveTrainingProjectChoices(projects, requestUrl.searchParams.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT, process.cwd());
      const [inbox, report] = await Promise.all([
        readTrainingProposalInbox(projectDir),
        readLatestTrainingDiscoveryReport(projectDir)
      ]);
      const evaluationViews = await loadTrainingProposalEvaluationViews(inbox, projectDir);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderTrainingProposalsHtml(inbox, report, localProjects, projectDir, requestUrl.searchParams, evaluationViews));
      return;
    }

    if (requestUrl.pathname === "/governance") {
      const report = await loadCachedDashboardReport(`governance:${requestUrl.searchParams.toString()}`, () =>
        loadGovernanceReport(ctx, parsePositiveInteger(requestUrl.searchParams.get("staleMinutes") ?? "15", 15), requestUrl.searchParams.get("includeEphemeral") === "true"));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderGovernanceHtml(filterGovernanceReport(report, requestUrl.searchParams), requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/roles") {
      const report = await loadCachedDashboardReport(`roles:${requestUrl.searchParams.toString()}`, () => loadRoleGovernanceReport(ctx, {
        projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50),
        role: requestUrl.searchParams.get("role") ?? undefined,
        status: requestUrl.searchParams.get("status") ?? undefined,
        actionType: requestUrl.searchParams.get("action") ?? undefined
      }));
      const projects = await listProjectStorageSummaries(100);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderRolesHtml(report, projects, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/artifact-lifecycle") {
      const report = await loadCachedDashboardReport(`artifact-lifecycle:${requestUrl.searchParams.toString()}`, () => loadArtifactLifecycleReport({
        projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
        kind: requestUrl.searchParams.get("kind") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "500", 500),
        prunePlan: requestUrl.searchParams.get("prunePlan") === "true",
        archivePlan: requestUrl.searchParams.get("archivePlan") === "true",
        restorePlan: requestUrl.searchParams.get("restorePlan") === "true",
        minAgeDays: requestUrl.searchParams.has("minAgeDays") ? parseNonNegativeInteger(requestUrl.searchParams.get("minAgeDays") ?? "", 30) : undefined,
        minBytes: requestUrl.searchParams.has("minBytes") ? parseNonNegativeInteger(requestUrl.searchParams.get("minBytes") ?? "", 20_000) : undefined,
        includeAudit: requestUrl.searchParams.has("includeAudit") ? requestUrl.searchParams.get("includeAudit") === "true" : undefined
      }));
      const projects = await listProjectStorageSummaries(100);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderArtifactLifecycleHtml(report, projects, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/backup-report") {
      const report = await loadCachedDashboardReport(`backup-report:${requestUrl.searchParams.toString()}`, () => loadBackupRestoreReport({
        projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "500", 500)
      }));
      const projects = await listProjectStorageSummaries(100);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderBackupRestoreHtml(report, projects, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/server-readiness") {
      const cacheKey = `server-readiness:${requestUrl.searchParams.toString()}`;
      const html = await loadCachedDashboardReport(cacheKey, async () => {
        const projectRootUri = requestUrl.searchParams.get("project") ?? undefined;
        const limit = parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "100", 100);
        const migrationDir = requestUrl.searchParams.get("migrationDir") ?? undefined;
        const [report, registry, storageVerification, migrationPlans, mergeEvidence, offlineFallback, runtimeMonitor, requestAudit, projects, worker] = await Promise.all([
          loadServerReadinessReport({ projectRootUri, limit }),
          loadServerProjectRegistryReport({
            projectRootUri,
            limit,
            includeRoots: requestUrl.searchParams.get("includeRoots") === "true"
          }),
          buildStorageVerificationReport({
            targetHost: requestUrl.searchParams.get("storageHost") ?? requestUrl.searchParams.get("targetHost") ?? undefined
          }),
          loadStorageMigrationPlanListing(migrationDir),
          loadStorageMergeEvidenceListing(ctx, migrationDir),
          loadOfflineFallbackReport(ctx),
          loadRuntimeMonitorReport(),
          loadServerRequestAuditLog(ctx, parsePositiveInteger(requestUrl.searchParams.get("requestLogLimit") ?? "50", 50)),
          listProjectStorageSummaries(100),
          loadDashboardWorkerStatus()
        ]);
      const objectProof = await buildObjectArtifactProofReport(ctx, {
        projectRootUri: report.projectRootUri || undefined,
        limit: parsePositiveInteger(requestUrl.searchParams.get("objectLimit") ?? "500", 500),
        enumerateBuckets: requestUrl.searchParams.get("enumerateBuckets") === "1",
        verify: requestUrl.searchParams.get("verifyObjects") === "1"
      });
      const statePlaneProof = buildSharedStatePlaneProof({
        server: report,
        storageVerification,
        mergeEvidence,
        offlineFallback,
        objectProof,
        runtimeMonitor
      });
        return renderServerReadinessHtml(report, registry, storageVerification, migrationPlans, mergeEvidence, offlineFallback, objectProof, runtimeMonitor, statePlaneProof, buildServerMutationControlReport(), buildServerApprovalActionPlanReport(), buildServerApprovalActionTestAdapterReport(), requestAudit, projects, worker, requestUrl.searchParams);
      });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }

    if (requestUrl.pathname === "/bundles") {
      const readiness = await loadReportOrLoadingPage(response, { title: "Workflow bundles", nav: "bundles" }, `bundles:${requestUrl.searchParams.toString()}`, () => loadDashboardBundleReadiness(requestUrl.searchParams));
      if (!readiness) return;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderBundleTrustHtml(readiness, requestUrl.searchParams));
      return;
    }
    if (requestUrl.pathname === "/runs") {
      const [runs, workAvailable] = await Promise.all([listWorkflowRuns(requestUrl.searchParams.has("relatedTo") ? 500 : 100, {
        runSetId: requestUrl.searchParams.get("runSet")?.trim() || undefined,
        relatedRunId: requestUrl.searchParams.get("relatedTo")?.trim() || undefined
      }), loadDashboardWorkAvailable()]);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderRunsHtml(runs, requestUrl.searchParams, workAvailable));
      return;
    }
    if (requestUrl.pathname === "/activity") {
      const [report, projects] = await Promise.all([
        loadUnifiedActivityReport(requestUrl.searchParams),
        listProjectStorageSummaries(100)
      ]);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(renderUnifiedActivityHtml(report, projects, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/projects") {
      const projects = await listProjectStorageSummaries(100);
      const identities = await loadDashboardProjectIdentityGroups(projects);
      const aliasMergePlan = buildDashboardProjectAliasMergePlan(projects, identities);
      const suggestionCounts = new Map<string, number>();
      await Promise.all(identities.filter((identity) => identity.visibility === "canonical").map(async (identity) => {
        const localRoot = await resolveLocalProjectRootUri(identity.primaryRootUri);
        const report = await readDashboardJsonFile<RoadmapSuggestionReport>(path.join(localRoot, ".agent-workflow", "learning", "roadmap-suggestions.json"), (value) => value.kind === "agentflow_roadmap_suggestions" && Array.isArray(value.suggestions));
        suggestionCounts.set(identity.primaryRootUri, report.value?.suggestions.length ?? 0);
      }));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderProjectsHtml(projects, identities, aliasMergePlan, suggestionCounts));
      return;
    }

    if (requestUrl.pathname === "/context-gateway") {
      const projects = await listProjectStorageSummaries(100);
      const selected = requestUrl.searchParams.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT ?? projects.find((item) => item.rootUri === ctx.rootDir)?.rootUri ?? ctx.rootDir;
      const report = await loadContextOperatorReport(ctx, await resolveLocalProjectRootUri(selected));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderContextGatewayHtml(report, projects, selected));
      return;
    }

    if (requestUrl.pathname === "/agents") {
      const projects = await listProjectStorageSummaries(100);
      const project = requestUrl.searchParams.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT ?? projects.find((item) => item.rootUri === ctx.rootDir)?.rootUri ?? projects[0]?.rootUri ?? "";
      const agents = await loadDashboardAgents(project || undefined);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderAgentsHtml(agents, projects, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/discovery") {
      const discoveryParams = new URLSearchParams(requestUrl.searchParams);
      discoveryParams.delete("page");
      discoveryParams.delete("q");
      const report = await loadReportOrLoadingPage(response, { title: "Discovery", nav: "discovery" }, `discovery:${discoveryParams.toString()}`, () => discoverLocalProjects(ctx, {
        roots: splitCommaList(requestUrl.searchParams.get("roots") ?? path.join(os.homedir(), "Projects")).map((item) => path.resolve(process.cwd(), item)),
        maxDepth: parsePositiveInteger(requestUrl.searchParams.get("maxDepth") ?? "5", 5),
        maxCandidates: parsePositiveInteger(requestUrl.searchParams.get("maxCandidates") ?? "200", 200),
        spotlight: parseSpotlightMode(requestUrl.searchParams.get("spotlight") ?? "auto")
      }));
      if (!report) return;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderDiscoveryHtml(report, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/project") {
      const rootUri = requestUrl.searchParams.get("root");
      if (!rootUri) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Missing root");
        return;
      }
      const detail = await loadDashboardProjectDetail(rootUri);
      if (!detail) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Project not found");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderProjectDetailHtml(detail, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/providers") {
      const dashboardUrl = dashboardUrlFromRequest(request);
      const info = await loadReportOrLoadingPage(response, { title: "Providers", nav: "providers" }, `providers-info:${dashboardUrl}`, () => withTimeout(
        loadDashboardProvidersInfo(dashboardUrl),
        8000,
        () => loadDashboardInfoFast(dashboardUrlFromRequest(request))
      ));
      if (!info) return;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderProvidersHtml(info, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/model-catalog") {
      const report = await loadReportOrLoadingPage(response, { title: "Model catalog", nav: "model-catalog" }, "model-catalog", () => withTimeout(
        loadDashboardModelCatalogReport(),
        5000,
        () => fallbackDashboardModelCatalogReport()
      ));
      if (!report) return;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderModelCatalogHtml(report));
      return;
    }

    if (requestUrl.pathname === "/roadmap") {
      const report = await loadRoadmapDashboardReport();
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderRoadmapDashboardHtml(report, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/fleet-model-usage") {
      const report = await loadDashboardFleetUsageReport();
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderFleetModelUsageHtml(report));
      return;
    }

    if (requestUrl.pathname === "/info" || requestUrl.pathname === "/settings") {
      const dashboardUrl = dashboardUrlFromRequest(request);
      const info = await loadReportOrLoadingPage(response, { title: "Settings", nav: "info" }, `dashboard-info:${dashboardUrl}`, () => withTimeout(
        loadDashboardInfo(dashboardUrlFromRequest(request)),
        1200,
        () => loadDashboardInfoFast(dashboardUrlFromRequest(request))
      ),2_000);
      if (!info) return;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderDashboardInfoHtml(info, requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "Unknown API path" }));
      return;
    }
    if (requestUrl.pathname !== "/" && requestUrl.pathname !== "/index.html") {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(renderDashboardStatusPage(404, "Page not found", `There is no dashboard page at ${requestUrl.pathname}. Check the address, or use the links below.`));
      return;
    }

    const [runs, throughput, workflows, worker, supervisor, runtimeMonitor, roadmap, queue, projects, services, pendingApprovals, approvedExecutableApprovals] = await Promise.all([
      loadCachedDashboardReport("dashboard-home:runs:25", () => listWorkflowRuns(25), 2_000),
      loadCachedDashboardReport("dashboard-home:throughput:7", () => listWorkflowRunThroughput(7), 2_000),
      loadWorkflows(ctx.rootDir),
      loadDashboardWorkerStatus(),
      loadDashboardSupervisorStatus(),
      loadCachedDashboardReport("runtime-monitor", () => loadRuntimeMonitorReport()),
      loadCachedDashboardReport("roadmap", () => loadRoadmapDashboardReport()),
      loadCachedDashboardReport("dashboard-home:queue:latest-related:100", () => listWorkflowQueue(100, { latestRelated: true }), 2_000),
      loadCachedDashboardReport("projects:100", () => listProjectStorageSummaries(100)),
      loadCachedDashboardReport("services", () => checkServices()),
      listActionApprovals({ status: "pending", limit: 25 }),
      listActionApprovals({ status: "approved", limit: 25 })
    ]);
    const agentImprovementPendingPromotions = await loadCachedDashboardReport(
      "dashboard-home:agent-improvement-pending",
      () => loadAgentImprovementPendingSummary(projects).then((summary) => summary.projects),
      30_000
    );
    const health: DashboardHomeHealth = {
      worker,
      supervisor,
      runtimeMonitor,
      roadmap,
      queue,
      projects,
      services,
      provider: process.env.DEFAULT_MODEL_PROVIDER ?? "mock",
      latestFailedRun: runs.find((run) => run.status === "failed") ?? null,
      pendingApprovals,
      approvedExecutableApprovals: approvedExecutableApprovals.filter((approval) => isExecutableApprovalAction(approval.actionType) && !approval.executedAt),
      learningDaemon: null,
      learningReceipts: null,
      agentImprovementPendingPromotions
    };
    const daemonProject = supervisor.learningProject ?? process.env.AGENTFLOW_DASHBOARD_PROJECT ?? "templates/project";
    [health.learningDaemon, health.learningReceipts] = await Promise.all([
      loadLearningDaemonStatus(ctx, daemonProject).catch(() => null),
      readLearningActionReceipts(daemonProject).catch(() => null)
    ]);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardHtml(runs, workflows, health, throughput));
  }

  async function indexDashboardProject(input: {
    project: string;
    maxFiles: string;
    refine: boolean;
  }): Promise<DashboardFollowUpResult> {
    const projectDir = input.project.trim();
    if (!projectDir) {
      return { ok: false, error: "Missing project path." };
    }
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      return {
        ok: false,
        error: missing.map((check) => `${check.endpoint.name}: ${check.message}`).join("\n")
      };
    }
    const maxFiles = parsePositiveInteger(input.maxFiles || "120", 120);
    const resolvedProjectDir = path.resolve(process.cwd(), projectDir);
    try {
      const result = await indexProjectForRun(ctx, {
        projectDir: resolvedProjectDir,
        maxFiles,
        refine: input.refine,
        forceRefine: false
      });
      return {
        ok: true,
        title: "Project Indexed",
        output: [
          `Project: ${result.projectName}`,
          `Path: ${resolvedProjectDir}`,
          formatIndexResult(result),
          `Open: /project?root=${encodeURIComponent(resolvedProjectDir)}`
        ].filter(Boolean).join("\n")
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function loadAgentImprovementPendingSummary(projects: DashboardProjectSummary[], selectedLocalDir?: string): Promise<AgentImprovementPendingSummary> {
    const targets = new Map<string, { projectRootUri: string; name: string }>();
    for (const project of projects) {
      targets.set(path.resolve(process.cwd(), project.rootUri), { projectRootUri: project.rootUri, name: project.name || project.rootUri });
    }
    const selectedKey = selectedLocalDir ? path.resolve(process.cwd(), selectedLocalDir) : null;
    if (selectedKey && selectedLocalDir && !targets.has(selectedKey)) {
      targets.set(selectedKey, { projectRootUri: selectedLocalDir, name: selectedKey });
    }
    const entries = await Promise.all([...targets.entries()].map(async ([key, target]) => {
      const counts = await countAgentImprovementPendingPromotions(target.projectRootUri).catch(() => null);
      if (!counts || counts.pending + counts.deferred === 0) {
        return null;
      }
      return { ...target, pending: counts.pending, deferred: counts.deferred, current: selectedKey === key };
    }));
    return { projects: entries.filter((entry): entry is AgentImprovementPendingProject => entry !== null) };
  }

  async function loadAutoProviderStatuses(): Promise<NonNullable<DashboardInfo["provider"]["providerStatuses"]>> {
    const [openai, codex, anthropic, deepseek, gemini, local, byo, compatible, muse, bedrock, kiro, mock] = await Promise.all([
      inspectOpenAIStatus(),
      inspectCodexCliStatus(),
      inspectAnthropicStatus(),
      inspectOpenAICompatibleStatus(ctx, {
        providerId: "deepseek",
        label: "DeepSeek",
        baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
        model: process.env.DEEPSEEK_MODEL || "deepseek-flash",
        apiKey: process.env.DEEPSEEK_API_KEY
      }),
      inspectOpenAICompatibleStatus(ctx, {
        providerId: "gemini",
        label: "Google Gemini",
        baseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/",
        model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
        apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
      }),
      inspectOpenAICompatibleStatus(ctx, {
        providerId: "local",
        label: "Local model runtime",
        baseUrl: process.env.LOCAL_MODEL_BASE_URL || "http://localhost:11434/v1",
        model: process.env.LOCAL_MODEL_NAME,
        apiKey: process.env.LOCAL_MODEL_API_KEY
      }),
      inspectOpenAICompatibleStatus(ctx, {
        providerId: "byo",
        label: "BYO / OpenAI-compatible gateway",
        baseUrl: process.env.BYO_MODEL_BASE_URL,
        model: process.env.BYO_MODEL_NAME,
        apiKey: process.env.BYO_MODEL_API_KEY
      }),
      inspectOpenAICompatibleStatus(ctx, {
        providerId: "openai-compatible",
        label: "OpenAI-compatible legacy",
        baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
        model: process.env.OPENAI_COMPATIBLE_MODEL,
        apiKey: process.env.OPENAI_COMPATIBLE_API_KEY
      }),
      inspectOpenAICompatibleStatus(ctx, {
        providerId: "muse",
        label: "Muse",
        baseUrl: process.env.MUSE_BASE_URL || "https://api.meta.ai/v1",
        model: process.env.MUSE_MODEL,
        apiKey: process.env.MUSE_API_KEY
      }),
      inspectBedrockStatus(),
      inspectProviderStatus({
        providerId: "kiro",
        label: "Kiro CLI",
        configured: Boolean(process.env.KIRO_API_KEY || process.env.KIRO_AGENT || process.env.KIRO_CLI_BIN),
        model: process.env.KIRO_AGENT || "auto",
        apiKeyStatus: process.env.KIRO_API_KEY ? "configured" : "CLI login or missing"
      }),
      {
        providerId: "mock",
        label: "Mock",
        configured: true,
        status: "ready" as const,
        model: "mock",
        details: ["Always available for deterministic local validation."]
      }
    ]);
    return [openai, codex, anthropic, deepseek, gemini, local, byo, compatible, muse, bedrock, kiro, mock];
  }

  async function loadCachedDashboardReport<T>(key: string, load: () => Promise<T>, ttlMs = dashboardReportCacheTtlMs): Promise<T> {
    let cached = dashboardReportCache.get(key);
    if (!cached && isDurableDashboardReportKey(key)) {
      const durable = await readDashboardReportSnapshot<T>(ctx.rootDir, key).catch(() => null);
      if (durable) {
        cached = { expiresAt: durable.capturedAt + ttlMs, value: durable.value };
        dashboardReportCache.set(key, cached);
      }
    }
    if (cached && cached.expiresAt > Date.now()) return cached.value as T;

    const pending = dashboardReportLoads.get(key);
    if (pending) return cached ? cached.value as T : pending as Promise<T>;

    const loadPromise = load()
      .then(async (value) => {
        dashboardReportCache.set(key, { expiresAt: Date.now() + ttlMs, value });
        if (isDurableDashboardReportKey(key)) await writeDashboardReportSnapshot(ctx.rootDir, key, value).catch(() => false);
        if (dashboardReportCache.size > 100) {
          const oldestKey = dashboardReportCache.keys().next().value as string | undefined;
          if (oldestKey) dashboardReportCache.delete(oldestKey);
        }
        return value;
      })
      .finally(() => dashboardReportLoads.delete(key));
    dashboardReportLoads.set(key, loadPromise);
    // Serve an expired snapshot while its replacement is refreshed. This keeps
    // diagnostic pages responsive even when their underlying probes are slow.
    if (cached) {
      void loadPromise.catch(() => undefined);
      return cached.value as T;
    }
    return loadPromise;
  }

  /** Wait briefly for a slow report. If it is not ready, send a loading page in the
   * normal layout that reloads itself, and let the report finish into the cache. */
  async function loadReportOrLoadingPage<T>(response: http.ServerResponse, page: { title: string; nav: Parameters<typeof dashboardNav>[0] }, key: string, load: () => Promise<T>, ttlMs?: number): Promise<T | undefined> {
    const notReady = Symbol("not-ready");
    const pending = loadCachedDashboardReport(key, load, ttlMs);
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([pending, new Promise<typeof notReady>((resolve) => { timer = setTimeout(() => resolve(notReady), DASHBOARD_LOADING_WAIT_MS); })]);
    if (timer) clearTimeout(timer);
    if (result !== notReady) return result as T;
    pending.catch(() => undefined);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(renderDashboardLoadingPage(page.title, page.nav));
    return undefined;
  }

  async function loadQueueCardSnapshot(projectRootUri: string | undefined, requestRefresh = false): Promise<QueueCardSnapshot<DashboardQueueSnapshot>> {
    const key = projectRootUri ?? "all";
    return queueCardSnapshots.get(key, async () => {
      const [queue, historicalRuns, partnerProjects] = await Promise.all([
        listWorkflowQueue(100, { projectRootUri, latestRelated: true }),
        listWorkflowRuns(250),
        listProjectStorageSummaries(100)
      ]);
      const [activityQueue, waitingQueue, activeCapabilities, latestCapabilityProbes, remoteFleetTrust] = await Promise.all([
        withQueueCardActivity(queue),
        withQueueWaitReasons(queue, ctx.defaultWorkerHeartbeatPath),
        loadActiveWorkerCapabilities(ctx.defaultWorkerHeartbeatPath),
        loadLatestWorkerCapabilityProbes(ctx.defaultWorkerHeartbeatPath),
        loadWorkerTrustStore().then(trustStore=>loadRemoteWorkerHeartbeatHealth({trustStore,heartbeatDir:ctx.defaultWorkerHeartbeatDir,cursorPath:path.join(ctx.defaultWorkerHeartbeatDir,"remote-ingestion-cursors.state")}))
      ]);
      const waitByRun = new Map(waitingQueue.map((item) => [item.runId, item.waitReason]));
      const checkedAt = new Date().toISOString();
      const enrichedQueue = activityQueue.map((item) => {
        const waitReason = waitByRun.get(item.runId);
        const requiredCapability = item.failureOwnership?.requiredWorkerCapability;
        const capableWorkers=requiredCapability?activeCapabilities.get(requiredCapability)??[]:[];
        const workerIds = capableWorkers.filter(worker=>workerEligibleForQueueProject(worker,item)).map(worker=>worker.workerId);
        const runtimeRemedy = requiredCapability ? {
          requiredCapability,
          state: workerIds.length ? "compatible-worker-active" as const : "awaiting-worker-rollout" as const,
          workerIds,
          checkedAt,
          eligibilityReason:workerEligibilityReason(capableWorkers,item,workerIds.length),
          latestProbe:latestCapabilityProbes.get(requiredCapability)??null,
          remoteFleetTrust
        } : null;
        return { ...item, ...(waitReason ? { waitReason } : {}), runtimeRemedy };
      });
      const removalQueue=await withFailedCardRemovalCandidates(enrichedQueue);
      const partnerHistory = await loadQueuePartnerHistoryForRuns(removalQueue.map((item) => item.runId));
      return { queue: removalQueue, historicalRuns, partnerProjects, partnerHistory };
    }, requestRefresh);
  }

  async function loadDashboardAgents(projectDir?: string): Promise<DashboardAgentsReport> {
    const warnings: string[] = [];
    const sharedAgents = await loadDashboardAgentSummaries(path.join(ctx.rootDir, "agents"), "shared", warnings);
    const projectRootUri = projectDir?.trim() ? path.resolve(process.cwd(), projectDir) : null;
    const sharedIds = new Set(sharedAgents.map((agent) => agent.id));
    const projectAgents = projectRootUri
      ? await loadDashboardAgentSummaries(path.join(projectRootUri, ".agent-workflow", "agents"), "project-local", warnings, sharedIds)
      : [];
    const effective = new Map<string, DashboardAgentSummary>();
    for (const agent of sharedAgents) {
      effective.set(agent.id, agent);
    }
    for (const agent of projectAgents) {
      effective.set(agent.id, agent);
    }
    return {
      generatedAt: new Date().toISOString(),
      projectRootUri,
      sharedAgents,
      projectAgents,
      effectiveAgents: [...effective.values()].sort(compareAgentSummaries),
      warnings
    };
  }

  async function loadDashboardBundleReadiness(params: URLSearchParams): Promise<DashboardBundleReadiness> {
    const projectParam = params.get("project")?.trim();
    const projectDir = projectParam ? path.resolve(process.cwd(), projectParam) : undefined;
    const errors: string[] = [];
    if (projectDir) {
      try {
        await fs.access(projectDir);
      } catch {
        errors.push(`Project path is not reachable: ${projectDir}`);
      }
    }

    const policy = normalizePolicy(params.get("policy") ?? process.env.AGENTFLOW_BUNDLE_TRUST_POLICY);
    const manifest = await loadCommittedBundleManifest(ctx.rootDir);
    if (!manifest) throw new Error("Bundle manifest is missing.");
    const packageJson = await ctx.readJsonFile<{ version?: string }>(path.join(ctx.rootDir, "package.json"));
    const statePath = projectDir ? path.join(projectDir, ".agent-workflow", "bundle-state.json") : undefined;
    const pinPath = projectDir ? path.join(projectDir, ".agent-workflow", "bundle-pin.json") : undefined;
    const state = statePath ? await ctx.readJsonFile<ProjectBundleState>(statePath) : null;
    const pin = pinPath ? await ctx.readJsonFile<ProjectBundlePin>(pinPath) : null;
    const compatibility = buildBundleCompatibilityReport(manifest, {
      agentWorkflow: packageJson?.version ?? "0.0.0",
      node: process.version.slice(1),
      mcp: manifest.compatibility.mcp
    });
    const upgradePreview = buildBundleUpgradePreview(manifest, {
      state: state ?? undefined,
      statePath
    });
    const catalog = await loadDefinitionMigrationCatalog(ctx.rootDir);
    const migrationPlan = buildDefinitionMigrationPlan({
      manifest,
      catalog,
      state: state ?? undefined,
      statePath
    });
    const contractTests = await runDefinitionContractTests({
      definitionsDir: ctx.rootDir,
      projectDir,
      provider: providerFromEnv("mock"),
      liveProvider: false
    });
    const registry = await loadDashboardBundleRegistry(params);
    return {
      generatedAt: new Date().toISOString(),
      projectDir: projectDir ?? null,
      verification: await verifyBundle(ctx.rootDir, policy),
      compatibility,
      registry,
      pin: pinPath ? { path: pinPath, value: pin } : null,
      upgradePreview,
      migrationPlan,
      contractTests,
      errors
    };
  }

  async function loadDashboardBundleRegistry(params: URLSearchParams): Promise<BundleRegistryReport> {
    const registryPath = path.resolve(process.cwd(), params.get("registry")?.trim() || ctx.defaultBundleRegistryPath);
    const registry = await loadBundleRegistry(registryPath);
    const manifest = await loadCommittedBundleManifest(ctx.rootDir);
    return buildBundleRegistryReport({
      registry,
      registryPath,
      installedManifest: manifest,
      installedChecksum: manifest?.checksum.value
    });
  }

  async function loadDashboardFleetUsageReport(): Promise<DashboardFleetUsageReport> {
    const ledgerPath = process.env.AGENTFLOW_FLEET_USAGE_LEDGER ?? path.join(ctx.rootDir, ".agent-workflow", "runtime", "fleet-model-usage.jsonl");
    const remoteUrl = process.env.AGENTFLOW_FLEET_USAGE_SUMMARY_URL?.trim();
    if (!remoteUrl) return { ...summarizeFleetUsage(await readFleetUsageReceipts(ledgerPath)), dashboardSource: "local-ledger" };
    try {
      const target = new URL(remoteUrl);
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("Summary URL must be an HTTP(S) URL without embedded credentials.");
      target.searchParams.set("limit", "100");
      const token = process.env.AGENTFLOW_FLEET_USAGE_SUMMARY_TOKEN;
      if (!token) throw new Error("Summary observer token is not configured.");
      const remote = await fetch(target, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
      if (!remote.ok) throw new Error(`Summary service returned HTTP ${remote.status}.`);
      const body = await readBoundedDashboardResponse(remote, 2_000_000);
      const parsed = JSON.parse(body) as ReturnType<typeof summarizeFleetUsage>;
      if (parsed.version !== 1 || !parsed.totals || !Array.isArray(parsed.clients) || !Array.isArray(parsed.receipts) || parsed.receipts.length > 500) throw new Error("Summary service returned an invalid report.");
      return { ...parsed, dashboardSource: "authoritative-gateway" };
    } catch (error) {
      return {
        ...summarizeFleetUsage(await readFleetUsageReceipts(ledgerPath)),
        dashboardSource: "local-fallback",
        dashboardNotice: `Authoritative summary unavailable: ${error instanceof Error ? error.message : "unknown error"}`
      };
    }
  }

  async function loadDashboardInfo(dashboardUrl: string): Promise<DashboardInfo> {
    const packageJson = JSON.parse(await fs.readFile(path.join(ctx.rootDir, "package.json"), "utf8")) as { name?: string; version?: string };
    const selectedProvider = process.env.DEFAULT_MODEL_PROVIDER ?? "mock";
    let adapter = selectedProvider;
    if (selectedProvider === "auto") {
      adapter = "auto-router";
    } else {
      try {
        adapter = providerFromEnv(selectedProvider).id;
      } catch {
        adapter = "unavailable";
      }
    }
    const [serviceChecks, agents, workflows, manifest, worker, supervisor, launchAgent, runtimeMonitor] = await Promise.all([
      checkServices(),
      loadAgents(ctx.rootDir),
      loadWorkflows(ctx.rootDir),
      loadCommittedBundleManifest(ctx.rootDir),
      loadDashboardWorkerStatus(),
      loadDashboardSupervisorStatus(),
      loadDashboardLaunchAgentStatus(),
      loadRuntimeMonitorReport()
    ]);

    return {
      app: {
        name: packageJson.name ?? "agent-workflow",
        version: packageJson.version ?? "0.0.0",
        rootDir: ctx.rootDir,
        dashboardUrl
      },
      provider: await describeProvider(selectedProvider, adapter),
      services: serviceChecks.map((check) => ({
        name: check.endpoint.name,
        reachable: check.reachable,
        message: check.message,
        requiredFor: check.endpoint.requiredFor
      })),
      registry: {
        agents: agents.length,
        workflows: workflows.length
      },
      bundle: manifest ? {
        version: manifest.bundle.version,
        checksum: manifest.checksum.value,
        files: manifest.counts.files,
        source: manifest.bundle.source
      } : null,
      storage: {
        databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
        redisUrlConfigured: Boolean(process.env.REDIS_URL),
        objectStorageConfigured: Boolean(process.env.OBJECT_STORAGE_ENDPOINT && process.env.OBJECT_STORAGE_BUCKET)
      },
      worker,
      supervisor,
      launchAgent,
      runtimeMonitor,
      commands: [
        "npm run doctor",
        "npm run validate",
        "npm run bundle-manifest",
        "npm run provider-check",
        "npm run dev:agentflow",
        "npm run worker:daemon",
        "npm run agentflow -- run-and-watch <workflow> --project <path> --task \"...\""
      ]
    };
  }

  async function loadDashboardInfoFast(dashboardUrl: string): Promise<DashboardInfo> {
    const packageJson = JSON.parse(await fs.readFile(path.join(ctx.rootDir, "package.json"), "utf8")) as { name?: string; version?: string };
    const selectedProvider = process.env.DEFAULT_MODEL_PROVIDER ?? "mock";
    let adapter = selectedProvider;
    if (selectedProvider === "auto") {
      adapter = "auto-router";
    } else {
      try {
        adapter = providerFromEnv(selectedProvider).id;
      } catch {
        adapter = "unavailable";
      }
    }
    const [serviceChecks, agents, workflows, manifest, worker, supervisor, launchAgent, runtimeMonitor] = await Promise.all([
      checkServices(),
      loadAgents(ctx.rootDir),
      loadWorkflows(ctx.rootDir),
      loadCommittedBundleManifest(ctx.rootDir),
      loadDashboardWorkerStatus(),
      loadDashboardSupervisorStatus(),
      loadDashboardLaunchAgentStatus(),
      loadRuntimeMonitorReport()
    ]);
    return {
      app: {
        name: packageJson.name ?? "agent-workflow",
        version: packageJson.version ?? "0.0.0",
        rootDir: ctx.rootDir,
        dashboardUrl
      },
      provider: describeProviderFast(selectedProvider, adapter),
      services: serviceChecks.map((check) => ({
        name: check.endpoint.name,
        reachable: check.reachable,
        message: check.message,
        requiredFor: check.endpoint.requiredFor
      })),
      registry: {
        agents: agents.length,
        workflows: workflows.length
      },
      bundle: manifest ? {
        version: manifest.bundle.version,
        checksum: manifest.checksum.value,
        files: manifest.counts.files,
        source: manifest.bundle.source
      } : null,
      storage: {
        databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
        redisUrlConfigured: Boolean(process.env.REDIS_URL),
        objectStorageConfigured: Boolean(process.env.OBJECT_STORAGE_ENDPOINT && process.env.OBJECT_STORAGE_BUCKET)
      },
      worker,
      supervisor,
      launchAgent,
      runtimeMonitor,
      commands: [
        "npm run doctor",
        "npm run validate",
        "npm run bundle-manifest",
        "npm run provider-check",
        "npm run dev:agentflow",
        "npm run worker:daemon",
        "npm run agentflow -- run-and-watch <workflow> --project <path> --task \"...\""
      ]
    };
  }

  async function loadDashboardLaunchAgentLog(kind: "stdout" | "stderr"): Promise<{ ok: boolean; kind: "stdout" | "stderr"; filePath: string; content: string; error?: string }> {
    const status = await loadDashboardLaunchAgentStatus();
    const filePath = kind === "stderr" ? status.stderrPath : status.stdoutPath;
    const relative = path.relative(ctx.defaultLaunchAgentLogDir, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { ok: false, kind, filePath, content: "", error: "Log path is outside the Agent Workflow launchd log directory." };
    }
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return { ok: true, kind, filePath, content: tailText(raw, 80_000) || "(log file is empty)" };
    } catch (error) {
      return { ok: false, kind, filePath, content: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function loadDashboardLaunchAgentStatus(): Promise<DashboardLaunchAgentStatus> {
    const label = ctx.defaultLaunchAgentLabel;
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const stdoutPath = path.join(ctx.defaultLaunchAgentLogDir, "stdout.log");
    const stderrPath = path.join(ctx.defaultLaunchAgentLogDir, "stderr.log");
    const [installed, stdoutExists, stderrExists] = await Promise.all([
      pathExists(plistPath),
      pathExists(stdoutPath),
      pathExists(stderrPath)
    ]);
    const base = {
      platform: process.platform,
      supported: process.platform === "darwin",
      label,
      plistPath,
      installed,
      pid: null,
      runs: null,
      stdoutPath,
      stderrPath,
      stdoutExists,
      stderrExists,
      lastError: "",
      installCommand: "npm run dev:agentflow:launchd:install",
      uninstallCommand: "npm run dev:agentflow:launchd:uninstall"
    };
    if (process.platform !== "darwin") {
      return { ...base, status: "unavailable" };
    }
    if (!installed) {
      return { ...base, status: "missing" };
    }
    const userId = typeof process.getuid === "function" ? process.getuid() : 0;
    const serviceTarget = `gui/${userId}/${label}`;
    const printResult = await execFileText(ctx, "launchctl", ["print", serviceTarget], { allowFailure: true });
    const pid = parseLaunchctlNumber(printResult.stdout, "pid");
    const runs = parseLaunchctlNumber(printResult.stdout, "runs");
    if (printResult.exitCode !== 0) {
      return {
        ...base,
        status: "installed",
        pid,
        runs,
        lastError: compactDashboardText(printResult.stderr || printResult.stdout || `launchctl print ${serviceTarget} failed.`, 500)
      };
    }
    return {
      ...base,
      status: /\bstate\s*=\s*running\b/.test(printResult.stdout) ? "running" : "installed",
      pid,
      runs,
      lastError: compactDashboardText(printResult.stderr, 500)
    };
  }

  async function loadDashboardModelImprovementReport(input: {
    projectDir: string;
    limit: number;
  }): Promise<DashboardModelImprovementReport> {
    const projectDir = path.resolve(process.cwd(), input.projectDir);
    const scorecard = await loadPreferenceScorecard({ projectDir, limit: input.limit });
    const proposals = buildTuningProposals(scorecard);
    const tuningOverlay = await loadDashboardTuningOverlayStatus(projectDir);
    const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: input.limit });
    const recentRouteReports = await loadCostQualityReportsForDashboardRuns(projectRuns.slice(0, Math.min(projectRuns.length, 50)));
    const feedbackTargets = await loadDashboardFeedbackTargets(projectRuns);
    const evaluationRunList = projectRuns.filter((run) => typeof run.evaluationMetadata?.suiteId === "string");
    const proposalCounts = countStrings(proposals.proposals.map((proposal) => proposal.kind));
    const highPriorityProposals = proposals.proposals.filter((proposal) => proposal.priority === "high").length;
    const feedbackNeeded = proposals.proposals.filter((proposal) => proposal.kind === "feedback_needed").length;
    const routingProposals = proposals.proposals.filter((proposal) => proposal.kind === "routing_preference").length;
    const feedbackTotal = Object.values(scorecard.feedbackCounts).reduce((sum, value) => sum + value, 0);
    const localProviderEvidence = buildDashboardLocalProviderEvidence(scorecard);
    const readiness: string[] = [];
    if (scorecard.runsAnalyzed === 0) {
      readiness.push("Run at least one workflow before diagnosing model improvement.");
    }
    if (feedbackTotal === 0) {
      readiness.push("Record accepted, revised, or rejected feedback before applying tuning.");
    }
    if (evaluationRunList.length === 0) {
      readiness.push("Add or run an evaluation suite before promoting routing or prompt changes.");
    }
    if (highPriorityProposals > 0) {
      readiness.push("Review high-priority proposals before repeating affected workflows.");
    }
    if (!readiness.length) {
      readiness.push("Local evidence is ready for baseline-versus-candidate comparison.");
    }
    const promotionReady = scorecard.runsAnalyzed > 0 && feedbackTotal > 0 && evaluationRunList.length > 0 && highPriorityProposals === 0;
    const localHoldoutRouting = await loadDashboardLocalHoldoutRoutingStatus(projectDir, localProviderEvidence);
    const routeReceiptTrends = buildDashboardRouteReceiptTrends(projectDir, recentRouteReports);
    const localLlmSmokeOutcomes = buildLocalLlmSmokeOutcomeTrend(projectDir, projectRuns, recentRouteReports);
    const localLlmSetup = await loadLocalLlmSetupChecklistReport(ctx, { projectDir, localHoldoutRouting, routeReceiptTrends, smokeOutcomes: localLlmSmokeOutcomes });
    const localLlmSetupGuide = await loadLocalLlmSetupGuideReport({ projectDir, checklist: localLlmSetup, approved: false });
    const localLlmDownloadRecommendations = buildLocalLlmDownloadRecommendationReport({ projectDir, scorecard, checklist: localLlmSetup, setupGuide: localLlmSetupGuide });
    const localLlmInstallationPlan = buildLocalLlmInstallationPlanReport(projectDir, localLlmDownloadRecommendations, "recommended");
    const localLlmInventory = await buildLocalLlmInventoryReport(projectDir, localLlmSetupGuide, localLlmDownloadRecommendations, localLlmInstallationPlan, recentRouteReports);
    const localLlmPrunePlan = buildLocalLlmPrunePlanReport(projectDir, localLlmInventory, "candidates");
    const localLlmCacheTrends = await buildLocalLlmCacheTrendReport(projectDir, localLlmInventory, localLlmPrunePlan, routeReceiptTrends, false);
    const localLlmCostLedger = await buildLocalLlmCostLedgerReport(projectDir, routeReceiptTrends, localLlmCacheTrends, false);
    const routeDecisionFeedback = await readRouteDecisionFeedbackLog(projectDir);
    const localLlmRoutingRecommendations = buildLocalLlmRoutingRecommendationReport({
      projectDir,
      localProviderEvidence,
      routeReceiptTrends,
      costLedger: localLlmCostLedger,
      cacheTrends: localLlmCacheTrends,
      routeDecisionFeedback
    });
    const localLlmRoutingNoteApplication = await loadDashboardLocalLlmRoutingNoteApplicationStatus(projectDir);
    const localLlmRoutingDecisionTimeline = await buildDashboardLocalLlmRoutingDecisionTimeline({
      projectDir,
      recommendations: localLlmRoutingRecommendations,
      noteApplication: localLlmRoutingNoteApplication,
      routeReceiptTrends
    });
    const localLlmRoutingDecisionSnapshots = await buildLocalLlmRoutingDecisionSnapshotReport(projectDir, localLlmRoutingDecisionTimeline, false);
    const localLlmBenchmarks = await buildLocalLlmBenchmarkReceiptReport({
      projectDir,
      execute: false,
      timeoutMs: 20000,
      checklist: localLlmSetup,
      setupGuide: localLlmSetupGuide,
      downloads: localLlmDownloadRecommendations
    });
    return {
      generatedAt: new Date().toISOString(),
      projectDir,
      scorecard,
      proposals,
      localProviderEvidence,
      localHoldoutRouting,
      routeReceiptTrends,
      localLlmSetup,
      localLlmSetupGuide,
      localLlmDownloadRecommendations,
      localLlmBenchmarks,
      localLlmInstallationPlan,
      localLlmInventory,
      localLlmPrunePlan,
      localLlmCacheTrends,
      localLlmCostLedger,
      localLlmRoutingRecommendations,
      localLlmRoutingNoteApplication,
      localLlmRoutingDecisionTimeline,
      localLlmRoutingDecisionSnapshots,
      evaluationRuns: evaluationRunList.length,
      latestEvaluationAt: evaluationRunList.map((run) => run.startedAt).sort().at(-1) ?? null,
      proposalCounts,
      highPriorityProposals,
      feedbackNeeded,
      routingProposals,
      promotionReady,
      readiness,
      tuningOverlay,
      feedbackTargets,
      nextCommands: [
        `npm run agentflow -- quality-report --run <run-id>`,
        `npm run agentflow -- feedback --run <run-id> --rating accepted|revised|rejected --note "<why>"`,
        `npm run agentflow -- tuning-proposals --project ${shellQuote(projectDir)}`,
        `npm run agentflow -- local-llm-routing-decision-snapshot --project ${shellQuote(projectDir)} --write`,
        `npm run agentflow -- local-route-feedback --project ${shellQuote(projectDir)} --workflow build-feature --stage verify --agent auto-test-runner --provider local --tier fast --class local-selected --rating helpful --note "<why>"`,
        `npm run agentflow -- run-and-watch model-improvement --project ${shellQuote(projectDir)} --task "Improve quality while reducing cost"`
      ]
    };
  }

  async function loadDashboardProjectDetail(rootUri: string): Promise<DashboardProjectDetail | null> {
    const projects = await listProjectStorageSummaries(500);
    const project = projects.find((item) => item.rootUri === rootUri);
    if (!project) {
      return null;
    }
    const projectPath = await resolveDashboardProjectPath(rootUri);
    const [files, memory, runs, contextFiles, roadmapSuggestions, roadmapSuggestionDecisions, learningDaemon] = await Promise.all([
      listProjectFileSummaries({ projectRootUri: rootUri, limit: 20 }),
      getLatestMemory({ projectRootUri: rootUri, limit: 8 }),
      listWorkflowRunsForProject({ projectRootUri: rootUri, limit: 12 }),
      loadDashboardProjectContextFiles(projectPath.localRootUri),
      readDashboardJsonFile<RoadmapSuggestionReport>(
        path.join(projectPath.localRootUri, ".agent-workflow", "learning", "roadmap-suggestions.json"),
        (value) => value.kind === "agentflow_roadmap_suggestions" && Array.isArray(value.suggestions)
      ).then((result) => result.value).catch(() => null),
      readRoadmapSuggestionDecisions(projectPath.localRootUri),
      loadLearningDaemonStatus(ctx, projectPath.localRootUri).catch(() => null)
    ]);
    const config = project.config as {
      actions?: { allowed_write_paths?: string[] };
      policies?: { allow_wide_open?: boolean };
    };
    return {
      project,
      files,
      memory,
      runs,
      contextFiles,
      initialized: contextFiles.some((file) => file.relativePath === ".agent-workflow/project.yaml" && file.exists),
      allowWrites: Boolean(config.policies?.allow_wide_open || (config.actions?.allowed_write_paths?.length ?? 0) > 0),
      roadmapSuggestions,
      roadmapSuggestionDecisions,
      learningDaemon
    };
  }

  async function loadDashboardProvidersInfo(dashboardUrl: string): Promise<DashboardInfo> {
    const info = await loadDashboardInfoFast(dashboardUrl);
    info.provider = await describeProvider(info.provider.selected, info.provider.adapter);
    return info;
  }

  async function loadDashboardRoleAuditView(params: URLSearchParams): Promise<DashboardRoleAuditViewResult> {
    const projectInput = params.get("project")?.trim() || "";
    const projectDir = projectInput ? path.resolve(process.cwd(), projectInput) : null;
    const fileInput = params.get("file")?.trim() || "";
    const fileName = path.basename(fileInput);
    if (!fileName || fileName !== fileInput || !fileName.endsWith(".md")) {
      return { ok: false, error: "Missing or invalid role audit file name.", projectDir };
    }
    const exportDir = path.resolve(projectDir ?? ctx.rootDir, ".agent-workflow", "exports", "roles");
    const markdownPath = path.resolve(exportDir, fileName);
    if (!isPathInside(markdownPath, exportDir)) {
      return { ok: false, error: "Role audit file must be inside the local role export folder.", projectDir };
    }
    try {
      const markdown = await fs.readFile(markdownPath, "utf8");
      const jsonPath = markdownPath.replace(/\.md$/u, ".json");
      let summary: DashboardRoleAuditExportSummary | null = null;
      if (fsSync.existsSync(jsonPath)) {
        try {
          summary = roleAuditSummaryFromPayload(jsonPath, JSON.parse(await fs.readFile(jsonPath, "utf8")) as unknown);
        } catch {
          summary = null;
        }
      }
      return { ok: true, projectDir, fileName, markdownPath, jsonPath: fsSync.existsSync(jsonPath) ? jsonPath : null, markdown, summary };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { ok: false, error: "Role audit export was not found.", projectDir };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error), projectDir };
    }
  }

  async function loadDashboardSupervisorStatus(): Promise<DashboardSupervisorStatus> {
    const heartbeatPath = path.resolve(process.cwd(), process.env.AGENTFLOW_SUPERVISOR_HEARTBEAT ?? ctx.defaultSupervisorHeartbeatPath);
    try {
      const heartbeat = JSON.parse(await fs.readFile(heartbeatPath, "utf8")) as Partial<SupervisorHeartbeat>;
      const lastHeartbeatAt = typeof heartbeat.lastHeartbeatAt === "string" ? heartbeat.lastHeartbeatAt : null;
      const ageMs = lastHeartbeatAt ? Date.now() - Date.parse(lastHeartbeatAt) : null;
      const monitorIntervalMs = typeof heartbeat.monitorIntervalMs === "number" ? heartbeat.monitorIntervalMs : 5000;
      const staleAfterMs = Math.max(monitorIntervalMs * 3, 20_000);
      const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : null;
      const processAlive = pid ? isProcessAlive(pid) : false;
      const heartbeatStatus = heartbeat.status ?? "stopped";
      const compatible = heartbeat.protocolVersions?.runtime === ctx.protocolVersions.runtime && heartbeat.protocolVersions?.storage === ctx.protocolVersions.storage && heartbeat.protocolVersions?.bundle === ctx.protocolVersions.bundle;
      const running = compatible && processAlive && ageMs !== null && ageMs <= staleAfterMs && heartbeatStatus === "running";
      return {
        runtimeVersion: typeof heartbeat.runtimeVersion === "string" ? heartbeat.runtimeVersion : null,
        bundleVersion: typeof heartbeat.bundleVersion === "string" ? heartbeat.bundleVersion : null,
        protocolVersions: heartbeat.protocolVersions ?? null,
        heartbeatPath,
        configured: true,
        status: running ? "running" : heartbeatStatus === "failed" ? "failed" : heartbeatStatus === "stopped" ? "stopped" : "stale",
        pid,
        processAlive,
        message: typeof heartbeat.message === "string" ? heartbeat.message : "",
        startedAt: typeof heartbeat.startedAt === "string" ? heartbeat.startedAt : null,
        lastHeartbeatAt,
        ageMs,
        ticks: typeof heartbeat.ticks === "number" ? heartbeat.ticks : 0,
        dashboardPort: typeof heartbeat.dashboardPort === "number" ? heartbeat.dashboardPort : null,
        dashboardManaged: heartbeat.dashboardManaged === true,
        workerManaged: heartbeat.workerManaged === true,
        learningManaged: heartbeat.learningManaged === true,
        learningEnabled: heartbeat.learningEnabled !== false,
        learningScope: heartbeat.learningScope === "project" || heartbeat.learningScope === "all-projects" ? heartbeat.learningScope : null,
        learningProject: typeof heartbeat.learningProject === "string" ? heartbeat.learningProject : null,
        learningMode: heartbeat.learningMode === "observe" || heartbeat.learningMode === "propose" || heartbeat.learningMode === "apply-approved" ? heartbeat.learningMode : null,
        learningHeartbeatPath: typeof heartbeat.learningHeartbeatPath === "string" ? heartbeat.learningHeartbeatPath : null,
        command: typeof heartbeat.command === "string" ? heartbeat.command : "npm run dev:agentflow"
      };
    } catch {
      return {
        runtimeVersion: null,
        bundleVersion: null,
        protocolVersions: null,
        heartbeatPath,
        configured: false,
        status: "missing",
        pid: null,
        processAlive: false,
        message: "No supervisor heartbeat found.",
        startedAt: null,
        lastHeartbeatAt: null,
        ageMs: null,
        ticks: 0,
        dashboardPort: null,
        dashboardManaged: false,
        workerManaged: false,
        learningManaged: false,
        learningEnabled: false,
        learningScope: null,
        learningProject: null,
        learningMode: null,
        learningHeartbeatPath: null,
        command: "npm run dev:agentflow"
      };
    }
  }

  /** True when a worker or supervisor heartbeat is live, so queued work will be picked up. */
  async function loadDashboardWorkAvailable(): Promise<boolean> {
    return loadCachedDashboardReport("dashboard:work-available", async () => {
      const [worker, supervisor] = await Promise.all([loadDashboardWorkerStatus().catch(() => null), loadDashboardSupervisorStatus().catch(() => null)]);
      return worker?.status === "running" || supervisor?.status === "running";
    }, 2_000);
  }

  async function loadDashboardWorkerStatus(): Promise<DashboardWorkerStatus> {
    const heartbeatPath = path.resolve(process.cwd(), process.env.AGENTFLOW_WORKER_HEARTBEAT ?? ctx.defaultWorkerHeartbeatPath);
    const [lanes,remoteFleetTrust]=await Promise.all([loadWorkerHeartbeatLanes(heartbeatPath),loadWorkerTrustStore().then(trustStore=>loadRemoteWorkerHeartbeatHealth({trustStore,heartbeatDir:ctx.defaultWorkerHeartbeatDir,cursorPath:path.join(ctx.defaultWorkerHeartbeatDir,"remote-ingestion-cursors.state")}))]);
    const activeLane = lanes.find((lane) => lane.status === "running") ?? lanes[0];
    if (activeLane) {
      return {
        ...activeLane,
        remoteFleetTrust,
        lanes
      };
    }
    return {
      runtimeVersion: null,
      bundleVersion: null,
        protocolVersions: null,
      heartbeatPath,
      configured: false,
      workerId: null,
      hostId:null,
      runtimeBuildDigest:null,
      heartbeatTrustState:"unsigned",
      heartbeatTrustReason:"No worker heartbeat is available.",
      status: "missing",
      pid: null,
      startedAt: null,
      lastHeartbeatAt: null,
      ageMs: null,
      limit: null,
      projectRootUri: null,
      projectId: null,
      projectIdentityId: null,
      projectIdentityGeneration: null,
      sourceRevision: null,
      concurrency: null,
      perProjectConcurrency: null,
      intervalMs: null,
      ticks: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
      executionCapabilities: [],
      executionCapabilityProbes: [],
      remoteFleetTrust,
      processAlive: false,
      command: "npm run worker:daemon",
      lanes: []
    };
  }

  async function loadDashboardWorkflowGraph(params: URLSearchParams): Promise<DashboardWorkflowGraphReport> {
    const projectDir = path.resolve(process.cwd(), params.get("project")?.trim() || process.env.AGENTFLOW_DASHBOARD_PROJECT || "templates/project");
    const workflows = await loadWorkflows(ctx.rootDir);
    const workflowId = params.get("workflow")?.trim() || workflows.find((workflow) => workflow.triggers.manual)?.id || workflows[0]?.id;
    if (!workflowId) throw new Error("No workflow definitions are available.");
    const workflow = resolveWorkflow(workflows, workflowId);
    if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
    const project = await loadProjectConfig(projectDir);
    const resolvedPolicy = resolveExecutionPolicy(project, params.get("policyProfile")?.trim() || undefined);
    const report = buildWorkflowGraphReport({
      workflow,
      agents: await loadAgentsForProject(ctx, projectDir),
      project,
      resolvedPolicy
    });
    const runLimit = parseDashboardRunLimit(params.get("runLimit") ?? "50", 50);
    const runScope = parseDashboardRunScope(params.get("runScope") ?? "project");
    const runStatusFilter = parseDashboardRunStatusFilter(params.get("runStatus") ?? "all");
    const requestedStageFocus = params.get("stage")?.trim() || "";
    const focusedStageId = report.stages.some((stage) => stage.id === requestedStageFocus) ? requestedStageFocus : "";
    const safeRunLimit = Math.min(Math.max(runLimit, 0), 250);
    const runWarnings: string[] = [];
    let runs: DashboardWorkflowGraphRun[] = [];
    let liveStageRuns: DashboardWorkflowStageRun[] = [];
    let stageHealth: DashboardWorkflowStageHealth[] = [];
    let focusedStageRuns: DashboardWorkflowStageRun[] = [];
    let focusedStageFixRuns: DashboardWorkflowGraphRun[] = [];
    let focusedStageVerificationRuns: DashboardWorkflowGraphRun[] = [];
    let recentGraphExports: DashboardGraphExportSummary[] = [];
    let graphPresets: DashboardGraphPreset[] = [];
    let handoffs: Awaited<ReturnType<typeof listWorkflowHandoffs>> = [];
    if (safeRunLimit > 0) {
      try {
        const historyFetchLimit = Math.min(Math.max(safeRunLimit * 4, safeRunLimit), 1000);
        const historyRuns = runScope === "all-projects"
          ? await listWorkflowRuns(historyFetchLimit)
          : await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: historyFetchLimit });
        runs = historyRuns
          .filter((run) => !run.dismissed)
          .filter((run) => run.workflowId === workflow.id)
          .filter((run) => dashboardRunMatchesStatus(run.status, runStatusFilter))
          .slice(0, safeRunLimit)
          .map(dashboardWorkflowGraphRunFromStorage);
        stageHealth = await listWorkflowStageHealthForRuns({ runIds: runs.map((run) => run.id) });
        const activeRunIds = runs.filter((run) => run.status === "queued" || run.status === "leased" || run.status === "running").map((run) => run.id);
        if (activeRunIds.length) {
          liveStageRuns = (await Promise.all(report.stages.map((stage) => listWorkflowStageRunsForRuns({ runIds: activeRunIds, stageId: stage.id })))).flat();
        }
        handoffs = (await Promise.all(runs.map((run) => listWorkflowHandoffs({ runId: run.id })))).flat();
        if (focusedStageId) {
          focusedStageRuns = await listWorkflowStageRunsForRuns({ runIds: runs.map((run) => run.id), stageId: focusedStageId });
          focusedStageFixRuns = historyRuns
            .filter((run) => !run.dismissed)
            .filter((run) => isFocusedStageFixRun(run, report.workflow.id, focusedStageId))
            .slice(0, 8)
            .map(dashboardWorkflowGraphRunFromStorage);
          focusedStageVerificationRuns = historyRuns
            .filter((run) => !run.dismissed)
            .filter((run) => isFocusedStageVerificationRun(run, report.workflow.id, focusedStageId))
            .slice(0, 8)
            .map(dashboardWorkflowGraphRunFromStorage);
        }
        if (!runs.length) {
          const statusLabel = runStatusFilter === "all" ? "any status" : runStatusFilter;
          const scopeLabel = runScope === "all-projects" ? "all registered projects" : `project ${projectDir}`;
          runWarnings.push(`No stored ${workflow.id} runs with ${statusLabel} matched ${scopeLabel}. The graph is showing the workflow definition only for this scope.`);
        }
      } catch (error) {
        runWarnings.push(`Run history unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      recentGraphExports = await listDashboardGraphHandoffExports(projectDir, 8);
    } catch (error) {
      runWarnings.push(`Graph handoff exports unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      graphPresets = (await readDashboardGraphPresets(projectDir)).presets;
    } catch (error) {
      runWarnings.push(`Graph presets unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ...report, handoffPackets: handoffs, runs, liveStageRuns, runScope, runStatusFilter, runWarnings, stageHealth, focusedStageId, focusedStageRuns, focusedStageFixRuns, focusedStageVerificationRuns, recentGraphExports, graphPresets };
  }

  async function loadDockerMonitorStatus(): Promise<RuntimeMonitorReport["docker"]> {
    const result = await execFileText(ctx, "docker", ["ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Ports}}"], { allowFailure: true });
    if (result.exitCode !== 0) {
      return {
        status: "unavailable",
        message: compactDashboardText(result.stderr || result.stdout || "docker ps failed", 500),
        containers: []
      };
    }
    const containers = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name = "", image = "", ports = ""] = line.split("\t");
      return { name, image, ports };
    });
    return {
      status: "running",
      message: containers.length ? `${containers.length} running container(s).` : "Docker is available with no running containers.",
      containers
    };
  }

  async function loadLocalModelRuntimeStatus(): Promise<RuntimeMonitorReport["localModelRuntime"]> {
    const fallback: RuntimeMonitorReport["localModelRuntime"] = {
      runtime: "missing", executable: null, label: "dev.agent-workflow.local-model",
      plistPath: path.join(os.homedir(), "Library", "LaunchAgents", "dev.agent-workflow.local-model.plist"),
      installed: false, serviceStatus: process.platform === "darwin" ? "missing" : "unavailable", pid: null, runs: null,
      endpoint: safeDisplayUrl(process.env.LOCAL_MODEL_BASE_URL || "http://127.0.0.1:11434/v1") || "invalid",
      endpointHealthy: false, modelCount: 0, selectedModel: process.env.LOCAL_MODEL_NAME || "auto",
      stdoutPath: path.join(ctx.rootDir, ".agent-workflow", "runtime", "local-model", "stdout.log"),
      stderrPath: path.join(ctx.rootDir, ".agent-workflow", "runtime", "local-model", "stderr.log"),
      installCommand: "npm run local-model:launchd:install", uninstallCommand: "npm run local-model:launchd:uninstall",
      restartCommand: "npm run local-model:launchd:install", guidance: "Local runtime status could not be loaded."
    };
    try {
      const result = await execFileText(ctx, process.execPath, [path.join(ctx.rootDir, "scripts", "local-model-runtime.mjs"), "status", "--json"], { allowFailure: true });
      if (result.exitCode !== 0) return { ...fallback, guidance: compactDashboardText(result.stderr || result.stdout, 300) || fallback.guidance };
      return { ...fallback, ...JSON.parse(result.stdout) };
    } catch (error) {
      return { ...fallback, guidance: error instanceof Error ? error.message : String(error) };
    }
  }

  async function loadMcpPipelineStatus(input: { checkMcp?: boolean } = {}): Promise<RuntimeMonitorReport["mcpPipeline"]> {
    const pluginRoot = agentWorkflowPluginRoot();
    const manifestPath = path.join(pluginRoot, ".mcp.json");
    const launcherPath = path.join(pluginRoot, "scripts", "run-agent-workflow-mcp.sh");
    const stdioLogPath = path.join(ctx.rootDir, ".agent-workflow", "runtime", "mcp", "stdio.log");
    const launcherLogPath = path.join(ctx.rootDir, ".agent-workflow", "runtime", "mcp", "launcher.log");
    let [configText, launcherStat, repoResolved, serverBuilt, lastStdioEvents, lastLauncherEvents] = await Promise.all([
      fs.readFile(path.join(os.homedir(), ".codex", "config.toml"), "utf8").catch(() => ""),
      fs.stat(launcherPath).catch(() => null),
      pathExists(path.join(ctx.rootDir, "package.json")),
      pathExists(path.join(ctx.rootDir, "dist", "apps", "mcp", "src", "index.js")),
      tailJsonl(stdioLogPath, 12),
      tailJsonl(launcherLogPath, 12)
    ]);
    const pluginEnabled = /\[plugins\."agent-workflow@personal"\][\s\S]*?enabled\s*=\s*true/.test(configText);
    const launcherExists = Boolean(launcherStat);
    const launcherExecutable = Boolean(launcherStat && (launcherStat.mode & 0o111));
    const smoke = input.checkMcp
      ? await runMcpPipelineSmoke({ launcherPath, pluginRoot })
      : {
          status: "not-run" as const,
          toolCount: null,
          message: "Run npm run runtime-monitor -- --check-mcp to verify the Codex plugin launcher on demand.",
          command: "npm run runtime-monitor -- --check-mcp",
          checkedAt: null
        };
    if (input.checkMcp) {
      [lastStdioEvents, lastLauncherEvents] = await Promise.all([
        tailJsonl(stdioLogPath, 12),
        tailJsonl(launcherLogPath, 12)
      ]);
    }
    const lastSpawn = [...lastStdioEvents].reverse().find((event) => event.event === "start");
    const lastExit = [...lastStdioEvents].reverse().find((event) => event.event === "exit");
    const ready = pluginEnabled && launcherExists && repoResolved && serverBuilt && (!input.checkMcp || smoke.status === "passed");
    const clientReload = buildMcpClientReloadGuidance({
      smoke,
      lastSpawnAt: typeof lastSpawn?.ts === "string" ? lastSpawn.ts : null,
      lastExitAt: typeof lastExit?.ts === "string" ? lastExit.ts : null,
      lastExitCode: typeof lastExit?.code === "number" ? lastExit.code : null,
      recentExitCount: lastStdioEvents.filter((event) => event.event === "exit").length
    });
    const approvalDiagnostics = buildMcpApprovalDiagnostics(lastStdioEvents);
    const commandDiagnostics = buildMcpCommandDiagnostics(lastStdioEvents);
    const recovery = await loadMcpRecoveryStatus();
    return {
      status: ready ? "ok" : "attention",
      pluginEnabled,
      pluginRoot,
      manifestPath,
      launcherPath,
      launcherExists,
      launcherExecutable,
      repoResolved,
      resolvedRepo: repoResolved ? ctx.rootDir : null,
      serverBuilt,
      stdioLogPath,
      launcherLogPath,
      lastStdioEvents,
      lastLauncherEvents,
      lastSpawnAt: typeof lastSpawn?.ts === "string" ? lastSpawn.ts : null,
      lastExitAt: typeof lastExit?.ts === "string" ? lastExit.ts : null,
      lastExitCode: typeof lastExit?.code === "number" ? lastExit.code : null,
      smoke,
      clientReload,
      approvalDiagnostics,
      commandDiagnostics,
      recovery
    };
  }

  async function loadMcpRecoveryStatus(): Promise<RuntimeMonitorReport["mcpPipeline"]["recovery"]> {
    const paths = mcpRecoveryPaths();
    const stat = await fs.stat(paths.jsonPath).catch(() => null);
    return {
      ...paths,
      status: stat ? "available" : "not-written",
      lastWrittenAt: stat ? stat.mtime.toISOString() : null,
      recommendedAction: "Write the recovery package after a transport failure, then restart or reload the Codex task/IDE client if the launcher smoke passes but the client still reports Transport closed.",
      canRestartClientPipe: false,
      reason: "Agent Workflow cannot reconnect a client-owned stdio pipe from inside the server. It can verify the launcher, preserve evidence, and provide safe local recovery commands."
    };
  }

  async function loadProjectSchedules(projectDir: string): Promise<ScheduleEntry[]> {
    const schedulePath = path.join(projectDir, ".agent-workflow", "schedules.yaml");
    try {
      const raw = await fs.readFile(schedulePath, "utf8");
      const parsed = YAML.parse(raw) as { schedules?: ScheduleEntry[] } | ScheduleEntry[];
      return Array.isArray(parsed) ? parsed : parsed.schedules ?? [];
    } catch {
      return [];
    }
  }

  async function loadProjectWorkerPoolDefaults(projectDir: string): Promise<{
    workerId?: string;
    limit?: number;
    concurrency?: number;
    perProjectConcurrency?: number;
    leaseSeconds?: number;
    intervalMs?: number;
    projectScoped?: boolean;
  }> {
    try {
      const project = await loadProjectConfig(projectDir);
      const workerPool = project.execution.worker_pool;
      return {
        workerId: workerPool?.worker_id,
        limit: workerPool?.limit,
        concurrency: workerPool?.concurrency,
        perProjectConcurrency: workerPool?.per_project_concurrency,
        leaseSeconds: workerPool?.lease_seconds,
        intervalMs: workerPool?.interval_ms,
        projectScoped: workerPool?.project_scoped
      };
    } catch {
      return {};
    }
  }

  async function loadRestoreDrillReport(input: {
    projectRootUri?: string;
    limit: number;
  }): Promise<RestoreDrillReport> {
    const projectRootUri = input.projectRootUri?.trim() || undefined;
    const services = await checkServices();
    const servicesReachable = services.every((service) => service.reachable);
    if (!servicesReachable) {
      return {
        kind: "agentflow_restore_drill_report",
        generatedAt: new Date().toISOString(),
        projectRootUri: projectRootUri ?? null,
        limit: input.limit,
        status: "attention",
        services,
        restoredSnapshotsInspected: 0,
        passed: 0,
        warnings: services.filter((service) => !service.reachable).length,
        checks: [],
        recommendedCommands: restoreDrillCommands(projectRootUri),
        notes: ["Enterprise services are not all reachable. Start local services before running restore verification."]
      };
    }

    const restoredRows = await listArtifactLifecycle({ projectRootUri, kind: "restored_artifact", limit: input.limit });
    const checks: RestoreDrillCheck[] = [];
    for (const row of restoredRows) {
      const restoredArtifact = await getArtifactByUri(row.uri);
      const restoreSource = restoredArtifact ? objectFromRecord(restoredArtifact.content, "restoreSource") : {};
      const restoreMetadata = restoredArtifact ? objectFromRecord(restoredArtifact.content, "restoreMetadata") : {};
      const sourceArchiveUri = stringFromRecord(restoreSource, "archivedArtifactUri");
      const originalUri = stringFromRecord(restoreMetadata, "originalUri") || stringFromRecord(restoredArtifact?.content ?? {}, "restoredTargetUri");
      const archivedArtifact = sourceArchiveUri ? await getArtifactByUri(sourceArchiveUri) : null;
      const originalArtifact = originalUri ? await getArtifactByUri(originalUri) : null;
      const restoredContent = restoredArtifact?.content.restoredContent;
      const archivedContent = archivedArtifact?.content.archivedContent;
      const contentHashMatches = restoredContent !== undefined && archivedContent !== undefined && stableHash(restoredContent) === stableHash(archivedContent);
      const missing = [
        restoredArtifact ? "" : "restored artifact row missing",
        sourceArchiveUri ? "" : "source archive URI missing",
        archivedArtifact ? "" : "source archive artifact missing",
        originalUri ? "" : "original URI missing",
        contentHashMatches ? "" : "restored content hash does not match archived content"
      ].filter(Boolean);
      checks.push({
        restoredArtifactId: row.id,
        restoredArtifactUri: row.uri,
        runId: row.runId,
        sourceArchiveUri: sourceArchiveUri ?? null,
        originalUri: originalUri ?? null,
        status: missing.length ? "warn" : "pass",
        contentHashMatches,
        originalStillPresent: originalUri ? Boolean(originalArtifact) : null,
        detail: missing.length ? missing.join("; ") : "Restore lineage and copied content hash verified."
      });
    }

    const warnings = checks.filter((check) => check.status === "warn").length;
    const notes = [
      restoredRows.length ? "" : "No restored_artifact snapshots were found. Run archive and restore approvals first, then rerun restore-drill.",
      warnings ? "One or more restored snapshots need review before treating restore evidence as verified." : "",
      restoredRows.length && !warnings ? "Restore drill passed for the inspected restored artifact snapshots." : ""
    ].filter(Boolean);
    return {
      kind: "agentflow_restore_drill_report",
      generatedAt: new Date().toISOString(),
      projectRootUri: projectRootUri ?? null,
      limit: input.limit,
      status: restoredRows.length > 0 && warnings === 0 ? "pass" : "attention",
      services,
      restoredSnapshotsInspected: restoredRows.length,
      passed: checks.filter((check) => check.status === "pass").length,
      warnings,
      checks,
      recommendedCommands: restoreDrillCommands(projectRootUri),
      notes
    };
  }

  async function loadRoadmapDashboardReport(): Promise<RoadmapDashboardReport> {
    const roadmapPath = path.join(ctx.rootDir, "docs", "roadmap.md");
    const markdown = await fs.readFile(roadmapPath, "utf8");
    const lines = markdown.split(/\r?\n/u);
    const milestones = parseRoadmapMilestones(lines);
    const milestoneByNumber = new Map(milestones.map((milestone) => [milestone.number, milestone]));
    const tasks = parseRoadmapTasks(lines, milestoneByNumber);
    const bugs = tasks.filter((task) => task.kind === "bug");
    const explicitMilestoneCount = tasks.filter((task) => task.milestoneSource === "explicit").length;
    const inferredMilestoneCount = tasks.filter((task) => task.milestoneSource === "inferred").length;
    const unlinkedCount = tasks.filter((task) => task.milestoneSource === "missing").length;
    return {
      kind: "agentflow_roadmap_dashboard",
      generatedAt: new Date().toISOString(),
      roadmapPath,
      milestones,
      tasks,
      bugs,
      summary: {
        milestoneCount: milestones.length,
        taskCount: tasks.length,
        bugCount: bugs.length,
        openCount: tasks.filter((task) => task.status === "open").length,
        doneCount: tasks.filter((task) => task.status === "done").length,
        nextCount: tasks.filter((task) => task.status === "next").length,
        explicitMilestoneCount,
        inferredMilestoneCount,
        unlinkedCount,
        priorityCounts: roadmapPriorityOrder().reduce((counts, priority) => {
          counts[priority] = tasks.filter((task) => task.priority === priority).length;
          return counts;
        }, {} as Record<RoadmapPriority, number>)
      }
    };
  }

  async function loadRuntimeMonitorReport(input: { checkMcp?: boolean } = {}): Promise<RuntimeMonitorReport> {
    const sharedHostTarget = resolveSharedHostStorageTarget();
    const sharedHostServices = sharedHostTarget.host
      ? await checkServices(defaultServiceEndpoints({
          AGENTFLOW_SHARED_STORAGE_HOST: sharedHostTarget.host,
          AGENTFLOW_POSTGRES_PORT: process.env.AGENTFLOW_POSTGRES_PORT,
          AGENTFLOW_REDIS_PORT: process.env.AGENTFLOW_REDIS_PORT,
          AGENTFLOW_MINIO_PORT: process.env.AGENTFLOW_MINIO_PORT
        } as NodeJS.ProcessEnv))
      : [];
    const localServices = await checkServices(defaultServiceEndpoints({
      DATABASE_URL: "postgres://agentflow:agentflow@127.0.0.1:15432/agentflow",
      REDIS_URL: "redis://127.0.0.1:16379",
      OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:19000"
    } as NodeJS.ProcessEnv));
    const [docker, ports, processes, mcpPipeline, staleRuns, localModelRuntime] = await Promise.all([
      loadDockerMonitorStatus(),
      loadRuntimePortStatuses(),
      loadRuntimeProcessGroups(),
      loadMcpPipelineStatus({ checkMcp: Boolean(input.checkMcp) }),
      listStaleTerminalWorkflowRuns(parseStaleRunReconcileLimit()),
      loadLocalModelRuntimeStatus()
    ]);
    const mcpCandidates = await loadRuntimeMcpCleanupCandidates(ctx);
    const mcpCleanupConfig = runtimeMcpCleanupConfig();
    const staleRunConfig = staleRunReconcileConfig();
    const recommendations = runtimeMonitorRecommendations({
      sharedHostReachable: sharedHostServices.length > 0 && sharedHostServices.every((service) => service.reachable),
      localServicesReachable: localServices.every((service) => service.reachable),
      docker,
      processes,
      mcpPipeline,
      staleRunCount: staleRuns.length,
      localModelRuntime
    });
    return {
      kind: "agentflow_runtime_monitor_report",
      generatedAt: new Date().toISOString(),
      storageHost: sharedHostTarget.host,
      sharedHost: {
        host: sharedHostTarget.host,
        source: sharedHostTarget.source,
        reachable: sharedHostServices.length > 0 && sharedHostServices.every((service) => service.reachable),
        services: sharedHostServices
      },
      localServices,
      localModelRuntime,
      docker,
      ports,
      processes,
      mcpPipeline,
      mcpCleanup: {
        candidateCount: mcpCandidates.length,
        candidates: mcpCandidates,
        autoCleanup: mcpCleanupConfig,
        previewCommand: `npm run runtime-monitor -- --cleanup-mcp --stale-minutes ${mcpCleanupConfig.staleMinutes}`,
        executeCommand: `npm run runtime-monitor -- --cleanup-mcp --confirm --stale-minutes ${mcpCleanupConfig.staleMinutes}`
      },
      staleRuns: {
        candidateCount: staleRuns.length,
        candidates: staleRuns.map((run) => ({
          runId: run.runId,
          workflowId: run.workflowId,
          runStatus: run.runStatus,
          task: run.task,
          projectRootUri: run.projectRootUri,
          totalTasks: run.totalTasks,
          completedTasks: run.completedTasks,
          cancelledTasks: run.cancelledTasks,
          recommendedStatus: run.recommendedStatus,
          startedAt: run.startedAt
        })),
        autoReconcile: staleRunConfig,
        previewCommand: `npm run runtime-monitor -- --reconcile-stale-runs --stale-run-limit ${staleRunConfig.limit}`,
        executeCommand: `npm run runtime-monitor -- --reconcile-stale-runs --confirm --stale-run-limit ${staleRunConfig.limit}`
      },
      recommendations
    };
  }

  async function loadRuntimePortStatuses(): Promise<RuntimeMonitorReport["ports"]> {
    const targets = [
      { label: "Postgres default", port: 5432 },
      { label: "Agent Workflow Postgres", port: 15432 },
      { label: "Redis default", port: 6379 },
      { label: "Agent Workflow Redis", port: 16379 },
      { label: "MinIO API default", port: 9000 },
      { label: "MinIO console", port: 9001 },
      { label: "Agent Workflow MinIO", port: 19000 },
      { label: "Agent Workflow dashboard", port: Number(process.env.AGENTFLOW_DASHBOARD_PORT ?? 17888) },
      { label: "Common app dev server", port: 3000 },
      { label: "Ollama/OpenAI-compatible local", port: 11434 }
    ];
    return Promise.all(targets.map(async (target) => {
      const result = await execFileText(ctx, "lsof", ["-nP", `-iTCP:${target.port}`, "-sTCP:LISTEN"], { allowFailure: true });
      const listener = parseLsofListener(result.stdout);
      return {
        ...target,
        status: listener ? "listening" : "closed",
        pid: listener?.pid ?? null,
        command: listener?.command ?? ""
      };
    }));
  }

  async function loadRuntimeProcessGroups(): Promise<RuntimeMonitorReport["processes"]> {
    const result = await execFileText(ctx, "ps", ["-axo", "pid=,ppid=,args="], { allowFailure: true });
    const rows = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      const pid = Number.parseInt(match?.[1] ?? "", 10);
      const parentPid = Number.parseInt(match?.[2] ?? "", 10);
      return match && Number.isFinite(pid) ? {
        pid,
        parentPid: Number.isFinite(parentPid) ? parentPid : null,
        args: match[3] ?? ""
      } : null;
    }).filter((row): row is { pid: number; parentPid: number | null; args: string } => Boolean(row));
    const matching = rows.filter((row) => /Agent Workflow|agentflow|apps\/mcp\/src\/index\.(ts|js)|apps\/cli\/src\/index\.ts|dev-agentflow\.mjs/i.test(row.args));
    const matchingByPid = new Map(matching.map((row) => [row.pid, row]));
    const groups: RuntimeMonitorReport["processes"] = [];
    for (const role of ["supervisor", "dashboard", "worker", "learning-daemon", "mcp"] as const) {
      const roleRows = matching.filter((row) => processMatchesRuntimeRole(row.args, role));
      const logicalGroups = new Map<string, typeof roleRows>();
      for (const row of roleRows) {
        const key = runtimeProcessGroupKey(row, role, matchingByPid);
        const group = logicalGroups.get(key) ?? [];
        group.push(row);
        logicalGroups.set(key, group);
      }
      const count = logicalGroups.size;
      groups.push({
        role,
        status: role === "mcp" ? count > 4 ? "attention" : "ok" : count > 0 ? "ok" : "attention",
        count,
        pids: [...logicalGroups.values()].map((group) => group[0]?.pid).filter((pid): pid is number => typeof pid === "number").slice(0, 20),
        detail: runtimeProcessDetail(role, count, roleRows.length)
      });
    }
    return groups;
  }

  async function loadServerDaemonFleetHealth(): Promise<ServerDaemonFleetHealthReport> {
    const [registry, supervisor, worker] = await Promise.all([
      loadServerProjectRegistryReport({ limit: 100, includeRoots: true }),
      loadDashboardSupervisorStatus(),
      loadDashboardWorkerStatus()
    ]);
    const resolvedProjects = await Promise.all(registry.projects.filter((project) => project.rootUri).map(async (project) => ({
      project,
      resolution: await resolveDashboardProjectPath(project.rootUri as string)
    })));
    const uniqueProjects = [...new Map(resolvedProjects.map((item) => [item.resolution.localPathExists ? item.resolution.localRootUri : item.resolution.storageRootUri, item])).values()];
    const projectResults = await Promise.all(uniqueProjects.map(async ({ project, resolution }) => {
      const localRoot = resolution.localRootUri;
      const [settings, heartbeat, triage] = await Promise.all([
        readLearningSettings(localRoot).catch(() => null),
        loadLearningDaemonStatus(ctx, localRoot),
        ctx.readJsonFile<LearningFailureTriageReport>(path.join(localRoot, ".agent-workflow", "learning", "failure-triage.json"))
      ]);
      const enabled = settings?.daemonEnabled ?? true;
      const paused = settings?.daemonPaused ?? false;
      const availability = classifyFleetProject({ name: project.name, rootUri: project.rootUri as string, localPathExists: resolution.localPathExists, enabled, paused });
      const available = fleetProjectAvailable({ availabilityTracked: availability.availabilityTracked, daemonStatus: heartbeat.status, heartbeatAgeMs: heartbeat.ageMs });
      const projectHealth = {
        projectId: project.projectId,
        name: project.name,
        scheduling: (!enabled ? "disabled" : paused ? "paused" : "enabled") as "enabled" | "paused" | "disabled",
        scope: availability.scope,
        availabilityTracked: availability.availabilityTracked,
        available,
        availabilityReason: availability.reason,
        daemonStatus: heartbeat.status,
        mode: settings?.daemonMode ?? heartbeat.mode ?? "apply-approved",
        runLimit: settings?.daemonRunLimit ?? heartbeat.limit ?? 50,
        heartbeatAgeMs: heartbeat.ageMs === null ? null : Math.max(0, Math.round(heartbeat.ageMs)),
        lastHeartbeatAt: heartbeat.lastHeartbeatAt,
        lastError: heartbeat.lastError ? truncateText(heartbeat.lastError, 240) : null
      };
      const attention = (triage?.groups ?? [])
        .filter((group) => group.action === "retry_failed" || group.action === "escalated")
        .map((group) => ({
          eventId: stableHash(`${project.projectId}:${group.signature}:${triage?.generatedAt ?? "unknown"}`),
          severity: (group.risk === "high" ? "critical" : "warning") as "warning" | "critical",
          projectId: project.projectId,
          projectName: project.name,
          category: group.category,
          title: group.action === "retry_failed" ? "Automatic workflow recovery did not succeed" : "Workflow failure needs review",
          summary: truncateText(`${group.diagnosis} ${group.detail}`, 360),
          action: group.action,
          generatedAt: triage?.generatedAt ?? heartbeat.lastHeartbeatAt ?? new Date().toISOString()
        }));
      return { projectHealth, attention };
    }));
    const projects = projectResults.map((result) => result.projectHealth);
    const attention = projectResults.flatMap((result) => result.attention).sort((left, right) => right.generatedAt.localeCompare(left.generatedAt)).slice(0, 50);
    const counts = {
      projects: projects.length,
      tracked: projects.filter((project) => project.availabilityTracked).length,
      excluded: projects.filter((project) => !project.availabilityTracked).length,
      remote: projects.filter((project) => project.scope === "remote").length,
      ephemeral: projects.filter((project) => project.scope === "ephemeral").length,
      running: projects.filter((project) => project.availabilityTracked && project.available).length,
      paused: projects.filter((project) => project.scheduling === "paused").length,
      disabled: projects.filter((project) => project.scheduling === "disabled").length,
      unavailable: projects.filter((project) => project.availabilityTracked && !project.available).length,
      workerLanes: worker.lanes.length,
      activeWorkerLanes: worker.lanes.filter((lane) => lane.status === "running").length,
      daemonLanes: daemonLanes.length,
      attention: attention.length
    };
    const firstRoot = registry.projects.find((project) => project.rootUri)?.rootUri;
    const activeTrust = firstRoot ? await readLearningSettings(await resolveLocalProjectRootUri(firstRoot)).catch(() => null) : null;
    const runtimeHealthy = worker.status === "running" && counts.unavailable === 0 && attention.length === 0;
    const supervisorStatus = supervisor.status === "missing" && worker.status === "running" ? "running" : supervisor.status;
    const supervisorHeartbeatAt = supervisor.lastHeartbeatAt ?? worker.lastHeartbeatAt;
    const supervisorHeartbeatAgeMs = supervisor.ageMs ?? worker.ageMs;
    return {
      kind: "agentflow_server_daemon_fleet_health",
      generatedAt: new Date().toISOString(),
      status: runtimeHealthy ? "healthy" : "attention",
      counts,
      supervisor: {
        status: supervisorStatus,
        lastHeartbeatAt: supervisorHeartbeatAt,
        heartbeatAgeMs: supervisorHeartbeatAgeMs === null ? null : Math.max(0, Math.round(supervisorHeartbeatAgeMs)),
        message: truncateText(supervisor.status === "missing" && worker.status === "running" ? "External service manager supervision is active." : supervisor.message, 160)
      },
      worker: {
        status: worker.status,
        lastHeartbeatAt: worker.lastHeartbeatAt,
        heartbeatAgeMs: worker.ageMs === null ? null : Math.max(0, Math.round(worker.ageMs)),
        lanes: worker.lanes.slice(0, 32).map((lane) => ({ id: lane.workerId ?? "worker", status: lane.status, lastHeartbeatAt: lane.lastHeartbeatAt, heartbeatAgeMs: lane.ageMs === null ? null : Math.max(0, Math.round(lane.ageMs)), claimed: lane.claimed, completed: lane.completed, failed: lane.failed }))
      },
      daemonLanes: daemonLanes.map((lane) => ({ id: lane.id, name: lane.name, purpose: lane.purpose, trust: activeTrust?.daemonTrustLevels[lane.id] ?? lane.defaultTrust, status: worker.status === "running" ? "running" : "attention" })),
      projects,
      attention
    };
  }

  async function loadStorageMigrationPlanListing(inputDir?: string): Promise<StorageMigrationPlanListing> {
    const directory = path.resolve(process.cwd(), inputDir?.trim() || ".agent-workflow/migrations");
    const warnings: string[] = [];
    const generatedAt = new Date().toISOString();
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          kind: "agentflow_storage_migration_plan_listing",
          generatedAt,
          directory,
          plans: [],
          warnings: [`No migration plan directory found at ${directory}. Run agentflow storage-migrate --write-plan to create one.`]
        };
      }
      throw error;
    }
    const plans: StorageMigrationPlanListing["plans"] = [];
    const jsonFiles = entries
      .filter((entry) => entry.startsWith("storage-migration-") && entry.endsWith(".json"))
      .sort()
      .reverse();
    for (const entry of jsonFiles.slice(0, 25)) {
      const jsonPath = path.join(directory, entry);
      const plan = await ctx.readJsonFile<StorageMigrationPlan>(jsonPath);
      if (!plan || plan.kind !== "agentflow_storage_migration_plan") {
        warnings.push(`Skipped unrecognized migration plan JSON: ${jsonPath}`);
        continue;
      }
      const basePath = jsonPath.slice(0, -".json".length);
      const markdownPath = await pathIsFile(`${basePath}.md`) ? `${basePath}.md` : null;
      const scriptPath = await pathIsFile(`${basePath}.sh`) ? `${basePath}.sh` : null;
      plans.push({
        jsonPath,
        markdownPath,
        scriptPath,
        generatedAt: plan.generatedAt,
        status: plan.status,
        mode: plan.mode,
        sourceDatabaseUrl: plan.source.databaseUrl,
        targetDatabaseUrl: plan.target.databaseUrl,
        targetObjectStorageEndpoint: plan.target.objectStorageEndpoint,
        targetObjectStorageBucket: plan.target.objectStorageBucket,
        warningCount: plan.warnings.length,
        stepCount: plan.steps.length
      });
    }
    if (!plans.length && !warnings.length) {
      warnings.push(`No storage migration plan JSON files found in ${directory}.`);
    }
    return {
      kind: "agentflow_storage_migration_plan_listing",
      generatedAt,
      directory,
      plans,
      warnings
    };
  }

  async function loadTrainingProposalEvaluationViews(inbox: TrainingProposalInbox, projectDir?: string): Promise<Map<string, TrainingProposalEvaluationView>> {
    const entries = await Promise.all(inbox.items.filter((item) => item.evaluation?.runId).map(async (item) => {
      const runId = item.evaluation?.runId as string;
      const [details, artifacts] = await Promise.all([
        getWorkflowRunDetails(runId),
        listArtifacts({ runId, kind: "stage_output" }).catch(() => [])
      ]);
      const finalArtifact = artifacts.at(-1) ?? null;
      const runSummary = stringValue(finalArtifact?.content?.summary)
        ?? stringValue(finalArtifact?.content?.output)
        ?? stringValue(finalArtifact?.content?.text)
        ?? null;
      const measuredPath = projectDir ? path.join(projectDir, ".agent-workflow", "evaluations", item.id.replace(/[^a-zA-Z0-9._-]+/gu, "-"), "measured-holdout.json") : null;
      const measured = measuredPath ? await fs.readFile(measuredPath, "utf8").then((value) => JSON.parse(value) as Awaited<ReturnType<typeof readTrainingHoldoutReport>>).catch(() => null) : null;
      const evidenceComplete = isCompleteTrainingHoldoutReport(measured);
      const summary = measured?.verdict ? `${measured.verdict}: measured ${measured.measuredObservations ?? 0}/${measured.plannedObservations ?? 0} blinded observations.${measured.failures?.length ? ` ${measured.failures.join(" ")}` : ""}` : runSummary;
      const recoveryRunId = details.run?.replacementRunId ?? null;
      return [item.id, {
        runId,
        status: details.run?.status ?? "missing",
        summary: summary?.slice(0, 600) ?? null,
        artifactUri: finalArtifact?.uri ?? null,
        evidenceHref: measured ? `/api/training-holdout-evidence?project=${encodeURIComponent(projectDir ?? "")}&id=${encodeURIComponent(item.id)}` : null,
        evidenceComplete,
        recoveryRunId,
        recoveryStatus: recoveryRunId ? details.run?.replacementRunStatus ?? "unavailable" : null
      }] as const;
    }));
    return new Map(entries);
  }

  async function loadUnifiedActivityReport(params: URLSearchParams): Promise<UnifiedActivityReport> {
    const limit = Math.max(1, Math.min(parsePositiveInteger(params.get("limit") ?? "200", 200), 1_000));
    const projectFilter = params.get("project")?.trim() || null;
    const categoryFilter = params.get("category")?.trim() || null;
    const severityFilter = params.get("severity")?.trim() || null;
    const statusFilter = params.get("status")?.trim() || null;
    const queryFilter = params.get("q")?.trim().toLowerCase() || null;
    const projects = await listProjectStorageSummaries(500);
    const selectedProjects = projectFilter ? projects.filter((project) => project.rootUri === projectFilter) : projects;
    const stored = await listActivityEvents({ limit: Math.min(1_000, limit * 4), projectRootUri: projectFilter ?? undefined });
    const events: UnifiedActivityEvent[] = stored.map((event) => ({
      ...event,
      title: redactApprovalCardText(event.title, 180),
      detail: redactApprovalCardText(event.detail, 500),
      href: event.runId ? `/run?id=${encodeURIComponent(event.runId)}` : null
    }));

    for (const project of selectedProjects) {
      const learningDir = path.join(project.rootUri, ".agent-workflow", "learning");
      const receipts = await ctx.readJsonFile<{ events?: Array<Record<string, unknown>> }>(path.join(learningDir, "action-receipts.json")).catch(() => null);
      for (const receipt of receipts?.events?.slice(-Math.min(limit, 250)) ?? []) {
        const occurredAt = stringValue(receipt.createdAt);
        if (!occurredAt) continue;
        const status = stringValue(receipt.status) ?? "recorded";
        events.push({
          id: `learning:${stringValue(receipt.id) ?? stableHash(receipt).slice(0, 16)}`,
          occurredAt,
          projectName: project.name,
          projectRootUri: project.rootUri,
          runId: null,
          category: "learning",
          eventType: stringValue(receipt.actionType) ?? "learning_action",
          severity: status === "failed" || status === "blocked" ? "warning" : "info",
          status,
          actor: stringValue(receipt.actor) ?? null,
          title: redactApprovalCardText(stringValue(receipt.title) ?? "Learning action", 180),
          detail: redactApprovalCardText(stringValue(receipt.note) ?? "Project-local learning receipt.", 500),
          source: "learning/action-receipts.json",
          href: `/learning?project=${encodeURIComponent(project.rootUri)}&view=diagnostics`
        });
      }
      const heartbeat = await ctx.readJsonFile<Record<string, unknown>>(path.join(learningDir, "daemon-status.json")).catch(() => null);
      const heartbeatAt = heartbeat ? stringValue(heartbeat.lastHeartbeatAt) : null;
      if (heartbeat && heartbeatAt) {
        const status = stringValue(heartbeat.status) ?? "unknown";
        events.push({
          id: `daemon:${project.id}:${heartbeatAt}`,
          occurredAt: heartbeatAt,
          projectName: project.name,
          projectRootUri: project.rootUri,
          runId: null,
          category: "daemon",
          eventType: "learning_daemon_heartbeat",
          severity: status === "failed" ? "error" : status === "stale" ? "warning" : "info",
          status,
          actor: stringValue(heartbeat.daemonId) ?? null,
          title: `Learning daemon ${status}`,
          detail: redactApprovalCardText(stringValue(heartbeat.lastError) || `Tick ${String(heartbeat.ticks ?? 0)}; roadmap snapshot ${String(heartbeat.roadmapSnapshotStatus ?? "unknown")}.`, 500),
          source: "learning/daemon-status.json",
          href: `/learning?project=${encodeURIComponent(project.rootUri)}&view=diagnostics`
        });
      }
      const publication = await ctx.readJsonFile<Record<string, unknown>>(path.join(learningDir, "roadmap-snapshot-publication.json")).catch(() => null);
      const publicationAt = publication ? stringValue(publication.recordedAt) : null;
      if (publication && publicationAt) {
        const status = stringValue(publication.status) ?? "unknown";
        events.push({
          id: `roadmap:${project.id}:${publicationAt}`,
          occurredAt: publicationAt,
          projectName: project.name,
          projectRootUri: project.rootUri,
          runId: null,
          category: "roadmap",
          eventType: "roadmap_snapshot_publication",
          severity: status === "unavailable" ? "warning" : "info",
          status,
          actor: stringValue(publication.actor) ?? null,
          title: `Roadmap snapshot ${status}`,
          detail: redactApprovalCardText(stringValue(publication.reason) ?? "Roadmap publication receipt.", 500),
          source: "learning/roadmap-snapshot-publication.json",
          href: "/roadmap"
        });
      }
    }

    const projectById = new Map(projects.map((project) => [project.id, project]));
    const requestAudit = await loadServerRequestAuditLog(ctx, Math.min(limit, 500));
    for (const event of requestAudit.events) {
      const project = event.projectId ? projectById.get(event.projectId) : undefined;
      if (projectFilter && project?.rootUri !== projectFilter) continue;
      events.push({
        id: `server:${event.requestId ?? stableHash(event).slice(0, 16)}`,
        occurredAt: event.generatedAt,
        projectName: project?.name ?? "Server",
        projectRootUri: project?.rootUri ?? null,
        runId: event.queuedRunId,
        category: "server",
        eventType: `server_${event.path.replace(/^\/api\//u, "").replaceAll("/", "_")}`,
        severity: event.status === "rejected" ? "error" : event.status === "blocked" || event.status === "attention" ? "warning" : "info",
        status: event.status,
        actor: event.actorRole,
        title: `${event.method} ${event.path}`,
        detail: `Auth ${event.auth.accepted ? "accepted" : event.auth.errorCode ?? "rejected"}; execute ${event.executeRequested ? "requested" : "not requested"}.`,
        source: "runtime/server/request-log.jsonl",
        href: event.queuedRunId ? `/run?id=${encodeURIComponent(event.queuedRunId)}` : "/server-readiness"
      });
    }

    const filtered = events.filter((event) =>
      (!categoryFilter || event.category === categoryFilter)
      && (!severityFilter || event.severity === severityFilter)
      && (!statusFilter || event.status === statusFilter)
      && (!queryFilter || `${event.title} ${event.detail} ${event.eventType} ${event.actor ?? ""} ${event.projectName}`.toLowerCase().includes(queryFilter))
    ).sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt)).slice(0, limit);
    const countBy = (key: "category" | "severity" | "status") => filtered.reduce<Record<string, number>>((counts, event) => ({ ...counts, [event[key]]: (counts[event[key]] ?? 0) + 1 }), {});
    return {
      kind: "agentflow_unified_activity",
      generatedAt: new Date().toISOString(),
      filters: { project: projectFilter, category: categoryFilter, severity: severityFilter, status: statusFilter, query: queryFilter, limit },
      counts: { returned: filtered.length, byCategory: countBy("category"), bySeverity: countBy("severity"), byStatus: countBy("status") },
      events: filtered,
      notes: [
        "This is a redacted read model over durable runs, stages, receipts, approvals, learning receipts, daemon state, roadmap publication, and server request audit events.",
        "Prompt bodies, model response bodies, credentials, private file contents, and raw network identities are excluded.",
        "Process stdout and stderr remain in component runtime logs and are not duplicated into this structured timeline."
      ]
    };
  }

  async function loadWorkerHeartbeatLane(heartbeatPath: string): Promise<DashboardWorkerLane | null> {
    try {
      const heartbeat = JSON.parse(await fs.readFile(heartbeatPath, "utf8")) as Partial<WorkerHeartbeat>;
      const trustDecision=evaluateWorkerHeartbeatTrust(heartbeat,await loadWorkerTrustStore());
      const lastHeartbeatAt = typeof heartbeat.lastHeartbeatAt === "string" ? heartbeat.lastHeartbeatAt : null;
      const ageMs = lastHeartbeatAt ? Date.now() - Date.parse(lastHeartbeatAt) : null;
      const intervalMs = typeof heartbeat.intervalMs === "number" ? heartbeat.intervalMs : null;
      const staleAfterMs = Math.max((intervalMs ?? 2000) * 3, 15_000);
      const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : null;
      const processAlive = pid ? isProcessAlive(pid) : false;
      const heartbeatStatus = heartbeat.status ?? "stopped";
      const compatible = heartbeat.protocolVersions?.runtime === ctx.protocolVersions.runtime && heartbeat.protocolVersions?.storage === ctx.protocolVersions.storage && heartbeat.protocolVersions?.bundle === ctx.protocolVersions.bundle;
      const running = compatible && trustDecision.trusted && ageMs !== null && ageMs <= staleAfterMs && heartbeatStatus !== "stopped" && heartbeatStatus !== "stopping";
      return {
        runtimeVersion: typeof heartbeat.runtimeVersion === "string" ? heartbeat.runtimeVersion : null,
        bundleVersion: typeof heartbeat.bundleVersion === "string" ? heartbeat.bundleVersion : null,
        protocolVersions: heartbeat.protocolVersions ?? null,
        heartbeatPath,
        configured: true,
        workerId: typeof heartbeat.workerId === "string" ? heartbeat.workerId : null,
        hostId:typeof heartbeat.hostId==="string"?heartbeat.hostId:null,
        runtimeBuildDigest:typeof heartbeat.runtimeBuildDigest==="string"?heartbeat.runtimeBuildDigest:trustDecision.runtimeBuildDigest,
        heartbeatTrustState:trustDecision.state,
        heartbeatTrustReason:trustDecision.reason,
        status: running ? "running" : heartbeatStatus === "stopped" ? "stopped" : "stale",
        pid,
        startedAt: typeof heartbeat.startedAt === "string" ? heartbeat.startedAt : null,
        lastHeartbeatAt,
        ageMs,
        limit: typeof heartbeat.limit === "number" ? heartbeat.limit : null,
        projectRootUri: typeof heartbeat.projectRootUri === "string" ? heartbeat.projectRootUri : null,
        projectId: typeof heartbeat.projectId === "string" ? heartbeat.projectId : null,
        projectIdentityId: typeof heartbeat.projectIdentityId === "string" ? heartbeat.projectIdentityId : null,
        projectIdentityGeneration: typeof heartbeat.projectIdentityGeneration === "number" ? heartbeat.projectIdentityGeneration : null,
        sourceRevision: typeof heartbeat.sourceRevision === "string" ? heartbeat.sourceRevision : null,
        concurrency: typeof heartbeat.concurrency === "number" ? heartbeat.concurrency : null,
        perProjectConcurrency: typeof heartbeat.perProjectConcurrency === "number" ? heartbeat.perProjectConcurrency : null,
        intervalMs,
        ticks: typeof heartbeat.ticks === "number" ? heartbeat.ticks : 0,
        claimed: typeof heartbeat.claimed === "number" ? heartbeat.claimed : 0,
        completed: typeof heartbeat.completed === "number" ? heartbeat.completed : 0,
        failed: typeof heartbeat.failed === "number" ? heartbeat.failed : 0,
        providerIds: Array.isArray(heartbeat.providerIds) ? heartbeat.providerIds.filter((item): item is string => typeof item === "string") : [],
        unavailableProviderIds: Array.isArray(heartbeat.unavailableProviderIds) ? heartbeat.unavailableProviderIds.filter((item): item is string => typeof item === "string") : [],
        executionCapabilities: Array.isArray(heartbeat.executionCapabilities) ? heartbeat.executionCapabilities.filter((item): item is string => typeof item === "string") : [],
        executionCapabilityProbes: Array.isArray(heartbeat.executionCapabilityProbes) ? heartbeat.executionCapabilityProbes.filter((item): item is ExecutionCapabilityProbe&{runtimeVersion:string} => Boolean(item)&&typeof item.id==="string"&&(item.status==="passed"||item.status==="failed")&&typeof item.digest==="string"&&typeof item.runtimeVersion==="string") : [],
        processAlive,
        command: typeof heartbeat.command === "string" ? heartbeat.command : "npm run worker:daemon"
      };
    } catch {
      return null;
    }
  }

  async function loadWorkerHeartbeatLanes(primaryHeartbeatPath: string): Promise<DashboardWorkerLane[]> {
    const candidates = new Set<string>([primaryHeartbeatPath]);
    try {
      const entries = await fs.readdir(ctx.defaultWorkerHeartbeatDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          candidates.add(path.join(ctx.defaultWorkerHeartbeatDir, entry.name));
        }
      }
    } catch {
      // Older installs only have the single heartbeat file.
    }

    const loaded = await Promise.all([...candidates].map((candidate) => loadWorkerHeartbeatLane(candidate)));
    const byWorkerProcess = new Map<string, DashboardWorkerLane>();
    for (const lane of loaded.filter((item): item is DashboardWorkerLane => Boolean(item))) {
      const key = `${lane.workerId ?? "unknown"}:${lane.pid ?? lane.heartbeatPath}`;
      const existing = byWorkerProcess.get(key);
      if (!existing || (lane.lastHeartbeatAt ?? "") > (existing.lastHeartbeatAt ?? "")) {
        byWorkerProcess.set(key, lane);
      }
    }
    return [...byWorkerProcess.values()].sort((left, right) => {
      if (left.status === "running" && right.status !== "running") return -1;
      if (right.status === "running" && left.status !== "running") return 1;
      return (right.lastHeartbeatAt ?? "").localeCompare(left.lastHeartbeatAt ?? "");
    });
  }

  async function loadActiveWorkerCapabilities(primaryHeartbeatPath: string): Promise<Map<string,Array<{workerId:string;projectRootUri:string|null;projectIdentityId:string|null;projectIdentityGeneration:number|null;sourceRevision:string|null}>>> {
    const candidates = new Set<string>([primaryHeartbeatPath]);
    try {
      for (const entry of await fs.readdir(ctx.defaultWorkerHeartbeatDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".json")) candidates.add(path.join(ctx.defaultWorkerHeartbeatDir, entry.name));
      }
    } catch { /* Older installs only have the primary heartbeat. */ }
    const capabilities = new Map<string,Array<{workerId:string;projectRootUri:string|null;projectIdentityId:string|null;projectIdentityGeneration:number|null;sourceRevision:string|null}>>();
    const trustStore=await loadWorkerTrustStore();
    for (const candidate of candidates) {
      try {
        const heartbeat = JSON.parse(await fs.readFile(candidate,"utf8")) as Partial<WorkerHeartbeat>;
        const ageMs = typeof heartbeat.lastHeartbeatAt === "string" ? Date.now()-Date.parse(heartbeat.lastHeartbeatAt) : Number.POSITIVE_INFINITY;
        const staleAfterMs = Math.max((typeof heartbeat.intervalMs === "number" ? heartbeat.intervalMs : 2000)*3,15_000);
        const compatible = heartbeat.protocolVersions?.runtime===ctx.protocolVersions.runtime && heartbeat.protocolVersions?.storage===ctx.protocolVersions.storage && heartbeat.protocolVersions?.bundle===ctx.protocolVersions.bundle;
        const trustDecision=evaluateWorkerHeartbeatTrust(heartbeat,trustStore);
        if (!compatible || !trustDecision.trusted || heartbeat.status!=="running" || ageMs>staleAfterMs) continue;
        const workerId = typeof heartbeat.workerId === "string" ? heartbeat.workerId : `pid:${heartbeat.pid}`;
        const projectRootUri=typeof heartbeat.projectRootUri==="string"?path.resolve(heartbeat.projectRootUri):null;
        const projectIdentityId=typeof heartbeat.projectIdentityId==="string"?heartbeat.projectIdentityId:null;
        const projectIdentityGeneration=typeof heartbeat.projectIdentityGeneration==="number"?heartbeat.projectIdentityGeneration:null;
        const sourceRevision=typeof heartbeat.sourceRevision==="string"?heartbeat.sourceRevision:null;
        for (const capability of Array.isArray(heartbeat.executionCapabilities) ? heartbeat.executionCapabilities : []) {
          if (typeof capability !== "string") continue;
          const workers=capabilities.get(capability)??[];
          if(!workers.some(worker=>worker.workerId===workerId))capabilities.set(capability,[...workers,{workerId,projectRootUri,projectIdentityId,projectIdentityGeneration,sourceRevision}]);
        }
      } catch { /* Missing or malformed heartbeats cannot attest capabilities. */ }
    }
    return capabilities;
  }

  async function loadLatestWorkerCapabilityProbes(primaryHeartbeatPath:string):Promise<Map<string,{status:"passed"|"failed";checkedAt:string;digest:string;reason:string|null;runtimeVersion:string;workerId:string;workerState:"active"|"stale"|"incompatible"|"stopped"|"untrusted"}>>{
    const candidates=new Set<string>([primaryHeartbeatPath]);
    try{for(const entry of await fs.readdir(ctx.defaultWorkerHeartbeatDir,{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith(".json"))candidates.add(path.join(ctx.defaultWorkerHeartbeatDir,entry.name));}catch{}
    const latest=new Map<string,{status:"passed"|"failed";checkedAt:string;digest:string;reason:string|null;runtimeVersion:string;workerId:string;workerState:"active"|"stale"|"incompatible"|"stopped"|"untrusted"}>();
    const trustStore=await loadWorkerTrustStore();
    for(const candidate of candidates)try{
      const heartbeat=JSON.parse(await fs.readFile(candidate,"utf8")) as Partial<WorkerHeartbeat>;
      const ageMs=typeof heartbeat.lastHeartbeatAt==="string"?Date.now()-Date.parse(heartbeat.lastHeartbeatAt):Number.POSITIVE_INFINITY;
      const staleAfterMs=Math.max((typeof heartbeat.intervalMs==="number"?heartbeat.intervalMs:2000)*3,15_000);
      const compatible=heartbeat.protocolVersions?.runtime===ctx.protocolVersions.runtime&&heartbeat.protocolVersions?.storage===ctx.protocolVersions.storage&&heartbeat.protocolVersions?.bundle===ctx.protocolVersions.bundle;
      const trustDecision=evaluateWorkerHeartbeatTrust(heartbeat,trustStore);
      const workerState:"active"|"stale"|"incompatible"|"stopped"|"untrusted"=!trustDecision.trusted?"untrusted":!compatible?"incompatible":heartbeat.status==="stopped"||heartbeat.status==="stopping"?"stopped":ageMs>staleAfterMs?"stale":"active";
      const workerId=typeof heartbeat.workerId==="string"?heartbeat.workerId:`pid:${heartbeat.pid??"unknown"}`;
      for(const probe of Array.isArray(heartbeat.executionCapabilityProbes)?heartbeat.executionCapabilityProbes:[]){
        if(!probe||typeof probe.id!=="string"||(probe.status!=="passed"&&probe.status!=="failed")||typeof probe.checkedAt!=="string"||typeof probe.digest!=="string"||typeof probe.runtimeVersion!=="string")continue;
        const observation={status:probe.status,checkedAt:probe.checkedAt,digest:probe.digest,reason:typeof probe.reason==="string"?probe.reason:null,runtimeVersion:probe.runtimeVersion,workerId,workerState};
        const prior=latest.get(probe.id);if(!prior||observation.checkedAt>prior.checkedAt)latest.set(probe.id,observation);
      }
    }catch{}
    return latest;
  }

  function localHoldoutComparisonForm(report: DashboardCandidateComparisonReport): string {
    const returnTo = `/candidate-comparisons?project=${encodeURIComponent(report.projectDir)}`;
    return `<form class="inline-form" method="post" action="/api/follow-up">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
      <input type="hidden" name="project" value="${escapeHtml(report.projectDir)}">
      <input type="hidden" name="action" value="local-holdout-comparison">
      <button type="submit">${iconLabel("brain", "Generate Local Holdout Plan")}</button>
    </form>`;
  }

  function localHoldoutPromotionForm(report: DashboardCandidateComparisonReport): string {
    const returnTo = `/candidate-comparisons?project=${encodeURIComponent(report.projectDir)}`;
    const eligible = report.promotionRecommendations.some((recommendation) => recommendation.decision === "propose_routing_note");
    return `<form class="inline-form" method="post" action="/api/follow-up">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
      <input type="hidden" name="project" value="${escapeHtml(report.projectDir)}">
      <input type="hidden" name="action" value="local-holdout-promote">
      <button type="submit"${eligible ? "" : " disabled"}>${iconLabel("route", "Approve Low-Risk Local Routing")}</button>
      <span class="muted">${eligible ? "Uses captured holdout result evidence and writes project-local routing preferences." : "Run/capture passing baseline and local candidate evidence before approving local routing."}</span>
    </form>`;
  }

  function localHoldoutResultsForm(report: DashboardCandidateComparisonReport): string {
    const returnTo = `/candidate-comparisons?project=${encodeURIComponent(report.projectDir)}`;
    return `<form class="inline-form" method="post" action="/api/follow-up">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
      <input type="hidden" name="project" value="${escapeHtml(report.projectDir)}">
      <input type="hidden" name="action" value="local-holdout-results">
      <button type="submit">${iconLabel("clipboard", "Capture Holdout Results")}</button>
    </form>`;
  }

  function mcpRecoveryPaths(): Pick<RuntimeMonitorReport["mcpPipeline"]["recovery"], "directory" | "markdownPath" | "jsonPath" | "scriptPath" | "writeCommand"> {
    const directory = path.join(ctx.rootDir, ".agent-workflow", "runtime", "mcp", "recovery");
    return {
      directory,
      markdownPath: path.join(directory, "mcp-recovery.md"),
      jsonPath: path.join(directory, "mcp-recovery.json"),
      scriptPath: path.join(directory, "mcp-client-recovery.sh"),
      writeCommand: "npm run runtime-monitor -- --check-mcp --write-mcp-recovery"
    };
  }

  function modelEnvForProvider(provider: string): string | undefined {
    if (provider === "openai") {
      return "OPENAI_MODEL";
    }
    if (provider === "codex-cli") {
      return "CODEX_CLI_MODEL";
    }
    if (provider === "anthropic") {
      return "ANTHROPIC_MODEL";
    }
    if (provider === "deepseek") {
      return "DEEPSEEK_MODEL";
    }
    if (provider === "gemini") {
      return "GEMINI_MODEL";
    }
    if (provider === "byo") {
      return "BYO_MODEL_NAME";
    }
    if (provider === "local") {
      return "LOCAL_MODEL_NAME";
    }
    if (provider === "openai-compatible") {
      return "OPENAI_COMPATIBLE_MODEL";
    }
    if (provider === "bedrock") {
      return "BEDROCK_MODEL";
    }
    if (provider === "muse") {
      return "MUSE_MODEL";
    }
    return undefined;
  }

  function normalizeDashboardProvider(value: string, options: { allowBlank: boolean }): string | undefined {
    const trimmed = value.trim();
    if (!trimmed && options.allowBlank) {
      return "";
    }
    const normalized = normalizeProviderRef(trimmed);
    const supported = new Set(["auto", "mock", "local", "byo", "openai", "codex-cli", "anthropic", "deepseek", "gemini", "groq", "openrouter", "nvidia", "muse", "openai-compatible", "bedrock", "kiro"]);
    return supported.has(normalized) ? normalized : undefined;
  }

  function primaryWorkflowStep(plan: OrchestrationPlan): OrchestrationStep | null {
    return plan.steps.find((step) => step.kind === "workflow" && step.target !== "review-pr")
      ?? plan.steps.find((step) => step.kind === "workflow")
      ?? null;
  }

  function printArtifact(
    artifact: {
      id: string;
      runId: string;
      taskId: string | null;
      kind: string;
      uri: string;
      content: Record<string, unknown>;
      createdAt: string;
    },
    asJson: boolean,
    contentOnly: boolean
  ): void {
    if (contentOnly) {
      console.log(JSON.stringify(artifact.content, null, 2));
      return;
    }

    if (asJson) {
      console.log(JSON.stringify(artifact, null, 2));
      return;
    }

    const summary = typeof artifact.content.summary === "string"
      ? artifact.content.summary
      : typeof artifact.content.text === "string"
        ? `${artifact.content.text.slice(0, 160)}${artifact.content.text.length > 160 ? "..." : ""}`
        : "";

    console.log(`${artifact.kind} ${artifact.uri}`);
    if (artifact.taskId) {
      console.log(`  task: ${artifact.taskId}`);
    }
    if (summary) {
      console.log(`  ${summary}`);
    }
  }

  async function processDashboardApprovalAction(input: {
    approvalId: string;
    decision: string;
    actorRole: string;
    note: string;
  }): Promise<DashboardFollowUpResult> {
    const approvalId = input.approvalId.trim();
    const decision = input.decision.trim();
    if (!approvalId) {
      return { ok: false, error: "Missing approval id." };
    }
    if (decision === "approve_execute") {
      return approveAndExecuteAction(ctx, {
        approvalId,
        actor: "dashboard",
        approveActorRole: normalizeActorRole(input.actorRole, "approver"),
        executeActorRole: "operator",
        note: input.note.trim()
      });
    }
    if (decision === "execute") {
      const result = await executeApprovedAction(ctx, { approvalId, actor: "dashboard", actorRole: normalizeActorRole(input.actorRole, "operator") });
      if (!result.ok || !result.runId) return result;
      const resumed = await resumeBlockedRunAfterResolvedApprovals(result.runId);
      return resumed.resumedTasks > 0 ? {
        ...result,
        runId: resumed.replacementRunId ?? result.runId,
        redirectToRun: Boolean(resumed.replacementRunId),
        output: `${result.output}\nResumed ${resumed.resumedTasks} blocked or unfinished stage${resumed.resumedTasks === 1 ? "" : "s"} in replacement run ${resumed.replacementRunId ?? result.runId}.`
      } : resumed.holdReason ? { ...result, output: `${result.output}\n${resumed.holdReason}` } : result;
    }
    if (decision === "dismiss") {
      return dismissApprovedAction(ctx, {
        approvalId,
        actor: "dashboard",
        actorRole: normalizeActorRole(input.actorRole, "operator"),
        note: input.note.trim()
      });
    }
    if (decision !== "approved" && decision !== "rejected") {
      return { ok: false, error: "Decision must be approved, rejected, execute, or dismiss." };
    }
    const approvalForGate = await getActionApproval(approvalId);
    if (!approvalForGate) {
      return { ok: false, error: "Approval was not found or is no longer pending." };
    }
    const project = await loadApprovalProjectConfig(ctx, approvalForGate);
    const actorRole = normalizeActorRole(input.actorRole, "approver");
    const gate = evaluateRoleGate(project, actorRole, decision === "approved" ? "can_approve_actions" : "can_reject_actions");
    if (!gate.allowed) {
      return { ok: false, error: gate.message };
    }
    const approval = await decideActionApproval({
      approvalId,
      decision,
      actor: "dashboard",
      actorRole,
      note: input.note.trim() || undefined
    });
    if (!approval) {
      return { ok: false, error: "Approval was not found or is no longer pending." };
    }
    const resumed = decision === "approved"
      ? await resumeBlockedRunAfterResolvedApprovals(approval.runId)
      : { resumedTasks: 0 };
    return {
      ok: true,
      title: `Action ${decision}`,
      runId: resumed.replacementRunId ?? approval.runId,
      redirectToRun: Boolean(resumed.replacementRunId),
      output: [
        `Approval: ${approval.id}`,
        `Action: ${approval.actionType}`,
        `Target: ${approval.target}`,
        `Run: ${approval.runId}`,
        `Project: ${approval.projectRootUri}`,
        `Actor role: ${approval.decidedRole ?? normalizeActorRole(input.actorRole, "approver")}`,
        `Role preview: ${rolePreviewForApproval(approval)}`,
        "Decision receipt was recorded.",
        resumed.holdReason ?? "",
        resumed.resumedTasks > 0 ? `Resumed ${resumed.resumedTasks} blocked or unfinished stage${resumed.resumedTasks === 1 ? "" : "s"} in replacement run ${resumed.replacementRunId ?? approval.runId}.` : "",
        "Open: /approvals"
      ].filter(Boolean).join("\n")
    };
  }

  async function processDashboardApprovalAutopilotAction(input: {
    project: string;
    runId: string;
    limit: string;
    maxRisk: string;
    execute: boolean;
  }): Promise<DashboardFollowUpResult> {
    const result = await runApprovalAutopilot(ctx, {
      projectRootUri: input.project.trim() ? path.resolve(process.cwd(), input.project.trim()) : undefined,
      runId: input.runId.trim() || undefined,
      limit: parsePositiveInteger(input.limit || "100", 100),
      maxRisk: parseApprovalAutopilotRisk(input.maxRisk || process.env.AGENTFLOW_APPROVAL_AUTOPILOT_MAX_RISK),
      execute: input.execute,
      actor: "approval-autopilot",
      actorRole: "approver"
    });
    return {
      ok: true,
      title: input.execute ? "Approval autopilot executed" : "Approval autopilot preview",
      output: [
        formatApprovalAutopilotResult(result),
        "",
        input.execute
          ? "Autopilot approved and executed only eligible items at or below the configured risk threshold."
          : "Preview only. Re-run with Execute enabled to approve and execute eligible items.",
        "Open: /approvals"
      ].join("\n")
    };
  }

  async function processDashboardApprovalTriageAction(form: URLSearchParams): Promise<DashboardFollowUpResult> {
    const action = (form.get("action") ?? "").trim();
    const confirmed = form.get("confirmed") === "on";
    const project = (form.get("project") ?? "").trim();
    const limit = parsePositiveInteger(form.get("limit") ?? "100", 100);
    if (!confirmed) {
      return { ok: false, error: "Confirm the selected bulk triage action before changing approval records." };
    }
    const report = await buildApprovalBacklogReport(ctx, {
      status: undefined,
      projectRootUri: project ? path.resolve(process.cwd(), project) : undefined,
      limit,
      staleMinutes: parsePositiveInteger(form.get("staleMinutes") ?? "60", 60)
    });
    const retryMissingTool = action === "retry-missing-tools";
    const dismissCommandFailures = action === "dismiss-command-failures";
    const dismissReviewedFailures = action === "dismiss-reviewed-failures";
    if (!retryMissingTool && !dismissCommandFailures && !dismissReviewedFailures) {
      return { ok: false, error: `Unsupported approval triage action: ${action || "none"}` };
    }
    const categories: ApprovalBacklogCategory[] = retryMissingTool
      ? ["missing_tool", "resolved_missing_tool"]
      : dismissReviewedFailures
        ? ["resolved_missing_tool", "command_failed"]
        : ["command_failed"];
    const candidates = report.items
      .filter((item) => item.status === "failed" && categories.includes(item.category) && isExecutableApprovalAction(item.actionType))
      .slice(0, limit);
    if (!candidates.length) {
      return { ok: true, title: "No matching approval backlog items", output: `No ${retryMissingTool ? "missing-tool" : dismissReviewedFailures ? "reviewable failed" : "command failure"} approval items matched this bulk action.` };
    }
    const changed: string[] = [];
    const failed: string[] = [];
    for (const item of candidates) {
      const result = retryMissingTool
        ? await executeApprovedAction(ctx, {
          approvalId: item.approvalId,
          actor: "dashboard-triage",
          actorRole: "operator"
        })
        : await dismissApprovedAction(ctx, {
          approvalId: item.approvalId,
          actor: "dashboard-triage",
          actorRole: "operator",
          note: "Reviewed and dismissed from approval backlog triage."
        });
      if (result.ok) {
        changed.push(`${item.approvalId}: ${approvalOneLineSummaryFromBacklog(item)}`);
      } else {
        failed.push(`${item.approvalId}: ${result.error}`);
      }
    }
    const title = retryMissingTool ? "Missing-tool approvals retried" : dismissReviewedFailures ? "Reviewed failures dismissed" : "Command failures dismissed";
    const output = [
      `Action: ${retryMissingTool ? "retry missing-tool failures" : dismissReviewedFailures ? "dismiss reviewed/not-actionable failures" : "dismiss reviewed command failures"}`,
      `Matched: ${candidates.length}`,
      `Changed: ${changed.length}`,
      `Failed: ${failed.length}`,
      "",
      changed.length ? "Changed:" : "Changed: none",
      ...changed.map((item) => `- ${item}`),
      ...(failed.length ? ["", "Failures:", ...failed.map((item) => `- ${item}`)] : []),
      "",
      "Receipts were recorded by the underlying approval execution or dismissal path.",
      "Open: /approvals"
    ].join("\n");
    return failed.length
      ? { ok: false, error: output }
      : { ok: true, title, output };
  }

  async function processDashboardArtifactLifecycleAction(input: {
    action: string;
    project: string;
    kind: string;
    limit: string;
    minAgeDays: string;
    minBytes: string;
    includeAudit: boolean;
    actorRole: string;
  }): Promise<DashboardFollowUpResult> {
    if (input.action !== "queue-prune-approvals" && input.action !== "queue-archive-approvals" && input.action !== "queue-restore-approvals") {
      return { ok: false, error: `Unsupported artifact lifecycle action: ${input.action || "none"}` };
    }
    const action: ArtifactLifecycleAction = input.action === "queue-archive-approvals" ? "archive" : input.action === "queue-restore-approvals" ? "restore" : "prune";
    const project = input.project.trim();
    if (!project) {
      return { ok: false, error: "Select a project before queueing lifecycle approvals." };
    }
    const report = await loadArtifactLifecycleReport({
      projectRootUri: project,
      kind: input.kind.trim() || undefined,
      limit: parsePositiveInteger(input.limit || "500", 500),
      prunePlan: action === "prune",
      archivePlan: action === "archive",
      restorePlan: action === "restore",
      minAgeDays: input.minAgeDays.trim() ? parseNonNegativeInteger(input.minAgeDays, 30) : undefined,
      minBytes: input.minBytes.trim() ? parseNonNegativeInteger(input.minBytes, 20_000) : undefined,
      includeAudit: input.includeAudit ? true : undefined
    });
    const queue = await queueArtifactLifecycleApprovals({
      report,
      action,
      actor: "dashboard",
      actorRole: normalizeActorRole(input.actorRole, "operator")
    });
    const plan = artifactLifecyclePlanForAction(report, action);
    return {
      ok: true,
      title: `Lifecycle ${action} approvals queued`,
      output: [
        `Project: ${report.projectRootUri}`,
        `Policy source: ${report.retentionPolicy.source}`,
        `Criteria source: ${plan?.criteria.policySource ?? "none"}`,
        `Candidates: ${plan?.totalCandidates ?? 0}`,
        `Approval requests: ${queue.totalRequested}`,
        ...queue.skipped.map((item) => `Skipped: ${item}`),
        ...queue.approvals.slice(0, 10).map((approval) => `Approval ${approval.approvalId}: ${approval.status} ${approval.target}`),
        "No artifacts were deleted or modified. Archive and restore execution create copied snapshots only after approval and matching project capability flags.",
        "Open: /approvals"
      ].join("\n")
    };
  }

  async function processDashboardBulkApprovalAction(input: {
    approvalIds: string[];
    actorRole: string;
    note: string;
    executeAfterApproval: boolean;
  }): Promise<DashboardFollowUpResult> {
    const approvalIds = [...new Set(input.approvalIds.map((id) => id.trim()).filter(Boolean))];
    if (!approvalIds.length) {
      return { ok: false, error: "Select at least one pending approval to approve." };
    }
    const actorRole = normalizeActorRole(input.actorRole, "approver");
    const approved: DashboardActionApproval[] = [];
    const executed: string[] = [];
    const skipped: string[] = [];
    for (const approvalId of approvalIds) {
      const approvalForGate = await getActionApproval(approvalId);
      if (!approvalForGate) {
        skipped.push(`${approvalId}: not found or no longer pending`);
        continue;
      }
      if (input.executeAfterApproval && isExecutableApprovalAction(approvalForGate.actionType)) {
        const result = await approveAndExecuteAction(ctx, {
          approvalId,
          actor: "dashboard",
          approveActorRole: actorRole,
          executeActorRole: "operator",
          note: input.note.trim() || "Bulk approved and executed from dashboard."
        });
        if (!result.ok) {
          skipped.push(`${approvalId}: ${result.error}`);
          continue;
        }
        approved.push(approvalForGate);
        executed.push(`${approvalId}: ${approvalOneLineSummary(approvalForGate)}`);
        continue;
      }
      const project = await loadApprovalProjectConfig(ctx, approvalForGate);
      const gate = evaluateRoleGate(project, actorRole, "can_approve_actions");
      if (!gate.allowed) {
        skipped.push(`${approvalId}: ${gate.message}`);
        continue;
      }
      const approval = await decideActionApproval({
        approvalId,
        decision: "approved",
        actor: "dashboard",
        actorRole,
        note: input.note.trim() || "Bulk approved from dashboard."
      });
      if (!approval) {
        skipped.push(`${approvalId}: not found or no longer pending`);
        continue;
      }
      approved.push(approval);
    }
    if (!approved.length) {
      return {
        ok: false,
        error: [
          "No approvals changed.",
          ...skipped.map((item) => `Skipped ${item}`)
        ].join("\n")
      };
    }
    return {
      ok: true,
      title: "Bulk approvals recorded",
      output: [
        `Approved: ${approved.length}`,
        `Executed: ${executed.length}`,
        `Skipped: ${skipped.length}`,
        ...approved.map((approval) => `Approved ${approval.id}: ${approvalOneLineSummary(approval)}`),
        ...executed.map((item) => `Executed ${item}`),
        ...skipped.map((item) => `Skipped ${item}`),
        input.executeAfterApproval
          ? "Decision and execution receipts were recorded where execution was available."
          : "Decision receipts were recorded for approved items.",
        "Open: /approvals"
      ].join("\n")
    };
  }

  async function processDashboardBulkFeedbackAction(form: URLSearchParams): Promise<DashboardFollowUpResult> {
    const runIds = orderedUnique(form.getAll("runId").map((runId) => runId.trim()).filter(Boolean));
    if (!runIds.length) {
      return { ok: false, error: "No feedback rows were selected." };
    }

    const recorded: string[] = [];
    const failed: string[] = [];
    for (const runId of runIds) {
      const result = await recordRunFeedback({
        runId,
        rating: form.get(`rating:${runId}`) ?? "",
        note: form.get(`note:${runId}`) ?? "",
        source: "dashboard-bulk"
      });
      if (result.ok) {
        recorded.push(`${runId} ${result.rating}`);
      } else {
        failed.push(`${runId}: ${result.error}`);
      }
    }

    const query = new URLSearchParams({
      project: form.get("project") ?? "",
      limit: form.get("limit") ?? "50"
    });
    const output = [
      `Recorded ${recorded.length} feedback item(s).`,
      failed.length ? `Failed ${failed.length} item(s).` : "",
      "",
      "Recorded:",
      ...(recorded.length ? recorded.map((item) => `- ${item}`) : ["- none"]),
      ...(failed.length ? ["", "Failures:", ...failed.map((item) => `- ${item}`)] : []),
      "",
      `Open: /feedback-inbox?${query.toString()}`
    ].filter(Boolean).join("\n");

    return failed.length
      ? { ok: false, error: output }
      : { ok: true, title: "Bulk Feedback Recorded", output };
  }

  async function processDashboardBundleLifecyclePlan(input: {
    project: string;
    bundleId: string;
    mode: string;
    targetVersion: string;
    registry: string;
    write: boolean;
  }): Promise<DashboardFollowUpResult> {
    const projectDir = input.project.trim();
    if (!projectDir) {
      return { ok: false, error: "Missing project path." };
    }
    const mode = input.mode.trim() || "upgrade";
    if (mode !== "upgrade" && mode !== "rollback") {
      return { ok: false, error: "Mode must be upgrade or rollback." };
    }
    const registryPath = path.resolve(process.cwd(), input.registry.trim() || ctx.defaultBundleRegistryPath);
    const registry = await loadBundleRegistry(registryPath);
    const plan = buildBundleLifecyclePlan({
      registry,
      projectDir: path.resolve(process.cwd(), projectDir),
      bundleId: input.bundleId.trim() || "agent-workflow-core",
      mode,
      targetVersion: input.targetVersion.trim() || undefined,
      write: input.write
    });
    let writtenPath: string | null = null;
    if (input.write && plan.status === "ready") {
      writtenPath = await writeBundleLifecyclePlan(plan);
    }
    const writeCommand = [
      "npm run agentflow -- bundle-lifecycle-plan",
      "--project", shellQuote(plan.projectDir),
      "--bundle-id", shellQuote(input.bundleId.trim() || "agent-workflow-core"),
      "--mode", shellQuote(mode),
      ...(input.targetVersion.trim() ? ["--target-version", shellQuote(input.targetVersion.trim())] : []),
      "--write"
    ].join(" ");
    const output = [
      formatBundleLifecyclePlan(plan),
      writtenPath ? `\nWritten: ${writtenPath}` : `\nDry run only. To write the review file:\n${writeCommand}`,
      "Open: /bundles"
    ].join("\n");
    return plan.status === "ready"
      ? { ok: true, title: input.write ? "Bundle Lifecycle Plan Written" : "Bundle Lifecycle Plan Dry Run", output }
      : { ok: false, error: output };
  }

  async function processDashboardLaunchAgentAction(action: string): Promise<DashboardFollowUpResult> {
    if (process.platform !== "darwin") {
      return { ok: false, error: `macOS LaunchAgent controls are unavailable on ${process.platform}. Use npm run dev:agentflow directly.` };
    }
    const normalized = normalizeLookup(action);
    const scriptName = normalized === "install" || normalized === "refresh"
      ? "install-launchagent.mjs"
      : normalized === "uninstall" ? "uninstall-launchagent.mjs" : "";
    if (!scriptName) {
      return { ok: false, error: "LaunchAgent action must be install, refresh, or uninstall." };
    }
    const scriptPath = path.join(ctx.rootDir, "scripts", scriptName);
    if (!await pathExists(scriptPath)) {
      return { ok: false, error: `Missing LaunchAgent script: ${scriptPath}` };
    }
    const actionLogPath = await scheduleDashboardLaunchAgentScript(scriptName);
    const verb = normalized === "uninstall" ? "uninstall" : "install/refresh";
    return {
      ok: true,
      title: `LaunchAgent ${verb} scheduled`,
      output: [
        `Scheduled: ${process.execPath} ${scriptPath}`,
        `Action log: ${actionLogPath}`,
        `Plist: ${path.join(os.homedir(), "Library", "LaunchAgents", `${ctx.defaultLaunchAgentLabel}.plist`)}`,
        "Refresh Settings in a few seconds to see the new launchd status."
      ].join("\n")
    };
  }

  async function processDashboardLearningDaemonTarget(input: { project: string; mode: string; scope: string }): Promise<DashboardFollowUpResult> {
    const projectDir = path.resolve(process.cwd(), input.project.trim());
    if (!input.project.trim()) {
      return { ok: false, error: "Missing project path." };
    }
    if (!await pathExists(projectDir)) {
      return { ok: false, error: `Project path does not exist: ${projectDir}` };
    }
    const mode = input.mode === "observe" || input.mode === "propose" || input.mode === "apply-approved" ? input.mode : "apply-approved";
    const scope = input.scope === "project" ? "project" : "all-projects";
    await updateEnvValue(ctx.configuredEnvPath, "AGENTFLOW_LEARNING_PROJECT", projectDir);
    await updateEnvValue(ctx.configuredEnvPath, "AGENTFLOW_LEARNING_MODE", mode);
    await updateEnvValue(ctx.configuredEnvPath, "AGENTFLOW_LEARNING_SCOPE", scope);
    await updateEnvValue(ctx.configuredEnvPath, "AGENTFLOW_LEARNING_DAEMON", "1");
    process.env.AGENTFLOW_LEARNING_PROJECT = projectDir;
    process.env.AGENTFLOW_LEARNING_MODE = mode;
    process.env.AGENTFLOW_LEARNING_SCOPE = scope;
    process.env.AGENTFLOW_LEARNING_DAEMON = "1";
    const launchAgent = await loadDashboardLaunchAgentStatus();
    const refreshLine = launchAgent.supported && launchAgent.installed
      ? "A LaunchAgent refresh was scheduled so the durable supervisor picks up the new learning target."
      : "LaunchAgent is not installed. Run npm run dev:agentflow or npm run dev:agentflow:launchd:install to start the daemon.";
    if (launchAgent.supported && launchAgent.installed) {
      await scheduleDashboardLaunchAgentScript("install-launchagent.mjs");
    }
    return {
      ok: true,
      title: "Learning daemon target updated",
      output: [
        `AGENTFLOW_LEARNING_PROJECT=${projectDir}`,
        `AGENTFLOW_LEARNING_MODE=${mode}`,
        `AGENTFLOW_LEARNING_SCOPE=${scope}`,
        "AGENTFLOW_LEARNING_DAEMON=1",
        refreshLine,
        `Open: /learning?project=${encodeURIComponent(projectDir)}`
      ].join("\n")
    };
  }

  async function processDashboardObjectMirrorApproval(form: URLSearchParams): Promise<DashboardFollowUpResult> {
    const project = (form.get("project") ?? ctx.rootDir).trim() || ctx.rootDir;
    const sourceEndpoint = (form.get("sourceEndpoint") ?? "http://127.0.0.1:19000").trim();
    const sourceBucket = (form.get("sourceBucket") ?? process.env.OBJECT_STORAGE_BUCKET ?? "agentflow-artifacts").trim();
    const targetEndpoint = (form.get("targetEndpoint") ?? process.env.OBJECT_STORAGE_ENDPOINT ?? "").trim();
    const targetBucket = (form.get("targetBucket") ?? process.env.OBJECT_STORAGE_BUCKET ?? "agentflow-artifacts").trim();
    const report = await buildObjectArtifactProofReport(ctx, {
      projectRootUri: project,
      limit: parsePositiveInteger(form.get("objectLimit") ?? "500", 500),
      enumerateBuckets: true,
      verify: false,
      sourceEndpoint,
      sourceBucket,
      targetEndpoint,
      targetBucket
    });
    return queueObjectMirrorApproval(ctx, {
      projectPath: project,
      report,
      sourceEndpoint,
      sourceBucket,
      targetEndpoint,
      targetBucket,
      actor: "dashboard",
      actorRole: normalizeActorRole(form.get("actorRole") ?? "", "operator")
    });
  }

  async function processDashboardOfflineFallbackAction(form: URLSearchParams): Promise<DashboardFollowUpResult> {
    const action = form.get("action") ?? "";
    if (action === "mark-synced") {
      const itemId = form.get("itemId")?.trim() || "";
      if (!itemId) return { ok: false, error: "Missing offline fallback queue item id." };
      const queue = await markOfflineFallbackQueueItemSynced(ctx, itemId, "dashboard");
      return {
        ok: true,
        title: "Offline fallback item marked synced",
        output: formatOfflineFallbackQueue(queue)
      };
    }
    const parsedAction = parseOfflineFallbackQueueAction(action);
    const projectInput = form.get("project")?.trim() || "";
    const result = await recordOfflineFallbackQueueItem(ctx, {
      action: parsedAction,
      projectRootUri: projectInput ? path.resolve(process.cwd(), projectInput) : undefined,
      runId: form.get("runId")?.trim() || undefined,
      note: form.get("note")?.trim() || undefined,
      actor: "dashboard"
    });
    return {
      ok: true,
      title: "Offline fallback queue updated",
      output: [
        `Queued: ${result.item.action}`,
        `Item: ${result.item.id}`,
        "",
        formatOfflineFallbackQueue(result.queue)
      ].join("\n")
    };
  }

  async function processDashboardOfflineSyncAction(form: URLSearchParams): Promise<DashboardFollowUpResult> {
    const execute = form.get("execute") === "on";
    const result = await runOfflineFallbackSync(ctx, {
      outDir: form.get("out")?.trim() || ".agent-workflow/migrations",
      execute,
      actor: "dashboard"
    });
    return result.status === "blocked"
      ? { ok: false, error: formatOfflineFallbackSyncResult(result) }
      : {
        ok: true,
        title: execute ? "Offline sync executed" : "Offline sync dry run completed",
        output: formatOfflineFallbackSyncResult(result)
      };
  }

  async function processDashboardQueueAction(input: {
    action: string;
    runId: string;
    workerLimit: string;
    workerConcurrency: string;
    project: string;
    reason: string;
    confirmed: boolean;
    actor?: string;
    removals?:string;
    expectedTaskDigest?:string;
    expectedRunStatus?:'failed';
  }): Promise<DashboardFollowUpResult> {
    const action = input.action.trim();
    const runId = input.runId.trim();

    if(action==='remove-failed-visible'){
      if(!input.confirmed)return {ok:false,error:'Confirm removal of the exact displayed failed cards first.'};
      let selected;try{selected=parseFailedCardRemovals(input.removals??'');}catch(error){return {ok:false,error:error instanceof Error?error.message:'Invalid removal selection.'};}
      const result=await removeReviewedFailedCards(selected,async item=>{
        const outcome=await processDashboardQueueAction({...input,action:'withdraw-unaccepted',runId:item.runId,
          expectedTaskDigest:item.taskDigest,expectedRunStatus:'failed',actor:'Human via dashboard',
          reason:input.reason.trim()||'Remove this reviewed failed card from the queue without accepting it.'});
        return outcome.ok?{ok:true}:{ok:false,error:outcome.error};
      });
      if(!result.removed.length&&result.refused.length)return {ok:false,error:`No failed cards removed; ${result.refused.length} need review. ${result.refused[0].reason}`};
      return {ok:true,title:`Removed ${result.removed.length} failed attempt${result.removed.length===1?'':'s'}; ${result.refused.length} need review`,
        output:[`Removed: ${result.removed.length}`,`Not removed: ${result.refused.length}`,
          ...result.refused.map(item=>`${item.runId}: ${item.reason}`),
          'Original failed statuses, contracts, approvals and evidence were preserved. No acceptance or execution authority was granted.','Open: /queue'].join('\n')};
    }

    if (action === "process") {
      const workerLimit = parsePositiveInteger(input.workerLimit || "6", 6);
      const workerConcurrency = parseBoundedPositiveInteger(input.workerConcurrency || "1", 1, 16);
      const projectRootUri = input.project.trim() ? path.resolve(process.cwd(), input.project.trim()) : undefined;
      const workerResult = await runWorkerOnce(workerLimit, { workerId: normalizeWorkerId("dashboard"), projectRootUri, concurrency: workerConcurrency });
      return {
        ok: true,
        title: "Worker batch processed",
        output: [
          `Worker claimed ${workerResult.claimed}, completed ${workerResult.completed}, failed ${workerResult.failed}.`,
          `Project scope: ${projectRootUri ?? "all projects"}`,
          `Concurrency: ${workerConcurrency}`,
          "Open: /queue"
        ].join("\n")
      };
    }

    if (action === "dismiss-all-failed") {
      if (!input.confirmed) {
        return { ok: false, error: "Confirm bulk dismissal before clearing failed queue items." };
      }
      const project = input.project.trim();
      const reason = input.reason.trim() || "Bulk-dismissed from the dashboard queue.";
      const count = await dismissAllFailedWorkflowRuns({
        projectRootUri: project || undefined,
        actor: "dashboard",
        reason
      });
      return {
        ok: true,
        title: "Failed runs dismissed",
        output: [
          `Dismissed failed runs: ${count}`,
          project ? `Project filter: ${project}` : "Project filter: all projects",
          `Reason: ${reason}`,
          "History, artifacts, and receipts were preserved.",
          "Open: /queue"
        ].join("\n")
      };
    }

    if (action === "recover-expired-leases") {
      const result = await requeueExpiredWorkflowTaskLeases({
        runId: runId || undefined,
        actor: "dashboard",
        reason: input.reason.trim() || "Expired worker lease recovery requested from dashboard."
      });
      return {
        ok: true,
        title: "Expired worker leases recovered",
        runId: runId || undefined,
        output: [
          runId ? `Run: ${runId}` : "Run filter: all active runs",
          `Requeued expired tasks: ${result.requeuedTasks}`,
          `Affected runs: ${result.affectedRuns}`,
          "History, artifacts, and receipts were preserved.",
          runId ? `Open: /run?id=${encodeURIComponent(runId)}` : "Open: /queue"
        ].join("\n")
      };
    }

    if (!runId) {
      return { ok: false, error: "Missing run id." };
    }

    if (action === "cancel") {
      const cancelled = await cancelWorkflowRun(runId);
      return cancelled
        ? { ok: true, title: "Run cancelled", runId, output: `Run: ${runId}\nOpen: /queue` }
        : { ok: false, error: `Run is not queued/running or does not exist: ${runId}` };
    }

    if (action === "requeue-running") {
      const count = await requeueRunningWorkflowTasks(runId);
      return {
        ok: true,
        title: "Running tasks requeued",
        runId,
        output: [
          `Run: ${runId}`,
          `Requeued running tasks: ${count}`,
          `Open: /run?id=${encodeURIComponent(runId)}`
        ].join("\n")
      };
    }

    if (action === "retry-failed") {
      const count = await retryFailedWorkflowRun(runId);
      return {
        ok: true,
        title: "Failed tasks requeued",
        runId,
        output: [
          `Run: ${runId}`,
          `Requeued failed tasks: ${count}`,
          `Open: /run?id=${encodeURIComponent(runId)}`
        ].join("\n")
      };
    }

    if (action === "retry-runtime-fixed") {
      const queue = await listWorkflowQueue(500,{latestRelated:true});
      const item = queue.find(candidate=>candidate.runId===runId || candidate.familyAttempts?.some(attempt=>attempt.id===runId));
      const ownership = item?.failureOwnership;
      const capability = ownership?.requiredWorkerCapability;
      if (!item || ownership?.owner!=="agent-workflow-runtime" || !capability) {
        return {ok:false,error:"This run does not have an evidence-bound Agent Workflow runtime remedy."};
      }
      const activeCapabilities = await loadActiveWorkerCapabilities(ctx.defaultWorkerHeartbeatPath);
      const capableWorkers=activeCapabilities.get(capability)??[];
      const workerIds = capableWorkers.filter(worker=>workerEligibleForQueueProject(worker,item)).map(worker=>worker.workerId);
      if (!workerIds.length) return {ok:false,error:`Replay refused: ${workerEligibilityReason(capableWorkers,item,0)}`};
      const sourceRunId = ownership.evidenceRunId;
      const replayed = await replayWorkflowRun({
        sourceRunId,
        actor:"dashboard-runtime-remedy",
        reason:`Operator requested one checkpoint-preserving validation replay after active workers attested runtime capability ${capability}.`,
        preserveCompletedCheckpoints:true,
        evaluationMetadataPatch:{runtimeRemedy:{evidenceRunId:sourceRunId,repairRoute:ownership.repairRoute,classificationConfidence:ownership.confidence,requiredCapability:capability,attestedWorkerIds:workerIds,checkedAt:new Date().toISOString()}}
      });
      return replayed ? {ok:true,title:"Runtime-fixed validation replay queued",runId:replayed.runId,redirectToRun:true,output:[
        `Evidence run: ${sourceRunId}`,
        `Replay run: ${replayed.runId}`,
        `Required capability: ${capability}`,
        `Attested workers: ${workerIds.join(", ")}`,
        `Preserved checkpoints: ${replayed.completedTasks}/${replayed.tasks}`,
        `Queued validation stages: ${replayed.queuedTasks}`
      ].join("\n")} : {ok:false,error:`Unknown workflow run: ${sourceRunId}`};
    }

    if (action === "repair-blocked") {
      const repairActor = input.actor?.trim() || "dashboard";
      const details = await getWorkflowRunDetails(runId);
      if (!details.run || (details.run.status !== "blocked" && details.run.status !== "failed")) {
        return { ok: false, error: `Run is not blocked/failed or does not exist: ${runId}` };
      }
      const projectDir = await resolveLocalProjectRootUri(details.run.projectRootUri);
      const artifacts = await listArtifacts({ runId, kind: "stage_output" });
      const lastOutput = artifacts.at(-1)?.content ?? {};
      const blockedReason = (stringValue(lastOutput.blockedReason) || stringValue(lastOutput.summary) || "The source run did not record a specific blocker.").slice(0, 2000);
      try {
        await indexProjectForRun(ctx, { projectDir, maxFiles: 180, refine: false, forceRefine: false });
      } catch (error) {
        return { ok: false, error: `Project context refresh failed before repair: ${error instanceof Error ? error.message : String(error)}` };
      }
      const repairTask = [
        `Repair blocked Agent Workflow run ${runId}.`,
        `Original workflow: ${details.run.workflowId}.`,
        `Original task: ${details.run.task.slice(0, 4000)}`,
        `Recorded blocker: ${blockedReason}`,
        "Use the newly refreshed project context and source-run artifacts; preserve the original task boundaries. Diagnose and resolve the actual prerequisite or failure. Apply product edits and verification only when the original task requires them; for read-only or advisory work, do not invent file writes. After diagnosis, report blocked rather than completed if a real approval or unavailable external dependency still prevents progress."
      ].join("\n\n");
      const queued = await queueWorkflow(ctx, {
        workflowId: "debug-failure",
        projectPath: projectDir,
        registeredProjectRootUri: details.run.projectRootUri,
        task: repairTask,
        sourceTokenBudget: "12000",
        sourceMaxFiles: "180",
        includeExactSourceExcerpts: true,
        preferImplementationSources: true,
        requester: details.run.requester ?? undefined,
        requesterChannel: details.run.requesterChannel ?? undefined,
        evaluationMetadata: { ...inheritedCodexOrigin(details.run.evaluationMetadata), source: "blocked-run-repair", sourceRunId: runId, actor: repairActor }
      });
      if (!queued.ok) return { ok: false, error: queued.error };
      await recordRunAction({
        runId,
        agentId: "workflow-orchestrator",
        actionType: "blocked_run_repair_queued",
        target: queued.run.runId,
        summary: "Refreshed project context and queued a governed debug-failure repair run.",
        artifactKind: "blocked_run_repair",
        artifactContent: { sourceRunId: runId, repairRunId: queued.run.runId, workflowId: queued.workflow.id, projectRootUri: details.run.projectRootUri },
        idempotencyKey: `blocked-repair-${runId}-${queued.run.runId}-${repairActor}`
      });
      return {
        ok: true,
        title: "Blocked run repair queued",
        runId: queued.run.runId,
        redirectToRun: true,
        output: [
          `Blocked run: ${runId}`,
          `Repair run: ${queued.run.runId}`,
          `Project context refreshed: ${projectDir}`,
          queued.run.deduplicated ? "Matching repair already exists; reused it." : `Queued repair stages: ${queued.run.tasks}`,
          `Open: /run?id=${encodeURIComponent(queued.run.runId)}`
        ].join("\n")
      };
    }

    if (action === "resolve-blocker") {
      const details = await getWorkflowRunDetails(runId);
      if (!details.run || (details.run.status !== "blocked" && details.run.status !== "failed")) {
        return { ok: false, error: `Run is not blocked/failed or does not exist: ${runId}` };
      }
      const approvals = await listActionApprovals({ runId, limit: 100 });
      const openApprovals = approvals.filter(isOpenApproval);
      if (openApprovals.length) {
        return {
          ok: false,
          error: `This run has ${openApprovals.length} open approval${openApprovals.length === 1 ? "" : "s"}. Review /approvals?status=open&run=${encodeURIComponent(runId)}, then resolve the blocker again.`
        };
      }
      const projectDir = await resolveLocalProjectRootUri(details.run.projectRootUri);
      await indexProjectForRun(ctx, { projectDir, maxFiles: 180, refine: false, forceRefine: false });
      const staleReport = await assessRunStaleInputs(ctx, runId);
      const result = await resumeWorkflowRunFromCheckpoint({
        runId,
        actor: input.actor?.trim() || "dashboard",
        reason: "Blocker resolved from dashboard after refreshing project context; completed checkpoints preserved.",
        includeFailed: true
      });
      return result.requeuedTasks > 0
        ? {
          ok: true,
          title: "Blocker resolved and workflow resumed",
          runId: result.replacementRunId ?? runId,
          redirectToRun: Boolean(result.replacementRunId),
          output: [
            `Run: ${result.replacementRunId ?? runId}`,
            ...(result.replacementRunId ? [`Superseded blocked run: ${runId}`] : []),
            `Completed checkpoints preserved: ${result.completedTasks}/${result.totalTasks}`,
            `Requeued blocked or unfinished stages: ${result.requeuedTasks}`,
            `Project context refreshed: ${projectDir}`,
            ...formatStaleInputWarnings(staleReport),
            `Open: /run?id=${encodeURIComponent(result.replacementRunId ?? runId)}`
          ].join("\n")
        }
        : { ok: false, error: `No blocked or unfinished stages could be resumed for run ${runId}.` };
    }

    if (action === "skip-blocker") {
      if (!input.confirmed) {
        return { ok: false, error: "Confirm that you accept the missing stage evidence before skipping the blocker." };
      }
      const reason = input.reason.trim();
      if (!reason) {
        return { ok: false, error: "Explain why the blocked stage is safe to skip." };
      }
      const details = await getWorkflowRunDetails(runId);
      if (!details.run || (details.run.status !== "blocked" && details.run.status !== "failed")) {
        return { ok: false, error: `Run is not blocked/failed or does not exist: ${runId}` };
      }
      const skippedStageIds = details.tasks
        .filter((task) => task.status === "blocked" || task.status === "failed")
        .map((task) => task.stageId);
      if (!skippedStageIds.length) {
        return { ok: false, error: "No blocked or failed stage is available to skip." };
      }
      const replayed = await replayWorkflowRun({
        sourceRunId: runId,
        actor: input.actor?.trim() || "dashboard",
        reason,
        preserveCompletedCheckpoints: true,
        skipStageIds: skippedStageIds
      });
      if (!replayed) return { ok: false, error: `Unknown workflow run: ${runId}` };
      await dismissFailedWorkflowRun({
        runId,
        actor: input.actor?.trim() || "dashboard",
        reason: `Blocked stage ${skippedStageIds.join(", ")} explicitly skipped; continued in replacement run ${replayed.runId}. Operator reason: ${reason}`
      });
      return {
        ok: true,
        title: "Blocked stage skipped; workflow continued",
        runId: replayed.runId,
        redirectToRun: true,
        output: [
          `Source run: ${runId}`,
          `Continuation run: ${replayed.runId}`,
          `Skipped stage${skippedStageIds.length === 1 ? "" : "s"}: ${skippedStageIds.join(", ")}`,
          `Completed checkpoints preserved: ${replayed.completedTasks}/${replayed.tasks}`,
          `Queued remaining stages: ${replayed.queuedTasks}`,
          `Reason: ${reason}`,
          `Open: /run?id=${encodeURIComponent(replayed.runId)}`
        ].join("\n")
      };
    }

    if (action === "resume-checkpoint") {
      const staleReport = await assessRunStaleInputs(ctx, runId);
      const result = await resumeWorkflowRunFromCheckpoint({
        runId,
        actor: "dashboard",
        reason: "Checkpoint resume requested from dashboard.",
        includeFailed: true
      });
      return result.totalTasks > 0
        ? {
          ok: true,
          title: "Run resumed from checkpoint",
          runId: result.replacementRunId ?? runId,
          redirectToRun: Boolean(result.replacementRunId),
          output: [
            `Run: ${result.replacementRunId ?? runId}`,
            ...(result.replacementRunId ? [`Superseded terminal run: ${runId}`] : []),
            `Completed checkpoints preserved: ${result.completedTasks}/${result.totalTasks}`,
            `Requeued unfinished stages: ${result.requeuedTasks}`,
            ...formatStaleInputWarnings(staleReport),
            `Open: /run?id=${encodeURIComponent(runId)}`
          ].join("\n")
        }
        : { ok: false, error: `Run cannot be resumed or does not exist: ${runId}` };
    }

    if (action === "replay-run") {
      const staleReport = await assessRunStaleInputs(ctx, runId);
      const replayed = await replayWorkflowRun({
        sourceRunId: runId,
        actor: "dashboard",
        reason: "Replay requested from dashboard."
      });
      return replayed
        ? {
          ok: true,
          title: "Run replay queued",
          runId: replayed.runId,
          redirectToRun: true,
          output: [
            `Source run: ${runId}`,
            `Replay run: ${replayed.runId}`,
            `Queued stages: ${replayed.tasks}`,
            ...formatStaleInputWarnings(staleReport),
            `Open: /run?id=${encodeURIComponent(replayed.runId)}`
          ].join("\n")
        }
        : { ok: false, error: `Unknown workflow run: ${runId}` };
    }

    if (action === "dismiss-failed") {
      const reason = input.reason.trim() || "Dismissed from the dashboard queue.";
      let dismissed = false;
      try {
        dismissed = await dismissFailedWorkflowRun({ runId, actor: "dashboard", reason });
      } catch (error) {
        if (error instanceof PartnerManagedRunRecoveryError) {
          return { ok: false, error: "This is Partner-managed work. Use ‘Remove from queue’ with exact human confirmation on this card; generic dismissal remains protected." };
        }
        throw error;
      }
      return dismissed
        ? {
          ok: true,
          title: "Failed run dismissed",
          runId,
          output: [
            `Run: ${runId}`,
            `Reason: ${reason}`,
            "History, artifacts, and receipts were preserved.",
            "Open: /queue"
          ].join("\n")
        }
        : { ok: false, error: `Run has no failed queue items or does not exist: ${runId}` };
    }

    if (action === "withdraw-unaccepted") {
      if (!input.confirmed) return { ok: false, error: "Confirm withdrawal of this exact unsuccessful run first." };
      const row = await withClient(async client => (await client.query<{
        projectId:string; task:string; evaluationMetadata:Record<string,unknown> | null;
        requester:string|null;requesterChannel:string|null;
        status:string;
      }>(`select project_id::text as "projectId",task,status,evaluation_metadata as "evaluationMetadata",requester,requester_channel as "requesterChannel"
          from workflow_runs where id=$1::uuid`,[runId])).rows[0]);
      const originatingThreadId = typeof row?.evaluationMetadata?.codexThreadId === "string"
        ? row.evaluationMetadata.codexThreadId : "";
      if (!row) return { ok:false,error:`Unknown workflow run: ${runId}` };
      if((input.expectedTaskDigest&&input.expectedTaskDigest!==acceptanceDigest(row.task))||(input.expectedRunStatus&&input.expectedRunStatus!==row.status))return {ok:false,error:'This run changed after review. Refresh the queue and review it again.'};
      const owner = `dashboard-withdrawal:${runId}`;
      const intent = await acquireWorkIntent({
        projectId:row.projectId,owner,
        objective:`Withdraw exact unaccepted run ${runId} from active views`,
        fileScopes:[`runtime/withdrawals/${runId}`],ttlSeconds:120
      });
      try {
        const instruction=input.reason.trim()||"Remove this exact unsuccessful run from queue views without accepting it.";
        const originBinding=originatingThreadId?{originatingThreadId}:{operatorSessionId:randomUUID(),
          originalOriginDigest:acceptanceDigest({requester:row.requester,requesterChannel:row.requesterChannel,evaluationMetadata:row.evaluationMetadata})};
        await withdrawUnacceptedRun({projectId:row.projectId,runId,...originBinding,
          ...(input.expectedRunStatus?{expectedStatus:input.expectedRunStatus}:{}),
          originalTaskDigest:acceptanceDigest(row.task),owner,intentFence:intent.fencingToken,
          actor:input.actor?.trim()||"Human via dashboard",instruction,confirmation:WITHDRAW_RUN_CONFIRMATION});
        return {ok:true,title:"Unsuccessful run removed from queue",runId,output:[
          `Run: ${runId}`,`Instruction: ${instruction}`,
          "Original failed status, contracts, approvals, artifacts, and receipts remain in history.",
          "No execution or acceptance authority was granted.","Open: /queue"
        ].join("\n")};
      } catch(error) {
        const refusal=queueRemovalRefusal(error);
        if(refusal)return {ok:false,error:refusal};
        throw error;
      } finally {
        await releaseWorkIntent({projectId:row.projectId,owner,fencingToken:intent.fencingToken});
      }
    }

    return { ok: false, error: `Unsupported queue action: ${action || "none"}` };
  }

  async function processDashboardRoleAuditExport(input: {
    project: string;
    limit: string;
    role: string;
    status: string;
    actionType: string;
    out: string;
  }): Promise<DashboardFollowUpResult> {
    try {
      const report = await loadRoleGovernanceReport(ctx, {
        projectRootUri: input.project.trim() || undefined,
        limit: parsePositiveInteger(input.limit || "50", 50),
        role: input.role.trim() || undefined,
        status: input.status.trim() || "all",
        actionType: input.actionType.trim() || undefined
      });
      const exported = await writeRoleAuditSnapshot(ctx, report, input.out.trim() || undefined);
      return {
        ok: true,
        title: "Role Audit Snapshot Exported",
        output: [
          `Project: ${report.projectRootUri ?? "all registered projects"}`,
          `Filters: role=${report.filters.role ?? "all"} status=${report.filters.status} action=${report.filters.actionType ?? "all"}`,
          `Approvals: ${report.recentApprovals.length}`,
          "",
          `Markdown: ${exported.markdownPath}`,
          `JSON: ${exported.jsonPath}`,
          "",
          "Open: /roles"
        ].join("\n")
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async function processDashboardRun(input: {
    runId: string;
    mode: string;
    workerLimit: string;
    workerConcurrency: string;
    timeoutMs: string;
  }): Promise<DashboardFollowUpResult> {
    const runId = input.runId.trim();
    if (!runId) {
      return { ok: false, error: "Missing run id." };
    }

    const details = await getWorkflowRunDetails(runId);
    if (!details.run) {
      return { ok: false, error: `Unknown workflow run: ${runId}` };
    }

    const workerLimit = parsePositiveInteger(input.workerLimit || "6", 6);
    const workerConcurrency = parseBoundedPositiveInteger(input.workerConcurrency || "1", 1, 16);
    const timeoutMs = parsePositiveInteger(input.timeoutMs || "60000", 60000);
    if (input.mode === "watch") {
      const ticks: string[] = [];
      const watchResult = await watchWorkflowRun({
        runId,
        workerLimit,
        workerConcurrency,
        projectRootUri: details.run.projectRootUri,
        intervalMs: 1000,
        timeoutMs,
        onTick: (tick) => {
          if (tick.claimed > 0 || tick.completed > 0 || tick.failed > 0) {
            ticks.push(`Worker claimed ${tick.claimed}, completed ${tick.completed}, failed ${tick.failed}.`);
          }
        }
      });
      return {
        ok: true,
        title: `Run ${watchResult.status}`,
        runId,
        output: [
          `Run: ${runId}`,
          `Status: ${watchResult.status}`,
          `Tasks: ${watchResult.completedTasks}/${watchResult.totalTasks} completed, ${watchResult.failedTasks} failed`,
          `Receipts: ${watchResult.receipts}`,
          await formatPendingApprovalNotice(runId, details.run.projectRootUri),
          ticks.length ? ticks.join("\n") : "Worker did not claim tasks during the watch window.",
          `Open: /run?id=${encodeURIComponent(runId)}`
        ].filter(Boolean).join("\n")
      };
    }

    const workerResult = await runWorkerOnce(workerLimit, { workerId: normalizeWorkerId("dashboard"), projectRootUri: details.run.projectRootUri, concurrency: workerConcurrency });
    const updated = await getWorkflowRunDetails(runId);
    const completedTasks = updated.tasks.filter((task) => task.status === "completed").length;
    const failedTasks = updated.tasks.filter((task) => task.status === "failed").length;
    return {
      ok: true,
      title: "Worker batch processed",
      runId,
      output: [
        `Run: ${runId}`,
        `Worker claimed ${workerResult.claimed}, completed ${workerResult.completed}, failed ${workerResult.failed}.`,
        updated.run ? `Status: ${updated.run.status}` : "",
        `Tasks: ${completedTasks}/${updated.tasks.length} completed, ${failedTasks} failed`,
        `Receipts: ${updated.receipts.length}`,
        await formatPendingApprovalNotice(runId, updated.run?.projectRootUri ?? details.run.projectRootUri),
        `Open: /run?id=${encodeURIComponent(runId)}`
      ].filter(Boolean).join("\n")
    };
  }

  async function processDashboardRunApprovalLevel(input: {
    runId: string;
    level: string;
    reason: string;
  }): Promise<DashboardFollowUpResult> {
    const runId = input.runId.trim();
    const level = input.level.trim();
    const reason = input.reason.trim();
    if (!runId || !RUN_APPROVAL_LEVELS.includes(level as typeof RUN_APPROVAL_LEVELS[number])) return { ok: false, error: "Choose a valid approval level." };
    if (!reason) return { ok: false, error: "A reason is required for the audit receipt." };
    const details = await getWorkflowRunDetails(runId);
    if (!details.run) return { ok: false, error: `Run not found: ${runId}` };
    if (level === details.run.autonomy) {
      return { ok: true, title: "Approval level unchanged", runId, output: `Run: ${runId}\nApproval level remains ${level} · ${runApprovalLevelLabel(level)}.\nNo continuation or policy mutation was created.` };
    }
    if (details.run.replacementRunId) return { ok: false, error: `This run is immutable history. Change approval level on continuation ${details.run.replacementRunId}.` };
    if (details.run.status === "leased" || details.run.status === "running") {
      return { ok: false, error: "Approval level cannot change while a worker owns the run. Wait for the stage to finish, then create a checkpoint continuation at the new level." };
    }
    const configured = await loadLocalProjectConfig(details.run.projectRootUri);
    const resolved = resolveExecutionPolicy(configured, details.run.policyProfile);
    const ceiling = String(resolved.project.project.autonomy);
    if (runApprovalLevelRank(level) > runApprovalLevelRank(ceiling)) {
      return { ok: false, error: `Level ${level} exceeds the project/profile ceiling of ${ceiling}. Change project policy first.` };
    }
    const policySnapshot = {
      ...resolved.snapshot,
      project: { ...resolved.snapshot.project, autonomy: level }
    } as ProjectConfig;
    const policySnapshotHash = canonicalJsonHash(policySnapshot);
    if (details.run.status === "queued") {
      const changed = await setQueuedWorkflowRunAutonomy({ runId, autonomy: level, policySnapshot, policySnapshotHash, actor: "dashboard", reason });
      if (!changed) return { ok: false, error: "The run was claimed while the level was changing. Refresh and try again after the active stage finishes." };
      return { ok: true, title: "Run approval level updated", runId, output: `Run: ${runId}\nApproval level: ${level} · ${runApprovalLevelLabel(level)}\nAudit receipt recorded before worker claim.` };
    }
    const replay = await replayWorkflowRun({
      sourceRunId: runId,
      actor: "dashboard",
      reason: `${reason} Approval level ${details.run.autonomy} -> ${level}.`,
      preserveCompletedCheckpoints: true,
      evaluationMetadataPatch: { source: "run-approval-level-change", sourceRunId: runId, priorAutonomy: details.run.autonomy, requestedAutonomy: level },
      autonomyOverride: level
    });
    if (!replay) return { ok: false, error: `Unable to create approval-level continuation for ${runId}.` };
    return { ok: true, title: "Approval-level continuation queued", runId: replay.runId, output: `Source run: ${runId}\nContinuation: ${replay.runId}\nApproval level: ${level} · ${runApprovalLevelLabel(level)}\nPreserved checkpoints: ${replay.completedTasks}` };
  }

  async function processDashboardRuntimeMonitorAction(form: URLSearchParams): Promise<DashboardFollowUpResult> {
    const action = normalizeLookup(form.get("action") ?? "");
    if (action === "check-mcp") {
      const report = await loadRuntimeMonitorReport({ checkMcp: true });
      return report.mcpPipeline.smoke.status === "passed"
        ? { ok: true, title: "MCP smoke passed", output: formatMcpPipelineStatus(report.mcpPipeline) }
        : { ok: false, error: formatMcpPipelineStatus(report.mcpPipeline) };
    }
    if (action === "write-mcp-recovery") {
      const report = await loadRuntimeMonitorReport({ checkMcp: true });
      report.mcpPipeline.recovery = await writeMcpRecoveryPackage(report.mcpPipeline);
      return {
        ok: true,
        title: "MCP recovery package written",
        output: [
          `Markdown: ${report.mcpPipeline.recovery.markdownPath}`,
          `JSON: ${report.mcpPipeline.recovery.jsonPath}`,
          `Script: ${report.mcpPipeline.recovery.scriptPath}`,
          "",
          formatMcpPipelineStatus(report.mcpPipeline)
        ].join("\n")
      };
    }
    if (action === "reconcile-stale-runs") {
      const result = await reconcileStaleTerminalWorkflowRuns({
        execute: true,
        limit: parseStaleRunReconcileLimit(),
        actor: "dashboard"
      });
      return {
        ok: true,
        title: "Stale runs reconciled",
        output: formatRuntimeStaleRunReconciliationResult(result)
      };
    }
    if (action !== "cleanup-mcp") {
      return { ok: false, error: "Unknown runtime monitor action." };
    }
    if (form.get("confirmed") !== "on") {
      const preview = await cleanupRuntimeMcpProcesses(ctx, { execute: false });
      return {
        ok: false,
        error: [
          "Confirmation is required before terminating MCP processes.",
          "",
          formatRuntimeMcpCleanupResult(preview)
        ].join("\n")
      };
    }
    const pids = form.getAll("pid").map((value) => Number.parseInt(value, 10)).filter(Number.isFinite);
    if (!pids.length) {
      return { ok: false, error: "No MCP cleanup candidates were selected." };
    }
    const result = await cleanupRuntimeMcpProcesses(ctx, { execute: true, pids });
    const output = formatRuntimeMcpCleanupResult(result);
    return result.warnings.length
      ? { ok: false, error: output }
      : { ok: true, title: "MCP cleanup completed", output };
  }

  async function processDashboardStorageProjectDecisionAction(form: URLSearchParams): Promise<DashboardFollowUpResult> {
    const rootUri = form.get("rootUri")?.trim() || "";
    const action = form.get("action")?.trim() || "";
    const note = form.get("note")?.trim() || "";
    if (!rootUri) return { ok: false, error: "Missing project root URI." };
    if (!["preserve-target-project", "promote-source-project", "manual-project-review"].includes(action)) {
      return { ok: false, error: "Choose preserve-target-project, promote-source-project, or manual-project-review." };
    }
    if (!note) return { ok: false, error: "A short decision note is required." };
    const result = await writeStorageProjectConflictDecision(ctx, {
      outDir: form.get("out")?.trim() || ".agent-workflow/migrations",
      rootUri,
      action,
      sourceProjectId: form.get("sourceProjectId")?.trim() || undefined,
      targetProjectId: form.get("targetProjectId")?.trim() || undefined,
      reviewer: form.get("reviewer")?.trim() || process.env.USER || "dashboard",
      note
    });
    return {
      ok: true,
      title: "Project decision recorded",
      output: [
        `Root: ${rootUri}`,
        `Action: ${action}`,
        `Decisions: ${result.decisionCount}`,
        `Evidence: ${result.jsonPath}`
      ].join("\n")
    };
  }

  async function processDashboardTrustedCommand(form: URLSearchParams, operation: "add" | "remove"): Promise<DashboardFollowUpResult> {
    try {
      const scope = form.get("scope") === "global" ? "global" : "project";
      const pattern = form.get("pattern") ?? "";
      if (scope === "project") return updateProjectTrustedCommand({ projectRootUri: form.get("project") ?? "", pattern, operation });
      const result = operation === "add"
        ? await addGlobalTrustedCommand(pattern)
        : await removeGlobalTrustedCommand(pattern);
      return {
        ok: true,
        title: operation === "add" ? "Global trusted command added" : "Global trusted command removed",
        output: [`Pattern: ${normalizeTrustedCommandPattern(pattern)}`, `Config: ${result.filePath}`, "Scope: all projects on this machine"].join("\n")
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function processServerOrchestrationRequest(request: http.IncomingMessage, body: unknown, limits = serverRequestLimits()): Promise<ServerOrchestrationReport> {
    const payload = objectValue(body);
    const requestedProjectId = stringValue(payload.projectId)?.trim() ?? "";
    const requestedProjectName = stringValue(payload.projectName)?.trim() ?? "";
    const goal = stringValue(payload.goal)?.trim() ?? "";
    const actor = stringValue(payload.actor)?.trim() || "server-client";
    const actorRole = stringValue(payload.actorRole)?.trim() || "operator";
    const idempotencyKey = stringValue(payload.idempotencyKey)?.trim() ?? "";
    const executeRequested = payload.execute === true;
    const summaries = await listProjectStorageSummaries(500);
    const nameMatches = requestedProjectName ? summaries.filter((item) => item.name === requestedProjectName) : [];
    const summary = requestedProjectId
      ? summaries.find((item) => item.id === requestedProjectId)
      : nameMatches.length === 1 ? nameMatches[0] : undefined;
    const localProjectRoot = summary ? await resolveLocalProjectRootUri(summary.rootUri) : null;
    // A remote or historical registration may map to a different checkout on
    // this host. Runs must bind to that exact local registration; persisting
    // the pre-map root makes later workers treat an unavailable path as the
    // execution scope even though admission read a different checkout.
    const executionSummary = localProjectRoot
      ? summaries.find((item) => path.resolve(item.rootUri) === path.resolve(localProjectRoot))
      : undefined;
    const registeredProject = executionSummary ? await loadRegisteredProjectConfig(executionSummary).catch(() => null) : null;
    const roleGate = registeredProject
      ? evaluateRoleGate(registeredProject, actorRole, "can_request_approvals")
      : { allowed: false, message: "Registered project policy is unavailable." };
    const roleAccepted = Boolean(registeredProject && (registeredProject.team.enforcement !== "enforce" || roleGate.allowed));
    const projectId = executionSummary?.id ?? summary?.id ?? requestedProjectId;
    const operationId = `op_${stableHash([projectId, idempotencyKey]).slice(0, 24)}`;
    const auth = validateServerMutationAuth(request);
    const serverModeEnabled = envFlag("AGENTFLOW_SERVER_MODE");
    const orchestrationEnabled = envFlag("AGENTFLOW_SERVER_ENABLE_ORCHESTRATION") || envFlag("AGENTFLOW_SERVER_ENABLE_QUEUE");
    const rateLimit = checkServerQueueRateLimit({ request, actor, limitPerMinute: limits.rateLimitPerMinute });
    const checks: ServerOrchestrationReport["checks"] = [
      { label: "Registered project", status: summary ? "pass" : "fail", detail: summary ? `Resolved registered project ${summary.name}.` : requestedProjectName && nameMatches.length > 1 ? "Project name is ambiguous; send projectId." : "Project id/name did not resolve to one registered project." },
      { label: "Host project mapping", status: executionSummary ? "pass" : "fail", detail: executionSummary ? summary?.id === executionSummary.id ? `Using registered host root ${executionSummary.rootUri}.` : `Mapped ${summary?.rootUri} to registered host root ${executionSummary.rootUri}.` : summary ? `Registered project root ${summary.rootUri} is unavailable on this host and did not map to a registered local project.` : "No registered project was available to map." },
      { label: "Goal", status: goal ? "pass" : "fail", detail: goal ? "Natural-language goal is present." : "goal is required." },
      { label: "Actor", status: actor && actorRole ? "pass" : "fail", detail: `Actor role is ${actorRole || "missing"}.` },
      { label: "Role capability", status: roleAccepted ? (roleGate.allowed ? "pass" : "warn") : "fail", detail: roleGate.message },
      { label: "Idempotency", status: idempotencyKey ? "pass" : "fail", detail: idempotencyKey ? "Client idempotency key is present." : "idempotencyKey is required." },
      { label: "Authentication", status: auth.ok ? "pass" : "fail", detail: auth.ok ? `Authenticated with ${auth.method}.` : auth.error },
      { label: "Execution gate", status: !executeRequested ? "warn" : serverModeEnabled && orchestrationEnabled ? "pass" : "fail", detail: !executeRequested ? "Dry-run only; set execute=true to queue." : serverModeEnabled && orchestrationEnabled ? "Server orchestration is enabled." : "AGENTFLOW_SERVER_MODE and the orchestration execution gate are required." },
      { label: "Rate limit", status: rateLimit.ok ? "pass" : "fail", detail: rateLimit.ok ? "Request is within the configured rate limit." : `Retry after ${rateLimit.resetAt}.` }
    ];
    let workflowId: string | null = null;
    let runId: string | null = null;
    let receiptUri: string | null = null;
    let reused = false;
    const canQueue = Boolean(executionSummary && goal && idempotencyKey && auth.ok && roleAccepted && executeRequested && serverModeEnabled && orchestrationEnabled && rateLimit.ok);
    if (canQueue && executionSummary) {
      const existing = (await listWorkflowRunsForProject({ projectRootUri: executionSummary.rootUri, limit: 500 }))
        .find((run) => stringValue(run.evaluationMetadata?.source) === "server-orchestration" && stringValue(run.evaluationMetadata?.operationId) === operationId);
      if (existing) {
        runId = existing.id;
        workflowId = existing.workflowId;
        reused = true;
      } else {
        const project = await loadProjectConfig(localProjectRoot as string);
        const dynamic = constructDynamicWorkflow({ goal, project, agents: await loadAgentsForProject(ctx, localProjectRoot as string), executionProfile: "adaptive" });
        workflowId = dynamic.id;
        const queued = await queueWorkflow(ctx, {
          workflowId: dynamic.id,
          workflowOverride: dynamic,
          projectPath: localProjectRoot as string,
          registeredProjectRootUri: executionSummary.rootUri,
          task: goal,
          policyProfile: project.execution.policy_profile,
          evaluationMetadata: { source: "server-orchestration", operationId, idempotencyKey, actor, actorRole, projectId: executionSummary.id, requestedProjectId: summary?.id ?? null, executionProfile: "adaptive" }
        });
        if (queued.ok) {
          runId = queued.run.runId;
          receiptUri = await recordRunAction({
            runId,
            agentId: "workflow-orchestrator",
            actionType: "server_orchestration_requested",
            target: executionSummary.id,
            summary: `Accepted one-goal orchestration request for ${executionSummary.name}.`,
            artifactKind: "server_orchestration_request",
            artifactContent: { operationId, projectId: executionSummary.id, requestedProjectId: summary?.id ?? null, projectName: executionSummary.name, projectRootUri: executionSummary.rootUri, goalHash: stableHash(goal), actor, actorRole, workflowId: dynamic.id, executionProfile: "adaptive", receivedAt: new Date().toISOString() },
            idempotencyKey: `server-orchestration-${stableHash(idempotencyKey).slice(0, 24)}`
          });
        } else {
          checks.push({ label: "Workflow construction", status: "fail", detail: queued.error });
        }
      }
    }
    const blocked = checks.some((check) => check.status === "fail");
    return {
      kind: "agentflow_server_orchestration_report",
      generatedAt: new Date().toISOString(),
      status: runId ? "queued" : blocked ? "blocked" : "ready",
      operationId,
      projectId,
      projectName: executionSummary?.name ?? summary?.name ?? null,
      goalHash: stableHash(goal),
      workflowId,
      runGroup: { runIds: runId ? [runId] : [], aggregateStatus: runId ? "queued" : blocked ? "blocked" : "queued" },
      receiptUri,
      reused,
      checks,
      links: {
        status: `/api/server-orchestration-status?projectId=${encodeURIComponent(projectId)}&operationId=${encodeURIComponent(operationId)}`,
        events: `/api/server-orchestration-events?projectId=${encodeURIComponent(projectId)}&operationId=${encodeURIComponent(operationId)}`,
        run: runId ? `/run?id=${encodeURIComponent(runId)}` : null
      }
    };
  }

  function promotionNotePlanForm(report: DashboardCandidateComparisonReport): string {
    const suiteIds = report.promotionRecommendations
      .filter((recommendation) => recommendation.decision === "propose_routing_note")
      .map((recommendation) => recommendation.suiteId);
    if (!suiteIds.length) {
      return '<p class="muted">Run baseline and candidate evaluations until a suite is promotable before generating a promotion note plan.</p>';
    }
    return `<form class="inline-form" method="post" action="/api/follow-up">
      <input type="hidden" name="project" value="${escapeHtml(report.projectDir)}">
      <input type="hidden" name="action" value="promotion-note-plan">
      <input type="hidden" name="ids" value="${escapeHtml(suiteIds.join(","))}">
      <button type="submit">Preview Promotion Note Plan</button>
    </form>`;
  }

  async function queueArtifactLifecycleApprovals(input: {
    report: ArtifactLifecycleReport;
    action: ArtifactLifecycleAction;
    actor: string;
    actorRole: string;
  }): Promise<ArtifactLifecycleApprovalQueue> {
    const projectRootUri = input.report.projectRootUri;
    if (!projectRootUri) {
      return {
        mode: "approval-request",
        action: input.action,
        generatedAt: new Date().toISOString(),
        requestedBy: input.actor,
        requestedByRole: input.actorRole,
        totalRequested: 0,
        skipped: ["A project is required before lifecycle approvals can be queued."],
        approvals: []
      };
    }
    const plan = artifactLifecyclePlanForAction(input.report, input.action);
    if (!plan) {
      return {
        mode: "approval-request",
        action: input.action,
        generatedAt: new Date().toISOString(),
        requestedBy: input.actor,
        requestedByRole: input.actorRole,
        totalRequested: 0,
        skipped: [`A dry-run ${input.action} plan is required before lifecycle approvals can be queued.`],
        approvals: []
      };
    }
    if (input.report.retentionPolicy.legalHold) {
      return {
        mode: "approval-request",
        action: input.action,
        generatedAt: new Date().toISOString(),
        requestedBy: input.actor,
        requestedByRole: input.actorRole,
        totalRequested: 0,
        skipped: ["Project legal hold is enabled; lifecycle approval requests were not queued."],
        approvals: []
      };
    }

    const project = await loadLocalProjectConfig(projectRootUri);
    const requestRoleGate = evaluateRoleGate(project, input.actorRole, "can_request_approvals");
    if (!requestRoleGate.allowed) {
      return {
        mode: "approval-request",
        action: input.action,
        generatedAt: new Date().toISOString(),
        requestedBy: input.actor,
        requestedByRole: input.actorRole,
        totalRequested: 0,
        skipped: [requestRoleGate.message],
        approvals: []
      };
    }

    const agents = await loadAgentRecords(ctx.rootDir);
    const workflows = await loadWorkflowRecords(ctx.rootDir);
    await seedRegistry(agents, workflows);

    const approvals: ArtifactLifecycleApprovalQueue["approvals"] = [];
    const approvalActionType = artifactLifecycleApprovalActionType(input.action);
    for (const candidate of plan.candidates) {
      const idempotencyKey = stableHash({
        actionType: approvalActionType,
        artifactId: candidate.artifactId,
        uri: candidate.uri,
        runId: candidate.runId,
        projectRootUri,
        criteria: plan.criteria
      });
      const approval = await requestActionApproval({
        runId: candidate.runId,
        taskId: candidate.taskId,
        stageId: "artifact-lifecycle",
        agentId: "workflow-orchestrator",
        actionType: approvalActionType,
        target: candidate.uri,
        rationale: `Artifact lifecycle ${input.action} approval requested for ${candidate.artifactId}: ${candidate.reason}`,
        policyDecision: {
          approvalRequired: plan.approvalRequired,
          policySource: plan.criteria.policySource,
          retentionPolicy: input.report.retentionPolicy,
          criteria: plan.criteria,
          roleGate: requestRoleGate.message,
          destructiveCapabilityEnabled: lifecycleExecutionCapabilityEnabled(input.report.retentionPolicy, input.action),
          destructiveExecutionAvailable: false
        },
        payload: {
          ...candidate.receiptPreview.metadata,
          target: candidate.receiptPreview.target,
          summary: candidate.receiptPreview.summary,
          projectRootUri,
          requestedBy: input.actor,
          requestedByRole: input.actorRole,
          queuedAt: new Date().toISOString()
        },
        idempotencyKey
      });
      approvals.push({
        approvalId: approval.approvalId,
        status: approval.status,
        artifactUri: approval.artifactUri,
        runId: candidate.runId,
        target: candidate.uri,
        artifactId: candidate.artifactId,
        idempotencyKey
      });
    }

    return {
      mode: "approval-request",
      action: input.action,
      generatedAt: new Date().toISOString(),
      requestedBy: input.actor,
      requestedByRole: input.actorRole,
      totalRequested: approvals.length,
      skipped: approvals.length ? [] : [`No ${input.action} candidates were available to queue.`],
      approvals
    };
  }

  async function queueDashboardStageFix(input: {
    projectDir: string;
    workflowId: string;
    stageId: string;
  }): Promise<DashboardFollowUpResult> {
    const projectDir = path.resolve(process.cwd(), input.projectDir.trim());
    const workflowId = input.workflowId.trim();
    const stageId = input.stageId.trim();
    if (!workflowId) {
      return { ok: false, error: "Missing workflow id." };
    }
    if (!stageId) {
      return { ok: false, error: "Missing stage id." };
    }

    const workflows = await loadWorkflows(ctx.rootDir);
    const workflow = resolveWorkflow(workflows, workflowId);
    if (!workflow) {
      return { ok: false, error: `Unknown workflow: ${workflowId}` };
    }
    const stage = workflow.stages.find((item) => item.id === stageId);
    if (!stage) {
      return { ok: false, error: `Unknown stage '${stageId}' for workflow '${workflow.id}'.` };
    }

    const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: 100 });
    const workflowRuns = projectRuns.filter((run) => run.workflowId === workflow.id).slice(0, 50);
    const stageRuns = await listWorkflowStageRunsForRuns({
      runIds: workflowRuns.map((run) => run.id),
      stageId
    });
    const failedStageRuns = stageRuns.filter((run) => run.taskStatus === "failed" || run.runStatus === "failed").slice(0, 8);
    const recentStageRuns = stageRuns.slice(0, 8);
    const runLines = (failedStageRuns.length ? failedStageRuns : recentStageRuns).map((run) => (
      `- ${run.runId}: run=${run.runStatus}, stage=${run.taskStatus}, attempts=${run.attempts}, agent=${run.agentId}, task="${run.task}"`
    ));
    const task = [
      `Suggest a focused fix for workflow '${workflow.id}' stage '${stage.id}'.`,
      "",
      `Stage goal: ${stage.goal}`,
      `Primary agent: ${stage.agent}`,
      stage.subagents.length ? `Subagents: ${stage.subagents.join(", ")}` : "Subagents: none",
      "",
      "Use recent run history to identify the likely cause, files or commands to inspect, and the smallest safe next fix.",
      "Do not make broad unrelated changes. Preserve project policy and write receipts for any requested action.",
      "",
      runLines.length ? "Recent relevant stage runs:" : "Recent relevant stage runs: none found for the selected project/workflow.",
      ...runLines
    ].join("\n");

    const queued = await queueWorkflow(ctx, {
      workflowId: "debug-failure",
      projectPath: projectDir,
      task,
      sourceTokenBudget: "3000",
      sourceMaxFiles: "40",
      evaluationMetadata: {
        kind: "stage_fix_suggestion",
        sourceWorkflowId: workflow.id,
        sourceStageId: stage.id,
        sourceProjectRootUri: projectDir,
        sourceRunIds: (failedStageRuns.length ? failedStageRuns : recentStageRuns).map((run) => run.runId),
        createdFrom: "dashboard-workflow-graph"
      }
    });
    if (!queued.ok) {
      return { ok: false, error: queued.error };
    }
    return {
      ok: true,
      title: "Stage Fix Suggested",
      runId: queued.run.runId,
      output: [
        `Queued debug run: ${queued.run.runId}`,
        `Source workflow: ${workflow.id}`,
        `Focused stage: ${stage.id}`,
        `Recent stage records: ${stageRuns.length}`,
        failedStageRuns.length ? `Failed records included: ${failedStageRuns.length}` : "No failed stage records found; queued from recent stage history.",
        `Open: /run?id=${encodeURIComponent(queued.run.runId)}`,
        "",
        "Process queued stages with:",
        "npm run worker -- --limit 6"
      ].join("\n")
    };
  }

  async function queueDashboardStageVerification(input: {
    projectDir: string;
    workflowId: string;
    stageId: string;
    fixRunId: string;
  }): Promise<DashboardFollowUpResult> {
    const projectDir = path.resolve(process.cwd(), input.projectDir.trim());
    const workflowId = input.workflowId.trim();
    const stageId = input.stageId.trim();
    const fixRunId = input.fixRunId.trim();
    if (!workflowId) {
      return { ok: false, error: "Missing workflow id." };
    }
    if (!stageId) {
      return { ok: false, error: "Missing stage id." };
    }
    if (!fixRunId) {
      return { ok: false, error: "Missing suggested fix run id." };
    }

    const fixRun = await getWorkflowRunDetails(fixRunId);
    if (!fixRun.run) {
      return { ok: false, error: `Unknown suggested fix run: ${fixRunId}` };
    }
    if (fixRun.run.status === "queued" || fixRun.run.status === "leased" || fixRun.run.status === "running") {
      return { ok: false, error: "Wait for the suggested fix run to finish before rerunning the source workflow." };
    }
    const metadata = fixRun.run.evaluationMetadata ?? {};
    if (metadata.kind !== "stage_fix_suggestion" || metadata.sourceWorkflowId !== workflowId || metadata.sourceStageId !== stageId) {
      return { ok: false, error: "Run is not a suggested fix for the selected workflow stage." };
    }

    const task = [
      `Rerun workflow '${workflowId}' after suggested fix run '${fixRunId}' to verify focused stage '${stageId}'.`,
      "",
      "Use this as the after run for focused-stage health comparison.",
      "Preserve project policy, keep changes scoped, and write receipts for requested actions.",
      "",
      `Suggested fix status: ${fixRun.run.status}`,
      `Suggested fix task: ${fixRun.run.task}`
    ].join("\n");

    const queued = await queueWorkflow(ctx, {
      workflowId,
      projectPath: projectDir,
      task,
      sourceTokenBudget: "3000",
      sourceMaxFiles: "40",
      evaluationMetadata: {
        kind: "stage_fix_verification",
        sourceWorkflowId: workflowId,
        sourceStageId: stageId,
        sourceFixRunId: fixRunId,
        sourceProjectRootUri: projectDir,
        createdFrom: "dashboard-workflow-graph"
      }
    });
    if (!queued.ok) {
      return { ok: false, error: queued.error };
    }
    return {
      ok: true,
      title: "Source Workflow Rerun Queued",
      runId: queued.run.runId,
      output: [
        `Verification run: ${queued.run.runId}`,
        `Source workflow: ${workflowId}`,
        `Focused stage: ${stageId}`,
        `Suggested fix run: ${fixRunId}`,
        `Open: /run?id=${encodeURIComponent(queued.run.runId)}`,
        "",
        "Process queued stages with:",
        "npm run worker -- --limit 6"
      ].join("\n")
    };
  }

  // Studio "Run now" watches, keyed by run id. A watch drives worker ticks
  // inside the daemon so a freshly queued run makes live progress in the
  // Studio task pane (which already polls /api/runs and refreshes on
  // /api/studio-events). The watch is detached: the submit POST returns
  // immediately and Studio renders progress from the existing feed. A
  // second Run now for the same run reuses the in-flight watch instead of
  // spawning a duplicate worker loop.
  const studioRunNowWatches = new Set<string>();

  function startStudioRunNowWatch(runId: string, projectDir: string): void {
    if (studioRunNowWatches.has(runId)) return;
    studioRunNowWatches.add(runId);
    void watchWorkflowRun({
      runId,
      workerLimit: 6,
      workerConcurrency: 1,
      projectRootUri: projectDir,
      intervalMs: 1000,
      timeoutMs: 900000,
      onTick: (tick) => {
        if (tick.claimed > 0 || tick.completed > 0 || tick.failed > 0) {
          console.log(`Studio run now ${runId}: worker claimed ${tick.claimed}, completed ${tick.completed}, failed ${tick.failed}.`);
        }
      }
    }).then(
      (watchResult) => {
        studioRunNowWatches.delete(runId);
        console.log(`Studio run now ${runId} finished: ${watchResult.status} (${watchResult.completedTasks}/${watchResult.totalTasks} tasks, ${watchResult.failedTasks} failed).`);
      },
      (error) => {
        studioRunNowWatches.delete(runId);
        console.error(`Studio run now ${runId} watch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    );
  }

  async function queueDashboardWorkflowRun(input: {
    workflowId: string;
    project: string;
    task: string;
    sourceTokenBudget?: string;
    sourceMaxFiles?: string;
    watch?: boolean;
    workerLimit?: string;
    workerConcurrency?: string;
    timeoutMs?: string;
  }): Promise<DashboardFollowUpResult> {
    const workflowId = input.workflowId.trim();
    const project = input.project.trim();
    const task = input.task.trim();
    if (!workflowId) {
      return { ok: false, error: "Missing workflow." };
    }
    if (!project) {
      return { ok: false, error: "Missing project path." };
    }
    if (!task) {
      return { ok: false, error: "Missing task." };
    }

    const queued = await queueWorkflow(ctx, {
      workflowId,
      projectPath: project,
      task,
      sourceTokenBudget: input.sourceTokenBudget?.trim(),
      sourceMaxFiles: input.sourceMaxFiles?.trim()
    });

    if (!queued.ok) {
      return { ok: false, error: queued.error };
    }

    const runUrl = `/run?id=${encodeURIComponent(queued.run.runId)}`;
    const output = [
      `Run: ${queued.run.runId}`,
      `Workflow: ${queued.workflow.id}`,
      `Project: ${queued.projectDir}`,
      queued.run.deduplicated ? "Duplicate suppressed: reused the matching active or recently completed run." : `Queued stages: ${queued.run.tasks}`,
      `Open: ${runUrl}`
    ];

    if (input.watch) {
      const workerLimit = parsePositiveInteger(input.workerLimit ?? "6", 6);
      const workerConcurrency = parseBoundedPositiveInteger(input.workerConcurrency ?? "1", 1, 16);
      const timeoutMs = parsePositiveInteger(input.timeoutMs ?? "60000", 60000);
      const ticks: string[] = [];
      const watchResult = await watchWorkflowRun({
        runId: queued.run.runId,
        workerLimit,
        workerConcurrency,
        projectRootUri: queued.projectDir,
        intervalMs: 1000,
        timeoutMs,
        onTick: (tick) => {
          if (tick.claimed > 0 || tick.completed > 0 || tick.failed > 0) {
            ticks.push(`Worker claimed ${tick.claimed}, completed ${tick.completed}, failed ${tick.failed}.`);
          }
        }
      });
      output.push(
        "",
        `Status: ${watchResult.status}`,
        `Tasks: ${watchResult.completedTasks}/${watchResult.totalTasks} completed, ${watchResult.failedTasks} failed`,
        `Receipts: ${watchResult.receipts}`,
        await formatPendingApprovalNotice(queued.run.runId, queued.projectDir),
        ticks.length ? ticks.join("\n") : "Worker did not claim tasks during the watch window."
      );
    } else {
      output.push(
        "",
        "Process queued stages with:",
        "npm run worker -- --limit 6"
      );
    }

    return {
      ok: true,
      title: input.watch ? "Workflow run watched" : "Workflow queued",
      runId: queued.run.runId,
      output: output.join("\n")
    };
  }

  async function readDashboardGraphPresets(projectDir: string): Promise<DashboardGraphPresetFile> {
    const parsed = await ctx.readJsonFile<Partial<DashboardGraphPresetFile>>(dashboardGraphPresetsPath(projectDir));
    if (!parsed) {
      return {
        kind: "agentflow_graph_presets",
        projectRootUri: projectDir,
        updatedAt: new Date(0).toISOString(),
        presets: []
      };
    }
    const presets = Array.isArray(parsed.presets)
      ? parsed.presets.map((preset) => normalizeDashboardGraphPreset(preset)).filter((preset): preset is DashboardGraphPreset => Boolean(preset))
      : [];
    return {
      kind: "agentflow_graph_presets",
      projectRootUri: typeof parsed.projectRootUri === "string" ? parsed.projectRootUri : projectDir,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      presets: presets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    };
  }

  async function readScheduleState(statePath: string): Promise<Record<string, { lastRunAt: string; lastRunId: string; lastStatus: string }>> {
    try {
      return JSON.parse(await fs.readFile(statePath, "utf8")) as Record<string, { lastRunAt: string; lastRunId: string; lastStatus: string }>;
    } catch {
      return {};
    }
  }

  function renderAgentImprovementHtml(report: AgentImprovementReport, evalPlan: AgentImprovementEvalPlan | null, promotionQueue: AgentImprovementPromotionQueue | null): string {
    const command = `npm run agentflow -- agent-improvement-report --project ${shellQuote(report.projectRootUri)} --write`;
    const patchCommand = `npm run agentflow -- agent-improvement-patches --project ${shellQuote(report.projectRootUri)} --write`;
    const evalCommand = `npm run agentflow -- agent-improvement-evals --project ${shellQuote(report.projectRootUri)} --write`;
    const promotionCommand = `npm run agentflow -- agent-improvement-promotions --project ${shellQuote(report.projectRootUri)} --write`;
    const applyCommand = `npm run agentflow -- agent-improvement-apply --project ${shellQuote(report.projectRootUri)} --write`;
    const patchHref = `/api/agent-improvement-patches?project=${encodeURIComponent(report.projectRootUri)}&limit=${encodeURIComponent(String(report.limit))}`;
    const evalHref = `/api/agent-improvement-evals?project=${encodeURIComponent(report.projectRootUri)}&limit=${encodeURIComponent(String(report.limit))}`;
    const promotionHref = `/api/agent-improvement-promotions?project=${encodeURIComponent(report.projectRootUri)}&limit=${encodeURIComponent(String(report.limit))}`;
    const evalRows = (evalPlan?.evaluations ?? []).slice(0, 12).map((item) => `
      <tr>
        <td>${escapeHtml(item.agentId)}<br><span class="muted">${escapeHtml(item.scope)}</span></td>
        <td><span class="flag ${item.status === "pass" ? "good" : item.status === "warn" ? "queued" : "warn"}">${escapeHtml(item.status)}</span><br><span class="muted">${item.score}/100</span></td>
        <td>${item.holdoutTasks.length}</td>
        <td>${item.promotionReady ? "yes" : "no"}</td>
        <td>${item.autoApplyReady ? "yes" : "no"}</td>
        <td>${escapeHtml(item.recommendation)}</td>
      </tr>
    `).join("");
    const evalById = new Map((evalPlan?.evaluations ?? []).map((item) => [item.id, item]));
    const candidateById = new Map((report.candidates ?? []).map((candidate) => [candidate.id, candidate]));
    const promotionCards = (promotionQueue?.items ?? []).slice(0, 12).map((item) => {
      const evaluation = evalById.get(item.evalId);
      const decisionOpen = item.status === "pending" || item.status === "deferred";
      const outcomeCandidate = candidateById.get(item.candidateId);
      const outcomeSummary = outcomeCandidate
        ? outcomeCandidate.outcomeEvidence
          ? `Outcome weight ${outcomeCandidate.outcomeWeight.toFixed(2)} from ${outcomeCandidate.outcomeEvidence.approvals} approval(s) and ${outcomeCandidate.outcomeEvidence.rejections} rejection(s) for pattern ${outcomeCandidate.patternId}.`
          : `Outcome weight ${outcomeCandidate.outcomeWeight.toFixed(2)}: no owner decisions recorded for pattern ${outcomeCandidate.patternId} yet (neutral cold start).`
        : `Outcome pattern ${item.patternId ?? "unknown"} (candidate not in the current report).`;
      return `<article class="panel nested-panel">
        <div class="section-heading">
          <div><h3>${escapeHtml(item.displayName)}</h3><span class="muted">${escapeHtml(item.agentId)} · ${escapeHtml(item.id)}</span></div>
          <span class="flag ${item.status === "approved" || item.status === "applied" ? "good" : item.status === "pending" || item.status === "deferred" ? "queued" : "warn"}">${escapeHtml(item.status)} · ${item.score}/100</span>
        </div>
        <div class="meta-grid compact">
          <div><strong>Holdout coverage</strong>${evaluation?.holdoutTasks.length ?? 0} task(s)</div>
          <div><strong>Readiness</strong>${item.promotionReady ? "promotion ready" : "not ready"}</div>
          <div><strong>Policy</strong>${escapeHtml(item.scope)} · ${escapeHtml(item.priority)} priority · ${escapeHtml(item.riskLevel)} risk</div>
          <div><strong>Approval</strong>${item.approvalRequired ? "owner required" : "policy eligible"}</div>
          <div><strong>Auto apply</strong>${item.autoApplyReady ? "eligible" : "disabled"}</div>
          <div><strong>Source current</strong>${item.rollback.sourceHashCurrent ? "yes" : "no"}</div>
          <div><strong>Source</strong><code>${escapeHtml(item.sourcePath)}</code></div>
          <div><strong>Source hash</strong><code>${escapeHtml(item.sourceHash.slice(0, 16))}</code></div>
          <div><strong>Rollback</strong><code>${escapeHtml(item.rollback.restorePath)}</code> · <code>${escapeHtml(item.rollback.restoreSourceHash.slice(0, 16))}</code></div>
        </div>
        <p>${escapeHtml(item.recommendation)}</p>
        <p class="muted">${escapeHtml(item.rationale)}</p>
        <p class="muted">Outcome signal: ${escapeHtml(outcomeSummary)}</p>
        ${evaluation?.holdoutTasks.length ? `<details><summary>Holdout evidence (${evaluation.holdoutTasks.length})</summary><ul>${evaluation.holdoutTasks.map((task) => `<li><strong>${escapeHtml(task.workflowId)}</strong> · ${escapeHtml(task.status)} · ${escapeHtml(task.evidence)}</li>`).join("")}</ul></details>` : ""}
        <details><summary>Proposed source change</summary><pre>${escapeHtml(item.diff)}</pre></details>
        ${decisionOpen ? `<form method="post" action="/api/agent-improvement-promotion-decision" class="inline-action-form">
          <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
          <input type="hidden" name="promotionId" value="${escapeHtml(item.id)}">
          <input type="hidden" name="returnTo" value="/learning?project=${encodeURIComponent(report.projectRootUri)}&view=agent-improvements">
          <label>Decision note <input name="note" placeholder="Optional review note"></label>
          <button type="submit" name="decision" value="approved">Approve</button>
          <button type="submit" name="decision" value="deferred" class="secondary">Defer</button>
          <button type="submit" name="decision" value="deferred" class="secondary">Reject</button>
        </form>` : `<p class="muted">Decision: <span class="flag ${item.status === "approved" || item.status === "applied" ? "good" : "warn"}">${escapeHtml(item.status.charAt(0).toUpperCase() + item.status.slice(1))}</span>${item.reviewer ? ` by ${escapeHtml(item.reviewer)}` : ""}${item.decidedAt ? ` &middot; ${escapeHtml(new Date(item.decidedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}` : ""}${item.note ? ` &mdash; &ldquo;${escapeHtml(item.note)}&rdquo;` : ""}</p>`}
      </article>`;
    }).join("");
    const candidateRows = report.candidates.map((candidate) => `
      <tr>
        <td>${escapeHtml(candidate.agentId)}<br><span class="muted">${escapeHtml(candidate.displayName)} · ${escapeHtml(candidate.scope)}</span></td>
        <td><span class="flag ${candidate.priority === "high" ? "warn" : candidate.priority === "medium" ? "queued" : "good"}">${escapeHtml(candidate.priority)}</span><br><span class="muted">${escapeHtml(candidate.riskLevel)} risk</span></td>
        <td>${escapeHtml(candidate.recommendation)}<br><span class="muted">${escapeHtml(candidate.evidence.join(" "))}</span></td>
        <td>${candidate.suggestedMutableFields.map((field) => `<code>${escapeHtml(field)}</code>`).join(" ") || "n/a"}</td>
        <td>${candidate.autoApplyEligible ? "yes" : "approval"}</td>
      </tr>
    `).join("");
    const automatic = report.autonomyBoundary.automatic.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    const gated = report.autonomyBoundary.approvalRequired.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    const ownedFiles = report.ownedLearningFiles.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join("");
    return `
      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>Agent Definition Improvement</h2>
            <span class="muted">${report.agentsAnalyzed} agent(s) analyzed · ${report.candidates.length} candidate(s) · local-first research prompts only</span>
          </div>
          <a class="button secondary" href="${escapeHtml(evalHref)}">Eval JSON</a>
          <a class="button secondary" href="${escapeHtml(promotionHref)}">Promotion JSON</a>
          <a class="button secondary" href="${escapeHtml(patchHref)}">Patch JSON</a>
          <a class="button secondary" href="/api/agent-improvement-report?project=${encodeURIComponent(report.projectRootUri)}&limit=${encodeURIComponent(String(report.limit))}">JSON</a>
        </div>
        <div class="metric-grid">
          ${metricCard("Candidates", report.candidates.length, "agent-card improvements")}
          ${metricCard("Auto Eligible", report.candidates.filter((item) => item.autoApplyEligible).length, "project-local low/medium only")}
          ${metricCard("Shared Agents", report.evidenceSummary.sharedAgents, "approval to edit")}
          ${metricCard("Local Agents", report.evidenceSummary.projectLocalAgents, "may be autonomous")}
          ${metricCard("Failed Runs", report.evidenceSummary.failedRuns, "evidence window")}
          ${metricCard("Workflow Refs", report.evidenceSummary.workflowReferences, "stage/subagent slots")}
          ${metricCard("Eval Pass", evalPlan?.evaluations.filter((item) => item.status === "pass").length ?? 0, "promotion-ready scoring")}
          ${metricCard("Promotions", promotionQueue?.items.length ?? 0, `${promotionQueue?.items.filter((item) => item.status === "pending").length ?? 0} pending`)}
        </div>
        <p class="muted">Refresh owned learning artifacts with <code>${escapeHtml(command)}</code>. Generate exact YAML previews with <code>${escapeHtml(patchCommand)}</code>. Score holdout promotion gates with <code>${escapeHtml(evalCommand)}</code>. Create promotion receipts with <code>${escapeHtml(promotionCommand)}</code>. Apply approved YAML with <code>${escapeHtml(applyCommand)}</code>; source hashes, schema validation, risk threshold, and rollback receipts still gate the write.</p>
        <div class="split-grid">
          <div><h3>Automatic</h3><ul>${automatic}</ul></div>
          <div><h3>Requires Approval</h3><ul>${gated}</ul></div>
        </div>
        <div class="split-grid">
          <div><h3>Owned Files</h3><ul>${ownedFiles}</ul></div>
          <div><h3>Privacy</h3><ul>${report.privacyBoundaries.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Agent</th><th>Priority</th><th>Recommendation</th><th>Fields</th><th>Apply</th></tr></thead><tbody>${candidateRows || "<tr><td colspan=\"5\">No agent definition improvement candidates found.</td></tr>"}</tbody></table></div>
        <h3>Holdout Eval Scores</h3>
        <div class="table-wrap"><table><thead><tr><th>Agent</th><th>Status</th><th>Holdout</th><th>Promote</th><th>Auto</th><th>Recommendation</th></tr></thead><tbody>${evalRows || "<tr><td colspan=\"6\">No holdout eval scores generated yet.</td></tr>"}</tbody></table></div>
        <h3>Promotion Queue</h3>
        ${promotionCards || '<p class="muted">No promotion-ready agent patches queued yet.</p>'}
      </section>
    `;
  }

  function renderCandidateComparisonReportHtml(report: DashboardCandidateComparisonReport): string {
    const comparison = report.comparisonPlan;
    const history = report.modelHistory;
    const chartModels = history.models.slice(0, 12);
    const formatDatetimeLocal = (iso: string | null): string => {
      if (!iso) return "";
      const date = new Date(iso);
      const pad = (value: number) => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    const historyColors = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0891b2", "#be123c", "#4f46e5", "#65a30d", "#a16207", "#0f766e", "#7e22ce"];
    const historyLineChart = (metric: "quality" | "latency") => {
      const chartKeys = new Set(chartModels.map((model) => model.key));
      const measured = history.points.filter((point) => chartKeys.has(point.key) && (metric === "quality" ? point.averageQuality !== null : point.averageLatencyMs !== null));
      if (!measured.length) return `<div class="chart-empty"><strong>No measured ${metric} history in this range</strong><span>Change the range or run scored model routes.</span></div>`;
      const width = 900, height = 360, left = 58, right = 24, top = 30, bottom = 54;
      const times = measured.map((point) => Date.parse(point.bucketStart));
      const measuredMinTime = Math.min(...times), measuredMaxTime = Math.max(...times);
      const selectedMinTime = history.windowFrom ? Date.parse(history.windowFrom) : measuredMinTime;
      const selectedMaxTime = history.windowTo ? Date.parse(history.windowTo) : measuredMaxTime;
      const minTime = Number.isFinite(selectedMinTime) ? selectedMinTime : measuredMinTime;
      const maxTime = Number.isFinite(selectedMaxTime) && selectedMaxTime > minTime ? selectedMaxTime : measuredMaxTime;
      const values = measured.map((point) => metric === "quality" ? point.averageQuality! : point.averageLatencyMs!);
      const minValue = metric === "quality" ? 0 : Math.min(0, ...values);
      const maxValue = Math.max(metric === "quality" ? 1 : 1, ...values);
      const x = (time: number) => left + (maxTime === minTime ? 0.5 : (time - minTime) / (maxTime - minTime)) * (width - left - right);
      const y = (value: number) => top + (1 - (value - minValue) / Math.max(0.001, maxValue - minValue)) * (height - top - bottom);
      const series = chartModels.map((model, index) => {
        const points = measured.filter((point) => point.key === model.key).sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
        const coordinates = points.map((point) => `${x(Date.parse(point.bucketStart))},${y(metric === "quality" ? point.averageQuality! : point.averageLatencyMs!)}`).join(" ");
        const dots = points.map((point) => {
          const value = metric === "quality" ? point.averageQuality! : point.averageLatencyMs!;
          return `<circle cx="${x(Date.parse(point.bucketStart))}" cy="${y(value)}" r="4" fill="${historyColors[index % historyColors.length]}"><title>${escapeHtml(model.key)} · ${renderDashboardDateTime(point.bucketStart)} · ${metric === "quality" ? value.toFixed(3) : formatDuration(value)} · ${point.samples} route${point.samples === 1 ? "" : "s"}</title></circle>`;
        }).join("");
        return `${points.length > 1 ? `<polyline points="${coordinates}" fill="none" stroke="${historyColors[index % historyColors.length]}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>` : ""}${dots}`;
      }).join("");
      const legend = chartModels.map((model, index) => `<span class="model-legend-item"><i style="background:${historyColors[index % historyColors.length]}"></i>${escapeHtml(model.key)}</span>`).join("");
      const formatTick = (timestamp: number) => new Intl.DateTimeFormat("en-US", history.bucket === "minute" || history.bucket === "hour"
        ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
        : history.bucket === "month" ? { month: "short", year: "2-digit" } : { month: "short", day: "numeric" }).format(new Date(timestamp));
      const ticks = Array.from({ length: 5 }, (_, index) => {
        const timestamp = minTime + (maxTime - minTime) * index / 4;
        const tickX = x(timestamp);
        return `<line x1="${tickX}" y1="${height - bottom}" x2="${tickX}" y2="${height - bottom + 6}" class="chart-axis"/><text x="${tickX}" y="${height - 28}" text-anchor="${index === 0 ? "start" : index === 4 ? "end" : "middle"}" class="chart-label">${escapeHtml(formatTick(timestamp))}</text>`;
      }).join("");
      return `<div class="model-history-chart"><svg class="comparison-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="All models ${metric} over time"><line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}" class="chart-axis"/><line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" class="chart-axis"/>${ticks}<text x="8" y="${top + 8}" class="chart-label">${metric === "quality" ? maxValue.toFixed(2) : formatDuration(maxValue)}</text><text x="8" y="${height - bottom}" class="chart-label">${metric === "quality" ? minValue.toFixed(2) : "0ms"}</text>${series}</svg><div class="model-legend">${legend}</div></div>`;
    };
    const modelRows = history.models.map((model) => `<tr><td><strong>${escapeHtml(model.model)}</strong><br><span class="muted">${escapeHtml(model.provider)} · ${escapeHtml(model.modelTier)}</span></td><td>${formatNumber(model.samples)}</td><td>${formatNumber(model.qualitySamples)}</td><td>${model.averageQuality === null ? "n/a" : model.averageQuality.toFixed(3)}</td><td>${formatNumber(model.latencySamples)}</td><td>${model.averageLatencyMs === null ? "n/a" : formatDuration(model.averageLatencyMs)}</td><td>${Math.round(model.fallbackRate * 100)}%</td><td>${renderDashboardDateTime(model.latestAt)}</td></tr>`).join("");
    const chartOutcomes = report.outcomes.filter((item) => item.baselineQuality !== null || item.candidateQuality !== null || item.baselineLatencyMs !== null || item.candidateLatencyMs !== null);
    const pairedBarChart = (metric: "quality" | "latency") => {
      const rows = chartOutcomes.slice(0, 10);
      if (!rows.length) return `<div class="chart-empty"><strong>No measured ${metric} data yet</strong><span>Run both variants to populate this chart.</span></div>`;
      const width = 760;
      const rowHeight = 48;
      const height = 54 + rows.length * rowHeight;
      const plotLeft = 190;
      const plotWidth = 500;
      const values = rows.flatMap((item) => metric === "quality" ? [item.baselineQuality, item.candidateQuality] : [item.baselineLatencyMs, item.candidateLatencyMs]).filter((value): value is number => value !== null);
      const max = metric === "quality" ? Math.max(1, ...values) : Math.max(1, ...values);
      const bars = rows.map((item, index) => {
        const baseline = metric === "quality" ? item.baselineQuality : item.baselineLatencyMs;
        const candidate = metric === "quality" ? item.candidateQuality : item.candidateLatencyMs;
        const y = 40 + index * rowHeight;
        const bar = (value: number | null, offset: number, color: string) => value === null ? "" : `<rect x="${plotLeft}" y="${y + offset}" width="${Math.max(2, (value / max) * plotWidth)}" height="12" rx="6" fill="${color}"><title>${metric === "quality" ? value.toFixed(3) : formatDuration(value)}</title></rect><text x="${Math.min(width - 52, plotLeft + (value / max) * plotWidth + 7)}" y="${y + offset + 10}" class="chart-value">${metric === "quality" ? value.toFixed(2) : `${Math.round(value)}ms`}</text>`;
        return `<text x="8" y="${y + 19}" class="chart-label">${escapeHtml(item.suiteId.length > 24 ? `${item.suiteId.slice(0, 23)}…` : item.suiteId)}</text>${bar(baseline, 2, "#94a3b8")}${bar(candidate, 20, "#2563eb")}`;
      }).join("");
      return `<svg class="comparison-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Baseline and candidate ${metric} by suite"><g><text x="${plotLeft}" y="20" class="chart-legend">■ Baseline</text><text x="${plotLeft + 105}" y="20" class="chart-legend chart-candidate">■ Candidate</text>${bars}</g></svg>`;
    };
    const tradeoffChart = (() => {
      const points = chartOutcomes.filter((item) => item.qualityDelta !== null && item.latencyDeltaMs !== null).slice(0, 20);
      if (!points.length) return `<div class="chart-empty"><strong>No quality/latency tradeoff yet</strong><span>Paired evaluation results will appear here.</span></div>`;
      const width = 760, height = 330, left = 70, top = 28, plotWidth = 620, plotHeight = 240;
      const maxQuality = Math.max(0.05, ...points.map((item) => Math.abs(item.qualityDelta ?? 0)));
      const maxLatency = Math.max(100, ...points.map((item) => Math.abs(item.latencyDeltaMs ?? 0)));
      const x = (value: number) => left + plotWidth / 2 + (value / maxLatency) * plotWidth / 2;
      const y = (value: number) => top + plotHeight / 2 - (value / maxQuality) * plotHeight / 2;
      const dots = points.map((item) => `<circle cx="${x(item.latencyDeltaMs ?? 0)}" cy="${y(item.qualityDelta ?? 0)}" r="8" fill="${(item.qualityDelta ?? 0) >= 0 && (item.latencyDeltaMs ?? 0) <= 0 ? "#16a34a" : (item.qualityDelta ?? 0) < 0 ? "#dc2626" : "#f59e0b"}" opacity="0.9"><title>${escapeHtml(item.suiteId)}: quality ${item.qualityDelta}, latency ${item.latencyDeltaMs}ms</title></circle>`).join("");
      return `<svg class="comparison-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Quality gain against latency change"><rect x="${left}" y="${top}" width="${plotWidth / 2}" height="${plotHeight / 2}" fill="#dcfce7" opacity="0.55"/><line x1="${left + plotWidth / 2}" y1="${top}" x2="${left + plotWidth / 2}" y2="${top + plotHeight}" class="chart-axis"/><line x1="${left}" y1="${top + plotHeight / 2}" x2="${left + plotWidth}" y2="${top + plotHeight / 2}" class="chart-axis"/>${dots}<text x="${left}" y="${height - 28}" class="chart-label">← faster</text><text x="${left + plotWidth - 38}" y="${height - 28}" class="chart-label">slower →</text><text x="8" y="${top + 8}" class="chart-label">better</text><text x="8" y="${top + plotHeight}" class="chart-label">worse</text><text x="${left + 12}" y="${top + 22}" class="chart-good-label">Best zone: faster + higher quality</text></svg>`;
    })();
    const suiteRows = comparison?.suites.map((suite) => {
      const file = report.suiteFiles.find((item) => item.path === suite.suitePath);
      const outcome = report.outcomes.find((item) => item.suiteId === suite.id);
      return `
        <tr>
          <td>${escapeHtml(suite.id)}</td>
          <td>${escapeHtml(suite.workflowId)}</td>
          <td>${formatNumber(suite.caseCount)}</td>
          <td><code>${escapeHtml(suite.suitePath)}</code></td>
          <td><span class="status ${file?.exists ? "completed" : "queued"}">${file?.exists ? "present" : "missing"}</span></td>
          <td>${outcome?.runs ?? 0}</td>
          <td>${outcome?.gateReady ? '<span class="flag good">ready</span>' : '<span class="flag warn">not yet</span>'}</td>
        </tr>
      `;
    }).join("") ?? "";
    const outcomeRows = report.outcomes.map((outcome) => `
      <tr>
        <td>${escapeHtml(outcome.suiteId)}</td>
        <td>${escapeHtml(outcome.leader ?? "none")}</td>
        <td>${outcome.baselineRuns}</td>
        <td>${outcome.candidateRuns}</td>
        <td>${outcome.baselineQuality ?? "n/a"}</td>
        <td>${outcome.candidateQuality ?? "n/a"}</td>
        <td>${outcome.qualityDelta ?? "n/a"}</td>
        <td>${outcome.latencyDeltaMs === null ? "n/a" : formatDurationDelta(outcome.latencyDeltaMs)}</td>
        <td>${outcome.latestAt ? renderDashboardDateTime(outcome.latestAt) : "n/a"}</td>
      </tr>
    `).join("");
    const recommendationRows = report.promotionRecommendations.map((recommendation) => `
      <tr>
        <td>${escapeHtml(recommendation.suiteId)}</td>
        <td><span class="flag ${recommendation.severity === "ready" ? "good" : recommendation.severity === "warning" ? "warn" : "queued"}">${escapeHtml(recommendation.decision.replace(/_/g, " "))}</span></td>
        <td><ul>${recommendation.rationale.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></td>
        <td>${recommendation.nextAction.includes("npm run ") ? `<code>${escapeHtml(recommendation.nextAction)}</code>` : escapeHtml(recommendation.nextAction)}</td>
      </tr>
    `).join("");
    const promotionFileRows = report.promotionNoteFiles.map((file) => `
      <tr>
        <td><code>${escapeHtml(file.path)}</code></td>
        <td><span class="status ${file.exists && !file.error ? "completed" : file.error ? "failed" : "queued"}">${file.exists && !file.error ? "present" : file.error ? "error" : "missing"}</span></td>
        <td>${file.exists ? formatNumber(file.bytes) : "n/a"}</td>
        <td>${file.modifiedAt ? renderDashboardDateTime(file.modifiedAt) : "n/a"}</td>
        <td>${file.error ? escapeHtml(file.error) : file.preview ? "preview below" : "n/a"}</td>
      </tr>
    `).join("");
    const promotionMarkdownPreview = report.promotionNoteFiles.find((file) => file.path.endsWith(".md") && file.preview)?.preview ?? "";
    const commandRows = report.nextCommands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
    const gateRows = comparison?.gateCommands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("") ?? "";
    const gateReadyCount = report.outcomes.filter((outcome) => outcome.gateReady).length;
    const recommendationReadyCount = report.promotionRecommendations.filter((recommendation) => recommendation.decision === "propose_routing_note").length;
    return `
      <section class="panel">
        <div class="metric-grid candidate-summary-grid">
          ${metricCard("Model Plan", report.modelPlanExists && !report.modelPlanError ? "ready" : "missing", report.modelPlanError ?? ".agent-workflow/model-improvement")}
          ${metricCard("Comparison Plan", report.comparisonPlanExists && !report.comparisonPlanError ? "ready" : "missing", report.comparisonPlanError ?? "candidate-comparison-plan.json")}
          ${metricCard("Eval Cases", report.modelPlan?.evalCases.length ?? 0, "from approved feedback")}
          ${metricCard("Suites", comparison?.suites.length ?? 0, "generated private eval files")}
          ${metricCard("Suite Files", `${report.suiteFiles.filter((suite) => suite.exists).length}/${report.suiteFiles.length}`, "present")}
          ${metricCard("Gate Ready", `${gateReadyCount}/${report.outcomes.length}`, "baseline and candidate runs")}
          ${metricCard("Promotable", `${recommendationReadyCount}/${report.promotionRecommendations.length}`, "reviewed routing note")}
          ${metricCard("Generated", formatDashboardDateTimeText(report.generatedAt), "local read")}
        </div>
        <p class="muted">Project ${escapeHtml(report.projectDir)}.</p>
      </section>
      <section class="panel">
        <h2>Readiness</h2>
        <ul>${report.readiness.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        ${localHoldoutComparisonForm(report)}
      </section>
      ${renderLocalHoldoutRoutingStatusHtml(report.localHoldoutRouting)}
      ${renderLocalRouteDecisionDrilldownHtml(report.routeReceiptTrends, report.localHoldoutRouting)}
      ${renderRouteReceiptTrendsHtml(report.routeReceiptTrends)}
      <section class="panel comparison-visuals">
        <div class="section-heading"><div><h2>Fleet model history</h2><span class="muted">All observed model routes in the selected project and retained time range. Quality uses scored stages; speed uses measured stage latency.</span></div><span class="flag ${history.samples ? "good" : "warn"}">${history.samples} route sample${history.samples === 1 ? "" : "s"}</span></div>
        <form method="get" class="model-history-controls" aria-label="Model history date range">
          <input type="hidden" name="project" value="${escapeHtml(report.projectDir)}">
          <label>Resolution<select name="bucket">${["minute", "hour", "day", "week", "month"].map((value) => `<option value="${value}"${history.bucket === value ? " selected" : ""}>${value}</option>`).join("")}</select></label>
          <label>Quick range<select name="range" onchange="this.form.elements.from.value='';this.form.elements.to.value=''">${[["1h", "1 hour"], ["6h", "6 hours"], ["24h", "24 hours"], ["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"], ["180d", "6 months"], ["365d", "12 months"], ["all", "All retained"]].map(([value, label]) => `<option value="${value}"${history.range === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>
          <label>From<input type="datetime-local" name="from" value="${escapeHtml(formatDatetimeLocal(history.windowFrom))}" min="${escapeHtml(formatDatetimeLocal(history.availableFrom))}" max="${escapeHtml(formatDatetimeLocal(history.windowTo))}"></label>
          <label>To<input type="datetime-local" name="to" value="${escapeHtml(formatDatetimeLocal(history.windowTo))}" min="${escapeHtml(formatDatetimeLocal(history.availableFrom))}"></label>
          <button type="submit">Apply range</button>
          <a class="button secondary" href="/candidate-comparisons?project=${encodeURIComponent(report.projectDir)}&bucket=${encodeURIComponent(history.bucket)}&range=all">Reset</a>
        </form>
        <div class="chart-grid model-history-grid"><article class="chart-card"><h3>Quality over time</h3><p class="muted">Higher is better · ${escapeHtml(history.bucket)} buckets.</p>${historyLineChart("quality")}</article><article class="chart-card"><h3>Speed over time</h3><p class="muted">Lower latency is better · ${escapeHtml(history.bucket)} buckets.</p>${historyLineChart("latency")}</article></div>
        ${history.models.length > chartModels.length ? `<p class="muted">Charts show the ${chartModels.length} most-observed model routes for legibility. The table compares all ${history.models.length} observed model routes.</p>` : ""}
        <div class="table-wrap"><table><thead><tr><th>Model</th><th>Routes</th><th>Quality samples</th><th>Avg quality</th><th>Latency samples</th><th>Avg latency</th><th>Fallback</th><th>Latest</th></tr></thead><tbody>${modelRows || '<tr><td colspan="8">No model-route evidence exists in this range.</td></tr>'}</tbody></table></div>
        <p class="muted">Available evidence: ${renderDashboardDateTime(history.availableFrom, "none")} to ${renderDashboardDateTime(history.availableTo, "none")}. Routes without a recorded concrete model are labeled with their provider and model tier.</p>
      </section>
      <section class="panel">
        <h2>Variants</h2>
        ${comparison ? `
          <div class="meta-grid compact">
            <div><strong>Baseline</strong>${escapeHtml(comparison.baseline.provider)} / ${escapeHtml(comparison.baseline.modelTier)}<br><span class="muted">${escapeHtml(comparison.baseline.promptSuffix)}</span></div>
            <div><strong>Candidate</strong>${escapeHtml(comparison.candidate.provider)} / ${escapeHtml(comparison.candidate.modelTier)}<br><span class="muted">${escapeHtml(comparison.candidate.promptSuffix)}</span></div>
          </div>
        ` : '<p class="muted">No candidate comparison plan found.</p>'}
      </section>
      <section class="panel comparison-visuals">
        <div class="section-heading"><div><h2>Model Comparison</h2><span class="muted">Measured quality, speed, and the tradeoff between them. Hover points and bars for exact values.</span></div><span class="flag ${gateReadyCount ? "good" : "warn"}">${gateReadyCount ? `${gateReadyCount} paired suite${gateReadyCount === 1 ? "" : "s"}` : "needs paired runs"}</span></div>
        <div class="chart-grid"><article class="chart-card"><h3>Quality by suite</h3><p class="muted">Higher is better.</p>${pairedBarChart("quality")}</article><article class="chart-card"><h3>Latency by suite</h3><p class="muted">Lower is better.</p>${pairedBarChart("latency")}</article></div>
        <article class="chart-card"><h3>Quality–speed tradeoff</h3><p class="muted">The upper-left zone identifies candidates that improve quality while responding faster.</p>${tradeoffChart}</article>
      </section>
      <section class="panel">
        <h2>Suites</h2>
        <div class="table-wrap"><table><thead><tr><th>Suite</th><th>Workflow</th><th>Cases</th><th>Path</th><th>File</th><th>Runs</th><th>Gate</th></tr></thead><tbody>${suiteRows || "<tr><td colspan=\"7\">No suites generated.</td></tr>"}</tbody></table></div>
      </section>
      <section class="panel">
        <h2>Outcomes</h2>
        <div class="table-wrap"><table><thead><tr><th>Suite</th><th>Leader</th><th>Baseline Runs</th><th>Candidate Runs</th><th>Baseline Quality</th><th>Candidate Quality</th><th>Quality Delta</th><th>Latency Delta</th><th>Latest</th></tr></thead><tbody>${outcomeRows || "<tr><td colspan=\"9\">No evaluation outcomes yet.</td></tr>"}</tbody></table></div>
        ${localHoldoutResultsForm(report)}
      </section>
      <section class="panel">
        <h2>Promotion Recommendation</h2>
        <div class="table-wrap"><table><thead><tr><th>Suite</th><th>Decision</th><th>Rationale</th><th>Next Action</th></tr></thead><tbody>${recommendationRows || "<tr><td colspan=\"4\">No comparison outcomes available yet.</td></tr>"}</tbody></table></div>
        ${promotionNotePlanForm(report)}
        ${localHoldoutPromotionForm(report)}
      </section>
      <section class="panel">
        <h2>Promotion Note Files</h2>
        <div class="table-wrap"><table><thead><tr><th>Path</th><th>Status</th><th>Bytes</th><th>Modified</th><th>Preview</th></tr></thead><tbody>${promotionFileRows}</tbody></table></div>
        ${promotionMarkdownPreview ? `<h3>Markdown Preview</h3><pre>${escapeHtml(promotionMarkdownPreview)}</pre>` : '<p class="muted">No written promotion note plan yet. Preview or write one from a promotable recommendation.</p>'}
      </section>
      <section class="panel">
        <h2>Promotion Gates</h2>
        <ul>${gateRows || "<li>Run baseline and candidate evaluations before promotion.</li>"}</ul>
      </section>
      <section class="panel">
        <h2>Next Commands</h2>
        <ul>${commandRows}</ul>
      </section>
    `;
  }

  function renderCandidateComparisonsHtml(
    report: DashboardCandidateComparisonReport | null,
    projects: DashboardProjectSummary[],
    params: URLSearchParams
  ): string {
    const selectedProject = report?.projectDir ?? params.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT ?? "";
    const selectedBucket = report?.modelHistory.bucket ?? params.get("bucket") ?? "day";
    const selectedRange = report?.modelHistory.range ?? params.get("range") ?? "90d";
    const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}">${escapeHtml(project.name)} - ${escapeHtml(project.rootUri)}</option>`).join("");
    const jsonHref = report ? `/api/candidate-comparisons?project=${encodeURIComponent(report.projectDir)}&bucket=${encodeURIComponent(selectedBucket)}&range=${encodeURIComponent(selectedRange)}` : "";
    const body = report
      ? renderCandidateComparisonReportHtml(report)
      : `<section class="panel"><h2>No Project Selected</h2><p class="muted">Run onboarding or enter a project path to inspect local candidate comparison evidence.</p></section>`;
    return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent Workflow Candidate Comparisons</title>
    <style>${dashboardCss()}</style>
  </head>
  <body>
    ${dashboardNav("candidate-comparisons")}
    <main id="main-content">
      <div class="topbar">
        <div>
          <a href="/">Dashboard</a>
          <h1>Candidate Comparisons</h1>
          <p class="muted">Read-only local visibility for model-improvement comparison suites, baseline/candidate variants, and promotion gates.</p>
        </div>
        ${jsonHref ? `<a class="button secondary" href="${escapeHtml(jsonHref)}">JSON</a>` : ""}
      </div>
      <section class="panel">
        <form method="get" class="workflow-form">
          <label class="wide">Project path
            <input name="project" value="${escapeHtml(selectedProject)}" list="candidate-comparison-projects" placeholder="/path/to/project">
            <datalist id="candidate-comparison-projects">${projectOptions}</datalist>
          </label>
          <label>Time bucket<select name="bucket">${["minute", "hour", "day", "week", "month"].map((value) => `<option value="${value}"${selectedBucket === value ? " selected" : ""}>${value}</option>`).join("")}</select></label>
          <label>History range<select name="range">${[["1h", "1 hour"], ["6h", "6 hours"], ["24h", "24 hours"], ["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"], ["180d", "6 months"], ["365d", "12 months"], ["all", "All retained"]].map(([value, label]) => `<option value="${value}"${selectedRange === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>
          <div class="form-actions"><button type="submit">Inspect</button></div>
        </form>
      </section>
      ${body}
    </main>
  </body>
  </html>`;
  }

  function renderDaemonLanes(supervisor: DashboardSupervisorStatus, daemon: DashboardLearningDaemonStatus | null): string {
    const lanes = [
      ["Supervisor", supervisor.status === "running", `${formatNumber(supervisor.ticks)} ticks`],
      ["Worker", supervisor.workerManaged, supervisor.workerManaged ? "managed" : "external"],
      ["Learning", daemon?.status === "running", daemon?.mode ?? supervisor.learningMode ?? "disabled"],
      ["Dashboard", supervisor.dashboardManaged, supervisor.dashboardManaged ? "managed" : "external"]
    ] as const;
    return `<div class="ops-daemon-lanes">${lanes.map(([label, active, detail]) => `<div><i class="${active ? "active" : "idle"}"></i><span><strong>${label}</strong><small>${escapeHtml(detail)}</small></span></div>`).join("")}</div><div class="ops-daemon-trust"><span>Autonomy ceiling</span><strong>${escapeHtml(daemon?.autonomousApplyMaxRisk ?? "none")}</strong></div>`;
  }

  function renderDaemonMonitor(supervisor: DashboardSupervisorStatus, daemon: DashboardLearningDaemonStatus | null, receipts: LearningActionReceiptLog | null): string {
    const events = [...(receipts?.events ?? [])].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(-24);
    const buckets = new Map<string, { label: string; applied: number; planned: number; other: number }>();
    for (const event of events) {
      const date = new Date(event.createdAt);
      const key = event.createdAt.slice(0, 10);
      const bucket = buckets.get(key) ?? { label: Number.isFinite(date.getTime()) ? date.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : key, applied: 0, planned: 0, other: 0 };
      if (event.status === "applied") bucket.applied += 1;
      else if (event.status === "planned") bucket.planned += 1;
      else bucket.other += 1;
      buckets.set(key, bucket);
    }
    const points = [...buckets.values()].slice(-10);
    const max = Math.max(...points.map((item) => item.applied + item.planned + item.other), 1);
    const bars = points.map((item) => {
      const total = item.applied + item.planned + item.other;
      return `<div class="ops-daemon-column"><div class="ops-daemon-stack" style="height:${Math.max(8, (total / max) * 100)}%"><i class="applied" style="--share:${item.applied}"></i><i class="planned" style="--share:${item.planned}"></i><i class="other" style="--share:${item.other}"></i></div><span>${escapeHtml(item.label)}</span></div>`;
    }).join("");
    const status = daemon?.status ?? supervisor.status;
    const lastCycle = daemon?.lastReportAt ?? daemon?.lastHeartbeatAt ?? supervisor.lastHeartbeatAt;
    return `<div class="ops-daemon-layout"><div class="ops-daemon-chart">${bars || '<div class="ops-empty"><strong>No daemon action receipts yet</strong><span>Heartbeat monitoring remains active.</span></div>'}</div><div class="ops-daemon-facts"><div><span>Status</span><strong class="${status === "running" ? "good-text" : "warn-text"}">${escapeHtml(status)}</strong></div><div><span>Cycles</span><strong>${formatNumber(daemon?.ticks ?? supervisor.ticks)}</strong></div><div><span>Last cycle</span><strong>${renderDashboardDateTime(lastCycle, "none")}</strong></div><div><span>Actions</span><strong>${formatNumber(events.length)}</strong></div></div></div><div class="ops-legend"><span><i class="daemon-applied"></i>Applied</span><span><i class="daemon-planned"></i>Planned</span><span><i class="daemon-other"></i>Closed</span></div>`;
  }

  /** Errors on API and asset paths stay plain text; page requests get the layout. */
  function finishDashboardPageError(request: http.IncomingMessage, response: http.ServerResponse): void {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const wantsPage = request.method === "GET" && !pathname.startsWith("/api/") && !pathname.startsWith("/assets/") && !pathname.endsWith(".json");
    let html: string | undefined;
    if (wantsPage) {
      try { html = renderDashboardStatusPage(500, "Something went wrong", "The dashboard could not load this page. The error was logged; try again, or go back to a page that works."); } catch { html = undefined; }
    }
    finishDashboardError(response, publicHttpError("Dashboard request failed."), html);
  }

  function renderDashboardHtml(runs: Awaited<ReturnType<typeof listWorkflowRuns>>, workflows: Awaited<ReturnType<typeof loadWorkflows>>, health: DashboardHomeHealth, throughput: WorkflowThroughputBucket[]): string {
    const activeRuns = runs.filter((run) => run.status === "queued" || run.status === "leased" || run.status === "running");
    const recentRuns = runs.filter((run) => run.status === "completed" || run.status === "failed").slice(0, 8);
    const humanInterventions = buildHumanInterventionItems({ pendingApprovals: health.pendingApprovals, approvedExecutableApprovals: health.approvedExecutableApprovals, queue: health.queue, workerStatus: health.worker.status, supervisorStatus: health.supervisor.status, mcpStatus: health.runtimeMonitor.mcpPipeline.status, missingServices: health.services.filter((service) => !service.reachable).map((service) => service.endpoint.name), learningDaemonError: health.learningDaemon?.lastError, approvalBacklogErrors: health.learningDaemon?.approvalBacklogErrors, approvalBacklogWarnings: health.learningDaemon?.approvalBacklogWarnings, agentImprovementPending: health.agentImprovementPendingPromotions });
    const failedRuns = health.queue.filter((item) => item.runStatus === "failed").length;
    const terminalRuns = runs.filter((run) => run.status === "completed" || run.status === "failed");
    const completedRuns = terminalRuns.filter((run) => run.status === "completed").length;
    const successRate = terminalRuns.length ? Math.round((completedRuns / terminalRuns.length) * 100) : 0;
    const durations = terminalRuns.map(dashboardRunDurationMs).filter((value): value is number => value !== null).sort((a, b) => a - b);
    const medianDuration = durations.length ? durations[Math.floor(durations.length / 2)] : null;
    const activeStageTasks = health.queue.reduce((sum, item) => sum + item.queuedTasks + item.runningTasks, 0);
    const activeProjects = health.projects.filter((project) => project.runCount > 0 || project.indexedFiles > 0).length;
    const servicesReady = health.services.filter((service) => service.reachable).length;
    const systemHealthy = servicesReady === health.services.length && health.worker.status === "running" && health.supervisor.status === "running" && failedRuns === 0;
    const interventionRows = humanInterventions.map((item) => `
      <a class="ops-approval-row" href="${escapeHtml(item.href)}">
        <span class="ops-status-dot ${item.severity}"></span>
        <span><strong>${escapeHtml(compactDashboardText(item.title, 52))}</strong><small>${escapeHtml(compactDashboardText(item.detail, 72))}</small></span>
        <span>${escapeHtml(item.action)}</span>
      </a>`).join("");
    const workAvailable = health.worker.status === "running" || health.supervisor.status === "running";
    const nowRow = (href: string, tone: string, title: string, detail: string, action: string) => `<a class="ops-now-row" href="${escapeHtml(href)}"><span class="ops-status-dot ${tone}"></span><span><strong>${escapeHtml(compactDashboardText(title, 80))}</strong><small>${escapeHtml(compactDashboardText(detail, 96))}</small></span><span>${escapeHtml(action)}</span></a>`;
    const runningNow = activeRuns.slice(0, 6).map((run) => nowRow(`/run?id=${run.id}`, workAvailable || run.status !== "queued" ? "good" : "warn", run.task, `${run.projectName} · ${workflowDisplayName(run.workflowId)} · ${run.status === "queued" && !workAvailable ? "waiting — no worker is running" : run.status}`, "Open")).join("");
    const troubledRuns = runs.filter((run) => run.status === "failed" || run.status === "blocked");
    const troubledNow = troubledRuns.slice(0, 6).map((run) => nowRow(`/run?id=${run.id}`, run.status === "failed" ? "bad" : "warn", run.task, `${run.projectName} · ${workflowDisplayName(run.workflowId)} · ${run.status}`, run.status === "failed" ? "Diagnose" : "Unblock")).join("");
    const needsYouNow = humanInterventions.slice(0, 6).map((item) => nowRow(item.href, item.severity, item.title, item.detail, item.action)).join("");
    const nowPanel = (id: string, title: string, count: number, rows: string, more: string, empty: string) => `<section class="ops-panel ops-now-panel" aria-labelledby="${id}"><div class="ops-panel-heading"><div><h2 id="${id}">${title} <span class="ops-now-count">${count}</span></h2></div>${more}</div><div class="ops-now-list">${rows || `<p class="ops-now-empty">${empty}</p>`}</div></section>`;
    const recentRows = recentRuns.map((run) => `
      <tr>
        <td><a href="/run?id=${encodeURIComponent(run.id)}">${escapeHtml(run.id.slice(0, 8))}</a></td>
        <td><strong>${escapeHtml(compactDashboardText(run.task, 54))}</strong><small>${escapeHtml(run.projectName)}</small></td>
        <td>${escapeHtml(workflowDisplayName(run.workflowId))}</td>
        <td><span class="ops-run-status ${escapeHtml(run.status)}"><i></i>${escapeHtml(run.status)}</span></td>
        <td>${escapeHtml(formatDashboardDuration(dashboardRunDurationMs(run)))}</td>
        <td>${renderDashboardDateTime(run.startedAt)}</td>
      </tr>`).join("");
    const workflowOptions = workflows
      .filter((workflow) => workflow.triggers.manual)
      .map((workflow) => `<option value="${escapeHtml(workflow.id)}">${escapeHtml(workflow.name)} (${escapeHtml(workflow.id)})</option>`)
      .join("");
    const defaultProject = process.env.AGENTFLOW_DASHBOARD_PROJECT ?? "templates/project";

    return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent Workflow Dashboard</title>
    <style>
      ${dashboardCss()}
    </style>
  </head>
  <body>
    ${dashboardNav("dashboard")}
    <main id="main-content" class="ops-home">
      <div class="ops-topbar">
        <div><h1>System Pulse</h1><p>Live operational view of agent execution, reliability, and flow.</p></div>
        <div class="ops-topbar-actions"><span class="ops-live"><i></i> Live</span><a class="button" href="#start-work">${dashboardIcon("play")} Start workflow</a></div>
      </div>
      <div class="ops-now-grid">
        ${nowPanel("now-needs-you", "Needs you", humanInterventions.length, needsYouNow, humanInterventions.length > 6 ? `<a href="#human-intervention">All ${humanInterventions.length}</a>` : `<a href="/approvals">Approvals</a>`, "Nothing needs you right now.")}
        ${nowPanel("now-running", "Running now", activeRuns.length, runningNow, `<a href="/queue">Queue</a>`, "Nothing is running.")}
        ${nowPanel("now-troubled", "Failed or blocked", troubledRuns.length, troubledNow, `<a href="/runs">All runs</a>`, "No recent failed or blocked runs.")}
      </div>
      <section class="ops-pulse-panel">
        <div class="ops-pulse-heading">
          <a class="ops-system-state ${systemHealthy ? "good" : "warn"}" href="/settings"><i></i><span><strong>${systemHealthy ? "All systems operational" : "System attention required"}</strong><small>${servicesReady}/${health.services.length} services · worker ${escapeHtml(health.worker.status)} · supervisor ${escapeHtml(health.supervisor.status)}</small></span>${dashboardIcon("chevrons")}</a>
        </div>
        <div class="ops-metric-row">
          ${renderOpsMetric("Recent runs", formatNumber(runs.length), `${activeRuns.length} active`, runs.map((_, index) => index + 1), "cyan")}
          ${renderOpsMetric("Success rate", `${successRate}%`, `${completedRuns}/${terminalRuns.length || 0} terminal`, terminalRuns.map((run) => run.status === "completed" ? 1 : 0), "teal")}
          ${renderOpsMetric("Median duration", formatDashboardDuration(medianDuration), `${durations.length} measured`, durations.slice(-10), "violet")}
          ${renderOpsMetric("Active stage tasks", formatNumber(activeStageTasks), `${health.queue.length} queue records`, health.queue.slice(0, 10).map((item) => item.queuedTasks + item.runningTasks), "cyan")}
          ${renderOpsMetric("Human intervention", formatNumber(humanInterventions.length), humanInterventions.length ? "action required" : "clear", [0, humanInterventions.filter((item) => item.severity === "warn").length, humanInterventions.filter((item) => item.severity === "bad").length], "amber", "#human-intervention")}
          ${renderOpsMetric("Active projects", formatNumber(activeProjects), `${health.projects.length} registered`, health.projects.slice(0, 10).map((project) => project.runCount), "violet")}
        </div>
      </section>
      <div class="ops-chart-grid">
        <section class="ops-panel ops-span-2"><div class="ops-panel-heading"><div><h2>Workflow throughput</h2><span>Runs by final state · rolling 7 days</span></div><a href="/runs">View runs</a></div>${renderOpsThroughputChart(throughput)}</section>
        <section class="ops-panel"><div class="ops-panel-heading"><div><h2>Run health</h2><span>Current state distribution</span></div></div>${renderOpsStatusChart(runs)}</section>
        <section class="ops-panel ops-span-2"><div class="ops-panel-heading"><div><h2>Execution duration</h2><span>Completed and failed run latency</span></div></div>${renderOpsDurationChart(terminalRuns)}</section>
        <section class="ops-panel"><div class="ops-panel-heading"><div><h2>Queue pressure</h2><span>Stage work and oldest active item</span></div><a href="/queue">Open queue</a></div>${renderOpsQueuePressure(health.queue)}</section>
        <section class="ops-panel ops-span-2"><div class="ops-panel-heading"><div><h2>Agent flow</h2><span>Current and next stage handoffs</span></div><a href="/workflow-graph">Open graph</a></div>${renderOpsAgentFlow(health.queue, runs, health.worker.status === "running" || health.supervisor.status === "running")}</section>
        <section class="ops-panel"><div class="ops-panel-heading"><div><h2>Project activity</h2><span>Runs across registered projects</span></div><a href="/projects">Projects</a></div>${renderOpsProjectActivity(health.projects)}</section>
        <section class="ops-panel ops-span-2 ops-daemon-panel"><div class="ops-panel-heading"><div><h2>Daemon monitor</h2><span>Learning cycles, autonomous actions, and heartbeat health</span></div><a href="/learning">Open learning</a></div>${renderDaemonMonitor(health.supervisor, health.learningDaemon, health.learningReceipts)}</section>
        <section class="ops-panel"><div class="ops-panel-heading"><div><h2>Daemon lanes</h2><span>Managed runtime responsibilities</span></div><a href="/settings">Settings</a></div>${renderDaemonLanes(health.supervisor, health.learningDaemon)}</section>
      </div>
      <div class="ops-lower-grid">
        <section class="ops-panel ops-runs-panel"><div class="ops-panel-heading"><div><h2>Recent runs</h2><span>Latest terminal workflow outcomes</span></div><a href="/runs">View all runs</a></div><div class="table-wrap"><table class="ops-table"><colgroup><col class="ops-col-run"><col class="ops-col-task"><col class="ops-col-workflow"><col class="ops-col-status"><col class="ops-col-duration"><col class="ops-col-started"></colgroup><thead><tr><th>Run</th><th>Task</th><th>Workflow</th><th>Status</th><th>Duration</th><th>Started</th></tr></thead><tbody>${recentRows || '<tr><td colspan="6">No terminal runs in the current window.</td></tr>'}</tbody></table></div></section>
        <section class="ops-panel ops-approvals-panel" id="human-intervention"><div class="ops-panel-heading"><div><h2>Human intervention</h2><span>Every decision, recovery, and runtime item requiring a person</span></div><a href="/approvals">Open approvals</a></div><div class="ops-approval-list" role="region" aria-label="Human intervention items" tabindex="0">${interventionRows || '<div class="ops-empty"><strong>No human intervention needed</strong><span>The system can continue autonomously.</span></div>'}</div></section>
      </div>
      <section class="ops-panel start-work" id="start-work">
        <div class="human-section-heading"><div><h2>Start work</h2><p>Describe the outcome. Agent Workflow will handle the execution details.</p></div></div>
        <form class="workflow-form human-composer" method="post" action="/api/workflow-run">
          <label>Project path
            <input name="project" value="${escapeHtml(defaultProject)}" placeholder="/path/to/project">
          </label>
          <label>Workflow
            <select name="workflowId">${workflowOptions}</select>
          </label>
          <label class="wide">What would you like done?
            <textarea name="task" rows="4" placeholder="Describe the outcome you want"></textarea>
          </label>
          <details class="advanced-options wide">
            <summary>Advanced options</summary>
            <div class="advanced-grid">
              <label>Context token budget<input name="sourceTokenBudget" inputmode="numeric" placeholder="3000"></label>
              <label>Maximum source files<input name="sourceMaxFiles" inputmode="numeric" placeholder="20"></label>
              <label>Maximum work items<input name="workerLimit" inputmode="numeric" value="6"></label>
              <label>Parallel work items<input name="workerConcurrency" inputmode="numeric" value="1"></label>
              <label>Watch timeout in milliseconds<input name="timeoutMs" inputmode="numeric" value="60000"></label>
              <label class="check-row"><input type="checkbox" name="watch"> Stay on this page while work starts</label>
            </div>
          </details>
          <div class="form-actions wide"><button type="submit">Start work</button></div>
        </form>
      </section>
    </main>
  </body>
  </html>`;
  }

  function renderDashboardProjectPathResolutionHtml(projectPath: DashboardProjectPathResolution): string {
    return `
      <section class="panel compact-panel">
        <div class="section-heading">
          <div>
            <h2>Project Path Mapping</h2>
            <span class="muted">Shared storage can keep a project under one host path while this machine uses another local checkout path.</span>
          </div>
          <span class="status ${projectPath.localPathExists ? "completed" : "queued"}">${projectPath.localPathExists ? projectPath.source : "not mounted"}</span>
        </div>
        <div class="meta-grid compact">
          <div><strong>Storage Root</strong>${escapeHtml(projectPath.storageRootUri)}</div>
          <div><strong>Local Root</strong>${escapeHtml(projectPath.localRootUri)}</div>
          <div><strong>Mapped</strong>${projectPath.mapped ? "yes" : "no"}</div>
          <div><strong>Local Path</strong>${projectPath.localPathExists ? "available" : "missing"}</div>
        </div>
        <p class="muted">${escapeHtml(projectPath.note)}</p>
      </section>
    `;
  }

  function renderEvaluationsHtml(suites: DashboardEvaluationSuite[], selected: DashboardEvaluationSuite | null, providerStatuses: Awaited<ReturnType<typeof loadAutoProviderStatuses>>): string { const testedProviders = new Set(suites.flatMap((suite) => suite.variants.map((variant) => variant.provider)));
    const providerRows = providerStatuses.map((provider) => { const tested = testedProviders.has(provider.providerId), statusClass = provider.status === "ready" ? "completed" : provider.status === "missing" ? "failed" : "queued"; return `<tr${provider.providerId === "muse" ? ' class="leader-row"' : ""}><td><strong>${escapeHtml(provider.label)}</strong><br><code>${escapeHtml(provider.providerId)}</code></td><td><span class="status ${statusClass}">${escapeHtml(provider.status)}</span></td><td>${escapeHtml(provider.model ?? "auto")}</td><td><span class="flag ${tested ? "good" : "warn"}">${tested ? "tested" : "not tested"}</span></td><td>${tested ? `${suites.filter((suite) => suite.variants.some((variant) => variant.provider === provider.providerId)).length} suite(s)` : "No evaluation runs yet"}</td><td><a class="button secondary" href="/providers?provider=${encodeURIComponent(provider.providerId)}">Configure</a></td></tr>`; }).join("");
    const suiteLinks = suites.map((suite) => `
      <a class="suite-link ${selected?.id === suite.id ? "active" : ""}" href="/evaluations?suite=${encodeURIComponent(suite.id)}">
        <strong>${escapeHtml(suite.name)}</strong>
        <span>${escapeHtml(suite.workflowId)} · ${suite.runs.length} runs</span>
        <small>${renderDashboardDateTime(suite.latestAt)}</small>
      </a>
    `).join("");
    const variantRows = selected?.variants.map((variant) => `
      <tr class="${selected.leader === variant.id ? "leader-row" : ""}">
        <td><strong>${escapeHtml(variant.id)}</strong>${selected.leader === variant.id ? '<span class="flag good">leader</span>' : ""}</td>
        <td>${escapeHtml(variant.provider)}</td>
        <td>${escapeHtml(variant.modelTier)}</td>
        <td>${variant.completed}/${variant.runs}</td>
        <td>${variant.averageQuality ?? "n/a"}</td>
        <td>${variant.averageLatencyMs === null ? "n/a" : formatDuration(variant.averageLatencyMs)}</td>
        <td>${variant.fallbackRate}</td>
        <td>${escapeHtml(formatInlineCounts(variant.estimatedCostMix))}</td>
        <td>${escapeHtml(formatInlineCounts(variant.feedbackCounts))}</td>
      </tr>
    `).join("") ?? "";
    const runRows = selected?.runs.map((run) => `
      <tr>
        <td><a href="/run?id=${encodeURIComponent(run.runId)}">${escapeHtml(run.runId.slice(0, 8))}</a></td>
        <td>${escapeHtml(run.caseId)}</td>
        <td>${escapeHtml(run.variantId)}</td>
        <td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
        <td>${run.averageQuality ?? "n/a"}</td>
        <td>${formatDuration(run.totalLatencyMs)}</td>
        <td>${run.fallbackCount}</td>
        <td>${escapeHtml(run.feedback ?? "none")}</td>
      </tr>
    `).join("") ?? "";

    return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent Workflow Evaluations</title>
    <style>${dashboardCss()}</style>
  </head>
  <body>
    ${dashboardNav("evaluations")}
    <main id="main-content">
      <div class="topbar">
        <div>
          <a href="/">Dashboard</a>
          <h1>Evaluations</h1>
          <p class="muted">Compare workflow quality, latency, fallback behavior, cost mix, and feedback across provider, tier, and prompt variants.</p>
        </div>
        <a class="button secondary" href="/api/evaluations${selected ? `?suite=${encodeURIComponent(selected.id)}` : ""}">JSON</a>
      </div>
      <section class="panel"><div class="section-heading"><div><h2>Provider coverage</h2><span class="muted">Supported providers remain visible even before they have evaluation evidence. “Tested” means at least one stored suite contains that provider.</span></div><a class="button secondary" href="/candidate-comparisons">Plan comparison</a></div><div class="table-wrap"><table><thead><tr><th>Provider</th><th>Readiness</th><th>Model</th><th>Coverage</th><th>Evidence</th><th>Setup</th></tr></thead><tbody>${providerRows}</tbody></table></div></section>
      <div class="comparison-layout">
        <aside class="suite-list" aria-label="Evaluation suites">
          <h2>Suites</h2>
          ${suiteLinks || '<p class="muted">No evaluation runs found.</p>'}
        </aside>
        <div>
          ${selected ? `
            <section class="panel">
              <div class="section-heading">
                <div><h2>${escapeHtml(selected.name)}</h2><span class="muted">${escapeHtml(selected.workflowId)} · latest ${renderDashboardDateTime(selected.latestAt)}</span></div>
                <span class="flag good">Leader: ${escapeHtml(selected.leader ?? "none")}</span>
              </div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Variant</th><th>Provider</th><th>Tier</th><th>Completed</th><th>Quality</th><th>Latency</th><th>Fallbacks/run</th><th>Cost mix</th><th>Feedback</th></tr></thead>
                  <tbody>${variantRows}</tbody>
                </table>
              </div>
            </section>
            <section class="panel">
              <h2>Run matrix</h2>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Run</th><th>Case</th><th>Variant</th><th>Status</th><th>Quality</th><th>Latency</th><th>Fallbacks</th><th>Feedback</th></tr></thead>
                  <tbody>${runRows}</tbody>
                </table>
              </div>
            </section>
          ` : '<section class="panel"><h2>No evaluation data</h2><p>Run <code>agentflow evaluate</code> to populate this comparison view.</p></section>'}
        </div>
      </div>
    </main>
  </body>
  </html>`;
  }

  function renderFeedbackBulkReviewHtml(report: DashboardFeedbackInboxReport, params: URLSearchParams): string {
    const allItems = [
      ...report.groups.probably_accept,
      ...report.groups.probably_revise,
      ...report.groups.probably_reject
    ];
    const rows = allItems.map((item) => {
      const suggestedRating = feedbackRatingForBucket(item.classification.bucket);
      return `
        <tr>
          <td><input type="checkbox" name="runId" value="${escapeHtml(item.runId)}" checked></td>
          <td><a href="/run?id=${encodeURIComponent(item.runId)}">${escapeHtml(item.runId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(item.workflowId)} · ${renderDashboardDateTime(item.startedAt)}</span><div class="row-tools">${renderRunInfoDialog({
            runId: item.runId,
            workflowId: item.workflowId,
            status: item.status,
            task: item.task,
            startedAt: item.startedAt,
            summary: [
              item.classification.reason,
              item.summary ? `${item.summary.completedTasks}/${item.summary.totalTasks} stages complete, ${item.summary.failedTasks} failed` : "summary unavailable",
              item.summary?.recommendedNextAction ?? "next action unavailable"
            ]
          })}</div></td>
          <td><span class="flag ${suggestedRating === "accepted" ? "good" : suggestedRating === "revised" ? "warn" : "bad"}">${escapeHtml(suggestedRating)}</span><br><span class="muted">${escapeHtml(item.classification.reason)}</span></td>
          <td>
            <select name="rating:${escapeHtml(item.runId)}">
              ${(["accepted", "revised", "rejected"] as const).map((rating) => `<option value="${rating}"${rating === suggestedRating ? " selected" : ""}>${rating}</option>`).join("")}
            </select>
          </td>
          <td><input name="note:${escapeHtml(item.runId)}" value="${escapeHtml(defaultFeedbackNote(item, suggestedRating))}" placeholder="What should future runs learn?"></td>
          <td>
            <strong>${escapeHtml(item.task)}</strong>
            ${item.summary ? `<br><span class="muted">${item.summary.completedTasks}/${item.summary.totalTasks} stages complete · ${item.summary.failedTasks} failed</span>` : ""}
            ${item.summary?.keyFindings.length ? `<br><span class="muted">${escapeHtml(truncateText(item.summary.keyFindings[0], 180))}</span>` : ""}
            ${item.summary?.failures.length ? `<br><span class="muted">${escapeHtml(truncateText(item.summary.failures[0], 180))}</span>` : ""}
          </td>
        </tr>
      `;
    }).join("");
    return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent Workflow Bulk Feedback</title>
    <style>${dashboardCss()}</style>
  </head>
  <body>
    ${dashboardNav("feedback-inbox")}
    <main id="main-content">
      <div class="topbar">
        <div>
          <a href="/feedback-inbox?${escapeHtml(params.toString())}">Feedback Inbox</a>
          <h1>Bulk Feedback Review</h1>
          <p class="muted">Review suggested feedback ratings, uncheck anything you do not want to record, then submit selected rows.</p>
        </div>
      </div>
      ${renderDashboardFlash(params)}
      <section class="panel">
        <div class="metric-grid">
          ${metricCard("Selected By Default", allItems.length, "uncheck rows to skip")}
          ${metricCard("Probably Accept", report.counts.probably_accept, "suggested accepted")}
          ${metricCard("Probably Revise", report.counts.probably_revise, "suggested revised")}
          ${metricCard("Probably Reject", report.counts.probably_reject, "suggested rejected")}
          ${metricCard("Project Scope", report.projectRootUri ? "one" : "all", report.projectRootUri ?? "all registered projects")}
          ${metricCard("Generated", formatDashboardDateTimeText(report.generatedAt), "local read")}
        </div>
      </section>
      <section class="panel">
        <form method="post" action="/api/feedback-bulk-action" class="bulk-feedback-form">
          <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri ?? "")}">
          <input type="hidden" name="limit" value="${escapeHtml(String(report.limit))}">
          <div class="form-actions">
            <button type="submit"${allItems.length ? "" : " disabled"}>Record Selected Feedback</button>
            <a class="button secondary" href="/feedback-inbox?${escapeHtml(params.toString())}">Cancel</a>
          </div>
          <div class="table-wrap"><table><thead><tr><th>Use</th><th>Run</th><th>Suggestion</th><th>Rating</th><th>Note</th><th>Evidence</th></tr></thead><tbody>${rows || "<tr><td colspan=\"6\">No unreviewed runs found.</td></tr>"}</tbody></table></div>
        </form>
      </section>
    </main>
  </body>
  </html>`;
  }

  function renderFeedbackInboxGroupHtml(
    title: string,
    defaultRating: FeedbackRating,
    items: DashboardFeedbackInboxItem[]
  ): string {
    const rows = items.map((target) => `
      <tr>
        <td><a href="/run?id=${encodeURIComponent(target.runId)}">${escapeHtml(target.runId.slice(0, 8))}</a><br><span class="muted">${renderDashboardDateTime(target.startedAt)}</span><div class="row-tools">${renderRunInfoDialog({
          runId: target.runId,
          workflowId: target.workflowId,
          status: target.status,
          task: target.task,
          startedAt: target.startedAt,
          summary: [
            target.classification.reason,
            target.summary ? `${target.summary.completedTasks}/${target.summary.totalTasks} stages complete, ${target.summary.failedTasks} failed` : "summary unavailable",
            target.summary?.recommendedNextAction ?? "next action unavailable"
          ]
        })}</div></td>
        <td>${escapeHtml(target.workflowId)}<br><span class="muted">${escapeHtml(target.classification.reason)}</span></td>
        <td>
          <strong>${escapeHtml(target.task)}</strong>
          ${target.summary ? `<br><span class="muted">${target.summary.completedTasks}/${target.summary.totalTasks} stages complete · ${target.summary.failedTasks} failed · ${escapeHtml(target.summary.recommendedNextAction)}</span>` : ""}
        </td>
        <td>${renderFeedbackTargetEvidenceHtml(target)}</td>
        <td>${renderFeedbackTargetPrimaryActionForm(target, defaultRating)}${renderFeedbackTargetActionForms(target)}</td>
      </tr>
    `).join("");
    return `
      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>${escapeHtml(title)}</h2>
            <span class="muted">${items.length} unreviewed run${items.length === 1 ? "" : "s"}</span>
          </div>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Run</th><th>Workflow</th><th>Summary</th><th>Evidence</th><th>Feedback</th></tr></thead><tbody>${rows || "<tr><td colspan=\"5\">No runs in this bucket.</td></tr>"}</tbody></table></div>
      </section>
    `;
  }

  function renderFeedbackInboxHtml(
    report: DashboardFeedbackInboxReport,
    projects: DashboardProjectSummary[],
    params: URLSearchParams
  ): string {
    const selectedProject = report.projectRootUri ?? params.get("project") ?? "";
    const projectOptions = [
      `<option value=""${selectedProject ? "" : " selected"}>All registered projects</option>`,
      ...projects.map((project) => `<option value="${escapeHtml(project.rootUri)}"${selectedProject === project.rootUri ? " selected" : ""}>${escapeHtml(project.name)} - ${escapeHtml(project.rootUri)}</option>`)
    ].join("");
    return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent Workflow Feedback Inbox</title>
    <style>${dashboardCss()}</style>
  </head>
  <body>
    ${dashboardNav("feedback-inbox")}
    <main id="main-content">
      <div class="topbar">
        <div>
          <a href="/">Dashboard</a>
          <h1>Feedback Inbox</h1>
          <p class="muted">Review unscored runs across projects and turn them into local learning signal.</p>
        </div>
        <div class="actions">
          <a class="button" href="/feedback-inbox/bulk?${escapeHtml(params.toString())}">Bulk Review</a>
          <a class="button secondary" href="/api/feedback-inbox?${escapeHtml(params.toString())}">JSON</a>
        </div>
      </div>
      ${renderDashboardFlash(params)}
      ${renderDashboardActionHistory()}
      <section class="panel">
        <form method="get" class="workflow-form">
          <label class="wide">Project<select name="project">${projectOptions}</select></label>
          <label>Run limit<input name="limit" value="${escapeHtml(String(report.limit))}" inputmode="numeric"></label>
          <div class="form-actions"><button type="submit">Refresh Inbox</button></div>
        </form>
      </section>
      <section class="panel">
        <div class="metric-grid">
          ${metricCard("Unreviewed", report.totalTargets, `${report.totalCandidates} recent finished runs scanned`)}
          ${metricCard("Probably Accept", report.counts.probably_accept, "clean useful runs")}
          ${metricCard("Probably Revise", report.counts.probably_revise, "useful with caveats")}
          ${metricCard("Probably Reject", report.counts.probably_reject, "wrong, failed, or low quality")}
          ${metricCard("Project Scope", report.projectRootUri ? "one" : "all", report.projectRootUri ?? "all registered projects")}
          ${metricCard("Generated", formatDashboardDateTimeText(report.generatedAt), "local read")}
        </div>
      </section>
      ${renderFeedbackInboxGroupHtml("Probably Accept", "accepted", report.groups.probably_accept)}
      ${renderFeedbackInboxGroupHtml("Probably Revise", "revised", report.groups.probably_revise)}
      ${renderFeedbackInboxGroupHtml("Probably Reject", "rejected", report.groups.probably_reject)}
    </main>
  </body>
  </html>`;
  }

  function renderFeedbackTargetPrimaryActionForm(target: DashboardFeedbackInboxItem, rating: FeedbackRating): string {
    return `
      <div class="recommended-feedback">
        <strong>Recommended</strong>
        ${feedbackTargetActionForm(target.runId, rating, `Mark ${titleCase(rating)}`, defaultFeedbackNote(target, rating))}
      </div>
    `;
  }

  function renderLearningActionReceiptHealthHtml(health: LearningActionReceiptHealth, limit: number, workflowId: string): string {
    const clean = health.compactableReceiptCount === 0;
    const statusLabel = clean ? "clean" : "compactable";
    return `
      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>Learning Receipt Health</h2>
            <span class="muted">Daemon-owned receipt compaction keeps project learning state useful and small.</span>
          </div>
          <a class="button secondary" href="/api/learning-action-receipts?project=${encodeURIComponent(health.projectRootUri)}&health=1">Health JSON</a>
        </div>
        <div class="metric-grid">
          ${metricCard("Status", statusLabel, health.recommendation)}
          ${metricCard("Receipts", health.totalReceipts, `planned=${health.counts.planned ?? 0} applied=${health.counts.applied ?? 0}`)}
          ${metricCard("Superseded", health.counts.superseded ?? 0, "historical audit trail")}
          ${metricCard("Daemon Open", health.daemonOpenReceipts, `${health.uniqueDaemonOpenReceipts} unique active receipt(s)`)}
          ${metricCard("Duplicates", health.duplicateDaemonOpenReceipts, "planned/applied daemon repeats")}
          ${metricCard("Last Backup", health.latestBackupPath ? "present" : "none", health.latestBackupPath ?? "no compaction backup yet")}
        </div>
        <form method="post" action="/api/learning-action-receipts" class="inline-action-form">
          <input type="hidden" name="project" value="${escapeHtml(health.projectRootUri)}">
          <input type="hidden" name="limit" value="${escapeHtml(String(limit))}">
          <input type="hidden" name="workflow" value="${escapeHtml(workflowId)}">
          <input type="hidden" name="action" value="compact">
          <button type="submit" class="secondary"${clean ? ' disabled title="Receipt health is already clean; there are no duplicate daemon-owned receipts to compact."' : ""}>${clean ? "Receipts already compact" : "Compact daemon-owned receipts"}</button>
          <span class="muted">Creates local backups before rewriting Agent Workflow-owned receipt files.</span>
        </form>
        <div class="meta-grid compact">
          <div><strong>Updated</strong>${renderDashboardDateTime(health.updatedAt)}</div>
          <div><strong>Latest Receipt</strong>${renderDashboardDateTime(health.latestReceiptAt, "none")}</div>
          <div><strong>Latest Backup</strong>${escapeHtml(health.latestBackupPath ?? "none")}</div>
        </div>
      </section>
    `;
  }

  function renderLearningActionReceiptsHtml(log: LearningActionReceiptLog, limit: number): string {
    const counts = countStrings(log.events.map((event) => event.status));
    const rows = log.events.slice(-20).reverse().map((event) => `
      <tr>
        <td>${escapeHtml(event.id)}<br><span class="muted">${renderDashboardDateTime(event.createdAt)}</span></td>
        <td><span class="flag ${event.status === "planned" ? "good" : event.status === "rejected" ? "warn" : "queued"}">${escapeHtml(event.status)}</span></td>
        <td>${escapeHtml(event.title)}<br><span class="muted">${escapeHtml(event.actionId)} · ${escapeHtml(event.proposalId)}</span></td>
        <td>${escapeHtml(event.actionType)}<br><span class="muted">${escapeHtml(event.dangerGate)}</span></td>
        <td>${escapeHtml(event.actor)}<br><span class="muted">${escapeHtml(event.note)}</span></td>
      </tr>
    `).join("");
    return `
      <section class="panel">
        <div class="section-heading">
          <div><h2>Proposal-To-Action Receipts</h2><span class="muted">planned=${counts.planned ?? 0} superseded=${counts.superseded ?? 0} rejected=${counts.rejected ?? 0}</span></div>
          <a class="button secondary" href="/api/learning-action-receipts?project=${encodeURIComponent(log.projectRootUri)}">JSON</a>
        </div>
        <p class="muted">Receipts are append-only learning-owned state. They record when approved proposals become plans, when plans are superseded, and when you reject a planned action.</p>
        <form method="post" action="/api/learning-action-receipts" class="inline-action-form">
          <input type="hidden" name="project" value="${escapeHtml(log.projectRootUri)}">
          <input type="hidden" name="limit" value="${escapeHtml(String(limit))}">
          <label>Item to reject<input name="reject" placeholder="action, proposal, or receipt id"></label>
          <label>Decision made by<input name="actor" value="dashboard"></label>
          <label>Reason for rejection<input name="note" placeholder="why reject this planned action"></label>
          <button type="submit" class="secondary">Reject Planned Action</button>
        </form>
        <div class="table-wrap"><table><thead><tr><th>Receipt</th><th>Status</th><th>Action</th><th>Type/Gate</th><th>Actor/Note</th></tr></thead><tbody>${rows || "<tr><td colspan=\"5\">No learning action receipts yet.</td></tr>"}</tbody></table></div>
      </section>
    `;
  }

  function renderLearningDaemonStatusHtml(status: DashboardLearningDaemonStatus, supervisor: DashboardSupervisorStatus): string {
    const age = status.ageMs === null ? "n/a" : formatDuration(Math.max(0, status.ageMs));
    const remoteProjectSelected = status.status === "missing" && !status.projectPathExists && supervisor.learningEnabled && supervisor.learningScope === "all-projects";
    const statusLabel = remoteProjectSelected ? "remote path" : status.status;
    const statusClass = remoteProjectSelected ? "queued" : status.status === "running" ? "completed" : status.status === "missing" ? "queued" : "failed";
    const statusDetail = remoteProjectSelected
      ? `The durable learning daemon is running in all-projects mode, but this selected project path is not mounted on this Mac: ${status.projectRootUri}. Agent Workflow can read its shared run history from storage, but cannot write that project's local heartbeat files until the project is available at a local path.`
      : status.status === "missing" && supervisor.learningScope !== "all-projects" && supervisor.learningProject && supervisor.learningProject !== status.projectRootUri
        ? `No heartbeat for this project because the durable supervisor is currently watching ${supervisor.learningProject}.`
        : "";
    return `
      <div class="meta-grid">
        <div><strong>Status</strong><span class="status ${statusClass}">${escapeHtml(statusLabel)}</span></div>
        <div><strong>Mode</strong>${escapeHtml(status.mode ?? "n/a")}</div>
        <div><strong>Daemon</strong>${escapeHtml(status.daemonId ?? "n/a")}</div>
        <div><strong>PID</strong>${status.pid ?? "none"}</div>
        <div><strong>Process</strong>${status.processAlive ? "alive" : "not running"}</div>
        <div><strong>Project Path</strong>${status.projectPathExists ? "available locally" : "not mounted here"}</div>
        <div><strong>Last Heartbeat</strong>${renderDashboardDateTime(status.lastHeartbeatAt, "none")}</div>
        <div><strong>Age</strong>${escapeHtml(age)}</div>
        <div><strong>Last Report</strong>${renderDashboardDateTime(status.lastReportAt, "none")}</div>
        <div><strong>Ticks</strong>${formatNumber(status.ticks)}</div>
        <div><strong>Proposals</strong>${formatNumber(status.proposals)}</div>
        <div><strong>Roadmap Snapshot</strong>${escapeHtml(status.roadmapSnapshotStatus ?? "not published")}</div>
        <div><strong>Snapshot Published</strong>${renderDashboardDateTime(status.roadmapSnapshotPublishedAt, "none")}</div>
        <div><strong>Snapshot Digest</strong><code>${escapeHtml(status.roadmapSnapshotDigest?.slice(0, 12) ?? "none")}</code></div>
        <div><strong>Inbox Items</strong>${formatNumber(status.inboxItems)}</div>
        <div><strong>Application Actions</strong>${formatNumber(status.applicationActions)}</div>
        <div><strong>Auto-applied</strong>${formatNumber(status.autonomousAppliedActions)}</div>
        <div><strong>Auto-apply Risk</strong>${escapeHtml(status.autonomousApplyMaxRisk)}</div>
        <div><strong>Agent Candidates</strong>${formatNumber(status.agentImprovementCandidates)}</div>
        <div><strong>Agent Patch Previews</strong>${formatNumber(status.agentImprovementPatchPreviews)}</div>
        <div><strong>Agent Eval Passes</strong>${formatNumber(status.agentImprovementEvalPasses)}</div>
        <div><strong>Agent Promotions</strong>${formatNumber(status.agentImprovementPromotions)}</div>
        <div><strong>Promotion Pending</strong>${formatNumber(status.agentImprovementPromotionPending)}</div>
        <div><strong>Agent YAML Applied</strong>${formatNumber(status.agentImprovementApplied)}</div>
        <div><strong>YAML Apply Skipped</strong>${formatNumber(status.agentImprovementApplySkipped)}</div>
        <div><strong>Approval Autopilot</strong>${status.approvalAutopilotEnabled ? "on" : "off"}</div>
        <div><strong>Approval Risk</strong>${escapeHtml(status.approvalAutopilotMaxRisk)}</div>
        <div><strong>Approvals Executed</strong>${formatNumber(status.approvalAutopilotExecuted)}</div>
        <div><strong>Approvals Skipped</strong>${formatNumber(status.approvalAutopilotSkipped)}</div>
        <div><strong>Backlog Scanned</strong>${formatNumber(status.approvalBacklogScanned)}</div>
        <div><strong>Backlog Warnings</strong>${formatNumber(status.approvalBacklogWarnings)}</div>
        <div><strong>Backlog Errors</strong>${formatNumber(status.approvalBacklogErrors)}</div>
        <div><strong>Shape Auto Update</strong>${status.workflowShapeAutoUpdate === false ? "off" : "on"}</div>
        <div><strong>Shape Recommendations</strong>${formatNumber(status.workflowShapeRecommendations ?? 0)}</div>
        <div><strong>MCP Cleanup</strong>${status.mcpCleanupEnabled ? escapeHtml(status.mcpCleanupMode) : "off"}</div>
        <div><strong>MCP Stale Age</strong>${formatNumber(status.mcpCleanupStaleMinutes)} min</div>
        <div><strong>MCP Candidates</strong>${formatNumber(status.mcpCleanupCandidates)}</div>
        <div><strong>MCP Auto-cleanable</strong>${formatNumber(status.mcpCleanupAutoCleanable)}</div>
        <div><strong>MCP Terminated</strong>${formatNumber(status.mcpCleanupTerminated)}</div>
        <div><strong>MCP Warnings</strong>${formatNumber(status.mcpCleanupWarnings)}</div>
        <div><strong>Last MCP Cleanup</strong>${renderDashboardDateTime(status.lastMcpCleanupAt, "none")}</div>
        <div><strong>Stale Run Reconcile</strong>${status.staleRunReconcileEnabled ? "on" : "off"}</div>
        <div><strong>Stale Run Candidates</strong>${formatNumber(status.staleRunReconcileCandidates)}</div>
        <div><strong>Stale Runs Repaired</strong>${formatNumber(status.staleRunReconciled)}</div>
        <div><strong>Last Stale Run Check</strong>${renderDashboardDateTime(status.lastStaleRunReconcileAt, "none")}</div>
        <div><strong>Heartbeat File</strong>${escapeHtml(status.heartbeatPath)}</div>
        <div><strong>Start Command</strong><code>${escapeHtml(status.command)}</code></div>
        ${status.lastError ? `<div><strong>Last Error</strong>${escapeHtml(status.lastError)}</div>` : ""}
      </div>
      ${statusDetail ? `<p class="warn-box">${escapeHtml(statusDetail)}</p>` : ""}
    `;
  }

  function renderGuideEvidenceDiagnosticsPanel(project: string): string {
    const endpoint = `/api/guide-evidence-diagnostics?project=${encodeURIComponent(project)}`;
    const reductionStorageKey = guideEvidenceCheckpointStorageKey(project);
    return `<section class="panel" id="guide-evidence-integrity">
      <div class="section-heading"><div><h2>Guide Evidence Integrity</h2><span class="muted">Read-only inventory of compatible and quarantined historical Guide evidence.</span></div><a class="button secondary" id="guide-evidence-json" href="${escapeHtml(endpoint)}">JSON</a></div>
      <p class="muted">Quarantine is an audit-only integrity issue. It is not a workflow failure, approval request, automatic repair authorization, or acceptance decision.</p>
      <div class="workflow-form">
        <label>Task class<input id="guide-evidence-task-class" placeholder="all task classes"></label>
        <label>Status<select id="guide-evidence-status"><option value="">all evidence</option><option value="legacy-compatible">legacy-compatible</option><option value="quarantined">quarantined</option></select></label>
      </div>
      <div id="guide-evidence-summary" class="meta-grid compact"><div><strong>Status</strong>Loading read-only inventory…</div></div>
      <div class="table-wrap"><table><thead><tr><th>Integrity</th><th>Task class / kind</th><th>Evidence</th><th>Audit-only next action</th></tr></thead><tbody id="guide-evidence-findings"><tr><td colspan="4">Loading bounded findings…</td></tr></tbody></table></div>
      <div class="inline-action-form"><button type="button" class="secondary" id="guide-evidence-page">Review receipt pages</button><button type="button" class="secondary" id="guide-evidence-reduce">Reduce full snapshot</button><span class="muted" id="guide-evidence-page-status">Pages preserve a frozen snapshot checkpoint; partial pages draw no integrity conclusion.</span></div>
      <script>
        (() => {
          const base = ${serializeInlineScriptJson(endpoint)};
          const reductionStorageKey = ${serializeInlineScriptJson(reductionStorageKey)};
          const taskClass = document.getElementById("guide-evidence-task-class");
          const status = document.getElementById("guide-evidence-status");
          const summary = document.getElementById("guide-evidence-summary");
          const findings = document.getElementById("guide-evidence-findings");
          const json = document.getElementById("guide-evidence-json");
          const pageButton = document.getElementById("guide-evidence-page");
          const reduceButton = document.getElementById("guide-evidence-reduce");
          const pageStatus = document.getElementById("guide-evidence-page-status");
          let pageCursor = null;
          let reductionCheckpoint = null;
          try { reductionCheckpoint = localStorage.getItem(reductionStorageKey); } catch {}
          if (reductionCheckpoint) reduceButton.textContent = "Resume full snapshot";
          const cell = (value) => { const td = document.createElement("td"); td.textContent = String(value ?? ""); return td; };
          const load = async () => {
            const url = new URL(base, location.origin);
            if (taskClass.value.trim()) url.searchParams.set("taskClass", taskClass.value.trim());
            if (status.value) url.searchParams.set("status", status.value);
            json.href = url.pathname + url.search;
            try {
              const response = await fetch(url, { headers: { accept: "application/json" } });
              const report = await response.json();
              if (!response.ok) throw new Error(report.error || "Guide evidence inventory unavailable");
              summary.replaceChildren();
              [["Scanned", report.scanned], ["Compatible", report.legacyCompatible], ["Quarantined", report.quarantined], ["Bounded", report.truncated ? "more evidence exists" : "complete window"], ["Authority", report.authority]].forEach(([label, value]) => {
                const item = document.createElement("div"); const strong = document.createElement("strong"); strong.textContent = String(label); item.append(strong, document.createTextNode(String(value))); summary.append(item);
              });
              findings.replaceChildren();
              report.findings.slice(0, 100).forEach((item) => {
                const row = document.createElement("tr");
                row.append(cell(item.status), cell(item.taskClass + " / " + item.kind), cell(item.reason), cell(item.reconciliation));
                findings.append(row);
              });
              if (!report.findings.length) { const row = document.createElement("tr"); const td = cell("No matching Guide evidence."); td.colSpan = 4; row.append(td); findings.append(row); }
            } catch (error) {
              summary.textContent = error instanceof Error ? error.message : String(error);
              findings.replaceChildren();
            }
          };
          const loadPage = async () => {
            const url = new URL(base, location.origin); url.searchParams.set("pageSize", "100"); if (pageCursor) url.searchParams.set("cursor", pageCursor);
            pageButton.disabled = true;
            try { const response = await fetch(url, { headers: { accept: "application/json" } }); const page = await response.json(); if (!response.ok) throw new Error(page.error || "Receipt page unavailable"); pageStatus.textContent = "Page " + page.pageIndex + ": " + page.items.length + " receipt(s), checkpoint " + page.coverage.checkpointHash.slice(0, 12) + " · " + page.integrityConclusion; pageCursor = page.nextCursor; pageButton.textContent = pageCursor ? "Review next receipt page" : "Snapshot fully covered"; pageButton.disabled = !pageCursor; }
            catch (error) { pageStatus.textContent = error instanceof Error ? error.message : String(error); pageButton.textContent = "Restart receipt-page review"; pageCursor = null; pageButton.disabled = false; }
          };
          const reduceSnapshot = async () => {
            const url = new URL(base, location.origin); url.searchParams.set("reduce", "true"); url.searchParams.set("pageSize", "100");
            reduceButton.disabled = true; reduceButton.textContent = "Reducing verified pages…";
            try {
              for (let attempt = 0; attempt < 1000; attempt += 1) {
                const headers = { accept: "application/json" }; if (reductionCheckpoint) headers["x-agentflow-guide-checkpoint"] = reductionCheckpoint;
                const response = await fetch(url, { headers }); const result = await response.json();
                if (!response.ok) { if (result.checkpointRejected) { reductionCheckpoint = null; try { localStorage.removeItem(reductionStorageKey); } catch {} } throw new Error(result.error || "Snapshot reduction unavailable"); }
                if (result.complete === false) {
                  reductionCheckpoint = result.checkpoint; try { localStorage.setItem(reductionStorageKey, reductionCheckpoint); } catch {}
                  pageStatus.textContent = "Checkpointed " + result.progress.receipts + " receipt(s) across " + result.progress.pages + " verified page(s) · expires " + new Date(result.expiresAt).toLocaleTimeString() + " · resume-only, no repair, replay, approval, promotion, or acceptance authority";
                  reduceButton.textContent = "Reducing page " + (result.progress.pages + 1) + "…"; await new Promise(resolve => setTimeout(resolve, 0)); continue;
                }
                const manifest = result; reductionCheckpoint = null; try { localStorage.removeItem(reductionStorageKey); } catch {}
                pageStatus.textContent = "Full snapshot: " + manifest.conclusion + " · " + manifest.receipts + " receipts across " + manifest.pages + " page(s) · signature " + manifest.manifestSignature.value.slice(0, 12) + " · no repair, replay, approval, promotion, or acceptance authority"; reduceButton.textContent = "Snapshot reduced"; return;
              }
              reduceButton.textContent = "Continue full snapshot"; reduceButton.disabled = false;
            }
            catch (error) { pageStatus.textContent = error instanceof Error ? error.message : String(error); reduceButton.textContent = reductionCheckpoint ? "Resume full snapshot" : "Restart full snapshot"; reduceButton.disabled = false; }
          };
          pageButton.addEventListener("click", loadPage);
          reduceButton.addEventListener("click", reduceSnapshot);
          taskClass.addEventListener("change", load); status.addEventListener("change", load); load();
        })();
      </script>
    </section>`;
  }

  function renderGuideAdoptionHoldMetricsPanel(project: string): string {
    const endpoint = `/api/guide-adoption-hold-metrics?project=${encodeURIComponent(project)}&staleMinutes=auto`;
    return `<section class="panel" id="guide-adoption-holds">
      <div class="section-heading"><div><h2>Guide Adoption Holds</h2><span class="muted">Observed deployment latency and coalescing by registry fingerprint generation.</span></div><a class="button secondary" href="${escapeHtml(endpoint)}">JSON</a></div>
      <p class="muted">Lag alerts are observational only. They do not authorize worker restart, replay, repair, or acceptance of a primary outcome.</p>
      <div id="guide-hold-summary" class="meta-grid compact"><div><strong>Status</strong>Loading bounded hold metrics…</div></div>
      <div class="table-wrap"><table><thead><tr><th>Generation</th><th>State / latency</th><th>Affected</th><th>Coalescing</th><th>Signal</th></tr></thead><tbody id="guide-hold-metrics"><tr><td colspan="5">Loading…</td></tr></tbody></table></div>
      <script>
        (() => {
          const summary = document.getElementById("guide-hold-summary");
          const rows = document.getElementById("guide-hold-metrics");
          const cell = (value) => { const td = document.createElement("td"); td.textContent = String(value ?? ""); return td; };
          const duration = (ms) => ms == null ? "n/a" : ms < 60_000 ? Math.round(ms / 1000) + "s" : Math.round(ms / 60_000) + "m";
          fetch(${serializeInlineScriptJson(endpoint)}, { headers: { accept: "application/json" } }).then(async (response) => {
            const report = await response.json(); if (!response.ok) throw new Error(report.error || "Guide hold metrics unavailable");
            summary.replaceChildren();
            const confidence = report.calibration.confidenceBandLowerMs == null ? "insufficient evidence" : duration(report.calibration.confidenceBandLowerMs) + "–" + duration(report.calibration.confidenceBandUpperMs);
            [["Generations", report.metrics.length], ["Open", report.metrics.filter((item) => item.state === "open").length], ["Lag alerts", report.metrics.filter((item) => item.adoptionLagAlert).length], ["Threshold", duration(report.calibration.selectedThresholdMs) + " · " + report.calibration.source + " · candidate " + duration(report.calibration.candidateThresholdMs)], ["Alert guard", duration(report.calibration.alertThresholdMs) + " · preserves open alerts"], ["Confidence", confidence], ["Stability", report.calibration.stability + " · " + report.calibration.sampleCount + "/" + report.calibration.minimumSamples + " samples · " + report.calibration.stableGenerationsObserved + "/" + report.calibration.stableGenerationRequirement + " stable generations · max " + Math.round(report.calibration.maximumChangeFraction * 100) + "% change"], ["Receipt window", report.truncated ? "truncated" : "complete"], ["Authority", report.authority]].forEach(([label, value]) => { const item = document.createElement("div"); const strong = document.createElement("strong"); strong.textContent = String(label); item.append(strong, document.createTextNode(String(value))); summary.append(item); });
            rows.replaceChildren();
            report.metrics.slice(0, 100).forEach((item) => { const row = document.createElement("tr"); row.append(cell(item.expectedFingerprint.slice(0, 12) + " / " + item.generation), cell(item.state + " · " + (item.state === "open" ? duration(item.openAgeMs) + " open" : duration(item.resolutionLatencyMs) + " to resolve")), cell(item.affectedRunCount), cell(item.duplicateSuppressedCount + " duplicate receipt(s) suppressed"), cell(item.adoptionLagAlert ? "adoption lag" : "within observed threshold")); rows.append(row); });
            if (!report.metrics.length) { const row = document.createElement("tr"); const td = cell("No Guide adoption holds."); td.colSpan = 5; row.append(td); rows.append(row); }
          }).catch((error) => { summary.textContent = error instanceof Error ? error.message : String(error); rows.replaceChildren(); });
        })();
      </script>
    </section>`;
  }

  function renderLearningDashboardHtml(report: LearningReport | null, learningQueue: LearningApprovalQueue | null, learningDaemon: DashboardLearningDaemonStatus | null, learningApplicationPlan: LearningApplicationPlan | null, learningActionReceipts: LearningActionReceiptLog | null, learningActionReceiptHealth: LearningActionReceiptHealth | null, workflowShape: WorkflowShapeOptimizationReport | null, agentImprovement: AgentImprovementReport | null, agentImprovementEval: AgentImprovementEvalPlan | null, agentImprovementPromotion: AgentImprovementPromotionQueue | null, learningSettings: LearningSettings | null, supervisor: DashboardSupervisorStatus, projects: DashboardProjectSummary[], params: URLSearchParams, projectPath: DashboardProjectPathResolution | null = null, learningLoop: LearningLoopDashboard | null = null, agentImprovementPending: AgentImprovementPendingSummary | null = null): string {
    const learningViews = ["overview", "learning-loop", "recommendations", "approvals", "agent-improvements", "diagnostics", "settings"] as const;
    const requestedView = params.get("view");
    const learningView = learningViews.includes(requestedView as typeof learningViews[number]) ? requestedView as typeof learningViews[number] : "overview";
    const selectedProject = projectPath?.storageRootUri ?? report?.projectDir ?? params.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT ?? "";
    const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}">${escapeHtml(project.name)} - ${escapeHtml(project.rootUri)}</option>`).join("");
    const jsonHref = learningLoop ? `/api/learning-loop?project=${encodeURIComponent(projectPath?.localRootUri ?? selectedProject)}` : report ? `/api/learning-report?project=${encodeURIComponent(report.projectDir)}&limit=${encodeURIComponent(String(report.limit))}` : "";
    const shapeJsonHref = workflowShape ? `/api/learning-workflow-shape?project=${encodeURIComponent(workflowShape.projectRootUri)}&workflow=${encodeURIComponent(workflowShape.workflowId)}&limit=${encodeURIComponent(String(report?.limit ?? params.get("limit") ?? "50"))}` : "";
    const agentImprovementJsonHref = agentImprovement ? `/api/agent-improvement-report?project=${encodeURIComponent(agentImprovement.projectRootUri)}&limit=${encodeURIComponent(String(agentImprovement.limit))}` : "";
    const shapeAutoUpdate = learningSettings?.workflowShapeAutoUpdate ?? true;
    const agentImprovementProjectLocalAutoApply = learningSettings?.agentImprovementProjectLocalAutoApply ?? true;
    const autonomousApplyMaxRisk = learningSettings?.autonomousApplyMaxRisk ?? "medium";
    const approvalAutopilotEnabled = learningSettings?.approvalAutopilotEnabled ?? false;
    const approvalAutopilotMaxRisk = learningSettings?.approvalAutopilotMaxRisk ?? "medium";
    const daemonTrustLevels = learningSettings?.daemonTrustLevels ?? defaultDaemonTrustSettings();
    const overviewBody = selectedProject ? `<section class="human-section learning-overview-intro">
      <h2>Choose what to review</h2>
      <p class="page-intro">Open only the evidence you need. Detailed analysis loads when you select a view.</p>
      <div class="human-list">
        <a class="human-list-row" href="/learning?project=${encodeURIComponent(selectedProject)}&view=recommendations"><span class="human-row-icon">${dashboardIcon("sparkles")}</span><span><strong>Recommendations</strong><small>Workflow improvements, evaluation gaps, and routing opportunities.</small></span>${dashboardIcon("chevrons")}</a>
        <a class="human-list-row" href="/learning?project=${encodeURIComponent(selectedProject)}&view=approvals"><span class="human-row-icon">${dashboardIcon("shield")}</span><span><strong>Approvals</strong><small>Review learning proposals and planned changes.</small></span>${dashboardIcon("chevrons")}</a>
        <a class="human-list-row" href="/learning?project=${encodeURIComponent(selectedProject)}&view=agent-improvements"><span class="human-row-icon">${dashboardIcon("agent")}</span><span><strong>Agent improvements</strong><small>Inspect evaluated changes to agent definitions.</small></span>${dashboardIcon("chevrons")}</a>
        <a class="human-list-row" href="/learning?project=${encodeURIComponent(selectedProject)}&view=learning-loop"><span class="human-row-icon">${dashboardIcon("sparkles")}</span><span><strong>Learning loop</strong><small>Peer questions, calibrated assessments, disagreement, and guarded experiments.</small></span>${dashboardIcon("chevrons")}</a>
        <a class="human-list-row" href="/learning?project=${encodeURIComponent(selectedProject)}&view=diagnostics"><span class="human-row-icon">${dashboardIcon("gauge")}</span><span><strong>Diagnostics</strong><small>Failures, receipts, routing signals, and daemon health.</small></span>${dashboardIcon("chevrons")}</a>
      </div>
    </section>` : "";
    const body = learningLoop
      ? renderLearningLoopHtml(learningLoop)
      : report
      ? renderLearningReportHtml(report, learningQueue, learningDaemon, learningApplicationPlan, learningActionReceipts, learningActionReceiptHealth, workflowShape, agentImprovement, agentImprovementEval, agentImprovementPromotion, shapeAutoUpdate, agentImprovementProjectLocalAutoApply, autonomousApplyMaxRisk, approvalAutopilotEnabled, approvalAutopilotMaxRisk, daemonTrustLevels, supervisor, projectPath)
      : learningView === "overview" && selectedProject
        ? overviewBody
        : `<section class="panel"><h2>No Project Selected</h2><p class="muted">Register or select a project to inspect read-only local learning evidence.</p></section>`;
    return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent Workflow Learning</title>
    <style>${dashboardCss()}</style>
  </head>
  <body>
    ${dashboardNav(learningView === "settings" ? "daemon-control" : learningView === "diagnostics" ? "learning-diagnostics" : "learning")}
    <main id="main-content">
      <div class="topbar">
        <div>
          <a href="/">Home</a>
          <h1>Learning</h1>
          <p class="page-intro">Review recommendations, decisions, and system learning without the implementation noise.</p>
        </div>
        ${jsonHref ? `<a class="button secondary" href="${escapeHtml(jsonHref)}">JSON</a>` : ""}
      </div>
      <nav class="learning-tabs" aria-label="Insight views">
        ${learningViews.map((view) => {
          const hrefParams = new URLSearchParams(params);
          hrefParams.set("view", view);
          const label = view === "agent-improvements" ? "Agent improvements" : view === "learning-loop" ? "Learning loop" : titleCase(view);
          return `<a href="/learning?${escapeHtml(hrefParams.toString())}" class="${learningView === view ? "active" : ""}" ${learningView === view ? 'aria-current="page"' : ""}>${escapeHtml(label)}</a>`;
        }).join("")}
      </nav>
      ${renderDashboardFlash(params)}
      ${renderAgentImprovementPendingBannerHtml(agentImprovementPending)}
      ${renderDashboardActionHistory()}
      ${projectPath ? renderDashboardProjectPathResolutionHtml(projectPath) : ""}
      <section class="panel">
        <form method="get" class="workflow-form">
          <input type="hidden" name="view" value="${escapeHtml(learningView)}">
          <label class="wide">Project path
            <input name="project" value="${escapeHtml(selectedProject)}" list="learning-projects" placeholder="/path/to/project">
            <datalist id="learning-projects">${projectOptions}</datalist>
          </label>
          <label>Run limit
            <input name="limit" value="${escapeHtml(params.get("limit") ?? "50")}" inputmode="numeric">
          </label>
          <label>Workflow
            <input name="workflow" value="${escapeHtml(params.get("workflow") ?? workflowShape?.workflowId ?? "")}" placeholder="latest run workflow">
          </label>
          <div class="form-actions"><button type="submit">Inspect</button></div>
        </form>
      </section>
      ${(shapeJsonHref || agentImprovementJsonHref) ? `<section class="panel compact-panel">${shapeJsonHref ? `<a class="button secondary" href="${escapeHtml(shapeJsonHref)}">Workflow Shape JSON</a>` : ""}${agentImprovementJsonHref ? `<a class="button secondary" href="${escapeHtml(agentImprovementJsonHref)}">Agent Improvement JSON</a>` : ""}</section>` : ""}
      ${selectedProject && learningView === "diagnostics" ? renderGuideEvidenceDiagnosticsPanel(projectPath?.localRootUri ?? selectedProject) : ""}
      ${selectedProject && learningView === "diagnostics" ? renderGuideAdoptionHoldMetricsPanel(projectPath?.localRootUri ?? selectedProject) : ""}
      ${selectedProject ? `<section class="panel"><div class="section-heading"><div><h2>Workflow Optimizer</h2><span class="muted">Durable events, budgets, shadow evidence, approvals, and fleet health.</span></div><a class="button secondary" href="/api/optimizer-status?project=${encodeURIComponent(selectedProject)}">JSON</a></div><div id="optimizer-summary" class="meta-grid"><div><strong>Status</strong>Loading…</div></div></section><script>fetch(${serializeInlineScriptJson(`/api/optimizer-status?project=${encodeURIComponent(selectedProject)}`)}).then(r=>r.json()).then(r=>{document.getElementById('optimizer-summary').innerHTML='<div><strong>Status</strong>'+String(r.health?.status??'unknown')+'</div><div><strong>Events</strong>'+String(r.eventCursorCount??0)+'</div><div><strong>Queue</strong>'+String(r.health?.queueDepth??0)+'</div><div><strong>Budget</strong>'+String(r.health?.budgetConsumed??0)+' / '+String(r.health?.budgetLimit??0)+'</div><div><strong>Shadow Results</strong>'+String(r.shadowResults?.length??0)+'</div><div><strong>Approvals</strong>'+String(r.approvals?.length??0)+'</div>'}).catch(()=>{document.getElementById('optimizer-summary').textContent='Optimizer status unavailable.'})</script>` : ""}
      ${body}
      <script>
        (() => {
          const view = ${serializeInlineScriptJson(learningView)};
          const groups = {
            overview: ["Recent Dashboard Actions", "Workflow Optimizer", "Choose what to review"],
            "learning-loop": ["Learning Loop", "Open Peer Questions", "Peer Assessment Results", "Learning Experiments", "Scheduler Receipts"],
            recommendations: ["Workflow Shape Optimizer", "Evaluation Gaps", "Repeated Failure Patterns", "Cost And Routing Opportunities", "Proposal Preview"],
            approvals: ["Learning Proposal Inbox", "Approved Application Plan"],
            "agent-improvements": ["Agent Definition Improvement"],
            diagnostics: ["Project Path Mapping", "Guide Evidence Integrity", "Guide Adoption Holds", "Route Feedback Signals", "Learning Daemon", "Daemon Failure Triage", "Recent Failed Runs", "Learning Receipt Health", "Proposal-To-Action Receipts", "Privacy Boundaries", "Next Commands"],
            settings: ["Durable Learning Target", "Daemon Control Plane", "Autonomy Boundary"]
          };
          const utilityHeadings = ["Recent Dashboard Actions", "Project Path Mapping"];
          const alwaysOverview = (section) => !section.querySelector("h2") && !section.querySelector("form") && !section.classList.contains("compact-panel");
          document.querySelectorAll("main > section").forEach((section) => {
            if (section.querySelector("form[method='get']")) {
              section.classList.toggle("learning-hidden", view !== "overview");
              return;
            }
            const heading = section.querySelector("h2")?.textContent?.trim() ?? "";
            const allowed = view === "overview"
              ? alwaysOverview(section) || groups.overview.includes(heading)
              : groups[view]?.includes(heading) && !utilityHeadings.includes(heading);
            section.classList.toggle("learning-hidden", !allowed);
          });
        })();
      </script>
    </main>
  </body>
  </html>`;
  }

  function renderLearningFailureTriageHtml(report: LearningFailureTriageReport): string {
    const rows = report.groups.map((group) => `<tr>
      <td><code>${escapeHtml(group.signature)}</code><br><span class="muted">${group.runIds.map((runId) => `<a href="/run?id=${encodeURIComponent(runId)}">${escapeHtml(runId.slice(0, 8))}</a>`).join(" ")}</span></td>
      <td><span class="flag ${group.risk === "high" ? "warn" : group.risk === "low" ? "good" : "queued"}">${escapeHtml(group.risk)}</span><br>${escapeHtml(group.category)}</td>
      <td>${escapeHtml(group.diagnosis)}<br><span class="muted">${escapeHtml(group.detail)}</span></td>
      <td><span class="status ${group.action === "retried" ? "completed" : group.action === "escalated" || group.action === "retry_failed" ? "failed" : "queued"}">${escapeHtml(group.action.replace(/_/g, " "))}</span></td>
    </tr>`).join("");
    return `<section class="panel">
      <div class="section-heading"><div><h2>Daemon Failure Triage</h2><span class="muted">Proactive diagnosis, verified remediation, and bounded retry decisions.</span></div></div>
      <div class="callout ${report.failedRuns ? "queued" : "completed"}"><strong>Daemon observation</strong><p>${escapeHtml(report.observation)}</p></div>
      <div class="meta-grid compact"><div><strong>Failures seen</strong>${report.failedRuns}</div><div><strong>Root causes</strong>${report.groups.length}</div><div><strong>Safely retried</strong>${report.retriedRuns.length}</div><div><strong>Withheld</strong>${report.withheldRuns.length}</div></div>
      <div class="table-wrap"><table><thead><tr><th>Failure group</th><th>Class / risk</th><th>Reasoning</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No failures needed triage.</td></tr>'}</tbody></table></div>
    </section>`;
  }

  function renderLearningReportHtml(report: LearningReport, learningQueue: LearningApprovalQueue | null, learningDaemon: DashboardLearningDaemonStatus | null, learningApplicationPlan: LearningApplicationPlan | null, learningActionReceipts: LearningActionReceiptLog | null, learningActionReceiptHealth: LearningActionReceiptHealth | null, workflowShape: WorkflowShapeOptimizationReport | null, agentImprovement: AgentImprovementReport | null, agentImprovementEval: AgentImprovementEvalPlan | null, agentImprovementPromotion: AgentImprovementPromotionQueue | null, shapeAutoUpdate: boolean, agentImprovementProjectLocalAutoApply: boolean, autonomousApplyMaxRisk: LearningRiskLevel, approvalAutopilotEnabled: boolean, approvalAutopilotMaxRisk: ApprovalAutopilotRisk, daemonTrustLevels: DaemonTrustSettings, supervisor: DashboardSupervisorStatus, projectPath: DashboardProjectPathResolution | null = null): string {
    const localProjectDir = projectPath?.localRootUri ?? report.projectDir;
    const failureRows = report.repeatedFailurePatterns.map((pattern) => `
      <tr><td>${escapeHtml(pattern.workflowId)}</td><td>${escapeHtml(pattern.stageId)}</td><td>${escapeHtml(pattern.agentId)}</td><td>${pattern.failedTasks}/${pattern.totalTasks}</td><td>${pattern.failureRate}</td></tr>
    `).join("");
    const costRows = report.costOpportunities.map((item) => `
      <tr><td>${escapeHtml(item.workflowId)}<br><span class="muted">${escapeHtml(item.stageId)}</span></td><td>${escapeHtml(item.agentId)}</td><td>${escapeHtml(item.providerId)} / ${escapeHtml(item.modelTier)}</td><td>${item.runs}</td><td>${item.fallbackRate}</td><td>${item.averageLatencyMs ?? "n/a"}</td><td>${escapeHtml(item.recommendation)}</td></tr>
    `).join("");
    const failedRunRows = report.failedRuns.map((run) => `
      <tr><td><a href="/run?id=${encodeURIComponent(run.runId)}">${escapeHtml(run.runId.slice(0, 8))}</a></td><td>${escapeHtml(run.workflowId)}</td><td>${escapeHtml(run.task)}</td><td>${renderDashboardDateTime(run.startedAt)}</td><td><div class="actions">${queueRunActionForm(run.runId, "resolve-blocker", "Resolve Blocker")}<a class="button secondary" href="/run?id=${encodeURIComponent(run.runId)}">Inspect</a></div></td></tr>
    `).join("");
    const proposalRows = Object.entries(report.proposalPreview.byKind).map(([kind, count]) => `<tr><td>${escapeHtml(kind)}</td><td>${formatNumber(count)}</td></tr>`).join("");
    const learningRows = (learningQueue?.items ?? []).map((item) => {
      const actionButtons = item.status === "pending" ? `
        <form method="post" action="/api/learning-approval-decision" style="display:inline;margin-right:4px">
          <input type="hidden" name="project" value="${escapeHtml(localProjectDir)}">
          <input type="hidden" name="approvalId" value="${escapeHtml(item.id)}">
          <input type="hidden" name="decision" value="approved">
          <button type="submit" class="compact-button">Approve</button>
        </form>
        <form method="post" action="/api/learning-approval-decision" style="display:inline">
          <input type="hidden" name="project" value="${escapeHtml(localProjectDir)}">
          <input type="hidden" name="approvalId" value="${escapeHtml(item.id)}">
          <input type="hidden" name="decision" value="rejected">
          <button type="submit" class="compact-button secondary">Reject</button>
        </form>` : `<span class="muted">-</span>`;
      return `
      <tr><td>${escapeHtml(item.proposalId)}<br><span class="muted">${escapeHtml(item.id)}</span></td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.proposal.priority)} / ${escapeHtml(item.proposal.riskLevel)}</td><td>${escapeHtml(item.proposal.title)}<br><span class="muted">${escapeHtml(item.proposal.target)}</span></td><td>${escapeHtml(item.proposal.recommendation)}</td><td>${actionButtons}</td></tr>
    `;}).join("");
    const learningCounts = learningQueue ? countStrings(learningQueue.items.map((item) => item.status)) : {};
    const applicationRows = (learningApplicationPlan?.actions ?? []).map((action) => `
      <tr><td>${escapeHtml(action.id)}<br><span class="muted">${escapeHtml(action.proposalId)}</span></td><td>${escapeHtml(action.actionType)}</td><td>${escapeHtml(action.dangerGate)}</td><td>${action.writesOwnedLearningStateOnly ? "yes" : "no"}</td><td>${action.command ? `<code>${escapeHtml(action.command)}</code>` : "manual review"}</td></tr>
    `).join("");
    const proposalCommand = `npm run agentflow -- learning-proposals --project ${shellQuote(localProjectDir)} --write`;
    const applicationPlanCommand = `npm run agentflow -- learning-application-plan --project ${shellQuote(localProjectDir)} --write`;
    const daemonCommand = `npm run agentflow -- learning-daemon --project ${shellQuote(localProjectDir)} --mode apply-approved`;
    const shapeCommand = `npm run agentflow -- learning-workflow-shape --project ${shellQuote(localProjectDir)}${workflowShape ? ` --workflow ${shellQuote(workflowShape.workflowId)}` : ""} --write`;
    const list = (items: string[]) => `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
    return `
      <section class="panel">
        <div class="metric-grid">
          ${metricCard("Mode", report.autonomyMode, "owned learning writes")}
          ${metricCard("Runs", report.runsAnalyzed, formatInlineCounts(report.runStatusCounts) || "none")}
          ${metricCard("Feedback", formatInlineCounts(report.feedbackCounts) || "none", "approved user signal")}
          ${metricCard("Route Feedback", formatInlineCounts(report.routeFeedback.counts) || "none", report.routeFeedback.latestAt ? `latest ${formatDashboardDateTimeText(report.routeFeedback.latestAt)}` : "no route signals")}
          ${metricCard("Eval Runs", report.evaluationRuns, report.latestEvaluationAt ? `latest ${new Date(report.latestEvaluationAt).toLocaleDateString()}` : "none found")}
          ${metricCard("Failures", report.failedRuns.length, "recent failed runs")}
          ${metricCard("Proposal Preview", report.proposalPreview.total, `${report.proposalPreview.highPriority} high priority`)}
        </div>
        <p class="muted">Generated ${renderDashboardDateTime(report.generatedAt)} for ${escapeHtml(report.projectDir)}.</p>
      </section>
      ${renderLearningSupervisorTargetHtml(localProjectDir, supervisor)}
      ${renderLearningRouteFeedbackHtml(report.routeFeedback)}
      <section class="panel">
        <div class="section-heading"><div><h2>Learning Daemon</h2><span class="muted">Local autonomous loop over Agent Workflow-owned learning state.</span></div></div>
        ${learningDaemon ? renderLearningDaemonStatusHtml(learningDaemon, supervisor) : `<p class="muted">No project selected.</p>`}
        <p class="muted">Start autonomous mode with <code>${escapeHtml(daemonCommand)}</code>. It auto-applies low/medium-risk Agent Workflow-owned local optimization files by default, including project-local tuning overlays. High-risk source, provider, command, network, reusable bundle, and export changes still require approval.</p>
      </section>
      ${report.failureTriage ? renderLearningFailureTriageHtml(report.failureTriage) : ""}
      ${renderDaemonControl({ project: report.projectDir, limit: report.limit, workflow: workflowShape?.workflowId ?? "", trust: daemonTrustLevels, shapeAutoUpdate, agentAutoApply: agentImprovementProjectLocalAutoApply, autonomousMaxRisk: autonomousApplyMaxRisk, autopilotEnabled: approvalAutopilotEnabled, autopilotMaxRisk: approvalAutopilotMaxRisk })}
      ${workflowShape ? renderWorkflowShapeOptimizationHtml(workflowShape, shapeCommand, shapeAutoUpdate, agentImprovementProjectLocalAutoApply, autonomousApplyMaxRisk, approvalAutopilotEnabled, approvalAutopilotMaxRisk, daemonTrustLevels) : ""}
      ${agentImprovement ? renderAgentImprovementHtml(agentImprovement, agentImprovementEval, agentImprovementPromotion) : ""}
      <section class="panel">
        <div class="section-heading"><div><h2>Autonomy Boundary</h2><span class="muted">The learning daemon should keep working automatically until an action becomes dangerous.</span></div></div>
        <div class="split-grid">
          <div><h3>Automatic</h3>${list(report.safeAutomaticActions)}</div>
          <div><h3>Requires Approval</h3>${list(report.approvalRequiredActions)}</div>
        </div>
      </section>
      <section class="panel"><h2>Evaluation Gaps</h2>${list(report.evalGaps)}</section>
      <section class="panel"><h2>Repeated Failure Patterns</h2><div class="table-wrap"><table><thead><tr><th>Workflow</th><th>Stage</th><th>Agent</th><th>Failures</th><th>Rate</th></tr></thead><tbody>${failureRows || "<tr><td colspan=\"5\">No repeated failure patterns found.</td></tr>"}</tbody></table></div></section>
      <section class="panel"><h2>Cost And Routing Opportunities</h2><div class="table-wrap"><table><thead><tr><th>Workflow</th><th>Agent</th><th>Provider/Tier</th><th>Runs</th><th>Fallback</th><th>Latency</th><th>Recommendation</th></tr></thead><tbody>${costRows || "<tr><td colspan=\"7\">No cost or routing opportunities found.</td></tr>"}</tbody></table></div></section>
      <section class="panel"><div class="section-heading"><div><h2>Recent Failed Runs</h2><span class="muted">Refresh context and resume the same durable run without creating a repair chain.</span></div><a class="button secondary" href="/queue">Open Queue</a></div><div class="table-wrap"><table><thead><tr><th>Run</th><th>Workflow</th><th>Task</th><th>Started</th><th>Actions</th></tr></thead><tbody>${failedRunRows || "<tr><td colspan=\"5\">No failed runs in the inspected window.</td></tr>"}</tbody></table></div></section>
      <section class="panel"><h2>Proposal Preview</h2><div class="table-wrap"><table><thead><tr><th>Kind</th><th>Count</th></tr></thead><tbody>${proposalRows || "<tr><td colspan=\"2\">No proposal candidates yet.</td></tr>"}</tbody></table></div></section>
      <section class="panel">
        <div class="section-heading"><div><h2>Learning Proposal Inbox</h2><span class="muted">${learningQueue ? `pending=${learningCounts.pending ?? 0} approved=${learningCounts.approved ?? 0} rejected=${learningCounts.rejected ?? 0}` : "No local inbox written yet."}</span></div></div>
        <p class="muted">Generate the inbox with <code>${escapeHtml(proposalCommand)}</code>. Low/medium-risk items auto-approve in autonomous mode; high-risk items wait here for review.</p>
        <div class="table-wrap"><table><thead><tr><th>Proposal</th><th>Status</th><th>Priority/Risk</th><th>Target</th><th>Recommendation</th><th>Actions</th></tr></thead><tbody>${learningRows || "<tr><td colspan=\"5\">No learning proposal inbox found.</td></tr>"}</tbody></table></div>
      </section>
      <section class="panel">
        <div class="section-heading"><div><h2>Approved Application Plan</h2><span class="muted">${learningApplicationPlan ? `${learningApplicationPlan.actions.length} planned action(s)` : "No approved application plan yet."}</span></div></div>
        <p class="muted">Generate a saved plan with <code>${escapeHtml(applicationPlanCommand)}</code>. The daemon applies safe local overlay actions automatically and leaves high-risk actions gated.</p>
        <div class="table-wrap"><table><thead><tr><th>Action</th><th>Type</th><th>Gate</th><th>Owned State Only</th><th>Command</th></tr></thead><tbody>${applicationRows || "<tr><td colspan=\"5\">No approved learning proposals selected for application planning.</td></tr>"}</tbody></table></div>
      </section>
      ${learningActionReceiptHealth ? renderLearningActionReceiptHealthHtml(learningActionReceiptHealth, report.limit, workflowShape?.workflowId ?? "") : ""}
      ${learningActionReceipts ? renderLearningActionReceiptsHtml(learningActionReceipts, report.limit) : ""}
      <section class="panel"><h2>Privacy Boundaries</h2>${list(report.privacyBoundaries)}</section>
      <section class="panel"><h2>Next Commands</h2>${list(report.nextCommands)}</section>
    `;
  }

  function renderLearningRouteFeedbackHtml(summary: LearningRouteFeedbackSummary): string {
    const row = (group: LearningRouteFeedbackGroup) => `
      <tr>
        <td>${escapeHtml(group.target)}<br><span class="muted">${escapeHtml(group.route)}</span></td>
        <td>${escapeHtml(group.routeClass)}</td>
        <td>${formatNumber(group.total)}</td>
        <td>${group.helpful}/${group.costly}/${group.neutral}</td>
        <td>${renderDashboardDateTime(group.latestAt)}</td>
      </tr>
    `;
    const costlyRows = summary.costlyGroups.map(row).join("");
    const helpfulRows = summary.helpfulGroups.map(row).join("");
    return `
      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>Route Feedback Signals</h2>
            <span class="muted">Helpful/costly route decisions from the model-improvement drilldown.</span>
          </div>
          <span class="status ${summary.costlyGroups.length ? "queued" : summary.total ? "completed" : "queued"}">${formatNumber(summary.total)} signal(s)</span>
        </div>
        <div class="split-grid">
          <div>
            <h3>Costly Routes</h3>
            <div class="table-wrap"><table><thead><tr><th>Target</th><th>Class</th><th>Total</th><th>H/C/N</th><th>Latest</th></tr></thead><tbody>${costlyRows || "<tr><td colspan=\"5\">No costly route feedback yet.</td></tr>"}</tbody></table></div>
          </div>
          <div>
            <h3>Helpful Routes</h3>
            <div class="table-wrap"><table><thead><tr><th>Target</th><th>Class</th><th>Total</th><th>H/C/N</th><th>Latest</th></tr></thead><tbody>${helpfulRows || "<tr><td colspan=\"5\">No helpful route feedback yet.</td></tr>"}</tbody></table></div>
          </div>
        </div>
      </section>
    `;
  }

  function renderLearningSupervisorTargetHtml(projectDir: string, supervisor: DashboardSupervisorStatus): string {
    const allProjects = supervisor.learningScope === "all-projects";
    const targetMatches = allProjects || supervisor.learningProject === projectDir;
    const statusText = supervisor.learningEnabled
      ? allProjects ? "watching all registered projects" : targetMatches ? "watching this project" : supervisor.learningProject ? "watching another project" : "enabled without target"
      : "disabled";
    return `
      <section class="panel compact-panel">
        <div class="section-heading">
          <div>
            <h2>Durable Learning Target</h2>
            <span class="muted">LaunchAgent supervision can keep one local learning daemon durable by default.</span>
          </div>
          <form method="post" action="/api/learning-daemon-target" class="inline-form compact-form">
            <input type="hidden" name="project" value="${escapeHtml(projectDir)}">
            <input type="hidden" name="mode" value="apply-approved">
            <input type="hidden" name="scope" value="all-projects">
            <button type="submit" class="secondary">${allProjects ? "Refresh All Projects" : "Watch All Projects"}</button>
          </form>
          <form method="post" action="/api/learning-daemon-target" class="inline-form compact-form">
            <input type="hidden" name="project" value="${escapeHtml(projectDir)}">
            <input type="hidden" name="mode" value="apply-approved">
            <input type="hidden" name="scope" value="project">
            <button type="submit" class="secondary">${targetMatches ? "Refresh Durable Target" : "Watch This Project"}</button>
          </form>
        </div>
        <div class="meta-grid compact">
          <div><strong>Status</strong>${escapeHtml(statusText)}</div>
          <div><strong>Supervisor</strong>${escapeHtml(supervisor.status)}</div>
          <div><strong>Scope</strong>${escapeHtml(supervisor.learningScope ?? "n/a")}</div>
          <div><strong>Current Target</strong>${escapeHtml(supervisor.learningProject ?? "none")}</div>
          <div><strong>Selected Project</strong>${escapeHtml(projectDir)}</div>
          <div><strong>Mode</strong>${escapeHtml(supervisor.learningMode ?? "n/a")}</div>
        </div>
        ${targetMatches ? "" : `<p class="warn-box">The selected project can still show historical learning evidence, but its daemon heartbeat is missing because the durable supervisor is currently watching ${escapeHtml(supervisor.learningProject ?? "no project")}.</p>`}
      </section>
    `;
  }

  function renderObjectArtifactProofPanel(report: ObjectArtifactProofReport, params: URLSearchParams): string {
    const statusClass = report.status === "verified" || report.status === "metadata-only" ? "completed" : report.status === "missing" ? "failed" : "queued";
    const query = new URLSearchParams();
    if (report.projectRootUri) query.set("project", report.projectRootUri);
    query.set("limit", String(report.limit));
    const verifyQuery = new URLSearchParams(query);
    verifyQuery.set("verify", "1");
    const sampleRows = report.objects.slice(0, 12).map((object) => `<tr>
      <td><span class="status ${object.status === "present" ? "completed" : object.status === "missing" ? "failed" : "queued"}">${escapeHtml(object.status)}</span></td>
      <td><code>${escapeHtml(object.key)}</code><br><span class="muted">${escapeHtml(object.source)}</span></td>
      <td>${escapeHtml(object.artifactKind)}<br><code>${escapeHtml(object.artifactUri)}</code></td>
      <td>${escapeHtml(object.message)}</td>
    </tr>`).join("");
    const warnings = report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
    const recommendations = report.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    const bucket = report.bucketParity;
    const bucketStatusClass = bucket?.status === "verified" ? "completed" : bucket?.status === "missing" ? "failed" : "queued";
    const missingRows = bucket?.sampledMissingKeys.map((key) => `<li><code>${escapeHtml(key)}</code></li>`).join("") ?? "";
    const mirrorRows = bucket?.mirrorPlan.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("") ?? "";
    const queueMirrorForm = bucket?.status === "missing" && bucket.missingInTarget > 0 ? `
      <form method="post" action="/api/object-mirror-approval" class="inline-form compact-form">
        ${dashboardReturnInput("/server-readiness", params)}
        <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri ?? ctx.rootDir)}">
        <input type="hidden" name="objectLimit" value="${escapeHtml(String(report.limit))}">
        <input type="hidden" name="sourceEndpoint" value="${escapeHtml(bucket.sourceEndpoint)}">
        <input type="hidden" name="sourceBucket" value="${escapeHtml(bucket.sourceBucket)}">
        <input type="hidden" name="targetEndpoint" value="${escapeHtml(bucket.targetEndpoint)}">
        <input type="hidden" name="targetBucket" value="${escapeHtml(bucket.targetBucket)}">
        <label>Actor role<input name="actorRole" value="operator"></label>
        <button type="submit">Queue Mirror Approval</button>
      </form>` : "";
    return `<section class="panel">
      <div class="section-heading">
        <div><h2>Object Artifact Proof</h2><span class="muted">Read-only proof for object-backed artifact references after storage merge.</span></div>
        <div class="actions"><a class="button secondary" href="/api/object-artifact-proof?${escapeHtml(query.toString())}">JSON</a><a class="button secondary" href="/api/object-artifact-proof?${escapeHtml(verifyQuery.toString())}">Verify JSON</a></div>
      </div>
      <div class="metric-grid">
        ${metricCard("Status", report.status, "object reference proof")}
        ${metricCard("Artifacts", report.inspectedArtifacts, "recent rows inspected")}
        ${metricCard("Object Refs", report.referencedObjects, "references discovered")}
        ${metricCard("Missing", report.missingObjects, "verified missing objects")}
        ${metricCard("Bucket Parity", bucket ? bucket.status : "not checked", bucket ? `${bucket.missingInTarget} missing` : "optional mc enumeration")}
      </div>
      <div class="meta-grid compact">
        <div><strong>Endpoint</strong>${escapeHtml(report.endpoint)}</div>
        <div><strong>Bucket</strong>${escapeHtml(report.bucket)}</div>
        <div><strong>Verification</strong><span class="status ${statusClass}">${escapeHtml(report.verification)}</span></div>
        <div><strong>Generated</strong>${renderDashboardDateTime(report.generatedAt)}</div>
      </div>
      <form method="get" action="/server-readiness" class="inline-form compact-form">
        ${[...params.entries()].filter(([key]) => key !== "objectLimit" && key !== "verifyObjects").map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join("")}
        <label>Object limit<input name="objectLimit" inputmode="numeric" value="${escapeHtml(String(report.limit))}"></label>
        <label class="check-row"><input type="checkbox" name="verifyObjects" value="1"> Verify with mc</label>
        <label class="check-row"><input type="checkbox" name="enumerateBuckets" value="1"> Enumerate buckets</label>
        <button type="submit">Refresh Object Proof</button>
      </form>
      ${bucket ? `<div class="meta-grid compact">
        <div><strong>Bucket Status</strong><span class="status ${bucketStatusClass}">${escapeHtml(bucket.status)}</span><br><span class="muted">${escapeHtml(bucket.message)}</span></div>
        <div><strong>Source Bucket</strong>${escapeHtml(bucket.sourceEndpoint)}<br>${escapeHtml(bucket.sourceBucket)} (${formatNumber(bucket.sourceObjects)} object(s))</div>
        <div><strong>Target Bucket</strong>${escapeHtml(bucket.targetEndpoint)}<br>${escapeHtml(bucket.targetBucket)} (${formatNumber(bucket.targetObjects)} object(s))</div>
        <div><strong>Delta</strong>${formatNumber(bucket.missingInTarget)} missing<br><span class="muted">${formatNumber(bucket.extraInTarget)} extra in target</span></div>
        <div><strong>Verifier</strong><span class="status ${bucket.verifier === "unavailable" ? "queued" : "completed"}">${escapeHtml(bucket.verifier)}</span></div>
      </div>
      ${missingRows ? `<details class="governance-details" open><summary>Sample Missing Keys</summary><ul>${missingRows}</ul></details>` : ""}
      <details class="governance-details"><summary>Dry-Run Mirror Plan</summary><ul>${mirrorRows}</ul></details>
      ${queueMirrorForm}` : ""}
      ${warnings ? `<details class="governance-details" open><summary>Warnings</summary><ul>${warnings}</ul></details>` : ""}
      ${recommendations ? `<details class="governance-details"><summary>Recommendations</summary><ul>${recommendations}</ul></details>` : ""}
      <div class="table-wrap"><table><thead><tr><th>Status</th><th>Object Key</th><th>Artifact</th><th>Detail</th></tr></thead><tbody>${sampleRows || '<tr><td colspan="4">No object-backed artifact references found in inspected rows.</td></tr>'}</tbody></table></div>
    </section>`;
  }

  function renderOpsAgentFlow(queue: DashboardQueueItem[], historicalRuns: DashboardRunStatus[], workAvailable = true): string {
    const flows = queue.filter((item) => item.runningAgentId || item.nextAgentId).slice(0, 5);
    if (!flows.length) return '<div class="ops-empty"><strong>No active handoffs</strong><span>Agent transitions appear here while workflows execute.</span></div>';
    return `<div class="ops-flow-list">${flows.map((item) => { const eta = estimateQueueItemEta(item, historicalRuns, workAvailable); return `<a href="/run?id=${encodeURIComponent(item.runId)}"><span class="ops-agent-node current">${escapeHtml(item.runningAgentId ?? "queued")}</span><span class="ops-flow-trace"><i></i>${dashboardIcon("chevrons")}</span><span class="ops-agent-node next">${escapeHtml(item.nextAgentId ?? "complete")}</span><small>${escapeHtml(compactDashboardText(item.task, 46))} · ETA ${escapeHtml(formatRunEta(eta))}</small></a>`; }).join("")}</div>`;
  }

  function renderOpsDurationChart(runs: DashboardRunStatus[]): string {
    const samples = [...runs].reverse().slice(-16).map((run) => dashboardRunDurationMs(run) ?? 0);
    if (!samples.length) return '<div class="ops-empty"><strong>No duration evidence</strong><span>Finished runs will populate this chart.</span></div>';
    const width = 720;
    const height = 170;
    const max = Math.max(...samples, 1);
    const points = samples.map((value, index) => `${30 + (index / Math.max(samples.length - 1, 1)) * (width - 50)},${height - 24 - (value / max) * (height - 52)}`).join(" ");
    const area = `30,${height - 24} ${points} ${width - 20},${height - 24}`;
    return `<div class="ops-line-chart"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Recent workflow run duration trend"><g class="ops-grid-lines"><path d="M30 20H${width - 20}"></path><path d="M30 ${height / 2}H${width - 20}"></path><path d="M30 ${height - 24}H${width - 20}"></path></g><polygon points="${area}"></polygon><polyline points="${points}"></polyline></svg><div class="ops-axis-labels"><span>${escapeHtml(formatDashboardDuration(max))}</span><span>${escapeHtml(formatDashboardDuration(Math.round(max / 2)))}</span><span>0s</span></div></div>`;
  }

  function renderOpsMetric(label: string, value: string, detail: string, samples: number[], tone: "cyan" | "teal" | "violet" | "amber", href?: string): string {
    const inner = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small>${renderOpsSparkline(samples, tone)}`;
    return href ? `<a class="ops-metric" href="${escapeHtml(href)}">${inner}</a>` : `<div class="ops-metric">${inner}</div>`;
  }

  function renderOpsProjectActivity(projects: DashboardProjectSummary[]): string {
    const top = [...projects].sort((a, b) => b.runCount - a.runCount).slice(0, 6);
    const max = Math.max(...top.map((project) => project.runCount), 1);
    return `<div class="ops-project-bars">${top.map((project) => `<a href="/projects?project=${encodeURIComponent(project.rootUri)}"><span>${escapeHtml(compactDashboardText(project.name, 22))}</span><i><b style="width:${(project.runCount / max) * 100}%"></b></i><strong>${formatNumber(project.runCount)}</strong></a>`).join("") || '<div class="ops-empty">No project activity</div>'}</div>`;
  }


  function renderOpsQueuePressure(queue: DashboardQueueItem[]): string {
    const queued = queue.reduce((sum, item) => sum + item.queuedTasks, 0);
    const running = queue.reduce((sum, item) => sum + item.runningTasks, 0);
    const failed = queue.reduce((sum, item) => sum + item.failedTasks, 0);
    const active = queue.filter((item) => item.runStatus === "queued" || item.runStatus === "running" || item.runStatus === "leased");
    const oldestMs = active.length ? Math.max(...active.map((item) => Date.now() - Date.parse(item.oldestRunningAt ?? item.oldestQueuedAt ?? item.startedAt)).filter(Number.isFinite)) : 0;
    const total = Math.max(queued + running + failed, 1);
    return `<div class="ops-queue-summary"><div><span>Queue depth</span><strong>${queued + running}</strong><small>${running} running · ${queued} waiting</small></div><div><span>Oldest active</span><strong>${formatDashboardDuration(oldestMs)}</strong><small>${failed} failed stage${failed === 1 ? "" : "s"}</small></div></div><div class="ops-pressure-bar"><i class="running" style="width:${(running / total) * 100}%"></i><i class="queued" style="width:${(queued / total) * 100}%"></i><i class="failed" style="width:${(failed / total) * 100}%"></i></div><div class="ops-legend"><span><i class="running"></i>Running</span><span><i class="queued"></i>Queued</span><span><i class="failed"></i>Failed</span></div>`;
  }

  function renderOpsSparkline(values: number[], tone: "cyan" | "teal" | "violet" | "amber"): string {
    const samples = values.length > 1 ? values : [0, ...(values.length ? values : [0])];
    const max = Math.max(...samples, 1);
    const points = samples.map((value, index) => `${(index / Math.max(samples.length - 1, 1)) * 92 + 2},${28 - (value / max) * 22}`).join(" ");
    return `<svg class="ops-spark ${tone}" viewBox="0 0 96 32" aria-hidden="true"><polyline points="${points}"></polyline></svg>`;
  }

  function renderOpsStatusChart(runs: DashboardRunStatus[]): string {
    const counts = runStateCounts(runs);
    const { completed, failed, blocked } = counts;
    const active = counts.active + counts.other;
    const total = Math.max(runs.length, 1);
    const completedStop = Math.round((completed / total) * 100);
    const failedStop = completedStop + Math.round((failed / total) * 100);
    const blockedStop = failedStop + Math.round((blocked / total) * 100);
    const key = (state: string, label: string, count: number, href: string) => `<a href="${href}"><i class="${state}"></i><span>${label}</span><strong>${count}</strong></a>`;
    return `<div class="ops-donut-layout"><div class="ops-donut" style="--completed:${completedStop}%;--failed:${failedStop}%;--blocked:${blockedStop}%"><span><strong>${runs.length}</strong><small>runs</small></span></div><div class="ops-donut-key">${key("completed", "Completed", completed, "/runs?status=completed")}${key("failed", "Failed", failed, "/runs?status=failed")}${key("blocked", "Blocked", blocked, "/runs?status=blocked")}${key("active", "Active", active, "/runs?status=active")}</div></div>`;
  }

  function renderOpsThroughputChart(buckets: WorkflowThroughputBucket[]): string {
    const max = Math.max(...buckets.map((bucket) => bucket.completed + bucket.failed + bucket.blocked + bucket.active), 1);
    const bars = buckets.map((bucket) => {
      const total = bucket.completed + bucket.failed + bucket.blocked + bucket.active;
      const label = new Date(`${bucket.key}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      return `<div class="ops-throughput-column" title="${escapeHtml(label)}: ${total} run(s)"><div class="ops-stacked-bar" style="--bar-height:${Math.max(8, Math.round((total / max) * 100))}%"><i class="completed" style="--share:${total ? bucket.completed / total : 0}"></i><i class="failed" style="--share:${total ? bucket.failed / total : 0}"></i><i class="blocked" style="--share:${total ? bucket.blocked / total : 0}"></i><i class="active" style="--share:${total ? bucket.active / total : 0}"></i></div><span>${escapeHtml(label)}</span></div>`;
    }).join("");
    return `<div class="ops-chart-frame"><div class="ops-y-labels"><span>${max}</span><span>${Math.ceil(max / 2)}</span><span>0</span></div><div class="ops-throughput-bars">${bars || '<div class="ops-empty">No run data</div>'}</div></div><div class="ops-legend"><span><i class="completed"></i>Completed</span><span><i class="failed"></i>Failed</span><span><i class="blocked"></i>Blocked</span><span><i class="active"></i>Active</span></div>`;
  }

  function renderQueueHtml(queue: DashboardQueueItem[], projectFilter: string | undefined, flash: {notice?:string;error?:string;actionRun?:string}, historicalRuns: DashboardRunStatus[], partnerProjects: Array<{id:string;name:string;rootUri:string}>, partnerHistory:Record<string,QueuePartnerHistorySummary>={}, workAvailable = true): string {
    const resolvedProjectFilter = projectFilter ?? "";
    const active = queue.filter((item) => queueLifecyclePresentation(item).active
      || item.familyAttempts?.some(attempt => ["queued","leased","running"].includes(attempt.status)));
    const recoveryActiveStatuses = new Set(["queued", "leased", "running"]);
    const recovering = queue.filter((item) =>
      (item.runStatus === "failed" || item.runStatus === "blocked")
      && !item.relatedRunCount
      && Boolean(item.recoveryRunId)
      && recoveryActiveStatuses.has(item.recoveryRunStatus ?? "")
    );
    const recoveringRunIds = new Set(recovering.map((item) => item.runId));
    const failed = queue.filter((item) => (item.runStatus === "failed" || item.familyAttempts?.some(attempt => attempt.status === "failed"))
      && !recoveringRunIds.has(item.runId));
    const blocked = queue.filter((item) => item.runStatus === "blocked" && !recoveringRunIds.has(item.runId));
    const expiredLeaseRows = queue.filter((item) => hasExpiredLease(item));
    const cards = queue.filter((item) => !recoveringRunIds.has(item.runId)).map((item) => {
      const lifecycle = queueLifecyclePresentation(item);
      const historyHref = item.relatedRunCount
        ? `/runs?relatedTo=${encodeURIComponent(item.runId)}`
        : `/runs?runSet=${encodeURIComponent(item.runSetId)}`;
      const earlierReview = (item.relatedOpenRunCount ?? 0) > 0
        ? `<div class="queue-card-callout warn">${dashboardIcon("warning")}<span><strong>Earlier attempts need review</strong><small>${formatNumber(item.relatedOpenRunCount ?? 0)} earlier unfinished attempt(s). Grouping is not acceptance or dismissal; <a href="${historyHref}">review history and approvals</a>.</small></span></div>`
        : "";
      const familyApprovalCount = item.familyAttempts?.reduce((count,attempt) => count + attempt.approvals.length,0) ?? 0;
      const attemptsPanel = item.familyAttempts?.length
        ? `<details class="queue-family-attempts" style="overflow-wrap:anywhere;min-width:0"><summary>All ${formatNumber(item.familyAttempts.length)} attempts in this version set${familyApprovalCount ? ` · ${formatNumber(familyApprovalCount)} approval record(s) need review` : ""}</summary><p class="muted">Original statuses, blockers and approvals are retained. Grouping does not complete or dismiss work.</p><ol>${item.familyAttempts.map(attempt => `<li><a href="/run?id=${encodeURIComponent(attempt.id)}">${escapeHtml(attempt.id.slice(0,8))}</a> · ${escapeHtml(attempt.status)}${attempt.blocker ? `<p>${escapeHtml(redactApprovalCardText(attempt.blocker,2000))}</p>` : ""}${attempt.approvals.length ? `<p>${attempt.approvals.map(approval => `<a href="/run?id=${encodeURIComponent(attempt.id)}">Approval ${escapeHtml(approval.id.slice(0,8))}: ${escapeHtml(approval.status)}</a>`).join(" · ")}</p>` : ""}</li>`).join("")}</ol></details>`
        : "";
      const deliverableTitle = buildQueueCardTitle(item);
      const versionSetId = item.versionSetId ?? item.runSetId;
      const eta = estimateQueueItemEta(item, historicalRuns, workAvailable);
      const latency = queueLatencyBudget(item);
      const taskSummary = `${item.completedTasks}/${item.totalTasks} done, ${item.queuedTasks} queued, ${item.runningTasks} worker-leased, ${item.failedTasks} failed`;
      const currentStage = item.runningStageId
        ? `${item.runningStageId} (${item.runningAgentId ?? "unknown"})`
        : item.nextStageId
          ? `${item.nextStageId} (${item.nextAgentId ?? "unknown"})`
          : "none";
      const leaseDetail = item.runningWorkerId
        ? `execution unconfirmed; worker lease: ${item.runningWorkerId}${item.runningLeaseExpiresAt ? `; expires ${renderDashboardDateTime(item.runningLeaseExpiresAt)}` : ""}`
        : item.runningTasks > 0
          ? "execution unconfirmed; worker lease owner unknown"
          : "worker: none";
      const activeLabel = item.approvalWait ? "Awaiting approval" : item.runningStageId
        ? `Running ${item.runningStageId}`
        : item.nextStageId
          ? `Up next: ${item.nextStageId}`
          : item.runStatus === "failed"
            ? "Needs review"
            : item.runStatus === "blocked"
              ? "Blocked"
            : "Waiting to start";
      const activeAgent = item.runningAgentId ?? item.nextAgentId;
      const stageDots = Array.from({ length: Math.max(item.totalTasks, 1) }, (_, index) => {
        const step = index + 1;
        const state = index < item.completedTasks
          ? "completed"
          : item.failedTasks > 0 && index === item.completedTasks
            ? "failed"
            : item.runStatus === "blocked" && index === item.completedTasks
              ? "blocked"
            : item.runningTasks > 0 && index === item.completedTasks
              ? "running"
              : "pending";
        return `<span class="queue-stage-dot ${state}" title="Stage ${step}: ${state}"><span>${step}</span></span>`;
      }).join("");
      const attention = item.runStatus === "blocked"
        ? `<div class="queue-card-callout warn">${dashboardIcon("warning")}<span><strong>Blocked</strong><small>${escapeHtml(item.blockedReason ?? "This run needs a decision or resolved dependency before it can continue.")}</small></span></div>`
        : item.failedTasks > 0 || item.runStatus === "failed"
        ? `<div class="queue-card-callout bad">${dashboardIcon("warning")}<span><strong>Failed</strong><small>${escapeHtml(item.failedReason?.trim() || `${formatNumber(item.failedTasks || 1)} stage${(item.failedTasks || 1) === 1 ? "" : "s"} failed without a recorded reason.`)}</small></span></div>`
        : hasExpiredLease(item)
          ? `<div class="queue-card-callout warn">${dashboardIcon("warning")}<span><strong>Worker lease expired</strong><small>Recovery is available without losing completed stages.</small></span></div>`
          : lifecycle.key === "stale"
            ? `<div class="queue-card-callout warn">${dashboardIcon("warning")}<span><strong>Lifecycle needs reconciliation</strong><small>${escapeHtml(lifecycle.explanation)} Historical evidence is preserved.</small></span></div>`
          : "";
      const waiting = lifecycle.key === "waiting" && item.waitReason
        ? `<div class="queue-card-callout ${item.waitReason.overdue ? "warn" : ""}">${dashboardIcon(item.waitReason.overdue ? "warning" : "activity")}<span><strong>${item.waitReason.overdue ? "Wait budget exceeded" : "Waiting"}</strong><small>${escapeHtml(item.waitReason.reason)} · ${formatDuration(item.waitReason.waitedMs)} elapsed / ${formatDuration(item.waitReason.budgetMs)} budget.</small></span></div>`
        : "";
      const latencyAlert = ["running","stale"].includes(lifecycle.key) && latency.status !== "within"
        ? `<div class="queue-card-callout warn">${dashboardIcon("warning")}<span><strong>${latency.status === "overdue" ? "Time budget exceeded" : "Time budget nearly used"}</strong><small>${escapeHtml(latency.phase)} · ${formatDuration(latency.elapsedMs)} elapsed / ${formatDuration(latency.budgetMs)} ${escapeHtml(latency.workClass)} budget.</small></span></div>`
        : "";
      const callback = item.codeFixCallback;
      const callbackLabel = callback?.state === "acknowledged" ? "Requester acknowledged"
        : callback?.state === "transport_accepted" ? "Transport accepted"
        : callback?.state === "delivery_uncertain" ? "Delivery uncertain"
        : callback?.state === "delivery_failed" ? "Delivery retry pending"
        : callback ? "Callback queued" : null;
      const callbackCallout = callback && callbackLabel
        ? `<div class="queue-card-callout ${callback.state === "delivery_failed" || callback.state === "delivery_uncertain" ? "warn" : ""}">${dashboardIcon(callback.state === "acknowledged" ? "check" : "activity")}<span><strong>Verified fix callback: ${escapeHtml(callbackLabel)}</strong><small>Verification, transport acceptance, and requester acknowledgment are separate evidence. Notification ${escapeHtml(callback.notificationId.slice(0,8))}.</small></span></div>`
        : "";
      const ownership = item.failureOwnership;
      const ownerLabel = ownership?.owner === "agent-workflow-runtime" ? "Agent Workflow runtime"
        : ownership?.owner === "product-source" ? `${item.projectName} product source`
        : ownership?.owner === "project-policy" ? "Project policy"
        : ownership?.owner === "external-native" ? "External/native evidence"
        : ownership ? "Unclassified" : null;
      const ownershipCallout = ownership && ownerLabel
        ? `<div class="queue-card-callout ${ownership.owner === "unknown" ? "warn" : ""}">${dashboardIcon(ownership.codeFix ? "file" : "info")}<span><strong>Failure owner: ${escapeHtml(ownerLabel)}</strong><small>${escapeHtml(ownership.reason)} · route: ${escapeHtml(ownership.repairRoute)} · ${escapeHtml(ownership.confidence)} confidence; evidence run ${escapeHtml(ownership.evidenceRunId.slice(0,8))}. Classification grants no repair or replay authority.</small></span></div>`
        : "";
      const runtimeRemedy = item.runtimeRemedy as (typeof item.runtimeRemedy&{remoteFleetTrust?:NonNullable<DashboardWorkerStatus["remoteFleetTrust"]>})|null;
      const probeDetail = runtimeRemedy?.latestProbe
        ? ` Latest probe ${runtimeRemedy.latestProbe.status} on runtime ${runtimeRemedy.latestProbe.runtimeVersion} (${runtimeRemedy.latestProbe.workerState}, digest ${runtimeRemedy.latestProbe.digest.slice(0,12)})${runtimeRemedy.latestProbe.reason ? `: ${runtimeRemedy.latestProbe.reason}` : "."}`
        : " No capability probe has been recorded.";
      const remoteFleetTrust=runtimeRemedy?.remoteFleetTrust??[];
      const fleetTransportDelayed=remoteFleetTrust.filter(host=>host.state==="transport-delayed"||host.state==="not-delivered");
      const fleetWorkerUnhealthy=remoteFleetTrust.filter(host=>host.state==="worker-stale"||host.state==="untrusted"||host.state==="disabled");
      const fleetDetail=remoteFleetTrust.length
        ? ` Fleet delivery: ${remoteFleetTrust.map(host=>`${host.hostId} ${host.state} (sequence ${host.sequence??"none"}, delivery ${host.deliveryLagMs===null?"n/a":formatDuration(host.deliveryLagMs)}, worker ${host.workerFreshnessMs===null?"n/a":formatDuration(host.workerFreshnessMs)}, build ${host.runtimeBuildDigest?.slice(0,12)??"none"}, key ${host.keyLifecycle})`).join("; ")}. ${fleetTransportDelayed.length?`Heartbeat transport delayed for ${fleetTransportDelayed.map(host=>host.hostId).join(", ")}; this does not prove the worker itself is unhealthy. `:""}${fleetWorkerUnhealthy.length?`Worker or trust health needs attention for ${fleetWorkerUnhealthy.map(host=>host.hostId).join(", ")}. `:""}`
        : " No enrolled remote fleet heartbeat has been delivered; local worker evidence remains separate.";
      const remedyCallout = runtimeRemedy
        ? `<div class="queue-card-callout ${runtimeRemedy.state === "awaiting-worker-rollout" ? "warn" : ""}">${dashboardIcon(runtimeRemedy.state === "compatible-worker-active" ? "check" : "warning")}<span><strong>${runtimeRemedy.state === "compatible-worker-active" ? "Compatible worker runtime active" : "Runtime fix awaiting worker rollout"}</strong><small>Required capability ${escapeHtml(runtimeRemedy.requiredCapability)}${runtimeRemedy.workerIds.length ? ` attested by ${escapeHtml(runtimeRemedy.workerIds.join(", "))}` : " is not attested by an eligible worker"}. ${escapeHtml(runtimeRemedy.eligibilityReason)}${escapeHtml(probeDetail)}${escapeHtml(fleetDetail)} This readiness check does not authorize replay.</small></span></div>`
        : "";
      return `
        <article class="queue-card queue-status-${escapeHtml(lifecycle.key)}" data-queue-card-key="${escapeHtml(`${item.projectRootUri}:${item.versionSetId ?? item.runSetId}`)}">
          <div class="queue-card-header">
            <div class="queue-card-title">
              <div class="queue-card-eyebrow"><span class="status ${escapeHtml(lifecycle.key)}" title="${escapeHtml(lifecycle.explanation)}">${escapeHtml(lifecycle.label)}</span><span>${escapeHtml(item.projectName)}</span><span>${escapeHtml(item.workflowId)}</span></div>
              <h2><a href="/run?id=${encodeURIComponent(item.runId)}">${escapeHtml(deliverableTitle)}</a></h2>
              ${renderQueueCardActivityLine(item.runId,item.liveActivity?.text ?? currentStage)}
              <p class="muted"><strong>Version set</strong> <a href="${historyHref}" title="Open this version set">${escapeHtml(versionSetId)}</a> · card ${escapeHtml(item.runId.slice(0, 8))}</p>
              <p class="muted">Started ${renderDashboardDateTime(item.startedAt)}</p>
            </div>
            <div class="actions"><a class="button secondary" href="${historyHref}">${iconLabel("layers", "Open history")}</a><a class="button secondary" href="/run?id=${encodeURIComponent(item.runId)}">${iconLabel("activity", "Open run")}</a></div>
          </div>
          ${attention}
          ${renderApprovalWait(item.approvalWait,isExecutableApprovalAction)}
          ${waiting}
          ${latencyAlert}
          ${callbackCallout}
          ${ownershipCallout}
          ${remedyCallout}
          ${earlierReview}
          ${attemptsPanel}
          ${renderQueuePartnerHistory(partnerHistory[item.runId])}
          <div class="queue-stage-summary">
            <div class="queue-stage-heading"><span><strong>${formatNumber(item.completedTasks)} of ${formatNumber(item.totalTasks)} stages complete</strong><small>${escapeHtml(activeLabel)}${activeAgent ? ` · ${escapeHtml(activeAgent)}` : ""}</small></span><span class="queue-stage-count">${Math.round((item.completedTasks / Math.max(item.totalTasks, 1)) * 100)}%</span></div>
            <div class="queue-stage-rail" role="img" aria-label="${escapeHtml(`${item.completedTasks} of ${item.totalTasks} stages complete; ${activeLabel}`)}">${stageDots}</div>
          </div>
          <div class="queue-card-facts">
            <div><strong>Current work</strong><span>${escapeHtml(currentStage)}</span></div>
            <div><strong>ETA</strong><span title="${escapeHtml(eta.reason)}">${eta.state === "waiting" ? `<a href="/queue">${escapeHtml(formatRunEta(eta))}</a>` : escapeHtml(formatRunEta(eta))}</span></div>
            <div><strong>Time budget</strong><span>${escapeHtml(latency.phase)} · ${formatDuration(latency.elapsedMs)} / ${formatDuration(latency.budgetMs)} · ${escapeHtml(latency.status)}</span></div>
            <div><strong>Queue</strong><span>${formatNumber(item.runningTasks)} running · ${formatNumber(item.queuedTasks)} waiting</span></div>
            <div><strong>Worker</strong><span>${escapeHtml(item.runningWorkerId ?? "Not leased")}</span></div>
            ${callback && callbackLabel ? `<div><strong>Fix callback</strong><span>${escapeHtml(callbackLabel)} · ${renderDashboardDateTime(callback.acknowledgedAt ?? callback.transportAcceptedAt ?? callback.createdAt)}</span></div>` : ""}
            ${ownership && ownerLabel ? `<div><strong>Failure owner</strong><span>${escapeHtml(ownerLabel)} · ${escapeHtml(ownership.confidence)} confidence</span></div>` : ""}
            ${runtimeRemedy ? `<div><strong>Runtime remedy</strong><span>${escapeHtml(runtimeRemedy.state)} · ${escapeHtml(runtimeRemedy.requiredCapability)}</span></div>` : ""}
            <div><strong>Oldest active</strong><span>${renderDashboardDateTime(item.oldestRunningAt ?? item.oldestQueuedAt ?? item.startedAt)}</span></div>
            <div><strong>Version set</strong><span>${escapeHtml((item.versionSetId ?? item.runSetId).slice(0,8))} · <a href="${historyHref}">${formatNumber(item.relatedRunCount ?? item.runSetSize)} related run${(item.relatedRunCount ?? item.runSetSize) === 1 ? "" : "s"}</a> · <a href="${historyHref}" target="_blank" rel="noopener">Open family in new window</a></span></div>
          </div>
          <div class="queue-card-footer">
            <div class="queue-primary-actions">${queueItemPrimaryForms(item)}</div>
            <details class="queue-more-actions"><summary>More actions</summary><div class="actions">${queueItemSecondaryForms(item)}${renderRunInfoDialog({
            runId: item.runId,
            workflowId: item.workflowId,
            status: item.runStatus,
            projectName: item.projectName,
            projectRootUri: item.projectRootUri,
            task: item.task,
            startedAt: item.startedAt,
            blockedReason: item.blockedReason,
            failedReason: item.failedReason,
            summary: [taskSummary, `current: ${currentStage}`, leaseDetail]
          })}</div></details>
          </div>
        </article>
      `;
    }).join("");

    return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent Workflow Queue</title>
    <style>${dashboardCss()}</style>
  </head>
  <body>
    ${dashboardNav("queue")}
    ${renderQueuePartnerOverlay(partnerProjects, resolvedProjectFilter || ctx.rootDir)}
    <main id="main-content">
      <div class="topbar">
        <div>
          <a href="/">Dashboard</a>
          <h1>Queue</h1>
          <span id="queue-watch-status" class="muted">Queue watcher starting…</span>
          <button type="button" id="queue-watch-refresh" hidden style="display:none">Queue changed — refresh cards</button>
        </div>
        <div class="actions"><a class="button secondary" href="/queue-status">Live status table</a><a class="button secondary" href="/api/queue">JSON</a></div>
      </div>
      ${renderDashboardFlashValues(flash)}
      ${renderDashboardActionHistory()}
      <section class="panel">
        <div class="metric-grid" data-queue-live-region="counts">
          ${metricCard("Active Runs", formatNumber(active.length), "queued or running")}
          ${metricCard("Recovering", formatNumber(recovering.length), "follow-up in progress")}
          ${metricCard("Failed Runs", formatNumber(failed.length), "need a decision")}
          ${metricCard("Blocked Runs", formatNumber(blocked.length), "waiting for a person")}
          ${metricCard("Queued Tasks", formatNumber(queue.reduce((sum, item) => sum + item.queuedTasks, 0)), "stages waiting")}
          ${metricCard("Running Tasks", formatNumber(queue.reduce((sum, item) => sum + item.runningTasks, 0)), "stages with a lease")}
        </div>
        <h2 class="queue-controls-heading">Process queued work</h2>
        <div class="actions" data-queue-live-region="controls">
          ${queueProcessForm(resolvedProjectFilter)}
          ${expiredLeaseRows.length ? queueRecoverExpiredLeasesForm() : ""}
        </div>
        <form class="workflow-form" method="get" action="/queue">
          <label class="wide">Project filter<input name="project" value="${escapeHtml(resolvedProjectFilter)}" placeholder="/path/to/project or blank for all"></label>
          <div class="form-actions"><button type="submit">Filter Queue</button></div>
        </form>
      </section>
      <div data-queue-live-region="attention">
      ${failed.length ? `<details class="panel warn-panel bulk-actions">
        <summary><h2>Clear failed queue items (${failed.length})</h2></summary>
        <p class="muted">Remove reviewed failed cards while preserving their failed statuses and evidence. Active work, approvals, or unresolved effects must be reconciled first.</p>
        ${queueDismissAllForm(queue)}
      </details>` : ""}
      ${recovering.length ? `<section class="panel">
        <div class="section-heading"><div><h2>Recovery in Progress</h2><span class="muted">Source failures remain immutable history. Current work is counted once through the active recovery run.</span></div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Source run</th><th>Derived status</th><th>Current recovery</th><th>Project</th><th>Started</th></tr></thead>
          <tbody>${recovering.map((item) => `<tr>
            <td><a href="/run?id=${encodeURIComponent(item.runId)}">${escapeHtml(item.runId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(item.runStatus)} · ${escapeHtml(item.workflowId)}</span></td>
            <td><span class="status running">${item.runStatus === "blocked" ? "continuation running" : "recovery running"}</span></td>
            <td><a href="/run?id=${encodeURIComponent(item.recoveryRunId ?? "")}">${escapeHtml(item.recoveryRunId?.slice(0, 8) ?? "unknown")}</a><br><span class="muted">${escapeHtml(item.recoveryRunStatus ?? "unknown")} · ${escapeHtml(item.recoveryRelation ?? "recovery")}</span></td>
            <td>${escapeHtml(item.projectName)}</td>
            <td>${renderDashboardDateTime(item.recoveryStartedAt ?? item.startedAt)}</td>
          </tr>`).join("")}</tbody>
        </table></div>
      </section>` : ""}
      </div>
      ${renderQueueHistoryPanel()}
      <section class="queue-section" aria-labelledby="queue-runs-heading">
        <div class="section-heading"><div><h2 id="queue-runs-heading">Work in the queue</h2><span class="muted">Follow progress, understand blockers, and act without losing run history.</span></div></div>
        <div class="queue-card-list" data-queue-live-region="cards">${cards || '<div class="panel human-empty"><strong>The queue is clear</strong><span>New and active work will appear here.</span></div>'}</div>
      </section>
    </main>
    <script>
      (() => {
        const status = document.getElementById("queue-watch-status");
        ${queueCardActivityScript()}
        ${queueCardRefreshScript()}
        ${queueHistoryScript()}
        const history = startQueueHistory();
        const cards = createQueueCardRefresher(() => history.refresh());
        if (!("Worker" in window)) {
          status.textContent = "Watching queue cards with background polling.";
          cards.request();
          const fallback = window.setInterval(() => cards.request(), 10000);
          window.addEventListener("pagehide", () => { clearInterval(fallback); cards.stop(); history.stop(); }, { once: true });
          return;
        }
        const watcher = new Worker("/assets/queue-watcher.js");
        const fallback = window.setInterval(() => cards.request(), 10000);
        watcher.onmessage = (event) => {
          if (event.data.type === "snapshot") updateQueueCardActivity(event.data.activities);
          if (event.data.type === "error") {
            status.textContent = "Queue watcher reconnecting…";
            return;
          }
          status.textContent = event.data.active > 0
            ? "Watching " + event.data.active + " active run" + (event.data.active === 1 ? "" : "s") + " · updated " + new Date(event.data.checkedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
            : "Queue watcher idle · checked " + new Date(event.data.checkedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
          if (event.data.changed) cards.request();
        };
        watcher.postMessage({ type: "start", project: ${serializeInlineScriptJson(projectFilter || null)}, signature: ${serializeInlineScriptJson(queueSnapshotSignature(queue))} });
        window.addEventListener("pagehide", () => { clearInterval(fallback); watcher.postMessage({ type: "stop" }); cards.stop(); history.stop(); }, { once: true });
      })();
    </script>
  </body>
  </html>`;
  }

  function renderRunApprovalLevelControl(
    run: NonNullable<Awaited<ReturnType<typeof getWorkflowRunDetails>>["run"]>,
    ceiling: string
  ): string {
    const currentRank = runApprovalLevelRank(run.autonomy);
    const ceilingRank = runApprovalLevelRank(ceiling);
    const immutableActive = run.status === "leased" || run.status === "running";
    const superseded = Boolean(run.replacementRunId) || Boolean(run.superseded);
    const options = RUN_APPROVAL_LEVELS.filter((level) => runApprovalLevelRank(level) <= ceilingRank).map((level) =>
      `<option value="${escapeHtml(level)}"${level === run.autonomy ? " selected" : ""}>Level ${escapeHtml(level)} · ${escapeHtml(runApprovalLevelLabel(level))}</option>`
    ).join("");
    const behavior = run.status === "queued"
      ? "This updates the queued run before any worker claims it."
      : immutableActive
        ? "A worker already owns this policy snapshot, so its authority cannot change mid-stage."
        : "Changing this immutable run creates a checkpoint continuation with the selected level.";
    return `<section class="run-approval-level" aria-labelledby="run-approval-level-title">
      <div>
        <p class="eyebrow">Approval level</p>
        <h3 id="run-approval-level-title">Level ${escapeHtml(run.autonomy)} · ${escapeHtml(runApprovalLevelLabel(run.autonomy))}</h3>
        <p>${escapeHtml(behavior)} Project/profile ceiling: <strong>Level ${escapeHtml(ceiling)}</strong>. Higher levels permit more autonomous action; project policy and explicit high-risk gates still apply.</p>
      </div>
      ${superseded ? `<a class="button" href="/run?id=${encodeURIComponent(run.replacementRunId!)}">Change current continuation →</a>` : immutableActive ? `<span class="status running">Locked while ${escapeHtml(run.status)}</span>` : `<form class="run-approval-level-form" method="post" action="/api/run-approval-level">
        <input type="hidden" name="runId" value="${escapeHtml(run.id)}">
        <input type="hidden" name="returnTo" value="/run?id=${encodeURIComponent(run.id)}">
        <label><span>New level</span><select name="level" aria-label="Run approval level">${options}</select></label>
        <label><span>Reason</span><input name="reason" required maxlength="500" value="Operator changed the run approval level from ${escapeHtml(run.autonomy)}." aria-label="Reason for approval level change"></label>
        <button type="submit"${currentRank > ceilingRank ? " disabled" : ""}>Apply level</button>
      </form>`}
    </section>`;
  }

  function renderRunDetailHtml(input: {
    run: NonNullable<Awaited<ReturnType<typeof getWorkflowRunDetails>>["run"]>;
    partnerProjects: Array<{id:string;name:string;rootUri:string}>;
    tasks: Awaited<ReturnType<typeof getWorkflowRunDetails>>["tasks"];
    receipts: Awaited<ReturnType<typeof getWorkflowRunDetails>>["receipts"];
    artifacts: Awaited<ReturnType<typeof listArtifacts>>;
    approvals: Awaited<ReturnType<typeof listActionApprovals>>;
    params: URLSearchParams;
    summary: RunSummary | null;
    qualityReport: CostQualityReport | null;
    observabilityReport: ObservabilityReport | null;
    usageEstimate: RunUsageEstimate | null;
    eta: RunEta;
    preferenceScorecard: PreferenceScorecard | null;
    tuningProposals: TuningProposalSet | null;
    approvalCeiling: string;
    partnerHistory?:QueuePartnerHistorySummary;
  }): string {
    const completedTasks = input.tasks.filter((task) => task.status === "completed" && !task.skipped).length;
    const failedTasks = input.tasks.filter((task) => task.status === "failed").length;
    const activeTasks = input.tasks.filter((task) => task.status === "running" || task.status === "leased" || task.status === "queued").length;
    const coordinatorSourceRunId = stringValue(input.run.evaluationMetadata?.sourceRunId) ?? input.run.id;
    const shouldRefresh = input.run.status === "queued" || input.run.status === "leased" || input.run.status === "running";
    const summaryBlock = input.summary
      ? `<pre>${escapeHtml(formatRunSummary(input.summary))}</pre>`
      : "<p>No summary available.</p>";
    const taskRows = input.tasks.map((task) => `
      <tr><td>${escapeHtml(task.stageId)}</td><td>${escapeHtml(task.agentId)}</td><td>${escapeHtml(task.status)}</td><td>${task.attempts}</td><td>${task.executorSnapshot ? escapeHtml(`${task.executorSnapshot.executorId}/${task.executorSnapshot.operation}@${task.executorSnapshot.requestedHost}`) : "local model"}</td></tr>
    `).join("");
    const receiptRows = input.receipts.map((receipt) => `
      <tr><td>${escapeHtml(receipt.actionType)}</td><td>${escapeHtml(receipt.agentId)}</td><td>${escapeHtml(receipt.summary)}</td></tr>
    `).join("");
    const artifactBlocks = input.artifacts.map((artifact) => `
      <details class="artifact">
        <summary>${escapeHtml(artifact.kind)} ${escapeHtml(artifact.uri)}</summary>
        <pre>${escapeHtml(JSON.stringify(artifact.content, null, 2))}</pre>
      </details>
    `).join("");
    const decisionExplanations = buildRunDecisionExplanations(input.run, input.qualityReport, input.summary);
    const governedReusePlan = readGovernedReusePlan(input.artifacts);
    const runTitle = withoutWorkflowPrefix(dashboardRunPresentation(input.run).title, input.run.workflowId);

    return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(compactDashboardText(runTitle, 70))} · Run ${escapeHtml(input.run.id.slice(0, 8))}</title>
    <style>${dashboardCss()}</style>
  </head>
  <body>
    ${dashboardNav("runs")}
    ${renderQueuePartnerOverlay(input.partnerProjects, input.run.projectRootUri, {runId:input.run.id})}
    <main id="main-content">
      <div class="topbar">
        <div>
          <a href="/runs">Runs</a>
          <h1 class="run-title">${escapeHtml(runTitle)}</h1>
          <p class="run-subtitle muted"><span class="status ${escapeHtml(input.run.status)}">${escapeHtml(input.run.status)}</span> ${escapeHtml(workflowDisplayName(input.run.workflowId))} · ${escapeHtml(input.run.projectName)} · <code title="Run id">${escapeHtml(input.run.id)}</code></p>
        </div>
        <details class="export-menu">
          <summary class="button secondary">Export</summary>
          <div class="export-menu-list" role="list">
            <a role="listitem" href="/api/run?id=${encodeURIComponent(input.run.id)}">Run JSON</a>
            <a role="listitem" href="/api/quality?id=${encodeURIComponent(input.run.id)}">Quality JSON</a>
            <a role="listitem" href="/api/observability?id=${encodeURIComponent(input.run.id)}">OpenTelemetry JSON</a>
            <a role="listitem" href="/api/preferences?project=${encodeURIComponent(input.run.projectRootUri)}">Preference JSON</a>
            <a role="listitem" href="/api/tuning?project=${encodeURIComponent(input.run.projectRootUri)}">Tuning JSON</a>
          </div>
        </details>
      </div>
      ${renderDashboardFlash(input.params)}
      ${renderDashboardActionHistory()}
      ${(input.run.runSetSize ?? 1) > 1 && input.run.runSetId ? `<section class="panel"><strong>Run history</strong><p class="muted">This run belongs to set ${escapeHtml(input.run.runSetId)} with ${formatNumber(input.run.runSetSize ?? 1)} immutable attempts.</p><a href="/runs?runSet=${encodeURIComponent(input.run.runSetId)}">View related runs →</a></section>` : ""}
      ${input.run.replacementRunId && ["failed","blocked","cancelled"].includes(input.run.status) ? `<section class="panel" aria-labelledby="coordinator-history-title">
        <h2 id="coordinator-history-title">Coordinator history</h2>
        <p>${input.run.dismissed ? "This terminal attempt is archived from actionable views. Its original status, contracts, receipts, checkpoints, approvals, and acceptance history remain intact." : "This unsuccessful terminal attempt can leave actionable views only after its successful replacement has independently satisfied the original requirements."}</p>
        <p><a href="/run?id=${encodeURIComponent(input.run.replacementRunId)}">Open accepted replacement ${escapeHtml(input.run.replacementRunId.slice(0,8))} →</a></p>
        <form method="post" action="/api/coordinator-history" class="inline-form">
          <input type="hidden" name="returnTo" value="/run?id=${encodeURIComponent(input.run.id)}">
          <input type="hidden" name="action" value="${input.run.dismissed?"restore":"archive"}">
          <input type="hidden" name="sourceRunId" value="${escapeHtml(coordinatorSourceRunId)}">
          <input type="hidden" name="replacementRunId" value="${escapeHtml(input.run.replacementRunId)}">
          <input type="hidden" name="runIds" value="${escapeHtml(input.run.id)}">
          <input type="hidden" name="actor" value="dashboard-user">
          <label>Reason<input name="reason" required maxlength="500" placeholder="Why this exact view-only history action is needed"></label>
          <label class="check-row"><input type="checkbox" required onchange="this.form.confirmation.value=this.checked?'${input.run.dismissed?"Restore to active views.":"Archive from active views."}':''"> I understand this preserves history and changes no execution or acceptance state.</label>
          <input type="hidden" name="confirmation" value="">
          <button type="submit">${input.run.dismissed?"Restore to active views":"Archive from active views"}</button>
        </form>
      </section>`:""}
      ${input.partnerHistory?.attempts?`<section class="panel"><h2>Partner learned history</h2>${renderQueuePartnerHistory(input.partnerHistory)}</section>`:''}
      <div id="run-continuation">${renderRunContinuationBanner(input.run)}</div>
      <section id="run-stage-timeline" class="panel run-stage-timeline-panel">
        ${renderRunStageTimeline(input.tasks)}
      </section>
      <section id="run-command-center" class="panel run-command-center">
        ${renderRunCommandCenterBody(input.run, input.tasks, input.approvals)}
      </section>
      ${governedReusePlan ? renderGovernedReusePanel(governedReusePlan) : ""}
      <section class="panel run-live-panel" data-run-active="${shouldRefresh ? "true" : "false"}">
        <div class="section-heading">
          <div>
            <h2>Live Progress</h2>
            <span id="run-live-connection" class="muted" aria-live="polite">${shouldRefresh ? "Connecting to run activity…" : "Loading recorded activity…"}</span>
          </div>
          <div class="actions">
            <span id="run-live-indicator" class="run-live-indicator ${shouldRefresh ? "active" : ""}" aria-hidden="true"></span>
            <button id="run-live-verbose" class="secondary compact-button" type="button" aria-pressed="false">Verbose</button>
            <button id="run-live-toggle" class="secondary compact-button" type="button">Pause updates</button>
          </div>
        </div>
        <div id="run-live-scope" class="run-live-scope" hidden></div>
        <ol id="run-live-log" class="run-live-log" aria-label="Run progress log">
          <li class="run-live-empty">Waiting for activity…</li>
        </ol>
      </section>
      <section class="panel">
        <div class="meta-grid">
          <div><strong>Status</strong><span id="run-live-status" class="status ${escapeHtml(input.run.status)}">${escapeHtml(input.run.status)}</span></div>
          <div><strong>Workflow</strong>${escapeHtml(workflowDisplayName(input.run.workflowId))}<br><span class="muted">${escapeHtml(input.run.workflowId)}</span></div>
          <div><strong>Project</strong>${escapeHtml(input.run.projectName)}</div>
          <div><strong>Started</strong>${renderDashboardDateTime(input.run.startedAt)}</div>
          <div><strong>ETA</strong><span id="run-live-eta" title="${escapeHtml(input.eta.reason)}">${escapeHtml(formatRunEta(input.eta))}</span></div>
          <div><strong>Tasks</strong><span id="run-live-completed">${completedTasks}/${input.tasks.length} completed</span></div>
          <div><strong>Failed</strong><span id="run-live-failed">${failedTasks}</span></div>
          <div><strong>Active</strong><span id="run-live-active">${activeTasks}</span></div>
          <div><strong>Receipts</strong>${input.receipts.length}</div>
        </div>
        ${renderRunApprovalLevelControl(input.run, input.approvalCeiling)}
        <p>${escapeHtml(input.run.task)}</p>
        ${input.run.status === "blocked" ? `<h3>Reason Blocked</h3><p class="warn-box">${escapeHtml(input.run.blockedReason?.trim() || "No specific blocker reason was recorded. This is a workflow defect; inspect the stage artifacts below.")}</p>` : ""}
        ${input.run.status === "failed" ? renderFailedRunResolutionPanel(input.run) : ""}
        <details class="governance-details"><summary>Follow-up workflows</summary><div class="actions quick-actions">
          ${runActionForm(input.run.id, "summarize", "Summarize Run")}
          ${runActionForm(input.run.id, "debug-failure", "Diagnose & Fix")}
          ${runActionForm(input.run.id, "investigate-issue", "Investigate Issue")}
          ${runActionForm(input.run.id, "mira-ux-pass", "Ask Mira")}
          ${runActionForm(input.run.id, "frontend-pass", "Frontend Pass")}
          ${runActionForm(input.run.id, "maintain-context", "Maintain Context")}
        </div></details>
      </section>
      <section class="panel">
        <h2>Feedback</h2>
        ${input.qualityReport ? renderFeedbackHtml(input.run.id, input.qualityReport) : "<p>No feedback available.</p>"}
      </section>
      <section class="panel">
        <h2>Summary</h2>
        ${summaryBlock}
      </section>
      ${renderRunDecisionExplanationsHtml(decisionExplanations)}
      <section class="panel">
        <h2>Cost & Quality</h2>
        ${input.qualityReport ? renderCostQualityHtml(input.qualityReport) : "<p>No routing data available.</p>"}
      </section>
      <section class="panel">
        <h2>Observability</h2>
        ${input.observabilityReport ? renderObservabilityHtml(input.observabilityReport) : "<p>No observability data available.</p>"}
      </section>
      <section class="panel">
        <h2>Token Savings Estimate</h2>
        ${input.usageEstimate ? renderRunUsageEstimateHtml(input.usageEstimate) : "<p>No token estimate available.</p>"}
      </section>
      <section class="panel">
        <h2>Preference Scorecard</h2>
        ${input.preferenceScorecard ? renderPreferenceScorecardHtml(input.preferenceScorecard) : "<p>No preference scorecard available.</p>"}
      </section>
      <section class="panel">
        <h2>Tuning Proposals</h2>
        ${input.tuningProposals ? renderTuningProposalsHtml(input.tuningProposals) : "<p>No tuning proposals available.</p>"}
      </section>
      <section class="panel">
        <h2>Stages</h2>
        <table><thead><tr><th>Stage</th><th>Agent</th><th>Status</th><th>Attempts</th><th>Executor</th></tr></thead><tbody id="run-live-stages">${taskRows}</tbody></table>
      </section>
      <section class="panel">
        <h2>Receipts</h2>
        <table><thead><tr><th>Action</th><th>Agent</th><th>Summary</th></tr></thead><tbody>${receiptRows || "<tr><td colspan=\"3\">No receipts.</td></tr>"}</tbody></table>
      </section>
      <section class="panel">
        <h2>Artifacts</h2>
        ${artifactBlocks || "<p>No artifacts.</p>"}
      </section>
    </main>
    <script>${renderRunLiveProgressScript(input.run.id, shouldRefresh)}</script>
  </body>
  </html>`;
  }

  const RUNS_PAGE_STATUS_FILTERS: ReadonlyArray<[string, string]> = [["all", "All"], ["failed", "Failed"], ["blocked", "Blocked"], ["queued", "Queued"], ["running", "Running"], ["completed", "Completed"]];

  function parseRunsPageStatusFilter(value: string | null): string {
    const normalized = (value ?? "all").trim().toLowerCase();
    if (normalized === "active") return "active";
    return RUNS_PAGE_STATUS_FILTERS.some(([status]) => status === normalized) ? normalized : "all";
  }

  function renderRunsHtml(runs: DashboardRunStatus[], params: URLSearchParams = new URLSearchParams(), workAvailable = true): string {
    const selectedRunSet = params.get("runSet")?.trim(), setRuns = selectedRunSet ? runs.filter((run) => run.runSetId === selectedRunSet) : runs;
    const statusFilter = parseRunsPageStatusFilter(params.get("status"));
    const visibleRuns = setRuns.filter((run) => runsPageStatusMatches(run.status, statusFilter));
    const chipHref = (status: string) => {
      const next = new URLSearchParams();
      for (const key of ["runSet", "relatedTo"]) { const value = params.get(key); if (value) next.set(key, value); }
      if (status !== "all") next.set("status", status);
      const query = next.toString();
      return `/runs${query ? `?${query}` : ""}`;
    };
    const chips = RUNS_PAGE_STATUS_FILTERS.map(([status, label]) => {
      const count = setRuns.filter((run) => runsPageStatusMatches(run.status, status)).length;
      return `<a class="status-chip${status === statusFilter ? " active" : ""}" href="${escapeHtml(chipHref(status))}"${status === statusFilter ? ' aria-current="page"' : ""}>${escapeHtml(label)} <span>${formatNumber(count)}</span></a>`;
    }).join("");
    const rows = visibleRuns.map((run) => {
      const presentation = dashboardRunPresentation(run);
      const eta = withWorkerAvailability(estimateRunEta({ run, tasks: [{ status: run.status }], historicalRuns: runs }), dashboardRunCanProgress(workAvailable, run));
      return `
      <tr>
        <td class="run-id-cell"><a href="/run?id=${encodeURIComponent(run.id)}" title="${escapeHtml(run.id)}"><code>${escapeHtml(run.id.slice(0, 8))}</code></a><button type="button" class="secondary copy-run-id" data-copy="${escapeHtml(run.id)}" aria-label="Copy run id ${escapeHtml(run.id)}" title="Copy full run id">Copy</button><div class="row-tools">${renderRunInfoDialog({
          runId: run.id,
          workflowId: run.workflowId,
          status: run.status,
          projectName: run.projectName,
          projectRootUri: run.projectRootUri,
          task: run.task,
          startedAt: run.startedAt,
          blockedReason: run.blockedReason,
          summary: [
            run.finishedAt ? `finished: ${formatDashboardDateTimeText(run.finishedAt)}` : "not finished yet",
            run.providerOverride ? `provider: ${run.providerOverride}` : "provider: default route",
            run.modelTierOverride ? `model tier: ${run.modelTierOverride}` : "model tier: workflow default"
          ]
        })}</div></td>
        <td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
        <td title="${escapeHtml(run.workflowId)}">${escapeHtml(workflowDisplayName(run.workflowId))}</td>
        <td title="${escapeHtml(run.projectRootUri)}">${escapeHtml(run.projectName)}</td>
        <td class="run-task-cell" title="${escapeHtml(run.task)}"><strong>${escapeHtml(withoutWorkflowPrefix(presentation.title, run.workflowId))}</strong></td>
        <td>${renderDashboardDateTime(run.startedAt)}</td>
        <td title="${escapeHtml(eta.reason)}">${eta.state === "waiting" ? `<a href="/queue">${escapeHtml(formatRunEta(eta))}</a>` : escapeHtml(formatRunEta(eta))}</td>
      </tr>
    `;
    }).join("");
    return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent Workflow Runs</title>
    <style>${dashboardCss()}</style>
  </head>
  <body>
    ${dashboardNav("runs")}
    <main id="main-content">
      <div class="topbar">
        <div>
          <a href="/">Dashboard</a>
          <h1>Runs</h1>
        </div>
        <a class="button secondary" href="/api/runs">JSON</a>
      </div>
      ${renderDashboardFlash(params)}
      ${selectedRunSet ? `<section class="panel"><strong>Related run history</strong><p class="muted">Run set ${escapeHtml(selectedRunSet)} · ${formatNumber(visibleRuns.length)} run${visibleRuns.length === 1 ? "" : "s"}</p><a href="/runs">Show all runs</a></section>` : ""}
      ${renderDashboardActionHistory()}
      <section class="panel">
        <div class="section-heading"><h2>Recent Runs</h2></div>
        <nav class="status-chips" aria-label="Filter runs by status">${chips}</nav>
        <div class="table-wrap"><table class="runs-table">
          <thead><tr><th>Run</th><th>Status</th><th>Workflow</th><th>Project</th><th>Task</th><th>Started</th><th>ETA</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="7">${statusFilter === "all" ? "No runs found." : `No ${escapeHtml(statusFilter)} runs. <a href="${escapeHtml(chipHref("all"))}">Show all runs</a>`}</td></tr>`}</tbody>
        </table></div>
      </section>
      <script>document.addEventListener("click",(event)=>{const button=event.target instanceof Element?event.target.closest("button[data-copy]"):null;if(!button)return;const done=()=>{button.textContent="Copied";setTimeout(()=>{button.textContent="Copy"},1500)};navigator.clipboard?.writeText(button.getAttribute("data-copy")||"").then(done,()=>{button.textContent="Copy failed"})});</script>
    </main>
  </body>
  </html>`;
  }

  function renderServerReadinessHtml(report: ServerReadinessReport, registry: ServerProjectRegistryReport, storageVerification: StorageVerificationReport, migrationPlans: StorageMigrationPlanListing, mergeEvidence: StorageMergeEvidenceListing, offlineFallback: OfflineFallbackReport, objectProof: ObjectArtifactProofReport, runtimeMonitor: RuntimeMonitorReport, statePlaneProof: SharedStatePlaneProof, mutationControls: ServerMutationControlReport, approvalActionPlan: ServerApprovalActionPlanReport, approvalActionTestAdapter: ServerApprovalActionTestAdapterReport, requestAudit: ServerRequestAuditReport, projects: DashboardProjectSummary[], worker: DashboardWorkerStatus, params: URLSearchParams): string {
    const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}"${report.projectRootUri === project.rootUri ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
    const statusClass = report.status === "ready" || report.status === "local-only" ? "completed" : report.status === "blocked" ? "failed" : "queued";
    const checkRows = report.checks.map((check) => `
      <tr><td>${escapeHtml(check.label)}</td><td><span class="status ${check.status === "pass" ? "completed" : check.status === "fail" ? "failed" : "queued"}">${escapeHtml(check.status)}</span></td><td>${escapeHtml(check.detail)}</td></tr>
    `).join("");
    const endpointRows = report.endpointClasses.map((endpoint) => `
      <tr><td>${escapeHtml(endpoint.name)}<br><span class="muted">${escapeHtml(endpoint.exposure)}</span></td><td><span class="status ${endpoint.implemented ? "completed" : "queued"}">${endpoint.implemented ? "implemented" : "not implemented"}</span></td><td><span class="status ${endpoint.ready ? "completed" : "queued"}">${endpoint.ready ? "ready" : "not ready"}</span></td><td>${endpoint.requiredControls.map((control) => `<code>${escapeHtml(control)}</code>`).join(" ")}</td></tr>
    `).join("");
    const projectRows = report.projects.map((project) => `
      <tr><td>${escapeHtml(project.name)}<br><code>${escapeHtml(project.id)}</code></td><td><code>${escapeHtml(project.rootUri)}</code></td><td><span class="status ${project.configStatus === "valid" ? "completed" : project.configStatus === "invalid" ? "failed" : "queued"}">${escapeHtml(project.configStatus)}</span></td><td>${escapeHtml(project.roleEnforcement)}</td><td>${project.roles.map((role) => `<code>${escapeHtml(role)}</code>`).join(" ") || "none"}</td></tr>
    `).join("");
    const registryRows = registry.projects.map((project) => `
      <tr><td>${escapeHtml(project.name)}<br><code>${escapeHtml(project.projectId)}</code><br><a href="/api/server-project?projectId=${encodeURIComponent(project.projectId)}">Resolve JSON</a></td><td>${project.rootUri ? `<code>${escapeHtml(project.rootUri)}</code>` : `<span class="muted">hidden</span><br><code>${escapeHtml(project.rootHash.slice(0, 12))}</code>`}</td><td>${project.defaultWorkflows.map((workflow) => `<code>${escapeHtml(workflow)}</code>`).join(" ") || "none"}</td><td><code>${escapeHtml(JSON.stringify(project.requestExample))}</code></td></tr>
    `).join("");
    const serviceRows = report.services.map((service) => `
      <tr><td>${escapeHtml(service.endpoint.name)}</td><td><span class="status ${service.reachable ? "completed" : "failed"}">${service.reachable ? "OK" : "MISSING"}</span></td><td>${escapeHtml(service.message)}</td></tr>
    `).join("");
    const storageStatusClass = storageVerification.status === "match" ? "completed" : storageVerification.status === "blocked" || storageVerification.status === "mismatch" ? "failed" : "queued";
    const storageMatches = storageVerification.diffs.filter((diff) => diff.status === "match").length;
    const storageMismatches = storageVerification.diffs.filter((diff) => diff.status === "mismatch").length;
    const storageMissing = storageVerification.diffs.filter((diff) => diff.status === "missing").length;
    const storageDiffRows = storageVerification.diffs.map((diff) => `
      <tr><td>${escapeHtml(diff.table)}</td><td><span class="status ${diff.status === "match" ? "completed" : "failed"}">${escapeHtml(diff.status)}</span></td><td>${escapeHtml(String(diff.sourceCount ?? "missing"))}</td><td>${escapeHtml(String(diff.targetCount ?? "missing"))}</td></tr>
    `).join("");
    const storageWarningRows = storageVerification.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
    const migrationPlanRows = migrationPlans.plans.map((plan) => {
      const planStatusClass = plan.status === "ready" ? "completed" : plan.status === "blocked" ? "failed" : "queued";
      return `
      <tr>
        <td>${renderDashboardDateTime(plan.generatedAt)}<br><code>${escapeHtml(path.basename(plan.jsonPath))}</code></td>
        <td><span class="status ${planStatusClass}">${escapeHtml(plan.status)}</span><br><span class="muted">${escapeHtml(plan.mode)}</span></td>
        <td><code>${escapeHtml(plan.sourceDatabaseUrl)}</code></td>
        <td><code>${escapeHtml(plan.targetDatabaseUrl)}</code><br><span class="muted">${escapeHtml(plan.targetObjectStorageEndpoint)} / ${escapeHtml(plan.targetObjectStorageBucket)}</span></td>
        <td>${formatNumber(plan.warningCount)}<br><span class="muted">${formatNumber(plan.stepCount)} steps</span></td>
        <td>${plan.markdownPath ? `<code>${escapeHtml(plan.markdownPath)}</code>` : '<span class="muted">none</span>'}</td>
        <td>${plan.scriptPath ? `<code>${escapeHtml(plan.scriptPath)}</code>` : '<span class="muted">none</span>'}</td>
      </tr>`;
    }).join("");
    const migrationWarningRows = migrationPlans.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
    const storageHost = params.get("storageHost") ?? process.env.AGENTFLOW_SHARED_STORAGE_HOST ?? "";
    const migrationDir = params.get("migrationDir") ?? ".agent-workflow/migrations";
    const commandRows = report.recommendedCommands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
    const noteRows = report.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
    const jsonParams = new URLSearchParams();
    if (report.projectRootUri) jsonParams.set("project", report.projectRootUri);
    jsonParams.set("limit", String(report.limit));
    const storageParams = new URLSearchParams();
    if (storageHost) storageParams.set("storageHost", storageHost);
    const migrationParams = new URLSearchParams();
    migrationParams.set("dir", migrationPlans.directory);
    const registryParams = new URLSearchParams(jsonParams);
    if (registry.includeRoots) registryParams.set("includeRoots", "true");
    const serverControlDetails = `
      <section class="panel"><h2>Readiness Checks</h2><div class="table-wrap"><table><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>${checkRows}</tbody></table></div></section>
      <section class="panel"><h2>Endpoint Classes</h2><div class="table-wrap"><table><thead><tr><th>Class</th><th>Implementation</th><th>Ready</th><th>Required Controls</th></tr></thead><tbody>${endpointRows}</tbody></table></div></section>
      ${renderServerAuthHardeningPanel(report.authHardening)}
      ${renderServerMutationControlsPanel(mutationControls)}
      ${renderServerApprovalActionPlanPanel(approvalActionPlan, approvalActionTestAdapter)}`;
    const projectAndAuditDetails = `
      ${renderServerRequestAuditPanel(requestAudit)}
      <section class="panel"><div class="section-heading"><div><h2>Server Project IDs</h2><span class="muted">Client-facing preview. Future server-mode requests should use projectId instead of raw filesystem paths.</span></div><a class="button secondary" href="/api/server-projects?${escapeHtml(registryParams.toString())}">JSON</a></div><div class="table-wrap"><table><thead><tr><th>Project</th><th>Root</th><th>Default Workflows</th><th>Request Example</th></tr></thead><tbody>${registryRows || '<tr><td colspan="4">No registered projects found.</td></tr>'}</tbody></table></div></section>
      <section class="panel"><h2>Registered Projects</h2><div class="table-wrap"><table><thead><tr><th>Project</th><th>Root</th><th>Config</th><th>Roles</th><th>Role IDs</th></tr></thead><tbody>${projectRows || '<tr><td colspan="5">No registered projects found.</td></tr>'}</tbody></table></div></section>`;
    const runtimeDetails = `
      <section class="panel"><h2>Services</h2><div class="table-wrap"><table><thead><tr><th>Service</th><th>Status</th><th>Detail</th></tr></thead><tbody>${serviceRows || '<tr><td colspan="3">No service checks were recorded.</td></tr>'}</tbody></table></div></section>
      <section class="panel"><div class="section-heading"><div><h2>Worker and Fleet Delivery</h2><span class="muted">Local process health, authenticated remote delivery, and worker execution freshness are independent signals.</span></div></div>${renderWorkerStatusHtml(worker)}</section>
      ${renderRuntimeMonitorPanel(runtimeMonitor, params)}`;
    const storageDetails = `
      <section class="panel"><div class="section-heading"><div><h2>Shared Storage Verification</h2><span class="muted">Read-only migration proof. This does not copy, restore, delete, or mutate storage.</span></div><a class="button secondary" href="/api/storage-verify?${escapeHtml(storageParams.toString())}">JSON</a></div>
      <div class="metric-grid">${metricCard("Storage", storageVerification.status, "durable state comparison")}${metricCard("Matched", storageMatches, `${storageVerification.diffs.length} durable tables`)}${metricCard("Mismatched", storageMismatches, "count or fingerprint differs")}${metricCard("Missing", storageMissing, "table absent on one side")}</div>
      <div class="meta-grid compact"><div><strong>Source DB</strong>${escapeHtml(storageVerification.source.endpoint.databaseUrl)}</div><div><strong>Target DB</strong>${escapeHtml(storageVerification.target.endpoint.databaseUrl)}</div><div><strong>Source Objects</strong>${escapeHtml(storageVerification.source.endpoint.objectStorageEndpoint)}</div><div><strong>Target Objects</strong>${escapeHtml(storageVerification.target.endpoint.objectStorageEndpoint)}</div></div>
      <p class="muted">Generated ${renderDashboardDateTime(storageVerification.generatedAt)}. Current status: <span class="status ${storageStatusClass}">${escapeHtml(storageVerification.status)}</span>.</p>
      ${storageVerification.warnings.length ? `<details class="governance-details" open><summary>Storage Warnings</summary><ul>${storageWarningRows}</ul></details>` : ""}
      <div class="table-wrap"><table><thead><tr><th>Table</th><th>Status</th><th>Source Rows</th><th>Target Rows</th></tr></thead><tbody>${storageDiffRows}</tbody></table></div></section>
      ${renderPostMergeEvidencePanel(mergeEvidence)}
      ${renderOfflineFallbackPanel(offlineFallback, params)}
      ${renderObjectArtifactProofPanel(objectProof, params)}
      <section class="panel"><div class="section-heading"><div><h2>Storage Migration Plans</h2><span class="muted">Generated dry-run operator packages from <code>storage-migrate --write-plan</code>. This page only reads plan artifacts.</span></div><a class="button secondary" href="/api/storage-migrations?${escapeHtml(migrationParams.toString())}">JSON</a></div>
      <div class="metric-grid">${metricCard("Plans", migrationPlans.plans.length, "generated migration packages")}${metricCard("Ready", migrationPlans.plans.filter((plan) => plan.status === "ready").length, "safe to review for execution")}${metricCard("Blocked", migrationPlans.plans.filter((plan) => plan.status === "blocked").length, "requires config changes first")}${metricCard("Warnings", migrationPlans.plans.reduce((total, plan) => total + plan.warningCount, 0), "across listed plans")}</div>
      <div class="meta-grid compact"><div><strong>Directory</strong><code>${escapeHtml(migrationPlans.directory)}</code></div><div><strong>Generated</strong>${renderDashboardDateTime(migrationPlans.generatedAt)}</div></div>
      ${migrationPlans.warnings.length ? `<details class="governance-details" open><summary>Migration Plan Warnings</summary><ul>${migrationWarningRows}</ul></details>` : ""}
      <div class="table-wrap"><table><thead><tr><th>Generated</th><th>Status</th><th>Source DB</th><th>Target Storage</th><th>Warnings / Steps</th><th>Markdown Report</th><th>Guarded Script</th></tr></thead><tbody>${migrationPlanRows || '<tr><td colspan="7">No generated storage migration plans found. Run <code>npm run storage-migrate -- --write-plan</code> to create a reviewed dry-run package.</td></tr>'}</tbody></table></div></section>`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Server Readiness</title><style>${dashboardCss()}</style></head><body>
    ${dashboardNav("server-readiness")}
    <main id="main-content"><div class="topbar"><div><a href="/">Dashboard</a><h1>Server Readiness</h1><p class="muted">Read-only governed server-mode readiness. This page does not enable remote execution or change network binding.</p></div><a class="button secondary" href="/api/server-readiness?${escapeHtml(jsonParams.toString())}">JSON</a></div>
    ${renderDashboardFlash(params)}
    ${renderDashboardActionHistory()}
    <details class="readiness-filter"><summary>Inspection scope and advanced filters</summary><section class="panel"><form method="get" class="workflow-form"><label>Project<select name="project"><option value="">all registered projects</option>${projectOptions}</select></label><label>Limit<input name="limit" value="${escapeHtml(params.get("limit") ?? String(report.limit))}" inputmode="numeric"></label><label>Storage host<input name="storageHost" value="${escapeHtml(storageHost)}" placeholder="192.0.2.10"></label><label>Migration dir<input name="migrationDir" value="${escapeHtml(migrationDir)}" placeholder=".agent-workflow/migrations"></label><label class="checkbox-row"><input type="checkbox" name="includeRoots" value="true"${registry.includeRoots ? " checked" : ""}> include local roots</label><div class="form-actions"><button type="submit">Inspect</button></div></form></section></details>
    ${renderPrimaryStatePlaneOperatorPanel(mergeEvidence, offlineFallback, runtimeMonitor)}
    ${renderSharedStatePlaneProofPanel(statePlaneProof)}
    <section class="panel"><div class="metric-grid">
      ${metricCard("Status", report.status, "server-mode readiness")}
      ${metricCard("Mode", report.mode.enabled ? "enabled" : "local-only", report.mode.networkExposed ? "network-exposed bind" : "loopback bind")}
      ${metricCard("Bind", `${report.mode.bind}:${report.mode.port}`, report.mode.networkExposed ? "shared network candidate" : "local developer default")}
      ${metricCard("Auth", report.mode.authMode, report.mode.tokenConfigured ? "token configured" : "no token configured")}
      ${metricCard("Projects", report.projects.length, "registered project ids inspected")}
      ${metricCard("Origins", report.mode.allowedOrigins.length, "allowed browser origins")}
    </div><p class="muted">Generated ${renderDashboardDateTime(report.generatedAt)}. Current status: <span class="status ${statusClass}">${escapeHtml(report.status)}</span>.</p></section>
    <nav class="readiness-jump-nav" aria-label="Readiness detail groups"><a href="#server-controls">Server controls</a><a href="#runtime-services">Runtime &amp; services</a><a href="#projects-audit">Projects &amp; audit</a><a href="#storage-recovery">Storage &amp; recovery</a></nav>
    ${renderReadinessGroup("server-controls", "Server controls", `${report.authHardening.warningControls + report.authHardening.failingControls} controls need review`, serverControlDetails)}
    ${renderReadinessGroup("runtime-services", "Runtime & services", `${runtimeMonitor.processes.reduce((total, process) => total + process.count, 0)} managed processes inspected`, runtimeDetails)}
    ${renderReadinessGroup("projects-audit", "Projects & audit", `${report.projects.length} projects and ${requestAudit.totalRead} request events`, projectAndAuditDetails)}
    ${renderReadinessGroup("storage-recovery", "Storage & recovery", `${storageMatches}/${storageVerification.diffs.length} tables match; ${migrationPlans.plans.length} migration plans`, storageDetails)}
    <details class="readiness-group"><summary><span><strong>Operator reference</strong><small>Commands and local-first operating notes</small></span><span class="readiness-group-action">View details</span></summary><div class="readiness-group-content"><section class="panel"><h2>Recommended Commands</h2><ul>${commandRows}</ul></section><section class="panel"><h2>Notes</h2><ul>${noteRows || '<li>No server-mode notes found.</li>'}</ul></section></div></details></main></body></html>`;
  }

  function renderTrainingProposalActions(item: TrainingProposalInbox["items"][number], selected: string, params: URLSearchParams, evaluation?: TrainingProposalEvaluationView): string {
    const hidden = `${dashboardReturnInput("/training-proposals", params)}<input type="hidden" name="project" value="${escapeHtml(selected)}"><input type="hidden" name="id" value="${escapeHtml(item.id)}">`;
    const form = (body: string, notePlaceholder: string, noteRequired = false) => `<form class="training-proposal-actions" method="post" action="/api/training-proposal-decision">${hidden}<input name="note" maxlength="500" placeholder="${escapeHtml(notePlaceholder)}"${noteRequired ? " required" : ""}>${body}</form>`;
    const evaluationForm = (label: string) => `<form class="training-proposal-actions" method="post" action="/api/training-proposal-evaluation">${hidden}<button type="submit">${escapeHtml(label)}</button></form>`;
    const verdict = trainingEvaluationVerdict(evaluation?.summary);
    const recovery = evaluation?.recoveryRunId ? `<br><span class="muted">Recovery follow-up: <a href="/run?id=${encodeURIComponent(evaluation.recoveryRunId)}">${escapeHtml(evaluation.recoveryRunId.slice(0, 8))}</a> · ${escapeHtml(evaluation.recoveryStatus ?? "unavailable")}. A completed recovery does not replace a missing evaluation verdict.</span>` : "";
    const evidence = evaluation ? `<p class="training-evaluation-evidence"><a href="/run?id=${encodeURIComponent(evaluation.runId)}">View evaluation run ${escapeHtml(evaluation.runId.slice(0, 8))}</a>${evaluation.evidenceHref ? ` · <a href="${escapeHtml(evaluation.evidenceHref)}">Measured evidence JSON</a>` : ""}<br><span class="status ${escapeHtml(evaluation.status)}">${escapeHtml(verdict ?? evaluation.status)}</span>${evaluation.summary ? `<br><span class="muted">${escapeHtml(evaluation.summary)}</span>` : ""}${recovery}</p>` : "";
    if (item.status === "pending") {
      return form('<div class="actions"><button name="status" value="approved" type="submit">Approve evaluation</button><button class="secondary" name="status" value="rejected" type="submit">Reject</button><button class="secondary" name="status" value="stale" type="submit">Mark stale</button></div>', "Decision note (optional)");
    }
    if (item.status === "approved") {
      if (!evaluation) {
        return `<p><strong>Evaluation approved</strong><br><span class="muted">Agent Workflow will run the stated holdout and collect evidence.</span></p>${evaluationForm("Run evaluation")}`;
      }
      if (evaluation.status === "completed" && evaluation.evidenceComplete) {
        return `<p><strong>Evaluation evidence ready</strong><br><span class="muted">Review the linked run, then accept its generated evidence.</span></p>${evidence}<form class="training-proposal-actions" method="post" action="/api/training-proposal-decision">${hidden}<button name="status" value="evaluated" type="submit">Accept evaluation result</button></form>`;
      }
      if (evaluation.status === "completed") {
        return `<p><strong>Evaluation needs evidence</strong><br><span class="muted">The workflow completed, but no complete nonzero measured holdout report exists. It cannot be accepted.</span></p>${evidence}<form class="training-proposal-actions" method="post" action="/api/training-proposal-decision">${hidden}<button name="status" value="evaluated" type="submit">Record missing evidence</button></form>`;
      }
      if (["failed", "blocked", "cancelled", "missing"].includes(evaluation.status)) {
        return `<p><strong>Evaluation needs attention</strong><br><span class="muted">The evaluation did not produce an accepted PASS, FAIL, or INCONCLUSIVE verdict. A successful recovery follow-up only proves the recovery workflow completed.</span></p>${evidence}${evaluationForm("Retry evaluation")}`;
      }
      return `<p><strong>Evaluation in progress</strong><br><span class="muted">Evidence will appear here when the linked run reaches a truthful terminal state.</span></p>${evidence}`;
    }
    if (item.status === "needs-evidence") {
      return `<p><strong>Needs evidence</strong><br><span class="muted">The previous run did not produce complete measured coverage. Retry with the persisted bounded design.</span></p>${evidence}${evaluationForm("Retry measured evaluation")}`;
    }
    if (item.status === "evaluated") {
      if (verdict !== "PASS") {
        return `<p><strong>Evaluation accepted — not promotion eligible</strong><br><span class="muted">${escapeHtml(verdict ?? "UNKNOWN")} evidence is preserved for review. Resolve the evidence gaps before running a new evaluation.</span></p>${evidence}${form('<div class="actions"><button class="secondary" name="status" value="stale" type="submit">Mark stale</button></div>', "Review note (optional)")}`;
      }
      return `<p><strong>PASS evaluation accepted</strong><br><span class="muted">The linked run is the evidence source for promotion review.</span></p>${evidence}${form('<div class="actions"><button name="status" value="promoted" type="submit">Record promotion decision</button><button class="secondary" name="status" value="stale" type="submit">Mark stale</button></div>', "Promotion decision and rollback confirmation", true)}`;
    }
    if (item.status === "promoted") {
      return '<p><strong>Promotion recorded</strong><br><span class="muted">No further inbox action is required.</span></p>';
    }
    return `<p><strong>${escapeHtml(titleCase(item.status))}</strong><br><span class="muted">This proposal has no active inbox action.</span></p>`;
  }

  function renderTrainingProposalsHtml(inbox: TrainingProposalInbox, report: TrainingDiscoveryReport | null, projects: DashboardProjectSummary[], selected: string, params: URLSearchParams, evaluationViews = new Map<string, TrainingProposalEvaluationView>()): string {
    const options = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}"${project.rootUri === selected ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
    const pending = inbox.items.filter((item) => item.status === "pending").length;
    const approved = inbox.items.filter((item) => item.status === "approved").length;
    const evaluated = inbox.items.filter((item) => item.status === "evaluated").length;
    const rows = inbox.items.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map((item) => `<tr>
      <td><strong>${escapeHtml(item.proposal.publisher)}</strong><br><a href="${escapeHtml(item.proposal.url)}" rel="noreferrer">${escapeHtml(item.sourceId)}</a><br><code>${escapeHtml(item.contentSha256.slice(0, 16))}</code></td>
      <td>${escapeHtml(item.proposal.targets.join(", "))}<br><span class="muted">${escapeHtml(item.proposal.claimedBenefit)}</span></td>
      <td><span class="status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span><br><span class="muted">${escapeHtml(item.proposal.confidence)} confidence · ${escapeHtml(item.proposal.license)}</span>${item.reviewer ? `<br><span class="muted">Reviewed by ${escapeHtml(item.reviewer)}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</span>` : ""}</td>
      <td><span>${escapeHtml(item.proposal.risks)}</span><br><strong>Holdout:</strong> ${escapeHtml(item.proposal.holdoutEvaluation)}</td>
      <td>${renderTrainingProposalActions(item, selected, params, evaluationViews.get(item.id))}</td>
    </tr>`).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Training Proposals</title><style>${dashboardCss()}
    .training-proposal-table{min-width:1180px;table-layout:fixed}.training-proposal-table th:nth-child(1){width:15%}.training-proposal-table th:nth-child(2){width:24%}.training-proposal-table th:nth-child(3){width:15%}.training-proposal-table th:nth-child(4){width:29%}.training-proposal-table th:nth-child(5){width:17%}.training-proposal-actions input{box-sizing:border-box;width:100%;min-width:0}.training-proposal-actions .actions{display:grid;grid-template-columns:1fr;gap:.4rem;margin-top:.45rem}.training-proposal-actions button{width:100%;white-space:normal}
    </style></head><body>
    ${dashboardNav("training-proposals")}
    <main id="main-content"><header><div><p class="eyebrow">Learning</p><h1>Training proposals</h1><p>Public-source evidence stays inert until reviewed, evaluated on holdouts, and explicitly promoted.</p></div></header>
    ${renderDashboardFlash(params)}
    <section class="panel"><form method="get" action="/training-proposals"><label>Project<select name="project">${options}</select></label><button type="submit">Inspect</button></form></section>
    <section class="metrics">${metricCard("Pending decision", pending, `${inbox.items.length} total proposals`)}${metricCard("Evaluation approved", approved, "run bounded holdouts next")}${metricCard("Evaluated", evaluated, "ready for promotion review")}${metricCard("Last discovery", report?.generatedAt ? formatDashboardDateTimeText(report.generatedAt) : "never", report?.status ?? "no report")}${metricCard("Sources scanned", report?.scannedSources ?? 0, `${report?.unsafeSources.length ?? 0} quarantined`)}</section>
    <section class="panel"><h2>Governed inbox</h2><p class="muted">Each row shows its actual next step. Approval permits a bounded holdout evaluation; recording evaluation or promotion does not itself change shared agent definitions, tools, authority, routing, or executable code.</p><div class="table-wrap"><table class="training-proposal-table"><thead><tr><th>Source</th><th>Targets / benefit</th><th>Status</th><th>Risk / evaluation</th><th>Next action</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No training proposals have been discovered.</td></tr>'}</tbody></table></div></section>
    <section class="panel"><h2>Manual run</h2><p><code>npm run training-discovery -- --project ${escapeHtml(selected)} --force</code></p><p><a href="/api/training-proposals?project=${encodeURIComponent(selected)}">JSON inbox</a></p></section>
    </main></body></html>`;
  }

  function renderWorkflowShapeOptimizationHtml(report: WorkflowShapeOptimizationReport, command: string, autoUpdate: boolean, agentImprovementProjectLocalAutoApply: boolean, autonomousApplyMaxRisk: LearningRiskLevel, approvalAutopilotEnabled: boolean, approvalAutopilotMaxRisk: ApprovalAutopilotRisk, daemonTrustLevels: DaemonTrustSettings): string {
    const recommendationRows = report.recommendations.map((item) => `
      <tr>
        <td>${escapeHtml(item.id)}<br><span class="muted">${escapeHtml(item.kind)}</span></td>
        <td><span class="flag ${item.priority === "high" ? "warn" : item.priority === "medium" ? "queued" : "good"}">${escapeHtml(item.priority)}</span></td>
        <td>${escapeHtml(item.title)}<br><span class="muted">${escapeHtml(item.target)}</span></td>
        <td>${escapeHtml(item.preferredScope.replace(/_/g, " "))}</td>
        <td>${item.agentTypeId ? escapeHtml(item.agentTypeId) : "n/a"}</td>
        <td>${escapeHtml(item.recommendation)}</td>
      </tr>
    `).join("");
    const summaryItems = report.summary.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    const fileItems = report.ownedLearningFiles.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join("");
    const settingsButton = "Save optimizer setting";
    const riskOptions = ["low", "medium", "high"].map((risk) => `<option value="${risk}"${autonomousApplyMaxRisk === risk ? " selected" : ""}>${risk}</option>`).join("");
    const approvalRiskOptions = ["low", "medium", "high"].map((risk) => `<option value="${risk}"${approvalAutopilotMaxRisk === risk ? " selected" : ""}>${risk}</option>`).join("");
    return `
      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>Workflow Shape Optimizer</h2>
            <span class="muted">${escapeHtml(report.workflowId)} · ${report.runsAnalyzed} run(s) · ${autoUpdate ? "autonomous learning-file updates" : "approval-first recommendations"}</span>
          </div>
          <a class="button secondary" href="/workflow-graph?workflow=${encodeURIComponent(report.workflowId)}&project=${encodeURIComponent(report.projectRootUri)}&view=network">Graph</a>
        </div>
        <form method="post" action="/api/learning-settings" class="inline-action-form">
          <input type="hidden" name="settingsSection" value="workflow-shape">
          <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
          <input type="hidden" name="workflow" value="${escapeHtml(report.workflowId)}">
          <input type="hidden" name="limit" value="${escapeHtml(String(report.runsAnalyzed || 50))}">
          <label class="checkbox-label">
            <input type="checkbox" name="workflowShapeAutoUpdate" value="on" ${autoUpdate ? "checked" : ""}>
            Autonomous optimizer writes learning-owned recommendation files
          </label>
          <label>Auto-apply through
            <select name="autonomousApplyMaxRisk">${riskOptions}</select>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" name="agentImprovementProjectLocalAutoApply" value="on" ${agentImprovementProjectLocalAutoApply ? "checked" : ""}>
            Auto-apply passing project-local agent-card improvements
          </label>
          <label class="checkbox-label">
            <input type="checkbox" name="approvalAutopilotEnabled" value="on" ${approvalAutopilotEnabled ? "checked" : ""}>
            Approval autopilot approves and executes eligible side effects
          </label>
          <label>Approval autopilot through
            <select name="approvalAutopilotMaxRisk">${approvalRiskOptions}</select>
          </label>
          <button type="submit" class="secondary">${escapeHtml(settingsButton)}</button>
        </form>
        <div class="metric-grid">
          ${metricCard("Shape Ideas", report.recommendations.length, "stage and agent-type proposals")}
          ${metricCard("High Priority", report.recommendations.filter((item) => item.priority === "high").length, "review first")}
          ${metricCard("Indexed Files", report.projectContext.indexedFiles, "project context")}
          ${metricCard("Eval Runs", report.evaluationRuns, "shape evidence")}
        </div>
        <p class="muted">Refresh owned learning artifacts with <code>${escapeHtml(command)}</code>. With Autonomous optimizer on, each daemon tick refreshes these learning-owned recommendation files by default. Turn it off for approval-first recommendation review.</p>
        <div class="split-grid">
          <div><h3>Summary</h3><ul>${summaryItems}</ul></div>
          <div><h3>Owned Files</h3><ul>${fileItems}</ul></div>
        </div>
        <div class="table-wrap"><table><thead><tr><th>ID</th><th>Priority</th><th>Recommendation</th><th>Scope</th><th>Agent Type</th><th>Action</th></tr></thead><tbody>${recommendationRows || "<tr><td colspan=\"6\">No shape changes recommended yet.</td></tr>"}</tbody></table></div>
      </section>
    `;
  }

  function restoreDrillCommands(projectRootUri?: string): string[] {
    const projectArg = projectRootUri ? ` --project ${shellQuote(projectRootUri)}` : "";
    return [
      `agentflow restore-drill${projectArg} --json`,
      `agentflow backup-report${projectArg}`,
      `agentflow artifact-lifecycle${projectArg} --restore-plan`
    ];
  }

  async function runDashboardFollowUp(input: {
    action: string;
    runId?: string;
    project?: string;
    workflowId?: string;
    stageId?: string;
    agentId?: string;
    providerId?: string;
    modelTier?: string;
    routeClass?: string;
    runs?: string;
    fallbackCount?: string;
    averageQuality?: string;
    averageLatencyMs?: string;
    ids?: string;
    model?: string;
    rating?: string;
    note?: string;
  }): Promise<DashboardFollowUpResult> {
    const action = input.action;
    if (action === "summarize") {
      if (!input.runId) {
        return { ok: false, error: "Missing run id." };
      }
      const summary = await summarizeWorkflowRun(input.runId);
      if (!summary.ok) {
        return { ok: false, error: `Unknown workflow run: ${input.runId}` };
      }
      return {
        ok: true,
        title: "Run Summary",
        output: formatRunSummary(summary.value)
      };
    }

    if (action === "feedback") {
      if (!input.runId) {
        return { ok: false, error: "Missing run id." };
      }
      const result = await recordRunFeedback({
        runId: input.runId,
        rating: input.rating ?? "",
        note: input.note ?? "",
        source: "dashboard"
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return {
        ok: true,
        title: "Feedback Recorded",
        output: `Recorded ${result.rating} feedback.\nArtifact: ${result.artifactUri}`,
        runId: input.runId
      };
    }

    if (action === "route-feedback") {
      if (!input.project) {
        return { ok: false, error: "Missing project path for route feedback." };
      }
      const result = await recordRouteDecisionFeedback({
        projectDir: path.resolve(process.cwd(), input.project),
        workflowId: input.workflowId ?? "",
        stageId: input.stageId ?? "",
        agentId: input.agentId ?? "",
        providerId: input.providerId ?? "",
        modelTier: input.modelTier ?? "",
        routeClass: input.routeClass ?? "",
        rating: input.rating ?? "",
        note: input.note ?? "",
        runs: parseNonNegativeInteger(input.runs ?? "0", 0),
        fallbackCount: parseNonNegativeInteger(input.fallbackCount ?? "0", 0),
        averageQuality: parseOptionalNumber(input.averageQuality),
        averageLatencyMs: parseOptionalNumber(input.averageLatencyMs),
        source: "dashboard"
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return {
        ok: true,
        title: "Route Feedback Recorded",
        output: formatRouteDecisionFeedbackResult(result)
      };
    }

    const sourceRun = input.runId ? await getWorkflowRunDetails(input.runId) : null;
    const preset = resolveWorkflowPreset(action);
    const sourceProject = sourceRun?.run?.projectRootUri ?? input.project ?? preset?.project;
    if (!sourceProject) {
      return { ok: false, error: "Missing project path or source run. Open a run detail page first, or use a dashboard quick action with a configured project." };
    }

    const sourceTask = sourceRun?.run?.task ?? "dashboard preset";
    const sourceLabel = input.runId ? `from run ${input.runId}` : "from dashboard preset";

    if (action === "suggest-stage-fix") {
      return queueDashboardStageFix({
        projectDir: sourceProject,
        workflowId: input.workflowId ?? "",
        stageId: input.stageId ?? ""
      });
    }

    if (action === "verify-stage-fix") {
      return queueDashboardStageVerification({
        projectDir: sourceProject,
        workflowId: input.workflowId ?? "",
        stageId: input.stageId ?? "",
        fixRunId: input.runId ?? ""
      });
    }

    if (action === "apply-tuning-dry-run") {
      const proposalSet = await loadTuningProposals({
        projectDir: sourceProject,
        limit: 25
      });
      const plan = buildTuningApplicationPlan(proposalSet, parseProposalIds(input.ids));
      return {
        ok: true,
        title: "Tuning Overlay Dry Run",
        output: `${formatTuningApplicationPlan(plan)}\n\nRun this command to write the overlay files:\nnpm run agentflow -- apply-tuning-proposals --project ${shellQuote(sourceProject)} --ids ${shellQuote(input.ids?.trim() || "all")} --write`
      };
    }

    if (action === "promotion-note-plan") {
      const report = await loadDashboardCandidateComparisonReport({
        projectDir: sourceProject
      });
      const suiteIds = input.ids?.trim() || "all";
      const plan = buildPromotionRoutingNotePlan(report, parseProposalIds(suiteIds));
      return {
        ok: true,
        title: "Promotion Note Plan Dry Run",
        output: `${formatPromotionRoutingNotePlan(plan)}\n\nRun this command to write the review files:\nnpm run agentflow -- promotion-note-plan --project ${shellQuote(sourceProject)} --suite ${shellQuote(suiteIds)} --write`
      };
    }

    if (action === "local-llm-smoke") {
      const result = await runLocalLlmRouteSmoke(ctx, {
        projectDir: sourceProject,
        timeoutMs: 120000
      });
      return result.status === "completed"
        ? {
          ok: true,
          title: "Local LLM Smoke Completed",
          runId: result.runId ?? undefined,
          output: formatLocalLlmRouteSmokeResult(result)
        }
        : {
          ok: false,
          error: formatLocalLlmRouteSmokeResult(result)
        };
    }

    if (action === "local-llm-setup-guide" || action === "local-llm-setup-approve") {
      const projectDir = path.resolve(process.cwd(), sourceProject);
      const scorecard = await loadPreferenceScorecard({ projectDir, limit: 50 });
      const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: 50 });
      const recentRouteReports = await loadCostQualityReportsForDashboardRuns(projectRuns.slice(0, Math.min(projectRuns.length, 50)));
      const localProviderEvidence = buildDashboardLocalProviderEvidence(scorecard);
      const localHoldoutRouting = await loadDashboardLocalHoldoutRoutingStatus(projectDir, localProviderEvidence);
      const routeReceiptTrends = buildDashboardRouteReceiptTrends(projectDir, recentRouteReports);
      const smokeOutcomes = buildLocalLlmSmokeOutcomeTrend(projectDir, projectRuns, recentRouteReports);
      const checklist = await loadLocalLlmSetupChecklistReport(ctx, { projectDir, localHoldoutRouting, routeReceiptTrends, smokeOutcomes });
      const guide = await loadLocalLlmSetupGuideReport({
        projectDir,
        checklist,
        approved: action === "local-llm-setup-approve"
      });
      await writeLocalLlmSetupGuideReport(projectDir, guide);
      if (action === "local-llm-setup-approve" && guide.status !== "ready") {
        return {
          ok: false,
          error: formatLocalLlmSetupGuideReport(guide)
        };
      }
      return {
        ok: true,
        title: action === "local-llm-setup-approve" ? "Local Routing Note Written" : "Local Setup Guide Written",
        output: formatLocalLlmSetupGuideReport(guide)
      };
    }

    if (action === "local-llm-download-recommendations") {
      const projectDir = path.resolve(process.cwd(), sourceProject);
      const scorecard = await loadPreferenceScorecard({ projectDir, limit: 50 });
      const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: 50 });
      const recentRouteReports = await loadCostQualityReportsForDashboardRuns(projectRuns.slice(0, Math.min(projectRuns.length, 50)));
      const localProviderEvidence = buildDashboardLocalProviderEvidence(scorecard);
      const localHoldoutRouting = await loadDashboardLocalHoldoutRoutingStatus(projectDir, localProviderEvidence);
      const routeReceiptTrends = buildDashboardRouteReceiptTrends(projectDir, recentRouteReports);
      const smokeOutcomes = buildLocalLlmSmokeOutcomeTrend(projectDir, projectRuns, recentRouteReports);
      const checklist = await loadLocalLlmSetupChecklistReport(ctx, { projectDir, localHoldoutRouting, routeReceiptTrends, smokeOutcomes });
      const setupGuide = await loadLocalLlmSetupGuideReport({ projectDir, checklist, approved: false });
      const report = buildLocalLlmDownloadRecommendationReport({ projectDir, scorecard, checklist, setupGuide });
      await writeLocalLlmDownloadRecommendationReport(projectDir, report);
      return {
        ok: true,
        title: "Local Model Recommendations Written",
        output: formatLocalLlmDownloadRecommendationReport(report)
      };
    }

    if (action === "local-llm-benchmarks" || action === "local-llm-benchmarks-execute") {
      const projectDir = path.resolve(process.cwd(), sourceProject);
      const report = await loadLocalLlmBenchmarkReceiptReport(ctx, {
        projectDir,
        limit: 50,
        execute: action === "local-llm-benchmarks-execute",
        timeoutMs: 20000
      });
      await writeLocalLlmBenchmarkReceiptReport(projectDir, report);
      const output = formatLocalLlmBenchmarkReceiptReport(report);
      if (report.status === "completed" || report.status === "planned" || report.status === "partial") {
        return {
          ok: true,
          title: action === "local-llm-benchmarks-execute" ? "Local Benchmark Receipts Executed" : "Local Benchmark Plan Written",
          output
        };
      }
      return {
        ok: false,
        error: output
      };
    }

    if (action === "local-llm-install-plan") {
      const projectDir = path.resolve(process.cwd(), sourceProject);
      const report = await loadLocalLlmInstallationPlanReport(ctx, {
        projectDir,
        selectedModels: input.model?.trim() || "recommended",
        limit: 50
      });
      await writeLocalLlmInstallationPlanReport(projectDir, report);
      return {
        ok: true,
        title: "Local Model Install Plan Written",
        output: formatLocalLlmInstallationPlanReport(report)
      };
    }

    if (action === "local-llm-inventory") {
      const projectDir = path.resolve(process.cwd(), sourceProject);
      const report = await loadLocalLlmInventoryReport(ctx, {
        projectDir,
        limit: 50
      });
      await writeLocalLlmInventoryReport(projectDir, report);
      return {
        ok: true,
        title: "Local Model Inventory Written",
        output: formatLocalLlmInventoryReport(report)
      };
    }

    if (action === "local-llm-prune-plan") {
      const projectDir = path.resolve(process.cwd(), sourceProject);
      const inventory = await loadLocalLlmInventoryReport(ctx, {
        projectDir,
        limit: 50
      });
      const report = buildLocalLlmPrunePlanReport(projectDir, inventory, input.model?.trim() || "candidates");
      await writeLocalLlmPrunePlanReport(projectDir, report);
      return {
        ok: true,
        title: "Local Model Prune Plan Written",
        output: formatLocalLlmPrunePlanReport(report)
      };
    }

    if (action === "local-llm-cache-trends") {
      const projectDir = path.resolve(process.cwd(), sourceProject);
      const report = await loadLocalLlmCacheTrendReport(ctx, {
        projectDir,
        limit: 50,
        write: true
      });
      return {
        ok: true,
        title: "Local Model Trend Snapshot Written",
        output: formatLocalLlmCacheTrendReport(report)
      };
    }

    if (action === "local-llm-cost-ledger") {
      const projectDir = path.resolve(process.cwd(), sourceProject);
      const report = await loadLocalLlmCostLedgerReport(ctx, {
        projectDir,
        limit: 50,
        write: true
      });
      return {
        ok: true,
        title: "Local Model Cost Snapshot Written",
        output: formatLocalLlmCostLedgerReport(report)
      };
    }

    if (action === "local-llm-routing-recommendations") {
      const projectDir = path.resolve(process.cwd(), sourceProject);
      const report = await loadLocalLlmRoutingRecommendationReport(ctx, {
        projectDir,
        limit: 50
      });
      await writeLocalLlmRoutingRecommendationReport(projectDir, report);
      return {
        ok: true,
        title: "Local Routing Recommendations Written",
        output: formatLocalLlmRoutingRecommendationReport(report)
      };
    }

    if (action === "local-llm-routing-note-plan") {
      const projectDir = path.resolve(process.cwd(), sourceProject);
      const recommendations = await loadLocalLlmRoutingRecommendationReport(ctx, {
        projectDir,
        limit: 50
      });
      const plan = buildLocalLlmRoutingNotePlan(recommendations, parseProposalIds(input.ids));
      await writeLocalLlmRoutingNotePlan(projectDir, plan);
      return {
        ok: true,
        title: "Local Routing Note Plan Written",
        output: formatLocalLlmRoutingNotePlan(plan)
      };
    }

    if (action === "apply-local-llm-routing-note-plan") {
      const projectDir = path.resolve(process.cwd(), sourceProject);
      const notePlan = await readLocalLlmRoutingNotePlan(projectDir);
      const selectedIds = input.ids?.trim() || "all";
      const plan = await buildLocalLlmRoutingNoteApplicationPlan({
        projectDir,
        notePlan,
        selectedIds: parseProposalIds(selectedIds),
        approved: false
      });
      return {
        ok: true,
        title: "Local Routing Note Apply Dry Run",
        output: `${formatLocalLlmRoutingNoteApplicationPlan(plan)}\n\nRun this command to append the reviewed notes:\nnpm run agentflow -- apply-local-llm-routing-note-plan --project ${shellQuote(sourceProject)} --ids ${shellQuote(selectedIds)} --approved --write`
      };
    }

    if (action === "local-llm-routing-decision-snapshot") {
      const projectDir = path.resolve(process.cwd(), sourceProject);
      const report = await loadLocalLlmRoutingDecisionSnapshotReport(ctx, {
        projectDir,
        limit: 50,
        write: true
      });
      return {
        ok: true,
        title: report.captured ? "Routing Decision Snapshot Captured" : "Routing Decision Snapshot Unchanged",
        output: formatLocalLlmRoutingDecisionSnapshotReport(report)
      };
    }

    if (action === "local-holdout-comparison") {
      const { modelPlan, source } = await loadLocalHoldoutModelPlan(sourceProject, true);
      const plan = buildCandidateComparisonPlan({
        modelPlan,
        baseline: {
          provider: "openai",
          modelTier: "standard",
          promptSuffix: "Use the hosted baseline provider with current project-local Agent Workflow instructions."
        },
        candidate: {
          provider: "local",
          modelTier: "fast",
          promptSuffix: "Use the local LLM candidate only for low-risk developer work, preserving evidence, brevity, and safety boundaries."
        }
      });
      await writeCandidateComparisonPlan(sourceProject, plan);
      return {
        ok: true,
        title: "Local Holdout Plan Written",
        output: [
          "Generated local LLM versus hosted-provider holdout comparison files.",
          `Source: ${source}`,
          `Suites: ${plan.suites.length}`,
          "",
          formatCandidateComparisonPlan(plan),
          "",
          "Next command:",
          `npm run agentflow -- evaluate -s <suite> -p ${shellQuote(sourceProject)}`
        ].join("\n")
      };
    }

    if (action === "local-holdout-results") {
      const report = await loadDashboardCandidateComparisonReport({
        projectDir: sourceProject
      });
      const result = buildLocalHoldoutResultSummary(report);
      await writeLocalHoldoutResultSummary(sourceProject, result);
      return {
        ok: true,
        title: "Local Holdout Results Captured",
        output: [
          formatLocalHoldoutResultSummary(result),
          "",
          "Next command:",
          result.decision === "eligible_for_review"
            ? `npm run agentflow -- promotion-note-plan --project ${shellQuote(sourceProject)} --suite all --write`
            : `npm run agentflow -- evaluate -s <suite> -p ${shellQuote(sourceProject)}`
        ].join("\n")
      };
    }

    if (action === "local-holdout-promote") {
      const results = await readLocalHoldoutResultSummary(sourceProject).catch(() => emptyLocalHoldoutResultSummary(sourceProject, "Capture local holdout results before approving local routing."));
      const promotion = buildLocalHoldoutRoutingPromotion(sourceProject, results, true);
      if (promotion.status !== "ready") {
        return {
          ok: false,
          error: promotion.reason
        };
      }
      await writeLocalHoldoutRoutingPromotion(sourceProject, promotion);
      return {
        ok: true,
        title: "Low-Risk Local Routing Approved",
        output: [
          formatLocalHoldoutRoutingPromotion(promotion),
          "",
          "Future compiled briefs can read .agent-workflow/tuning/routing-preferences.md as project-local routing context."
        ].join("\n")
      };
    }

    if (action === "debug-failure") {
      return runDashboardWorkflow(ctx, {
        title: "Debug Failure",
        workflow: "debug-failure",
        projectDir: sourceProject,
        task: `Investigate failures ${sourceLabel}: ${sourceTask}`
      });
    }

    if (action === "mira-ux-pass") {
      return runDashboardAgentTask(ctx, {
        title: "Mira UX Pass",
        agent: "Mira",
        projectDir: sourceProject,
        task: `Do a UX pass ${sourceLabel}: ${sourceTask}`
      });
    }

    if (action === "frontend-pass") {
      return runDashboardAgentTask(ctx, {
        title: "Frontend Pass",
        agent: "frontend",
        projectDir: sourceProject,
        task: `Review and plan frontend fixes ${sourceLabel}: ${sourceTask}`
      });
    }

    if (action === "maintain-context") {
      return runDashboardWorkflow(ctx, {
        title: "Maintain Context",
        workflow: "maintain-context",
        projectDir: sourceProject,
        task: `Update durable project context ${sourceLabel}: ${sourceTask}`
      });
    }

    if (preset) {
      return runWorkflowPreset(ctx, {
        presetRef: preset.id,
        project: input.project ?? sourceProject
      });
    }

  	  return { ok: false, error: `Unknown dashboard action: ${action}` };
  	}

  async function runDueSchedules(input: { projectDir: string; dryRun: boolean }): Promise<{ lines: string[] }> {
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      return {
        lines: missing.map((check) => `MISSING: ${check.endpoint.name} - ${check.message}`)
      };
    }

    const schedules = await loadProjectSchedules(input.projectDir);
    if (!schedules.length) {
      return { lines: [`No schedules found in ${path.join(input.projectDir, ".agent-workflow", "schedules.yaml")}`] };
    }

    const statePath = path.join(input.projectDir, ".agent-workflow", "schedule-state.json");
    const state = await readScheduleState(statePath);
    const now = Date.now();
    const lines: string[] = [];
    let stateChanged = false;

    for (const schedule of schedules) {
      if (schedule.enabled === false) {
        continue;
      }
      const lastRunAt = state[schedule.id]?.lastRunAt ? Date.parse(state[schedule.id].lastRunAt) : 0;
      const everyMs = Math.max(1, schedule.every_minutes ?? 1440) * 60_000;
      const due = !lastRunAt || now - lastRunAt >= everyMs;
      if (!due) {
        continue;
      }

      const label = schedule.workflow ? `workflow ${schedule.workflow}` : `agent ${schedule.agent}`;
      if (input.dryRun) {
        lines.push(`DUE ${schedule.id}: ${label} - ${schedule.task}`);
        continue;
      }

      const indexResult = await indexProjectForRun(ctx, {
        projectDir: input.projectDir,
        maxFiles: schedule.index_max_files ?? 100,
        refine: false,
        forceRefine: false
      });
      lines.push(`Indexed ${indexResult.count} files for ${indexResult.projectName}.`);

      let queuedRunId: string | null = null;
      if (schedule.agent) {
        const agents = await loadAgentsForProject(ctx, input.projectDir);
        const agent = resolveAgent(agents, schedule.agent);
        if (!agent) {
          lines.push(`FAILED ${schedule.id}: unknown agent ${schedule.agent}`);
          continue;
        }
        const workflow = createAgentTaskWorkflow(agent);
        const builtinAgentIds = new Set((await loadAgents(ctx.rootDir)).map((item) => item.id));
        await seedRegistry(builtinAgentIds.has(agent.id) ? [] : [{ path: `project/${agent.id}.yaml`, value: agent }], [{ path: `runtime/${workflow.id}.yaml`, value: workflow }]);
        const queued = await queueWorkflow(ctx, {
          workflowId: workflow.id,
          projectPath: input.projectDir,
          task: schedule.task,
          workflowOverride: workflow
        });
        if (!queued.ok) {
          lines.push(`FAILED ${schedule.id}: ${queued.error}`);
          continue;
        }
        queuedRunId = queued.run.runId;
      } else if (schedule.workflow) {
        const queued = await queueWorkflow(ctx, {
          workflowId: schedule.workflow,
          projectPath: input.projectDir,
          task: schedule.task
        });
        if (!queued.ok) {
          lines.push(`FAILED ${schedule.id}: ${queued.error}`);
          continue;
        }
        queuedRunId = queued.run.runId;
      } else {
        lines.push(`FAILED ${schedule.id}: provide workflow or agent`);
        continue;
      }

      const watchResult = await watchWorkflowRun({
        runId: queuedRunId,
        workerLimit: schedule.worker_limit ?? 6,
        intervalMs: 1000,
        timeoutMs: 900000
      });
      const exportResult = await exportWorkflowRun({
        runId: queuedRunId,
        outDir: path.join(input.projectDir, ".agent-workflow", "exports")
      });
      state[schedule.id] = {
        lastRunAt: new Date().toISOString(),
        lastRunId: queuedRunId,
        lastStatus: watchResult.status
      };
      stateChanged = true;
      lines.push(`RAN ${schedule.id}: ${queuedRunId} ${watchResult.status}`);
      if (exportResult.ok) {
        lines.push(`Exported Markdown: ${exportResult.markdownPath}`);
        lines.push(`Exported JSON: ${exportResult.jsonPath}`);
      }
    }

    if (stateChanged) {
      await writeScheduleState(statePath, state);
    }
    return { lines: lines.length ? lines : ["No schedules due."] };
  }

  async function runMcpPipelineSmoke(input: { launcherPath: string; pluginRoot: string }): Promise<RuntimeMonitorReport["mcpPipeline"]["smoke"]> {
    const command = `bash ${input.launcherPath}`;
    const checkedAt = new Date().toISOString();
    try {
      const [{ Client }, { StdioClientTransport }] = await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/client/stdio.js")
      ]);
      const transport = new StdioClientTransport({
        command: "bash",
        args: [input.launcherPath],
        cwd: input.pluginRoot,
        env: { ...process.env, AGENT_WORKFLOW_HOME: ctx.rootDir }
      });
      const client = new Client({ name: "agentflow-runtime-monitor", version: "0.0.0" });
      await client.connect(transport);
      const tools = await client.listTools();
      await client.close().catch(() => {});
      return {
        status: "passed",
        toolCount: tools.tools.length,
        message: `MCP launcher connected and returned ${tools.tools.length} tool(s).`,
        command,
        checkedAt
      };
    } catch (error) {
      return {
        status: "failed",
        toolCount: null,
        message: error instanceof Error ? error.message : String(error),
        command,
        checkedAt
      };
    }
  }

  function safeWorkerHeartbeatFileSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "") || "worker";
  }

  async function saveDashboardGraphPreset(form: URLSearchParams): Promise<DashboardGraphPresetActionResult> {
    const projectInput = form.get("project")?.trim() || "";
    const name = form.get("name")?.trim() || "";
    if (!projectInput) return { ok: false, error: "Missing project path." };
    if (!name) return { ok: false, error: "Preset name is required." };
    const projectDir = path.resolve(process.cwd(), projectInput);
    const presetFile = await readDashboardGraphPresets(projectDir);
    const now = new Date().toISOString();
    const id = safeFileSegment(name);
    const existing = presetFile.presets.find((preset) => preset.id === id);
    const filters = normalizeDashboardGraphPresetFilters({
      workflow: form.get("workflow") ?? "",
      project: projectInput,
      policyProfile: form.get("policyProfile") ?? "",
      view: form.get("view") ?? "",
      orientation: form.get("orientation") ?? "",
      category: form.get("category") ?? "",
      approval: form.get("approval") ?? "",
      policyStatus: form.get("policyStatus") ?? "",
      runStatus: form.get("runStatus") ?? "",
      runLimit: form.get("runLimit") ?? "",
      runScope: form.get("runScope") ?? "",
      stage: form.get("stage") ?? ""
    });
    const preset: DashboardGraphPreset = {
      id,
      name,
      description: form.get("description")?.trim() || "",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      filters
    };
    presetFile.presets = [preset, ...presetFile.presets.filter((item) => item.id !== id)].slice(0, 30);
    await writeDashboardGraphPresets(projectDir, presetFile);
    return { ok: true, href: graphPresetHref(preset) };
  }

  async function scheduleDashboardLaunchAgentScript(scriptName: string): Promise<string> {
    await fs.mkdir(ctx.defaultLaunchAgentLogDir, { recursive: true });
    const actionLogPath = path.join(ctx.defaultLaunchAgentLogDir, "actions.log");
    const scriptPath = path.join(ctx.rootDir, "scripts", scriptName);
    if (!await pathExists(scriptPath)) {
      throw new Error(`Missing LaunchAgent script: ${scriptPath}`);
    }
    const command = `${shellQuote(process.execPath)} ${shellQuote(scriptPath)} >> ${shellQuote(actionLogPath)} 2>&1`;
    const child = spawn("sh", ["-lc", `sleep 1; ${command}`], {
      cwd: ctx.rootDir,
      env: process.env,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return actionLogPath;
  }

  function splitProviderList(value: string): string[] {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  function trainingEvaluationVerdict(summary: string | null | undefined): "PASS" | "FAIL" | "INCONCLUSIVE" | null {
    const match = summary?.trim().match(/^(PASS|FAIL|INCONCLUSIVE)\b/u);
    return match ? match[1] as "PASS" | "FAIL" | "INCONCLUSIVE" : null;
  }

  async function updateDashboardModel(input: { provider: string; model: string }): Promise<DashboardFollowUpResult> {
    const selectedProvider = process.env.DEFAULT_MODEL_PROVIDER ?? "mock";
    if (input.provider !== selectedProvider) {
      return { ok: false, error: `Provider changed while editing. Current provider is ${selectedProvider}.` };
    }

    const model = input.model.trim();
    if (!model) {
      return { ok: false, error: "Missing model." };
    }

    const modelEnv = modelEnvForProvider(selectedProvider);
    if (!modelEnv) {
      return { ok: false, error: `${selectedProvider} does not support model selection.` };
    }

    await updateEnvValue(ctx.configuredEnvPath, modelEnv, model);
    process.env[modelEnv] = model;
    return {
      ok: true,
      title: "Model updated",
      output: [
        `${modelEnv}=${model}`,
        `Provider: ${selectedProvider}`,
        "New workflow tasks will use this model. Restart any already-running workers if you need them to pick up the change immediately.",
        "Open: /providers"
      ].join("\n")
    };
  }

  async function updateDashboardRouting(input: {
    provider: string;
    autoProviders: string;
    fastProvider: string;
    standardProvider: string;
    reasoningProvider: string;
    fallbackProvider: string;
    qualityThreshold: string;
    modelPolicy: string;
  }): Promise<DashboardFollowUpResult> {
    const provider = normalizeDashboardProvider(input.provider, { allowBlank: false });
    if (!provider) {
      return { ok: false, error: `Unsupported provider: ${input.provider}` };
    }

    const autoProviders = orderedUnique(splitProviderList(input.autoProviders)
      .map((item) => normalizeDashboardProvider(item, { allowBlank: false }))
      .filter((item): item is string => Boolean(item && item !== "auto")));
    const fastProvider = normalizeDashboardProvider(input.fastProvider, { allowBlank: false });
    const standardProvider = normalizeDashboardProvider(input.standardProvider, { allowBlank: false });
    const reasoningProvider = normalizeDashboardProvider(input.reasoningProvider, { allowBlank: false });
    const fallbackProvider = normalizeDashboardProvider(input.fallbackProvider, { allowBlank: true });
    const threshold = input.qualityThreshold.trim() || "0.62";
    const parsedThreshold = Number(threshold);
    const modelPolicy = normalizeModelSelectionPolicy(input.modelPolicy);

    if (!fastProvider || !standardProvider || !reasoningProvider || fallbackProvider === undefined) {
      return { ok: false, error: "One or more routing providers are unsupported." };
    }
    if (!Number.isFinite(parsedThreshold) || parsedThreshold < 0 || parsedThreshold > 1) {
      return { ok: false, error: "Quality threshold must be a number between 0 and 1." };
    }

    const updates: Record<string, string> = {
      DEFAULT_MODEL_PROVIDER: provider,
      AGENTFLOW_ROUTING_MODE: provider === "auto" ? "adaptive" : process.env.AGENTFLOW_ROUTING_MODE || "adaptive",
      AGENTFLOW_AUTO_PROVIDERS: autoProviders.length ? autoProviders.join(",") : "local,byo,bedrock,deepseek,gemini,groq,openrouter,nvidia,openai,anthropic,openai-compatible,kiro",
      AGENTFLOW_PROVIDER_FAST: fastProvider,
      AGENTFLOW_PROVIDER_STANDARD: standardProvider,
      AGENTFLOW_PROVIDER_REASONING: reasoningProvider,
      AGENTFLOW_FALLBACK_PROVIDER: fallbackProvider,
      AGENTFLOW_QUALITY_THRESHOLD: String(parsedThreshold),
      AGENTFLOW_MODEL_POLICY: modelPolicy
    };

    const envPath = ctx.configuredEnvPath;
    for (const [key, value] of Object.entries(updates)) {
      await updateEnvValue(envPath, key, value);
      process.env[key] = value;
    }

    return {
      ok: true,
      title: "Routing updated",
      output: [
        `DEFAULT_MODEL_PROVIDER=${updates.DEFAULT_MODEL_PROVIDER}`,
        `AGENTFLOW_AUTO_PROVIDERS=${updates.AGENTFLOW_AUTO_PROVIDERS}`,
        `AGENTFLOW_PROVIDER_FAST=${updates.AGENTFLOW_PROVIDER_FAST}`,
        `AGENTFLOW_PROVIDER_STANDARD=${updates.AGENTFLOW_PROVIDER_STANDARD}`,
        `AGENTFLOW_PROVIDER_REASONING=${updates.AGENTFLOW_PROVIDER_REASONING}`,
        `AGENTFLOW_FALLBACK_PROVIDER=${updates.AGENTFLOW_FALLBACK_PROVIDER || "none"}`,
        `AGENTFLOW_QUALITY_THRESHOLD=${updates.AGENTFLOW_QUALITY_THRESHOLD}`,
        `AGENTFLOW_MODEL_POLICY=${updates.AGENTFLOW_MODEL_POLICY}`,
        "New workflow tasks will use this routing. Already-running workers should be restarted if they need the updated environment.",
        "Open: /providers"
      ].join("\n")
    };
  }

  async function updateProjectTrustedCommand(input: { projectRootUri: string; pattern: string; operation: "add" | "remove" }): Promise<DashboardFollowUpResult> {
    if (!input.projectRootUri.trim()) return { ok: false, error: "Choose a project for a project-scoped trusted command." };
    const projectRoot = path.resolve(input.projectRootUri);
    const configPath = path.join(projectRoot, ".agent-workflow", "project.yaml");
    await ensureProjectSubdir(projectRoot, path.dirname(configPath), ".agent-workflow");
    const pattern = normalizeTrustedCommandPattern(input.pattern);
    const current = YAML.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    const actions = isRecord(current.actions) ? current.actions : {};
    const parsed = projectConfigSchema.parse(current);
    const commands = input.operation === "add"
      ? [...new Set([...parsed.actions.allowed_commands, pattern])]
      : parsed.actions.allowed_commands.filter((command) => command !== pattern);
    const next = { ...current, actions: { ...actions, allowed_commands: commands } };
    projectConfigSchema.parse(next);
    const tempPath = `${configPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, YAML.stringify(next), "utf8");
    await fs.rename(tempPath, configPath);
    return {
      ok: true,
      title: input.operation === "add" ? "Project trusted command added" : "Project trusted command removed",
      output: [`Pattern: ${pattern}`, `Project: ${projectRoot}`, `Config: ${configPath}`].join("\n")
    };
  }

  async function updateRoadmapTaskPriority(form: URLSearchParams): Promise<DashboardFollowUpResult> {
    const lineNumber = parsePositiveInteger(form.get("line") ?? "", 0);
    const priority = parseRoadmapPriority(form.get("priority") ?? "");
    if (!lineNumber || !priority) return { ok: false, error: "Roadmap priority update requires a checklist line and valid priority." };
    const roadmapPath = path.join(ctx.rootDir, "docs", "roadmap.md");
    const markdown = await fs.readFile(roadmapPath, "utf8");
    const lines = markdown.split(/\r?\n/u);
    const index = lineNumber - 1;
    const line = lines[index];
    if (!line || !/^- \[(x| )\]\s+/iu.test(line)) {
      return { ok: false, error: "Only checklist-backed roadmap rows can have priority edited." };
    }

    let insertAt = index + 1;
    let existingPriorityIndex = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const current = lines[cursor];
      if (/^##\s+/u.test(current) || /^- \[(x| )\]\s+/iu.test(current)) break;
      if (/^\s+-\s+Milestone:/iu.test(current)) insertAt = cursor + 1;
      if (/^\s+-\s+Priority:/iu.test(current)) {
        existingPriorityIndex = cursor;
        break;
      }
    }
    if (existingPriorityIndex >= 0) {
      lines[existingPriorityIndex] = `  - Priority: ${priority}`;
    } else {
      lines.splice(insertAt, 0, `  - Priority: ${priority}`);
    }
    await fs.writeFile(roadmapPath, lines.join("\n"), "utf8");
    return {
      ok: true,
      title: `Roadmap priority set to ${priority}`,
      output: `Updated docs/roadmap.md:${lineNumber} priority to ${priority}.`
    };
  }

  async function updateRoadmapTaskStatus(form: URLSearchParams): Promise<DashboardFollowUpResult> {
    const lineNumber = parsePositiveInteger(form.get("line") ?? "", 0);
    const desiredStatus = form.get("status") === "done" ? "done" : form.get("status") === "open" ? "open" : null;
    if (!lineNumber || !desiredStatus) return { ok: false, error: "Roadmap status update requires a checklist line and status." };
    const roadmapPath = path.join(ctx.rootDir, "docs", "roadmap.md");
    const markdown = await fs.readFile(roadmapPath, "utf8");
    const lines = markdown.split(/\r?\n/u);
    const index = lineNumber - 1;
    const line = lines[index];
    if (!line || !/^- \[(x| )\]\s+/iu.test(line)) {
      return { ok: false, error: "Only checklist-backed roadmap rows can be marked done or open." };
    }
    const nextMarker = desiredStatus === "done" ? "x" : " ";
    const nextLine = line.replace(/^- \[(x| )\]/iu, `- [${nextMarker}]`);
    if (nextLine === line) {
      return { ok: true, title: "Roadmap already up to date", output: `docs/roadmap.md:${lineNumber} already has status ${desiredStatus}.` };
    }
    lines[index] = nextLine;
    await fs.writeFile(roadmapPath, lines.join("\n"), "utf8");
    return {
      ok: true,
      title: `Roadmap marked ${desiredStatus}`,
      output: `Updated docs/roadmap.md:${lineNumber} to ${desiredStatus}.`
    };
  }

  async function writeDashboardGraphPresets(projectDir: string, presetFile: DashboardGraphPresetFile): Promise<void> {
    const filePath = dashboardGraphPresetsPath(projectDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload: DashboardGraphPresetFile = {
      kind: "agentflow_graph_presets",
      projectRootUri: projectDir,
      updatedAt: new Date().toISOString(),
      presets: presetFile.presets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    };
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  async function writeLearningSettings(projectDir: string, settings: LearningSettings): Promise<void> {
    const learningDir = path.join(projectDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
    await fs.writeFile(path.join(learningDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    const configPath = path.join(projectDir, ".agent-workflow", "project.yaml");
    const config = YAML.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    const actions = isRecord(config.actions) ? config.actions : {};
    const nextConfig = {
      ...config,
      actions: {
        ...actions,
        auto_approve_max_risk: settings.approvalAutopilotEnabled ? settings.approvalAutopilotMaxRisk : "none"
      }
    };
    projectConfigSchema.parse(nextConfig);
    await fs.writeFile(configPath, YAML.stringify(nextConfig), "utf8");
  }

  async function writeMcpRecoveryPackage(pipeline: RuntimeMonitorReport["mcpPipeline"]): Promise<RuntimeMonitorReport["mcpPipeline"]["recovery"]> {
    const recovery = await loadMcpRecoveryStatus();
    const generatedAt = new Date().toISOString();
    await fs.mkdir(recovery.directory, { recursive: true });
    const payload = {
      kind: "agentflow_mcp_recovery_package",
      generatedAt,
      repo: ctx.rootDir,
      status: pipeline.status,
      smoke: pipeline.smoke,
      clientReload: pipeline.clientReload,
      approvalDiagnostics: pipeline.approvalDiagnostics,
      logs: {
        launcher: pipeline.launcherLogPath,
        stdio: pipeline.stdioLogPath
      },
      recentLauncherEvents: pipeline.lastLauncherEvents.slice(-12),
      recentStdioEvents: pipeline.lastStdioEvents.slice(-12),
      safeCommands: [
        "npm run runtime-monitor -- --check-mcp",
        "npm run runtime-monitor -- --cleanup-mcp",
        "npm run runtime-monitor -- --cleanup-mcp --confirm --auto-low-risk",
        "npm run doctor",
        "npm run dev:agentflow"
      ],
      note: recovery.reason
    };
    await fs.writeFile(recovery.jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.writeFile(recovery.markdownPath, formatMcpRecoveryMarkdown(payload), "utf8");
    await fs.writeFile(recovery.scriptPath, formatMcpRecoveryScript(), { encoding: "utf8", mode: 0o755 });
    await fs.chmod(recovery.scriptPath, 0o755).catch(() => {});
    return {
      ...recovery,
      status: "available",
      lastWrittenAt: generatedAt
    };
  }

  async function writeScheduleState(statePath: string, state: Record<string, { lastRunAt: string; lastRunId: string; lastStatus: string }>): Promise<void> {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  program
    .command("artifacts")
    .description("Inspect compiled briefs and stage output artifacts")
    .option("-r, --run <id>", "workflow run id")
    .option("-k, --kind <kind>", "artifact kind, for example compiled_brief or stage_output")
    .option("-u, --uri <uri>", "specific artifact URI")
    .option("--json", "print full artifact JSON")
    .option("--content", "print artifact content only")
    .action(async (options: { run?: string; kind?: string; uri?: string; json?: boolean; content?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      if (options.uri) {
        const artifact = await getArtifactByUri(options.uri);
        if (!artifact) {
          console.error(`Unknown artifact URI: ${options.uri}`);
          process.exitCode = 1;
          return;
        }
        printArtifact(artifact, Boolean(options.json), Boolean(options.content));
        return;
      }

      if (!options.run) {
        console.error("Provide --run <id> or --uri <uri>.");
        process.exitCode = 1;
        return;
      }

      const artifacts = await listArtifacts({
        runId: options.run,
        kind: options.kind
      });

      if (!artifacts.length) {
        console.log("No artifacts found.");
        return;
      }

      for (const artifact of artifacts) {
        printArtifact(artifact, Boolean(options.json), Boolean(options.content));
      }
    });

  program
    .command("artifact-lifecycle")
    .description("Inspect read-only artifact inventory, age buckets, and storage lifecycle hints")
    .option("-p, --project <dir>", "filter by project directory")
    .option("-k, --kind <kind>", "filter by artifact kind")
    .option("-l, --limit <number>", "number of recent artifacts to inspect", "500")
    .option("--prune-plan", "include a dry-run prune plan; does not delete anything")
    .option("--archive-plan", "include a dry-run archive plan; does not archive anything")
    .option("--restore-plan", "include a dry-run restore plan from archived artifact snapshots; does not restore anything")
    .option("--min-age-days <number>", "override minimum artifact age for prune candidates")
    .option("--min-bytes <number>", "override minimum artifact JSON size for prune candidates")
    .option("--include-audit", "allow audit artifacts in the dry-run prune plan")
    .option("--queue-approvals", "queue approval requests for dry-run prune candidates; does not execute pruning")
    .option("--queue-archive-approvals", "queue approval requests for dry-run archive candidates; does not execute archiving")
    .option("--queue-restore-approvals", "queue approval requests for dry-run restore candidates; does not execute restore")
    .option("--actor <name>", "person or tool requesting lifecycle approvals", "cli")
    .option("--actor-role <role>", "project role for approval request audit", "operator")
    .option("--json", "print machine-readable artifact lifecycle report")
    .action(async (options: { project?: string; kind?: string; limit: string; prunePlan?: boolean; archivePlan?: boolean; restorePlan?: boolean; minAgeDays?: string; minBytes?: string; includeAudit?: boolean; queueApprovals?: boolean; queueArchiveApprovals?: boolean; queueRestoreApprovals?: boolean; actor: string; actorRole: string; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }
      if ((options.queueApprovals || options.queueArchiveApprovals || options.queueRestoreApprovals) && !options.project) {
        console.error("Queueing lifecycle approvals requires --project so project-local lifecycle policy and roles can be checked.");
        process.exitCode = 1;
        return;
      }
      const report = await loadArtifactLifecycleReport({
        projectRootUri: options.project,
        kind: options.kind,
        limit: parsePositiveInteger(options.limit, 500),
        prunePlan: Boolean(options.prunePlan || options.queueApprovals),
        archivePlan: Boolean(options.archivePlan || options.queueArchiveApprovals),
        restorePlan: Boolean(options.restorePlan || options.queueRestoreApprovals),
        minAgeDays: options.minAgeDays ? parseNonNegativeInteger(options.minAgeDays, 30) : undefined,
        minBytes: options.minBytes ? parseNonNegativeInteger(options.minBytes, 20_000) : undefined,
        includeAudit: options.includeAudit === true ? true : undefined
      });
      if (options.queueApprovals) {
        report.approvalQueues.push(await queueArtifactLifecycleApprovals({
          report,
          action: "prune",
          actor: options.actor,
          actorRole: normalizeActorRole(options.actorRole, "operator")
        }));
      }
      if (options.queueArchiveApprovals) {
        report.approvalQueues.push(await queueArtifactLifecycleApprovals({
          report,
          action: "archive",
          actor: options.actor,
          actorRole: normalizeActorRole(options.actorRole, "operator")
        }));
      }
      if (options.queueRestoreApprovals) {
        report.approvalQueues.push(await queueArtifactLifecycleApprovals({
          report,
          action: "restore",
          actor: options.actor,
          actorRole: normalizeActorRole(options.actorRole, "operator")
        }));
      }
      console.log(options.json ? JSON.stringify(report, null, 2) : formatArtifactLifecycleReport(report));
    });

  program
    .command("backup-report")
    .description("Inspect read-only backup inventory and restore-drill readiness for local enterprise storage")
    .option("-p, --project <dir>", "filter by project directory")
    .option("-l, --limit <number>", "number of recent artifacts, approvals, and queue rows to inspect", "500")
    .option("--json", "print machine-readable backup readiness report")
    .action(async (options: { project?: string; limit: string; json?: boolean }) => {
      const projectRootUri = options.project ? path.resolve(process.cwd(), options.project) : undefined;
      const report = await loadBackupRestoreReport({
        projectRootUri,
        limit: parsePositiveInteger(options.limit, 500)
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatBackupRestoreReport(report));
    });

  program
    .command("restore-drill")
    .description("Verify archived/restored artifact lineage without mutating storage")
    .option("-p, --project <dir>", "filter by project directory")
    .option("-l, --limit <number>", "number of restored artifact snapshots to inspect", "100")
    .option("--json", "print machine-readable restore verification report")
    .action(async (options: { project?: string; limit: string; json?: boolean }) => {
      const projectRootUri = options.project ? path.resolve(process.cwd(), options.project) : undefined;
      const report = await loadRestoreDrillReport({
        projectRootUri,
        limit: parsePositiveInteger(options.limit, 100)
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatRestoreDrillReport(report));
    });

  program
    .command("runtime-monitor")
    .description("Inspect local Agent Workflow processes, local service listeners, and shared shared host storage health")
    .option("--cleanup-mcp", "preview stale Agent Workflow MCP cleanup candidates; pair with --confirm to terminate them")
    .option("--reconcile-stale-runs", "preview stale workflow runs whose child tasks are already terminal; pair with --confirm to repair them")
    .option("--check-mcp", "run an on-demand MCP launcher smoke check")
    .option("--write-mcp-recovery", "write a local MCP recovery package with runbook, metadata, and a safe helper script")
    .option("--confirm", "confirm cleanup-mcp termination")
    .option("--auto-low-risk", "with cleanup-mcp, terminate only old duplicate low-risk MCP candidates")
    .option("--stale-minutes <number>", "age threshold for daemon/auto-low-risk MCP cleanup candidates")
    .option("--stale-run-limit <number>", "maximum stale terminal workflow runs to inspect or reconcile", "50")
    .option("--json", "print machine-readable runtime monitor report")
    .action(async (options: { cleanupMcp?: boolean; reconcileStaleRuns?: boolean; checkMcp?: boolean; writeMcpRecovery?: boolean; confirm?: boolean; autoLowRisk?: boolean; staleMinutes?: string; staleRunLimit: string; json?: boolean }) => {
      if (options.cleanupMcp) {
        const result = await cleanupRuntimeMcpProcesses(ctx, {
          execute: Boolean(options.confirm),
          autoLowRiskOnly: Boolean(options.autoLowRisk),
          staleMinutes: parseRuntimeMcpStaleMinutes(options.staleMinutes)
        });
        console.log(options.json ? JSON.stringify(result, null, 2) : formatRuntimeMcpCleanupResult(result));
        if (result.warnings.length) process.exitCode = 1;
        return;
      }
      if (options.reconcileStaleRuns) {
        const result = await reconcileStaleTerminalWorkflowRuns({
          execute: Boolean(options.confirm),
          limit: parsePositiveInteger(options.staleRunLimit, 50),
          actor: "runtime-monitor"
        });
        console.log(options.json ? JSON.stringify(result, null, 2) : formatRuntimeStaleRunReconciliationResult(result));
        return;
      }
      const report = await loadRuntimeMonitorReport({ checkMcp: Boolean(options.checkMcp || options.writeMcpRecovery) });
      if (options.writeMcpRecovery) {
        report.mcpPipeline.recovery = await writeMcpRecoveryPackage(report.mcpPipeline);
      }
      console.log(options.json ? JSON.stringify(report, null, 2) : formatRuntimeMonitorReport(report));
      if (!report.sharedHost.reachable || report.mcpPipeline.status !== "ok" || report.mcpPipeline.smoke.status === "failed") process.exitCode = 1;
    });

  program
    .command("roadmap-audit")
    .description("Check roadmap task, bug, milestone, and priority hygiene")
    .option("--json", "print machine-readable roadmap audit")
    .action(async (options: { json?: boolean }) => {
      const report = await loadRoadmapDashboardReport();
      console.log(options.json ? JSON.stringify(report, null, 2) : formatRoadmapAuditReport(report));
      if (report.summary.unlinkedCount > 0) process.exitCode = 1;
    });

  program
    .command("schedule")
    .description("Run due project schedules from .agent-workflow/schedules.yaml")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--watch", "keep polling for due schedules")
    .option("--interval-ms <number>", "watch polling interval in milliseconds", "60000")
    .option("--dry-run", "print due schedules without running them")
    .action(async (options: { project: string; watch?: boolean; intervalMs: string; dryRun?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const intervalMs = parsePositiveInteger(options.intervalMs, 60000);

      do {
        const result = await runDueSchedules({
          projectDir,
          dryRun: Boolean(options.dryRun)
        });
        for (const line of result.lines) {
          console.log(line);
        }
        if (!options.watch) {
          return;
        }
        await sleep(intervalMs);
      } while (true);
    });

  program
    .command("dashboard")
    .description("Start a local dashboard for workflow runs and artifacts")
    .option("--host <host>", "host to bind", "127.0.0.1")
    .option("--port <number>", "port to bind", "17888")
    .action(async (options: { host: string; port: string }) => {
      const port = parsePositiveInteger(options.port, 17888);
      const server = http.createServer(async (request, response) => {
        const releaseRequestSlot = await acquireDashboardRequestSlot();
        try {
          await handleDashboardRequest(request, response);
        } catch (error) {
          console.error("Dashboard request failed:", redactApprovalCardText(error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : "Unknown error", 1500));
          finishDashboardPageError(request, response);
        } finally {
          releaseRequestSlot();
        }
      });

      await new Promise<void>((resolve) => {
        server.listen(port, options.host, resolve);
      });
      console.log(`Agent Workflow dashboard: http://${options.host}:${port}`);
    });

  program
    .command("exec-command")
    .description("Execute an allowed local command and record an audit receipt")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("-r, --run <id>", "workflow run id for receipt")
    .option("-a, --agent <id>", "agent id to associate with the action", "implementation-agent")
    .argument("<command...>", "command to execute")
    .action(async (commandParts: string[], options: { project: string; run: string; agent: string }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const project = await loadProjectConfig(projectDir);
      const commandLine = commandParts.join(" ");
      const execution=await resolveRunExecutionRoot({runId:options.run,canonicalRoot:projectDir});
      if(execution.contract?.required&&execution.contract.isolation==='project-artifacts')throw Error('Project-artifact workflows do not authorize local commands');
      const result = await executeAllowedCommand({
        commandLine,
        cwd: execution.root,
        project,
        environmentContext:execution.contract?.required?{runId:options.run,workflowId:execution.workflowId,requireEnvironment:true,managedSource:execution.contract.sourceChanges}:undefined
      });

      const summary = [
        `Command \`${result.commandLine}\` exited with ${result.exitCode}`,
        result.timedOut ? "after timing out" : `in ${result.durationMs}ms`
      ].join(" ");
      const artifactUri = await recordRunAction({
        runId: options.run,
        agentId: options.agent,
        actionType: "local_command",
        target: result.commandLine,
        summary,
        artifactKind: "command_output",
        artifactContent: {
          ...result
        }
      });

      console.log(summary);
      console.log(`Artifact: ${artifactUri}`);
      if (result.stdout.trim()) {
        console.log("");
        console.log("stdout");
        console.log(result.stdout.trim());
      }
      if (result.stderr.trim()) {
        console.log("");
        console.log("stderr");
        console.log(result.stderr.trim());
      }

      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode ?? 1;
      }
    });

  program
    .command("worker-host-trust")
    .description("Preview or apply governed fleet worker host enrollment, rotation, or revocation")
    .requiredOption("--action <action>","enroll, rotate, or disable")
    .requiredOption("--host-id <id>","stable registered fleet host identity")
    .option("--public-key <path>","operator-supplied Ed25519 public key for enroll or rotate")
    .option("--builds <digests>","comma-separated allowed runtime build digests")
    .option("--expires-at <timestamp>","optional host key expiry")
    .option("--overlap-until <timestamp>","required old-key overlap limit for rotation")
    .option("--actor <name>","operator identity recorded on apply")
    .option("--write","apply the previewed change and append an immutable receipt")
    .option("--json","print machine-readable output")
    .action(async(options:{action:string;hostId:string;publicKey?:string;builds?:string;expiresAt?:string;overlapUntil?:string;actor?:string;write?:boolean;json?:boolean})=>{
      if(!["enroll","rotate","disable"].includes(options.action))throw new Error("--action must be enroll, rotate, or disable");
      const registryPath=workerTrustStorePath;
      const receiptPath=path.join(path.dirname(registryPath),"worker-host-trust-receipts.jsonl");
      const store=await loadWorkerTrustStore();
      const publicKey=options.publicKey?await fs.readFile(path.resolve(options.publicKey),"utf8"):undefined;
      const plan=buildWorkerHostRegistryPlan({store,action:options.action as WorkerHostRegistryAction,hostId:options.hostId,publicKey,allowedRuntimeBuildDigests:options.builds?.split(","),expiresAt:options.expiresAt,overlapUntil:options.overlapUntil});
      if(!options.write){
        const preview={mode:"preview",registryPath,receiptPath,plan};
        console.log(options.json?JSON.stringify(preview,null,2):[`Fleet host ${plan.action} preview ${plan.id}`,`Host: ${plan.hostId}`,`Key: ${plan.keyFingerprint??"all registered keys"}`,`Before: ${plan.beforeDigest}`,`After: ${plan.afterDigest}`,...plan.warnings.map(warning=>`Warning: ${warning}`),"No files changed. Re-run with --write --actor <name> after review."].join("\n"));
        return;
      }
      if(!options.actor?.trim())throw new Error("--write requires --actor so the trust change has accountable provenance.");
      const receipt=await applyWorkerHostRegistryPlan({plan,registryPath,receiptPath,actor:options.actor.trim()});
      console.log(options.json?JSON.stringify({mode:"applied",receipt},null,2):`Applied ${receipt.action} for ${receipt.hostId}; receipt ${receipt.id}.`);
    });

  program
    .command("worker")
    .description("Execute queued workflow stage tasks")
    .option("-l, --limit <number>", "maximum tasks to execute", "1")
    .option("--watch", "keep polling for queued workflow tasks")
    .option("--interval-ms <number>", "watch polling interval in milliseconds", "2000")
    .option("--worker-id <id>", "stable worker lane label; lease ownership includes a unique process incarnation")
    .option("--lease-seconds <number>", "renewable running-task lease duration in seconds", "120")
    .option("-p, --project <dir>", "only claim queued tasks for one project root")
    .option("--all-projects", "use project worker-pool defaults without restricting queue claims to that project")
    .option("--concurrency <number>", "maximum tasks this worker may execute at the same time", "1")
    .option("--per-project-concurrency <number>", "maximum active stages from any one project", "2")
    .option("--heartbeat-file <path>", "worker heartbeat file path", ctx.defaultWorkerHeartbeatPath)
    .action(async (options: { limit: string; watch?: boolean; intervalMs: string; workerId?: string; leaseSeconds: string; project?: string; allProjects?: boolean; concurrency: string; perProjectConcurrency: string; heartbeatFile: string }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        console.error("\nStart local enterprise services with:");
        console.error("docker compose -f infra/docker-compose.yml up -d");
        process.exitCode = 1;
        return;
      }

      const configuredProjectRootUri = options.project ? path.resolve(process.cwd(), options.project) : undefined;
      const workerDefaults = configuredProjectRootUri ? await loadProjectWorkerPoolDefaults(configuredProjectRootUri) : {};
      const limit = Number.parseInt(cliOptionValue(options.limit, ["--limit", "-l"], String(workerDefaults.limit ?? 1)), 10);
      if (!Number.isFinite(limit) || limit < 1) {
        console.error("--limit must be a positive integer");
        process.exitCode = 1;
        return;
      }
      const { workerId, workerLabel } = createWorkerIdentity(normalizeWorkerId(cliOptionValue(options.workerId, ["--worker-id"], workerDefaults.workerId)));
      const leaseSeconds = Number.parseInt(cliOptionValue(options.leaseSeconds, ["--lease-seconds"], String(workerDefaults.leaseSeconds ?? 120)), 10);
      if (!Number.isFinite(leaseSeconds) || leaseSeconds < 30) {
        console.error("--lease-seconds must be an integer >= 30");
        process.exitCode = 1;
        return;
      }
      const concurrency = parseBoundedPositiveInteger(cliOptionValue(options.concurrency, ["--concurrency"], String(workerDefaults.concurrency ?? 1)), 1, 16);
      const perProjectConcurrency = parseBoundedPositiveInteger(cliOptionValue(options.perProjectConcurrency, ["--per-project-concurrency"], String(workerDefaults.perProjectConcurrency ?? 2)), 1, 16);
      const projectScoped = workerDefaults.projectScoped !== false && !options.allProjects;
      const projectRootUri = configuredProjectRootUri && projectScoped ? configuredProjectRootUri : undefined;
      const workerProjectIdentity=projectRootUri?await withClient(async client=>{
        const available=Boolean((await client.query("select to_regclass('project_identity_locations') as name")).rows[0]?.name);
        if(!available)return null;
        return (await client.query<{projectId:string;projectIdentityId:string;projectIdentityGeneration:number}>(`select p.id::text as "projectId",l.identity_id::text as "projectIdentityId",l.generation as "projectIdentityGeneration" from projects p join project_identity_locations l on l.project_id=p.id where p.root_uri=$1 limit 1`,[projectRootUri])).rows[0]??null;
      }).catch(()=>null):null;
      const workerSourceRevision=projectRootUri?(await execFileText(ctx,"git",["-C",projectRootUri,"rev-parse","HEAD"],{allowFailure:true})).stdout.trim()||null:null;

      if (!options.watch) {
        const capabilities = await probeWorkerProviderCapabilities();
        const result = await runWorkerOnce(limit, { workerId, leaseSeconds, projectRootUri, concurrency, perProjectConcurrency, providerIds: capabilities.ready, defaultProviderId: process.env.DEFAULT_MODEL_PROVIDER?.trim() || "mock", workerPlatform: process.platform });
        console.log(`Worker ${workerId} claimed ${result.claimed}, completed ${result.completed}, failed ${result.failed}.`);
        if (projectRootUri) console.log(`Project scope: ${projectRootUri}`);
        console.log(`Concurrency: ${concurrency}`);
        console.log(`Per-project concurrency: ${perProjectConcurrency}`);
        const approvalNotice = await formatPendingApprovalInboxNotice(projectRootUri);
        if (approvalNotice) {
          console.log("");
          console.log(approvalNotice);
        }
        return;
      }

      const intervalMs = Number.parseInt(cliOptionValue(options.intervalMs, ["--interval-ms"], String(workerDefaults.intervalMs ?? 2000)), 10);
      if (!Number.isFinite(intervalMs) || intervalMs < 250) {
        console.error("--interval-ms must be an integer >= 250");
        process.exitCode = 1;
        return;
      }

      let stop = false;
      let ticks = 0;
      let latestTick: Awaited<ReturnType<typeof runWorkerOnce>> | undefined;
      const startedAt = new Date().toISOString();
      let capabilities: Awaited<ReturnType<typeof probeWorkerProviderCapabilities>> = { ready: [], unavailable: [] };
      let executionCapabilityProbes: Array<ExecutionCapabilityProbe&{runtimeVersion:string}> = [];
      const workerHostId=process.env.AGENTFLOW_WORKER_HOST_ID?.trim()||os.hostname();
      const attestationKeyFile=process.env.AGENTFLOW_WORKER_ATTESTATION_PRIVATE_KEY_FILE?.trim();
      const attestationPrivateKey=attestationKeyFile?await fs.readFile(path.resolve(attestationKeyFile),"utf8").catch(()=>null):null;
      let heartbeatSequence=BigInt(Date.now())*1_000n;
      const configuredProbeInterval=Number.parseInt(process.env.AGENTFLOW_EXECUTION_CAPABILITY_PROBE_INTERVAL_MS??"60000",10);
      const executionCapabilityProbeIntervalMs=Math.min(3_600_000,Math.max(15_000,Number.isFinite(configuredProbeInterval)?configuredProbeInterval:60_000));
      let lastExecutionCapabilityProbeAt=0;
      let executionCapabilityProbeRefresh:Promise<void>|null=null;
      const refreshExecutionCapabilityProbes=async(force=false):Promise<void>=>{
        if(!force&&Date.now()-lastExecutionCapabilityProbeAt<executionCapabilityProbeIntervalMs)return;
        if(executionCapabilityProbeRefresh)return executionCapabilityProbeRefresh;
        executionCapabilityProbeRefresh=(async()=>{
          const runtimeMetadata=await ctx.runtimeVersionMetadata;
          const next=(await probeCommandExecutionCapabilities()).map(probe=>({...probe,runtimeVersion:runtimeMetadata.runtimeVersion}));
          executionCapabilityProbes=next;
          lastExecutionCapabilityProbeAt=Date.now();
        })().finally(()=>{executionCapabilityProbeRefresh=null;});
        return executionCapabilityProbeRefresh;
      };
      const heartbeatFile = path.resolve(process.cwd(), options.heartbeatFile);
      const registryHeartbeatFile = path.join(ctx.defaultWorkerHeartbeatDir, `${safeWorkerHeartbeatFileSegment(workerId)}-${process.pid}.json`);
      const writeHeartbeat = async (status: WorkerHeartbeat["status"], tick?: Awaited<ReturnType<typeof runWorkerOnce>>, countTick = true): Promise<void> => {
        if (tick && countTick) {
          ticks += 1;
          latestTick = tick;
        }
        const runtimeMetadata=await ctx.runtimeVersionMetadata;
        const runtimeBuildDigest=workerRuntimeBuildDigest({runtimeVersion:runtimeMetadata.runtimeVersion,bundleVersion:runtimeMetadata.bundleVersion,protocolVersions:runtimeMetadata.protocolVersions,executionCapabilityProbes});
        const heartbeat: WorkerHeartbeat = {
          ...runtimeMetadata,
          pid: process.pid,
          workerId,
          workerLabel,
          hostId:workerHostId,
          runtimeBuildDigest,
          projectRootUri: projectRootUri ?? null,
          projectId:workerProjectIdentity?.projectId??null,
          projectIdentityId:workerProjectIdentity?.projectIdentityId??null,
          projectIdentityGeneration:workerProjectIdentity?.projectIdentityGeneration??null,
          sourceRevision:workerSourceRevision,
          concurrency,
          perProjectConcurrency,
          startedAt,
          lastHeartbeatAt: new Date().toISOString(),
          limit,
          intervalMs,
          ticks,
          claimed: tick?.claimed ?? 0,
          completed: tick?.completed ?? 0,
          failed: tick?.failed ?? 0,
          providerIds: tick?.providerIds ?? capabilities.ready,
          unavailableProviderIds: [...new Set([
            ...capabilities.unavailable.map((item) => item.providerId),
            ...(tick?.quarantinedProviderIds ?? [])
          ])],
          executionCapabilities: executionCapabilityProbes.filter(probe=>probe.status==="passed").map(probe=>probe.id),
          executionCapabilityProbes,
          executionCapabilityProbeIntervalMs,
          status,
          command: `agentflow worker --watch --limit ${limit} --interval-ms ${intervalMs} --worker-id ${workerLabel} --lease-seconds ${leaseSeconds}${projectRootUri ? ` --project ${shellQuote(projectRootUri)}` : ""} --concurrency ${concurrency} --per-project-concurrency ${perProjectConcurrency}`
        };
        if(attestationPrivateKey){
          heartbeatSequence+=1n;
          heartbeat.attestation=signWorkerHeartbeat({heartbeat:heartbeat as unknown as Record<string,unknown>,hostId:workerHostId,privateKey:attestationPrivateKey,runtimeBuildDigest,sequence:heartbeatSequence.toString(),ttlMs:Math.max(15_000,Math.min(60_000,intervalMs*10))});
        }
        await fs.mkdir(path.dirname(heartbeatFile), { recursive: true });
        await fs.writeFile(heartbeatFile, `${JSON.stringify(heartbeat, null, 2)}\n`, "utf8");
        await fs.mkdir(path.dirname(registryHeartbeatFile), { recursive: true });
        if (registryHeartbeatFile !== heartbeatFile) {
          await fs.writeFile(registryHeartbeatFile, `${JSON.stringify(heartbeat, null, 2)}\n`, "utf8");
        }
      };
      const stopWorker = () => {
        stop = true;
        console.log("Stopping worker after current tick...");
      };
      process.once("SIGINT", stopWorker);
      process.once("SIGTERM", stopWorker);

      await writeHeartbeat("starting");
      await refreshExecutionCapabilityProbes(true);
      capabilities = await probeWorkerProviderCapabilities();
      await writeHeartbeat("running");
      console.log(`Worker watching. id=${workerId} limit=${limit} concurrency=${concurrency} perProjectConcurrency=${perProjectConcurrency} project=${projectRootUri ?? "all"} intervalMs=${intervalMs} leaseSeconds=${leaseSeconds} heartbeat=${heartbeatFile}`);
      const activeHeartbeatTimer = setInterval(() => {
        void writeHeartbeat(stop ? "stopping" : "running", latestTick, false).catch((error) => {
          console.error(`Worker heartbeat update failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, Math.min(10_000, Math.max(2_000, Math.floor(leaseSeconds * 1000 / 4))));
      activeHeartbeatTimer.unref();
      try {
        await runWorkerWatch({
          limitPerTick: limit,
          intervalMs,
          workerId,
          leaseSeconds,
          projectRootUri,
          concurrency,
          perProjectConcurrency,
          providerIds: capabilities.ready,
          defaultProviderId: process.env.DEFAULT_MODEL_PROVIDER?.trim() || "mock",
          workerPlatform: process.platform,
          providerRecoveryCooldownMs: 60_000,
          recoverProvider: async (providerId) => (await probeWorkerProviderExecution(providerId)).ready,
          shouldStop: () => stop,
          onTick: async (result) => {
            await refreshExecutionCapabilityProbes(result.failed>0);
            await writeHeartbeat(stop ? "stopping" : "running", result);
            if (result.claimed > 0 || result.failed > 0) {
              console.log(`Worker claimed ${result.claimed}, completed ${result.completed}, failed ${result.failed}.`);
              const approvalNotice = await formatPendingApprovalInboxNotice(projectRootUri);
              if (approvalNotice) {
                console.log(approvalNotice);
              }
            }
          }
        });
      } finally {
        clearInterval(activeHeartbeatTimer);
      }
      await writeHeartbeat("stopped");
      if (registryHeartbeatFile !== heartbeatFile) {
        await fs.unlink(registryHeartbeatFile).catch(() => {});
      }
    });

  program
    .command("recover-leases")
    .description("Requeue running workflow tasks whose worker lease has expired")
    .option("-r, --run <id>", "limit recovery to one workflow run")
    .option("-p, --project <dir>", "limit recovery to one project root")
    .option("--reason <text>", "audit reason", "Expired worker lease recovery requested.")
    .action(async (options: { run?: string; project?: string; reason: string }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }
      const result = await requeueExpiredWorkflowTaskLeases({
        runId: options.run,
        projectRootUri: options.project ? path.resolve(process.cwd(), options.project) : undefined,
        actor: "cli",
        reason: options.reason
      });
      console.log(`Requeued expired leases: ${result.requeuedTasks} task(s) across ${result.affectedRuns} run(s).`);
    });

}
