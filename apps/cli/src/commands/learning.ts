import type { CliContext } from "../lib/context.js";
import { registerLearningLoopCommand } from "../learning/learning-loop-command.js";
import { normalizePolicy, verifyBundle } from "../../../../packages/bundle-trust/src/index.js";
import type { Command } from "commander";
import type { AgentImprovementEvalPlan, AgentImprovementPatchPlan, AgentImprovementPromotionItem, AgentImprovementPromotionQueue, AgentImprovementPromotionReceiptLog, AgentImprovementReport, ApprovalAutopilotResult, ApprovalAutopilotRisk, ApprovalBacklogReport, DashboardFeedbackInboxItem, DashboardFeedbackInboxReport, DashboardLearningDaemonStatus, DashboardPromotionRoutingNotePlan, FeedbackRating, LearningActionReceiptCompactionResult, LearningActionReceiptHealth, LearningActionReceiptLog, LearningActionReceiptStatus, LearningDaemonHeartbeat, LearningDaemonMode, LearningFailureTriageReport, LearningReport, RoadmapSnapshotPublication, RuntimeMcpCleanupResult, RuntimeMonitorReport, RuntimeStaleRunReconciliationResult } from "../lib/cli-types.js";
import { buildApprovalBacklogReport, deliverCodexWorkflowCallback, deliverRunNotifications, parseApprovalAutopilotRisk, runApprovalAutopilot } from "../lib/builders-approvals.js";
import { agentImprovementRiskRank, appendLearningActionRejectionReceipts, buildAgentImprovementEvalPlan, buildAgentImprovementPatchPlan, buildAgentImprovementPromotionQueue, buildPromotionRoutingNotePlan, cleanupRuntimeMcpProcesses, compactLearningActionReceiptFiles, compactLearningActionReceipts, decideAgentImprovementPromotions, defaultFeedbackNote, discoverProjectRoadmap, emptyLearningActionReceipts, formatDuration, formatLearningActionReceipts, formatPromotionRoutingNotePlan, learningActionReceiptOpenKey, learningDaemonMcpCleanupEnabled, learningDaemonMcpCleanupMode, loadAgentImprovementReport, loadDashboardCandidateComparisonReport, loadDashboardEvaluations, loadDashboardFeedbackInboxReport, loadLearningActionReceiptHealth, loadLearningDaemonStatus, loadLearningReport, loadLocalLlmRoutingRecommendationReport, loadPreferenceScorecard, loadTuningProposals, loadWorkflowShapeOptimization, orderedUnique, parseLearningDaemonMode, parseLearningRiskLevel, parseModelTierOption, parseProposalIds, parseRuntimeMcpStaleMinutes, publishRoadmapSnapshotIfChanged, readAgentImprovementPromotionQueue, readLearningActionReceipts, readLearningApprovalQueue, readLearningSettings, readModelImprovementPlan, readTuningApprovalHistory, readTuningApprovalQueue, recordRunFeedback, recordTuningHistory, runDaemonOfflineSyncScheduler, runtimeMcpCleanupConfig, sha256, staleRunReconcileConfig, summarizeAgentImprovementPromotionQueue, writeAgentImprovementPromotionQueue, writeCandidateComparisonPlan, writeLearningActionReceipts, writeLocalLlmRoutingRecommendationReport, writeModelImprovementPlan } from "../lib/builders-learning.js";
import { countStrings, ensureProjectSubdir, formatInlineCounts, indexProjectForRun, isOpenApproval, loadAgentsForProject, loadCostQualityReport, normalizeWorkerId, pathExists, queueWorkflow, resolveLocalProjectRootUri, shellQuote, sleep, stringValue, truncateText } from "../lib/builders-shared.js";
import { loadAgents, loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { type AgentCard, agentCardSchema } from "../../../../packages/agent-registry/src/schemas.js";
import { buildClientCapabilityContract } from "../../../../packages/client-capabilities/src/index.js";
import { daemonLanes } from "../../../../packages/daemon-control/src/index.js";
import { lowerTrustLevel } from "../../../../packages/daemon-control/src/settings.js";
import { classifyFailureForTriage, failureTriageRiskAllowed } from "../../../../packages/failure-triage/src/index.js";
import { type LearningApplicationPlan, type LearningApprovalQueue, type LearningProposalSet, type LearningRiskLevel, buildLearningApplicationPlan as buildGovernedLearningApplicationPlan, buildLearningApprovalQueue, decideLearningApprovals } from "../../../../packages/learning-governance/src/index.js";
import { type LearningLoopSchedulerReceipt } from "../../../../packages/learning-loop/src/index.js";
import { buildLearningProposalSet, formatLearningProposalSet, writeLearningProposalFiles } from "../../../../packages/learning-proposals/src/index.js";
import { executeAllowedCommand } from "../../../../packages/local-tools/src/command-executor.js";
import { providerFromEnv } from "../../../../packages/model-providers/src/index.js";
import { type RepositoryMaintenanceReport, commitRepositoryMaintenance, scanRepositoryMaintenance, writeRepositoryMaintenanceReceipt } from "../../../../packages/repository-maintenance/src/index.js";
import { type RoadmapSuggestionReport, buildRoadmapSuggestionReport, formatRoadmapSuggestionReport, resolveContainedProjectPath } from "../../../../packages/roadmap-planner/src/index.js";
import { type CandidateVariantPlan, type TuningApplicationPlan, type TuningApprovalQueue, type TuningHistoryStatus, type TuningPatchPlan, type TuningPatchPlanDocument, type TuningProposalSet, type WorkflowShapeOptimizationReport, buildCandidateComparisonPlan, buildModelImprovementPlan, buildTuningApplicationPlan, buildTuningApprovalQueue, buildTuningPatchApplicationPlan, buildTuningPatchPlan, decideTuningApprovals, formatCandidateComparisonPlan, formatCostQualityReport, formatModelImprovementPlan, formatPreferenceScorecard, formatTuningApplicationPlan, formatTuningApprovalHistory, formatTuningApprovalQueue, formatTuningApprovalQueueMarkdown, formatTuningPatchPlan, formatTuningProposals, formatWorkflowShapeOptimizationMarkdown, formatWorkflowShapeOptimizationReport } from "../../../../packages/run-reporter/src/index.js";
import { checkServices } from "../../../../packages/storage/src/doctor.js";
import { type WorkflowRunStatus, cancelWorkflowRun, decideActionApproval, getWorkflowRunDetails, listActionApprovals, listArtifacts, listProjectStorageSummaries, listWorkflowRunsForProject, markActionApprovalExecution, reconcileStaleTerminalWorkflowRuns, recordRunAction, recoverInterruptedActionApprovalExecutions, replayWorkflowRun, requeueExpiredWorkflowTaskLeases, retryFailedWorkflowRun, supersedeWorkflowRun, upsertMemoryItem } from "../../../../packages/storage/src/postgres.js";
import { type TrainingDiscoveryReport, type TrainingProposalDecisionStatus, decideTrainingProposal, formatTrainingDiscoveryReport, readLatestTrainingDiscoveryReport, readTrainingProposalInbox, runTrainingDiscovery } from "../../../../packages/training-discovery/src/index.js";
import { fairProjectOrder, runOptimizerCycle } from "../../../../packages/workflow-optimizer/src/index.js";
import { findLaterCompletedEquivalentRun } from "../blocked-run-supersession.js";
import { CODEX_CALLBACK_RECEIPT, approvalCallbackPrompt, codexThreadId, failureCallbackPrompt, inheritedCodexOrigin } from "../codex-callback.js";
import { runDaemonLearningLoopSchedule } from "../learning/learning-loop-daemon.js";
import { type ModelComparisonSchedule, type ModelRoutingOptimizerReport, isFleetModelComparisonOwner, prepareRecurringModelComparison, runModelRoutingOptimizer } from "../learning/model-routing-optimizer.js";
import { parseBoundedPositiveInteger, parsePositiveInteger } from "../numeric-options.js";
import { normalizeProviderRef } from "../reference-resolution.js";
import { type TrainingHoldoutDesign, runTrainingHoldout } from "../training-holdout-runner.js";
import { type SupervisedDeliveryReceipt, findSupersedingDeliveryReceipt, isInternalDiscoveryBlocker, isWithinAutomaticWorkflowRepairWindow, supervisedRepairWorkflowId, workflowDeliveryRepairReason, workflowRepairLesson, workflowRootRepairAction } from "../workflow-supervision.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

type AgentImprovementApplyReceipt = {
  id: string;
  promotionId: string;
  patchId: string;
  evalId: string;
  agentId: string;
  status: "applied" | "skipped";
  score: number;
  riskLevel: LearningRiskLevel;
  scope: "shared" | "project-local";
  actor: string;
  note: string;
  sourcePath: string;
  sourceHashBefore: string;
  sourceHashAfter: string | null;
  rollbackPath: string;
  reason: string;
  createdAt: string;
};

type AgentImprovementApplyReceiptLog = {
  kind: "agentflow_agent_improvement_apply_receipts";
  projectRootUri: string;
  updatedAt: string;
  events: AgentImprovementApplyReceipt[];
};

type AgentImprovementApplyResult = {
  queue: AgentImprovementPromotionQueue;
  receipts: AgentImprovementApplyReceiptLog;
  selectedIds: string[];
  appliedIds: string[];
  skippedIds: string[];
  unknownIds: string[];
  dryRun: boolean;
};

type LearningAutonomousApplicationResult = {
  kind: "agentflow_learning_autonomous_application";
  projectRootUri: string;
  generatedAt: string;
  appliedActions: number;
  skippedActions: number;
  filesWritten: string[];
  notes: string[];
};

type LearningDaemonProjectTarget = {
  projectDir: string;
  enabled: boolean;
  paused: boolean;
  mode: LearningDaemonMode;
  limit: number;
};

export function registerLearningCommands(program: Command, ctx: CliContext): void {
  function appendLearningApplicationPlanReceipts(log: LearningActionReceiptLog, plan: LearningApplicationPlan, actor: string, note: string, status: Extract<LearningActionReceiptStatus, "planned" | "applied"> = "planned"): LearningActionReceiptLog {
    const createdAt = new Date().toISOString();
    const compacted = compactLearningActionReceipts(log, createdAt);
    const alreadyClosed = new Set(compacted.events.filter((event) => event.status === "superseded" || event.status === "rejected").map((event) => `${event.actionId}|${event.proposalId}|${event.status}`));
    const currentPlanKeys = new Set(plan.actions.map((action) => `${action.id}|${action.proposalId}`));
    const activeKeys = new Set(compacted.events.filter((event) => event.status === status).map((event) => learningActionReceiptOpenKey(event)));
    const nextEvents = [...compacted.events];
    for (const event of compacted.events) {
      const key = `${event.actionId}|${event.proposalId}`;
      const supersedeKey = `${event.actionId}|${event.proposalId}|superseded`;
      if (event.status === "planned" && !currentPlanKeys.has(key) && !alreadyClosed.has(supersedeKey)) {
        nextEvents.push({
          ...event,
          id: `receipt-${String(nextEvents.length + 1).padStart(4, "0")}`,
          status: "superseded",
          createdAt,
          actor,
          note: `Superseded by application plan ${plan.generatedAt}.`
        });
      }
    }
    for (const action of plan.actions) {
      const key = learningActionReceiptOpenKey({
        status,
        actionId: action.id,
        proposalId: action.proposalId,
        actor,
        note,
        title: action.title,
        actionType: action.actionType,
        dangerGate: action.dangerGate,
        writesOwnedLearningStateOnly: action.writesOwnedLearningStateOnly
      });
      if (activeKeys.has(key)) {
        continue;
      }
      activeKeys.add(key);
      nextEvents.push({
        id: `receipt-${String(nextEvents.length + 1).padStart(4, "0")}`,
        status,
        actionId: action.id,
        proposalId: action.proposalId,
        planGeneratedAt: plan.generatedAt,
        createdAt,
        actor,
        note,
        title: action.title,
        actionType: action.actionType,
        dangerGate: action.dangerGate,
        writesOwnedLearningStateOnly: action.writesOwnedLearningStateOnly
      });
    }
    return {
      ...log,
      projectRootUri: plan.projectRootUri,
      updatedAt: createdAt,
      events: nextEvents
    };
  }

  async function applyAgentImprovementPromotions(input: {
    projectDir: string;
    queue: AgentImprovementPromotionQueue;
    ids: string[] | "all";
    maxRisk: LearningRiskLevel;
    actor: string;
    note: string;
    write: boolean;
    mode?: "approved" | "project-local-auto";
  }): Promise<AgentImprovementApplyResult> {
    const now = new Date().toISOString();
    const matching = input.queue.items.filter((item) =>
      (input.ids === "all" || input.ids.includes(item.id) || input.ids.includes(item.patchId) || input.ids.includes(item.evalId) || input.ids.includes(item.candidateId) || input.ids.includes(item.agentId)) &&
      (input.mode !== "project-local-auto" || (item.scope === "project-local" && item.autoApplyReady && !item.approvalRequired))
    );
    const selectedIds = matching.map((item) => item.id);
    const unknownIds = input.ids === "all" ? [] : input.ids.filter((id) =>
      !matching.some((item) => item.id === id || item.patchId === id || item.evalId === id || item.candidateId === id || item.agentId === id)
    );
    const existingReceipts = await readAgentImprovementApplyReceipts(input.projectDir).catch(() => emptyAgentImprovementApplyReceipts(input.projectDir));
    const existingReceiptKeys = new Set(existingReceipts.events.map((event) =>
      `${event.promotionId}\0${event.status}\0${event.sourceHashBefore}\0${event.sourceHashAfter ?? ""}\0${event.reason}`
    ));
    const appliedIds = new Set<string>();
    const skippedIds = new Set<string>();
    const events: AgentImprovementApplyReceipt[] = [];
    const recordEvent = (event: AgentImprovementApplyReceipt): void => {
      const key = `${event.promotionId}\0${event.status}\0${event.sourceHashBefore}\0${event.sourceHashAfter ?? ""}\0${event.reason}`;
      if (!existingReceiptKeys.has(key)) {
        events.push(event);
        existingReceiptKeys.add(key);
      }
    };

    for (const item of matching) {
      const baseReceipt = {
        id: `receipt-apply-${item.id}-${now.replace(/[^0-9]/g, "")}`,
        promotionId: item.id,
        patchId: item.patchId,
        evalId: item.evalId,
        agentId: item.agentId,
        score: item.score,
        riskLevel: item.riskLevel,
        scope: item.scope,
        actor: input.actor,
        note: input.note,
        sourcePath: item.sourcePath,
        sourceHashBefore: item.sourceHash,
        sourceHashAfter: null,
        rollbackPath: item.rollback.restorePath,
        createdAt: now
      } satisfies Omit<AgentImprovementApplyReceipt, "status" | "reason">;
      if (item.status === "applied") {
        skippedIds.add(item.id);
        recordEvent({ ...baseReceipt, status: "skipped", reason: "Promotion was already applied." });
        continue;
      }
      const autoApprovedByDaemon = input.mode === "project-local-auto" && item.status === "pending" && item.scope === "project-local" && item.autoApplyReady && !item.approvalRequired;
      if (item.status !== "approved" && !autoApprovedByDaemon) {
        skippedIds.add(item.id);
        continue;
      }
      if (agentImprovementRiskRank(item.riskLevel) > agentImprovementRiskRank(input.maxRisk)) {
        skippedIds.add(item.id);
        recordEvent({ ...baseReceipt, status: "skipped", reason: `Risk ${item.riskLevel} exceeds max risk ${input.maxRisk}.` });
        continue;
      }
      if (!item.promotionReady) {
        skippedIds.add(item.id);
        recordEvent({ ...baseReceipt, status: "skipped", reason: "Promotion is not ready." });
        continue;
      }
      if (!item.rollback.sourceHashCurrent) {
        skippedIds.add(item.id);
        recordEvent({ ...baseReceipt, status: "skipped", reason: "Rollback/source hash evidence was stale when promoted." });
        continue;
      }
      const sourcePath = resolveAgentPromotionSourcePath(input.projectDir, item);
      const currentYaml = await fs.readFile(sourcePath, "utf8").catch(() => "");
      if (!currentYaml) {
        skippedIds.add(item.id);
        recordEvent({ ...baseReceipt, status: "skipped", reason: `Source file was not readable: ${item.sourcePath}` });
        continue;
      }
      const currentHash = sha256(currentYaml);
      if (currentHash !== item.sourceHash) {
        skippedIds.add(item.id);
        recordEvent({ ...baseReceipt, sourceHashBefore: currentHash, status: "skipped", reason: "Source hash changed since promotion; regenerate before applying." });
        continue;
      }
      const proposedYaml = extractProposedYamlFromFullFileDiff(item.diff);
      if (!proposedYaml.trim()) {
        skippedIds.add(item.id);
        recordEvent({ ...baseReceipt, status: "skipped", reason: "Promotion did not include a proposed YAML payload." });
        continue;
      }
      const validation = agentCardSchema.safeParse(YAML.parse(proposedYaml));
      if (!validation.success) {
        skippedIds.add(item.id);
        recordEvent({ ...baseReceipt, status: "skipped", reason: `Proposed YAML failed schema validation: ${validation.error.issues.map((issue) => issue.message).join("; ")}` });
        continue;
      }
      const nextHash = sha256(proposedYaml);
      recordEvent({ ...baseReceipt, status: "applied", sourceHashAfter: nextHash, reason: input.write ? "Applied approved agent YAML promotion." : "Dry-run would apply approved agent YAML promotion." });
      if (input.write) {
        await fs.writeFile(sourcePath, proposedYaml, "utf8");
        appliedIds.add(item.id);
      }
    }

    const queueDraft = {
      ...input.queue,
      updatedAt: now,
      items: input.queue.items.map((item) => appliedIds.has(item.id)
        ? { ...item, status: "applied" as const, decidedAt: now, reviewer: input.actor, note: input.note }
        : item)
    };
    const queue = {
      ...queueDraft,
      summary: summarizeAgentImprovementPromotionQueue(queueDraft)
    };
    const receipts = {
      ...existingReceipts,
      updatedAt: now,
      events: [...existingReceipts.events, ...events]
    };
    if (input.write) {
      await writeAgentImprovementPromotionQueue(input.projectDir, queue);
      await writeAgentImprovementApplyReceipts(input.projectDir, receipts);
    }
    return {
      queue,
      receipts,
      selectedIds,
      appliedIds: [...appliedIds],
      skippedIds: [...skippedIds],
      unknownIds,
      dryRun: !input.write
    };
  }

  async function applyAutonomousLearningApplicationPlan(projectDir: string, plan: LearningApplicationPlan): Promise<LearningAutonomousApplicationResult> {
    const safeTuningActions = plan.actions.filter((action) => action.dangerGate === "none" && action.actionType === "apply_tuning_overlay");
    const safeRouteFeedbackActions = plan.actions.filter((action) => action.dangerGate === "none" && action.actionType === "refresh_routing_recommendations");
    const filesWritten: string[] = [];
    const notes: string[] = [];
    let appliedActions = 0;
    if (safeTuningActions.length) {
      const tuningProposals = await loadTuningProposals({ projectDir, limit: 50 });
      const tuningPlan = buildTuningApplicationPlan(tuningProposals, "all");
      if (tuningPlan.selectedIds.length) {
        await writeTuningApplicationPlan(projectDir, tuningPlan);
        await recordTuningHistory(projectDir, tuningPlan.selectedIds, "applied", "learning-daemon", "autonomous local tuning overlay");
        filesWritten.push(...tuningPlan.files.map((file) => file.relativePath));
        appliedActions += safeTuningActions.length;
        notes.push(`Applied project-local tuning overlay for ${tuningPlan.selectedIds.length} tuning proposal(s).`);
      } else {
        notes.push("Safe tuning-overlay action was available, but no concrete tuning proposal rows were ready to apply.");
      }
    }
    if (safeRouteFeedbackActions.length) {
      const report = await loadLocalLlmRoutingRecommendationReport(ctx, { projectDir, limit: 50 });
      await writeLocalLlmRoutingRecommendationReport(projectDir, report);
      filesWritten.push(...report.files.map((file) => file.relativePath));
      appliedActions += safeRouteFeedbackActions.length;
      notes.push(`Refreshed savings-aware routing recommendations from route feedback for ${safeRouteFeedbackActions.length} learning proposal action(s).`);
    }
    if (!safeTuningActions.length && !safeRouteFeedbackActions.length) {
      notes.push("No safe owned local optimization actions were available to apply.");
    }
    const skippedActions = plan.actions.length - appliedActions;
    if (skippedActions > 0) {
      notes.push(`${skippedActions} action(s) were left for approval because they are high-risk or outside autonomous local scope.`);
    }
    const result: LearningAutonomousApplicationResult = {
      kind: "agentflow_learning_autonomous_application",
      projectRootUri: projectDir,
      generatedAt: new Date().toISOString(),
      appliedActions,
      skippedActions,
      filesWritten,
      notes
    };
    await writeLearningAutonomousApplicationResult(projectDir, result);
    return result;
  }

  async function autoRepairOneWorkflowRun(projectDir: string, mode: LearningDaemonMode): Promise<number> {
    if (mode !== "apply-approved") return 0;
    const runs = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: 500 });
    const repairSources = new Set(["blocked-run-repair", "workflow-supervisor-repair", "workflow-root-repair"]);
    const deliveryReceipts = await loadProjectDeliveryReceipts(projectDir);
    const activeRepair = runs.find((run) => (run.status === "queued" || run.status === "leased" || run.status === "running") && repairSources.has(stringValue(run.evaluationMetadata?.source) ?? ""));
    if (activeRepair) {
      const sourceRunId = stringValue(activeRepair.evaluationMetadata?.sourceRunId);
      const sourceRun = runs.find((candidate) => candidate.id === sourceRunId);
      const sourceDetails = sourceRun ? await getWorkflowRunDetails(sourceRun.id) : null;
      const repairSuppressed = sourceDetails?.receipts.some((receipt) => receipt.actionType === "workflow_supervisor_repair_suppressed") ?? false;
      if (sourceRun && repairSuppressed) {
        await cancelWorkflowRun(activeRepair.id);
        return 1;
      }
      const receipt = sourceRun ? findSupersedingDeliveryReceipt(sourceRun.task, deliveryReceipts) : null;
      if (!sourceRun || !receipt) return 0;
      await dismissRunSupersededByReceipt({ run: sourceRun, receipt, repairRun: activeRepair });
      return 1;
    }
    for (const run of runs.filter((item) => !item.dismissed && (item.status === "blocked" || item.status === "failed" || item.status === "completed"))) {
      const sourceRunId = stringValue(run.evaluationMetadata?.sourceRunId);
      const repairSource = repairSources.has(stringValue(run.evaluationMetadata?.source) ?? "")
        ? runs.find((candidate) => candidate.id === sourceRunId)
        : undefined;
      const priorProviderRecoveryKind = stringValue(repairSource?.evaluationMetadata?.rootRepairKind);
      const supersededBy = run.status === "completed" ? undefined : findLaterCompletedEquivalentRun(runs, repairSource ?? run);
      if (supersededBy) {
        const reason = `Superseded by completed equivalent run ${supersededBy.id}; immutable history preserved.`;
        await supersedeWorkflowRun({ runId: run.id, actor: "learning-daemon", reason, supersededBy: supersededBy.id });
        if (repairSource?.status === "blocked") {
          await supersedeWorkflowRun({ runId: repairSource.id, actor: "learning-daemon", reason, supersededBy: supersededBy.id });
        }
        return 1;
      }
      const providerRecoveryNeedsRealProbe = Boolean(repairSource)
        && stringValue(run.evaluationMetadata?.source) === "workflow-root-repair"
        && priorProviderRecoveryKind === "provider-recovered";
      if (repairSource && run.status === "blocked" && ["blocked-run-repair", "workflow-supervisor-repair"].includes(stringValue(run.evaluationMetadata?.source) ?? "")) {
        const repairDetails = await getWorkflowRunDetails(run.id);
        const repairArtifacts = await listArtifacts({ runId: run.id, kind: "stage_output" });
        const discoveryReason = [
          run.blockedReason,
          ...repairArtifacts.map((artifact) => `${stringValue(artifact.content?.blockedReason) ?? ""} ${stringValue(artifact.content?.summary) ?? ""}`)
        ].filter(Boolean).join(" ");
        const alreadyRetried = repairDetails.receipts.some((receipt) => receipt.actionType === "workflow_internal_discovery_replayed");
        const repairApprovals = await listActionApprovals({ runId: run.id, limit: 100 });
        if (!alreadyRetried && !repairApprovals.some(isOpenApproval) && isInternalDiscoveryBlocker(discoveryReason)) {
          try {
            await indexProjectForRun(ctx, { projectDir, maxFiles: 180, refine: false, forceRefine: false });
          } catch {
            continue;
          }
          const replay = await replayWorkflowRun({
            sourceRunId: run.id,
            actor: "learning-daemon",
            reason: "Studio refreshed bounded project discovery and resumed the saved repair checkpoint automatically.",
            preserveCompletedCheckpoints: true,
            evaluationMetadataPatch: { source: "workflow-root-repair", sourceRunId: run.id, rootRepairKind: "planning-discovery" }
          });
          if (!replay) return 0;
          await recordRunAction({
            runId: run.id,
            agentId: "workflow-orchestrator",
            actionType: "workflow_internal_discovery_replayed",
            target: replay.runId,
            summary: "Studio refreshed bounded project discovery and resumed this internal planning blocker without operator input.",
            artifactKind: "workflow_root_repair",
            artifactContent: { sourceRunId: run.id, repairRunId: replay.runId, rootRepairKind: "planning-discovery" },
            idempotencyKey: `workflow-internal-discovery-${run.id}`
          });
          await supersedeWorkflowRun({ runId: run.id, actor: "learning-daemon", reason: `Superseded by automatic discovery replay ${replay.runId}; immutable history preserved.`, supersededBy: replay.runId });
          return 1;
        }
      }
      if (repairSource && !providerRecoveryNeedsRealProbe) continue;
      const repairReferenceTime = run.finishedAt ?? run.startedAt;
      if (!isWithinAutomaticWorkflowRepairWindow(repairReferenceTime)) continue;
      const deliveryReceipt = run.status === "completed" ? null : findSupersedingDeliveryReceipt(run.task, deliveryReceipts);
      if (deliveryReceipt) {
        await dismissRunSupersededByReceipt({ run, receipt: deliveryReceipt });
        return 1;
      }
      const details = await getWorkflowRunDetails(run.id);
      if (details.receipts.some((receipt) => receipt.actionType === "blocked_run_repair_queued"
        || receipt.actionType === "workflow_supervisor_repair_queued"
        || receipt.actionType === "workflow_supervisor_repair_suppressed")) continue;
      const approvals = await listActionApprovals({ runId: run.id, limit: 100 });
      const hasOpenApproval = approvals.some(isOpenApproval);
      if (hasOpenApproval) continue;
      const artifacts = await listArtifacts({ runId: run.id, kind: "stage_output" });
      const outputs = artifacts.map((artifact) => artifact.content);
      const output = outputs.at(-1) ?? {};
      const recordedFailure = [...details.receipts].reverse().find((receipt) => receipt.actionType === "stage_failed")?.summary?.trim() ?? "";
      const reason = `${stringValue(output.blockedReason) ?? ""} ${stringValue(output.summary) ?? ""} ${recordedFailure}`.toLowerCase();
      const missingExistingEvidence = /\b(?:missing|not supplied|not provided|unavailable|omits?)\b/u.test(reason)
        && /\b(?:context|source|files?|diff|tests?|evidence|repository|implementation|configuration)\b/u.test(reason);
      const deliveryReason = workflowDeliveryRepairReason(run, outputs);
      const externallyManagedFailure = /\b(?:auth(?:entication|orization)?|credential|quota|policy|permission|approval|provider|fallback|model route)\b/u.test(reason);
      const repairableFailure = run.status === "failed" && Boolean(recordedFailure) && !externallyManagedFailure;
      const rootRepairAction = workflowRootRepairAction({
        run,
        reason,
        deliveryReason,
        hasOpenApproval,
        recordedFailure
      });
      if (rootRepairAction === "operator-provider") {
        // A recovered-provider replay gets at most one health-probed provider
        // continuation. A different later root cause still enters its matching
        // repair path instead of being hidden by provider lineage.
        if (priorProviderRecoveryKind === "provider-inference-recovered") continue;
        // Never retry a provider incident blindly. Once readiness and one bounded
        // inference both pass, previously external authentication, quota,
        // configuration, and outage failures are proven recovered and may be
        // replayed exactly once from durable checkpoints.
        const recoverableProviderFailure = /\b(?:provider[_ -]?outage|auth(?:entication|orization)?|credential|quota|configuration|rate limit)\b/u.test(reason);
        if (!recoverableProviderFailure) continue;
        const provider = providerFromEnv(run.providerOverride ?? undefined);
        const project = await loadProjectConfig(projectDir);
        const health = provider.check ? await provider.check().catch(() => ({ ready: false, details: [] })) : { ready: false, details: [] };
        if (!health.ready) continue;
        const inferenceReady = await provider.executeStage({
          runId: randomUUID(),
          taskId: randomUUID(),
          projectRootUri: projectDir,
          projectConfig: project,
          workflowId: "provider-recovery-probe",
          workflowTask: "Verify that the configured provider can complete one bounded inference request.",
          stageId: "probe",
          agentId: "workflow-orchestrator",
          agentName: "Workflow Orchestrator",
          agentPrompt: "This is a provider health probe. Do not use tools or inspect project files. Return a short completed summary.",
          stageGoal: "Return a successful bounded response without tools.",
          compiledBrief: "Synthetic provider health probe. No project content is included.",
          modelTier: "fast",
          providerOverride: run.providerOverride,
          priorReceipts: []
        }).then(() => true, () => false);
        if (!inferenceReady) continue;
        const replay = await replayWorkflowRun({
          sourceRunId: run.id,
          actor: "learning-daemon",
          reason: `Provider ${provider.id} passed readiness and bounded inference after the recorded provider failure; replaying the original workflow once.`,
          preserveCompletedCheckpoints: true,
          evaluationMetadataPatch: {
            source: "workflow-root-repair",
            sourceRunId: run.id,
            rootRepairKind: providerRecoveryNeedsRealProbe ? "provider-inference-recovered" : "provider-recovered"
          }
        });
        if (!replay) return 0;
        await recordRunAction({
          runId: run.id,
          agentId: "workflow-orchestrator",
          actionType: "workflow_provider_recovery_replayed",
          target: replay.runId,
          summary: `Learning daemon verified provider ${provider.id} with readiness and bounded inference, then replayed the recovered provider failure once.`,
          artifactKind: "workflow_root_repair",
          artifactContent: { sourceRunId: run.id, repairRunId: replay.runId, providerId: provider.id },
          idempotencyKey: `workflow-provider-recovery-${run.id}-${replay.runId}`
        });
        await supersedeWorkflowRun({ runId: run.id, actor: "learning-daemon",
          reason: `Superseded by provider-recovery replay ${replay.runId}; immutable history preserved.`, supersededBy: replay.runId });
        return 1;
      }
      if (rootRepairAction === "wait-approval" || rootRepairAction === "none") continue;
      if (rootRepairAction === "replay-original") {
        try {
          await indexProjectForRun(ctx, { projectDir, maxFiles: 180, refine: false, forceRefine: false });
        } catch {
          continue;
        }
        const replay = await replayWorkflowRun({
          sourceRunId: run.id,
          actor: "learning-daemon",
          reason: "Root repair refreshed project evidence and replayed the original review contract.",
          preserveCompletedCheckpoints: true,
          evaluationMetadataPatch: {
            source: "workflow-root-repair",
            sourceRunId: run.id,
            rootRepairKind: "review-evidence-gap"
          }
        });
        if (!replay) return 0;
        await recordRunAction({
          runId: run.id,
          agentId: "workflow-orchestrator",
          actionType: "workflow_root_repair_replayed",
          target: replay.runId,
          summary: "Learning daemon refreshed indexed evidence and replayed the original review workflow instead of launching a diagnostic loop.",
          artifactKind: "workflow_root_repair",
          artifactContent: { sourceRunId: run.id, repairRunId: replay.runId, action: rootRepairAction },
          idempotencyKey: `workflow-root-repair-${run.id}-${replay.runId}`
        });
        await supersedeWorkflowRun({ runId: run.id, actor: "learning-daemon",
          reason: `Superseded by root-repair replay ${replay.runId}; immutable history preserved.`, supersededBy: replay.runId });
        return 1;
      }
      if (details.receipts.some((receipt) => receipt.actionType === "blocked_run_repair_queued" || receipt.actionType === "workflow_supervisor_repair_queued")) continue;
      if (!missingExistingEvidence && !deliveryReason && !repairableFailure) continue;
      const repaired = await queueSupervisedWorkflowRepair({
        run,
        projectDir,
        reason: deliveryReason ?? (repairableFailure
          ? `The failed stage recorded this cause: ${recordedFailure}`
          : "The blocked run is missing project evidence that now exists or can be refreshed."),
        actor: "learning-daemon"
      });
      return repaired ? 1 : 0;
    }
    return 0;
  }

  async function dismissDuplicateBlockedWorkflowRuns(projectDir: string, actor: string): Promise<number> {
    const runs = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: 500 });
    const terminal = runs
      .filter((run) => !run.dismissed && (run.status === "blocked" || run.status === "failed"))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const newestByContract = new Map<string, WorkflowRunStatus>();
    let dismissed = 0;
    for (const run of terminal) {
      const contract = `${run.workflowId}\u0000${run.task.trim()}`;
      const newest = newestByContract.get(contract);
      if (!newest) {
        newestByContract.set(contract, run);
        continue;
      }
      const reason = `Superseded by newer equivalent run ${newest.id}; duplicate self-healing work was not executed.`;
      const approvals = await listActionApprovals({ runId: run.id, status: "all", limit: 500 });
      for (const approval of approvals) {
        if (approval.status === "pending") {
          await decideActionApproval({
            approvalId: approval.id,
            decision: "rejected",
            actor,
            actorRole: "approver",
            note: reason
          });
        } else if (approval.status === "approved" && !approval.executedAt) {
          await markActionApprovalExecution({
            approvalId: approval.id,
            status: "dismissed",
            actor,
            actorRole: "operator",
            summary: reason
          });
        }
      }
      if (await supersedeWorkflowRun({ runId: run.id, actor, reason, supersededBy: newest.id })) dismissed += 1;
    }
    return dismissed;
  }

  async function dismissRunSupersededByReceipt(input: {
    run: WorkflowRunStatus;
    receipt: SupervisedDeliveryReceipt;
    repairRun?: WorkflowRunStatus;
  }): Promise<void> {
    const reason = `Superseded by verified project delivery evidence ${input.receipt.path}; immutable history preserved.`;
    if (input.repairRun && ["queued", "leased", "running"].includes(input.repairRun.status)) {
      await cancelWorkflowRun(input.repairRun.id);
    }
    if (input.run.status === "blocked" || input.run.status === "failed") {
      await supersedeWorkflowRun({
        runId: input.run.id, actor: "learning-daemon", reason,
        supersededBy: input.repairRun?.id ?? input.receipt.path
      });
    }
  }

  function emptyAgentImprovementApplyReceipts(projectDir: string): AgentImprovementApplyReceiptLog {
    return {
      kind: "agentflow_agent_improvement_apply_receipts",
      projectRootUri: projectDir,
      updatedAt: new Date().toISOString(),
      events: []
    };
  }

  function emptyApprovalAutopilotResult(maxRisk: ApprovalAutopilotRisk): ApprovalAutopilotResult {
    return {
      kind: "agentflow_approval_autopilot_result",
      generatedAt: new Date().toISOString(),
      mode: "execute",
      maxRisk,
      scanned: 0,
      approved: 0,
      executed: 0,
      skipped: 0,
      items: []
    };
  }

  function emptyLearningAutonomousApplicationResult(projectRootUri: string): LearningAutonomousApplicationResult {
    return {
      kind: "agentflow_learning_autonomous_application",
      projectRootUri,
      generatedAt: new Date().toISOString(),
      appliedActions: 0,
      skippedActions: 0,
      filesWritten: [],
      notes: ["No autonomous local application was performed."]
    };
  }

  function envFlagEnabled(value: string | undefined): boolean {
    if (!value) return false;
    return ["1", "true", "on", "yes"].includes(value.trim().toLowerCase());
  }

  program.hook("preAction", async (_command, actionCommand) => {
    if (["validate", "schemas", "contract-test", "bundle-manifest", "bundle-compat", "bundle-registry", "bundle-pin", "bundle-lifecycle-plan", "bundle-upgrade-preview", "definition-migrations", "bundle-verify", "bundle-sign", "bundle-trust", "object-artifact-proof", "offline-fallback", "offline-sync", "project-alias-merge-plan", "roadmap-audit", "runtime-monitor", "server-readiness", "server-mutation-controls", "server-projects", "server-resolve-project", "server-request-log", "server-request-preview", "server-route-preview", "server-approval-preview", "server-approval-action", "server-approval-action-plan", "server-approval-action-test-adapter", "storage-migrate", "storage-merge-evidence", "storage-merge-manifest", "storage-merge-import", "storage-project-conflicts", "storage-project-decision", "storage-verify"].includes(actionCommand.name())) return;
    const policy = normalizePolicy(process.env.AGENTFLOW_BUNDLE_TRUST_POLICY);
    const verification = await verifyBundle(ctx.rootDir, policy);
    if (!verification.allowed) throw new Error(`Bundle trust policy ${policy} rejected ${verification.status}: ${verification.reasons.join(" ")}`);
    if (policy === "warn" && verification.status !== "trusted") console.error(`WARNING: bundle ${verification.status}: ${verification.reasons.join(" ")}`);
  });

  function extractProposedYamlFromFullFileDiff(diff: string): string {
    const lines = diff.split("\n");
    const added = lines
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
    return added.join("\n").trimEnd() + "\n";
  }

  function filterAppliedLearningApplicationPlan(plan: LearningApplicationPlan): LearningApplicationPlan {
    const actions = plan.actions.filter((action) => action.dangerGate === "none" && ["apply_tuning_overlay", "refresh_routing_recommendations"].includes(action.actionType));
    return {
      ...plan,
      actions,
      selectedIds: actions.map((action) => action.proposalId),
      skippedIds: [],
      summary: actions.length
        ? [`${actions.length} autonomous owned local optimization action(s) applied.`]
        : ["No autonomous local actions applied."]
    };
  }

  function formatAgentImprovementApplyReceiptsMarkdown(receipts: AgentImprovementApplyReceiptLog): string {
    return [
      "# Agent Improvement Apply Receipts",
      "",
      `Updated: ${receipts.updatedAt}`,
      `Project: ${receipts.projectRootUri}`,
      "",
      ...(receipts.events.length
        ? receipts.events.map((event) => [
          `## ${event.status}: ${event.agentId}`,
          "",
          `- Receipt: ${event.id}`,
          `- Promotion: ${event.promotionId}`,
          `- Patch: ${event.patchId}`,
          `- Eval: ${event.evalId}`,
          `- Score: ${event.score}/100`,
          `- Scope: ${event.scope}`,
          `- Risk: ${event.riskLevel}`,
          `- Actor: ${event.actor}`,
          `- Note: ${event.note}`,
          `- Source: ${event.sourcePath}`,
          `- Source hash before: ${event.sourceHashBefore}`,
          `- Source hash after: ${event.sourceHashAfter ?? "n/a"}`,
          `- Rollback path: ${event.rollbackPath}`,
          `- Reason: ${event.reason}`
        ].join("\n")).join("\n\n")
        : ["No promotion applications recorded yet."]),
      ""
    ].join("\n");
  }

  function formatAgentImprovementApplyResult(result: AgentImprovementApplyResult, maxRisk: LearningRiskLevel): string {
    const recent = result.receipts.events.slice(-20).map((event) =>
      `- ${event.status}: ${event.agentId} (${event.scope}, ${event.riskLevel}) ${event.reason}`
    );
    return [
      `Agent improvement apply ${result.dryRun ? "dry run" : "result"} (${result.receipts.updatedAt})`,
      `Project: ${result.queue.projectRootUri}`,
      `Max risk: ${maxRisk}`,
      `Selected: ${result.selectedIds.length}`,
      `Applied: ${result.appliedIds.length}`,
      `Skipped: ${result.skippedIds.length}`,
      `Unknown ids: ${result.unknownIds.join(", ") || "none"}`,
      "",
      "Recent receipts:",
      ...(recent.length ? recent : ["- none"])
    ].join("\n");
  }

  function formatAgentImprovementEvalPlan(plan: AgentImprovementEvalPlan): string {
    return [
      `Agent improvement eval plan (${plan.generatedAt})`,
      `Project: ${plan.projectRootUri}`,
      `Selected: ${plan.selectedIds.length}`,
      `Skipped: ${plan.skippedIds.join(", ") || "none"}`,
      `Policy: pass>=${plan.promotionPolicy.passThreshold}, auto>=${plan.promotionPolicy.autoApplyThreshold}, minimum holdout=${plan.promotionPolicy.minimumHoldoutTasks}`,
      "",
      ...plan.summary.map((item) => `- ${item}`),
      "",
      "Evaluations:",
      ...(plan.evaluations.length ? plan.evaluations.map((item) => `- ${item.status} ${item.score}/100: ${item.agentId} (${item.scope}) holdout=${item.holdoutTasks.length} promotion=${item.promotionReady ? "ready" : "not-ready"} auto=${item.autoApplyReady ? "ready" : "not-ready"} - ${item.recommendation}`) : ["- none"])
    ].join("\n");
  }

  function formatAgentImprovementEvalPlanMarkdown(plan: AgentImprovementEvalPlan): string {
    const rows = plan.evaluations.map((item) => [
      `## ${item.displayName} (${item.agentId})`,
      "",
      `- Status: ${item.status}`,
      `- Score: ${item.score}/100`,
      `- Scope: ${item.scope}`,
      `- Risk: ${item.riskLevel}`,
      `- Promotion ready: ${item.promotionReady ? "yes" : "no"}`,
      `- Auto-apply ready: ${item.autoApplyReady ? "yes" : "no"}`,
      `- Rollback hash current: ${item.rollback.sourceHashCurrent ? "yes" : "no"}`,
      `- Recommendation: ${item.recommendation}`,
      "",
      "### Gates",
      "",
      ...item.gates.map((gate) => `- ${gate.passed ? "pass" : "fail"} (${gate.weight}): ${gate.id} - ${gate.message}`),
      "",
      "### Holdout Tasks",
      "",
      ...(item.holdoutTasks.length ? item.holdoutTasks.map((task) => `- ${task.status}: ${task.workflowId} ${task.runId.slice(0, 8)} - ${task.task}`) : ["- none"])
    ].join("\n")).join("\n\n");
    return [
      "# Agent Improvement Holdout Evals",
      "",
      `Generated: ${plan.generatedAt}`,
      `Project: ${plan.projectRootUri}`,
      "",
      "## Summary",
      "",
      ...plan.summary.map((item) => `- ${item}`),
      "",
      rows || "No agent improvement evals generated.",
      ""
    ].join("\n");
  }

  function formatAgentImprovementMarkdown(report: AgentImprovementReport): string {
    const candidateRows = report.candidates.map((candidate) => [
      `### ${candidate.displayName} (${candidate.agentId})`,
      "",
      `- Scope: ${candidate.scope}`,
      `- Source: ${candidate.sourcePath}`,
      `- Priority/Risk: ${candidate.priority}/${candidate.riskLevel}`,
      `- Auto-apply eligible: ${candidate.autoApplyEligible ? "yes" : "no"}`,
      `- Recommendation: ${candidate.recommendation}`,
      "- Evidence:",
      ...candidate.evidence.map((item) => `  - ${item}`),
      "- Suggested mutable fields:",
      ...candidate.suggestedMutableFields.map((item) => `  - ${item}`),
      "- Safe research queries:",
      ...candidate.safeResearchQueries.map((item) => `  - ${item}`),
      "- Validation plan:",
      ...candidate.validationPlan.map((item) => `  - ${item}`)
    ].join("\n")).join("\n\n");
    return [
      "# Agent Improvement Recommendations",
      "",
      `Generated: ${report.generatedAt}`,
      `Project: ${report.projectRootUri}`,
      `Mode: ${report.mode}`,
      "",
      "## Evidence Summary",
      "",
      `- Runs analyzed: ${report.evidenceSummary.runsAnalyzed}`,
      `- Failed runs: ${report.evidenceSummary.failedRuns}`,
      `- Shared agents: ${report.evidenceSummary.sharedAgents}`,
      `- Project-local agents: ${report.evidenceSummary.projectLocalAgents}`,
      `- Workflow references: ${report.evidenceSummary.workflowReferences}`,
      `- Feedback: ${formatInlineCounts(report.evidenceSummary.feedbackCounts) || "none"}`,
      "",
      "## Candidates",
      "",
      candidateRows || "No agent-card improvement candidates found.",
      "",
      "## Autonomy Boundary",
      "",
      "Automatic:",
      ...report.autonomyBoundary.automatic.map((item) => `- ${item}`),
      "",
      "Requires approval:",
      ...report.autonomyBoundary.approvalRequired.map((item) => `- ${item}`),
      "",
      "## Privacy Boundaries",
      "",
      ...report.privacyBoundaries.map((item) => `- ${item}`),
      ""
    ].join("\n");
  }

  function formatAgentImprovementPatchPlan(plan: AgentImprovementPatchPlan): string {
    return [
      `Agent improvement patch plan (${plan.generatedAt})`,
      `Project: ${plan.projectRootUri}`,
      `Selected: ${plan.selectedIds.length}`,
      `Skipped: ${plan.skippedIds.join(", ") || "none"}`,
      "",
      ...plan.summary.map((item) => `- ${item}`),
      "",
      "Patches:",
      ...(plan.patches.length ? plan.patches.map((patch) => `- ${patch.priority}/${patch.riskLevel}: ${patch.agentId} (${patch.scope}) fields=${patch.changedFields.join(", ") || "none"} schema=${patch.validation.schemaValid ? "valid" : "invalid"} approval=${patch.approvalRequired ? "required" : "not-required"}`) : ["- none"])
    ].join("\n");
  }

  function formatAgentImprovementPatchPlanMarkdown(plan: AgentImprovementPatchPlan): string {
    const patches = plan.patches.map((patch) => [
      `## ${patch.displayName} (${patch.agentId})`,
      "",
      `- Scope: ${patch.scope}`,
      `- Source: ${patch.sourcePath}`,
      `- Source hash: ${patch.sourceHash}`,
      `- Priority/Risk: ${patch.priority}/${patch.riskLevel}`,
      `- Schema valid: ${patch.validation.schemaValid ? "yes" : "no"}`,
      `- Approval required: ${patch.approvalRequired ? "yes" : "no"}`,
      `- Auto-apply eligible: ${patch.autoApplyEligible ? "yes" : "no"}`,
      `- Changed fields: ${patch.changedFields.join(", ") || "none"}`,
      `- Rationale: ${patch.rationale}`,
      patch.validation.errors.length ? ["", "Validation errors:", ...patch.validation.errors.map((error) => `- ${error}`)].join("\n") : "",
      "",
      "```diff",
      patch.unifiedDiff,
      "```"
    ].filter(Boolean).join("\n")).join("\n\n");
    return [
      "# Agent Improvement Patch Plan",
      "",
      `Generated: ${plan.generatedAt}`,
      `Project: ${plan.projectRootUri}`,
      "",
      "## Summary",
      "",
      ...plan.summary.map((item) => `- ${item}`),
      "",
      patches || "No patch previews generated.",
      ""
    ].join("\n");
  }

  function formatAgentImprovementPromotionQueue(queue: AgentImprovementPromotionQueue): string {
    return [
      `Agent improvement promotion queue (${queue.generatedAt})`,
      `Project: ${queue.projectRootUri}`,
      `Selected: ${queue.selectedIds.length}`,
      `Skipped: ${queue.skippedIds.join(", ") || "none"}`,
      "",
      ...queue.summary.map((item) => `- ${item}`),
      "",
      "Promotions:",
      ...(queue.items.length ? queue.items.map((item) => `- ${item.status} ${item.score}/100: ${item.agentId} (${item.scope}, ${item.priority}/${item.riskLevel}) approval=${item.approvalRequired ? "required" : "not-required"} ${item.id}`) : ["- none"])
    ].join("\n");
  }

  function formatAgentImprovementPromotionReceipts(receipts: AgentImprovementPromotionReceiptLog): string {
    return [
      `Agent improvement promotion receipts (${receipts.updatedAt})`,
      `Project: ${receipts.projectRootUri}`,
      `Events: ${receipts.events.length}`,
      "",
      ...(receipts.events.length ? receipts.events.slice(-20).map((event) => `- ${event.status}: ${event.agentId} ${event.score}/100 by ${event.actor} (${event.promotionId})`) : ["- none"])
    ].join("\n");
  }

  function formatAgentImprovementReport(report: AgentImprovementReport): string {
    return [
      `Agent improvement report (${report.generatedAt})`,
      `Project: ${report.projectRootUri}`,
      `Mode: ${report.mode}`,
      `Agents analyzed: ${report.agentsAnalyzed}`,
      `Evidence: runs=${report.evidenceSummary.runsAnalyzed}, failed=${report.evidenceSummary.failedRuns}, sharedAgents=${report.evidenceSummary.sharedAgents}, projectLocalAgents=${report.evidenceSummary.projectLocalAgents}, workflowRefs=${report.evidenceSummary.workflowReferences}`,
      `Feedback: ${formatInlineCounts(report.evidenceSummary.feedbackCounts) || "none"}`,
      "",
      "Candidates:",
      ...(report.candidates.length ? report.candidates.map((candidate) => `- ${candidate.priority}/${candidate.riskLevel}: ${candidate.agentId} (${candidate.scope}) - ${candidate.recommendation}`) : ["- none"]),
      "",
      "Automatic:",
      ...report.autonomyBoundary.automatic.map((item) => `- ${item}`),
      "",
      "Requires approval:",
      ...report.autonomyBoundary.approvalRequired.map((item) => `- ${item}`),
      "",
      "Privacy boundaries:",
      ...report.privacyBoundaries.map((item) => `- ${item}`),
      "",
      "Next commands:",
      ...report.nextCommands.map((command) => `- ${command}`)
    ].join("\n");
  }

  function formatFeedbackInboxBucket(title: string, rating: FeedbackRating, items: DashboardFeedbackInboxItem[]): string[] {
    if (!items.length) {
      return [title, "- none", ""];
    }
    return [
      title,
      ...items.map((item) => [
        `- ${item.runId} ${item.workflowId} ${item.status}`,
        `  route: ${item.provider ?? "default"}/${item.modelTier ?? "auto tier"}`,
        `  reason: ${item.classification.reason}`,
        `  task: ${truncateText(item.task, 140)}`,
        item.summary ? `  stages: ${item.summary.completedTasks}/${item.summary.totalTasks} complete, ${item.summary.failedTasks} failed` : "",
        item.summary?.keyFindings.length ? `  findings: ${truncateText(item.summary.keyFindings[0], 160)}` : "",
        item.summary?.failures.length ? `  failure: ${truncateText(item.summary.failures[0], 160)}` : "",
        `  record: npm run agentflow -- feedback --run ${item.runId} --rating ${rating} --note ${shellQuote(defaultFeedbackNote(item, rating))}`
      ].filter(Boolean).join("\n")),
      ""
    ];
  }

  function formatFeedbackInboxReport(report: DashboardFeedbackInboxReport): string {
    return [
      "Feedback Inbox",
      `Generated: ${report.generatedAt}`,
      `Project: ${report.projectRootUri ?? "all registered projects"}`,
      `Scanned: ${report.totalCandidates}`,
      `Unreviewed: ${report.totalTargets}`,
      `Buckets: accept=${report.counts.probably_accept} revise=${report.counts.probably_revise} reject=${report.counts.probably_reject}`,
      "",
      ...formatFeedbackInboxBucket("Probably Accept", "accepted", report.groups.probably_accept),
      ...formatFeedbackInboxBucket("Probably Revise", "revised", report.groups.probably_revise),
      ...formatFeedbackInboxBucket("Probably Reject", "rejected", report.groups.probably_reject)
    ].join("\n");
  }

  function formatLearningActionReceiptCompaction(result: LearningActionReceiptCompactionResult): string {
    return [
      `Learning Receipt Compaction: ${result.projectRootUri}`,
      `Removed receipts: ${result.removedReceipts}`,
      `Before: ${result.before.totalReceipts} total, ${result.before.duplicateDaemonOpenReceipts} duplicate daemon open`,
      `After: ${result.after.totalReceipts} total, ${result.after.duplicateDaemonOpenReceipts} duplicate daemon open`,
      `Backups: ${result.backupPaths.length ? result.backupPaths.join(", ") : "none needed"}`,
      `Recommendation: ${result.after.recommendation}`
    ].join("\n");
  }

  function formatLearningActionReceiptHealth(health: LearningActionReceiptHealth): string {
    return [
      `Learning Receipt Health: ${health.projectRootUri}`,
      `Generated: ${health.generatedAt}`,
      `Updated: ${health.updatedAt}`,
      `Total receipts: ${health.totalReceipts}`,
      `Counts: planned=${health.counts.planned ?? 0} applied=${health.counts.applied ?? 0} superseded=${health.counts.superseded ?? 0} rejected=${health.counts.rejected ?? 0}`,
      `Daemon open receipts: ${health.daemonOpenReceipts}`,
      `Unique daemon open receipts: ${health.uniqueDaemonOpenReceipts}`,
      `Duplicate daemon open receipts: ${health.duplicateDaemonOpenReceipts}`,
      `Latest receipt: ${health.latestReceiptAt ?? "none"}`,
      `Latest backup: ${health.latestBackupPath ?? "none"}`,
      `Recommendation: ${health.recommendation}`
    ].join("\n");
  }

  function formatLearningApplicationPlan(plan: LearningApplicationPlan): string {
    return [
      `Learning Application Plan: ${plan.projectRootUri}`,
      `Generated: ${plan.generatedAt}`,
      `Selected proposals: ${plan.selectedIds.join(", ") || "none"}`,
      plan.skippedIds.length ? `Skipped unknown or unapproved ids: ${plan.skippedIds.join(", ")}` : "",
      "",
      "Summary",
      plan.summary.map((item) => `- ${item}`).join("\n"),
      "",
      "Actions",
      plan.actions.length
        ? plan.actions.map((action) => [
          `- ${action.id} ${action.actionType}: ${action.title}`,
          `  - Proposal: ${action.proposalId}`,
          `  - Gate: ${action.dangerGate}`,
          `  - Owned learning state only: ${action.writesOwnedLearningStateOnly ? "yes" : "no"}`,
          `  - Rationale: ${action.rationale}`,
          action.command ? `  - Command: ${action.command}` : "",
          action.blockedUntil.length ? `  - Blocked until: ${action.blockedUntil.join("; ")}` : ""
        ].filter(Boolean).join("\n")).join("\n")
        : "- No actions."
    ].filter(Boolean).join("\n");
  }

  function formatLearningApplicationPlanMarkdown(plan: LearningApplicationPlan): string {
    const sections = plan.actions.map((action) => [
      `## ${action.id} - ${action.title}`,
      "",
      `- Proposal: ${action.proposalId}`,
      `- Type: ${action.actionType}`,
      `- Gate: ${action.dangerGate}`,
      `- Owned learning state only: ${action.writesOwnedLearningStateOnly ? "yes" : "no"}`,
      `- Rationale: ${action.rationale}`,
      action.command ? `- Command: \`${action.command.replaceAll("`", "\\`")}\`` : "",
      "",
      "Blocked until:",
      ...action.blockedUntil.map((item) => `- ${item}`),
      ""
    ].filter(Boolean).join("\n"));
    return [
      "# Agent Workflow Learning Application Plan",
      "",
      `Project: ${plan.projectRootUri}`,
      `Generated: ${plan.generatedAt}`,
      `Source inbox: ${plan.sourceGeneratedAt}`,
      `Selected proposals: ${plan.selectedIds.join(", ") || "none"}`,
      plan.skippedIds.length ? `Skipped: ${plan.skippedIds.join(", ")}` : "",
      "",
      "## Summary",
      "",
      ...plan.summary.map((item) => `- ${item}`),
      "",
      ...sections
    ].filter(Boolean).join("\n");
  }

  function formatLearningApprovalQueue(queue: LearningApprovalQueue): string {
    const counts = countStrings(queue.items.map((item) => item.status));
    return [
      `Learning Approval Inbox: ${queue.projectRootUri}`,
      `Generated: ${queue.generatedAt}`,
      `Source runs analyzed: ${queue.sourceRunsAnalyzed}`,
      `Counts: pending=${counts.pending ?? 0} approved=${counts.approved ?? 0} rejected=${counts.rejected ?? 0}`,
      queue.skippedIds.length ? `Skipped unknown ids: ${queue.skippedIds.join(", ")}` : "",
      "",
      queue.items.length
        ? queue.items.map((item) => [
          `- ${item.proposalId} ${item.status}: ${item.proposal.title}`,
          `  - Approval id: ${item.id}`,
          `  - Risk: ${item.proposal.riskLevel}${item.proposal.approvalRequired ? " approval-required" : " report-only"}`,
          `  - Recommendation: ${item.proposal.recommendation}`,
          item.note ? `  - Note: ${item.note}` : ""
        ].filter(Boolean).join("\n")).join("\n")
        : "- No learning approval items."
    ].filter(Boolean).join("\n");
  }

  function formatLearningApprovalQueueMarkdown(queue: LearningApprovalQueue): string {
    const sections = queue.items.map((item) => [
      `## ${item.proposalId} - ${item.status}`,
      "",
      `- Approval id: ${item.id}`,
      `- Title: ${item.proposal.title}`,
      `- Priority: ${item.proposal.priority}`,
      `- Kind: ${item.proposal.kind}`,
      `- Risk: ${item.proposal.riskLevel}`,
      `- Target: ${item.proposal.target}`,
      `- Approval required: ${item.proposal.approvalRequired ? "yes" : "no"}`,
      `- Created: ${item.createdAt}`,
      item.decidedAt ? `- Decided: ${item.decidedAt}` : "",
      item.reviewer ? `- Reviewer: ${item.reviewer}` : "",
      item.note ? `- Note: ${item.note}` : "",
      `- Rationale: ${item.proposal.rationale}`,
      `- Recommendation: ${item.proposal.recommendation}`,
      "",
      "Evidence:",
      ...item.proposal.evidence.map((evidence) => `- ${evidence}`),
      ""
    ].filter(Boolean).join("\n"));
    return [
      "# Agent Workflow Learning Approval Inbox",
      "",
      `Project: ${queue.projectRootUri}`,
      `Generated: ${queue.generatedAt}`,
      `Source proposals: ${queue.sourceGeneratedAt}`,
      `Source runs analyzed: ${queue.sourceRunsAnalyzed}`,
      "",
      ...sections
    ].join("\n");
  }

  function formatLearningAutonomousApplicationResult(result: LearningAutonomousApplicationResult): string {
    return [
      "# Agent Workflow Autonomous Learning Application",
      "",
      `Project: ${result.projectRootUri}`,
      `Generated: ${result.generatedAt}`,
      `Applied actions: ${result.appliedActions}`,
      `Skipped actions: ${result.skippedActions}`,
      "",
      "## Notes",
      "",
      ...result.notes.map((note) => `- ${note}`),
      "",
      "## Files Written",
      "",
      ...(result.filesWritten.length ? result.filesWritten.map((file) => `- \`${file}\``) : ["- none"]),
      ""
    ].join("\n");
  }

  function formatLearningDaemonMcpCleanupReceipt(receipt: {
    kind: string;
    generatedAt: string;
    projectRootUri: string;
    config: RuntimeMonitorReport["mcpCleanup"]["autoCleanup"];
    candidates: Array<Pick<RuntimeMonitorReport["mcpCleanup"]["candidates"][number], "pid" | "parentPid" | "sessionKey" | "risk" | "autoCleanable" | "ageMs" | "startedAt" | "reason">>;
    terminated: RuntimeMcpCleanupResult["terminated"];
    warnings: string[];
  }): string {
    return [
      "# Learning Daemon MCP Cleanup",
      "",
      `Generated: ${receipt.generatedAt}`,
      `Project: ${receipt.projectRootUri}`,
      `Enabled: ${receipt.config.enabled ? "yes" : "no"}`,
      `Mode: ${receipt.config.mode}`,
      `Stale threshold: ${receipt.config.staleMinutes} minute(s)`,
      "",
      "## Candidates",
      ...(receipt.candidates.length
        ? receipt.candidates.map((candidate) => `- PID ${candidate.pid} parent=${candidate.parentPid ?? "n/a"} session=${candidate.sessionKey} risk=${candidate.risk} autoCleanable=${candidate.autoCleanable ? "yes" : "no"} age=${candidate.ageMs === null ? "n/a" : formatDuration(candidate.ageMs)} - ${candidate.reason}`)
        : ["- none"]),
      "",
      "## Terminated",
      ...(receipt.terminated.length
        ? receipt.terminated.map((item) => `- PID ${item.pid}: ${item.status} - ${item.message}`)
        : ["- none"]),
      "",
      "## Warnings",
      ...(receipt.warnings.length ? receipt.warnings.map((warning) => `- ${warning}`) : ["- none"])
    ].join("\n");
  }

  function formatLearningDaemonStaleRunReconciliationReceipt(receipt: {
    kind: string;
    generatedAt: string;
    projectRootUri: string;
    config: RuntimeMonitorReport["staleRuns"]["autoReconcile"];
    mode: RuntimeStaleRunReconciliationResult["mode"];
    candidates: Array<Pick<RuntimeMonitorReport["staleRuns"]["candidates"][number], "runId" | "workflowId" | "runStatus" | "recommendedStatus" | "totalTasks" | "completedTasks" | "cancelledTasks" | "startedAt" | "task">>;
    reconciled: RuntimeStaleRunReconciliationResult["reconciled"];
  }): string {
    return [
      "# Learning Daemon Stale Run Reconciliation",
      "",
      `Generated: ${receipt.generatedAt}`,
      `Project: ${receipt.projectRootUri}`,
      `Enabled: ${receipt.config.enabled ? "yes" : "no"}`,
      `Mode: ${receipt.mode}`,
      `Limit: ${receipt.config.limit}`,
      "",
      "## Candidates",
      ...(receipt.candidates.length
        ? receipt.candidates.map((candidate) => `- ${candidate.runId} ${candidate.runStatus}->${candidate.recommendedStatus} workflow=${candidate.workflowId} tasks=${candidate.completedTasks}/${candidate.totalTasks} completed cancelled=${candidate.cancelledTasks} - ${candidate.task}`)
        : ["- none"]),
      "",
      "## Reconciled",
      ...(receipt.reconciled.length
        ? receipt.reconciled.map((item) => `- ${item.runId}: ${item.updated ? "updated" : "skipped"} as ${item.status}`)
        : ["- none"])
    ].join("\n");
  }

  function formatLearningDaemonStatus(status: DashboardLearningDaemonStatus): string {
    return [
      `Learning daemon: ${status.status}`,
      `Project: ${status.projectRootUri}`,
      `Mode: ${status.mode ?? "n/a"}`,
      `Daemon: ${status.daemonId ?? "n/a"}`,
      `PID: ${status.pid ?? "none"} (${status.processAlive ? "alive" : "not running"})`,
      `Last heartbeat: ${status.lastHeartbeatAt ?? "none"}`,
      `Last report: ${status.lastReportAt ?? "none"}`,
      `Ticks: ${status.ticks}`,
      `Proposals: ${status.proposals}`,
      `Training discovery: ${status.trainingDiscoveryStatus ?? "not run"}`,
      `Training discovery last run: ${status.trainingDiscoveryLastRunAt ?? "none"}`,
      `Training discovery next run: ${status.trainingDiscoveryNextRunAfter ?? "none"}`,
      `Training discovery proposals/errors: ${status.trainingDiscoveryProposals}/${status.trainingDiscoveryErrors}`,
      `Roadmap snapshot: ${status.roadmapSnapshotStatus ?? "not published"}`,
      `Roadmap snapshot published: ${status.roadmapSnapshotPublishedAt ?? "none"}`,
      `Roadmap snapshot digest: ${status.roadmapSnapshotDigest ?? "none"}`,
      `Inbox items: ${status.inboxItems}`,
      `Application actions: ${status.applicationActions}`,
      `Autonomous applied actions: ${status.autonomousAppliedActions}`,
      `Autonomous apply max risk: ${status.autonomousApplyMaxRisk}`,
      `Agent improvement candidates: ${status.agentImprovementCandidates}`,
      `Agent improvement patch previews: ${status.agentImprovementPatchPreviews}`,
      `Agent improvement eval passes: ${status.agentImprovementEvalPasses}`,
      `Agent improvement promotions: ${status.agentImprovementPromotions}`,
      `Agent improvement promotion pending: ${status.agentImprovementPromotionPending}`,
      `Agent improvement applied: ${status.agentImprovementApplied}`,
      `Agent improvement apply skipped: ${status.agentImprovementApplySkipped}`,
      `Approval autopilot: ${status.approvalAutopilotEnabled ? "on" : "off"} through ${status.approvalAutopilotMaxRisk}`,
      `Approval autopilot executed: ${status.approvalAutopilotExecuted}`,
      `Approval autopilot skipped: ${status.approvalAutopilotSkipped}`,
      `Approval backlog scanned: ${status.approvalBacklogScanned}`,
      `Approval backlog warnings: ${status.approvalBacklogWarnings}`,
      `Approval backlog errors: ${status.approvalBacklogErrors}`,
      `MCP cleanup: ${status.mcpCleanupEnabled ? status.mcpCleanupMode : "off"} through ${status.mcpCleanupStaleMinutes} minute(s)`,
      `MCP cleanup candidates: ${status.mcpCleanupCandidates}`,
      `MCP cleanup auto-cleanable: ${status.mcpCleanupAutoCleanable}`,
      `MCP cleanup terminated: ${status.mcpCleanupTerminated}`,
      `MCP cleanup warnings: ${status.mcpCleanupWarnings}`,
      `Last MCP cleanup: ${status.lastMcpCleanupAt ?? "none"}`,
      `Stale run reconcile: ${status.staleRunReconcileEnabled ? "on" : "off"}`,
      `Stale run candidates: ${status.staleRunReconcileCandidates}`,
      `Stale runs reconciled: ${status.staleRunReconciled}`,
      `Last stale run reconcile: ${status.lastStaleRunReconcileAt ?? "none"}`,
      status.lastError ? `Last error: ${status.lastError}` : "",
      `Heartbeat file: ${status.heartbeatPath}`,
      `Start command: ${status.command}`
    ].filter(Boolean).join("\n");
  }

  function formatLearningFailureTriage(report: LearningFailureTriageReport): string {
    return [
      "# Learning Daemon Failure Triage",
      "",
      `Generated: ${report.generatedAt}`,
      `Project: ${report.projectRootUri}`,
      "",
      report.observation,
      "",
      "## Root-cause groups",
      ...(report.groups.length ? report.groups.map((group) => `- ${group.signature} [${group.risk}] ${group.action}: ${group.diagnosis} ${group.detail} Runs: ${group.runIds.join(", ")}`) : ["- none"]),
      "",
      `Retried: ${report.retriedRuns.length ? report.retriedRuns.join(", ") : "none"}`,
      `Withheld: ${report.withheldRuns.length ? report.withheldRuns.join(", ") : "none"}`,
      ""
    ].join("\n");
  }

  function formatLearningReport(report: LearningReport): string {
    return [
      `Learning report (${report.generatedAt})`,
      `Project: ${report.projectDir}`,
      `Mode: ${report.autonomyMode}`,
      `Runs analyzed: ${report.runsAnalyzed}`,
      `Run statuses: ${formatInlineCounts(report.runStatusCounts) || "none"}`,
      `Feedback: ${formatInlineCounts(report.feedbackCounts) || "none"}`,
      `Route feedback: ${formatInlineCounts(report.routeFeedback.counts) || "none"}${report.routeFeedback.latestAt ? ` latest=${report.routeFeedback.latestAt}` : ""}`,
      `Evaluation runs: ${report.evaluationRuns}${report.latestEvaluationAt ? ` latest=${report.latestEvaluationAt}` : ""}`,
      `Proposal preview: total=${report.proposalPreview.total} high=${report.proposalPreview.highPriority} ${formatInlineCounts(report.proposalPreview.byKind)}`,
      "",
      "Repeated failure patterns:",
      ...(report.repeatedFailurePatterns.length ? report.repeatedFailurePatterns.map((pattern) => `- ${pattern.workflowId}/${pattern.stageId}/${pattern.agentId}: ${pattern.failedTasks}/${pattern.totalTasks} failed (${pattern.failureRate})`) : ["- none"]),
      "",
      "Cost and routing opportunities:",
      ...(report.costOpportunities.length ? report.costOpportunities.map((item) => `- ${item.workflowId}/${item.stageId}/${item.agentId}: ${item.providerId}/${item.modelTier}, fallback=${item.fallbackRate}, latency=${item.averageLatencyMs ?? "n/a"}ms - ${item.recommendation}`) : ["- none"]),
      "",
      "Route feedback signals:",
      ...(report.routeFeedback.costlyGroups.length ? report.routeFeedback.costlyGroups.map((group) => `- costly ${group.target}: ${group.route} ${group.routeClass}, signals=${group.total}, latest=${group.latestAt ?? "n/a"}`) : ["- no costly route groups"]),
      ...(report.routeFeedback.helpfulGroups.length ? report.routeFeedback.helpfulGroups.map((group) => `- helpful ${group.target}: ${group.route} ${group.routeClass}, signals=${group.total}, latest=${group.latestAt ?? "n/a"}`) : ["- no helpful route groups"]),
      "",
      "Evaluation gaps:",
      ...report.evalGaps.map((item) => `- ${item}`),
      "",
      "Safe automatic actions:",
      ...report.safeAutomaticActions.map((item) => `- ${item}`),
      "",
      "Approval required:",
      ...report.approvalRequiredActions.map((item) => `- ${item}`),
      "",
      "Privacy boundaries:",
      ...report.privacyBoundaries.map((item) => `- ${item}`),
      "",
      "Next commands:",
      ...report.nextCommands.map((command) => `- ${command}`)
    ].join("\n");
  }

  async function learnFromWorkflowRepairs(projectDir: string): Promise<number> {
    const runs = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: 500 });
    const repairSources = new Set(["blocked-run-repair", "workflow-supervisor-repair", "workflow-root-repair"]);
    let learned = 0;
    for (const run of runs) {
      const source = stringValue(run.evaluationMetadata?.source) ?? "";
      if (!repairSources.has(source) || !["completed", "blocked", "failed", "cancelled"].includes(run.status)) continue;
      const details = await getWorkflowRunDetails(run.id);
      if (details.receipts.some((receipt) => receipt.actionType === "workflow_repair_learning")) continue;
      const completedTasks = details.tasks.filter((task) => task.status === "completed").length;
      const failedTasks = details.tasks.filter((task) => task.status === "failed" || task.status === "blocked").length;
      const strategy = stringValue(run.evaluationMetadata?.rootRepairKind)
        ?? stringValue(run.evaluationMetadata?.repairWorkflowId)
        ?? (run.workflowId === "build-feature" ? "build-feature" : run.workflowId === "debug-failure" ? "debug-failure" : "replay-original");
      const lesson = workflowRepairLesson({ strategy, repairStatus: run.status, completedTasks, failedTasks });
      const sourceRunId = stringValue(run.evaluationMetadata?.sourceRunId) ?? "unknown";
      await recordRunAction({
        runId: run.id,
        agentId: "workflow-orchestrator",
        actionType: "workflow_repair_learning",
        target: strategy,
        summary: `${lesson.outcome}: ${lesson.futureAction}`,
        artifactKind: "workflow_repair_learning",
        artifactContent: {
          sourceRunId,
          repairRunId: run.id,
          rootCauseClass: strategy,
          repairStatus: run.status,
          completedTasks,
          failedTasks,
          outcome: lesson.outcome,
          futureAction: lesson.futureAction,
          diagnosisOrder: lesson.diagnosisOrder,
          prevention: lesson.prevention,
          confidence: lesson.confidence
        },
        idempotencyKey: `workflow-repair-learning-${run.id}-${run.status}`
      });
      await upsertMemoryItem({
        projectRootUri: projectDir,
        sourceUri: `agentflow://repair-learning/${run.id}`,
        summary: `Workflow repair lesson (${strategy}): ${lesson.outcome}. ${lesson.futureAction} Prevention: ${lesson.prevention}`,
        metadata: {
          kind: "workflow_repair_learning",
          sourceRunId,
          repairRunId: run.id,
          rootCauseClass: strategy,
          repairStatus: run.status,
          outcome: lesson.outcome,
          prevention: lesson.prevention,
          confidence: lesson.confidence
        }
      });
      learned += 1;
    }
    return learned;
  }

  async function learningAgentImprovementProjectLocalAutoApplyEnabled(projectDir: string): Promise<boolean> {
    const override = process.env.AGENTFLOW_AGENT_IMPROVEMENT_PROJECT_LOCAL_AUTO_APPLY;
    if (override === "0" || override === "false" || override === "off") {
      return false;
    }
    if (override === "1" || override === "true" || override === "on") {
      return true;
    }
    const settings = await readLearningSettings(projectDir).catch(() => null);
    return settings?.agentImprovementProjectLocalAutoApply ?? true;
  }

  async function learningApprovalAutopilotEnabled(projectDir: string): Promise<boolean> {
    const override = process.env.AGENTFLOW_APPROVAL_AUTOPILOT;
    if (override === "0" || override === "false" || override === "off") {
      return false;
    }
    if (override === "1" || override === "true" || override === "on") {
      return true;
    }
    const settings = await readLearningSettings(projectDir).catch(() => null);
    return settings?.approvalAutopilotEnabled ?? false;
  }

  async function learningApprovalAutopilotMaxRisk(projectDir: string): Promise<ApprovalAutopilotRisk> {
    const override = process.env.AGENTFLOW_APPROVAL_AUTOPILOT_MAX_RISK;
    const settings = await readLearningSettings(projectDir).catch(() => null);
    return lowerTrustLevel(override ? parseApprovalAutopilotRisk(override) : settings?.approvalAutopilotMaxRisk ?? parseApprovalAutopilotRisk(process.env.AGENTFLOW_LEARNING_AUTONOMOUS_MAX_RISK), settings?.daemonTrustLevels["action-executor"] ?? "low");
  }

  async function learningAutonomousApplyMaxRisk(projectDir: string): Promise<LearningRiskLevel> {
    const override = process.env.AGENTFLOW_LEARNING_AUTONOMOUS_MAX_RISK;
    const settings = await readLearningSettings(projectDir).catch(() => null);
    return lowerTrustLevel(override ? parseLearningRiskLevel(override) : settings?.autonomousApplyMaxRisk ?? "medium", settings?.daemonTrustLevels["action-executor"] ?? "low");
  }

  async function learningWorkflowShapeAutoUpdateEnabled(projectDir: string): Promise<boolean> {
    const override = process.env.AGENTFLOW_LEARNING_WORKFLOW_SHAPE_AUTO_UPDATE;
    if (override === "0" || override === "false" || override === "off") {
      return false;
    }
    if (override === "1" || override === "true" || override === "on") {
      return true;
    }
    const settings = await readLearningSettings(projectDir).catch(() => null);
    return settings?.workflowShapeAutoUpdate ?? true;
  }

  async function loadAndWriteRoadmapSuggestions(projectDir: string): Promise<RoadmapSuggestionReport> {
    let roadmapPath: string;
    try {
      const config = await loadProjectConfig(projectDir);
      roadmapPath = config.project.roadmap_path;
    } catch {
      roadmapPath = (await discoverProjectRoadmap(projectDir)).relativePath;
    }
    const absolutePath = await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: roadmapPath, label: "project.roadmap_path" });
    let markdown: string | undefined;
    try {
      markdown = await fs.readFile(absolutePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const report = buildRoadmapSuggestionReport({ projectRootUri: projectDir, roadmapPath, markdown });
    const learningDir = path.join(projectDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
    await fs.writeFile(path.join(learningDir, "roadmap-suggestions.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(learningDir, "roadmap-suggestions.md"), `${formatRoadmapSuggestionReport(report)}\n`, "utf8");
    return report;
  }

  async function loadLearningDaemonProjectTargets(fallbackProjectDir: string): Promise<LearningDaemonProjectTarget[]> {
    const summaries = await listProjectStorageSummaries(500);
    const mappedRoots = await Promise.all(summaries.map((summary) => resolveLocalProjectRootUri(summary.rootUri)));
    const candidates = orderedUnique([
      ...mappedRoots,
      fallbackProjectDir
    ].map((item) => path.resolve(process.cwd(), item)));
    const available: LearningDaemonProjectTarget[] = [];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        const settings = await readLearningSettings(candidate).catch(() => null);
        available.push({
          projectDir: candidate,
          enabled: settings?.daemonEnabled ?? true,
          paused: settings?.daemonPaused ?? false,
          mode: settings?.daemonMode ?? "apply-approved",
          limit: settings?.daemonRunLimit ?? 50
        });
      }
    }
    return available.length ? available : [{ projectDir: fallbackProjectDir, enabled: true, paused: false, mode: "apply-approved", limit: 50 }];
  }

  async function loadProjectDeliveryReceipts(projectDir: string): Promise<SupervisedDeliveryReceipt[]> {
    const receiptsDir = path.join(projectDir, ".agent-workflow", "receipts");
    const entries = await fs.readdir(receiptsDir, { withFileTypes: true }).catch(() => []);
    const candidates = entries
      .filter((entry) => entry.isFile() && /\.(?:md|json)$/iu.test(entry.name))
      .slice(0, 250);
    const receipts: SupervisedDeliveryReceipt[] = [];
    for (const entry of candidates) {
      const absolutePath = path.join(receiptsDir, entry.name);
      const content = await fs.readFile(absolutePath, "utf8").catch(() => "");
      if (!content || content.length > 100_000) continue;
      receipts.push({ path: path.relative(projectDir, absolutePath), content });
    }
    return receipts;
  }

  async function notifyOriginatingCodexTask(projectDir: string): Promise<number> {
    const runs = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: 200 });
    const originated = runs.filter((run) => !run.dismissed && codexThreadId(run.evaluationMetadata));

    for (const run of originated) {
      const threadId = codexThreadId(run.evaluationMetadata);
      if (!threadId) continue;
      const details = await getWorkflowRunDetails(run.id);
      const deliveredTargets = new Set(details.receipts
        .filter((receipt) => receipt.actionType === CODEX_CALLBACK_RECEIPT)
        .map((receipt) => receipt.target));
      const approvals = await listActionApprovals({ runId: run.id, status: "pending", limit: 20 });
      const approval = approvals.find((item) => !deliveredTargets.has(`approval:${item.id}`)
        && isWithinAutomaticWorkflowRepairWindow(item.createdAt));
      if (approval) {
        const target = `approval:${approval.id}`;
        const delivered = await deliverCodexWorkflowCallback({
          threadId,
          projectDir,
          prompt: approvalCallbackPrompt({
            runId: run.id,
            workflowId: run.workflowId,
            projectName: run.projectName,
            approvalId: approval.id,
            actionType: approval.actionType,
            target: approval.target,
            rationale: approval.rationale
          })
        });
        if (!delivered) return 0;
        await recordRunAction({
          runId: run.id,
          agentId: "workflow-orchestrator",
          actionType: CODEX_CALLBACK_RECEIPT,
          target,
          summary: "Delivered an approval request to the originating Codex task.",
          artifactKind: "codex_attention_delivery",
          artifactContent: { kind: "approval", approvalId: approval.id, threadId },
          idempotencyKey: `codex-approval-${approval.id}`
        });
        return 1;
      }

      if (!["blocked", "failed"].includes(run.status) || !run.finishedAt
        || !isWithinAutomaticWorkflowRepairWindow(run.finishedAt)
        || deliveredTargets.has(`failure:${run.status}`)
        || approvals.length > 0
        || details.receipts.some((receipt) => receipt.actionType === "blocked_run_repair_queued" || receipt.actionType === "workflow_supervisor_repair_queued")) continue;
      const target = `failure:${run.status}`;
      const delivered = await deliverCodexWorkflowCallback({
        threadId,
        projectDir,
        prompt: failureCallbackPrompt({
          runId: run.id,
          workflowId: run.workflowId,
          projectName: run.projectName,
          status: run.status,
          task: run.task.slice(0, 2000)
        })
      });
      if (!delivered) return 0;
      await recordRunAction({
        runId: run.id,
        agentId: "workflow-orchestrator",
        actionType: CODEX_CALLBACK_RECEIPT,
        target,
        summary: "Delivered a workflow failure to the originating Codex task.",
        artifactKind: "codex_attention_delivery",
        artifactContent: { kind: "failure", status: run.status, threadId },
        idempotencyKey: `codex-failure-${run.id}-${run.status}`
      });
      return 1;
    }
    return 0;
  }

  /**
   * Chat-mode: deliver pending requester notifications through the run's channel.
   * - codex: callback into the originating Codex thread (existing mechanism)
   * - command: pipe JSON to AGENTFLOW_NOTIFY_COMMAND (e.g. a local messaging bridge)
   * - dashboard/cli/other: marked delivered; surfaced in the dashboard and via
   *   the `notifications` CLI command.
   */

  function proposalSetFromApprovedQueue(queue: TuningApprovalQueue): TuningProposalSet {
    const proposals = queue.items.filter((item) => item.status === "approved").map((item) => item.proposal);
    return {
      projectRootUri: queue.projectRootUri,
      generatedAt: new Date().toISOString(),
      sourceRunsAnalyzed: queue.sourceRunsAnalyzed,
      proposals,
      summary: [
        `${proposals.length} approved tuning proposal(s) selected from the project-local approval queue.`,
        "Only approved proposals are included in this application plan."
      ]
    };
  }

  async function queueSupervisedWorkflowRepair(input: {
    run: WorkflowRunStatus;
    projectDir: string;
    reason: string;
    actor: string;
  }): Promise<boolean> {
    // Repair-of-repair cap: a repair run that itself fails is terminal.
    // Spawning a repair of a repair creates unbounded chains (observed:
    // N blocked debug-failure runs all repairing the same parent).
    const runMeta = (input.run.evaluationMetadata ?? {}) as Record<string, unknown>;
    if (runMeta.source === "workflow-supervisor-repair") {
      await recordRunAction({
        runId: input.run.id,
        agentId: "workflow-orchestrator",
        actionType: "workflow_supervisor_repair_refused",
        target: String(runMeta.sourceRunId ?? "unknown"),
        summary: "Repair run failed; refusing to spawn a repair-of-repair. Escalating to operator instead of chaining.",
        artifactKind: "workflow_supervisor_repair",
        artifactContent: {
          sourceRunId: input.run.id,
          refusedBecause: "repair-of-repair",
          originalSourceRunId: runMeta.sourceRunId ?? null,
          finding: input.reason.slice(0, 2000)
        },
        idempotencyKey: `workflow-supervisor-repair-refused-${input.run.id}`
      }).catch(() => undefined);
      return false;
    }
    try {
      await indexProjectForRun(ctx, { projectDir: input.projectDir, maxFiles: 180, refine: false, forceRefine: false });
    } catch {
      return false;
    }
    const repairWorkflowId = supervisedRepairWorkflowId(input.run, input.reason);
    const repairTask = [
      `Repair supervised Agent Workflow run ${input.run.id}.`,
      `Original workflow: ${input.run.workflowId}.`,
      `Original task: ${input.run.task.slice(0, 4000)}`,
      `Supervisor finding: ${input.reason.slice(0, 2000)}`,
      "Preserve the original acceptance contract and completed checkpoints. Work only within the current project policy; do not edit policy to grant yourself authority. Apply product edits, verification, packaging, or installation only when the original task requires them. For read-only or advisory work, diagnose and verify without inventing file writes. If policy prevents an action required by the original task, remain blocked and identify the exact missing permission or approval."
    ].join("\n\n");
    const queued = await queueWorkflow(ctx, {
      workflowId: repairWorkflowId,
      projectPath: input.projectDir,
      registeredProjectRootUri: input.run.projectRootUri,
      task: repairTask,
      sourceTokenBudget: "12000",
      sourceMaxFiles: "180",
      includeExactSourceExcerpts: true,
      preferImplementationSources: true,
      requester: input.run.requester ?? undefined,
      requesterChannel: input.run.requesterChannel ?? undefined,
      evaluationMetadata: { ...inheritedCodexOrigin(input.run.evaluationMetadata), source: "workflow-supervisor-repair", sourceRunId: input.run.id, actor: input.actor, repairWorkflowId }
    });
    if (!queued.ok) return false;
    await recordRunAction({
      runId: input.run.id,
      agentId: "workflow-orchestrator",
      actionType: "workflow_supervisor_repair_queued",
      target: queued.run.runId,
      summary: "Workflow supervisor refreshed project context and queued a policy-bounded repair run.",
      artifactKind: "workflow_supervisor_repair",
      artifactContent: {
        sourceRunId: input.run.id,
        repairRunId: queued.run.runId,
        workflowId: queued.workflow.id,
        projectRootUri: input.run.projectRootUri,
        finding: input.reason
      },
      idempotencyKey: `workflow-supervisor-repair-${input.run.id}-${queued.run.runId}`
    });
    return true;
  }

  async function readAgentImprovementApplyReceipts(projectDir: string): Promise<AgentImprovementApplyReceiptLog> {
    const receiptsPath = path.join(projectDir, ".agent-workflow", "learning", "agent-improvement-apply-receipts.json");
    const raw = await fs.readFile(receiptsPath, "utf8");
    const parsed = JSON.parse(raw) as AgentImprovementApplyReceiptLog;
    if (parsed.kind !== "agentflow_agent_improvement_apply_receipts" || !Array.isArray(parsed.events)) {
      throw new Error(`Invalid agent improvement apply receipts: ${receiptsPath}`);
    }
    return parsed;
  }

  async function readTuningPatchPlan(projectDir: string): Promise<TuningPatchPlanDocument> {
    const patchPlanPath = path.join(projectDir, ".agent-workflow", "tuning", "patches", "patch-plan.json");
    const raw = await fs.readFile(patchPlanPath, "utf8");
    const parsed = JSON.parse(raw) as TuningPatchPlanDocument;
    if (parsed.kind !== "agentflow_tuning_patch_plan" || !Array.isArray(parsed.patches)) {
      throw new Error(`Invalid tuning patch plan: ${patchPlanPath}`);
    }
    return parsed;
  }

  async function recordLearningApplicationPlanReceipts(projectDir: string, plan: LearningApplicationPlan, actor: string, note: string, status: Extract<LearningActionReceiptStatus, "planned" | "applied"> = "planned"): Promise<LearningActionReceiptLog> {
    const existing = await readLearningActionReceipts(projectDir).catch(() => emptyLearningActionReceipts(projectDir));
    const receipts = appendLearningApplicationPlanReceipts(existing, plan, actor, note, status);
    await writeLearningActionReceipts(projectDir, receipts);
    return receipts;
  }

  function resolveAgentPromotionSourcePath(projectDir: string, item: AgentImprovementPromotionItem): string {
    const baseDir = item.scope === "shared" ? ctx.rootDir : projectDir;
    const resolved = path.resolve(baseDir, item.sourcePath);
    const base = path.resolve(baseDir);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
      throw new Error(`Refusing to apply agent improvement outside ${item.scope} root: ${item.sourcePath}`);
    }
    return resolved;
  }

  async function runLearningDaemonMcpCleanup(projectDir: string): Promise<RuntimeMcpCleanupResult> {
    const config = runtimeMcpCleanupConfig();
    const result = await cleanupRuntimeMcpProcesses(ctx, {
      execute: config.enabled && config.mode === "auto-low-risk",
      autoLowRiskOnly: true,
      staleMinutes: config.staleMinutes
    });
    await writeLearningDaemonMcpCleanupReceipt(ctx.rootDir, projectDir, config, result);
    return result;
  }

  async function runLearningDaemonStaleRunReconciliation(projectDir: string): Promise<RuntimeStaleRunReconciliationResult> {
    const config = staleRunReconcileConfig();
    const result = await reconcileStaleTerminalWorkflowRuns({
      execute: config.enabled,
      limit: config.limit,
      actor: "learning-daemon"
    });
    await writeLearningDaemonStaleRunReconciliationReceipt(ctx.rootDir, projectDir, config, result);
    return result;
  }

  async function runLearningDaemonTick(input: {
    projectDir: string;
    mode: LearningDaemonMode;
    limit: number;
    daemonId?: string;
    approvalAutopilotOverride?: boolean;
    modelComparisonEnabled?: boolean;
    trainingDiscoveryEnabled?: boolean;
  }): Promise<{ report: LearningReport; roadmap: RoadmapSuggestionReport; roadmapPublication: RoadmapSnapshotPublication; proposalSet: LearningProposalSet; approvalQueue: LearningApprovalQueue; applicationPlan: LearningApplicationPlan; workflowShape: WorkflowShapeOptimizationReport | null; modelRoutingOptimizer: ModelRoutingOptimizerReport; modelComparisonSchedule: ModelComparisonSchedule; trainingDiscovery: TrainingDiscoveryReport | null; learningLoopScheduler: LearningLoopSchedulerReceipt | null; agentImprovement: AgentImprovementReport; agentImprovementPatchPlan: AgentImprovementPatchPlan; agentImprovementEvalPlan: AgentImprovementEvalPlan; agentImprovementPromotionQueue: AgentImprovementPromotionQueue; agentImprovementApply: AgentImprovementApplyResult; workflowShapeAutoUpdate: boolean; agentImprovementProjectLocalAutoApply: boolean; autonomousApplyMaxRisk: LearningRiskLevel; autonomousApplication: LearningAutonomousApplicationResult; approvalAutopilotEnabled: boolean; approvalAutopilotMaxRisk: ApprovalAutopilotRisk; approvalAutopilot: ApprovalAutopilotResult; approvalBacklog: ApprovalBacklogReport; repositoryMaintenance: RepositoryMaintenanceReport }> {
    const approvalAutopilotEnabled = input.approvalAutopilotOverride ?? await learningApprovalAutopilotEnabled(input.projectDir);
    const approvalAutopilotMaxRisk = await learningApprovalAutopilotMaxRisk(input.projectDir);
    let approvalAutopilot: ApprovalAutopilotResult = emptyApprovalAutopilotResult(approvalAutopilotMaxRisk);
    if (input.mode === "apply-approved" && approvalAutopilotEnabled) {
      await dismissDuplicateBlockedWorkflowRuns(input.projectDir, input.daemonId ?? "learning-daemon");
      approvalAutopilot = await runApprovalAutopilot(ctx, {
        projectRootUri: input.projectDir,
        limit: 100,
        maxRisk: approvalAutopilotMaxRisk,
        execute: true,
        actor: input.daemonId ?? "learning-daemon",
        actorRole: "approver"
      });
    }
    const repositoryMaintenance = await scanRepositoryMaintenance(input.projectDir);
    await writeRepositoryMaintenanceReceipt(input.projectDir, repositoryMaintenance);
    const trainingDiscovery = input.trainingDiscoveryEnabled === false
      ? null
      : await runTrainingDiscovery({
        projectDir: input.projectDir,
        agents: (await loadAgents(ctx.rootDir)).map((agent) => agent.id),
        daemonLanes: daemonLanes.map((lane) => lane.id),
        cadenceMs: parsePositiveInteger(process.env.AGENTFLOW_TRAINING_DISCOVERY_INTERVAL_MS ?? "", 86_400_000)
      });
    let learningLoopScheduler: LearningLoopSchedulerReceipt | null = null;
    if (envFlagEnabled(process.env.AGENTFLOW_LEARNING_LOOP_AUTO_RUN)) {
      learningLoopScheduler = await runDaemonLearningLoopSchedule({ projectDir: input.projectDir, definitionsRoot: ctx.rootDir });
    }
    const report = await loadLearningReport({ projectDir: input.projectDir, limit: input.limit });
    const modelRoutingOptimizer = await runModelRoutingOptimizer({ projectDir: input.projectDir, suites: await loadDashboardEvaluations(250, input.projectDir), autoUpdate: input.mode === "apply-approved" && envFlagEnabled(process.env.AGENTFLOW_MODEL_ROUTING_AUTO_UPDATE) });
    const modelComparisonSchedule = await prepareRecurringModelComparison({
      projectDir: input.projectDir,
      enabled: input.modelComparisonEnabled !== false
        && input.mode === "apply-approved"
        && envFlagEnabled(process.env.AGENTFLOW_MODEL_COMPARISON_AUTO_RUN),
      intervalMs: parsePositiveInteger(process.env.AGENTFLOW_MODEL_COMPARISON_INTERVAL_MS ?? "", 86400000)
    });
    if (modelComparisonSchedule.due) {
      const logFd = fsSync.openSync(path.join(input.projectDir, ".agent-workflow", "learning", "model-comparison.log"), "a");
      const child = spawn("npm", ["run", "agentflow", "--", "evaluate", "--suite", modelComparisonSchedule.suitePath, "--project", input.projectDir, "--skip-index", "--worker-limit", "2", "--worker-concurrency", "1"], {
        cwd: ctx.rootDir,
        env: process.env,
        detached: true,
        stdio: ["ignore", logFd, logFd]
      });
      child.unref();
      fsSync.closeSync(logFd);
    }
    const roadmap = await loadAndWriteRoadmapSuggestions(input.projectDir);
    const roadmapPublication = await publishRoadmapSnapshotIfChanged(input.projectDir, input.daemonId ?? "learning-daemon").catch((error) => ({
      status: "unavailable" as const,
      projectId: "",
      source: roadmap.roadmapPath,
      digest: "",
      sourceModifiedAt: null,
      publishedAt: new Date().toISOString(),
      reason: `Roadmap snapshot publication is unavailable: ${error instanceof Error ? error.message : String(error)}`
    }));
    const proposalSet = buildLearningProposalSet(report);
    const existingQueue = await readLearningApprovalQueue(input.projectDir).catch(() => undefined);
    const autonomousApplyMaxRisk = await learningAutonomousApplyMaxRisk(input.projectDir);
    const approvalQueue = buildLearningApprovalQueue(proposalSet, "all", existingQueue, autonomousApplyMaxRisk);
    const applicationPlan = buildGovernedLearningApplicationPlan(approvalQueue, "all");
    const workflowShapeAutoUpdate = await learningWorkflowShapeAutoUpdateEnabled(input.projectDir);
    const agentImprovementProjectLocalAutoApply = await learningAgentImprovementProjectLocalAutoApplyEnabled(input.projectDir);
    const workflowShape = workflowShapeAutoUpdate
      ? await loadWorkflowShapeOptimization(ctx, { projectDir: input.projectDir, limit: input.limit })
      : null;
    const agentImprovement = await loadAgentImprovementReport(ctx, {
      projectDir: input.projectDir,
      limit: input.limit,
      mode: "write-owned-learning-state"
    });
    const agentImprovementPatchPlan = await buildAgentImprovementPatchPlan(ctx, input.projectDir, agentImprovement, "all");
    const agentImprovementEvalPlan = await buildAgentImprovementEvalPlan(ctx, input.projectDir, agentImprovementPatchPlan, "all", input.limit);
    const existingAgentPromotionQueue = await readAgentImprovementPromotionQueue(input.projectDir).catch(() => undefined);
    let agentImprovementPromotionQueue = buildAgentImprovementPromotionQueue(input.projectDir, agentImprovementPatchPlan, agentImprovementEvalPlan, "all", existingAgentPromotionQueue);
    let autonomousApplication = emptyLearningAutonomousApplicationResult(input.projectDir);
    report.failureTriage = await runLearningFailureTriage({
      projectDir: input.projectDir,
      failedRuns: report.failedRuns,
      mode: input.mode,
      maxRisk: autonomousApplyMaxRisk
    });
    await writeLearningReport(input.projectDir, report);
    if (workflowShape) {
      await writeWorkflowShapeOptimization(input.projectDir, workflowShape);
    }
    await writeAgentImprovementReport(input.projectDir, agentImprovement);
    await writeAgentImprovementPatchPlan(input.projectDir, agentImprovementPatchPlan);
    await writeAgentImprovementEvalPlan(input.projectDir, agentImprovementEvalPlan);
    await writeAgentImprovementPromotionQueue(input.projectDir, agentImprovementPromotionQueue);
    let agentImprovementApply = await applyAgentImprovementPromotions({
      projectDir: input.projectDir,
      queue: agentImprovementPromotionQueue,
      ids: "all",
      maxRisk: autonomousApplyMaxRisk,
      actor: input.daemonId ?? "learning-daemon",
      note: agentImprovementProjectLocalAutoApply
        ? "Daemon applied auto-ready project-local agent-improvement promotions within the configured autonomy risk threshold."
        : "Daemon inspected agent-improvement promotions; project-local auto-apply is disabled.",
      write: input.mode === "apply-approved" && agentImprovementProjectLocalAutoApply,
      mode: "project-local-auto"
    });
    agentImprovementPromotionQueue = agentImprovementApply.queue;
    if (input.mode === "propose" || input.mode === "apply-approved") {
      await writeLearningProposals(input.projectDir, proposalSet);
      await writeLearningApprovalQueue(input.projectDir, approvalQueue);
    }
    if (input.mode === "apply-approved") {
      await writeLearningApplicationPlan(input.projectDir, applicationPlan);
      await recordLearningApplicationPlanReceipts(input.projectDir, applicationPlan, "learning-daemon", "apply-approved planning tick");
      autonomousApplication = await applyAutonomousLearningApplicationPlan(input.projectDir, applicationPlan);
      if (approvalAutopilotEnabled) {
        const maintenanceFiles = approvalAutopilot.items.filter((item) => item.status === "executed" && item.actionType === "file_write").map((item) => item.target);
        const validationCommand = process.env.AGENTFLOW_DAEMON_MAINTENANCE_VALIDATION_COMMAND?.trim();
        if (maintenanceFiles.length && envFlagEnabled(process.env.AGENTFLOW_DAEMON_MAINTENANCE_COMMITS) && validationCommand) {
          const project = await loadProjectConfig(input.projectDir);
          const validation = await executeAllowedCommand({ commandLine: validationCommand, cwd: input.projectDir, project });
          if (validation.exitCode === 0 && !validation.timedOut) {
            const committed = await commitRepositoryMaintenance({ projectRoot: input.projectDir, files: maintenanceFiles, validation: `${validationCommand} passed`, message: "chore: apply daemon repository maintenance" });
            if (committed) await writeRepositoryMaintenanceReceipt(input.projectDir, await scanRepositoryMaintenance(input.projectDir), committed.applied, { hash: committed.hash, message: committed.message });
          }
        }
      }
      if (autonomousApplication.appliedActions > 0) {
        await recordLearningApplicationPlanReceipts(input.projectDir, filterAppliedLearningApplicationPlan(applicationPlan), "learning-daemon", "autonomous local apply tick", "applied");
      }
    }
    const approvalBacklog = await buildApprovalBacklogReport(ctx, { projectRootUri: input.projectDir, limit: 500, staleMinutes: 60 });
    const optimizerEvents = [
      ...report.failedRuns.map(run => ({ id: `run-failed:${run.runId}`, kind: "evaluation.failed" as const, projectId: input.projectDir, occurredAt: run.startedAt })),
      ...(report.routeFeedback.latestAt ? [{ id: `feedback:${report.routeFeedback.latestAt}`, kind: "feedback.created" as const, projectId: input.projectDir, occurredAt: report.routeFeedback.latestAt }] : []),
      ...(report.latestEvaluationAt ? [{ id: `evaluation:${report.latestEvaluationAt}`, kind: "run.completed" as const, projectId: input.projectDir, occurredAt: report.latestEvaluationAt }] : []),
      ...(approvalBacklog.severityCounts.warning || approvalBacklog.severityCounts.error ? [{ id: `approval-backlog:${report.generatedAt}`, kind: "approval.stale" as const, projectId: input.projectDir, occurredAt: report.generatedAt }] : []),
      ...report.costOpportunities.filter(item => item.fallbackRate >= 0.5).map(item => ({ id: `provider-degraded:${item.providerId}:${item.workflowId}:${item.stageId}`, kind: "provider.degraded" as const, projectId: input.projectDir, occurredAt: report.generatedAt }))
    ];
    await runOptimizerCycle({
      projectDir: input.projectDir,
      events: optimizerEvents,
      recommendations: workflowShape?.recommendations.slice(0, 50).map((item, index) => ({ id: `workflow-shape:${index}:${report.generatedAt}`, projectId: input.projectDir, kind: "stage" as const, evidence: Math.min(1, report.runsAnalyzed / 10), impact: 0.5, reversibility: 1, risk: "medium" as const, confidence: Math.min(1, report.runsAnalyzed / 5), duplicateKey: JSON.stringify(item) })) ?? []
    });
    return { report, roadmap, roadmapPublication, proposalSet, approvalQueue, applicationPlan, workflowShape, modelRoutingOptimizer, modelComparisonSchedule, trainingDiscovery, learningLoopScheduler, agentImprovement, agentImprovementPatchPlan, agentImprovementEvalPlan, agentImprovementPromotionQueue, agentImprovementApply, workflowShapeAutoUpdate, agentImprovementProjectLocalAutoApply, autonomousApplyMaxRisk, autonomousApplication, approvalAutopilotEnabled, approvalAutopilotMaxRisk, approvalAutopilot, approvalBacklog, repositoryMaintenance };
  }

  async function runLearningFailureTriage(input: {
    projectDir: string;
    failedRuns: LearningReport["failedRuns"];
    mode: LearningDaemonMode;
    maxRisk: LearningRiskLevel;
  }): Promise<LearningFailureTriageReport> {
    const generatedAt = new Date().toISOString();
    const learningDir = path.join(input.projectDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(input.projectDir, learningDir, ".agent-workflow/learning");
    const statePath = path.join(learningDir, "failure-triage-state.json");
    const state = (await ctx.readJsonFile<{ attemptedRuns?: Record<string, { attemptedAt: string; signature: string }> }>(statePath)) ?? {};
    const attemptedRuns = state.attemptedRuns ?? {};
    const evidence = (await Promise.all(input.failedRuns.map(async (failedRun) => {
      const details = await getWorkflowRunDetails(failedRun.runId);
      if (!details.run) return null;
      const failedTasks = details.tasks.filter((task) => task.status === "failed");
      const decision = classifyFailureForTriage({
        runId: failedRun.runId,
        workflowId: failedRun.workflowId,
        providerId: details.run.providerOverride,
        taskAttempts: Math.max(0, ...failedTasks.map((task) => task.attempts)),
        receipts: details.receipts.map((receipt) => ({ actionType: receipt.actionType, target: receipt.target, summary: receipt.summary }))
      });
      return { failedRun, details, decision };
    }))).filter((item): item is NonNullable<typeof item> => item !== null);

    const grouped = new Map<string, typeof evidence>();
    for (const item of evidence) grouped.set(item.decision.signature, [...(grouped.get(item.decision.signature) ?? []), item]);
    const providerChecks = new Map<string, { ready: boolean; detail: string }>();
    const retriedRuns: string[] = [];
    const withheldRuns: string[] = [];
    const groups: LearningFailureTriageReport["groups"] = [];

    for (const [signature, items] of grouped) {
      const decision = items[0].decision;
      let verificationPassed = false;
      let verificationDetail = "No safe automatic verification is available for this failure class.";
      if (decision.verification === "provider_readiness") {
        const providerId = items[0].details.run?.providerOverride ?? items[0].details.receipts.find((receipt) => receipt.actionType === "model_route_failed")?.target ?? "";
        if (providerId) {
          let check = providerChecks.get(providerId);
          if (!check) {
            try {
              const provider = providerFromEnv(providerId);
              const result = provider.check ? await provider.check() : { ready: true, details: [`${providerId} has no additional readiness check.`] };
              check = { ready: result.ready, detail: result.details.join(" ") };
            } catch (error) {
              check = { ready: false, detail: error instanceof Error ? error.message : String(error) };
            }
            providerChecks.set(providerId, check);
          }
          verificationPassed = check.ready;
          verificationDetail = check.ready ? `${providerId} is ready now. ${check.detail}` : `${providerId} is still unavailable. ${check.detail}`;
        } else {
          verificationDetail = "The failed provider could not be identified from the run snapshot or receipts.";
        }
      }

      const allowed = failureTriageRiskAllowed(decision.risk, input.maxRisk);
      const candidates = items.filter((item) => !attemptedRuns[item.failedRun.runId]);
      let action: LearningFailureTriageReport["groups"][number]["action"] = decision.risk === "high" ? "escalated" : "reported";
      if (input.mode === "apply-approved" && decision.retryAfterVerification && verificationPassed && allowed && candidates.length) {
        for (const item of candidates) {
          const requeued = await retryFailedWorkflowRun(item.failedRun.runId);
          attemptedRuns[item.failedRun.runId] = { attemptedAt: generatedAt, signature };
          if (requeued > 0) retriedRuns.push(item.failedRun.runId);
          else withheldRuns.push(item.failedRun.runId);
        }
        action = retriedRuns.some((runId) => candidates.some((item) => item.failedRun.runId === runId)) ? "retried" : "reported";
      } else {
        withheldRuns.push(...items.map((item) => item.failedRun.runId));
        if (!candidates.length && items.length) {
          action = "retry_failed";
          verificationDetail = `${verificationDetail} A previous autonomous retry returned to failed state, so the loop guard withheld another retry and escalated the diagnosis.`;
        }
      }
      groups.push({
        signature,
        category: decision.category,
        diagnosis: decision.diagnosis,
        risk: decision.risk,
        runIds: items.map((item) => item.failedRun.runId),
        verification: decision.verification,
        verificationPassed,
        action,
        detail: `${verificationDetail} ${allowed ? `Risk ${decision.risk} is within the configured ${input.maxRisk} threshold.` : `Risk ${decision.risk} exceeds the configured ${input.maxRisk} threshold.`}`
      });
    }

    const report: LearningFailureTriageReport = {
      kind: "agentflow_learning_failure_triage",
      generatedAt,
      projectRootUri: input.projectDir,
      observation: input.failedRuns.length
        ? groups.some((group) => group.action === "retry_failed")
          ? `I found ${input.failedRuns.length} failed workflow run${input.failedRuns.length === 1 ? "" : "s"}. A bounded retry did not recover the affected run, so I stopped retrying and escalated the diagnosis with evidence.`
          : `I found ${input.failedRuns.length} failed workflow run${input.failedRuns.length === 1 ? "" : "s"} in this project, grouped them into ${groups.length} likely root cause${groups.length === 1 ? "" : "s"}, and safely requeued ${retriedRuns.length}.`
        : "I did not find any failed workflow runs in the inspected window.",
      failedRuns: input.failedRuns.length,
      groups,
      retriedRuns,
      withheldRuns: [...new Set(withheldRuns)]
    };
    await fs.writeFile(statePath, `${JSON.stringify({ kind: "agentflow_learning_failure_triage_state", updatedAt: generatedAt, attemptedRuns }, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(learningDir, "failure-triage.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(learningDir, "failure-triage.md"), formatLearningFailureTriage(report), "utf8");
    return report;
  }

  async function writeAgentImprovementApplyReceipts(projectDir: string, receipts: AgentImprovementApplyReceiptLog): Promise<void> {
    const learningDir = path.join(projectDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
    await fs.writeFile(path.join(learningDir, "agent-improvement-apply-receipts.json"), `${JSON.stringify(receipts, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(learningDir, "agent-improvement-apply-receipts.md"), formatAgentImprovementApplyReceiptsMarkdown(receipts), "utf8");
  }

  async function writeAgentImprovementEvalPlan(projectDir: string, plan: AgentImprovementEvalPlan): Promise<void> {
    const learningDir = path.join(projectDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
    await fs.writeFile(path.join(learningDir, "agent-improvement-evals.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(learningDir, "agent-improvement-evals.md"), formatAgentImprovementEvalPlanMarkdown(plan), "utf8");
  }

  async function writeAgentImprovementPatchPlan(projectDir: string, plan: AgentImprovementPatchPlan): Promise<void> {
    const learningDir = path.join(projectDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
    await fs.writeFile(path.join(learningDir, "agent-improvement-patches.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(learningDir, "agent-improvement-patches.md"), formatAgentImprovementPatchPlanMarkdown(plan), "utf8");
  }

  async function writeAgentImprovementReport(projectDir: string, report: AgentImprovementReport): Promise<void> {
    const learningDir = path.join(projectDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
    await fs.writeFile(path.join(learningDir, "agent-improvement-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(learningDir, "agent-improvement-recommendations.md"), formatAgentImprovementMarkdown(report), "utf8");
  }

  async function writeLearningApplicationPlan(projectDir: string, plan: LearningApplicationPlan): Promise<void> {
    const learningDir = path.join(projectDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
    await fs.writeFile(path.join(learningDir, "application-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(learningDir, "application-plan.md"), formatLearningApplicationPlanMarkdown(plan), "utf8");
  }

  async function writeLearningApprovalQueue(projectDir: string, queue: LearningApprovalQueue): Promise<void> {
    const learningDir = path.join(projectDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
    await fs.writeFile(path.join(learningDir, "approval-inbox.json"), `${JSON.stringify(queue, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(learningDir, "approval-inbox.md"), formatLearningApprovalQueueMarkdown(queue), "utf8");
  }

  async function writeLearningAutonomousApplicationResult(projectDir: string, result: LearningAutonomousApplicationResult): Promise<void> {
    const learningDir = path.join(projectDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
    await fs.writeFile(path.join(learningDir, "autonomous-application.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(learningDir, "autonomous-application.md"), formatLearningAutonomousApplicationResult(result), "utf8");
  }

  async function writeLearningDaemonMcpCleanupReceipt(
    stateRootDir: string,
    projectDir: string,
    config: RuntimeMonitorReport["mcpCleanup"]["autoCleanup"],
    result: RuntimeMcpCleanupResult
  ): Promise<void> {
    const learningDir = path.join(stateRootDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(stateRootDir, learningDir, ".agent-workflow/learning");
    const receipt = {
      kind: "agentflow_learning_daemon_mcp_cleanup_receipt",
      generatedAt: result.generatedAt,
      projectRootUri: projectDir,
      config,
      candidates: result.candidates.map((candidate) => ({
        pid: candidate.pid,
        parentPid: candidate.parentPid,
        sessionKey: candidate.sessionKey,
        risk: candidate.risk,
        autoCleanable: candidate.autoCleanable,
        ageMs: candidate.ageMs,
        startedAt: candidate.startedAt,
        reason: candidate.reason
      })),
      terminated: result.terminated,
      warnings: result.warnings
    };
    await fs.writeFile(path.join(learningDir, "mcp-cleanup-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(learningDir, "mcp-cleanup-receipt.md"), formatLearningDaemonMcpCleanupReceipt(receipt), "utf8");
  }

  async function writeLearningDaemonStaleRunReconciliationReceipt(
    stateRootDir: string,
    projectDir: string,
    config: RuntimeMonitorReport["staleRuns"]["autoReconcile"],
    result: RuntimeStaleRunReconciliationResult
  ): Promise<void> {
    const learningDir = path.join(stateRootDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(stateRootDir, learningDir, ".agent-workflow/learning");
    const receipt = {
      kind: "agentflow_learning_daemon_stale_run_reconciliation_receipt",
      generatedAt: result.generatedAt,
      projectRootUri: projectDir,
      config,
      mode: result.mode,
      candidates: result.candidates.map((candidate) => ({
        runId: candidate.runId,
        workflowId: candidate.workflowId,
        runStatus: candidate.runStatus,
        recommendedStatus: candidate.recommendedStatus,
        totalTasks: candidate.totalTasks,
        completedTasks: candidate.completedTasks,
        cancelledTasks: candidate.cancelledTasks,
        startedAt: candidate.startedAt,
        task: candidate.task
      })),
      reconciled: result.reconciled
    };
    await fs.writeFile(path.join(learningDir, "stale-run-reconciliation-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(learningDir, "stale-run-reconciliation-receipt.md"), formatLearningDaemonStaleRunReconciliationReceipt(receipt), "utf8");
  }

  async function writeLearningDaemonStatus(projectDir: string, status: LearningDaemonHeartbeat, heartbeatFile: string): Promise<void> {
    const learningDir = path.join(projectDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
    const resolvedHeartbeat = path.resolve(heartbeatFile);
    const projectRoot = path.resolve(projectDir);
    if (!resolvedHeartbeat.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write learning daemon status outside project: ${heartbeatFile}`);
    }
    await fs.mkdir(path.dirname(resolvedHeartbeat), { recursive: true });
    await fs.writeFile(resolvedHeartbeat, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  }

  async function writeLearningProposals(projectDir: string, proposalSet: LearningProposalSet): Promise<void> {
    await writeLearningProposalFiles(projectDir, proposalSet);
  }

  async function writeLearningReport(projectDir: string, report: LearningReport): Promise<void> {
    const reportsDir = path.join(projectDir, ".agent-workflow", "learning", "reports");
    await ensureProjectSubdir(projectDir, reportsDir, ".agent-workflow/learning/reports");
    await fs.writeFile(path.join(reportsDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(reportsDir, "latest.md"), `${formatLearningReport(report)}\n`, "utf8");
  }

  async function writePromotionRoutingNotePlan(projectDir: string, plan: DashboardPromotionRoutingNotePlan): Promise<void> {
    for (const file of plan.files) {
      if (!file.relativePath.startsWith(".agent-workflow/tuning/")) {
        throw new Error(`Refusing to write promotion routing note plan outside .agent-workflow/tuning: ${file.relativePath}`);
      }
      const targetPath = path.resolve(projectDir, file.relativePath);
      const projectRoot = path.resolve(projectDir);
      if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
        throw new Error(`Refusing to write promotion routing note plan outside project: ${file.relativePath}`);
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, file.content, "utf8");
    }
  }

  async function writeTuningApplicationPlan(projectDir: string, plan: TuningApplicationPlan): Promise<void> {
    for (const file of plan.files) {
      if (!file.relativePath.startsWith(".agent-workflow/tuning/")) {
        throw new Error(`Refusing to write tuning overlay outside .agent-workflow/tuning: ${file.relativePath}`);
      }
      const targetPath = path.resolve(projectDir, file.relativePath);
      const projectRoot = path.resolve(projectDir);
      if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
        throw new Error(`Refusing to write tuning overlay outside project: ${file.relativePath}`);
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, file.content, "utf8");
    }
  }

  async function writeTuningApprovalQueue(projectDir: string, queue: TuningApprovalQueue): Promise<void> {
    const tuningDir = path.join(projectDir, ".agent-workflow", "tuning");
    await fs.mkdir(tuningDir, { recursive: true });
    await fs.writeFile(path.join(tuningDir, "approval-queue.json"), `${JSON.stringify(queue, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(tuningDir, "approval-queue.md"), formatTuningApprovalQueueMarkdown(queue), "utf8");
  }

  async function writeTuningPatchPlan(projectDir: string, plan: TuningPatchPlan): Promise<void> {
    for (const file of plan.files) {
      if (!file.relativePath.startsWith(".agent-workflow/tuning/patches/")) {
        throw new Error(`Refusing to write tuning patch plan outside .agent-workflow/tuning/patches: ${file.relativePath}`);
      }
      const targetPath = path.resolve(projectDir, file.relativePath);
      const projectRoot = path.resolve(projectDir);
      if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
        throw new Error(`Refusing to write tuning patch plan outside project: ${file.relativePath}`);
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, file.content, "utf8");
    }
  }

  async function writeWorkflowShapeOptimization(projectDir: string, report: WorkflowShapeOptimizationReport): Promise<void> {
    const learningDir = path.join(projectDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
    await fs.writeFile(path.join(learningDir, "workflow-shape-proposals.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(learningDir, "stage-recommendations.md"), formatWorkflowShapeOptimizationMarkdown(report), "utf8");
  }

  // Outcome feedback into the scorer (2026-09-28): group promotion receipts by
  // the candidate patternId that produced them and compute a Laplace-smoothed
  // approval rate per pattern. Cold start (no receipts at all, the current
  // reality) yields no map entries, and the candidate builder treats a missing
  // entry as a neutral 0.5 with null evidence. The mechanism ships, but weight
  // influence stays modest until real owner decisions accumulate.

  program
    .command("feedback")
    .description("Record accepted, revised, or rejected feedback for a workflow run")
    .requiredOption("-r, --run <id>", "workflow run id")
    .requiredOption("--rating <rating>", "accepted, revised, or rejected")
    .option("--note <text>", "short note explaining what worked or needs to change", "")
    .action(async (options: { run: string; rating: string; note: string }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const result = await recordRunFeedback({
        runId: options.run,
        rating: options.rating,
        note: options.note,
        source: "cli"
      });
      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }

      console.log(`Recorded ${result.rating} feedback for ${options.run}.`);
      console.log(`Artifact: ${result.artifactUri}`);
    });

  program
    .command("feedback-inbox")
    .description("List unreviewed runs grouped by likely feedback decision")
    .option("-p, --project <dir>", "project directory filter")
    .option("-l, --limit <number>", "number of recent finished runs to scan", "50")
    .option("--json", "print JSON")
    .action(async (options: { project?: string; limit: string; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const report = await loadDashboardFeedbackInboxReport({
        projectRootUri: options.project ? path.resolve(process.cwd(), options.project) : undefined,
        limit: parsePositiveInteger(options.limit, 50)
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatFeedbackInboxReport(report));
    });

  program
    .command("preference-scorecard")
    .description("Aggregate feedback, quality, fallback, and routing performance by workflow, stage, agent, provider, and tier")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("-l, --limit <number>", "number of recent project runs to analyze", "25")
    .option("--json", "print scorecard JSON")
    .action(async (options: { project: string; limit: string; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const scorecard = await loadPreferenceScorecard({
        projectDir,
        limit: parsePositiveInteger(options.limit, 25)
      });

      if (options.json) {
        console.log(JSON.stringify(scorecard, null, 2));
        return;
      }

      console.log(formatPreferenceScorecard(scorecard));
    });

  program
    .command("learning-report")
    .description("Read-only local learning report from run history, feedback, failures, routing, and eval evidence")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("-l, --limit <number>", "number of recent project runs to analyze", "50")
    .option("--json", "print learning report JSON")
    .action(async (options: { project: string; limit: string; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const report = await loadLearningReport({
        projectDir: path.resolve(process.cwd(), options.project),
        limit: parsePositiveInteger(options.limit, 50)
      });

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(formatLearningReport(report));
    });

  program
    .command("learning-proposals")
    .description("Generate local learning proposals from the read-only learning report")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--ids <ids>", "comma-separated proposal ids to queue for approval, or all", "all")
    .option("-l, --limit <number>", "number of recent project runs to analyze", "50")
    .option("--write", "write proposal and approval inbox files under .agent-workflow/learning")
    .option("--json", "print learning proposals JSON")
    .action(async (options: { project: string; ids: string; limit: string; write?: boolean; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const report = await loadLearningReport({
        projectDir,
        limit: parsePositiveInteger(options.limit, 50)
      });
      const proposalSet = buildLearningProposalSet(report);
      const existingQueue = await readLearningApprovalQueue(projectDir).catch(() => undefined);
      const queue = buildLearningApprovalQueue(proposalSet, parseProposalIds(options.ids), existingQueue);

      if (options.write) {
        await writeLearningProposals(projectDir, proposalSet);
        await writeLearningApprovalQueue(projectDir, queue);
      }

      if (options.json) {
        console.log(JSON.stringify({ ...proposalSet, approvalQueue: queue, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }

      console.log(formatLearningProposalSet(proposalSet));
      console.log("");
      console.log(formatLearningApprovalQueue(queue));
      if (options.write) {
        console.log("");
        console.log("Wrote .agent-workflow/learning/proposals.json");
        console.log("Wrote .agent-workflow/learning/proposals.md");
        console.log("Wrote .agent-workflow/learning/approval-inbox.json");
        console.log("Wrote .agent-workflow/learning/approval-inbox.md");
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to create the project-local learning proposal inbox.");
      }
    });

  program
    .command("learning-approvals")
    .description("List, approve, or reject project-local learning proposal inbox items")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--approve <ids>", "comma-separated approval ids or proposal ids to approve, or all")
    .option("--reject <ids>", "comma-separated approval ids or proposal ids to reject, or all")
    .option("--reviewer <name>", "reviewer name")
    .option("--note <text>", "decision note")
    .option("--json", "print learning approval queue JSON")
    .action(async (options: { project: string; approve?: string; reject?: string; reviewer?: string; note?: string; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const queue = await readLearningApprovalQueue(projectDir);
      const decisionCount = Number(Boolean(options.approve)) + Number(Boolean(options.reject));
      if (decisionCount > 1) {
        console.error("Use either --approve or --reject, not both.");
        process.exitCode = 1;
        return;
      }

      let nextQueue = queue;
      if (options.approve || options.reject) {
        const result = decideLearningApprovals({
          queue,
          ids: parseProposalIds(options.approve ?? options.reject),
          status: options.approve ? "approved" : "rejected",
          reviewer: options.reviewer,
          note: options.note
        });
        nextQueue = result.queue;
        await writeLearningApprovalQueue(projectDir, nextQueue);
        if (result.skippedIds.length) {
          console.error(`Skipped unknown ids: ${result.skippedIds.join(", ")}`);
        }
      }

      if (options.json) {
        console.log(JSON.stringify(nextQueue, null, 2));
        return;
      }

      console.log(formatLearningApprovalQueue(nextQueue));
    });

  program
    .command("training-discovery")
    .description("Run the governed public-source training scout manually")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--force", "run even when the daily cadence is not due")
    .option("--json", "print training discovery JSON")
    .action(async (options: { project: string; force?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const agents = await loadAgents(ctx.rootDir);
      const report = await runTrainingDiscovery({
        projectDir,
        agents: agents.map((agent) => agent.id),
        daemonLanes: daemonLanes.map((lane) => lane.id),
        cadenceMs: parsePositiveInteger(process.env.AGENTFLOW_TRAINING_DISCOVERY_INTERVAL_MS ?? "", 86_400_000),
        force: options.force
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatTrainingDiscoveryReport(report));
    });

  program
    .command("training-proposals")
    .description("List or decide governed training-discovery proposals")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--id <id>", "proposal id to decide")
    .option("--status <status>", "decision: approved, rejected, stale, unsafe, evaluated, or promoted")
    .option("--reviewer <reviewer>", "reviewer identity", "operator")
    .option("--note <note>", "bounded decision note")
    .option("--json", "print proposal inbox JSON")
    .action(async (options: { project: string; id?: string; status?: string; reviewer: string; note?: string; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const allowed = new Set<TrainingProposalDecisionStatus>(["approved", "rejected", "stale", "unsafe", "evaluated", "promoted"]);
      let inbox = await readTrainingProposalInbox(projectDir);
      if (options.id || options.status) {
        if (!options.id || !options.status || !allowed.has(options.status as TrainingProposalDecisionStatus)) {
          throw new Error("--id and a valid --status are required together");
        }
        inbox = await decideTrainingProposal({
          projectDir,
          id: options.id,
          status: options.status as Exclude<TrainingProposalDecisionStatus, "pending">,
          reviewer: options.reviewer,
          note: options.note
        });
      }
      if (options.json) {
        console.log(JSON.stringify(inbox, null, 2));
        return;
      }
      for (const item of inbox.items) console.log(`${item.status}\t${item.id}\t${item.proposal.publisher}\t${item.proposal.targets.join(",")}`);
      if (!inbox.items.length) console.log("No training proposals.");
    });

  registerLearningLoopCommand(program, ctx.rootDir);

  program
    .command("training-holdout")
    .description("Run a blinded baseline/candidate holdout for one approved training proposal")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("--proposal <id>", "approved training proposal id")
    .requiredOption("--design <file>", "project-local holdout design JSON")
    .option("--provider <id>", "provider adapter; defaults to the configured provider")
    .option("--target <id>", "run only one declared target (useful for resuming missing coverage)")
    .option("--concurrency <number>", "parallel target/arm batches", "2")
    .option("--write", "write the private project-local evidence report")
    .option("--json", "print report JSON")
    .action(async (options: { project: string; proposal: string; design: string; provider?: string; target?: string; concurrency: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const designPath = path.resolve(projectDir, options.design);
      const design = JSON.parse(await fs.readFile(designPath, "utf8")) as TrainingHoldoutDesign;
      if (design.proposal !== options.proposal) throw new Error(`Holdout design ${design.proposal} does not match ${options.proposal}.`);
      const inbox = await readTrainingProposalInbox(projectDir);
      const proposal = inbox.items.find((item) => item.id === options.proposal);
      if (!proposal || !["approved", "evaluated"].includes(proposal.status)) throw new Error("Training holdouts require an approved or previously evaluated proposal.");
      const agents = await loadAgentsForProject(ctx, projectDir);
      const knownAgentIds = new Set(agents.map((agent) => agent.id));
      const daemonAgents: AgentCard[] = daemonLanes.filter((lane) => design.targets.includes(lane.id) && !knownAgentIds.has(lane.id)).map((lane) => ({
        id: lane.id, display_name: lane.name, category: "automatic", purpose: lane.purpose, model_strategy: "provider-agnostic", model_tier: "standard", autonomy: 1,
        use_when: [], avoid_when: [], can: lane.capabilities, cannot: ["mutate during holdout evaluation"], requires_approval: [], context_budget: { max_tokens: 2500, preferred_sources: [] }, outputs: { schema: "structured_summary" },
        prompt: `${lane.purpose} Evaluate only the supplied synthetic evidence. Keep provider-specific controls scoped to their provider, distinguish missing evidence from findings, and request no side effects.`
      }));
      const selectedDesign = options.target ? { ...design, targets: design.targets.filter((target) => target === options.target) } : design;
      if (options.target && selectedDesign.targets.length === 0) throw new Error(`Target ${options.target} is not declared by this holdout design.`);
      const candidateContext = [
        `Publisher: ${proposal.proposal.publisher}`,
        `Official source: ${proposal.proposal.url}`,
        `Claimed benefit: ${proposal.proposal.claimedBenefit}`,
        `Known risks and scope limit: ${proposal.proposal.risks}`,
        `Required holdout: ${proposal.proposal.holdoutEvaluation}`,
        "Use these concepts only when supported by the synthetic case evidence. Never invent provider controls or facts."
      ].join("\n");
      const report = await runTrainingHoldout({ design: selectedDesign, candidateContext, agents: [...agents, ...daemonAgents], projectConfig: await loadProjectConfig(projectDir), projectRootUri: projectDir, provider: providerFromEnv(options.provider), concurrency: parseBoundedPositiveInteger(options.concurrency, 2, 8) });
      if (options.write) {
        const outDir = path.join(projectDir, ".agent-workflow", "evaluations", options.proposal.replace(/[^a-zA-Z0-9._-]+/gu, "-"));
        await fs.mkdir(outDir, { recursive: true });
        const reportName = options.target ? `measured-holdout-${options.target}.json` : "measured-holdout.json";
        await fs.writeFile(path.join(outDir, reportName), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      }
      console.log(options.json ? JSON.stringify(report, null, 2) : [`Training holdout: ${report.verdict}`, `Coverage: ${report.measuredObservations}/${report.plannedObservations}`, `Candidate passed: ${report.metrics.candidatePassed}`, ...report.failures.map((failure) => `- ${failure}`)].join("\n"));
      if (report.verdict === "FAIL") process.exitCode = 2;
    });

  program
    .command("learning-daemon")
    .description("Run the local learning daemon in autonomous apply-approved mode, or observe/propose modes")
    .option("-p, --project <dir>", "project directory")
    .option("--all-projects", "iterate all registered local projects and write each project-local learning heartbeat")
    .option("--mode <mode>", "daemon mode: apply-approved, propose, or observe", "apply-approved")
    .option("--once", "run a single daemon tick and exit")
    .option("-l, --limit <number>", "number of recent project runs to analyze", "50")
    .option("--interval-ms <number>", "watch polling interval in milliseconds", "60000")
    .option("--offline-sync-interval-ms <number>", "minimum interval between daemon-triggered offline sync dry runs", "900000")
    .option("--offline-sync-execute", "allow daemon-triggered offline sync to execute insert-only reconciliation when ready")
    .option("--disable-offline-sync", "disable daemon-triggered offline sync dry-run checks")
    .option("--approval-autopilot", "auto approve and execute eligible low/medium pending or already-approved approvals each tick")
    .option("--disable-approval-autopilot", "disable daemon approval autopilot even when project settings enable it")
    .option("--daemon-id <id>", "stable daemon identity for dashboard visibility")
    .option("--heartbeat-file <path>", "learning daemon heartbeat file path")
    .option("--json", "print final daemon status JSON")
    .action(async (options: { project?: string; allProjects?: boolean; mode: string; once?: boolean; limit: string; intervalMs: string; offlineSyncIntervalMs: string; offlineSyncExecute?: boolean; disableOfflineSync?: boolean; approvalAutopilot?: boolean; disableApprovalAutopilot?: boolean; daemonId?: string; heartbeatFile?: string; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project ?? ctx.rootDir);
      const allProjects = options.allProjects === true;
      if (!allProjects && !options.project) {
        console.error("Provide --project <dir> or use --all-projects.");
        process.exitCode = 1;
        return;
      }
      const mode = parseLearningDaemonMode(options.mode);
      const limit = parsePositiveInteger(options.limit, 50);
      const intervalMs = parsePositiveInteger(options.intervalMs, 60000);
      if (intervalMs < 1000) {
        console.error("--interval-ms must be >= 1000");
        process.exitCode = 1;
        return;
      }
      const offlineSyncIntervalMs = parsePositiveInteger(options.offlineSyncIntervalMs, 900000);
      const offlineSyncExecute = options.offlineSyncExecute || envFlagEnabled(process.env.AGENTFLOW_OFFLINE_SYNC_AUTO_EXECUTE);
      const daemonId = normalizeWorkerId(options.daemonId) ?? "learning-daemon";
      const approvalAutopilotOverride = options.disableApprovalAutopilot ? false : options.approvalAutopilot ? true : undefined;
      const heartbeatFile = path.resolve(process.cwd(), options.heartbeatFile ?? path.join(projectDir, ".agent-workflow", "learning", "daemon-status.json"));
      const startedAt = new Date().toISOString();
      let stop = false;
      let ticks = 0;
      let lastStatus: LearningDaemonHeartbeat | null = null;
      const writeStatus = async (
        status: LearningDaemonHeartbeat["status"],
        update?: Awaited<ReturnType<typeof runLearningDaemonTick>>,
        lastError?: string,
        statusProjectDir = projectDir,
        aggregate?: {
          proposals?: number;
          inboxItems?: number;
          applicationActions?: number;
          autonomousAppliedActions?: number;
          agentImprovementCandidates?: number;
          agentImprovementPatchPreviews?: number;
          agentImprovementEvalPasses?: number;
          agentImprovementPromotions?: number;
          agentImprovementPromotionPending?: number;
          agentImprovementApplied?: number;
          agentImprovementApplySkipped?: number;
          workflowShapeRecommendations?: number;
          roadmapOpenItems?: number;
          roadmapSuggestions?: number;
          approvalAutopilotEnabled?: boolean;
          approvalAutopilotMaxRisk?: ApprovalAutopilotRisk;
          approvalAutopilotExecuted?: number;
          approvalAutopilotSkipped?: number;
          approvalBacklogWarnings?: number;
          approvalBacklogErrors?: number;
          approvalBacklogScanned?: number;
          mcpCleanup?: RuntimeMcpCleanupResult;
          staleRunReconciliation?: RuntimeStaleRunReconciliationResult;
          trainingDiscovery?: TrainingDiscoveryReport | null;
        }
      ): Promise<LearningDaemonHeartbeat> => {
        const latestTrainingDiscovery = aggregate?.trainingDiscovery
          ?? update?.trainingDiscovery
          ?? await readLatestTrainingDiscoveryReport(statusProjectDir)
          ?? await readLatestTrainingDiscoveryReport(projectDir);
        const heartbeat: LearningDaemonHeartbeat = {
          ...await ctx.runtimeVersionMetadata,
          kind: "agentflow_learning_daemon_status",
          pid: process.pid,
          daemonId,
          projectRootUri: statusProjectDir,
          scope: allProjects ? "all-projects" : "project",
          mode,
          status,
          startedAt,
          lastHeartbeatAt: new Date().toISOString(),
          lastReportAt: update?.report.generatedAt ?? lastStatus?.lastReportAt ?? null,
          intervalMs,
          limit,
          ticks,
          proposals: aggregate?.proposals ?? update?.proposalSet.proposals.length ?? lastStatus?.proposals ?? 0,
          roadmapPath: update?.roadmap.roadmapPath ?? lastStatus?.roadmapPath,
          roadmapStatus: update?.roadmap.status ?? lastStatus?.roadmapStatus,
          roadmapOpenItems: aggregate?.roadmapOpenItems ?? update?.roadmap.openItems ?? lastStatus?.roadmapOpenItems ?? 0,
          roadmapSuggestions: aggregate?.roadmapSuggestions ?? update?.roadmap.suggestions.length ?? lastStatus?.roadmapSuggestions ?? 0,
          roadmapSnapshotStatus: update?.roadmapPublication.status ?? lastStatus?.roadmapSnapshotStatus,
          roadmapSnapshotPublishedAt: update?.roadmapPublication.publishedAt ?? lastStatus?.roadmapSnapshotPublishedAt ?? null,
          roadmapSnapshotDigest: update?.roadmapPublication.digest ?? lastStatus?.roadmapSnapshotDigest,
          inboxItems: aggregate?.inboxItems ?? update?.approvalQueue.items.length ?? lastStatus?.inboxItems ?? 0,
          applicationActions: aggregate?.applicationActions ?? update?.applicationPlan?.actions.length ?? lastStatus?.applicationActions ?? 0,
          autonomousAppliedActions: aggregate?.autonomousAppliedActions ?? update?.autonomousApplication.appliedActions ?? lastStatus?.autonomousAppliedActions ?? 0,
          autonomousApplyMaxRisk: update?.autonomousApplyMaxRisk ?? await learningAutonomousApplyMaxRisk(statusProjectDir),
          agentImprovementCandidates: aggregate?.agentImprovementCandidates ?? update?.agentImprovement.candidates.length ?? lastStatus?.agentImprovementCandidates ?? 0,
          agentImprovementPatchPreviews: aggregate?.agentImprovementPatchPreviews ?? update?.agentImprovementPatchPlan.patches.length ?? lastStatus?.agentImprovementPatchPreviews ?? 0,
          agentImprovementEvalPasses: aggregate?.agentImprovementEvalPasses ?? update?.agentImprovementEvalPlan.evaluations.filter((item) => item.status === "pass").length ?? lastStatus?.agentImprovementEvalPasses ?? 0,
          agentImprovementPromotions: aggregate?.agentImprovementPromotions ?? update?.agentImprovementPromotionQueue.items.length ?? lastStatus?.agentImprovementPromotions ?? 0,
          agentImprovementPromotionPending: aggregate?.agentImprovementPromotionPending ?? update?.agentImprovementPromotionQueue.items.filter((item) => item.status === "pending").length ?? lastStatus?.agentImprovementPromotionPending ?? 0,
          agentImprovementApplied: aggregate?.agentImprovementApplied ?? update?.agentImprovementApply.appliedIds.length ?? lastStatus?.agentImprovementApplied ?? 0,
          agentImprovementApplySkipped: aggregate?.agentImprovementApplySkipped ?? update?.agentImprovementApply.skippedIds.length ?? lastStatus?.agentImprovementApplySkipped ?? 0,
          workflowShapeRecommendations: aggregate?.workflowShapeRecommendations ?? update?.workflowShape?.recommendations.length ?? lastStatus?.workflowShapeRecommendations ?? 0,
          workflowShapeAutoUpdate: update?.workflowShapeAutoUpdate ?? await learningWorkflowShapeAutoUpdateEnabled(statusProjectDir),
          approvalAutopilotEnabled: aggregate?.approvalAutopilotEnabled ?? update?.approvalAutopilotEnabled ?? await learningApprovalAutopilotEnabled(statusProjectDir),
          approvalAutopilotMaxRisk: aggregate?.approvalAutopilotMaxRisk ?? update?.approvalAutopilotMaxRisk ?? await learningApprovalAutopilotMaxRisk(statusProjectDir),
          approvalAutopilotExecuted: aggregate?.approvalAutopilotExecuted ?? update?.approvalAutopilot.executed ?? lastStatus?.approvalAutopilotExecuted ?? 0,
          approvalAutopilotSkipped: aggregate?.approvalAutopilotSkipped ?? update?.approvalAutopilot.skipped ?? lastStatus?.approvalAutopilotSkipped ?? 0,
          approvalBacklogWarnings: aggregate?.approvalBacklogWarnings ?? update?.approvalBacklog.severityCounts.warning ?? lastStatus?.approvalBacklogWarnings ?? 0,
          approvalBacklogErrors: aggregate?.approvalBacklogErrors ?? update?.approvalBacklog.severityCounts.error ?? lastStatus?.approvalBacklogErrors ?? 0,
          approvalBacklogScanned: aggregate?.approvalBacklogScanned ?? update?.approvalBacklog.scanned ?? lastStatus?.approvalBacklogScanned ?? 0,
          mcpCleanupEnabled: learningDaemonMcpCleanupEnabled(),
          mcpCleanupMode: learningDaemonMcpCleanupMode(),
          mcpCleanupStaleMinutes: parseRuntimeMcpStaleMinutes(),
          mcpCleanupCandidates: aggregate?.mcpCleanup?.candidates.length ?? lastStatus?.mcpCleanupCandidates ?? 0,
          mcpCleanupAutoCleanable: aggregate?.mcpCleanup?.candidates.filter((candidate) => candidate.autoCleanable).length ?? lastStatus?.mcpCleanupAutoCleanable ?? 0,
          mcpCleanupTerminated: aggregate?.mcpCleanup?.terminated.filter((item) => item.status === "sent").length ?? lastStatus?.mcpCleanupTerminated ?? 0,
          mcpCleanupWarnings: aggregate?.mcpCleanup?.warnings.length ?? lastStatus?.mcpCleanupWarnings ?? 0,
          lastMcpCleanupAt: aggregate?.mcpCleanup?.generatedAt ?? lastStatus?.lastMcpCleanupAt ?? null,
          staleRunReconcileEnabled: staleRunReconcileConfig().enabled,
          staleRunReconcileCandidates: aggregate?.staleRunReconciliation?.candidates.length ?? lastStatus?.staleRunReconcileCandidates ?? 0,
          staleRunReconciled: aggregate?.staleRunReconciliation?.reconciled.filter((item) => item.updated).length ?? lastStatus?.staleRunReconciled ?? 0,
          lastStaleRunReconcileAt: aggregate?.staleRunReconciliation?.generatedAt ?? lastStatus?.lastStaleRunReconcileAt ?? null,
          trainingDiscoveryStatus: latestTrainingDiscovery?.status ?? lastStatus?.trainingDiscoveryStatus,
          trainingDiscoveryLastRunAt: latestTrainingDiscovery?.generatedAt ?? lastStatus?.trainingDiscoveryLastRunAt ?? null,
          trainingDiscoveryNextRunAfter: latestTrainingDiscovery?.nextRunAfter ?? lastStatus?.trainingDiscoveryNextRunAfter ?? null,
          trainingDiscoveryProposals: latestTrainingDiscovery?.proposals.length ?? lastStatus?.trainingDiscoveryProposals ?? 0,
          trainingDiscoveryErrors: latestTrainingDiscovery?.errors.length ?? lastStatus?.trainingDiscoveryErrors ?? 0,
          offlineSyncStatus: lastStatus?.offlineSyncStatus ?? null,
          lastError,
          command: allProjects
            ? `agentflow learning-daemon --all-projects --mode ${mode} --limit ${limit} --interval-ms ${intervalMs} --daemon-id ${shellQuote(daemonId)}`
            : `agentflow learning-daemon --project ${shellQuote(projectDir)} --mode ${mode} --limit ${limit} --interval-ms ${intervalMs} --daemon-id ${shellQuote(daemonId)}`
        };
        const targetHeartbeatFile = allProjects && statusProjectDir !== projectDir
          ? path.join(statusProjectDir, ".agent-workflow", "learning", "daemon-status.json")
          : heartbeatFile;
        await writeLearningDaemonStatus(statusProjectDir, heartbeat, targetHeartbeatFile);
        lastStatus = heartbeat;
        return heartbeat;
      };

      let queueRecoveryInFlight: Promise<{ stale: RuntimeStaleRunReconciliationResult; healed: number }> | null = null;
      const runQueueRecoveryLane = async (): Promise<{ stale: RuntimeStaleRunReconciliationResult; healed: number }> => {
        if (queueRecoveryInFlight) return queueRecoveryInFlight;
        queueRecoveryInFlight = (async () => {
          const stale = await runLearningDaemonStaleRunReconciliation(projectDir);
          const discoveredTargets = allProjects
            ? await loadLearningDaemonProjectTargets(projectDir)
            : [{ projectDir, enabled: true, paused: false, mode, limit }];
          let healed = stale.reconciled.filter((item) => item.updated).length;
          for (const target of discoveredTargets.filter((item) => item.enabled && !item.paused && item.mode === "apply-approved")) {
            const leaseRecovery = await requeueExpiredWorkflowTaskLeases({
              projectRootUri: target.projectDir,
              actor: "learning-daemon",
              reason: "Workflow supervisor recovered an expired task lease and requeued the unfinished stage."
            });
            healed += leaseRecovery.affectedRuns;
            await learnFromWorkflowRepairs(target.projectDir);
            healed += await autoRepairOneWorkflowRun(target.projectDir, target.mode);
          }
          return { stale, healed };
        })();
        try {
          return await queueRecoveryInFlight;
        } finally {
          queueRecoveryInFlight = null;
        }
      };

      const runTick = async (): Promise<void> => {
        ticks += 1;
        try {
          const discoveredTargets = allProjects
            ? await loadLearningDaemonProjectTargets(projectDir)
            : [{ projectDir, enabled: true, paused: false, mode, limit }];
          const enabledTargets = discoveredTargets.filter((target) => target.enabled && !target.paused);
          const fairIds = fairProjectOrder(enabledTargets.map((target) => ({ projectId: target.projectDir, maxActions: target.limit, consumedActions: 0, queueDepth: 0 }))).map((item) => item.projectId);
          const targets = [...enabledTargets].sort((a, b) => fairIds.indexOf(a.projectDir) - fairIds.indexOf(b.projectDir));
          let lastUpdate: Awaited<ReturnType<typeof runLearningDaemonTick>> | undefined;
          let analyzedRuns = 0;
          let proposalCount = 0;
          let inboxCount = 0;
          let applicationActions = 0;
          let autonomousAppliedActions = 0;
          let agentImprovementCandidates = 0;
          let agentImprovementPatchPreviews = 0;
          let agentImprovementEvalPasses = 0;
          let agentImprovementPromotions = 0;
          let agentImprovementPromotionPending = 0;
          let agentImprovementApplied = 0;
          let agentImprovementApplySkipped = 0;
          let workflowShapeRecommendations = 0;
          let roadmapOpenItems = 0;
          let roadmapSuggestions = 0;
          let approvalAutopilotExecuted = 0;
          let approvalAutopilotSkipped = 0;
          let approvalBacklogWarnings = 0;
          let approvalBacklogErrors = 0;
          let approvalBacklogScanned = 0;
          let approvalAutopilotEnabled = false;
          let blockedRunsAutoHealed = 0;
          let approvalAutopilotMaxRisk: ApprovalAutopilotRisk = await learningApprovalAutopilotMaxRisk(projectDir);
          let mcpCleanup: RuntimeMcpCleanupResult | undefined;
          let staleRunReconciliation: RuntimeStaleRunReconciliationResult | undefined;
          let trainingDiscovery: TrainingDiscoveryReport | null = null;
          const projectErrors: string[] = [];
          try {
            trainingDiscovery = await runTrainingDiscovery({
              projectDir,
              agents: (await loadAgents(ctx.rootDir)).map((agent) => agent.id),
              daemonLanes: daemonLanes.map((lane) => lane.id),
              cadenceMs: parsePositiveInteger(process.env.AGENTFLOW_TRAINING_DISCOVERY_INTERVAL_MS ?? "", 86_400_000)
            });
          } catch (error) {
            projectErrors.push(`${projectDir} training discovery: ${error instanceof Error ? error.message : String(error)}`);
          }
          const runFastRecoverySweep = async (): Promise<void> => {
            // Parent run state and repair supervision are queue-health work, not
            // learning analysis. Do them first so a slow all-project learning
            // pass cannot leave completed work shown as queued or actionable
            // blockers unattended for several minutes.
            try {
              const queueRecovery = await runQueueRecoveryLane();
              staleRunReconciliation = queueRecovery.stale;
              blockedRunsAutoHealed += queueRecovery.healed;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              projectErrors.push(`${projectDir} stale run reconciliation: ${message}`);
            }
            for (const recoveryTarget of targets) {
              if (recoveryTarget.mode !== "apply-approved") continue;
              try {
                const targetAutopilotEnabled = approvalAutopilotOverride
                  ?? await learningApprovalAutopilotEnabled(recoveryTarget.projectDir);
                if (targetAutopilotEnabled) {
                  await dismissDuplicateBlockedWorkflowRuns(recoveryTarget.projectDir, daemonId);
                  const targetMaxRisk = await learningApprovalAutopilotMaxRisk(recoveryTarget.projectDir);
                  const autopilot = await runApprovalAutopilot(ctx, {
                    projectRootUri: recoveryTarget.projectDir,
                    limit: 100,
                    maxRisk: targetMaxRisk,
                    execute: true,
                    actor: daemonId,
                    actorRole: "approver"
                  });
                  approvalAutopilotEnabled = true;
                  approvalAutopilotMaxRisk = targetMaxRisk;
                  approvalAutopilotExecuted += autopilot.executed;
                  approvalAutopilotSkipped += autopilot.skipped;
                  autonomousAppliedActions += autopilot.executed;
                }
                await writeStatus(stop ? "stopping" : "running", undefined, undefined, recoveryTarget.projectDir);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                projectErrors.push(`${recoveryTarget.projectDir} fast recovery: ${message}`);
              }
            }
          };

          // Expensive project analysis must never make another project's queue wait
          // for an entire all-project cycle. Sweep every enabled queue before each
          // heavy target and once more at the end so new low-risk approvals and
          // expired leases are recovered within at most one project's analysis.
          for (const target of targets) {
            await runFastRecoverySweep();
            const targetProjectDir = target.projectDir;
            try {
              const update = await runLearningDaemonTick({
                projectDir: targetProjectDir,
                mode: target.mode,
                limit: target.limit,
                daemonId,
                approvalAutopilotOverride,
                // Provider comparisons produce fleet-wide evidence. Run them once
                // from the daemon's control project, not once per registered project.
                modelComparisonEnabled: isFleetModelComparisonOwner(targetProjectDir, projectDir),
                trainingDiscoveryEnabled: false
              });
              await writeStatus(stop ? "stopping" : "running", update, undefined, targetProjectDir);
              lastUpdate = update;
              analyzedRuns += update.report.runsAnalyzed;
              proposalCount += update.proposalSet.proposals.length;
              inboxCount += update.approvalQueue.items.length;
              applicationActions += update.applicationPlan?.actions.length ?? 0;
              autonomousAppliedActions += update.autonomousApplication.appliedActions;
              agentImprovementCandidates += update.agentImprovement.candidates.length;
              agentImprovementPatchPreviews += update.agentImprovementPatchPlan.patches.length;
              agentImprovementEvalPasses += update.agentImprovementEvalPlan.evaluations.filter((item) => item.status === "pass").length;
              agentImprovementPromotions += update.agentImprovementPromotionQueue.items.length;
              agentImprovementPromotionPending += update.agentImprovementPromotionQueue.items.filter((item) => item.status === "pending").length;
              agentImprovementApplied += update.agentImprovementApply.appliedIds.length;
              agentImprovementApplySkipped += update.agentImprovementApply.skippedIds.length;
              workflowShapeRecommendations += update.workflowShape?.recommendations.length ?? 0;
              roadmapOpenItems += update.roadmap.openItems;
              roadmapSuggestions += update.roadmap.suggestions.length;
              autonomousAppliedActions += update.approvalAutopilot.executed;
              approvalAutopilotExecuted += update.approvalAutopilot.executed;
              approvalAutopilotSkipped += update.approvalAutopilot.skipped;
              approvalBacklogWarnings += update.approvalBacklog.severityCounts.warning ?? 0;
              approvalBacklogErrors += update.approvalBacklog.severityCounts.error ?? 0;
              approvalBacklogScanned += update.approvalBacklog.scanned;
              approvalAutopilotEnabled = approvalAutopilotEnabled || update.approvalAutopilotEnabled;
              approvalAutopilotMaxRisk = update.approvalAutopilotMaxRisk;
              await notifyOriginatingCodexTask(targetProjectDir);
              await deliverRunNotifications(targetProjectDir);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              projectErrors.push(`${targetProjectDir}: ${message}`);
              await writeStatus("failed", undefined, message, targetProjectDir);
            }
          }
          await runFastRecoverySweep();
          mcpCleanup = await runLearningDaemonMcpCleanup(projectDir);
          staleRunReconciliation ??= await runLearningDaemonStaleRunReconciliation(projectDir);
          await writeStatus(targets.length > 0 && projectErrors.length === targets.length ? "failed" : stop ? "stopping" : "running", lastUpdate, projectErrors.join("\n"), projectDir, {
            proposals: proposalCount,
            inboxItems: inboxCount,
            applicationActions,
              autonomousAppliedActions,
              agentImprovementCandidates,
              agentImprovementPatchPreviews,
              agentImprovementEvalPasses,
              agentImprovementPromotions,
              agentImprovementPromotionPending,
              agentImprovementApplied,
              agentImprovementApplySkipped,
              workflowShapeRecommendations,
              roadmapOpenItems,
              roadmapSuggestions,
            approvalAutopilotEnabled,
            approvalAutopilotMaxRisk,
            approvalAutopilotExecuted,
            approvalAutopilotSkipped,
            approvalBacklogWarnings,
            approvalBacklogErrors,
            approvalBacklogScanned,
            mcpCleanup,
            staleRunReconciliation,
            trainingDiscovery
          });
          if (!options.disableOfflineSync) {
            const offlineSync = await runDaemonOfflineSyncScheduler(ctx, {
              actor: daemonId,
              minIntervalMs: offlineSyncIntervalMs,
              execute: offlineSyncExecute
            });
            if (lastStatus) {
              lastStatus.offlineSyncStatus = offlineSync;
              await writeLearningDaemonStatus(projectDir, lastStatus, heartbeatFile);
            }
          }
          if (!options.json) {
            console.log(`Learning daemon tick ${ticks}: projects=${targets.length}, failedProjects=${projectErrors.length}, report=${analyzedRuns} run(s), proposals=${proposalCount}, roadmapSuggestions=${roadmapSuggestions}/${roadmapOpenItems}, inbox=${inboxCount}, applicationActions=${applicationActions}, autonomousApplied=${autonomousAppliedActions}, blockedAutoHealed=${blockedRunsAutoHealed}, workflowShape=${workflowShapeRecommendations}, trainingDiscovery=${trainingDiscovery?.status ?? "not-owner"}/${trainingDiscovery?.proposals.length ?? 0}, staleRuns=${staleRunReconciliation.reconciled.filter((item) => item.updated).length}/${staleRunReconciliation.candidates.length}, mcpCleanup=${mcpCleanup.terminated.filter((item) => item.status === "sent").length}/${mcpCleanup.candidates.filter((candidate) => candidate.autoCleanable).length}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await writeStatus("failed", undefined, message);
          throw error;
        }
      };

      await writeStatus("starting");
      const recoveredApprovalExecutions = await recoverInterruptedActionApprovalExecutions({ actor: daemonId });
      if (!options.json && recoveredApprovalExecutions.length) {
        console.log(`Recovered ${recoveredApprovalExecutions.length} interrupted approval execution${recoveredApprovalExecutions.length === 1 ? "" : "s"} for ${daemonId}.`);
      }
      await runQueueRecoveryLane();
      const queueRecoveryTimer = setInterval(() => {
        void runQueueRecoveryLane().catch((error) => {
          console.error(`Queue recovery lane failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, Math.min(intervalMs, 10_000));
      queueRecoveryTimer.unref();
      try {
        await runTick();
        if (options.once) {
          const stopped = await writeStatus("stopped");
          if (options.json) console.log(JSON.stringify(stopped, null, 2));
          return;
        }

      const stopDaemon = () => {
        stop = true;
        console.log("Stopping learning daemon after current tick...");
      };
      process.once("SIGINT", stopDaemon);
      process.once("SIGTERM", stopDaemon);
      if (!options.json) {
        console.log(`Learning daemon watching. id=${daemonId} mode=${mode} scope=${allProjects ? "all-projects" : "project"} project=${projectDir} intervalMs=${intervalMs} heartbeat=${heartbeatFile}`);
      }
        while (!stop) {
          await sleep(intervalMs);
          if (!stop) await runTick();
        }
        const stopped = await writeStatus("stopped");
        if (options.json) console.log(JSON.stringify(stopped, null, 2));
      } finally {
        clearInterval(queueRecoveryTimer);
      }
    });

  program
    .command("learning-daemon-status")
    .description("Show local learning daemon status for a project")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--json", "print daemon status JSON")
    .action(async (options: { project: string; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const status = await loadLearningDaemonStatus(ctx, projectDir);
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(formatLearningDaemonStatus(status));
    });

  program
    .command("learning-application-plan")
    .description("Prepare an application plan from approved or auto-approved learning proposals")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--ids <ids>", "comma-separated approved proposal ids or approval ids to include, or all", "all")
    .option("--write", "write application plan files under .agent-workflow/learning")
    .option("--json", "print application plan JSON")
    .action(async (options: { project: string; ids: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const queue = await readLearningApprovalQueue(projectDir);
      const plan = buildGovernedLearningApplicationPlan(queue, parseProposalIds(options.ids));
      if (options.write) {
        await writeLearningApplicationPlan(projectDir, plan);
        await recordLearningApplicationPlanReceipts(projectDir, plan, "learning-application-plan", "application plan written");
      }

      if (options.json) {
        console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }

      console.log(formatLearningApplicationPlan(plan));
      if (options.write) {
        console.log("");
        console.log("Wrote .agent-workflow/learning/application-plan.json");
        console.log("Wrote .agent-workflow/learning/application-plan.md");
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to save the Agent Workflow-owned learning application plan.");
      }
    });

  program
    .command("learning-action-receipts")
    .description("List or update append-only receipts for local learning proposal-to-action plans")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--reject <ids>", "comma-separated planned action ids or proposal ids to reject, or all")
    .option("--health", "show receipt health and duplicate pressure instead of the full receipt log")
    .option("--compact", "backup and compact duplicate daemon-owned planned/applied receipts")
    .option("--actor <name>", "actor name", "developer")
    .option("--note <text>", "receipt note")
    .option("--json", "print receipt log JSON")
    .action(async (options: { project: string; reject?: string; health?: boolean; compact?: boolean; actor: string; note?: string; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      if (options.compact) {
        const result = await compactLearningActionReceiptFiles(projectDir);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(formatLearningActionReceiptCompaction(result));
        return;
      }
      if (options.health) {
        const health = await loadLearningActionReceiptHealth(projectDir);
        if (options.json) {
          console.log(JSON.stringify(health, null, 2));
          return;
        }
        console.log(formatLearningActionReceiptHealth(health));
        return;
      }
      let receipts = await readLearningActionReceipts(projectDir).catch(() => emptyLearningActionReceipts(projectDir));
      if (options.reject) {
        receipts = appendLearningActionRejectionReceipts(receipts, parseProposalIds(options.reject), options.actor, options.note ?? "Rejected planned learning action.");
        await writeLearningActionReceipts(projectDir, receipts);
      }

      if (options.json) {
        console.log(JSON.stringify(receipts, null, 2));
        return;
      }

      console.log(formatLearningActionReceipts(receipts));
    });

  program
    .command("learning-workflow-shape")
    .description("Recommend workflow stage and agent-type shape changes from local learning evidence")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("-w, --workflow <id>", "workflow id or alias; defaults to the latest project run workflow")
    .option("-l, --limit <number>", "number of recent project runs to analyze", "50")
    .option("--write", "write workflow-shape learning artifacts under .agent-workflow/learning")
    .option("--json", "print workflow shape optimization JSON")
    .action(async (options: { project: string; workflow?: string; limit: string; write?: boolean; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const report = await loadWorkflowShapeOptimization(ctx, {
        projectDir,
        workflowId: options.workflow,
        limit: parsePositiveInteger(options.limit, 50)
      });
      if (options.write) {
        await writeWorkflowShapeOptimization(projectDir, report);
      }

      if (options.json) {
        console.log(JSON.stringify({ ...report, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }

      console.log(formatWorkflowShapeOptimizationReport(report));
      if (options.write) {
        console.log("");
        console.log("Wrote .agent-workflow/learning/workflow-shape-proposals.json");
        console.log("Wrote .agent-workflow/learning/stage-recommendations.md");
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to refresh Agent Workflow-owned workflow-shape learning files.");
      }
    });

  program
    .command("agent-improvement-report")
    .description("Analyze agents and recommend safe local-first definition improvements from run history, feedback, routing, eval, and role evidence")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--agent <id>", "focus on one agent id")
    .option("-l, --limit <number>", "number of recent project runs to analyze", "50")
    .option("--write", "write agent-improvement learning artifacts under .agent-workflow/learning")
    .option("--json", "print agent improvement report JSON")
    .action(async (options: { project: string; agent?: string; limit: string; write?: boolean; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const report = await loadAgentImprovementReport(ctx, {
        projectDir,
        agentId: options.agent,
        limit: parsePositiveInteger(options.limit, 50),
        mode: options.write ? "write-owned-learning-state" : "read-only"
      });
      if (options.write) {
        await writeAgentImprovementReport(projectDir, report);
      }

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(formatAgentImprovementReport(report));
      if (options.write) {
        console.log("");
        console.log("Wrote .agent-workflow/learning/agent-improvement-report.json");
        console.log("Wrote .agent-workflow/learning/agent-improvement-recommendations.md");
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to refresh Agent Workflow-owned agent-improvement learning files.");
      }
    });

  program
    .command("agent-improvement-patches")
    .description("Generate validated YAML patch previews from agent improvement candidates without editing agent definitions")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--ids <ids>", "comma-separated candidate ids or agent ids to include, or all", "all")
    .option("--agent <id>", "focus on one agent id")
    .option("-l, --limit <number>", "number of recent project runs to analyze", "50")
    .option("--write", "write agent-improvement patch plan files under .agent-workflow/learning")
    .option("--json", "print agent improvement patch plan JSON")
    .action(async (options: { project: string; ids: string; agent?: string; limit: string; write?: boolean; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const report = await loadAgentImprovementReport(ctx, {
        projectDir,
        agentId: options.agent,
        limit: parsePositiveInteger(options.limit, 50),
        mode: "read-only"
      });
      const patchPlan = await buildAgentImprovementPatchPlan(ctx, projectDir, report, parseProposalIds(options.ids));
      if (options.write) {
        await writeAgentImprovementPatchPlan(projectDir, patchPlan);
      }

      if (options.json) {
        console.log(JSON.stringify(patchPlan, null, 2));
        return;
      }

      console.log(formatAgentImprovementPatchPlan(patchPlan));
      if (options.write) {
        console.log("");
        console.log("Wrote .agent-workflow/learning/agent-improvement-patches.json");
        console.log("Wrote .agent-workflow/learning/agent-improvement-patches.md");
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to refresh Agent Workflow-owned patch preview files.");
      }
    });

  program
    .command("agent-improvement-evals")
    .description("Score agent improvement patch previews against recent holdout run evidence before promotion or auto-apply")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--ids <ids>", "comma-separated patch ids, candidate ids, or agent ids to include, or all", "all")
    .option("--agent <id>", "focus on one agent id")
    .option("-l, --limit <number>", "number of recent project runs to analyze", "50")
    .option("--write", "write agent-improvement eval files under .agent-workflow/learning")
    .option("--json", "print agent improvement eval JSON")
    .action(async (options: { project: string; ids: string; agent?: string; limit: string; write?: boolean; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const report = await loadAgentImprovementReport(ctx, {
        projectDir,
        agentId: options.agent,
        limit: parsePositiveInteger(options.limit, 50),
        mode: "read-only"
      });
      const patchPlan = await buildAgentImprovementPatchPlan(ctx, projectDir, report, parseProposalIds(options.ids));
      const evalPlan = await buildAgentImprovementEvalPlan(ctx, projectDir, patchPlan, parseProposalIds(options.ids), parsePositiveInteger(options.limit, 50));
      if (options.write) {
        await writeAgentImprovementEvalPlan(projectDir, evalPlan);
      }

      if (options.json) {
        console.log(JSON.stringify(evalPlan, null, 2));
        return;
      }

      console.log(formatAgentImprovementEvalPlan(evalPlan));
      if (options.write) {
        console.log("");
        console.log("Wrote .agent-workflow/learning/agent-improvement-evals.json");
        console.log("Wrote .agent-workflow/learning/agent-improvement-evals.md");
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to refresh Agent Workflow-owned holdout eval files.");
      }
    });

  program
    .command("agent-improvement-promotions")
    .description("Create and decide an auditable promotion queue for eval-passing agent improvement patches")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--ids <ids>", "comma-separated patch ids, eval ids, promotion ids, candidate ids, or agent ids to include, or all", "all")
    .option("--agent <id>", "focus on one agent id")
    .option("-l, --limit <number>", "number of recent project runs to analyze", "50")
    .option("--approve <ids>", "comma-separated promotion ids, patch ids, eval ids, candidate ids, or agent ids to approve, or all")
    .option("--reject <ids>", "comma-separated promotion ids, patch ids, eval ids, candidate ids, or agent ids to reject, or all")
    .option("--defer <ids>", "comma-separated promotion ids, patch ids, eval ids, candidate ids, or agent ids to defer, or all")
    .option("--reviewer <name>", "reviewer name")
    .option("--note <text>", "decision note")
    .option("--write", "write promotion queue files under .agent-workflow/learning")
    .option("--json", "print agent improvement promotion queue JSON")
    .action(async (options: { project: string; ids: string; agent?: string; limit: string; approve?: string; reject?: string; defer?: string; reviewer?: string; note?: string; write?: boolean; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const decisionCount = Number(Boolean(options.approve)) + Number(Boolean(options.reject)) + Number(Boolean(options.defer));
      if (decisionCount > 1) {
        console.error("Use exactly one of --approve, --reject, or --defer.");
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const limit = parsePositiveInteger(options.limit, 50);
      const ids = parseProposalIds(options.ids);
      const report = await loadAgentImprovementReport(ctx, {
        projectDir,
        agentId: options.agent,
        limit,
        mode: "read-only"
      });
      const patchPlan = await buildAgentImprovementPatchPlan(ctx, projectDir, report, ids);
      const evalPlan = await buildAgentImprovementEvalPlan(ctx, projectDir, patchPlan, ids, limit);
      const existingQueue = await readAgentImprovementPromotionQueue(projectDir).catch(() => undefined);
      let queue = buildAgentImprovementPromotionQueue(projectDir, patchPlan, evalPlan, ids, existingQueue);
      let receipts: AgentImprovementPromotionReceiptLog | null = null;

      if (options.approve || options.reject || options.defer) {
        const result = await decideAgentImprovementPromotions({
          projectDir,
          queue,
          ids: parseProposalIds(options.approve ?? options.reject ?? options.defer),
          status: options.approve ? "approved" : options.reject ? "rejected" : "deferred",
          reviewer: options.reviewer,
          note: options.note
        });
        queue = result.queue;
        receipts = result.receipts;
        if (result.skippedIds.length) {
          console.error(`Skipped unknown ids: ${result.skippedIds.join(", ")}`);
        }
      }

      if (options.write || options.approve || options.reject || options.defer) {
        await writeAgentImprovementPromotionQueue(projectDir, queue);
      }

      if (options.json) {
        console.log(JSON.stringify(receipts ? { ...queue, receipts } : queue, null, 2));
        return;
      }

      console.log(formatAgentImprovementPromotionQueue(queue));
      if (receipts) {
        console.log("");
        console.log(formatAgentImprovementPromotionReceipts(receipts));
      }
      if (options.write || options.approve || options.reject || options.defer) {
        console.log("");
        console.log("Wrote .agent-workflow/learning/agent-improvement-promotions.json");
        console.log("Wrote .agent-workflow/learning/agent-improvement-promotions.md");
        if (receipts) {
          console.log("Wrote .agent-workflow/learning/agent-improvement-promotion-receipts.json");
          console.log("Wrote .agent-workflow/learning/agent-improvement-promotion-receipts.md");
        }
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to refresh Agent Workflow-owned promotion queue files.");
      }
    });

  program
    .command("agent-improvement-apply")
    .description("Apply approved agent improvement promotions into agent YAML with source-hash and rollback receipts")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--ids <ids>", "comma-separated promotion ids, patch ids, eval ids, candidate ids, or agent ids to apply, or all", "all")
    .option("--max-risk <risk>", "maximum approved promotion risk to apply: low, medium, or high")
    .option("--actor <name>", "actor name for application receipts", "learning-daemon")
    .option("--note <text>", "application note")
    .option("--project-local-auto-ready", "apply only project-local auto-ready promotions that do not require approval")
    .option("--write", "write approved YAML changes and application receipts")
    .option("--json", "print agent improvement apply result JSON")
    .action(async (options: { project: string; ids: string; maxRisk?: string; actor: string; note?: string; projectLocalAutoReady?: boolean; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const queue = await readAgentImprovementPromotionQueue(projectDir);
      const maxRisk = parseLearningRiskLevel(options.maxRisk ?? await learningAutonomousApplyMaxRisk(projectDir));
      const result = await applyAgentImprovementPromotions({
        projectDir,
        queue,
        ids: parseProposalIds(options.ids),
        maxRisk,
        actor: options.actor,
        note: options.note ?? "Apply approved agent improvement promotion.",
        write: Boolean(options.write),
        mode: options.projectLocalAutoReady ? "project-local-auto" : "approved"
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(formatAgentImprovementApplyResult(result, maxRisk));
      if (options.write) {
        console.log("");
        console.log("Wrote .agent-workflow/learning/agent-improvement-promotions.json");
        console.log("Wrote .agent-workflow/learning/agent-improvement-promotions.md");
        console.log("Wrote .agent-workflow/learning/agent-improvement-apply-receipts.json");
        console.log("Wrote .agent-workflow/learning/agent-improvement-apply-receipts.md");
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to apply approved agent YAML changes.");
      }
    });

  program
    .command("client-capabilities")
    .description("Print the versioned runtime capability contract for dashboard, IDE, MCP, and Studio clients")
    .option("--json", "print machine-readable capability JSON")
    .action((options: { json?: boolean }) => {
      const contract = buildClientCapabilityContract(ctx.packageVersion);
      if (options.json) console.log(JSON.stringify(contract, null, 2));
      else console.log(Object.entries(contract.capabilities).map(([id, capability]) => `${capability.supported ? "SUPPORTED" : "UNSUPPORTED"} ${id}: ${capability.semantics}`).join("\n"));
    });

  program
    .command("tuning-proposals")
    .description("Generate reviewable prompt, context-budget, and routing tuning proposals from the preference scorecard")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("-l, --limit <number>", "number of recent project runs to analyze", "25")
    .option("--json", "print proposals JSON")
    .action(async (options: { project: string; limit: string; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const proposalSet = await loadTuningProposals({
        projectDir: path.resolve(process.cwd(), options.project),
        limit: parsePositiveInteger(options.limit, 25)
      });

      if (options.json) {
        console.log(JSON.stringify(proposalSet, null, 2));
        return;
      }

      console.log(formatTuningProposals(proposalSet));
    });

  program
    .command("apply-tuning-proposals")
    .description("Create project-local tuning overlay files from selected tuning proposals")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--ids <ids>", "comma-separated proposal ids to apply, or all", "all")
    .option("-l, --limit <number>", "number of recent project runs to analyze", "25")
    .option("--approved", "apply only approved proposals from .agent-workflow/tuning/approval-queue.json")
    .option("--write", "write generated overlay files into the project")
    .option("--json", "print application plan JSON")
    .action(async (options: { project: string; ids: string; limit: string; approved?: boolean; write?: boolean; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const proposalSet = options.approved
        ? proposalSetFromApprovedQueue(await readTuningApprovalQueue(projectDir))
        : await loadTuningProposals({
          projectDir,
          limit: parsePositiveInteger(options.limit, 25)
        });
      const plan = buildTuningApplicationPlan(proposalSet, parseProposalIds(options.ids));

      if (options.write) {
        await writeTuningApplicationPlan(projectDir, plan);
        await recordTuningHistory(projectDir, plan.selectedIds, "applied", undefined, "Applied as project-local tuning overlays");
      }

      if (options.json) {
        console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }

      console.log(formatTuningApplicationPlan(plan));
      if (options.write) {
        for (const file of plan.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to create these project-local overlay files.");
      }
    });

  program
    .command("queue-tuning-approvals")
    .description("Create a project-local approval queue from selected tuning proposals")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--ids <ids>", "comma-separated proposal ids to queue, or all", "all")
    .option("-l, --limit <number>", "number of recent project runs to analyze", "25")
    .option("--write", "write approval queue files into the project")
    .option("--json", "print approval queue JSON")
    .action(async (options: { project: string; ids: string; limit: string; write?: boolean; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const proposalSet = await loadTuningProposals({
        projectDir,
        limit: parsePositiveInteger(options.limit, 25)
      });
      const existingQueue = await readTuningApprovalQueue(projectDir).catch(() => undefined);
      const queue = buildTuningApprovalQueue(proposalSet, parseProposalIds(options.ids), existingQueue);

      if (options.write) {
        await writeTuningApprovalQueue(projectDir, queue);
        const newIds = queue.items.filter((item) => !existingQueue?.items.some((existing) => existing.proposalId === item.proposalId)).map((item) => item.proposalId);
        await recordTuningHistory(projectDir, newIds, "queued");
      }

      if (options.json) {
        console.log(JSON.stringify({ ...queue, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }

      console.log(formatTuningApprovalQueue(queue));
      if (options.write) {
        console.log("Wrote .agent-workflow/tuning/approval-queue.json");
        console.log("Wrote .agent-workflow/tuning/approval-queue.md");
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to create the project-local approval queue.");
      }
    });

  program
    .command("tuning-approvals")
    .description("List, approve, or reject project-local tuning approval queue items")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--approve <ids>", "comma-separated approval ids or proposal ids to approve, or all")
    .option("--reject <ids>", "comma-separated approval ids or proposal ids to reject, or all")
    .option("--reviewer <name>", "reviewer name")
    .option("--note <text>", "decision note")
    .option("--json", "print approval queue JSON")
    .action(async (options: { project: string; approve?: string; reject?: string; reviewer?: string; note?: string; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const queue = await readTuningApprovalQueue(projectDir);
      const decisionCount = Number(Boolean(options.approve)) + Number(Boolean(options.reject));
      if (decisionCount > 1) {
        console.error("Use either --approve or --reject, not both.");
        process.exitCode = 1;
        return;
      }

      let nextQueue = queue;
      if (options.approve || options.reject) {
        const result = decideTuningApprovals({
          queue,
          ids: parseProposalIds(options.approve ?? options.reject),
          status: options.approve ? "approved" : "rejected",
          reviewer: options.reviewer,
          note: options.note
        });
        nextQueue = result.queue;
        await writeTuningApprovalQueue(projectDir, nextQueue);
        await recordTuningHistory(projectDir, result.selectedIds, options.approve ? "approved" : "rejected", options.reviewer, options.note);
        if (result.skippedIds.length) {
          console.error(`Skipped unknown ids: ${result.skippedIds.join(", ")}`);
        }
      }

      if (options.json) {
        console.log(JSON.stringify(nextQueue, null, 2));
        return;
      }

      console.log(formatTuningApprovalQueue(nextQueue));
    });

  program
    .command("generate-tuning-patches")
    .description("Create reviewable patch-plan files from approved tuning proposals")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--ids <ids>", "comma-separated approved proposal ids or approval ids to include, or all", "all")
    .option("--write", "write patch-plan files into the project")
    .option("--json", "print patch plan JSON")
    .action(async (options: { project: string; ids: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const queue = await readTuningApprovalQueue(projectDir);
      const plan = buildTuningPatchPlan(queue, parseProposalIds(options.ids));

      if (options.write) {
        await writeTuningPatchPlan(projectDir, plan);
      }

      if (options.json) {
        console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }

      console.log(formatTuningPatchPlan(plan));
      if (options.write) {
        for (const file of plan.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to create reviewable patch-plan files.");
      }
    });

  program
    .command("model-improvement-plan")
    .description("Prepare scrubbed eval-case and provider dataset-plan proposals from approved project-local feedback")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--ids <ids>", "comma-separated approved proposal ids or approval ids to include, or all", "all")
    .option("--write", "write plan files into the project")
    .option("--json", "print model-improvement plan JSON")
    .action(async (options: { project: string; ids: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const queue = await readTuningApprovalQueue(projectDir);
      const plan = buildModelImprovementPlan(queue, parseProposalIds(options.ids));

      if (options.write) {
        await writeModelImprovementPlan(projectDir, plan);
      }

      if (options.json) {
        console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }

      console.log(formatModelImprovementPlan(plan));
      if (options.write) {
        for (const file of plan.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to create project-local model-improvement plan files.");
      }
    });

  program
    .command("candidate-comparison-plan")
    .description("Prepare opt-in baseline-versus-candidate evaluation suites from a model-improvement plan")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--baseline-provider <provider>", "baseline provider id", "auto")
    .option("--candidate-provider <provider>", "candidate provider id", "auto")
    .option("--baseline-tier <tier>", "fast, standard, or reasoning", "standard")
    .option("--candidate-tier <tier>", "fast, standard, or reasoning", "reasoning")
    .option("--baseline-prompt <text>", "baseline prompt suffix")
    .option("--candidate-prompt <text>", "candidate prompt suffix")
    .option("--write", "write plan and private evaluation suite files into the project")
    .option("--json", "print candidate comparison plan JSON")
    .action(async (options: {
      project: string;
      baselineProvider: string;
      candidateProvider: string;
      baselineTier: string;
      candidateTier: string;
      baselinePrompt?: string;
      candidatePrompt?: string;
      write?: boolean;
      json?: boolean;
    }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const modelPlan = await readModelImprovementPlan(projectDir);
      const baseline: Partial<CandidateVariantPlan> = {
        provider: normalizeProviderRef(options.baselineProvider),
        modelTier: parseModelTierOption(options.baselineTier)
      };
      const candidate: Partial<CandidateVariantPlan> = {
        provider: normalizeProviderRef(options.candidateProvider),
        modelTier: parseModelTierOption(options.candidateTier)
      };
      if (options.baselinePrompt) baseline.promptSuffix = options.baselinePrompt;
      if (options.candidatePrompt) candidate.promptSuffix = options.candidatePrompt;
      const plan = buildCandidateComparisonPlan({ modelPlan, baseline, candidate });

      if (options.write) {
        await writeCandidateComparisonPlan(projectDir, plan);
      }

      if (options.json) {
        console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }

      console.log(formatCandidateComparisonPlan(plan));
      if (options.write) {
        for (const file of plan.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to create local comparison plan and evaluation suite files.");
      }
    });

  program
    .command("quality-report")
    .description("Show adaptive routing, cost mix, latency, fallback, and quality scoring for a workflow run")
    .requiredOption("-r, --run <id>", "workflow run id")
    .option("--json", "print report JSON")
    .action(async (options: { run: string; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const report = await loadCostQualityReport(options.run);
      if (!report) {
        console.error(`Unknown workflow run: ${options.run}`);
        process.exitCode = 1;
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(formatCostQualityReport(report));
    });

  program
    .command("promotion-note-plan")
    .description("Prepare reviewed project-local routing-note patch plans from promotable candidate comparisons")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--suite <ids>", "comma-separated suite ids to include, or all", "all")
    .option("--write", "write review plan files into .agent-workflow/tuning")
    .option("--json", "print promotion note plan JSON")
    .action(async (options: { project: string; suite: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const report = await loadDashboardCandidateComparisonReport({ projectDir });
      const plan = buildPromotionRoutingNotePlan(report, parseProposalIds(options.suite));

      if (options.write) {
        await writePromotionRoutingNotePlan(projectDir, plan);
      }

      if (options.json) {
        console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }

      console.log(formatPromotionRoutingNotePlan(plan));
      if (options.write) {
        for (const file of plan.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to create reviewable promotion note files.");
      }
    });

  program
    .command("apply-tuning-patches")
    .description("Apply reviewed tuning patch-plan items into project-local tuning note files")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--ids <ids>", "comma-separated approved proposal ids or approval ids to apply, or all", "all")
    .option("--write", "write applied tuning note files into the project")
    .option("--json", "print application plan JSON")
    .action(async (options: { project: string; ids: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const patchPlan = await readTuningPatchPlan(projectDir);
      const plan = buildTuningPatchApplicationPlan(patchPlan, parseProposalIds(options.ids));

      if (options.write) {
        await writeTuningApplicationPlan(projectDir, plan);
        await recordTuningHistory(projectDir, plan.selectedIds, "applied");
      }

      if (options.json) {
        console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }

      console.log(formatTuningApplicationPlan(plan));
      if (options.write) {
        for (const file of plan.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to create applied project-local tuning notes.");
      }
    });

  program
    .command("tuning-history")
    .description("List or append project-local tuning proposal lifecycle history")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--record <status>", "append applied, reverted, or superseded events")
    .option("--ids <ids>", "comma-separated proposal ids", "all")
    .option("--actor <name>", "actor name")
    .option("--note <text>", "event note")
    .option("--related-proposal <id>", "replacement or related proposal id")
    .option("--json", "print history JSON")
    .action(async (options: { project: string; record?: string; ids: string; actor?: string; note?: string; relatedProposal?: string; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      if (options.record) {
        const allowed: TuningHistoryStatus[] = ["applied", "reverted", "superseded"];
        if (!allowed.includes(options.record as TuningHistoryStatus)) throw new Error(`--record must be one of: ${allowed.join(", ")}`);
        if (options.ids === "all") throw new Error("--ids is required when recording a history event");
        await recordTuningHistory(projectDir, parseProposalIds(options.ids) as string[], options.record as TuningHistoryStatus, options.actor, options.note, options.relatedProposal);
      }
      const history = await readTuningApprovalHistory(projectDir).catch(() => ({
        kind: "agentflow_tuning_approval_history" as const,
        projectRootUri: projectDir,
        updatedAt: new Date(0).toISOString(),
        events: []
      }));
      console.log(options.json ? JSON.stringify(history, null, 2) : formatTuningApprovalHistory(history));
    });

}
