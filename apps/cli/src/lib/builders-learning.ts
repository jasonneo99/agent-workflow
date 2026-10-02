import escapeHtmlText from "escape-html";
import { dashboardIcon } from "../dashboard/icons.js";
import type { CliContext } from "./context.js";
import type { AgentImprovementCandidate, AgentImprovementEval, AgentImprovementEvalPlan, AgentImprovementOutcomeWeight, AgentImprovementPatch, AgentImprovementPatchPlan, AgentImprovementPromotionDecisionResult, AgentImprovementPromotionItem, AgentImprovementPromotionQueue, AgentImprovementPromotionReceiptLog, AgentImprovementPromotionStatus, AgentImprovementReport, DashboardCandidateComparisonReport, DashboardEvaluationRun, DashboardEvaluationSuite, DashboardEvaluationVariant, DashboardFeedbackClassification, DashboardFeedbackInboxReport, DashboardFeedbackTarget, DashboardInfo, DashboardLearningDaemonStatus, DashboardLocalHoldoutRoutingStatus, DashboardLocalProviderEvidence, DashboardPromotionNoteFileSummary, DashboardPromotionRoutingNotePlan, DashboardRouteReceiptTrendGroup, DashboardRouteReceiptTrendReport, DashboardRunStatus, FeedbackRating, LearningActionReceipt, LearningActionReceiptCompactionResult, LearningActionReceiptHealth, LearningActionReceiptLog, LearningDaemonHeartbeat, LearningDaemonMode, LearningReport, LearningRouteFeedbackSummary, LearningSettings, LocalHoldoutResultSummary, LocalHoldoutRoutingPromotion, LocalLlmBenchmarkReceiptReport, LocalLlmCacheTrendComparison, LocalLlmCacheTrendPoint, LocalLlmCacheTrendReport, LocalLlmCostAssumptions, LocalLlmCostLedgerComparison, LocalLlmCostLedgerPoint, LocalLlmCostLedgerReport, LocalLlmDownloadRecommendation, LocalLlmDownloadRecommendationReport, LocalLlmInstallationAction, LocalLlmInstallationPlanReport, LocalLlmInventoryCacheRoot, LocalLlmInventoryModel, LocalLlmInventoryReport, LocalLlmInventoryStorage, LocalLlmPruneAction, LocalLlmPrunePlanReport, LocalLlmRoutingRecommendation, LocalLlmRoutingRecommendationReport, LocalLlmRuntimeProbe, LocalLlmSetupChecklistItem, LocalLlmSetupChecklistReport, LocalLlmSetupGuideReport, LocalLlmSmokeOutcome, LocalLlmSmokeOutcomeTrend, OfflineFallbackQueue, OfflineFallbackQueueAction, OfflineFallbackQueueItem, OfflineFallbackSyncResult, OfflineSyncSchedulerStatus, RoadmapSnapshotPublication, RouteDecisionFeedbackEvent, RouteDecisionFeedbackLog, RouteDecisionFeedbackRating, RunSummary, RuntimeMcpCleanupResult, RuntimeMonitorReport, RuntimeVersionMetadata , AgentImprovementPendingProject, AgentImprovementPendingSummary } from "./cli-types.js";
import { parseApprovalAutopilotRisk } from "./builders-approvals.js";
import {buildStoredRoadmapSnapshot, countStrings, ensureProjectSubdir, execFileText, formatBytes, isExecutableApprovalAction, isRecord, loadCostQualityReport, mergeCounts, objectValue, pathExists, pathIsFile, redactDashboardUrl, safeDisplayUrl, safeErrorMessage, scanDirectorySize, shellQuote, stringValue, walk} from "./builders-shared.js";
import { loadAgentRecords, loadProjectConfig, loadWorkflows, loadYamlFile } from "../../../../packages/agent-registry/src/loaders.js";
import { type AgentCard, agentCardSchema } from "../../../../packages/agent-registry/src/schemas.js";
import { normalizeDaemonTrustSettings } from "../../../../packages/daemon-control/src/index.js";
import { buildCostOpportunities, buildEvaluationGaps, buildFailurePatterns, buildProposalPreview, selectFailedRuns, summarizeRouteFeedback } from "../../../../packages/learning-evidence/src/index.js";
import { type LearningApprovalQueue, type LearningProposalPriority, type LearningRiskLevel } from "../../../../packages/learning-governance/src/index.js";
import { normalizeModelSelectionPolicy } from "../../../../packages/model-providers/src/catalog.js";
import { type LocalRoutingFeedbackEvent, buildSavingsAwareLocalRoutingRecommendations } from "../../../../packages/model-providers/src/local-routing-recommendations.js";
import { type ModelTier } from "../../../../packages/model-providers/src/types.js";
import { resolveContainedProjectPath } from "../../../../packages/roadmap-planner/src/index.js";
import { parseRoadmapSnapshot, roadmapSnapshotNeedsPublication } from "../../../../packages/roadmap-snapshot/src/index.js";
import { type CandidateComparisonPlan, type CandidateVariantPlan, type CostQualityReport, type ModelImprovementPlan, type PreferenceScorecard, type TuningApprovalHistory, type TuningApprovalQueue, type TuningHistoryStatus, type TuningProposalSet, type WorkflowShapeOptimizationReport, appendTuningApprovalHistory, buildCostQualityReport, buildPreferenceScorecard, buildTuningProposals, buildWorkflowShapeOptimizationReport, formatTuningApprovalHistoryMarkdown } from "../../../../packages/run-reporter/src/index.js";
import { defaultServiceEndpoints } from "../../../../packages/storage/src/config.js";
import { checkServices } from "../../../../packages/storage/src/doctor.js";
import { type StorageMergeImportResult, formatStorageMergeImportResult, runStorageMergeImport } from "../../../../packages/storage/src/merge-importer.js";
import { type StorageMergeManifest, buildStorageMergeManifest, formatStorageMergeManifest } from "../../../../packages/storage/src/merge-manifest.js";
import { getProjectIndexState, getWorkflowRunDetails, listActionApprovals, listArtifacts, listProjectFileSummaries, listWorkflowRuns, listWorkflowRunsForProject, listWorkflowStageHealthForRuns, recordRunAction, upsertMemoryItem, upsertProject, upsertProjectIndexState } from "../../../../packages/storage/src/postgres.js";
import { mapWithConcurrency } from "../concurrency.js";
import { formatTierModelPreview, loadGenericTierModelPreview } from "../dashboard/anthropic-provider.js";
import { parsePositiveInteger } from "../numeric-options.js";
import { normalizeLookup, resolveWorkflow } from "../reference-resolution.js";
import { recommendRunNextAction } from "../run-recommendation.js";
import { createHash } from "node:crypto";
import fsSync, { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export const AGENT_IMPROVEMENT_NEGATIVE_OUTCOME_MAX_WEIGHT = 1 / 3;

export const AGENT_IMPROVEMENT_NEGATIVE_OUTCOME_MIN_EVIDENCE = 5;

export function addUniqueStrings(values: string[], additions: string[]): string[] {
  const seen = new Set(values);
  const output = [...values];
  for (const addition of additions) {
    if (!seen.has(addition)) {
      output.push(addition);
      seen.add(addition);
    }
  }
  return output;
}

export function agentImprovementRiskRank(risk: LearningRiskLevel): number {
  return risk === "high" ? 3 : risk === "medium" ? 2 : 1;
}

export function appendAgentPromptNotes(prompt: string, notes: string): string {
  if (prompt.includes("Local learning improvement notes:")) {
    return prompt;
  }
  return `${prompt.trim()}\n\n${notes}\n`;
}

export function appendLearningActionRejectionReceipts(log: LearningActionReceiptLog, ids: string[] | "all", actor: string, note: string): LearningActionReceiptLog {
  const idSet = ids === "all" ? null : new Set(ids);
  const createdAt = new Date().toISOString();
  const rejectedKeys = new Set(log.events.filter((event) => event.status === "rejected").map((event) => `${event.actionId}|${event.proposalId}`));
  const nextEvents = [...log.events];
  for (const event of log.events) {
    const selected = event.status === "planned" && (idSet === null || idSet.has(event.id) || idSet.has(event.actionId) || idSet.has(event.proposalId));
    const key = `${event.actionId}|${event.proposalId}`;
    if (selected && !rejectedKeys.has(key)) {
      nextEvents.push({
        ...event,
        id: `receipt-${String(nextEvents.length + 1).padStart(4, "0")}`,
        status: "rejected",
        createdAt,
        actor,
        note
      });
    }
  }
  return {
    ...log,
    updatedAt: createdAt,
    events: nextEvents
  };
}

export function buildAgentImprovementCandidate(input: {
  record: { agent: AgentCard; sourcePath: string; scope: "shared" | "project-local" };
  workflowRefs: Array<{ workflowId: string; stageId: string; subagent: boolean }>;
  runs: Awaited<ReturnType<typeof listWorkflowRunsForProject>>;
  scorecard: PreferenceScorecard;
  reports: CostQualityReport[];
  stageHealth: Awaited<ReturnType<typeof listWorkflowStageHealthForRuns>>;
  outcomeWeights: Map<string, AgentImprovementOutcomeWeight>;
}): AgentImprovementCandidate | null {
  const { agent } = input.record;
  const joined = [
    agent.purpose,
    ...agent.use_when,
    ...agent.avoid_when,
    ...agent.can,
    ...agent.cannot,
    ...agent.requires_approval,
    agent.prompt
  ].join("\n").toLowerCase();
  const workflowRefs = input.workflowRefs;
  const usedStageIds = new Set(workflowRefs.map((ref) => ref.stageId));
  const failingStages = input.stageHealth.filter((stage) => usedStageIds.has(stage.stageId) && stage.failedTasks > 0);
  const costGroups = input.scorecard.groups.filter((group) => group.agentId === agent.id || usedStageIds.has(group.stageId));
  const fallbackGroups = costGroups.filter((group) => group.fallbackRate > 0 || (group.averageLatencyMs ?? 0) > 30_000);
  const evidence: string[] = [];
  const mutableFields = new Set<AgentImprovementCandidate["suggestedMutableFields"][number]>();
  const recommendations: string[] = [];
  const patternKeys: string[] = [];
  let priority: LearningProposalPriority = "low";
  let riskLevel: LearningRiskLevel = "low";

  if (workflowRefs.length) {
    evidence.push(`Referenced by ${workflowRefs.length} workflow stage/subagent slot(s).`);
  } else {
    evidence.push("No reusable workflow references this agent yet.");
    recommendations.push("Clarify when this agent should be selected, or keep it out of default workflows until evidence supports it.");
    patternKeys.push("no-workflow-refs");
    mutableFields.add("use_when");
    priority = "medium";
  }
  if (failingStages.length) {
    const failed = failingStages.reduce((sum, stage) => sum + stage.failedTasks, 0);
    const total = failingStages.reduce((sum, stage) => sum + stage.totalTasks, 0);
    evidence.push(`${failed}/${total} recent task(s) failed in stages connected to this agent.`);
    recommendations.push("Add stronger failure-mode handling, handoff expectations, and verification receipts for stages this agent touches.");
    patternKeys.push("failing-stages");
    mutableFields.add("prompt");
    mutableFields.add("outputs");
    priority = "high";
    riskLevel = "medium";
  }
  if (fallbackGroups.length) {
    evidence.push(`${fallbackGroups.length} routing/cost group(s) show fallback or high latency pressure.`);
    recommendations.push("Tune model-tier guidance and context budget so the router can choose cheaper fast models for routine work and reasoning models for risky work.");
    patternKeys.push("fallback-pressure");
    mutableFields.add("context_budget");
    mutableFields.add("prompt");
    priority = priority === "high" ? priority : "medium";
  }
  if (!joined.includes("receipt")) {
    evidence.push("Agent card does not explicitly require receipts or auditable evidence.");
    recommendations.push("Add receipt language so autonomous actions leave compact proof of what changed, why, and how it was verified.");
    patternKeys.push("missing-receipts");
    mutableFields.add("prompt");
  }
  if (!joined.includes("validat") && !joined.includes("test")) {
    evidence.push("Agent card does not strongly name validation or test expectations.");
    recommendations.push("Add role-specific validation expectations before the agent marks work complete.");
    patternKeys.push("missing-validation");
    mutableFields.add("prompt");
    mutableFields.add("can");
  }
  if ((agent.category === "automatic" || String(agent.autonomy) === "wide-open") && !agent.requires_approval.length) {
    evidence.push("Automatic/high-autonomy agent has no explicit approval boundary entries.");
    recommendations.push("Add explicit danger gates for destructive commands, network/export behavior, privilege expansion, and shared-definition edits.");
    patternKeys.push("missing-approval-boundary");
    mutableFields.add("requires_approval");
    priority = "high";
    riskLevel = "medium";
  }
  if ((agent.category === "product" || agent.id.includes("ux")) && !joined.includes("accessib")) {
    evidence.push("Product/UX agent does not explicitly mention accessibility.");
    recommendations.push("Add accessibility, responsive layout, and trust/polish review criteria to the role prompt.");
    patternKeys.push("missing-accessibility");
    mutableFields.add("prompt");
  }
  if ((agent.category === "development" || agent.id.includes("security")) && !joined.includes("secret") && !joined.includes("auth")) {
    evidence.push("Development/security-adjacent agent card does not explicitly mention auth or secret handling.");
    recommendations.push("Add scoped checks for auth boundaries, secrets, permissions, and blast radius when relevant to the role.");
    patternKeys.push("missing-secret-handling");
    mutableFields.add("prompt");
  }
  if (!recommendations.length) {
    return null;
  }

  const patternId = [...patternKeys].sort().join("+");
  const outcome = input.outcomeWeights.get(patternId);
  const outcomeEvidenceCount = outcome ? outcome.approvals + outcome.rejections : 0;
  const negativeOutcomeEvidence = Boolean(outcome
    && outcomeEvidenceCount >= AGENT_IMPROVEMENT_NEGATIVE_OUTCOME_MIN_EVIDENCE
    && outcome.weight <= AGENT_IMPROVEMENT_NEGATIVE_OUTCOME_MAX_WEIGHT);
  const learnedPriority: LearningProposalPriority = negativeOutcomeEvidence
    ? priority === "high" ? "medium" : "low"
    : priority;
  if (negativeOutcomeEvidence && outcome) {
    evidence.push(`Owner decisions rejected this pattern ${outcome.rejections}/${outcomeEvidenceCount} times; automatic application is disabled and priority is reduced.`);
  }
  const baseAutoApplyEligible = input.record.scope === "project-local" && agentImprovementRiskRank(riskLevel) <= agentImprovementRiskRank("medium") && !recommendations.some((item) => /autonomy|approval|permission|privilege|network|export/i.test(item));
  const autoApplyEligible = baseAutoApplyEligible && !negativeOutcomeEvidence;
  return {
    id: `agent-${agent.id.replace(/[^a-z0-9_-]/gi, "-")}-improvement`,
    agentId: agent.id,
    displayName: agent.display_name,
    scope: input.record.scope,
    category: agent.category,
    priority: learnedPriority,
    riskLevel,
    sourcePath: input.record.sourcePath,
    currentRoleSummary: agent.purpose,
    evidence: evidence.slice(0, 6),
    recommendation: dedupeStrings(recommendations).join(" "),
    suggestedMutableFields: [...mutableFields],
    safeResearchQueries: buildSafeAgentImprovementResearchQueries(agent),
    validationPlan: [
      "Validate updated agent YAML against the registry schema.",
      "Run npm run validate and npm run contract-test.",
      "Compare a small holdout set of recent tasks before/after the candidate prompt change.",
      "Check cost, fallback, failure, and user-feedback deltas before promotion."
    ],
    autoApplyEligible,
    approvalRequired: !autoApplyEligible,
    patternId,
    outcomeWeight: outcome?.weight ?? 0.5,
    outcomeEvidence: outcome ? { approvals: outcome.approvals, rejections: outcome.rejections } : null
  };
}

export async function buildAgentImprovementEval(
  ctx: CliContext, projectDir: string,
  patch: AgentImprovementPatch,
  runs: Awaited<ReturnType<typeof listWorkflowRunsForProject>>,
  scorecard: PreferenceScorecard
): Promise<AgentImprovementEval> {
  const sourceCurrent = await fs.readFile(resolveAgentPatchSourcePath(ctx, projectDir, patch), "utf8").then((value) => sha256(value) === patch.sourceHash).catch(() => false);
  const holdoutTasks = selectAgentImprovementHoldoutTasks(patch, runs);
  const agentGroups = scorecard.groups.filter((group) => group.agentId === patch.agentId);
  const hasFeedback = Object.values(scorecard.feedbackCounts).reduce((sum, count) => sum + count, 0) > 0;
  const fallbackPressure = agentGroups.some((group) => group.fallbackRate > 0 || (group.averageLatencyMs ?? 0) > 30_000);
  const gates: AgentImprovementEval["gates"] = [
    {
      id: "schema-valid",
      passed: patch.validation.schemaValid,
      weight: 20,
      message: patch.validation.schemaValid ? "Proposed YAML validates against the agent schema." : `Schema validation failed: ${patch.validation.errors.join("; ")}`
    },
    {
      id: "rollback-ready",
      passed: Boolean(patch.rollback.restoreSourceHash && patch.rollback.restorePath && sourceCurrent),
      weight: 15,
      message: sourceCurrent ? "Current source hash matches the patch preview rollback hash." : "Source changed since patch preview; regenerate before promotion."
    },
    {
      id: "holdout-coverage",
      passed: holdoutTasks.length >= 2,
      weight: 15,
      message: holdoutTasks.length >= 2 ? `${holdoutTasks.length} representative task(s) available for before/after comparison.` : `${holdoutTasks.length} representative task(s) found; collect more runs before promotion.`
    },
    {
      id: "risk-boundary",
      passed: patch.riskLevel !== "high" && !/privilege|provider|network|export|weaker safety|broader autonomy/i.test(patch.rationale),
      weight: 15,
      message: patch.riskLevel === "high" ? "High-risk patches require manual review." : "Patch stays within low/medium-risk role guidance."
    },
    {
      id: "evidence-signal",
      passed: hasFeedback || fallbackPressure || holdoutTasks.some((task) => task.status === "failed"),
      weight: 10,
      message: hasFeedback || fallbackPressure ? "Local feedback or routing evidence supports scoring this patch." : "No strong feedback/routing/failure signal yet; treat as speculative."
    },
    {
      id: "semantic-change",
      passed: patch.unifiedDiff.trim().length > 0,
      weight: 25,
      message: patch.unifiedDiff.trim().length > 0
        ? "Patch changes the canonical agent YAML (not just serialization)."
        : "Patch carries no semantic change after YAML canonicalization; pure re-wrapping churn cannot be promoted."
    }
  ];
  const score = gates.reduce((sum, gate) => sum + (gate.passed ? gate.weight : 0), 0);
  const status: AgentImprovementEval["status"] = score >= 80 ? "pass" : score >= 55 ? "warn" : "fail";
  const promotionReady = status === "pass" && patch.validation.schemaValid && sourceCurrent;
  const autoApplyReady = promotionReady && patch.scope === "project-local" && patch.autoApplyEligible && score >= 90 && agentImprovementRiskRank(patch.riskLevel) <= agentImprovementRiskRank("medium");
  return {
    id: `eval-${patch.id}`,
    patchId: patch.id,
    candidateId: patch.candidateId,
    agentId: patch.agentId,
    displayName: patch.displayName,
    scope: patch.scope,
    sourcePath: patch.sourcePath,
    priority: patch.priority,
    riskLevel: patch.riskLevel,
    score,
    status,
    promotionReady,
    autoApplyReady,
    holdoutTasks,
    gates,
    rollback: {
      ...patch.rollback,
      sourceHashCurrent: sourceCurrent
    },
    recommendation: promotionReady
      ? autoApplyReady ? "Eligible for future owner-enabled project-local auto-apply." : "Promotion-ready for manual review; shared or gated scope prevents autonomous apply."
      : "Do not promote yet; address failed gates or collect more holdout evidence."
  };
}

export async function buildAgentImprovementEvalPlan(ctx: CliContext, projectDir: string, patchPlan: AgentImprovementPatchPlan, ids: string[] | "all", limit: number): Promise<AgentImprovementEvalPlan> {
  const runs = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: Math.max(1, limit) });
  const scorecard = await loadPreferenceScorecard({ projectDir, limit: Math.max(1, limit) });
  const selectedPatches = patchPlan.patches.filter((patch) =>
    ids === "all" || ids.includes(patch.id) || ids.includes(patch.candidateId) || ids.includes(patch.agentId)
  );
  const selectedIds = selectedPatches.map((patch) => patch.id);
  const skippedIds = ids === "all" ? [] : ids.filter((id) => !selectedPatches.some((patch) => patch.id === id || patch.candidateId === id || patch.agentId === id));
  const evaluations = await Promise.all(selectedPatches.map((patch) => buildAgentImprovementEval(ctx, projectDir, patch, runs, scorecard)));
  const passCount = evaluations.filter((item) => item.status === "pass").length;
  const warnCount = evaluations.filter((item) => item.status === "warn").length;
  const failCount = evaluations.filter((item) => item.status === "fail").length;
  return {
    kind: "agentflow_agent_improvement_eval_plan",
    generatedAt: new Date().toISOString(),
    projectRootUri: projectDir,
    sourcePatchPlanGeneratedAt: patchPlan.generatedAt,
    selectedIds,
    skippedIds,
    evaluations,
    summary: [
      `${evaluations.length} agent improvement patch eval(s) scored.`,
      `${passCount} passed, ${warnCount} need more evidence, ${failCount} failed promotion gates.`,
      `${evaluations.filter((item) => item.promotionReady).length} promotion-ready preview(s).`,
      `${evaluations.filter((item) => item.autoApplyReady).length} future auto-apply-ready project-local preview(s).`
    ],
    promotionPolicy: {
      passThreshold: 80,
      autoApplyThreshold: 90,
      minimumHoldoutTasks: 2,
      maxRiskForAutoApply: "medium"
    },
    ownedLearningFiles: [
      ".agent-workflow/learning/agent-improvement-evals.json",
      ".agent-workflow/learning/agent-improvement-evals.md"
    ]
  };
}

export async function buildAgentImprovementPatchPlan(ctx: CliContext, projectDir: string, report: AgentImprovementReport, ids: string[] | "all"): Promise<AgentImprovementPatchPlan> {
  const candidates = report.candidates.filter((candidate) => ids === "all" || ids.includes(candidate.id) || ids.includes(candidate.agentId));
  const selectedIds = candidates.map((candidate) => candidate.id);
  const skippedIds = ids === "all" ? [] : ids.filter((id) => !selectedIds.includes(id) && !candidates.some((candidate) => candidate.agentId === id));
  const records = await loadAgentImprovementRecords(ctx, projectDir);
  const recordById = new Map(records.map((record) => [record.agent.id, record]));
  const patches: AgentImprovementPatch[] = [];
  for (const candidate of candidates) {
    const record = recordById.get(candidate.agentId);
    if (!record) {
      continue;
    }
    const absoluteSourcePath = resolveAgentImprovementSourcePath(ctx, projectDir, record);
    const sourceYaml = await fs.readFile(absoluteSourcePath, "utf8");
    const sourceHash = sha256(sourceYaml);
    const proposedAgent = proposeAgentImprovement(record.agent, candidate);
    const validation = agentCardSchema.safeParse(proposedAgent);
    const proposedYaml = YAML.stringify(proposedAgent);
    // Canonicalize before diffing (2026-09-28): YAML.stringify re-serializes
    // the agent card, so a raw text diff would flag pure re-wrapping churn as
    // a change. The canonical diff is empty for semantic no-ops, which the
    // promotion queue already marks superseded instead of pending.
    const canonicalSourceYaml = canonicalizeAgentImprovementYaml(sourceYaml);
    const canonicalProposedYaml = canonicalizeAgentImprovementYaml(proposedYaml);
    const unifiedDiff = buildUnifiedDiff(candidate.sourcePath, canonicalSourceYaml, canonicalProposedYaml);
    patches.push({
      id: `patch-${candidate.id}`,
      candidateId: candidate.id,
      agentId: candidate.agentId,
      displayName: candidate.displayName,
      scope: candidate.scope,
      sourcePath: candidate.sourcePath,
      sourceHash,
      priority: candidate.priority,
      riskLevel: candidate.riskLevel,
      approvalRequired: candidate.approvalRequired || candidate.scope === "shared",
      autoApplyEligible: candidate.autoApplyEligible && candidate.scope === "project-local" && validation.success,
      changedFields: candidate.suggestedMutableFields,
      patternId: candidate.patternId,
      rationale: buildGroundedAgentImprovementRationale(candidate, candidate.suggestedMutableFields, unifiedDiff),
      validation: {
        schemaValid: validation.success,
        errors: validation.success ? [] : validation.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      },
      unifiedDiff,
      proposedYaml,
      rollback: {
        restoreSourceHash: sourceHash,
        restorePath: candidate.sourcePath
      }
    });
  }

  return {
    kind: "agentflow_agent_improvement_patch_plan",
    generatedAt: new Date().toISOString(),
    projectRootUri: projectDir,
    sourceReportGeneratedAt: report.generatedAt,
    selectedIds,
    skippedIds,
    patches,
    summary: [
      `${patches.length} agent improvement patch preview(s) generated.`,
      `${patches.filter((patch) => patch.validation.schemaValid).length} schema-valid preview(s).`,
      `${patches.filter((patch) => patch.autoApplyEligible).length} low-risk project-local preview(s) would be eligible for a future explicit auto-apply setting.`,
      `${patches.filter((patch) => patch.approvalRequired).length} preview(s) require approval before touching agent YAML.`
    ],
    ownedLearningFiles: [
      ".agent-workflow/learning/agent-improvement-patches.json",
      ".agent-workflow/learning/agent-improvement-patches.md"
    ]
  };
}

export function buildAgentImprovementPromotionQueue(
  projectDir: string,
  patchPlan: AgentImprovementPatchPlan,
  evalPlan: AgentImprovementEvalPlan,
  ids: string[] | "all",
  existingQueue?: AgentImprovementPromotionQueue
): AgentImprovementPromotionQueue {
  const generatedAt = new Date().toISOString();
  const patchById = new Map(patchPlan.patches.map((patch) => [patch.id, patch]));
  const existingById = new Map((existingQueue?.items ?? []).map((item) => [item.id, item]));
  const selectedEvaluations = evalPlan.evaluations.filter((evaluation) =>
    evaluation.promotionReady &&
    (ids === "all" || ids.includes(evaluation.id) || ids.includes(evaluation.patchId) || ids.includes(evaluation.candidateId) || ids.includes(evaluation.agentId))
  );
  const selectedIds = selectedEvaluations.map((evaluation) => evaluation.id);
  const skippedIds = ids === "all" ? [] : ids.filter((id) =>
    !selectedEvaluations.some((evaluation) => evaluation.id === id || evaluation.patchId === id || evaluation.candidateId === id || evaluation.agentId === id)
  );
  const items: AgentImprovementPromotionItem[] = selectedEvaluations.flatMap((evaluation) => {
    const patch = patchById.get(evaluation.patchId);
    if (!patch) {
      return [];
    }
    const id = `promotion-${patch.id}`;
    const previous = existingById.get(id);
    const sourceHashStillMatches = previous?.sourceHash === patch.sourceHash && previous?.score === evaluation.score;
    const preservedStatus = sourceHashStillMatches && previous?.status !== "superseded" ? previous?.status ?? "pending" : "pending";
    const preserveDecision = sourceHashStillMatches && (preservedStatus === "approved" || preservedStatus === "rejected" || preservedStatus === "deferred");
    // No-op suppression (2026-09-28): buildUnifiedDiff returns "" when the
    // proposed YAML is byte-identical to the current source, i.e. the patch
    // carries no change. Such promotions can never be applied (the apply lane
    // skips empty diffs) and previously piled up as "pending" forever because
    // nothing ever retired them. Mark them superseded up front so the queue
    // only ever shows decisions worth a human's time.
    const isNoopPromotion = !patch.unifiedDiff;
    return [{
      id,
      patchId: patch.id,
      evalId: evaluation.id,
      candidateId: patch.candidateId,
      agentId: patch.agentId,
      displayName: patch.displayName,
      scope: patch.scope,
      status: isNoopPromotion ? "superseded" : preservedStatus,
      createdAt: sourceHashStillMatches ? previous?.createdAt ?? generatedAt : generatedAt,
      decidedAt: isNoopPromotion ? generatedAt : (preserveDecision ? previous?.decidedAt ?? null : null),
      reviewer: preserveDecision && !isNoopPromotion ? previous?.reviewer ?? null : null,
      note: isNoopPromotion
        ? "No-op: proposed YAML is identical to the current source; nothing to apply."
        : (preserveDecision ? previous?.note ?? null : null),
      score: evaluation.score,
      promotionReady: evaluation.promotionReady,
      autoApplyReady: evaluation.autoApplyReady,
      priority: patch.priority,
      riskLevel: patch.riskLevel,
      sourcePath: patch.sourcePath,
      sourceHash: patch.sourceHash,
      diff: patch.unifiedDiff,
      rollback: evaluation.rollback,
      approvalRequired: patch.scope === "shared" || patch.approvalRequired || !evaluation.autoApplyReady,
      recommendation: evaluation.recommendation,
      rationale: patch.rationale,
      patternId: patch.patternId
    }];
  });
  const currentIds = new Set(items.map((item) => item.id));
  const untouchedExistingItems = ids === "all"
    ? []
    : (existingQueue?.items ?? []).filter((item) => !currentIds.has(item.id));
  const supersededItems = ids === "all"
    ? (existingQueue?.items ?? [])
      .filter((item) => !currentIds.has(item.id) && item.status !== "rejected")
      .map((item) => ({
        ...item,
        status: "superseded" as const,
        decidedAt: item.decidedAt ?? generatedAt,
        note: item.note ?? "Superseded by a regenerated promotion queue or a no-longer-passing eval."
      }))
    : [];
  const allItems = [...items, ...untouchedExistingItems, ...supersededItems].sort((left, right) =>
    promotionStatusRank(left.status) - promotionStatusRank(right.status) ||
    priorityRank(right.priority) - priorityRank(left.priority) ||
    right.score - left.score ||
    left.agentId.localeCompare(right.agentId)
  );
  const queue: AgentImprovementPromotionQueue = {
    kind: "agentflow_agent_improvement_promotion_queue",
    generatedAt,
    updatedAt: generatedAt,
    projectRootUri: projectDir,
    sourceEvalPlanGeneratedAt: evalPlan.generatedAt,
    selectedIds,
    skippedIds,
    summary: [],
    items: allItems,
    ownedLearningFiles: [
      ".agent-workflow/learning/agent-improvement-promotions.json",
      ".agent-workflow/learning/agent-improvement-promotions.md",
      ".agent-workflow/learning/agent-improvement-promotion-receipts.json",
      ".agent-workflow/learning/agent-improvement-promotion-receipts.md"
    ]
  };
  return {
    ...queue,
    summary: summarizeAgentImprovementPromotionQueue(queue)
  };
}

export function buildAgentImprovementPromptNotes(candidate: AgentImprovementCandidate): string {
  const bullets = [
    "Leave compact receipts for autonomous or delegated work, including what changed, why, and how it was checked.",
    "Name the validation evidence needed before handoff, scaled to the risk of the task.",
    candidate.category === "product" ? "Include accessibility, responsive behavior, user trust, and polish in product-surface reviews." : "",
    candidate.category === "development" ? "Check auth, secret handling, permissions, and blast radius when the task touches runtime behavior." : "",
    candidate.category === "automatic" ? "Stop for approval before destructive, external, provider, privilege, or reusable-definition changes." : ""
  ].filter(Boolean);
  return [
    "Local learning improvement notes:",
    ...bullets.map((item) => `- ${item}`)
  ].join("\n");
}

export function buildCandidatePromotionRecommendation(input: {
  projectDir: string;
  suite: Omit<CandidateComparisonPlan, "files">["suites"][number] | null;
  outcome: DashboardCandidateComparisonReport["outcomes"][number];
}): DashboardCandidateComparisonReport["promotionRecommendations"][number] {
  const rationale: string[] = [];
  const suiteCommand = input.suite?.command ?? `npm run agentflow -- evaluate -s .agent-workflow/evaluations/${input.outcome.suiteId}.yaml -p ${shellQuote(input.projectDir)}`;
  if (!input.outcome.gateReady || input.outcome.qualityDelta === null) {
    rationale.push("Baseline and candidate evidence must both be present before promotion.");
    if (input.outcome.baselineRuns === 0) {
      rationale.push("No baseline evaluation run is recorded.");
    }
    if (input.outcome.candidateRuns === 0) {
      rationale.push("No candidate evaluation run is recorded.");
    }
    return {
      suiteId: input.outcome.suiteId,
      decision: "run_more_evals",
      severity: "warning",
      rationale,
      nextAction: suiteCommand
    };
  }
  const latencyDelta = input.outcome.latencyDeltaMs;
  const isMaterialQualityGain = input.outcome.qualityDelta >= 0.05;
  const isQualityRegression = input.outcome.qualityDelta < 0;
  const isLatencyRegression = latencyDelta !== null && latencyDelta > 500;
  if (isQualityRegression) {
    rationale.push(`Candidate quality is lower than baseline by ${input.outcome.qualityDelta}.`);
    if (latencyDelta !== null) {
      rationale.push(`Latency delta is ${formatDurationDelta(latencyDelta)}.`);
    }
    return {
      suiteId: input.outcome.suiteId,
      decision: "keep_baseline",
      severity: "warning",
      rationale,
      nextAction: "Keep the current baseline routing and review candidate prompt/provider changes before retesting."
    };
  }
  if (isLatencyRegression && !isMaterialQualityGain) {
    rationale.push(`Candidate quality delta is ${input.outcome.qualityDelta}, but latency is ${formatDurationDelta(latencyDelta)} slower.`);
    rationale.push("The quality gain is not large enough to justify a slower default route.");
    return {
      suiteId: input.outcome.suiteId,
      decision: "run_more_evals",
      severity: "warning",
      rationale,
      nextAction: "Add more representative eval cases or retest with a cheaper/faster candidate before changing routing."
    };
  }
  rationale.push(`Candidate quality delta is ${input.outcome.qualityDelta}.`);
  if (latencyDelta !== null) {
    rationale.push(`Latency delta is ${formatDurationDelta(latencyDelta)}.`);
  }
  rationale.push("Promotion should still be applied as a reviewed project-local routing note.");
  return {
    suiteId: input.outcome.suiteId,
    decision: "propose_routing_note",
    severity: "ready",
    rationale,
    nextAction: `Create a reviewed project-local note under .agent-workflow/tuning/ after running the gate command for ${input.outcome.suiteId}.`
  };
}

export function buildDashboardLocalProviderEvidence(scorecard: PreferenceScorecard): DashboardLocalProviderEvidence {
  const localProviderIds = new Set(["local", "byo", "openai-compatible"]);
  const localGroups = scorecard.groups.filter((group) => localProviderIds.has(group.providerId));
  const hostedGroups = scorecard.groups.filter((group) => !localProviderIds.has(group.providerId) && group.providerId !== "mock");
  const localStageCount = localGroups.reduce((sum, group) => sum + group.runs, 0);
  const hostedStageCount = hostedGroups.reduce((sum, group) => sum + group.runs, 0);
  const localAccepted = localGroups.reduce((sum, group) => sum + group.accepted, 0);
  const localRevised = localGroups.reduce((sum, group) => sum + group.revised, 0);
  const localRejected = localGroups.reduce((sum, group) => sum + group.rejected, 0);
  const localFallbackRate = weightedAverage(localGroups, (group) => group.fallbackRate, (group) => group.runs);
  const localAverageLatencyMs = weightedAverageNullable(localGroups, (group) => group.averageLatencyMs, (group) => group.runs);
  const localAverageQuality = weightedAverageNullable(localGroups, (group) => group.averageQuality, (group) => group.runs);
  const hostedAverageLatencyMs = weightedAverageNullable(hostedGroups, (group) => group.averageLatencyMs, (group) => group.runs);
  const hostedAverageQuality = weightedAverageNullable(hostedGroups, (group) => group.averageQuality, (group) => group.runs);
  const configured = Boolean(process.env.LOCAL_MODEL_BASE_URL || process.env.LOCAL_MODEL_NAME || process.env.BYO_MODEL_BASE_URL || process.env.OPENAI_COMPATIBLE_BASE_URL);
  const providerIds = [...new Set(localGroups.map((group) => group.providerId))].sort((a, b) => a.localeCompare(b));
  const signalCount = localAccepted + localRevised + localRejected;

  let status: DashboardLocalProviderEvidence["status"] = "not-configured";
  let recommendation = "Configure a local runtime or BYO-compatible endpoint before evaluating avoided hosted calls.";
  if (configured && localStageCount === 0) {
    status = "needs-runs";
    recommendation = "Run low-risk fast or standard stages through local routing to collect latency, quality, and fallback evidence.";
  } else if (localStageCount > 0 && signalCount === 0) {
    status = "watch";
    recommendation = "Local provider stages exist, but feedback is missing. Record accepted/revised/rejected outcomes before expanding routing.";
  } else if (localStageCount > 0 && (localFallbackRate ?? 0) > 0.2) {
    status = "watch";
    recommendation = "Local provider fallback rate is high. Keep local routing to low-risk stages until model selection or context improves.";
  } else if (localStageCount > 0 && localRejected > localAccepted) {
    status = "watch";
    recommendation = "Local provider feedback is weak. Compare against a hosted baseline before promoting more stages.";
  } else if (localStageCount > 0 && localAverageQuality !== null && hostedAverageQuality !== null && localAverageQuality + 0.05 < hostedAverageQuality) {
    status = "candidate";
    recommendation = "Local provider is saving hosted calls, but quality trails hosted runs. Keep local for fast stages and improve eval coverage.";
  } else if (localStageCount > 0) {
    status = "ready";
    recommendation = "Local provider evidence is healthy enough to consider more fast/standard stages, with hosted reasoning fallback preserved.";
  }

  return {
    status,
    configured,
    providerIds,
    localStageCount,
    hostedStageCount,
    localAccepted,
    localRevised,
    localRejected,
    localFallbackRate,
    localAverageLatencyMs,
    localAverageQuality,
    hostedAverageLatencyMs,
    hostedAverageQuality,
    estimatedAvoidedHostedCalls: localStageCount,
    recommendation
  };
}

export function buildDashboardRouteReceiptTrends(
  projectDir: string,
  reports: CostQualityReport[]
): DashboardRouteReceiptTrendReport {
  const localProviderIds = new Set(["local", "byo", "openai-compatible"]);
  const groups = new Map<string, DashboardRouteReceiptTrendGroup>();
  let localSelected = 0;
  let localSkipped = 0;
  let hostedFallback = 0;
  let hostedSelected = 0;
  for (const report of reports) {
    for (const stage of report.stages) {
      const classification = classifyDashboardRouteReceipt(stage, localProviderIds);
      if (classification === "local-selected") localSelected += 1;
      else if (classification === "local-skipped") localSkipped += 1;
      else if (classification === "hosted-fallback") hostedFallback += 1;
      else hostedSelected += 1;
      const key = [report.workflowId, stage.stageId, stage.agentId, stage.providerId, stage.modelTier, classification].join("|");
      const group = groups.get(key) ?? {
        workflowId: report.workflowId,
        stageId: stage.stageId,
        agentId: stage.agentId,
        providerId: stage.providerId,
        modelTier: stage.modelTier,
        classification,
        runs: 0,
        fallbackCount: 0,
        latencySamples: 0,
        qualitySamples: 0,
        averageLatencyMs: null,
        averageQuality: null,
        latestReason: ""
      };
      const latencyTotal = (group.averageLatencyMs ?? 0) * group.latencySamples;
      const qualityTotal = (group.averageQuality ?? 0) * group.qualitySamples;
      group.runs += 1;
      group.fallbackCount += stage.fallbackUsed ? 1 : 0;
      if (stage.latencyMs !== null) {
        group.latencySamples += 1;
        group.averageLatencyMs = Math.round((latencyTotal + stage.latencyMs) / group.latencySamples);
      }
      if (stage.qualityScore !== null) {
        group.qualitySamples += 1;
        group.averageQuality = Math.round(((qualityTotal + stage.qualityScore) / group.qualitySamples) * 1000) / 1000;
      }
      group.latestReason = stage.routeReason ?? group.latestReason;
      groups.set(key, group);
    }
  }
  const totalReceipts = localSelected + localSkipped + hostedFallback + hostedSelected;
  const topGroups = [...groups.values()].sort((a, b) =>
    b.runs - a.runs ||
    b.fallbackCount - a.fallbackCount ||
    a.workflowId.localeCompare(b.workflowId) ||
    a.stageId.localeCompare(b.stageId)
  ).slice(0, 12);
  return {
    generatedAt: new Date().toISOString(),
    projectRootUri: projectDir,
    reportsAnalyzed: reports.length,
    totalReceipts,
    localSelected,
    localSkipped,
    hostedFallback,
    hostedSelected,
    fallbackRate: totalReceipts ? Math.round((hostedFallback / totalReceipts) * 1000) / 1000 : null,
    localSelectionRate: totalReceipts ? Math.round((localSelected / totalReceipts) * 1000) / 1000 : null,
    topGroups
  };
}

export function buildGroundedAgentImprovementRationale(candidate: AgentImprovementCandidate, changedFields: string[], unifiedDiff: string): string {
  const added = unifiedDiff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removed = unifiedDiff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const observed = candidate.evidence.slice(0, 3).join(" ");
  const fields = changedFields.length ? changedFields.join(", ") : "none";
  const change = unifiedDiff
    ? `proposes edits to ${fields} (+${added}/-${removed} canonical diff lines)`
    : `proposes no semantic change to ${fields} after YAML canonicalization`;
  return `Observed: ${observed} This patch ${change}. Recommendation: ${candidate.recommendation}`;
}

export function buildLearningActionReceiptHealth(log: LearningActionReceiptLog, latestBackupPath: string | null = null): LearningActionReceiptHealth {
  const counts = countStrings(log.events.map((event) => event.status));
  const daemonOpenKeys = new Set<string>();
  let daemonOpenReceipts = 0;
  let duplicateDaemonOpenReceipts = 0;
  let latestReceiptAt: string | null = null;
  for (const event of log.events) {
    if (!latestReceiptAt || event.createdAt > latestReceiptAt) {
      latestReceiptAt = event.createdAt;
    }
    if (!shouldCompactLearningActionReceipt(event)) {
      continue;
    }
    daemonOpenReceipts += 1;
    const key = learningActionReceiptOpenKey(event);
    if (daemonOpenKeys.has(key)) {
      duplicateDaemonOpenReceipts += 1;
    } else {
      daemonOpenKeys.add(key);
    }
  }
  const recommendation = duplicateDaemonOpenReceipts > 0
    ? `Compact ${duplicateDaemonOpenReceipts} duplicate daemon-owned planned/applied receipt(s).`
    : "Receipt health is clean. No daemon-owned duplicates found.";
  return {
    kind: "agentflow_learning_action_receipt_health",
    projectRootUri: log.projectRootUri,
    generatedAt: new Date().toISOString(),
    updatedAt: log.updatedAt,
    totalReceipts: log.events.length,
    counts,
    daemonOpenReceipts,
    uniqueDaemonOpenReceipts: daemonOpenKeys.size,
    duplicateDaemonOpenReceipts,
    compactableReceiptCount: duplicateDaemonOpenReceipts,
    latestReceiptAt,
    latestBackupPath,
    recommendation
  };
}

export async function buildLocalLlmCacheTrendReport(
  projectDir: string,
  inventory: LocalLlmInventoryReport,
  prunePlan: LocalLlmPrunePlanReport,
  routeReceiptTrends: DashboardRouteReceiptTrendReport,
  appendCurrent: boolean
): Promise<LocalLlmCacheTrendReport> {
  const generatedAt = new Date().toISOString();
  const existing = await readLocalLlmCacheTrendHistory(projectDir);
  const current: LocalLlmCacheTrendPoint = {
    capturedAt: generatedAt,
    totalCacheBytes: inventory.totalCacheBytes,
    totalCacheLabel: inventory.totalCacheLabel,
    freeBytes: inventory.storage.freeBytes,
    freeRatio: inventory.storage.freeRatio,
    storageStatus: inventory.storage.status,
    modelCount: inventory.models.length,
    pruneCandidateCount: inventory.pruneCandidates.length,
    reclaimableBytes: prunePlan.reclaimableBytes,
    reclaimableLabel: prunePlan.reclaimableLabel,
    localSelected: routeReceiptTrends.localSelected,
    localSkipped: routeReceiptTrends.localSkipped,
    hostedFallback: routeReceiptTrends.hostedFallback,
    hostedSelected: routeReceiptTrends.hostedSelected
  };
  const history = appendCurrent ? compactLocalLlmCacheTrendPoints([...existing.points, current]) : existing.points;
  const comparison = compareLocalLlmCacheTrendPoints(history.at(-1) ?? null, current);
  const status: LocalLlmCacheTrendReport["status"] = history.length >= 2
    ? "tracking"
    : appendCurrent
      ? "started"
      : existing.points.length
        ? "tracking"
        : "no-history";
  const recommendation = inventory.storage.status === "pressure"
    ? "Storage pressure is active. Review prune plans before installing more local models."
    : current.pruneCandidateCount > 0
      ? "Review prune candidates and compare trend points before adding more local models."
      : history.length >= 2
        ? "Keep collecting trend points after local routing, benchmark, install, or prune events."
        : "Write the first trend snapshot, then refresh after local model or routing changes.";
  const document = {
    kind: "agentflow_local_llm_cache_trends" as const,
    generatedAt,
    projectRootUri: projectDir,
    status,
    current,
    history,
    comparison,
    recommendation
  };
  return {
    ...document,
    files: [
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-cache-trends.md",
        content: formatLocalLlmCacheTrendMarkdown(document)
      },
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-cache-trends.json",
        content: `${JSON.stringify(document, null, 2)}\n`
      }
    ]
  };
}

export async function buildLocalLlmCostLedgerReport(
  projectDir: string,
  routeReceiptTrends: DashboardRouteReceiptTrendReport,
  cacheTrends: LocalLlmCacheTrendReport,
  appendCurrent: boolean
): Promise<LocalLlmCostLedgerReport> {
  const generatedAt = new Date().toISOString();
  const assumptions = localLlmCostAssumptions();
  const localGroups = routeReceiptTrends.topGroups.filter((group) => group.classification === "local-selected");
  const fallbackGroups = routeReceiptTrends.topGroups.filter((group) => group.classification === "hosted-fallback");
  const hostedGroups = routeReceiptTrends.topGroups.filter((group) => group.classification === "hosted-selected");
  const avoidedHostedUsd = sumEstimatedStageCost(localGroups, assumptions.hostedUsdPerStageByTier);
  const fallbackHostedUsd = sumEstimatedStageCost(fallbackGroups, assumptions.hostedUsdPerStageByTier);
  const observedHostedUsd = sumEstimatedStageCost(hostedGroups, assumptions.hostedUsdPerStageByTier);
  const cacheGb = cacheTrends.current.totalCacheBytes / 1024 / 1024 / 1024;
  const storageUsdPerMonth = cacheGb * assumptions.localStorageUsdPerGbMonth;
  const benchmark = await readLatestLocalLlmBenchmarkSummary(projectDir);
  const current: LocalLlmCostLedgerPoint = {
    capturedAt: generatedAt,
    localSelectedStages: routeReceiptTrends.localSelected,
    localSkippedStages: routeReceiptTrends.localSkipped,
    hostedFallbackStages: routeReceiptTrends.hostedFallback,
    hostedSelectedStages: routeReceiptTrends.hostedSelected,
    avoidedHostedUsd,
    fallbackHostedUsd,
    observedHostedUsd,
    storageUsdPerMonth,
    netEstimatedSavingsUsd: avoidedHostedUsd - fallbackHostedUsd - storageUsdPerMonth,
    totalCacheBytes: cacheTrends.current.totalCacheBytes,
    totalCacheLabel: cacheTrends.current.totalCacheLabel,
    benchmarkAverageLatencyMs: benchmark.averageLatencyMs,
    benchmarkAverageScore: benchmark.averageRubricScore
  };
  const existing = await readLocalLlmCostLedgerHistory(projectDir);
  const history = appendCurrent ? compactLocalLlmCostLedgerPoints([...existing.points, current]) : existing.points;
  const previous = history.at(-1) ?? null;
  const comparison: LocalLlmCostLedgerComparison = {
    previousAt: previous?.capturedAt ?? null,
    netSavingsDeltaUsd: previous ? current.netEstimatedSavingsUsd - previous.netEstimatedSavingsUsd : null,
    avoidedHostedDeltaUsd: previous ? current.avoidedHostedUsd - previous.avoidedHostedUsd : null,
    storageDeltaUsd: previous ? current.storageUsdPerMonth - previous.storageUsdPerMonth : null,
    localStageDelta: previous ? current.localSelectedStages - previous.localSelectedStages : null
  };
  const status: LocalLlmCostLedgerReport["status"] = current.localSelectedStages === 0
    ? "needs-local-routes"
    : current.netEstimatedSavingsUsd > 0
      ? "saving"
      : "watch";
  const recommendation = current.localSelectedStages === 0
    ? "Run low-risk local route smoke or approved local routing before expecting savings evidence."
    : current.netEstimatedSavingsUsd > 0
      ? "Local routing is estimated to be saving money. Keep benchmarking quality before expanding scope."
      : "Local routing savings are not yet positive after fallback and storage estimates; review model size, fallback rate, and route mix.";
  const document = {
    kind: "agentflow_local_llm_cost_ledger" as const,
    generatedAt,
    projectRootUri: projectDir,
    status,
    assumptions,
    current,
    history,
    comparison,
    recommendation
  };
  return {
    ...document,
    files: [
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-cost-ledger.md",
        content: formatLocalLlmCostLedgerMarkdown(document)
      },
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-cost-ledger.json",
        content: `${JSON.stringify(document, null, 2)}\n`
      }
    ]
  };
}

export function buildLocalLlmDownloadRecommendationReport(input: {
  projectDir: string;
  scorecard: PreferenceScorecard;
  checklist: LocalLlmSetupChecklistReport;
  setupGuide: LocalLlmSetupGuideReport;
}): LocalLlmDownloadRecommendationReport {
  const generatedAt = new Date().toISOString();
  const memoryGb = Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10;
  const cpuCount = os.cpus().length;
  const hardwareClass: LocalLlmDownloadRecommendationReport["hardware"]["class"] = memoryGb >= 48
    ? "large"
    : memoryGb >= 24
      ? "medium"
      : "small";
  const taskMix = buildLocalLlmTaskMix(input.scorecard);
  const readyRuntime = input.setupGuide.recommendedRuntime
    ?? input.setupGuide.runtimes.find((runtime) => runtime.status === "ready")
    ?? null;
  const runtimeId = readyRuntime?.id ?? "ollama";
  const runtimeLabel = readyRuntime?.label ?? "Ollama";
  const installedModels = new Set((readyRuntime?.models ?? []).map((model) => model.toLowerCase()));
  const candidates = localModelCandidateCatalog(hardwareClass, taskMix);
  const recommendations = candidates.map((candidate, index): LocalLlmDownloadRecommendation => {
    const installed = candidate.aliases.some((alias) => installedModels.has(alias.toLowerCase()));
    const downloadCommand = localModelDownloadCommand(runtimeId, candidate.modelId);
    const configEnv = [
      `LOCAL_MODEL_${candidate.primaryTier.toUpperCase()}=${candidate.modelId}`,
      "LOCAL_MODEL_NAME=auto",
      readyRuntime ? `LOCAL_MODEL_BASE_URL=${readyRuntime.baseUrl}` : "LOCAL_MODEL_BASE_URL=http://localhost:11434/v1"
    ];
    return {
      id: `local-model-${index + 1}`,
      priority: index === 0 ? "high" : index <= 2 ? "medium" : "low",
      modelId: candidate.modelId,
      label: candidate.label,
      runtime: runtimeLabel,
      tierFit: candidate.tierFit,
      primaryTier: candidate.primaryTier,
      hardwareFit: candidate.hardwareFit,
      installed,
      downloadCommand,
      configEnv,
      rationale: [
        candidate.reason,
        taskMix.dominantTier === candidate.primaryTier
          ? `Matches the current dominant task tier (${taskMix.dominantTier}).`
          : `Complements the current dominant task tier (${taskMix.dominantTier}).`,
        installed ? "Already appears in the detected runtime catalog." : "Not detected in the current local runtime catalog."
      ]
    };
  });
  const recommended = recommendations.find((item) => item.installed) ?? recommendations[0] ?? null;
  const status: LocalLlmDownloadRecommendationReport["status"] = readyRuntime
    ? recommendations.some((item) => item.installed) ? "ready" : "download-needed"
    : "runtime-needed";
  const nextAction = status === "ready"
    ? `Run npm run agentflow -- local-llm-smoke --project ${shellQuote(input.projectDir)} to verify local route selection.`
    : status === "download-needed" && recommended
      ? `${recommended.downloadCommand}; then run npm run agentflow -- local-llm-checklist --project ${shellQuote(input.projectDir)}.`
      : "Start Ollama, LM Studio, vLLM, or llama.cpp server, then rerun local-llm-download-recommendations.";
  const document = {
    kind: "agentflow_local_llm_download_recommendations" as const,
    generatedAt,
    projectRootUri: input.projectDir,
    status,
    hardware: {
      platform: process.platform,
      arch: process.arch,
      cpuCount,
      memoryGb,
      class: hardwareClass
    },
    taskMix,
    runtime: readyRuntime ? {
      id: readyRuntime.id,
      label: readyRuntime.label,
      baseUrl: readyRuntime.baseUrl,
      modelCount: readyRuntime.modelCount
    } : null,
    checklistStatus: input.checklist.status,
    firstLocalSmokeSuccessAt: input.checklist.smokeOutcomes.firstSuccessAt,
    latestSmokeIssue: input.checklist.smokeOutcomes.latestFailureReason,
    recommendedModelId: recommended?.modelId ?? null,
    recommendations,
    nextAction
  };
  return {
    ...document,
    files: [
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-download-recommendations.md",
        content: formatLocalLlmDownloadRecommendationMarkdown(document)
      },
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-download-recommendations.json",
        content: `${JSON.stringify(document, null, 2)}\n`
      }
    ]
  };
}

export function buildLocalLlmInstallationPlanReport(
  projectDir: string,
  recommendations: LocalLlmDownloadRecommendationReport,
  selectedModels: string
): LocalLlmInstallationPlanReport {
  const requested = selectedModels.trim() || "recommended";
  const requestedSet = new Set(requested === "recommended" || requested === "all" ? [] : parseProposalIds(requested));
  const selected = recommendations.recommendations.filter((item) => {
    if (requested === "all") return true;
    if (requested === "recommended") return item.modelId === recommendations.recommendedModelId || item.priority === "high";
    return requestedSet.has(item.id) || requestedSet.has(item.modelId);
  });
  const generatedAt = new Date().toISOString();
  const actions = selected.map((item, index): LocalLlmInstallationAction => {
    const diskEstimateGb = estimateLocalModelDiskGb(item.modelId);
    const diskRisk = diskEstimateGb >= 18 ? "high" : diskEstimateGb >= 8 ? "medium" : "low";
    const downloadCommand = item.downloadCommand;
    const verifyCommand = `npm run agentflow -- local-llm-checklist --project ${shellQuote(projectDir)}`;
    const benchmarkCommand = `npm run agentflow -- local-llm-benchmarks --project ${shellQuote(projectDir)} --execute --write`;
    return {
      id: `install-${String(index + 1).padStart(3, "0")}`,
      modelId: item.modelId,
      runtime: item.runtime,
      primaryTier: item.primaryTier,
      priority: item.priority,
      installed: item.installed,
      hardwareFit: item.hardwareFit,
      diskEstimateGb,
      risk: diskRisk === "high" || item.primaryTier === "reasoning" ? "high" : diskRisk,
      commands: [
        { id: "download", label: "Download model", command: downloadCommand, requiresApproval: true, reason: "Downloads model artifacts and may use significant disk and network." },
        { id: "verify", label: "Verify local catalog", command: verifyCommand, requiresApproval: false, reason: "Read-only Agent Workflow setup check after the runtime refreshes its model catalog." },
        { id: "benchmark", label: "Benchmark locally", command: benchmarkCommand, requiresApproval: false, reason: "Calls only the local OpenAI-compatible endpoint to create promotion evidence." }
      ],
      envHints: item.configEnv,
      notes: item.rationale
    };
  });
  const missingIds = requested === "recommended" || requested === "all"
    ? []
    : [...requestedSet].filter((id) => !selected.some((item) => item.id === id || item.modelId === id));
  const status: LocalLlmInstallationPlanReport["status"] = actions.length
    ? actions.every((action) => action.installed) ? "already-installed" : "ready-for-review"
    : "no-selection";
  const nextAction = actions.length
    ? "Review the download commands, run only the models you want to install, then run the verify and benchmark commands."
    : "Run local-llm-download-recommendations first, then select a recommendation id or model id.";
  const document = {
    kind: "agentflow_local_llm_installation_plan" as const,
    generatedAt,
    projectRootUri: projectDir,
    status,
    selectedModels: requested,
    recommendationSourceGeneratedAt: recommendations.generatedAt,
    runtimeStatus: recommendations.status,
    recommendedModelId: recommendations.recommendedModelId,
    missingIds,
    actions,
    safety: {
      executesDownloads: false,
      editsProviderSettings: false,
      writesProjectSource: false,
      approvalBoundary: "Download, provider-setting, and disk-heavy actions are emitted as commands for the operator to approve and run outside this planner."
    },
    nextAction
  };
  return {
    ...document,
    files: [
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-installation-plan.md",
        content: formatLocalLlmInstallationPlanMarkdown(document)
      },
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-installation-plan.json",
        content: `${JSON.stringify(document, null, 2)}\n`
      },
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-installation-plan.sh",
        content: formatLocalLlmInstallationPlanShell(document)
      }
    ]
  };
}

export async function buildLocalLlmInventoryReport(
  projectDir: string,
  setupGuide: LocalLlmSetupGuideReport,
  downloads: LocalLlmDownloadRecommendationReport,
  installPlan: LocalLlmInstallationPlanReport,
  recentRouteReports: CostQualityReport[]
): Promise<LocalLlmInventoryReport> {
  const generatedAt = new Date().toISOString();
  const roots = await Promise.all(localModelCacheRoots().map(readLocalModelCacheRoot));
  const existingRoots = roots.filter((root) => root.exists);
  const totalCacheBytes = existingRoots.reduce((sum, root) => sum + root.sizeBytes, 0);
  const storage = await readStoragePressure(existingRoots[0]?.path ?? os.homedir());
  const lastUsedByModel = await loadLocalModelLastUsedMap(projectDir, recentRouteReports);
  const runtimeModels = new Set(setupGuide.runtimes.flatMap((runtime) => runtime.models));
  const recommendedIds = new Set(downloads.recommendations.map((item) => item.modelId));
  const modelEntries: LocalLlmInventoryModel[] = [];
  for (const modelId of [...runtimeModels].sort((a, b) => a.localeCompare(b))) {
    modelEntries.push({
        modelId,
        source: "runtime-catalog",
        cacheRoot: setupGuide.runtimes.find((runtime) => runtime.models.includes(modelId))?.label ?? "local runtime",
        cachePath: null,
        sizeBytes: null,
        sizeLabel: "unknown",
        installed: true,
        recommended: recommendedIds.has(modelId),
      lastUsedAt: lastUsedByModel.get(modelId) ?? null,
      pruneCandidate: false,
      reason: "Detected from a live local /v1/models catalog."
    });
  }
  const directoryModels = await readDirectoryModelEntries(existingRoots, lastUsedByModel, recommendedIds);
  for (const entry of directoryModels) {
    if (!modelEntries.some((item) => item.modelId === entry.modelId && item.source === entry.source)) {
      modelEntries.push(entry);
    }
  }
  const pruneCandidates = modelEntries.filter((model) => model.pruneCandidate);
  const status: LocalLlmInventoryReport["status"] = existingRoots.length
    ? storage.freeRatio !== null && storage.freeRatio < 0.12 ? "storage-pressure" : "ready"
    : "no-cache-found";
  const nextAction = status === "storage-pressure"
    ? "Review prune candidates before downloading more local models."
    : installPlan.actions.length
      ? "Review the local model installation plan before downloading additional models."
      : "Start a local runtime or run local-llm-download-recommendations before inventory can connect cache usage to recommendations.";
  const document = {
    kind: "agentflow_local_llm_inventory" as const,
    generatedAt,
    projectRootUri: projectDir,
    status,
    storage,
    cacheRoots: roots,
    totalCacheBytes,
    totalCacheLabel: formatBytes(totalCacheBytes),
    models: modelEntries.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || a.modelId.localeCompare(b.modelId)),
    pruneCandidates,
    recommendation: nextAction
  };
  return {
    ...document,
    files: [
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-inventory.md",
        content: formatLocalLlmInventoryMarkdown(document)
      },
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-inventory.json",
        content: `${JSON.stringify(document, null, 2)}\n`
      }
    ]
  };
}

export function buildLocalLlmPrunePlanReport(
  projectDir: string,
  inventory: LocalLlmInventoryReport,
  selectedModels: string
): LocalLlmPrunePlanReport {
  const generatedAt = new Date().toISOString();
  const requested = selectedModels.trim() || "candidates";
  const requestedSet = new Set(requested === "candidates" || requested === "all" ? [] : parseProposalIds(requested));
  const selectableModels = requested === "all" ? inventory.models : inventory.pruneCandidates;
  const selected = selectableModels.filter((model, index) => {
    const actionId = `prune-${String(index + 1).padStart(3, "0")}`;
    if (requested === "all" || requested === "candidates") return true;
    return requestedSet.has(actionId) || requestedSet.has(model.modelId);
  });
  const actions = selected.map((model, index): LocalLlmPruneAction => {
    const actionId = `prune-${String(index + 1).padStart(3, "0")}`;
    const cachePath = model.cachePath;
    const command = cachePath
      ? `rm -rf ${shellQuote(cachePath)}`
      : `# Review ${shellQuote(model.modelId)} in ${shellQuote(model.cacheRoot)}; no cache path was detected for an automatic command.`;
    return {
      id: actionId,
      modelId: model.modelId,
      cacheRoot: model.cacheRoot,
      cachePath,
      sizeBytes: model.sizeBytes,
      sizeLabel: model.sizeLabel,
      lastUsedAt: model.lastUsedAt,
      recommended: model.recommended,
      pruneCandidate: model.pruneCandidate,
      risk: cachePath && !model.recommended && model.pruneCandidate ? "medium" : "high",
      command,
      requiresApproval: true,
      reason: model.pruneCandidate
        ? model.reason
        : "Selected model is not a default prune candidate, so removal needs extra operator review."
    };
  });
  const missingIds = requested === "all" || requested === "candidates"
    ? []
    : [...requestedSet].filter((id) => !actions.some((action) => action.id === id || action.modelId === id));
  const reclaimableBytes = actions.reduce((sum, action) => sum + (action.sizeBytes ?? 0), 0);
  const status: LocalLlmPrunePlanReport["status"] = actions.length
    ? actions.some((action) => action.risk === "high") ? "needs-review" : "ready-for-review"
    : "no-candidates";
  const nextAction = actions.length
    ? "Review the generated cleanup commands, run only the removals you trust, then refresh local-llm-inventory."
    : "No stale local model cache candidates were found. Keep collecting usage evidence before pruning.";
  const document = {
    kind: "agentflow_local_llm_prune_plan" as const,
    generatedAt,
    projectRootUri: projectDir,
    status,
    selectedModels: requested,
    inventoryGeneratedAt: inventory.generatedAt,
    actions,
    missingIds,
    reclaimableBytes,
    reclaimableLabel: formatBytes(reclaimableBytes),
    safety: {
      executesDeletes: false,
      editsProviderSettings: false,
      writesProjectSource: false,
      approvalBoundary: "Cleanup commands are emitted for explicit operator review. Agent Workflow does not execute local model deletion from this planner."
    },
    nextAction
  };
  return {
    ...document,
    files: [
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-prune-plan.md",
        content: formatLocalLlmPrunePlanMarkdown(document)
      },
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-prune-plan.json",
        content: `${JSON.stringify(document, null, 2)}\n`
      },
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-prune-plan.sh",
        content: formatLocalLlmPrunePlanShell(document)
      }
    ]
  };
}

export function buildLocalLlmRoutingRecommendationReport(input: {
  projectDir: string;
  localProviderEvidence: DashboardLocalProviderEvidence;
  routeReceiptTrends: DashboardRouteReceiptTrendReport;
  costLedger: LocalLlmCostLedgerReport;
  cacheTrends: LocalLlmCacheTrendReport;
  routeDecisionFeedback?: RouteDecisionFeedbackLog;
}): LocalLlmRoutingRecommendationReport {
  const generatedAt = new Date().toISOString();
  const feedbackLog = input.routeDecisionFeedback ?? {
    kind: "agentflow_route_decision_feedback" as const,
    projectRootUri: input.projectDir,
    updatedAt: new Date(0).toISOString(),
    events: []
  };
  const feedbackCounts = countStrings(feedbackLog.events.map((event) => event.rating));
  const recommendations = buildLocalLlmRoutingRecommendations(input.routeReceiptTrends, input.costLedger, input.cacheTrends, feedbackLog);
  const expand = recommendations.filter((item) => item.action === "expand").length;
  const hold = recommendations.filter((item) => item.action === "hold").length;
  const retreat = recommendations.filter((item) => item.action === "retreat").length;
  const status: LocalLlmRoutingRecommendationReport["status"] = !input.localProviderEvidence.configured
    ? "needs-local-provider"
    : !input.routeReceiptTrends.totalReceipts
      ? "needs-route-evidence"
      : retreat > 0
        ? "retreat"
        : expand > 0
          ? "expand"
          : "hold";
  const summary = [
    `${recommendations.length} local routing recommendation(s).`,
    `Expand=${expand}, hold=${hold}, retreat=${retreat}.`,
    `Net estimated savings=${formatUsd(input.costLedger.current.netEstimatedSavingsUsd)}.`,
    `Route feedback: helpful=${feedbackCounts.helpful ?? 0}, costly=${feedbackCounts.costly ?? 0}, neutral=${feedbackCounts.neutral ?? 0}.`,
    input.cacheTrends.current.pruneCandidateCount > 0
      ? `${input.cacheTrends.current.pruneCandidateCount} prune candidate(s) may affect local economics.`
      : "No prune pressure is currently affecting local economics."
  ];
  const nextAction = status === "needs-local-provider"
    ? "Configure a local/OpenAI-compatible provider and run a low-risk local route smoke before expanding local routing."
    : status === "needs-route-evidence"
      ? "Run local-llm-smoke or a low-risk workflow with local routing so this report can compare real route outcomes."
      : status === "expand"
        ? "Review expand candidates, then promote the safest low-risk stages through project-local routing notes."
        : status === "retreat"
          ? "Review retreat candidates before more local runs; fallback or quality evidence indicates local routing is not paying off everywhere."
          : "Keep current local routing boundaries and collect more feedback, benchmark, and cost snapshots.";
  const document = {
    kind: "agentflow_local_llm_routing_recommendations" as const,
    generatedAt,
    projectRootUri: input.projectDir,
    status,
    summary,
    recommendations,
    evidence: {
      localProviderStatus: input.localProviderEvidence.status,
      configured: input.localProviderEvidence.configured,
      netEstimatedSavingsUsd: input.costLedger.current.netEstimatedSavingsUsd,
      storageStatus: input.cacheTrends.current.storageStatus,
      pruneCandidateCount: input.cacheTrends.current.pruneCandidateCount,
      routeReceipts: input.routeReceiptTrends.totalReceipts,
      localSelected: input.routeReceiptTrends.localSelected,
      localSkipped: input.routeReceiptTrends.localSkipped,
      hostedFallback: input.routeReceiptTrends.hostedFallback,
      hostedSelected: input.routeReceiptTrends.hostedSelected,
      routeFeedbackEvents: feedbackLog.events.length,
      routeFeedbackCounts: feedbackCounts
    },
    nextAction
  };
  return {
    ...document,
    files: [
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-routing-recommendations.md",
        content: formatLocalLlmRoutingRecommendationMarkdown(document)
      },
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-routing-recommendations.json",
        content: `${JSON.stringify(document, null, 2)}\n`
      }
    ]
  };
}

export function buildLocalLlmRoutingRecommendations(
  routeReceiptTrends: DashboardRouteReceiptTrendReport,
  costLedger: LocalLlmCostLedgerReport,
  cacheTrends: LocalLlmCacheTrendReport,
  routeDecisionFeedback: RouteDecisionFeedbackLog
): LocalLlmRoutingRecommendation[] {
  return buildSavingsAwareLocalRoutingRecommendations({
    routeGroups: routeReceiptTrends.topGroups,
    netEstimatedSavingsUsd: costLedger.current.netEstimatedSavingsUsd,
    storagePressure: cacheTrends.current.storageStatus === "pressure",
    routeFeedbackEvents: routeDecisionFeedback.events.map(routeDecisionFeedbackEventForScorer)
  });
}

export function buildLocalLlmSmokeOutcomeTrend(
  projectDir: string,
  runs: DashboardRunStatus[],
  reports: CostQualityReport[]
): LocalLlmSmokeOutcomeTrend {
  const reportByRunId = new Map(reports.map((report) => [report.runId, report]));
  const smokeRuns = runs.filter(isLocalLlmSmokeRun);
  const counts: LocalLlmSmokeOutcomeTrend["counts"] = {
    "local-selected": 0,
    "local-skipped": 0,
    "hosted-fallback": 0,
    "hosted-selected": 0,
    missing: 0,
    failed: 0
  };
  const latestOutcomes = smokeRuns.map((run) => {
    const report = reportByRunId.get(run.id) ?? null;
    const route = report?.stages[0] ?? null;
    const routeClass: LocalLlmSmokeOutcome["routeClass"] = route ? classifyDashboardRouteReceipt(route) : "missing";
    if (run.status === "failed") counts.failed += 1;
    else counts[routeClass] += 1;
    return {
      runId: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      status: run.status,
      routeClass,
      providerId: route?.providerId ?? null,
      model: route?.model ?? null,
      modelTier: route?.modelTier ?? null,
      requestedModelTier: route?.requestedModelTier ?? run.modelTierOverride ?? null,
      routeReason: route?.routeReason ?? null,
      qualityScore: route?.qualityScore ?? null,
      fallbackUsed: route?.fallbackUsed ?? false
    };
  });
  const localSuccesses = latestOutcomes
    .filter((outcome) => outcome.status === "completed" && outcome.routeClass === "local-selected")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const latestOutcome = latestOutcomes[0] ?? null;
  let latestFailureReason: string | null = null;
  if (latestOutcome) {
    if (latestOutcome.status === "failed") {
      latestFailureReason = "Latest local LLM smoke run failed before completing local route verification.";
    } else if (latestOutcome.routeClass === "local-skipped") {
      latestFailureReason = "Local routing was requested but the local endpoint or selected model was unavailable.";
    } else if (latestOutcome.routeClass === "hosted-fallback") {
      latestFailureReason = `Hosted fallback used after ${latestOutcome.providerId ?? "unknown provider"} route.`;
    } else if (latestOutcome.routeClass === "hosted-selected") {
      latestFailureReason = `Hosted provider selected (${latestOutcome.providerId ?? "unknown"}); local did not win this smoke route.`;
    } else if (latestOutcome.routeClass === "missing") {
      latestFailureReason = "No model_route receipt was found for the latest smoke run.";
    }
  }

  let recommendation = `Run npm run agentflow -- local-llm-smoke --project ${shellQuote(projectDir)} to create first local routing evidence.`;
  if (latestOutcome?.status === "failed") {
    recommendation = "Fix the latest smoke failure, then rerun local-llm-smoke to verify the local route.";
  } else if (latestOutcome?.routeClass === "local-selected") {
    recommendation = "Local smoke is selecting a local/BYO provider. Keep collecting quality, latency, fallback, and feedback evidence before expanding beyond low-risk stages.";
  } else if (latestOutcome?.routeClass === "local-skipped") {
    recommendation = "Start or download a compatible local model, confirm /v1/models lists it, then rerun the low-risk local smoke.";
  } else if (latestOutcome?.routeClass === "hosted-selected") {
    recommendation = "Local is not winning the route. Include local in AGENTFLOW_AUTO_PROVIDERS or set DEFAULT_MODEL_PROVIDER=auto/local, then rerun the smoke.";
  } else if (latestOutcome?.routeClass === "hosted-fallback") {
    recommendation = "A hosted fallback was used. Check local endpoint reliability, selected model id, and holdout promotion before trusting local for more stages.";
  } else if (latestOutcome?.routeClass === "missing") {
    recommendation = "The latest smoke did not leave route evidence. Re-run the smoke and inspect worker/provider logs if it repeats.";
  }

  return {
    kind: "agentflow_local_llm_smoke_outcomes",
    generatedAt: new Date().toISOString(),
    projectRootUri: projectDir,
    runsAnalyzed: runs.length,
    smokeRuns: smokeRuns.length,
    counts,
    firstSuccessAt: localSuccesses[0]?.startedAt ?? null,
    latestSuccessAt: localSuccesses.at(-1)?.startedAt ?? null,
    latestSmokeAt: latestOutcome?.startedAt ?? null,
    latestFailureReason,
    latestOutcomes: latestOutcomes.slice(0, 8),
    recommendation
  };
}

export function buildLocalLlmTaskMix(scorecard: PreferenceScorecard): LocalLlmDownloadRecommendationReport["taskMix"] {
  const tierCounts = countStrings(scorecard.groups.flatMap((group) => Array.from({ length: Math.max(0, group.runs) }, () => group.modelTier)));
  const workflowCounts = countStrings(scorecard.groups.flatMap((group) => Array.from({ length: Math.max(0, group.runs) }, () => group.workflowId)));
  const dominantTier = (Object.entries(tierCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "fast") as ModelTier;
  const topWorkflows = Object.entries(workflowCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([workflowId, runs]) => ({ workflowId, runs }));
  return {
    runsAnalyzed: scorecard.runsAnalyzed,
    dominantTier: parseModelTierOption(dominantTier),
    tierCounts,
    topWorkflows,
    costSavingsGoal: scorecard.groups.some((group) => group.modelTier === "fast" || group.modelTier === "standard")
      ? "Move low-risk fast and standard developer stages to local first, with hosted fallback preserved."
      : "Start with low-risk summarization and triage before attempting reasoning-heavy local routes."
  };
}

export function buildPromotionRoutingNotePlan(
  report: DashboardCandidateComparisonReport,
  selectedSuiteIds: string[] | "all" = "all"
): DashboardPromotionRoutingNotePlan {
  const requestedSuiteIds = selectedSuiteIds === "all"
    ? report.promotionRecommendations.map((recommendation) => recommendation.suiteId)
    : selectedSuiteIds;
  const requestedSet = new Set(requestedSuiteIds);
  const selectedRecommendations = report.promotionRecommendations.filter((recommendation) =>
    requestedSet.has(recommendation.suiteId) && recommendation.decision === "propose_routing_note"
  );
  const selectedSet = new Set(selectedRecommendations.map((recommendation) => recommendation.suiteId));
  const generatedAt = new Date().toISOString();
  const notes = selectedRecommendations.map((recommendation) => {
    const suite = report.comparisonPlan?.suites.find((item) => item.id === recommendation.suiteId) ?? null;
    const outcome = report.outcomes.find((item) => item.suiteId === recommendation.suiteId) ?? null;
    const gateCommand = report.comparisonPlan?.gateCommands.find((command) => command.includes("--gate") || command.includes(" gate ")) ?? report.comparisonPlan?.gateCommands[0] ?? null;
    return {
      suiteId: recommendation.suiteId,
      workflowId: suite?.workflowId ?? "unknown",
      baseline: report.comparisonPlan?.baseline ?? null,
      candidate: report.comparisonPlan?.candidate ?? null,
      qualityDelta: outcome?.qualityDelta ?? null,
      latencyDeltaMs: outcome?.latencyDeltaMs ?? null,
      gateCommand,
      rationale: recommendation.rationale,
      draftNote: [
        `Prefer the candidate route for ${suite?.workflowId ?? recommendation.suiteId} only after the recorded gate passes.`,
        report.comparisonPlan?.candidate
          ? `Candidate: ${report.comparisonPlan.candidate.provider}/${report.comparisonPlan.candidate.modelTier}.`
          : "Candidate route details were not available.",
        outcome?.qualityDelta !== null && outcome?.qualityDelta !== undefined
          ? `Observed quality delta: ${outcome.qualityDelta}.`
          : "Quality delta must be confirmed before applying.",
        outcome?.latencyDeltaMs !== null && outcome?.latencyDeltaMs !== undefined
          ? `Observed latency delta: ${formatDurationDelta(outcome.latencyDeltaMs)}.`
          : "Latency delta must be confirmed before applying."
      ].join(" ")
    };
  });
  const document = {
    kind: "agentflow_promotion_routing_note_plan" as const,
    projectRootUri: report.projectDir,
    generatedAt,
    sourceComparisonPlanGeneratedAt: report.comparisonPlan?.generatedAt ?? null,
    selectedSuiteIds: selectedRecommendations.map((recommendation) => recommendation.suiteId),
    skippedSuiteIds: requestedSuiteIds.filter((suiteId) => !selectedSet.has(suiteId)),
    notes
  };
  return {
    ...document,
    files: [
      {
        relativePath: ".agent-workflow/tuning/promotion-routing-note-plan.md",
        content: formatPromotionRoutingNotePlanMarkdown(document)
      },
      {
        relativePath: ".agent-workflow/tuning/promotion-routing-note-plan.json",
        content: `${JSON.stringify(document, null, 2)}\n`
      }
    ]
  };
}

export function buildSafeAgentImprovementResearchQueries(agent: AgentCard): string[] {
  const role = agent.display_name || agent.id;
  const category = agent.category;
  return [
    `best practices for ${role} AI agent role in software development workflows`,
    `evaluation checklist for ${category} AI coding agent quality and reliability`,
    `prompt design patterns for ${role} agent receipts validation and handoffs`
  ];
}

export function buildUnifiedDiff(filePath: string, before: string, after: string): string {
  if (before === after) {
    return "";
  }
  const beforeLines = before.trimEnd().split("\n");
  const afterLines = after.trimEnd().split("\n");
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ full-file preview @@",
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`)
  ].join("\n");
}

export function canonicalizeAgentImprovementYaml(text: string): string {
  try {
    const parsed = YAML.parse(text);
    if (parsed === undefined || parsed === null) {
      return text;
    }
    return YAML.stringify(parsed);
  } catch {
    return text;
  }
}

// Grounded rationales (2026-09-28): the patch rationale used to be the
// templated candidate recommendation verbatim. Ground it in the actual
// observation (candidate evidence), the concrete change (changed fields plus
// canonical diff line stat), then keep the recommendation as the why. The
// recommendation text is preserved inside the rationale so the risk-boundary
// eval gate keeps seeing the same danger keywords it matched before.

export function canonicalizeDashboardDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.password = "";
    url.username = "";
    url.hostname = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
    return url.toString();
  } catch {
    return value;
  }
}

export function classifyDashboardRouteReceipt(
  stage: CostQualityReport["stages"][number],
  localProviderIds = new Set(["local", "byo", "openai-compatible"])
): DashboardRouteReceiptTrendGroup["classification"] {
  const routeReason = stage.routeReason ?? "";
  const localish = localProviderIds.has(stage.providerId);
  if (/local-holdout routing preference was present, but local was not ready/i.test(routeReason)) {
    return "local-skipped";
  }
  if (stage.fallbackUsed) {
    return "hosted-fallback";
  }
  if (localish) {
    return "local-selected";
  }
  return "hosted-selected";
}

export function classifyFeedbackTarget(target: DashboardFeedbackTarget): DashboardFeedbackClassification {
  const failures = target.summary?.failures.length ?? 0;
  const failedTasks = target.summary?.failedTasks ?? 0;
  const findings = target.summary?.keyFindings.length ?? 0;
  const averageQuality = target.quality?.averageQuality ?? null;
  const fallbackCount = target.quality?.fallbackCount ?? 0;
  const qualityFailures = target.quality?.qualityFailCount ?? 0;
  if (target.status === "failed" && findings === 0) {
    return { bucket: "probably_reject", reason: "The run failed and did not produce useful findings." };
  }
  if (averageQuality !== null && averageQuality < 0.5) {
    return { bucket: "probably_reject", reason: `Average quality is ${averageQuality}, below the useful-result threshold.` };
  }
  if (target.status === "completed" && failedTasks === 0 && failures === 0 && qualityFailures === 0 && fallbackCount === 0 && (averageQuality === null || averageQuality >= 0.75)) {
    return { bucket: "probably_accept", reason: "The run completed cleanly with useful quality signals and no fallback or failure evidence." };
  }
  if (target.status === "failed" && findings > 0) {
    return { bucket: "probably_revise", reason: "The run failed, but produced findings that may still be useful learning signal." };
  }
  if (failedTasks > 0 || failures > 0 || qualityFailures > 0 || fallbackCount > 0) {
    return { bucket: "probably_revise", reason: "The run has useful evidence plus review-worthy failure, quality, or fallback signals." };
  }
  return { bucket: "probably_revise", reason: "The run needs a human check before treating it as accepted signal." };
}

export async function cleanupRuntimeMcpProcesses(ctx: CliContext, input: { execute: boolean; pids?: number[]; autoLowRiskOnly?: boolean; staleMinutes?: number }): Promise<RuntimeMcpCleanupResult> {
  const candidates = await loadRuntimeMcpCleanupCandidates(ctx, { staleMinutes: input.staleMinutes });
  const allowedPids = new Set(candidates.map((candidate) => candidate.pid));
  const selectedCandidates = input.pids?.length
    ? candidates.filter((candidate) => input.pids?.includes(candidate.pid) && allowedPids.has(candidate.pid))
    : candidates;
  const executableCandidates = input.autoLowRiskOnly
    ? selectedCandidates.filter((candidate) => candidate.autoCleanable && candidate.risk === "low")
    : selectedCandidates;
  const requestedPids = executableCandidates.map((candidate) => candidate.pid);
  const warnings: string[] = [];
  const terminated: RuntimeMcpCleanupResult["terminated"] = [];
  if (!input.execute) {
    return {
      kind: "agentflow_mcp_cleanup_result",
      generatedAt: new Date().toISOString(),
      mode: "preview",
      candidates,
      terminated,
      warnings
    };
  }
  for (const pid of requestedPids) {
    if (pid === process.pid || !allowedPids.has(pid)) {
      terminated.push({ pid, status: "skipped", message: "PID is not an eligible Agent Workflow MCP cleanup candidate." });
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      terminated.push({ pid, status: "sent", message: "SIGTERM sent." });
    } catch (error) {
      warnings.push(`Failed to terminate ${pid}: ${error instanceof Error ? error.message : String(error)}`);
      terminated.push({ pid, status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    kind: "agentflow_mcp_cleanup_result",
    generatedAt: new Date().toISOString(),
    mode: "execute",
    candidates,
    terminated,
    warnings
  };
}

export function collectArtifactFindings(artifacts: Array<{ content: Record<string, unknown> }>): string[] {
  const findings: string[] = [];
  for (const artifact of artifacts) {
    for (const value of Object.values(artifact.content)) {
      collectFindingValue(value, findings);
    }
  }
  return [...new Set(findings.map((finding) => finding.trim()).filter(Boolean))];
}

export function collectFindingValue(value: unknown, findings: string[]): void {
  if (findings.length >= 20) {
    return;
  }
  if (typeof value === "string") {
    if (value.length > 20 && value.length < 280 && !/^[0-9a-f-]{24,}$/i.test(value)) {
      findings.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFindingValue(item, findings);
    }
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["summary", "finding", "issue", "risk", "nextAction", "recommendation"]) {
      if (key in record) {
        collectFindingValue(record[key], findings);
      }
    }
  }
}

export function compactAutonomousTuningApprovalHistory(history: TuningApprovalHistory): TuningApprovalHistory {
  const seen = new Set<string>();
  const events = history.events.filter((event) => {
    if (event.status !== "applied" || event.actor !== "learning-daemon" || event.note !== "autonomous local tuning overlay") {
      return true;
    }
    const key = tuningHistoryEventSignature(event);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  if (events.length === history.events.length) {
    return history;
  }
  return {
    ...history,
    updatedAt: new Date().toISOString(),
    events
  };
}

export async function compactLearningActionReceiptFiles(projectDir: string): Promise<LearningActionReceiptCompactionResult> {
  const receipts = await readLearningActionReceipts(projectDir).catch(() => emptyLearningActionReceipts(projectDir));
  const before = buildLearningActionReceiptHealth(receipts, await latestLearningActionReceiptBackupPath(projectDir));
  const compacted = compactLearningActionReceipts(receipts);
  const backupPaths: string[] = [];
  if (compacted.events.length !== receipts.events.length) {
    const learningDir = path.join(projectDir, ".agent-workflow", "learning");
    await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = path.join(learningDir, "action-receipts.json");
    const markdownPath = path.join(learningDir, "action-receipts.md");
    const jsonBackup = path.join(learningDir, `action-receipts.json.bak-${stamp}`);
    const markdownBackup = path.join(learningDir, `action-receipts.md.bak-${stamp}`);
    await fs.copyFile(jsonPath, jsonBackup).catch(() => undefined);
    await fs.copyFile(markdownPath, markdownBackup).catch(() => undefined);
    backupPaths.push(jsonBackup, markdownBackup);
    await writeLearningActionReceipts(projectDir, compacted);
  }
  const afterReceipts = compacted.events.length !== receipts.events.length ? compacted : receipts;
  return {
    kind: "agentflow_learning_action_receipt_compaction",
    projectRootUri: projectDir,
    generatedAt: new Date().toISOString(),
    before,
    after: buildLearningActionReceiptHealth(afterReceipts, backupPaths[0] ?? before.latestBackupPath),
    removedReceipts: receipts.events.length - compacted.events.length,
    backupPaths
  };
}

export function compactLearningActionReceipts(log: LearningActionReceiptLog, updatedAt = new Date().toISOString()): LearningActionReceiptLog {
  const seen = new Set<string>();
  const events: LearningActionReceipt[] = [];
  for (const event of log.events) {
    if (!shouldCompactLearningActionReceipt(event)) {
      events.push(event);
      continue;
    }
    const key = learningActionReceiptOpenKey(event);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    events.push(event);
  }
  if (events.length === log.events.length) {
    return log;
  }
  return {
    ...log,
    updatedAt,
    events
  };
}

export function compactLocalLlmCacheTrendPoints(points: LocalLlmCacheTrendPoint[]): LocalLlmCacheTrendPoint[] {
  const byTimestamp = new Map<string, LocalLlmCacheTrendPoint>();
  for (const point of points) byTimestamp.set(point.capturedAt, point);
  return [...byTimestamp.values()]
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .slice(-120);
}

export function compactLocalLlmCostLedgerPoints(points: LocalLlmCostLedgerPoint[]): LocalLlmCostLedgerPoint[] {
  const byTimestamp = new Map<string, LocalLlmCostLedgerPoint>();
  for (const point of points) byTimestamp.set(point.capturedAt, point);
  return [...byTimestamp.values()]
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .slice(-120);
}

export function compareLocalLlmCacheTrendPoints(previous: LocalLlmCacheTrendPoint | null, current: LocalLlmCacheTrendPoint): LocalLlmCacheTrendComparison {
  return {
    previousAt: previous?.capturedAt ?? null,
    cacheDeltaBytes: previous ? current.totalCacheBytes - previous.totalCacheBytes : null,
    cacheDeltaLabel: previous ? formatSignedBytes(current.totalCacheBytes - previous.totalCacheBytes) : "n/a",
    freeDeltaBytes: previous && current.freeBytes !== null && previous.freeBytes !== null ? current.freeBytes - previous.freeBytes : null,
    freeDeltaLabel: previous && current.freeBytes !== null && previous.freeBytes !== null ? formatSignedBytes(current.freeBytes - previous.freeBytes) : "n/a",
    modelDelta: previous ? current.modelCount - previous.modelCount : null,
    pruneCandidateDelta: previous ? current.pruneCandidateCount - previous.pruneCandidateCount : null,
    localRouteDelta: previous ? current.localSelected - previous.localSelected : null,
    hostedRouteDelta: previous ? current.hostedSelected - previous.hostedSelected : null
  };
}

export async function countModelDirectories(root: string, depth: number): Promise<number> {
  async function walk(current: string, level: number): Promise<number> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    const directories = entries.filter((entry) => entry.isDirectory());
    if (level >= depth) return directories.length;
    const counts = await Promise.all(directories.map((entry) => walk(path.join(current, entry.name), level + 1)));
    return counts.reduce((sum, count) => sum + count, 0);
  }
  return walk(root, 1);
}

export async function decideAgentImprovementPromotions(input: {
  projectDir: string;
  queue: AgentImprovementPromotionQueue;
  ids: string[] | "all";
  status: Extract<AgentImprovementPromotionStatus, "approved" | "rejected" | "deferred">;
  reviewer?: string;
  note?: string;
}): Promise<AgentImprovementPromotionDecisionResult> {
  const matching = input.queue.items.filter((item) =>
    input.ids === "all" || input.ids.includes(item.id) || input.ids.includes(item.patchId) || input.ids.includes(item.evalId) || input.ids.includes(item.candidateId) || input.ids.includes(item.agentId)
  );
  const selected = matching.filter((item) => item.status === "pending" || item.status === "deferred");
  const selectedIds = selected.map((item) => item.id);
  const skippedIds = input.ids === "all" ? [] : input.ids.filter((id) =>
    !matching.some((item) => item.id === id || item.patchId === id || item.evalId === id || item.candidateId === id || item.agentId === id)
  );
  const now = new Date().toISOString();
  const queueDraft = {
    ...input.queue,
    updatedAt: now,
    items: input.queue.items.map((item) => selectedIds.includes(item.id)
      ? {
        ...item,
        status: input.status,
        decidedAt: now,
        reviewer: input.reviewer ?? "local-operator",
        note: input.note ?? `${input.status} from agent-improvement-promotions`
      }
      : item)
  };
  const queue = {
    ...queueDraft,
    summary: summarizeAgentImprovementPromotionQueue(queueDraft)
  };
  const existingReceipts = await readAgentImprovementPromotionReceipts(input.projectDir).catch(() => emptyAgentImprovementPromotionReceipts(input.projectDir));
  const existingKeys = new Set(existingReceipts.events.map((event) => `${event.promotionId}\0${event.status}\0${event.sourceHash}`));
  const events = selected.flatMap((item) => {
    const key = `${item.id}\0${input.status}\0${item.sourceHash}`;
    if (existingKeys.has(key)) {
      return [];
    }
    return [{
      id: `receipt-${input.status}-${item.id}-${now.replace(/[^0-9]/g, "")}`,
      promotionId: item.id,
      patchId: item.patchId,
      evalId: item.evalId,
      agentId: item.agentId,
      status: input.status,
      score: item.score,
      riskLevel: item.riskLevel,
      scope: item.scope,
      actor: input.reviewer ?? "local-operator",
      note: input.note ?? `${input.status} from agent-improvement-promotions`,
      sourcePath: item.sourcePath,
      sourceHash: item.sourceHash,
      rollback: item.rollback,
      createdAt: now,
      patternId: item.patternId ?? "legacy"
    }];
  });
  const receipts = {
    ...existingReceipts,
    updatedAt: now,
    events: [...existingReceipts.events, ...events]
  };
  await writeAgentImprovementPromotionReceipts(input.projectDir, receipts);
  return { queue, receipts, selectedIds, skippedIds };
}

export function dedupeStrings(items: string[]): string[] {
  return [...new Set(items)];
}

export function defaultFeedbackNote(target: DashboardFeedbackTarget, rating: FeedbackRating): string {
  if (rating === "rejected") {
    return target.status === "failed"
      ? "Failed or not useful enough to repeat."
      : "Wrong direction or not useful for this task.";
  }
  if (rating === "revised") {
    return "Partly useful, but future runs should adjust scope, evidence, or routing.";
  }
  if (target.status === "failed") {
    return "Useful failure evidence despite the failed run.";
  }
  if ((target.quality?.qualityFailCount ?? 0) > 0 || target.summary?.failures.length) {
    return "Useful result with review-worthy quality or failure evidence.";
  }
  if (target.summary?.keyFindings.length) {
    return "Useful findings for this task.";
  }
  return "";
}

export async function detectLocalLlmRuntimeCandidates(): Promise<LocalLlmRuntimeProbe[]> {
  const configuredUrl = process.env.LOCAL_MODEL_BASE_URL;
  const candidates = [
    configuredUrl ? { id: "configured-local", label: "Configured LOCAL_MODEL_BASE_URL", baseUrl: configuredUrl, commandHint: "Use the runtime already configured in .env." } : null,
    { id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1", commandHint: "ollama serve; ollama pull qwen2.5-coder:7b" },
    { id: "lm-studio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", commandHint: "Open LM Studio, load a model, and start the Local Server." },
    { id: "vllm", label: "vLLM", baseUrl: "http://localhost:8000/v1", commandHint: "python -m vllm.entrypoints.openai.api_server --model <model>" },
    { id: "llama-cpp", label: "llama.cpp server", baseUrl: "http://localhost:8080/v1", commandHint: "llama-server --model <model.gguf> --port 8080" }
  ].filter((candidate): candidate is { id: string; label: string; baseUrl: string; commandHint: string } => Boolean(candidate));
  const seen = new Set<string>();
  const uniqueCandidates = candidates.filter((candidate) => {
    const key = candidate.baseUrl.replace(/\/+$/u, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return Promise.all(uniqueCandidates.map(async (candidate) => {
    const discovered = await discoverModelIds(() => loadOpenAICompatibleModelIds(candidate.baseUrl, process.env.LOCAL_MODEL_API_KEY));
    const tierModels = loadGenericTierModelPreview({
      catalog: discovered.models,
      provider: "compatible",
      baseModel: process.env.LOCAL_MODEL_NAME || "auto",
      tierEnvPrefix: "LOCAL_MODEL"
    }).map((item) => ({
      tier: parseModelTierOption(item.tier),
      model: item.model,
      source: item.source
    }));
    return {
      ...candidate,
      status: discovered.models.length > 0 ? "ready" : discovered.error ? "missing" : "empty",
      models: discovered.models.slice(0, 20),
      modelCount: discovered.models.length,
      selectedTierModels: tierModels,
      detail: discovered.error
        ? `Model list check failed: ${discovered.error}`
        : discovered.models.length
          ? `${discovered.models.length} model(s) listed.`
          : "Endpoint responded but listed no models.",
      nextAction: discovered.models.length
        ? "Use this endpoint with LOCAL_MODEL_BASE_URL and LOCAL_MODEL_NAME=auto, then run local-llm-smoke."
        : candidate.commandHint
    };
  }));
}

export async function discoverModelIds(loader: () => Promise<string[]>): Promise<{ models: string[]; error?: string }> {
  try {
    return { models: await loader() };
  } catch (error) {
    return { models: [], error: safeErrorMessage(error) };
  }
}

export async function discoverProjectRoadmap(projectDir: string): Promise<{ relativePath: string; exists: boolean }> {
  const configPath = path.join(projectDir, ".agent-workflow", "project.yaml");
  let configuredPath: string | undefined;
  try {
    const raw = YAML.parse(await fs.readFile(configPath, "utf8")) as { project?: { roadmap_path?: unknown } };
    if (typeof raw?.project?.roadmap_path === "string" && raw.project.roadmap_path.trim()) {
      configuredPath = raw.project.roadmap_path.trim();
    }
  } catch {}
  if (configuredPath) {
    const absolutePath = await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: configuredPath, label: "roadmap_path" });
    return { relativePath: configuredPath, exists: await pathIsFile(absolutePath) };
  }
  const candidates = [...roadmapCandidates];
  for (const relativePath of candidates) {
    const absolutePath = await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath, label: "roadmap_path" });
    if (await pathIsFile(absolutePath)) return { relativePath, exists: true };
  }
  return { relativePath: configuredPath ?? "ROADMAP.md", exists: false };
}

export function emptyAgentImprovementPromotionReceipts(projectDir: string): AgentImprovementPromotionReceiptLog {
  return {
    kind: "agentflow_agent_improvement_promotion_receipts",
    projectRootUri: projectDir,
    updatedAt: new Date().toISOString(),
    events: []
  };
}

export function emptyLearningActionReceipts(projectRootUri: string): LearningActionReceiptLog {
  return {
    kind: "agentflow_learning_action_receipts",
    projectRootUri,
    updatedAt: new Date().toISOString(),
    events: []
  };
}

export function emptyOfflineFallbackQueue(): OfflineFallbackQueue {
  return {
    kind: "agentflow_offline_fallback_queue",
    version: 1,
    updatedAt: new Date().toISOString(),
    items: []
  };
}

export function emptyOfflineSyncSchedulerStatus(): OfflineSyncSchedulerStatus {
  return {
    kind: "agentflow_offline_sync_scheduler_status",
    updatedAt: new Date().toISOString(),
    status: "idle",
    mode: "dry-run",
    pendingQueueItems: 0,
    lastRunAt: null,
    nextRunAfter: null,
    lastResultPath: null,
    message: "Offline sync scheduler has not run yet."
  };
}

export function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function estimateLocalModelDiskGb(modelId: string): number {
  const lower = modelId.toLowerCase();
  if (lower.includes("32b")) return 22;
  if (lower.includes("14b")) return 10;
  if (lower.includes("8b") || lower.includes("7b")) return 5;
  return 8;
}

export function formatAgentImprovementPromotionQueueMarkdown(queue: AgentImprovementPromotionQueue): string {
  const rows = queue.items.map((item) => [
    `## ${item.displayName} (${item.agentId})`,
    "",
    `- Promotion: ${item.id}`,
    `- Status: ${item.status}`,
    `- Score: ${item.score}/100`,
    `- Scope: ${item.scope}`,
    `- Risk: ${item.riskLevel}`,
    `- Approval required: ${item.approvalRequired ? "yes" : "no"}`,
    `- Auto-apply ready: ${item.autoApplyReady ? "yes" : "no"}`,
    `- Source: ${item.sourcePath}`,
    `- Source hash: ${item.sourceHash}`,
    `- Rollback hash current: ${item.rollback.sourceHashCurrent ? "yes" : "no"}`,
    `- Recommendation: ${item.recommendation}`,
    "",
    "Rationale:",
    "",
    item.rationale,
    "",
    "Diff:",
    "",
    "```diff",
    item.diff || "(no diff)",
    "```"
  ].join("\n")).join("\n\n");
  return [
    "# Agent Improvement Promotion Queue",
    "",
    `Generated: ${queue.generatedAt}`,
    `Updated: ${queue.updatedAt}`,
    `Project: ${queue.projectRootUri}`,
    `Source eval plan: ${queue.sourceEvalPlanGeneratedAt}`,
    "",
    "## Summary",
    "",
    ...queue.summary.map((item) => `- ${item}`),
    "",
    rows || "No promotion-ready agent improvement patches.",
    ""
  ].join("\n");
}

export function formatAgentImprovementPromotionReceiptsMarkdown(receipts: AgentImprovementPromotionReceiptLog): string {
  return [
    "# Agent Improvement Promotion Receipts",
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
        `- Source hash: ${event.sourceHash}`,
        `- Rollback hash current: ${event.rollback.sourceHashCurrent ? "yes" : "no"}`
      ].join("\n")).join("\n\n")
      : ["No promotion decisions recorded yet."]),
    ""
  ].join("\n");
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${formatOneDecimal(ms / 1000)}s`;
  }
  return `${formatOneDecimal(ms / 60_000)}m`;
}

export function formatDurationDelta(ms: number): string {
  const prefix = ms > 0 ? "+" : ms < 0 ? "-" : "";
  return `${prefix}${formatDuration(Math.abs(ms))}`;
}

export function formatLearningActionReceipts(log: LearningActionReceiptLog): string {
  const counts = countStrings(log.events.map((event) => event.status));
  return [
    `Learning Action Receipts: ${log.projectRootUri}`,
    `Updated: ${log.updatedAt}`,
    `Counts: planned=${counts.planned ?? 0} applied=${counts.applied ?? 0} superseded=${counts.superseded ?? 0} rejected=${counts.rejected ?? 0}`,
    "",
    log.events.length
      ? log.events.map((event) => [
        `- ${event.id} ${event.status}: ${event.title}`,
        `  - Action: ${event.actionId}`,
        `  - Proposal: ${event.proposalId}`,
        `  - Type: ${event.actionType}`,
        `  - Gate: ${event.dangerGate}`,
        `  - Owned learning state only: ${event.writesOwnedLearningStateOnly ? "yes" : "no"}`,
        `  - Actor: ${event.actor}`,
        `  - Note: ${event.note}`
      ].join("\n")).join("\n")
      : "- No learning action receipts yet."
  ].join("\n");
}

export function formatLearningActionReceiptsMarkdown(log: LearningActionReceiptLog): string {
  return [
    "# Agent Workflow Learning Action Receipts",
    "",
    `Project: ${log.projectRootUri}`,
    `Updated: ${log.updatedAt}`,
    "",
    "These receipts are append-only local learning state. They record proposal-to-action planning, superseded plans, and rejected planned actions. They do not execute commands or apply source, provider, reusable bundle, network, or private-data changes.",
    "",
    formatLearningActionReceipts(log),
    ""
  ].join("\n");
}

export function formatLocalLlmCacheTrendMarkdown(report: Omit<LocalLlmCacheTrendReport, "files">): string {
  const rows = report.history.slice(-25).map((point) =>
    `| ${point.capturedAt} | ${point.totalCacheLabel} | ${point.freeBytes === null ? "unknown" : formatBytes(point.freeBytes)} | ${point.storageStatus} | ${point.modelCount} | ${point.pruneCandidateCount} | ${point.reclaimableLabel} | ${point.localSelected} | ${point.hostedSelected} |`
  ).join("\n");
  return [
    "# Agent Workflow Local LLM Cache Trends",
    "",
    `Generated: ${report.generatedAt}`,
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    "",
    "This compact project-local history tracks local model cache size, storage pressure, prune candidates, and local-vs-hosted usage over time. It stores aggregate trend points only; it does not delete files or edit provider settings.",
    "",
    "## Current Snapshot",
    "",
    `- Total cache: ${report.current.totalCacheLabel}`,
    `- Free disk: ${report.current.freeBytes === null ? "unknown" : formatBytes(report.current.freeBytes)}`,
    `- Storage status: ${report.current.storageStatus}`,
    `- Models: ${report.current.modelCount}`,
    `- Prune candidates: ${report.current.pruneCandidateCount}`,
    `- Potential reclaim: ${report.current.reclaimableLabel}`,
    `- Local selected routes: ${report.current.localSelected}`,
    `- Hosted selected routes: ${report.current.hostedSelected}`,
    "",
    "## Latest Delta",
    "",
    `- Previous snapshot: ${report.comparison.previousAt ?? "none"}`,
    `- Cache delta: ${report.comparison.cacheDeltaLabel}`,
    `- Free disk delta: ${report.comparison.freeDeltaLabel}`,
    `- Model delta: ${report.comparison.modelDelta ?? "n/a"}`,
    `- Prune candidate delta: ${report.comparison.pruneCandidateDelta ?? "n/a"}`,
    `- Local route delta: ${report.comparison.localRouteDelta ?? "n/a"}`,
    `- Hosted route delta: ${report.comparison.hostedRouteDelta ?? "n/a"}`,
    "",
    "## History",
    "",
    "| Captured | Cache | Free Disk | Storage | Models | Prune Candidates | Reclaimable | Local Selected | Hosted Selected |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    rows || "| none | n/a | n/a | n/a | 0 | 0 | 0 B | 0 | 0 |",
    "",
    "## Recommendation",
    "",
    report.recommendation,
    ""
  ].join("\n");
}

export function formatLocalLlmCostLedgerMarkdown(report: Omit<LocalLlmCostLedgerReport, "files">): string {
  const rows = report.history.slice(-25).map((point) =>
    `| ${point.capturedAt} | ${point.localSelectedStages} | ${point.hostedFallbackStages} | ${point.hostedSelectedStages} | ${formatUsd(point.avoidedHostedUsd)} | ${formatUsd(point.fallbackHostedUsd)} | ${formatUsd(point.storageUsdPerMonth)} | ${formatUsd(point.netEstimatedSavingsUsd)} |`
  ).join("\n");
  return [
    "# Agent Workflow Local LLM Cost Ledger",
    "",
    `Generated: ${report.generatedAt}`,
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    "",
    "This project-local ledger estimates local-model savings from routed stage counts, benchmark latency evidence, and local model cache storage. It is an estimate, not a provider bill. Update the `AGENTFLOW_COST_LEDGER_*` environment variables for your actual provider and storage assumptions.",
    "",
    "## Assumptions",
    "",
    `- Source: ${report.assumptions.source}`,
    `- Fast hosted stage: ${formatUsd(report.assumptions.hostedUsdPerStageByTier.fast)}`,
    `- Standard hosted stage: ${formatUsd(report.assumptions.hostedUsdPerStageByTier.standard)}`,
    `- Reasoning hosted stage: ${formatUsd(report.assumptions.hostedUsdPerStageByTier.reasoning)}`,
    `- Local storage: ${formatUsd(report.assumptions.localStorageUsdPerGbMonth)} per GB-month`,
    "",
    "## Current Estimate",
    "",
    `- Net estimated savings: ${formatUsd(report.current.netEstimatedSavingsUsd)}`,
    `- Avoided hosted cost: ${formatUsd(report.current.avoidedHostedUsd)}`,
    `- Fallback hosted cost: ${formatUsd(report.current.fallbackHostedUsd)}`,
    `- Local storage/month: ${formatUsd(report.current.storageUsdPerMonth)}`,
    `- Local selected stages: ${report.current.localSelectedStages}`,
    `- Hosted fallback stages: ${report.current.hostedFallbackStages}`,
    `- Cache size: ${report.current.totalCacheLabel}`,
    `- Benchmark latency: ${report.current.benchmarkAverageLatencyMs ?? "n/a"} ms`,
    `- Benchmark score: ${report.current.benchmarkAverageScore ?? "n/a"}`,
    "",
    "## Latest Delta",
    "",
    `- Previous snapshot: ${report.comparison.previousAt ?? "none"}`,
    `- Net savings delta: ${report.comparison.netSavingsDeltaUsd === null ? "n/a" : formatUsd(report.comparison.netSavingsDeltaUsd)}`,
    `- Avoided hosted delta: ${report.comparison.avoidedHostedDeltaUsd === null ? "n/a" : formatUsd(report.comparison.avoidedHostedDeltaUsd)}`,
    `- Storage delta: ${report.comparison.storageDeltaUsd === null ? "n/a" : formatUsd(report.comparison.storageDeltaUsd)}`,
    `- Local stage delta: ${report.comparison.localStageDelta ?? "n/a"}`,
    "",
    "## History",
    "",
    "| Captured | Local Stages | Fallback Stages | Hosted Stages | Avoided Hosted | Fallback Cost | Storage/Month | Net Savings |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    rows || "| none | 0 | 0 | 0 | $0.0000 | $0.0000 | $0.0000 | $0.0000 |",
    "",
    "## Recommendation",
    "",
    report.recommendation,
    ""
  ].join("\n");
}

export function formatLocalLlmDownloadRecommendationMarkdown(report: Omit<LocalLlmDownloadRecommendationReport, "files">): string {
  const rows = report.recommendations.map((item) =>
    `| ${item.priority} | ${item.modelId} | ${item.primaryTier} | ${item.hardwareFit} | ${item.installed ? "yes" : "no"} | \`${item.downloadCommand}\` | ${item.rationale.join(" ")} |`
  ).join("\n");
  return [
    "# Agent Workflow Local LLM Download Recommendations",
    "",
    `Generated: ${report.generatedAt}`,
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    "",
    "This project-local report recommends local model downloads from hardware, detected runtime catalog, task mix, quality history, and local smoke evidence. It does not install models, edit `.env`, modify provider settings, or change shared workflows.",
    "",
    "## Hardware",
    "",
    `- Platform: ${report.hardware.platform}/${report.hardware.arch}`,
    `- CPU cores: ${report.hardware.cpuCount}`,
    `- Memory: ${report.hardware.memoryGb} GB`,
    `- Class: ${report.hardware.class}`,
    "",
    "## Task Mix",
    "",
    `- Runs analyzed: ${report.taskMix.runsAnalyzed}`,
    `- Dominant tier: ${report.taskMix.dominantTier}`,
    `- Cost-savings goal: ${report.taskMix.costSavingsGoal}`,
    "",
    "## Evidence",
    "",
    `- Runtime: ${report.runtime ? `${report.runtime.label} at ${report.runtime.baseUrl}` : "none detected"}`,
    `- Checklist status: ${report.checklistStatus}`,
    `- First local smoke success: ${report.firstLocalSmokeSuccessAt ?? "none"}`,
    `- Latest smoke issue: ${report.latestSmokeIssue ?? "none"}`,
    "",
    "## Recommendations",
    "",
    "| Priority | Model | Tier | Hardware Fit | Installed | Download | Rationale |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    rows || "| none | n/a | n/a | n/a | no | n/a | Start a local OpenAI-compatible runtime first. |",
    "",
    "## Next Action",
    "",
    report.nextAction,
    ""
  ].join("\n");
}

export function formatLocalLlmInstallationPlanMarkdown(report: Omit<LocalLlmInstallationPlanReport, "files">): string {
  const sections = report.actions.map((action) => [
    `## ${action.id} - ${action.modelId}`,
    "",
    `- Priority: ${action.priority}`,
    `- Tier: ${action.primaryTier}`,
    `- Runtime: ${action.runtime}`,
    `- Hardware fit: ${action.hardwareFit}`,
    `- Estimated disk: ${action.diskEstimateGb} GB`,
    `- Risk: ${action.risk}`,
    `- Already installed: ${action.installed ? "yes" : "no"}`,
    "",
    "Commands:",
    ...action.commands.map((command) => `- ${command.requiresApproval ? "Review before running: " : ""}\`${command.command.replaceAll("`", "\\`")}\` - ${command.reason}`),
    "",
    "Environment hints:",
    ...action.envHints.map((hint) => `- \`${hint}\``),
    "",
    "Notes:",
    ...action.notes.map((note) => `- ${note}`),
    ""
  ].join("\n"));
  return [
    "# Agent Workflow Local LLM Installation Plan",
    "",
    `Generated: ${report.generatedAt}`,
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    "",
    "This is a reviewed command plan. Agent Workflow writes the plan, but it does not execute downloads, edit provider settings, or change project source.",
    "",
    "## Safety Boundary",
    "",
    `- Executes downloads: ${report.safety.executesDownloads ? "yes" : "no"}`,
    `- Edits provider settings: ${report.safety.editsProviderSettings ? "yes" : "no"}`,
    `- Writes project source: ${report.safety.writesProjectSource ? "yes" : "no"}`,
    `- Approval boundary: ${report.safety.approvalBoundary}`,
    "",
    ...sections,
    "## Next Action",
    "",
    report.nextAction,
    ""
  ].join("\n");
}

export function formatLocalLlmInstallationPlanShell(report: Omit<LocalLlmInstallationPlanReport, "files">): string {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# Agent Workflow local LLM installation plan.",
    "# Review before running. This script may download large model artifacts.",
    ""
  ];
  for (const action of report.actions) {
    lines.push(`# ${action.id}: ${action.modelId} (${action.diskEstimateGb} GB estimate, ${action.risk} risk)`);
    for (const command of action.commands) {
      lines.push(`# ${command.label}: ${command.reason}`);
      lines.push(command.command);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function formatLocalLlmInventoryMarkdown(report: Omit<LocalLlmInventoryReport, "files">): string {
  const rootRows = report.cacheRoots.map((root) =>
    `| ${root.label} | ${root.exists ? "yes" : "no"} | ${root.sizeLabel} | ${root.modelDirectories} | ${root.lastModifiedAt ?? "n/a"} | \`${root.path}\` | ${root.error ?? ""} |`
  ).join("\n");
  const modelRows = report.models.map((model) =>
    `| ${model.modelId} | ${model.source} | ${model.cacheRoot} | ${model.sizeLabel} | ${model.lastUsedAt ?? "unknown"} | ${model.recommended ? "yes" : "no"} | ${model.pruneCandidate ? "yes" : "no"} | ${model.reason} |`
  ).join("\n");
  return [
    "# Agent Workflow Local LLM Disk/Cache Inventory",
    "",
    `Generated: ${report.generatedAt}`,
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    "",
    "This read-only report inspects common local model cache locations and recent Agent Workflow evidence before recommending additional downloads. It does not delete model files or edit provider settings.",
    "",
    "## Storage",
    "",
    `- Total cache: ${report.totalCacheLabel}`,
    `- Storage status: ${report.storage.status}`,
    `- Free: ${report.storage.freeBytes === null ? "unknown" : formatBytes(report.storage.freeBytes)}`,
    `- Total: ${report.storage.totalBytes === null ? "unknown" : formatBytes(report.storage.totalBytes)}`,
    "",
    "## Cache Roots",
    "",
    "| Root | Exists | Size | Model Dirs | Last Modified | Path | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    rootRows,
    "",
    "## Models",
    "",
    "| Model | Source | Cache | Size | Last Used | Recommended | Prune Candidate | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    modelRows || "| none | n/a | n/a | n/a | unknown | no | no | No local model cache entries found. |",
    "",
    "## Recommendation",
    "",
    report.recommendation,
    ""
  ].join("\n");
}

export function formatLocalLlmPrunePlanMarkdown(report: Omit<LocalLlmPrunePlanReport, "files">): string {
  const rows = report.actions.map((action) =>
    `| ${action.id} | ${action.modelId} | ${action.cacheRoot} | ${action.sizeLabel} | ${action.lastUsedAt ?? "unknown"} | ${action.risk} | ${action.recommended ? "yes" : "no"} | \`${action.command.replaceAll("`", "\\`")}\` | ${action.reason} |`
  ).join("\n");
  return [
    "# Agent Workflow Local LLM Prune Plan",
    "",
    `Generated: ${report.generatedAt}`,
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    `Potential reclaim: ${report.reclaimableLabel}`,
    "",
    "This is a reviewed cleanup command plan. Agent Workflow writes the plan, but it does not delete model files, edit provider settings, or change project source.",
    "",
    "## Safety Boundary",
    "",
    `- Executes deletes: ${report.safety.executesDeletes ? "yes" : "no"}`,
    `- Edits provider settings: ${report.safety.editsProviderSettings ? "yes" : "no"}`,
    `- Writes project source: ${report.safety.writesProjectSource ? "yes" : "no"}`,
    `- Approval boundary: ${report.safety.approvalBoundary}`,
    "",
    "## Cleanup Commands",
    "",
    "| ID | Model | Cache | Size | Last Used | Risk | Recommended | Command | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    rows || "| none | n/a | n/a | n/a | unknown | n/a | no | n/a | No prune candidates found. |",
    "",
    "## Next Action",
    "",
    report.nextAction,
    ""
  ].join("\n");
}

export function formatLocalLlmPrunePlanShell(report: Omit<LocalLlmPrunePlanReport, "files">): string {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# Agent Workflow local LLM prune plan.",
    "# Review before running. This script may delete local model cache directories.",
    "# Agent Workflow generated this file but did not execute it.",
    ""
  ];
  for (const action of report.actions) {
    lines.push(`# ${action.id}: ${action.modelId} (${action.sizeLabel}, ${action.risk} risk)`);
    lines.push(`# Reason: ${action.reason}`);
    lines.push(action.command);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function formatLocalLlmRoutingRecommendationMarkdown(report: Omit<LocalLlmRoutingRecommendationReport, "files">): string {
  const rows = report.recommendations.map((item) =>
    `| ${item.id} | ${item.priority} | ${item.action} | ${item.workflowId}/${item.stageId}/${item.agentId} | ${item.routeClass} | ${item.providerId}/${item.modelTier} | ${item.runs} | ${item.fallbackRate} | ${item.averageQuality ?? "n/a"} | ${item.averageLatencyMs ?? "n/a"} | ${item.routeFeedback.helpful}/${item.routeFeedback.costly}/${item.routeFeedback.neutral} | ${formatUsd(item.estimatedNetSavingsUsd)} | ${item.recommendation} |`
  ).join("\n");
  return [
    "# Agent Workflow Local LLM Routing Recommendations",
    "",
    `Generated: ${report.generatedAt}`,
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    "",
    "This project-local report recommends where local model routing should expand, hold, or retreat based on route receipts, quality, fallback behavior, latency, cache pressure, and estimated savings. It does not edit provider settings or routing notes.",
    "",
    "## Summary",
    "",
    ...report.summary.map((item) => `- ${item}`),
    "",
    "## Evidence",
    "",
    `- Local provider status: ${report.evidence.localProviderStatus}`,
    `- Configured: ${report.evidence.configured ? "yes" : "no"}`,
    `- Net estimated savings: ${formatUsd(report.evidence.netEstimatedSavingsUsd)}`,
    `- Storage status: ${report.evidence.storageStatus}`,
    `- Prune candidates: ${report.evidence.pruneCandidateCount}`,
    `- Route receipts: ${report.evidence.routeReceipts}`,
    `- Local selected: ${report.evidence.localSelected}`,
    `- Local skipped: ${report.evidence.localSkipped}`,
    `- Hosted fallback: ${report.evidence.hostedFallback}`,
    `- Hosted selected: ${report.evidence.hostedSelected}`,
    `- Route feedback events: ${report.evidence.routeFeedbackEvents}`,
    `- Route feedback helpful/costly/neutral: ${report.evidence.routeFeedbackCounts.helpful ?? 0}/${report.evidence.routeFeedbackCounts.costly ?? 0}/${report.evidence.routeFeedbackCounts.neutral ?? 0}`,
    "",
    "## Recommendations",
    "",
    "| ID | Priority | Action | Target | Route Class | Provider/Tier | Runs | Fallback | Quality | Latency ms | Feedback H/C/N | Net Savings | Recommendation |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    rows,
    "",
    "## Next Action",
    "",
    report.nextAction,
    ""
  ].join("\n");
}

export function formatLocalLlmSetupGuideMarkdown(report: Omit<LocalLlmSetupGuideReport, "files">): string {
  const runtimeRows = report.runtimes.map((runtime) =>
    `| ${runtime.label} | ${runtime.status} | ${runtime.baseUrl} | ${runtime.modelCount} | ${runtime.models.slice(0, 5).join(", ") || "none"} | ${runtime.nextAction} |`
  ).join("\n");
  return [
    "# Agent Workflow Local LLM Setup Guide",
    "",
    `Generated: ${report.generatedAt}`,
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    `Approved: ${report.approved ? "yes" : "no"}`,
    "",
    "This project-local guide records detected local OpenAI-compatible runtimes and setup evidence. It does not edit `.env`, shared workflows, reusable agents, provider settings, or project source.",
    "",
    "## Recommendation",
    "",
    report.recommendation,
    "",
    "## Evidence",
    "",
    `- Checklist status: ${report.checklistStatus}`,
    `- Routing note eligible: ${report.routingNoteEligible ? "yes" : "no"}`,
    `- First local smoke success: ${report.firstLocalSmokeSuccessAt ?? "none"}`,
    `- Latest smoke issue: ${report.latestSmokeIssue ?? "none"}`,
    "",
    "## Blockers",
    "",
    ...(report.blockers.length ? report.blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
    "",
    "## Runtime Probes",
    "",
    "| Runtime | Status | Base URL | Models | Sample Models | Next Action |",
    "| --- | --- | --- | ---: | --- | --- |",
    runtimeRows || "| none | missing | n/a | 0 | none | Start a local runtime. |",
    ""
  ].join("\n");
}

export function formatLocalLlmSetupRoutingNoteMarkdown(report: Omit<LocalLlmSetupGuideReport, "files">): string {
  const runtime = report.recommendedRuntime;
  return [
    "# Agent Workflow Local Model Routing Note",
    "",
    `Generated: ${report.generatedAt}`,
    `Project: ${report.projectRootUri}`,
    "",
    "## Approved Local Routing",
    "",
    "- Provider: local",
    "- Max risk: low",
    "- Scope: low-risk developer stages with hosted fallback preserved",
    runtime ? `- Base URL: ${runtime.baseUrl}` : "",
    runtime ? `- Model count: ${runtime.modelCount}` : "",
    `- First local smoke success: ${report.firstLocalSmokeSuccessAt ?? "none"}`,
    `- Latest smoke issue: ${report.latestSmokeIssue ?? "none"}`,
    "",
    "Only use this note after the local setup checklist is healthy. Keep hosted providers for high-risk work, command approval, secrets, production actions, reusable bundle changes, and policy decisions.",
    ""
  ].filter(Boolean).join("\n");
}

export function formatOneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

export function formatPromotionRoutingNotePlan(plan: DashboardPromotionRoutingNotePlan): string {
  return [
    `Promotion Routing Note Plan: ${plan.projectRootUri}`,
    `Generated: ${plan.generatedAt}`,
    `Selected promotable suites: ${plan.selectedSuiteIds.length ? plan.selectedSuiteIds.join(", ") : "none"}`,
    plan.skippedSuiteIds.length ? `Skipped suites: ${plan.skippedSuiteIds.join(", ")}` : "",
    "",
    "Files",
    plan.files.map((file) => `- ${file.relativePath} (${file.content.length} bytes)`).join("\n")
  ].filter(Boolean).join("\n");
}

export function formatPromotionRoutingNotePlanMarkdown(plan: Omit<DashboardPromotionRoutingNotePlan, "files">): string {
  return [
    "# Agent Workflow Promotion Routing Note Plan",
    "",
    `Generated: ${plan.generatedAt}`,
    `Project: ${plan.projectRootUri}`,
    plan.sourceComparisonPlanGeneratedAt ? `Source comparison plan: ${plan.sourceComparisonPlanGeneratedAt}` : "Source comparison plan: unavailable",
    "",
    "This plan is review-only. It does not change live routing. Apply any routing preference only after a project-local gate passes and a human reviews the note.",
    "",
    "## Draft Notes",
    "",
    plan.notes.length
      ? plan.notes.map((note) => [
        `### ${note.suiteId}`,
        "",
        `- Workflow: ${note.workflowId}`,
        `- Baseline: ${note.baseline ? `${note.baseline.provider}/${note.baseline.modelTier}` : "unavailable"}`,
        `- Candidate: ${note.candidate ? `${note.candidate.provider}/${note.candidate.modelTier}` : "unavailable"}`,
        `- Quality delta: ${note.qualityDelta ?? "unavailable"}`,
        `- Latency delta: ${note.latencyDeltaMs === null ? "unavailable" : formatDurationDelta(note.latencyDeltaMs)}`,
        note.gateCommand ? `- Gate: ${note.gateCommand}` : "- Gate: run a baseline-versus-candidate gate before applying.",
        "",
        "Rationale:",
        note.rationale.map((item) => `- ${item}`).join("\n"),
        "",
        "Draft routing note:",
        "",
        note.draftNote,
        ""
      ].join("\n")).join("\n")
      : "_No promotable candidate comparison suites selected._",
    ""
  ].join("\n");
}

export function formatSignedBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  return `${bytes > 0 ? "+" : "-"}${formatBytes(Math.abs(bytes))}`;
}

export function formatUsd(value: number): string {
  const rounded = roundCurrency(value);
  const sign = rounded < 0 ? "-" : "";
  return `${sign}$${Math.abs(rounded).toFixed(4)}`;
}

export function inferStageAgentId(reports: CostQualityReport[], stageId: string): string {
  const stage = reports.flatMap((report) => report.stages).find((item) => item.stageId === stageId);
  return stage?.agentId ?? "unknown";
}

export function inferStageWorkflowId(runs: DashboardRunStatus[], reports: CostQualityReport[], stageId: string): string {
  const report = reports.find((item) => item.stages.some((stage) => stage.stageId === stageId));
  return report?.workflowId ?? runs[0]?.workflowId ?? "unknown";
}

export async function inspectOpenAICompatibleStatus(ctx: CliContext, input: {
  providerId: "local" | "byo" | "openai-compatible" | "gemini" | "muse";
  label: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): Promise<NonNullable<DashboardInfo["provider"]["providerStatuses"]>[number]> {
  const configured = Boolean(input.baseUrl);
  if (!configured) {
    return {
      providerId: input.providerId,
      label: input.label,
      configured,
      status: "not configured",
      model: input.model || "auto",
      baseUrl: safeDisplayUrl(input.baseUrl),
      apiKeyStatus: input.apiKey ? "configured" : "not required or missing",
      details: ["Base URL is required before this provider can be routed."]
    };
  }

  const discovered = await discoverModelIds(() => loadOpenAICompatibleModelIds(input.baseUrl, input.apiKey));
  const tierEnvPrefix = input.providerId === "local" ? "LOCAL_MODEL" : input.providerId === "byo" ? "BYO_MODEL" : input.providerId === "gemini" ? "GEMINI_MODEL" : input.providerId === "muse" ? "MUSE_MODEL" : "OPENAI_COMPATIBLE_MODEL";
  const baseModel = input.model || "auto";
  const tierModels = loadGenericTierModelPreview({
    catalog: discovered.models,
    provider: "compatible",
    baseModel,
    tierEnvPrefix
  });
  const configuredModels = (["fast", "standard", "reasoning"] as const)
    .map((tier) => process.env[`${tierEnvPrefix}_${tier.toUpperCase()}`] || baseModel)
    .filter((model) => model !== "auto");
  const configuredModelsAvailable = configuredModels.every((model) => discovered.models.includes(model));
  return {
    providerId: input.providerId,
    label: input.label,
    configured,
    status: discovered.error || !configuredModelsAvailable ? "missing" : "ready",
    model: baseModel,
    baseUrl: safeDisplayUrl(input.baseUrl),
    apiKeyStatus: input.apiKey ? "configured" : "not required",
    tierModels,
    details: discovered.error
      ? [`Model list check failed: ${discovered.error}`]
      : !configuredModelsAvailable
        ? [`Configured model not listed: ${configuredModels.filter((model) => !discovered.models.includes(model)).join(", ")}`]
        : [`Endpoint reachable. ${discovered.models.length} models listed. ${formatTierModelPreview(tierModels)}`]
  };
}

export function isAgentWorkflowMcpCommand(ctx: CliContext, command: string): boolean {
  const encodedRootDir = ctx.rootDir.replaceAll(" ", "%20");
  return (command.includes(ctx.rootDir) || command.includes(encodedRootDir)) && /apps\/mcp\/src\/index\.(ts|js)/.test(command);
}

export function isLocalLlmCacheTrendPoint(value: unknown): value is LocalLlmCacheTrendPoint {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.capturedAt === "string" &&
    typeof record.totalCacheBytes === "number" &&
    typeof record.modelCount === "number" &&
    typeof record.pruneCandidateCount === "number";
}

export function isLocalLlmCostLedgerPoint(value: unknown): value is LocalLlmCostLedgerPoint {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.capturedAt === "string" &&
    typeof record.localSelectedStages === "number" &&
    typeof record.netEstimatedSavingsUsd === "number";
}

export function isLocalLlmSmokeRun(run: DashboardRunStatus): boolean {
  return run.evaluationMetadata?.kind === "local_llm_route_smoke"
    || (run.workflowId === "provider-smoke" && /local llm route smoke/i.test(run.task));
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isRouteDecisionFeedbackEvent(value: unknown): value is RouteDecisionFeedbackEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RouteDecisionFeedbackEvent>;
  return typeof candidate.id === "string"
    && typeof candidate.createdAt === "string"
    && normalizeRouteDecisionFeedbackRating(candidate.rating ?? "") !== null
    && normalizeRouteDecisionClass(candidate.routeClass ?? "") !== null;
}

export async function latestLearningActionReceiptBackupPath(projectDir: string): Promise<string | null> {
  const learningDir = path.join(projectDir, ".agent-workflow", "learning");
  const entries = await fs.readdir(learningDir, { withFileTypes: true }).catch(() => []);
  const backups = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("action-receipts.json.bak-"))
    .map((entry) => path.join(learningDir, entry.name))
    .sort();
  return backups.at(-1) ?? null;
}

export function learningActionReceiptOpenKey(event: Pick<LearningActionReceipt, "status" | "actionId" | "proposalId" | "actor" | "note" | "title" | "actionType" | "dangerGate" | "writesOwnedLearningStateOnly">): string {
  return [
    event.status,
    event.actionId,
    event.proposalId,
    event.actor,
    event.note,
    event.title,
    event.actionType,
    event.dangerGate,
    event.writesOwnedLearningStateOnly ? "owned" : "external"
  ].join("\u0000");
}

export function learningDaemonMcpCleanupEnabled(): boolean {
  return envFlag("AGENTFLOW_DAEMON_CLEANUP_STALE_MCP");
}

export function learningDaemonMcpCleanupMode(): RuntimeMonitorReport["mcpCleanup"]["autoCleanup"]["mode"] {
  const normalized = normalizeLookup(process.env.AGENTFLOW_MCP_CLEANUP_MODE ?? "preview");
  return normalized === "auto-low-risk" || normalized === "autolowrisk" ? "auto-low-risk" : "preview";
}

export async function listModelDirectories(root: string, depth: number): Promise<Array<{ name: string; path: string }>> {
  async function walk(current: string, parts: string[], level: number): Promise<Array<{ name: string; path: string }>> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    const directories = entries.filter((entry) => entry.isDirectory());
    if (level >= depth) {
      return directories.map((entry) => ({
        name: [...parts, entry.name].join("/").replace(/^models--/u, "").replaceAll("--", "/"),
        path: path.join(current, entry.name)
      }));
    }
    const nested = await Promise.all(directories.map((entry) => walk(path.join(current, entry.name), [...parts, entry.name], level + 1)));
    return nested.flat();
  }
  return walk(root, [], 1);
}

export async function loadAgentImprovementRecords(ctx: CliContext, projectDir: string): Promise<Array<{
  agent: AgentCard;
  sourcePath: string;
  scope: "shared" | "project-local";
}>> {
  const sharedRecords = await loadAgentRecords(ctx.rootDir);
  const records: Array<{
    agent: AgentCard;
    sourcePath: string;
    scope: "shared" | "project-local";
  }> = sharedRecords.map((record) => ({
    agent: record.value,
    sourcePath: record.path,
    scope: "shared" as const
  }));
  const projectAgentsDir = path.join(projectDir, ".agent-workflow", "agents");
  const entries = await fs.readdir(projectAgentsDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
      continue;
    }
    const filePath = path.join(projectAgentsDir, entry.name);
    records.push({
      agent: await loadYamlFile(filePath, agentCardSchema),
      sourcePath: path.relative(projectDir, filePath),
      scope: "project-local"
    });
  }
  const merged = new Map<string, typeof records[number]>();
  for (const record of records) {
    merged.set(record.agent.id, record);
  }
  return [...merged.values()];
}

export async function loadAgentImprovementReport(ctx: CliContext, input: {
  projectDir: string;
  agentId?: string;
  limit: number;
  mode: AgentImprovementReport["mode"];
}): Promise<AgentImprovementReport> {
  const projectDir = path.resolve(process.cwd(), input.projectDir);
  const limit = Math.max(1, input.limit);
  const agentRecords = await loadAgentImprovementRecords(ctx, projectDir);
  const workflows = await loadWorkflows(ctx.rootDir);
  const runs = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit });
  const scorecard = await loadPreferenceScorecard({ projectDir, limit });
  const reports = (await Promise.all(runs.slice(0, Math.min(runs.length, 20)).map((run) => loadCostQualityReport(run.id)))).filter((report): report is CostQualityReport => report !== null);
  const stageHealth = runs.length ? await listWorkflowStageHealthForRuns({ runIds: runs.map((run) => run.id) }) : [];
  const workflowStageRefs = new Map<string, Array<{ workflowId: string; stageId: string; subagent: boolean }>>();
  for (const workflow of workflows) {
    for (const stage of workflow.stages) {
      const refs = workflowStageRefs.get(stage.agent) ?? [];
      refs.push({ workflowId: workflow.id, stageId: stage.id, subagent: false });
      workflowStageRefs.set(stage.agent, refs);
      for (const subagent of stage.subagents) {
        const subrefs = workflowStageRefs.get(subagent) ?? [];
        subrefs.push({ workflowId: workflow.id, stageId: stage.id, subagent: true });
        workflowStageRefs.set(subagent, subrefs);
      }
    }
  }

  const focusedRecords = input.agentId
    ? agentRecords.filter((record) => record.agent.id === input.agentId)
    : agentRecords;
  const outcomeWeights = await loadOutcomeWeights(projectDir);
  const candidates = focusedRecords
    .map((record) => buildAgentImprovementCandidate({
      record,
      workflowRefs: workflowStageRefs.get(record.agent.id) ?? [],
      runs,
      scorecard,
      reports,
      stageHealth,
      outcomeWeights
    }))
    .filter((candidate): candidate is AgentImprovementCandidate => candidate !== null)
    .sort((left, right) => priorityRank(right.priority) - priorityRank(left.priority) || right.outcomeWeight - left.outcomeWeight || agentImprovementRiskRank(left.riskLevel) - agentImprovementRiskRank(right.riskLevel) || left.agentId.localeCompare(right.agentId));

  const sharedAgents = agentRecords.filter((record) => record.scope === "shared").length;
  const projectLocalAgents = agentRecords.filter((record) => record.scope === "project-local").length;
  const workflowReferences = [...workflowStageRefs.values()].reduce((sum, refs) => sum + refs.length, 0);
  return {
    kind: "agentflow_agent_improvement_report",
    generatedAt: new Date().toISOString(),
    projectRootUri: projectDir,
    limit,
    mode: input.mode,
    agentsAnalyzed: focusedRecords.length,
    candidates,
    evidenceSummary: {
      runsAnalyzed: runs.length,
      workflowReferences,
      projectLocalAgents,
      sharedAgents,
      feedbackCounts: scorecard.feedbackCounts,
      failedRuns: runs.filter((run) => run.status === "failed").length
    },
    ownedLearningFiles: [
      ".agent-workflow/learning/agent-improvement-report.json",
      ".agent-workflow/learning/agent-improvement-recommendations.md"
    ],
    autonomyBoundary: {
      automatic: [
        "Generate role-specific agent improvement candidates from local run evidence and static agent-card quality checks.",
        "Write Agent Workflow-owned learning reports under .agent-workflow/learning when --write or daemon-owned writes are enabled.",
        "Draft safe research queries from generic agent role names and abstract evidence labels without exporting private source or logs."
      ],
      approvalRequired: [
        "Edit shared agents/**/*.yaml or project-local .agent-workflow/agents/*.yaml.",
        "Add new reusable agent types, new tool privileges, broader autonomy, or weaker safety boundaries.",
        "Run network/model research with private project details, prompts, logs, eval cases, or source snippets.",
        "Promote an agent-card improvement into a release bundle."
      ]
    },
    privacyBoundaries: [
      "The report uses local metadata, run status, stage health, feedback counts, and compact report summaries.",
      "Generated research queries are intentionally abstract: job title, public practice area, and generic quality goal only.",
      "No private source, prompts, secrets, logs, or customer/project-specific data should be sent to web/model research without explicit approval."
    ],
    nextCommands: [
      `npm run agentflow -- agent-improvement-report --project ${shellQuote(projectDir)} --write`,
      `npm run agentflow -- agent-task technical-architect --project ${shellQuote(projectDir)} --task "Review agent improvement candidates and identify safe low-risk agent-card patches"`,
      `npm run agentflow -- learning-report --project ${shellQuote(projectDir)} --json`,
      `npm run agentflow -- learning-workflow-shape --project ${shellQuote(projectDir)} --write`
    ]
  };
}

export async function loadCostQualityReportsForDashboardRuns(runs: DashboardRunStatus[]): Promise<CostQualityReport[]> {
  const reports = await mapWithConcurrency(runs, 8, (run) => loadCostQualityReport(run.id).catch(() => null));
  return reports.filter((report): report is CostQualityReport => report !== null);
}

export async function loadDashboardCandidateComparisonReport(input: {
  projectDir: string;
}): Promise<DashboardCandidateComparisonReport> {
  const projectDir = path.resolve(process.cwd(), input.projectDir);
  const modelPlanPath = path.join(projectDir, ".agent-workflow", "model-improvement", "model-improvement-plan.json");
  const comparisonPlanPath = path.join(projectDir, ".agent-workflow", "model-improvement", "candidate-comparison-plan.json");
  const modelPlanResult = await readDashboardJsonFile<Omit<ModelImprovementPlan, "files">>(modelPlanPath, (value) =>
    value.kind === "agentflow_model_improvement_plan" && Array.isArray(value.evalCases)
  );
  const comparisonPlanResult = await readDashboardJsonFile<Omit<CandidateComparisonPlan, "files">>(comparisonPlanPath, (value) =>
    value.kind === "agentflow_candidate_comparison_plan" && Array.isArray(value.suites)
  );
  const comparisonPlan = comparisonPlanResult.value;
  const suiteFiles = (comparisonPlan?.suites ?? []).map((suite) => {
    const relativePath = suite.suitePath;
    const absolutePath = path.resolve(projectDir, relativePath);
    return {
      path: relativePath,
      exists: absolutePath.startsWith(`${projectDir}${path.sep}`) && fsSync.existsSync(absolutePath)
    };
  });
  const evaluationSuites = comparisonPlan ? await loadDashboardEvaluations(500) : [];
  const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: 50 });
  const recentRouteReports = await loadCostQualityReportsForDashboardRuns(projectRuns);
  const outcomes = (comparisonPlan?.suites ?? []).map((suite) => {
    const evaluation = evaluationSuites.find((item) => item.id === suite.id);
    const baseline = evaluation?.variants.find((variant) => variant.id.startsWith("baseline-")) ?? null;
    const candidate = evaluation?.variants.find((variant) => variant.id.startsWith("candidate-")) ?? null;
    return {
      suiteId: suite.id,
      runs: evaluation?.runs.length ?? 0,
      leader: evaluation?.leader ?? null,
      latestAt: evaluation?.latestAt || null,
      baselineRuns: baseline?.runs ?? 0,
      candidateRuns: candidate?.runs ?? 0,
      baselineQuality: baseline?.averageQuality ?? null,
      candidateQuality: candidate?.averageQuality ?? null,
      qualityDelta: baseline?.averageQuality !== null && baseline?.averageQuality !== undefined && candidate?.averageQuality !== null && candidate?.averageQuality !== undefined
        ? Math.round((candidate.averageQuality - baseline.averageQuality) * 1000) / 1000
        : null,
      baselineLatencyMs: baseline?.averageLatencyMs ?? null,
      candidateLatencyMs: candidate?.averageLatencyMs ?? null,
      latencyDeltaMs: baseline?.averageLatencyMs !== null && baseline?.averageLatencyMs !== undefined && candidate?.averageLatencyMs !== null && candidate?.averageLatencyMs !== undefined
        ? candidate.averageLatencyMs - baseline.averageLatencyMs
        : null,
      gateReady: Boolean((baseline?.runs ?? 0) > 0 && (candidate?.runs ?? 0) > 0)
    };
  });
  const promotionRecommendations = outcomes.map((outcome) =>
    buildCandidatePromotionRecommendation({
      projectDir,
      suite: comparisonPlan?.suites.find((suite) => suite.id === outcome.suiteId) ?? null,
      outcome
    })
  );
  const promotionNoteFiles = await readPromotionRoutingNoteFiles(projectDir);
  const localHoldoutRouting = await loadDashboardLocalHoldoutRoutingStatus(projectDir);
  const readiness: string[] = [];
  if (!modelPlanResult.exists) {
    readiness.push("Write a model-improvement plan before preparing candidate comparisons.");
  } else if (modelPlanResult.error) {
    readiness.push(`Model-improvement plan is unreadable: ${modelPlanResult.error}`);
  }
  if (!comparisonPlanResult.exists) {
    readiness.push("Run candidate-comparison-plan with --write to create local comparison files.");
  } else if (comparisonPlanResult.error) {
    readiness.push(`Candidate comparison plan is unreadable: ${comparisonPlanResult.error}`);
  }
  const missingSuites = suiteFiles.filter((suite) => !suite.exists).length;
  if (missingSuites) {
    readiness.push(`${missingSuites} generated evaluation suite file(s) are missing.`);
  }
  const unevaluatedSuites = outcomes.filter((outcome) => outcome.runs === 0).length;
  if (comparisonPlan && unevaluatedSuites) {
    readiness.push(`${unevaluatedSuites} candidate comparison suite(s) have not been evaluated yet.`);
  }
  if (!readiness.length) {
    readiness.push("Candidate comparison evidence is present. Run the gate before promoting routing or prompt changes.");
  }
  return {
    generatedAt: new Date().toISOString(),
    projectDir,
    modelPlanPath,
    comparisonPlanPath,
    modelPlanExists: modelPlanResult.exists,
    comparisonPlanExists: comparisonPlanResult.exists,
    modelPlanError: modelPlanResult.error,
    comparisonPlanError: comparisonPlanResult.error,
    modelPlan: modelPlanResult.value,
    comparisonPlan,
    suiteFiles,
    outcomes,
    promotionRecommendations,
    promotionNoteFiles,
    localHoldoutRouting,
    routeReceiptTrends: buildDashboardRouteReceiptTrends(projectDir, recentRouteReports),
    readiness,
    nextCommands: [
      `npm run agentflow -- model-improvement-plan --project ${shellQuote(projectDir)} --write`,
      `npm run agentflow -- candidate-comparison-plan --project ${shellQuote(projectDir)} --write`,
      `npm run agentflow -- local-holdout-comparison --project ${shellQuote(projectDir)} --write`,
      ...(comparisonPlan?.suites.map((suite) => suite.command) ?? []),
      `npm run agentflow -- local-holdout-results --project ${shellQuote(projectDir)} --write`,
      `npm run agentflow -- local-holdout-promote --project ${shellQuote(projectDir)} --approved --write`,
      `npm run agentflow -- gate --run <candidate-run-id> --baseline-run <baseline-run-id> --project ${shellQuote(projectDir)}`
    ]
  };
}

export async function loadDashboardEvaluations(limit = 250, projectRootUri?: string): Promise<DashboardEvaluationSuite[]> {
  const runs = (await listWorkflowRuns(limit)).filter((run) =>
    typeof run.evaluationMetadata?.suiteId === "string" && (!projectRootUri || path.resolve(run.projectRootUri) === path.resolve(projectRootUri))
  );
  const evaluated = (await mapWithConcurrency(runs, 8, async (run): Promise<DashboardEvaluationRun | null> => {
    const metadata = run.evaluationMetadata ?? {};
    const report = await loadCostQualityReport(run.id);
    if (!report) {
      return null;
    }
    const suiteId = stringValue(metadata.suiteId);
    const caseId = stringValue(metadata.caseId);
    const variantId = stringValue(metadata.variantId);
    if (!suiteId || !caseId || !variantId) {
      return null;
    }
    return {
      runId: run.id,
      projectRootUri: run.projectRootUri,
      suiteId,
      suiteName: stringValue(metadata.suiteName) ?? suiteId,
      caseId,
      variantId,
      workflowId: run.workflowId,
      provider: run.providerOverride ?? Object.keys(report.providerMix)[0] ?? "unknown",
      modelTier: run.modelTierOverride ?? Object.keys(report.modelTierMix)[0] ?? "unknown",
      status: run.status,
      averageQuality: report.averageQuality,
      totalLatencyMs: report.totalLatencyMs,
      fallbackCount: report.fallbackCount,
      estimatedCostMix: report.estimatedCostMix,
      feedback: report.feedback.latest?.rating ?? null,
      startedAt: run.startedAt
    };
  })).filter((run): run is DashboardEvaluationRun => run !== null);

  const suites = new Map<string, DashboardEvaluationRun[]>();
  for (const run of evaluated) {
    const selected = suites.get(run.suiteId) ?? [];
    selected.push(run);
    suites.set(run.suiteId, selected);
  }
  return [...suites.entries()].map(([id, suiteRuns]): DashboardEvaluationSuite => {
    const variantIds = [...new Set(suiteRuns.map((run) => run.variantId))];
    const variants = variantIds.map((variantId): DashboardEvaluationVariant => {
      const selected = suiteRuns.filter((run) => run.variantId === variantId);
      const scored = selected.filter((run) => run.averageQuality !== null);
      return {
        id: variantId,
        provider: selected[0]?.provider ?? "unknown",
        modelTier: selected[0]?.modelTier ?? "unknown",
        runs: selected.length,
        completed: selected.filter((run) => run.status === "completed").length,
        averageQuality: scored.length
          ? Math.round(scored.reduce((sum, run) => sum + (run.averageQuality ?? 0), 0) / scored.length * 1000) / 1000
          : null,
        averageLatencyMs: selected.length
          ? Math.round(selected.reduce((sum, run) => sum + run.totalLatencyMs, 0) / selected.length)
          : null,
        fallbackRate: Math.round(selected.reduce((sum, run) => sum + run.fallbackCount, 0) / Math.max(1, selected.length) * 1000) / 1000,
        estimatedCostMix: mergeCounts(selected.map((run) => run.estimatedCostMix)),
        feedbackCounts: countStrings(selected.flatMap((run) => run.feedback ? [run.feedback] : []))
      };
    }).sort((a, b) =>
      b.completed / Math.max(1, b.runs) - a.completed / Math.max(1, a.runs) ||
      (b.averageQuality ?? -1) - (a.averageQuality ?? -1) ||
      a.fallbackRate - b.fallbackRate ||
      (a.averageLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.averageLatencyMs ?? Number.MAX_SAFE_INTEGER)
    );
    return {
      id,
      name: suiteRuns[0]?.suiteName ?? id,
      workflowId: suiteRuns[0]?.workflowId ?? "unknown",
      runs: suiteRuns.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      variants,
      leader: variants[0]?.id ?? null,
      latestAt: suiteRuns.map((run) => run.startedAt).sort().at(-1) ?? ""
    };
  }).sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

export async function loadDashboardFeedbackInboxReport(input: {
  projectRootUri?: string;
  limit: number;
}): Promise<DashboardFeedbackInboxReport> {
  const projectRootUri = input.projectRootUri ? path.resolve(process.cwd(), input.projectRootUri) : null;
  const runs = projectRootUri
    ? await listWorkflowRunsForProject({ projectRootUri, limit: input.limit })
    : await listWorkflowRuns(input.limit);
  const targets = await loadDashboardFeedbackTargetsFromRuns(runs, input.limit);
  const items = targets.map((target) => ({
    ...target,
    classification: classifyFeedbackTarget(target)
  }));
  const groups: DashboardFeedbackInboxReport["groups"] = {
    probably_accept: [],
    probably_revise: [],
    probably_reject: []
  };
  for (const item of items) {
    groups[item.classification.bucket].push(item);
  }
  return {
    generatedAt: new Date().toISOString(),
    projectRootUri,
    limit: input.limit,
    totalCandidates: runs.length,
    totalTargets: items.length,
    counts: {
      probably_accept: groups.probably_accept.length,
      probably_revise: groups.probably_revise.length,
      probably_reject: groups.probably_reject.length
    },
    groups
  };
}

export async function loadDashboardFeedbackTargetsFromRuns(
  projectRuns: Awaited<ReturnType<typeof listWorkflowRunsForProject>>,
  targetLimit: number
): Promise<DashboardFeedbackTarget[]> {
  const candidates = projectRuns.filter((run) => run.status === "completed" || run.status === "failed");
  const reports = await Promise.all(candidates.map(async (run) => ({
    run,
    report: await loadCostQualityReport(run.id).catch(() => null),
    summary: await summarizeWorkflowRun(run.id).catch(() => null)
  })));
  return reports
    .filter((item) => !item.report?.feedback.latest)
    .slice(0, targetLimit)
    .map((item) => ({
      runId: item.run.id,
      workflowId: item.run.workflowId,
      status: item.run.status,
      task: item.run.task,
      startedAt: item.run.startedAt,
      finishedAt: item.run.finishedAt ?? null,
      provider: item.run.providerOverride ?? null,
      modelTier: item.run.modelTierOverride ?? null,
      summary: item.summary?.ok ? {
        completedTasks: item.summary.value.completedTasks,
        failedTasks: item.summary.value.failedTasks,
        totalTasks: item.summary.value.totalTasks,
        keyFindings: item.summary.value.keyFindings.slice(0, 3),
        failures: item.summary.value.failures.slice(0, 3),
        recommendedNextAction: item.summary.value.recommendedNextAction
      } : null,
      quality: item.report ? {
        averageQuality: item.report.averageQuality,
        qualityPassCount: item.report.qualityPassCount,
        qualityFailCount: item.report.qualityFailCount,
        fallbackCount: item.report.fallbackCount,
        averageLatencyMs: item.report.averageLatencyMs
      } : null
    }));
}

export async function loadDashboardLocalHoldoutRoutingStatus(
  projectDir: string,
  localEvidence: DashboardLocalProviderEvidence | null = null
): Promise<DashboardLocalHoldoutRoutingStatus> {
  const projectRoot = path.resolve(projectDir);
  const resultsPath = path.join(projectRoot, ".agent-workflow", "model-improvement", "local-holdout-results.json");
  const promotionPath = path.join(projectRoot, ".agent-workflow", "tuning", "local-routing-threshold.json");
  const results = await readDashboardJsonFile<Omit<LocalHoldoutResultSummary, "files">>(resultsPath, (value) =>
    value.kind === "agentflow_local_holdout_results" && isRecord(value.summary) && Array.isArray(value.results)
  );
  const promotion = await readDashboardJsonFile<Omit<LocalHoldoutRoutingPromotion, "files">>(promotionPath, (value) =>
    value.kind === "agentflow_local_holdout_routing_promotion" && (value.status === "ready" || value.status === "blocked")
  );
  const promotableSuites = results.value?.results.filter((result) => result.decision === "propose_routing_note").map((result) => result.suiteId) ?? [];
  const evidenceSuites = promotion.value?.preference?.evidenceSuites ?? [];
  const thresholdSummary = promotion.value?.preference
    ? `min suites ${promotion.value.preference.thresholds?.minEvidenceSuites ?? "legacy"}, min quality ${promotion.value.preference.thresholds?.minQualityDelta ?? "legacy"}, max latency ${promotion.value.preference.thresholds?.maxLatencyRegressionMs ?? "legacy"}ms`
    : null;
  const evidenceSummary = promotion.value?.preference
    ? `promotable ${promotion.value.preference.evidence?.promotableSuites ?? evidenceSuites.length}, worst quality ${promotion.value.preference.evidence?.worstQualityDelta ?? "n/a"}, worst latency ${promotion.value.preference.evidence?.worstLatencyDeltaMs ?? "n/a"}ms`
    : null;
  const localFallbackRate = localEvidence?.localFallbackRate ?? null;
  const localStageCount = localEvidence?.localStageCount ?? 0;
  const hostedStageCount = localEvidence?.hostedStageCount ?? 0;
  let status: DashboardLocalHoldoutRoutingStatus["status"] = "not-started";
  let recommendation = "Generate a local holdout comparison plan and capture results before changing routing.";
  if (results.error || promotion.error) {
    status = "error";
    recommendation = results.error ?? promotion.error ?? "Local holdout routing state is unreadable.";
  } else if (promotion.value?.status === "ready" && promotion.value.approved && promotion.value.preference) {
    status = localStageCount > 0 ? "active" : "approved";
    recommendation = localStageCount > 0
      ? "Approved local routing is active in recent run evidence; watch fallback rate before expanding beyond low-risk stages."
      : "Approved local routing is ready. Run auto/adaptive low-risk stages to confirm local selection receipts.";
  } else if (promotion.value?.status === "blocked") {
    status = "blocked";
    recommendation = promotion.value.reason;
  } else if (results.value?.decision === "eligible_for_review") {
    status = "needs-promotion";
    recommendation = "Captured holdout results are eligible. Approve low-risk local routing to write the project-local threshold note.";
  } else if (results.value) {
    status = "needs-evidence";
    recommendation = `Captured holdout decision is ${results.value.decision}; run or improve the comparison suites before promotion.`;
  }
  return {
    status,
    generatedAt: new Date().toISOString(),
    projectRootUri: projectRoot,
    resultsPath: ".agent-workflow/model-improvement/local-holdout-results.json",
    promotionPath: ".agent-workflow/tuning/local-routing-threshold.json",
    resultsExists: results.exists,
    promotionExists: promotion.exists,
    resultsDecision: results.value?.decision ?? null,
    promotionStatus: promotion.value?.status ?? null,
    approved: promotion.value?.approved ?? false,
    maxRisk: promotion.value?.preference?.maxRisk ?? null,
    evidenceSuites,
    thresholdSummary,
    evidenceSummary,
    promotableSuites,
    localStageCount,
    hostedStageCount,
    localFallbackRate,
    hostedFallbackBoundary: "Hosted providers remain the required fallback for high-risk, command, secret, policy, production, network, reusable bundle, and export actions.",
    recommendation,
    error: results.error ?? promotion.error
  };
}

export async function loadLearningActionReceiptHealth(projectDir: string): Promise<LearningActionReceiptHealth> {
  const receipts = await readLearningActionReceipts(projectDir).catch(() => emptyLearningActionReceipts(projectDir));
  return buildLearningActionReceiptHealth(receipts, await latestLearningActionReceiptBackupPath(projectDir));
}

export async function loadLearningDaemonStatus(ctx: CliContext, projectDir: string): Promise<DashboardLearningDaemonStatus> {
  const heartbeatPath = path.join(projectDir, ".agent-workflow", "learning", "daemon-status.json");
  const projectPathExists = await pathExists(projectDir);
  try {
    const heartbeat = JSON.parse(await fs.readFile(heartbeatPath, "utf8")) as Partial<LearningDaemonHeartbeat>;
    const lastHeartbeatAt = typeof heartbeat.lastHeartbeatAt === "string" ? heartbeat.lastHeartbeatAt : null;
    const ageMs = lastHeartbeatAt ? Date.now() - Date.parse(lastHeartbeatAt) : null;
    const intervalMs = typeof heartbeat.intervalMs === "number" ? heartbeat.intervalMs : null;
    const staleAfterMs = Math.max((intervalMs ?? 60000) * 3, 120_000);
    const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : null;
    const processAlive = pid ? isProcessAlive(pid) : false;
    const heartbeatStatus = heartbeat.status ?? "stopped";
    const running = processAlive && ageMs !== null && ageMs <= staleAfterMs && heartbeatStatus !== "stopped" && heartbeatStatus !== "stopping" && heartbeatStatus !== "failed";
    return {
      heartbeatPath,
      configured: true,
      projectPathExists,
      projectRootUri: typeof heartbeat.projectRootUri === "string" ? heartbeat.projectRootUri : projectDir,
      daemonId: typeof heartbeat.daemonId === "string" ? heartbeat.daemonId : null,
      mode: heartbeat.mode === "observe" || heartbeat.mode === "propose" || heartbeat.mode === "apply-approved" ? heartbeat.mode : null,
      status: running ? "running" : heartbeatStatus === "failed" ? "failed" : heartbeatStatus === "stopped" ? "stopped" : "stale",
      pid,
      processAlive,
      startedAt: typeof heartbeat.startedAt === "string" ? heartbeat.startedAt : null,
      lastHeartbeatAt,
      lastReportAt: typeof heartbeat.lastReportAt === "string" ? heartbeat.lastReportAt : null,
      ageMs,
      intervalMs,
      limit: typeof heartbeat.limit === "number" ? heartbeat.limit : null,
      ticks: typeof heartbeat.ticks === "number" ? heartbeat.ticks : 0,
      proposals: typeof heartbeat.proposals === "number" ? heartbeat.proposals : 0,
      roadmapSnapshotStatus: heartbeat.roadmapSnapshotStatus === "published" || heartbeat.roadmapSnapshotStatus === "unchanged" || heartbeat.roadmapSnapshotStatus === "unavailable" ? heartbeat.roadmapSnapshotStatus : null,
      roadmapSnapshotPublishedAt: typeof heartbeat.roadmapSnapshotPublishedAt === "string" ? heartbeat.roadmapSnapshotPublishedAt : null,
      roadmapSnapshotDigest: typeof heartbeat.roadmapSnapshotDigest === "string" ? heartbeat.roadmapSnapshotDigest : null,
      inboxItems: typeof heartbeat.inboxItems === "number" ? heartbeat.inboxItems : 0,
      applicationActions: typeof heartbeat.applicationActions === "number" ? heartbeat.applicationActions : 0,
      autonomousAppliedActions: typeof heartbeat.autonomousAppliedActions === "number" ? heartbeat.autonomousAppliedActions : 0,
      autonomousApplyMaxRisk: parseLearningRiskLevel(typeof heartbeat.autonomousApplyMaxRisk === "string" ? heartbeat.autonomousApplyMaxRisk : "medium"),
      agentImprovementCandidates: typeof heartbeat.agentImprovementCandidates === "number" ? heartbeat.agentImprovementCandidates : 0,
      agentImprovementPatchPreviews: typeof heartbeat.agentImprovementPatchPreviews === "number" ? heartbeat.agentImprovementPatchPreviews : 0,
      agentImprovementEvalPasses: typeof heartbeat.agentImprovementEvalPasses === "number" ? heartbeat.agentImprovementEvalPasses : 0,
      agentImprovementPromotions: typeof heartbeat.agentImprovementPromotions === "number" ? heartbeat.agentImprovementPromotions : 0,
      agentImprovementPromotionPending: typeof heartbeat.agentImprovementPromotionPending === "number" ? heartbeat.agentImprovementPromotionPending : 0,
      agentImprovementApplied: typeof heartbeat.agentImprovementApplied === "number" ? heartbeat.agentImprovementApplied : 0,
      agentImprovementApplySkipped: typeof heartbeat.agentImprovementApplySkipped === "number" ? heartbeat.agentImprovementApplySkipped : 0,
      approvalAutopilotEnabled: typeof heartbeat.approvalAutopilotEnabled === "boolean" ? heartbeat.approvalAutopilotEnabled : false,
      approvalAutopilotMaxRisk: parseApprovalAutopilotRisk(typeof heartbeat.approvalAutopilotMaxRisk === "string" ? heartbeat.approvalAutopilotMaxRisk : "medium"),
      approvalAutopilotExecuted: typeof heartbeat.approvalAutopilotExecuted === "number" ? heartbeat.approvalAutopilotExecuted : 0,
      approvalAutopilotSkipped: typeof heartbeat.approvalAutopilotSkipped === "number" ? heartbeat.approvalAutopilotSkipped : 0,
      approvalBacklogWarnings: typeof heartbeat.approvalBacklogWarnings === "number" ? heartbeat.approvalBacklogWarnings : 0,
      approvalBacklogErrors: typeof heartbeat.approvalBacklogErrors === "number" ? heartbeat.approvalBacklogErrors : 0,
      approvalBacklogScanned: typeof heartbeat.approvalBacklogScanned === "number" ? heartbeat.approvalBacklogScanned : 0,
      mcpCleanupEnabled: typeof heartbeat.mcpCleanupEnabled === "boolean" ? heartbeat.mcpCleanupEnabled : false,
      mcpCleanupMode: heartbeat.mcpCleanupMode === "auto-low-risk" ? "auto-low-risk" : "preview",
      mcpCleanupStaleMinutes: typeof heartbeat.mcpCleanupStaleMinutes === "number" ? heartbeat.mcpCleanupStaleMinutes : 60,
      mcpCleanupCandidates: typeof heartbeat.mcpCleanupCandidates === "number" ? heartbeat.mcpCleanupCandidates : 0,
      mcpCleanupAutoCleanable: typeof heartbeat.mcpCleanupAutoCleanable === "number" ? heartbeat.mcpCleanupAutoCleanable : 0,
      mcpCleanupTerminated: typeof heartbeat.mcpCleanupTerminated === "number" ? heartbeat.mcpCleanupTerminated : 0,
      mcpCleanupWarnings: typeof heartbeat.mcpCleanupWarnings === "number" ? heartbeat.mcpCleanupWarnings : 0,
      lastMcpCleanupAt: typeof heartbeat.lastMcpCleanupAt === "string" ? heartbeat.lastMcpCleanupAt : null,
      staleRunReconcileEnabled: typeof heartbeat.staleRunReconcileEnabled === "boolean" ? heartbeat.staleRunReconcileEnabled : staleRunReconcileConfig().enabled,
      staleRunReconcileCandidates: typeof heartbeat.staleRunReconcileCandidates === "number" ? heartbeat.staleRunReconcileCandidates : 0,
      staleRunReconciled: typeof heartbeat.staleRunReconciled === "number" ? heartbeat.staleRunReconciled : 0,
      lastStaleRunReconcileAt: typeof heartbeat.lastStaleRunReconcileAt === "string" ? heartbeat.lastStaleRunReconcileAt : null,
      trainingDiscoveryStatus: heartbeat.trainingDiscoveryStatus === "completed" || heartbeat.trainingDiscoveryStatus === "not_due" || heartbeat.trainingDiscoveryStatus === "failed" ? heartbeat.trainingDiscoveryStatus : null,
      trainingDiscoveryLastRunAt: typeof heartbeat.trainingDiscoveryLastRunAt === "string" ? heartbeat.trainingDiscoveryLastRunAt : null,
      trainingDiscoveryNextRunAfter: typeof heartbeat.trainingDiscoveryNextRunAfter === "string" ? heartbeat.trainingDiscoveryNextRunAfter : null,
      trainingDiscoveryProposals: typeof heartbeat.trainingDiscoveryProposals === "number" ? heartbeat.trainingDiscoveryProposals : 0,
      trainingDiscoveryErrors: typeof heartbeat.trainingDiscoveryErrors === "number" ? heartbeat.trainingDiscoveryErrors : 0,
      lastError: typeof heartbeat.lastError === "string" ? heartbeat.lastError : "",
      command: typeof heartbeat.command === "string" ? heartbeat.command : `npm run agentflow -- learning-daemon --project ${shellQuote(projectDir)} --mode apply-approved`
    };
  } catch {
    return {
      heartbeatPath,
      configured: false,
      projectPathExists,
      projectRootUri: projectDir,
      daemonId: null,
      mode: null,
      status: "missing",
      pid: null,
      processAlive: false,
      startedAt: null,
      lastHeartbeatAt: null,
      lastReportAt: null,
      ageMs: null,
      intervalMs: null,
      limit: null,
      ticks: 0,
      proposals: 0,
      roadmapSnapshotStatus: null,
      roadmapSnapshotPublishedAt: null,
      roadmapSnapshotDigest: null,
      inboxItems: 0,
      applicationActions: 0,
      autonomousAppliedActions: 0,
      autonomousApplyMaxRisk: "medium",
      agentImprovementCandidates: 0,
      agentImprovementPatchPreviews: 0,
      agentImprovementEvalPasses: 0,
      agentImprovementPromotions: 0,
      agentImprovementPromotionPending: 0,
      agentImprovementApplied: 0,
      agentImprovementApplySkipped: 0,
      approvalAutopilotEnabled: false,
      approvalAutopilotMaxRisk: "medium",
      approvalAutopilotExecuted: 0,
      approvalAutopilotSkipped: 0,
      approvalBacklogWarnings: 0,
      approvalBacklogErrors: 0,
      approvalBacklogScanned: 0,
      mcpCleanupEnabled: false,
      mcpCleanupMode: "preview",
      mcpCleanupStaleMinutes: 60,
      mcpCleanupCandidates: 0,
      mcpCleanupAutoCleanable: 0,
      mcpCleanupTerminated: 0,
      mcpCleanupWarnings: 0,
      lastMcpCleanupAt: null,
      staleRunReconcileEnabled: staleRunReconcileConfig().enabled,
      staleRunReconcileCandidates: 0,
      staleRunReconciled: 0,
      lastStaleRunReconcileAt: null,
      trainingDiscoveryStatus: null,
      trainingDiscoveryLastRunAt: null,
      trainingDiscoveryNextRunAfter: null,
      trainingDiscoveryProposals: 0,
      trainingDiscoveryErrors: 0,
      lastError: "",
      command: `npm run agentflow -- learning-daemon --project ${shellQuote(projectDir)} --mode apply-approved`
    };
  }
}

export async function loadLearningReport(input: {
  projectDir: string;
  limit: number;
}): Promise<LearningReport> {
  const projectDir = path.resolve(process.cwd(), input.projectDir);
  const limit = Math.max(1, input.limit);
  const runs = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit });
  const scorecard = await loadPreferenceScorecard({ projectDir, limit });
  const proposals = buildTuningProposals(scorecard);
  const routeFeedback = summarizeRouteFeedback((await readRouteDecisionFeedbackLog(projectDir)).events) as LearningRouteFeedbackSummary;
  const evaluationRuns = runs.filter((run) => typeof run.evaluationMetadata?.suiteId === "string");
  const operationalRuns = runs.filter((run) => typeof run.evaluationMetadata?.suiteId !== "string" && !run.dismissed);
  const stageHealth = operationalRuns.length ? await listWorkflowStageHealthForRuns({ runIds: operationalRuns.map((run) => run.id) }) : [];
  const reports = (await Promise.all(runs.slice(0, Math.min(runs.length, 20)).map((run) => loadCostQualityReport(run.id)))).filter((report): report is CostQualityReport => report !== null);
  const failedRuns = selectFailedRuns(runs);
  const repeatedFailurePatterns = buildFailurePatterns(stageHealth, (stageId) => ({ workflowId: inferStageWorkflowId(runs, reports, stageId), agentId: inferStageAgentId(reports, stageId) }));
  const costOpportunities = buildCostOpportunities(scorecard.groups);
  const proposalPreview = buildProposalPreview(proposals.proposals);
  const evalGaps = buildEvaluationGaps({ runs: runs.length, feedbackCount: Object.values(scorecard.feedbackCounts).reduce((sum, value) => sum + value, 0), evaluationRuns: evaluationRuns.length, failedRuns: failedRuns.length, failurePatterns: repeatedFailurePatterns.length, feedbackNeeded: proposals.proposals.some((proposal) => proposal.kind === "feedback_needed") });
  return {
    kind: "agentflow_learning_report",
    generatedAt: new Date().toISOString(),
    projectDir,
    limit,
    autonomyMode: "autonomous-local",
    runsAnalyzed: runs.length,
    runStatusCounts: countStrings(operationalRuns.map((run) => run.status)),
    feedbackCounts: scorecard.feedbackCounts,
    routeFeedback,
    evaluationRuns: evaluationRuns.length,
    latestEvaluationAt: evaluationRuns.map((run) => run.startedAt).sort().at(-1) ?? null,
    failedRuns,
    repeatedFailurePatterns,
    costOpportunities,
    proposalPreview,
    evalGaps,
    safeAutomaticActions: [
      "Read local run history, receipts, feedback, eval summaries, and queue status.",
      "Detect repeated failures, high-cost routes, stale context, and eval gaps.",
      "Use route-decision helpful/costly feedback to prioritize local routing improvements.",
      "Generate compact local learning reports and proposal previews.",
      "Update learning files and future learning database rows that Agent Workflow created and owns by default.",
      "Refresh workflow-shape and agent-type recommendation files automatically when the autonomous optimizer is enabled.",
      "Auto-approve and apply low/medium-risk project-local tuning overlays when autonomous mode is enabled.",
      "Prepare approval queues only for high-risk or outside-boundary changes."
    ],
    approvalRequiredActions: [
      "Apply high-risk project-local changes such as generated eval suites or debug workflow execution.",
      "Promote workflow-shape recommendations into shared workflows or reusable agent cards.",
      "Modify reusable agents, workflows, package code, docs, schemas, provider settings, or project source.",
      "Run commands, tests, web/model research, network calls, or external tools.",
      "Change production policy, deployment, storage lifecycle, server mode, or any private-data export."
    ],
    privacyBoundaries: [
      "Local evidence stays on this machine by default.",
      "Web/model research is opt-in and must not include private source, feedback, logs, prompts, eval cases, or artifacts without explicit approval.",
      "Open-source learning should generalize developer workflow patterns and avoid product-specific behavior."
    ],
    nextCommands: [
      `npm run agentflow -- learning-report --project ${shellQuote(projectDir)} --json`,
      `npm run agentflow -- learning-proposals --project ${shellQuote(projectDir)} --write`,
      `npm run agentflow -- preference-scorecard --project ${shellQuote(projectDir)}`,
      `npm run agentflow -- tuning-proposals --project ${shellQuote(projectDir)}`,
      `npm run agentflow -- run-and-watch model-improvement --project ${shellQuote(projectDir)} --task "Improve local developer workflow quality and cost"`
    ]
  };
}

export async function loadLocalLlmRoutingRecommendationReport(ctx: CliContext, input: {
  projectDir: string;
  limit: number;
}): Promise<LocalLlmRoutingRecommendationReport> {
  const projectDir = path.resolve(process.cwd(), input.projectDir);
  const scorecard = await loadPreferenceScorecard({ projectDir, limit: input.limit });
  const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: input.limit });
  const recentRouteReports = await loadCostQualityReportsForDashboardRuns(projectRuns.slice(0, Math.min(projectRuns.length, 50)));
  const localProviderEvidence = buildDashboardLocalProviderEvidence(scorecard);
  const routeReceiptTrends = buildDashboardRouteReceiptTrends(projectDir, recentRouteReports);
  const localLlmSmokeOutcomes = buildLocalLlmSmokeOutcomeTrend(projectDir, projectRuns, recentRouteReports);
  const localHoldoutRouting = await loadDashboardLocalHoldoutRoutingStatus(projectDir, localProviderEvidence);
  const localLlmSetup = await loadLocalLlmSetupChecklistReport(ctx, { projectDir, localHoldoutRouting, routeReceiptTrends, smokeOutcomes: localLlmSmokeOutcomes });
  const localLlmSetupGuide = await loadLocalLlmSetupGuideReport({ projectDir, checklist: localLlmSetup, approved: false });
  const localLlmDownloadRecommendations = buildLocalLlmDownloadRecommendationReport({ projectDir, scorecard, checklist: localLlmSetup, setupGuide: localLlmSetupGuide });
  const localLlmInstallationPlan = buildLocalLlmInstallationPlanReport(projectDir, localLlmDownloadRecommendations, "recommended");
  const localLlmInventory = await buildLocalLlmInventoryReport(projectDir, localLlmSetupGuide, localLlmDownloadRecommendations, localLlmInstallationPlan, recentRouteReports);
  const localLlmPrunePlan = buildLocalLlmPrunePlanReport(projectDir, localLlmInventory, "candidates");
  const localLlmCacheTrends = await buildLocalLlmCacheTrendReport(projectDir, localLlmInventory, localLlmPrunePlan, routeReceiptTrends, false);
  const localLlmCostLedger = await buildLocalLlmCostLedgerReport(projectDir, routeReceiptTrends, localLlmCacheTrends, false);
  const routeDecisionFeedback = await readRouteDecisionFeedbackLog(projectDir);
  return buildLocalLlmRoutingRecommendationReport({
    projectDir,
    localProviderEvidence,
    routeReceiptTrends,
    costLedger: localLlmCostLedger,
    cacheTrends: localLlmCacheTrends,
    routeDecisionFeedback
  });
}

export async function loadLocalLlmSetupChecklistReport(ctx: CliContext, input: {
  projectDir: string;
  localHoldoutRouting: DashboardLocalHoldoutRoutingStatus;
  routeReceiptTrends: DashboardRouteReceiptTrendReport;
  smokeOutcomes: LocalLlmSmokeOutcomeTrend;
}): Promise<LocalLlmSetupChecklistReport> {
  const projectRoot = path.resolve(input.projectDir);
  const baseUrl = process.env.LOCAL_MODEL_BASE_URL || "http://localhost:11434/v1";
  const model = process.env.LOCAL_MODEL_NAME || "auto";
  const discovered = await discoverModelIds(() => loadOpenAICompatibleModelIds(baseUrl, process.env.LOCAL_MODEL_API_KEY));
  const localStatus = await inspectOpenAICompatibleStatus(ctx, {
    providerId: "local",
    label: "Local model runtime",
    baseUrl,
    model,
    apiKey: process.env.LOCAL_MODEL_API_KEY
  });
  const routing = loadRoutingConfig(ctx);
  const selectedTierModels = (localStatus.tierModels ?? []).map((tierModel) => ({
    tier: parseModelTierOption(tierModel.tier),
    model: tierModel.model,
    source: tierModel.source
  }));
  const configured = Boolean(process.env.LOCAL_MODEL_BASE_URL || process.env.LOCAL_MODEL_NAME);
  const autoProviderIds = routing.autoProviders.split(",").map((provider) => normalizeLookup(provider));
  const canRouteAutomatically = routing.provider === "local"
    || routing.provider === "auto"
    || routing.fastProvider === "local"
    || routing.standardProvider === "local"
    || autoProviderIds.includes("local");
  const selectedModelsAvailable = selectedTierModels.length > 0 && selectedTierModels.every((item) => item.source !== "unavailable");
  const checks: LocalLlmSetupChecklistItem[] = [
    {
      id: "local-provider-config",
      label: "Local provider configured",
      status: configured ? "pass" : "warning",
      detail: configured
        ? `LOCAL_MODEL_BASE_URL=${safeDisplayUrl(baseUrl) ?? "not set"}, LOCAL_MODEL_NAME=${model}.`
        : "Using the Ollama-compatible localhost default. Set LOCAL_MODEL_BASE_URL or LOCAL_MODEL_NAME to make local setup explicit.",
      nextAction: "Set LOCAL_MODEL_BASE_URL and LOCAL_MODEL_NAME in .env, or keep the default localhost runtime."
    },
    {
      id: "endpoint-reachable",
      label: "Endpoint reachable",
      status: localStatus.status === "ready" ? "pass" : "fail",
      detail: localStatus.details.join(" "),
      nextAction: "Start Ollama, LM Studio, vLLM, or another OpenAI-compatible local runtime and confirm /v1/models responds."
    },
    {
      id: "catalog-selection",
      label: "Selected model catalog entry",
      status: selectedModelsAvailable ? "pass" : "fail",
      detail: selectedTierModels.length
        ? selectedTierModels.map((item) => `${item.tier}=${item.model} (${item.source})`).join(", ")
        : "No local tier model selection is available from the endpoint catalog.",
      nextAction: "Use LOCAL_MODEL_NAME=auto with a populated /v1/models catalog, or set LOCAL_MODEL_FAST/STANDARD/REASONING to listed model ids."
    },
    {
      id: "automatic-routing-visible",
      label: "Automatic routing can see local",
      status: canRouteAutomatically ? "pass" : "warning",
      detail: `DEFAULT_MODEL_PROVIDER=${routing.provider}; AGENTFLOW_AUTO_PROVIDERS=${routing.autoProviders}; fast=${routing.fastProvider}; standard=${routing.standardProvider}.`,
      nextAction: "Use DEFAULT_MODEL_PROVIDER=auto or local, or include local in AGENTFLOW_AUTO_PROVIDERS for adaptive low-risk routing."
    },
    {
      id: "holdout-promotion",
      label: "Low-risk holdout promotion",
      status: input.localHoldoutRouting.approved ? "pass" : "warning",
      detail: input.localHoldoutRouting.recommendation,
      nextAction: `Run npm run agentflow -- local-holdout-promote --project ${shellQuote(projectRoot)} --approved --write after reviewing holdout evidence.`
    },
    {
      id: "first-route-receipt",
      label: "First low-risk route receipt",
      status: input.routeReceiptTrends.localSelected > 0 ? "pass" : "warning",
      detail: `${input.routeReceiptTrends.localSelected} local-selected, ${input.routeReceiptTrends.localSkipped} local-skipped, ${input.routeReceiptTrends.hostedFallback} hosted-fallback receipts in the inspected window.`,
      nextAction: `Run a low-risk workflow after local promotion, then inspect npm run agentflow -- local-llm-checklist --project ${shellQuote(projectRoot)}.`
    }
  ];
  const status = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warning")
      ? "warning"
      : "pass";
  return {
    kind: "agentflow_local_llm_setup_checklist",
    generatedAt: new Date().toISOString(),
    projectRootUri: projectRoot,
    status,
    localProvider: {
      configured,
      baseUrl: safeDisplayUrl(baseUrl) ?? baseUrl,
      model,
      apiKeyConfigured: Boolean(process.env.LOCAL_MODEL_API_KEY),
      status: localStatus.status,
      modelsListed: discovered.models.length,
      selectedTierModels,
      details: localStatus.details
    },
    routing: {
      defaultProvider: routing.provider,
      autoProviders: routing.autoProviders,
      fastProvider: routing.fastProvider,
      standardProvider: routing.standardProvider,
      reasoningProvider: routing.reasoningProvider,
      localHoldoutStatus: input.localHoldoutRouting.status,
      localHoldoutApproved: input.localHoldoutRouting.approved,
      localRouteReceipts: input.routeReceiptTrends.localSelected,
      localSkippedReceipts: input.routeReceiptTrends.localSkipped,
      hostedFallbackReceipts: input.routeReceiptTrends.hostedFallback
    },
    smokeOutcomes: input.smokeOutcomes,
    checks,
    nextCommands: [
      `npm run agentflow -- provider-use auto --check`,
      `npm run agentflow -- local-holdout-comparison --project ${shellQuote(projectRoot)} --write`,
      `npm run agentflow -- local-holdout-results --project ${shellQuote(projectRoot)} --write`,
      `npm run agentflow -- local-holdout-promote --project ${shellQuote(projectRoot)} --approved --write`,
      `npm run agentflow -- local-llm-smoke --project ${shellQuote(projectRoot)}`,
      `npm run agentflow -- local-llm-checklist --project ${shellQuote(projectRoot)}`
    ]
  };
}

export async function loadLocalLlmSetupGuideReport(input: {
  projectDir: string;
  checklist: LocalLlmSetupChecklistReport;
  approved: boolean;
}): Promise<LocalLlmSetupGuideReport> {
  const projectDir = path.resolve(input.projectDir);
  const generatedAt = new Date().toISOString();
  const runtimes = await detectLocalLlmRuntimeCandidates();
  const readyRuntime = runtimes.find((runtime) => runtime.status === "ready") ?? null;
  const routingVisible = input.checklist.checks.find((check) => check.id === "automatic-routing-visible")?.status === "pass";
  const tierModelsReady = input.checklist.localProvider.selectedTierModels.length > 0
    && input.checklist.localProvider.selectedTierModels.every((item) => item.source !== "unavailable");
  const hasTrueLocalSmoke = input.checklist.smokeOutcomes.counts["local-selected"] > 0;
  const routingNoteEligible = Boolean(
    readyRuntime
      && input.checklist.localProvider.status === "ready"
      && tierModelsReady
      && routingVisible
      && hasTrueLocalSmoke
  );
  const blockers = [
    readyRuntime ? "" : "No local OpenAI-compatible runtime responded with a model catalog.",
    input.checklist.localProvider.status === "ready" ? "" : "The configured local provider endpoint is not ready.",
    tierModelsReady ? "" : "Selected local tier models are unavailable.",
    routingVisible ? "" : "Automatic routing cannot currently see the local provider.",
    hasTrueLocalSmoke ? "" : "No low-risk smoke run has produced a true local-selected route receipt.",
    input.approved ? "" : "Owner approval is required before writing the routing note."
  ].filter(Boolean);
  const status: LocalLlmSetupGuideReport["status"] = routingNoteEligible && input.approved ? "ready" : "blocked";
  const recommendation = routingNoteEligible
    ? input.approved
      ? "Write the project-local setup report and healthy local routing note, then continue monitoring fallback and quality before expanding beyond low-risk stages."
      : "Checklist evidence is healthy. Re-run with --approved --write, or use the dashboard approval action, to write the project-local routing note."
    : readyRuntime
      ? "A local runtime was detected, but the checklist is not healthy yet. Fix the blockers, rerun local-llm-smoke, then regenerate this guide."
      : "Start Ollama, LM Studio, vLLM, llama.cpp, or another OpenAI-compatible local runtime, download a coding-capable model, and rerun the checklist.";
  const document = {
    kind: "agentflow_local_llm_setup_guide" as const,
    generatedAt,
    projectRootUri: projectDir,
    approved: input.approved,
    status,
    routingNoteEligible,
    recommendedRuntime: readyRuntime,
    blockers,
    runtimes,
    checklistStatus: input.checklist.status,
    firstLocalSmokeSuccessAt: input.checklist.smokeOutcomes.firstSuccessAt,
    latestSmokeIssue: input.checklist.smokeOutcomes.latestFailureReason,
    recommendation
  };
  const setupFiles: LocalLlmSetupGuideReport["files"] = [
    {
      relativePath: ".agent-workflow/model-improvement/local-llm-setup-guide.md",
      content: formatLocalLlmSetupGuideMarkdown(document)
    },
    {
      relativePath: ".agent-workflow/model-improvement/local-llm-setup-guide.json",
      content: `${JSON.stringify(document, null, 2)}\n`
    }
  ];
  const routingFiles: LocalLlmSetupGuideReport["files"] = status === "ready" && readyRuntime
    ? [
      {
        relativePath: ".agent-workflow/tuning/local-model-routing-note.md",
        content: formatLocalLlmSetupRoutingNoteMarkdown(document)
      },
      {
        relativePath: ".agent-workflow/tuning/local-model-routing-note.json",
        content: `${JSON.stringify({
          kind: "agentflow_local_model_routing_note",
          generatedAt,
          projectRootUri: projectDir,
          approved: true,
          provider: "local",
          baseUrl: readyRuntime.baseUrl,
          models: readyRuntime.models,
          maxRisk: "low",
          evidence: {
            firstLocalSmokeSuccessAt: document.firstLocalSmokeSuccessAt,
            latestSmokeIssue: document.latestSmokeIssue,
            checklistStatus: document.checklistStatus
          },
          rollback: "Remove .agent-workflow/tuning/local-model-routing-note.* and rerun local-llm-checklist before changing provider settings."
        }, null, 2)}\n`
      }
    ]
    : [];
  return {
    ...document,
    files: [...setupFiles, ...routingFiles]
  };
}

export async function loadLocalModelLastUsedMap(projectDir: string, reports: CostQualityReport[]): Promise<Map<string, string>> {
  const usage = new Map<string, string>();
  for (const report of reports) {
    for (const stage of report.stages) {
      if (!stage.model) continue;
      const current = usage.get(stage.model);
      const run = await getWorkflowRunDetails(report.runId).catch(() => null);
      const timestamp = run?.run?.finishedAt ?? run?.run?.startedAt ?? null;
      if (timestamp && (!current || timestamp > current)) usage.set(stage.model, timestamp);
    }
  }
  const receiptsPath = path.join(projectDir, ".agent-workflow", "model-improvement", "local-llm-benchmark-receipts.json");
  const raw = await fs.readFile(receiptsPath, "utf8").catch(() => null);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as LocalLlmBenchmarkReceiptReport;
      for (const receipt of parsed.receipts ?? []) {
        if (receipt.status !== "completed") continue;
        const timestamp = receipt.finishedAt ?? receipt.startedAt;
        const current = usage.get(receipt.modelId);
        if (timestamp && (!current || timestamp > current)) usage.set(receipt.modelId, timestamp);
      }
    } catch {
      // Ignore stale or partial benchmark receipt files.
    }
  }
  return usage;
}

export async function loadOpenAICompatibleModelIds(baseUrl?: string, apiKey?: string): Promise<string[]> {
  if (!baseUrl) {
    return [];
  }

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(`${baseUrl.replace(/\/+$/u, "")}/models`, { headers });
  if (!response.ok) {
    throw new Error(`models API returned ${response.status}`);
  }
  const parsed = await response.json() as { data?: Array<{ id?: string }> };
  return uniqueSorted(parsed.data?.map((model) => model.id).filter((id): id is string => Boolean(id)) ?? []);
}

export async function loadOutcomeWeights(projectDir: string): Promise<Map<string, AgentImprovementOutcomeWeight>> {
  const receipts = await readAgentImprovementPromotionReceipts(path.resolve(process.cwd(), projectDir)).catch(() => null);
  const weights = new Map<string, AgentImprovementOutcomeWeight>();
  if (!receipts) {
    return weights;
  }
  const byPattern = new Map<string, { approvals: number; rejections: number }>();
  for (const event of receipts.events) {
    const patternId = event.patternId ?? "legacy";
    const counts = byPattern.get(patternId) ?? { approvals: 0, rejections: 0 };
    if (event.status === "approved") {
      counts.approvals += 1;
    } else if (event.status === "rejected") {
      counts.rejections += 1;
    }
    byPattern.set(patternId, counts);
  }
  for (const [patternId, counts] of byPattern) {
    weights.set(patternId, {
      weight: (counts.approvals + 1) / (counts.approvals + counts.rejections + 2),
      approvals: counts.approvals,
      rejections: counts.rejections
    });
  }
  return weights;
}

export async function loadPreferenceScorecard(input: {
  projectDir: string;
  limit: number;
}): Promise<PreferenceScorecard> {
  const runs = await listWorkflowRunsForProject({
    projectRootUri: input.projectDir,
    limit: input.limit
  });
  const reports: CostQualityReport[] = [];
  for (const run of runs) {
    const details = await getWorkflowRunDetails(run.id);
    if (!details.run) {
      continue;
    }
    const artifacts = await listArtifacts({ runId: run.id });
    reports.push(buildCostQualityReport({
      run: details.run,
      tasks: details.tasks,
      receipts: details.receipts,
      artifacts
    }));
  }
  return buildPreferenceScorecard({
    projectRootUri: input.projectDir,
    reports
  });
}

export function loadRoutingConfig(ctx: CliContext): DashboardInfo["provider"]["routingConfig"] {
  return {
    provider: process.env.DEFAULT_MODEL_PROVIDER ?? "mock",
    autoProviders: process.env.AGENTFLOW_AUTO_PROVIDERS ?? "local,byo,bedrock,gemini,codex-cli,openai,anthropic,muse,openai-compatible,kiro",
    fastProvider: process.env.AGENTFLOW_PROVIDER_FAST ?? "auto",
    standardProvider: process.env.AGENTFLOW_PROVIDER_STANDARD ?? "auto",
    reasoningProvider: process.env.AGENTFLOW_PROVIDER_REASONING ?? "auto",
    fallbackProvider: process.env.AGENTFLOW_FALLBACK_PROVIDER ?? "",
    qualityThreshold: process.env.AGENTFLOW_QUALITY_THRESHOLD ?? "0.62",
    modelPolicy: normalizeModelSelectionPolicy(process.env.AGENTFLOW_MODEL_POLICY)
  };
}

export async function loadRuntimeMcpCleanupCandidates(ctx: CliContext, input: { staleMinutes?: number } = {}): Promise<RuntimeMonitorReport["mcpCleanup"]["candidates"]> {
  const staleMinutes = input.staleMinutes ?? parseRuntimeMcpStaleMinutes();
  const staleMs = staleMinutes * 60_000;
  const result = await execFileText(ctx, "ps", ["-axo", "pid=,ppid=,etime=,args="], { allowFailure: true });
  const rows = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) return null;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const parentPid = Number.parseInt(match[2] ?? "", 10);
    const elapsedSeconds = parsePsElapsedSeconds(match[3] ?? "");
    const command = match[4] ?? "";
    if (!Number.isFinite(pid) || pid === process.pid) return null;
    return {
      pid,
      parentPid: Number.isFinite(parentPid) ? parentPid : null,
      elapsedSeconds: Number.isFinite(elapsedSeconds) ? elapsedSeconds : null,
      command
    };
  }).filter((row): row is { pid: number; parentPid: number | null; elapsedSeconds: number | null; command: string } => Boolean(row));
  const parentByPid = new Map(rows.map((row) => [row.pid, row]));
  const mcpRows = rows.filter((row) => isAgentWorkflowMcpCommand(ctx, row.command));
  const sessions = new Map<string, typeof mcpRows>();
  for (const row of mcpRows) {
    const sessionKey = runtimeMcpSessionKey(row, parentByPid);
    const group = sessions.get(sessionKey) ?? [];
    group.push(row);
    sessions.set(sessionKey, group);
  }
  const sessionSummaries = [...sessions.entries()]
    .map(([sessionKey, group]) => ({
      sessionKey,
      newestAgeMs: Math.min(...group.map((row) => row.elapsedSeconds === null ? Number.POSITIVE_INFINITY : row.elapsedSeconds * 1000)),
      oldestAgeMs: Math.max(...group.map((row) => row.elapsedSeconds === null ? 0 : row.elapsedSeconds * 1000))
    }))
    .sort((left, right) => left.newestAgeMs - right.newestAgeMs);
  const newestSessionKey = sessionSummaries[0]?.sessionKey ?? "";
  const staleSessionKeys = new Set(sessionSummaries
    .filter((session) => session.sessionKey !== newestSessionKey && session.oldestAgeMs >= staleMs)
    .map((session) => session.sessionKey));
  const candidates = mcpRows.map((row) => {
    const sessionKey = runtimeMcpSessionKey(row, parentByPid);
    const ageMs = row.elapsedSeconds === null ? null : row.elapsedSeconds * 1000;
    const startedAt = ageMs === null ? null : new Date(Date.now() - ageMs).toISOString();
    const autoCleanable = staleSessionKeys.has(sessionKey);
    const risk: "low" | "medium" = autoCleanable ? "low" : "medium";
    return {
      pid: row.pid,
      parentPid: row.parentPid,
      command: row.command,
      reason: autoCleanable
        ? `Old duplicate Agent Workflow MCP session from this checkout; older than ${staleMinutes} minute threshold and not the newest session.`
        : "Agent Workflow MCP process from this checkout; manual confirmation recommended because it is newest, young, or cannot be proven stale.",
      ageMs,
      startedAt,
      sessionKey,
      risk,
      autoCleanable
    };
  });
  return candidates.sort((left, right) => Number(right.autoCleanable) - Number(left.autoCleanable) || (right.ageMs ?? 0) - (left.ageMs ?? 0) || left.pid - right.pid);
}

export async function loadTuningProposals(input: {
  projectDir: string;
  limit: number;
}): Promise<TuningProposalSet> {
  const scorecard = await loadPreferenceScorecard(input);
  return buildTuningProposals(scorecard);
}

export async function loadWorkflowShapeOptimization(ctx: CliContext, input: {
  projectDir: string;
  workflowId?: string;
  limit: number;
}): Promise<WorkflowShapeOptimizationReport> {
  const projectDir = path.resolve(process.cwd(), input.projectDir);
  const limit = Math.max(1, input.limit);
  const workflows = await loadWorkflows(ctx.rootDir);
  const runs = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit });
  const requestedWorkflow = input.workflowId ? resolveWorkflow(workflows, input.workflowId) : null;
  const workflow = requestedWorkflow
    ?? workflows.find((item) => item.id === runs[0]?.workflowId)
    ?? workflows.find((item) => item.id === "build-feature")
    ?? workflows[0];
  if (!workflow) {
    throw new Error("No reusable workflows are available.");
  }
  if (input.workflowId && !requestedWorkflow) {
    throw new Error(`Unknown workflow: ${input.workflowId}`);
  }
  const workflowRuns = runs.filter((run) => run.workflowId === workflow.id);
  const scorecard = await loadPreferenceScorecard({ projectDir, limit });
  const stageHealth = workflowRuns.length ? await listWorkflowStageHealthForRuns({ runIds: workflowRuns.map((run) => run.id) }) : [];
  const files = await listProjectFileSummaries({ projectRootUri: projectDir, limit: 500 });
  const evaluationRuns = workflowRuns.filter((run) => typeof run.evaluationMetadata?.suiteId === "string");
  return buildWorkflowShapeOptimizationReport({
    projectRootUri: projectDir,
    workflowId: workflow.id,
    workflowName: workflow.name,
    runsAnalyzed: workflowRuns.length,
    evaluationRuns: evaluationRuns.length,
    feedbackCounts: scorecard.feedbackCounts,
    stages: workflow.stages.map((stage, index) => ({
      id: stage.id,
      agentId: stage.agent,
      order: index,
      contextMaxTokens: stage.context.max_tokens,
      contextLoads: stage.context.load,
      approvalRequired: stage.approval_required,
      subagentCount: stage.subagents.length
    })),
    stageHealth,
    scoreGroups: scorecard.groups,
    projectContext: {
      indexedFiles: files.length,
      indexedTokenEstimate: files.reduce((sum, file) => sum + file.tokenEstimate, 0),
      sourceKinds: summarizeProjectSourceKinds(files)
    }
  });
}

export function localLlmCostAssumptions(): LocalLlmCostAssumptions {
  return {
    currency: "USD",
    unit: "estimated cost per routed workflow stage",
    source: "operator-configurable estimates; set AGENTFLOW_COST_LEDGER_* env vars for your provider rates",
    hostedUsdPerStageByTier: {
      fast: readNumberEnv("AGENTFLOW_COST_LEDGER_FAST_USD_PER_STAGE", 0.001),
      standard: readNumberEnv("AGENTFLOW_COST_LEDGER_STANDARD_USD_PER_STAGE", 0.01),
      reasoning: readNumberEnv("AGENTFLOW_COST_LEDGER_REASONING_USD_PER_STAGE", 0.05)
    },
    localStorageUsdPerGbMonth: readNumberEnv("AGENTFLOW_COST_LEDGER_LOCAL_STORAGE_USD_PER_GB_MONTH", 0.02)
  };
}

export function localModelCacheRoots(): Array<{ id: string; label: string; path: string; modelDepth: number }> {
  const home = os.homedir();
  return [
    { id: "ollama", label: "Ollama", path: path.join(home, ".ollama", "models"), modelDepth: 0 },
    { id: "lm-studio", label: "LM Studio", path: path.join(home, "Library", "Application Support", "LM Studio", "models"), modelDepth: 2 },
    { id: "huggingface", label: "Hugging Face Hub", path: path.join(home, ".cache", "huggingface", "hub"), modelDepth: 1 },
    { id: "vllm", label: "vLLM/Hugging Face cache", path: path.join(home, ".cache", "vllm"), modelDepth: 1 },
    { id: "llama-cpp", label: "llama.cpp cache", path: path.join(home, ".cache", "llama.cpp"), modelDepth: 1 }
  ];
}

export function localModelCandidateCatalog(
  hardwareClass: LocalLlmDownloadRecommendationReport["hardware"]["class"],
  taskMix: LocalLlmDownloadRecommendationReport["taskMix"]
): Array<{
  modelId: string;
  aliases: string[];
  label: string;
  primaryTier: ModelTier;
  tierFit: ModelTier[];
  hardwareFit: "excellent" | "good" | "stretch" | "hosted-fallback";
  reason: string;
}> {
  const base = [
    {
      modelId: "qwen2.5-coder:7b",
      aliases: ["qwen2.5-coder:7b", "qwen2.5-coder"],
      label: "Coding starter",
      primaryTier: "fast" as const,
      tierFit: ["fast", "standard"] as ModelTier[],
      hardwareFit: "excellent" as const,
      reason: "Good first local coding model for low-risk implementation review, summarization, and small patch planning."
    },
    {
      modelId: "llama3.1:8b",
      aliases: ["llama3.1:8b", "llama3.1"],
      label: "General developer assistant",
      primaryTier: "fast" as const,
      tierFit: ["fast"] as ModelTier[],
      hardwareFit: "excellent" as const,
      reason: "Useful general-purpose local model for triage, summaries, docs, and routine developer workflow steps."
    }
  ];
  const medium = hardwareClass === "small" ? [] : [
    {
      modelId: "qwen2.5-coder:14b",
      aliases: ["qwen2.5-coder:14b"],
      label: "Coding standard",
      primaryTier: "standard" as const,
      tierFit: ["standard"] as ModelTier[],
      hardwareFit: hardwareClass === "large" ? "excellent" as const : "good" as const,
      reason: "Better fit for larger code context, refactor planning, and stronger local standard-tier developer work."
    },
    {
      modelId: "deepseek-r1:14b",
      aliases: ["deepseek-r1:14b"],
      label: "Local reasoning starter",
      primaryTier: "reasoning" as const,
      tierFit: ["reasoning"] as ModelTier[],
      hardwareFit: hardwareClass === "large" ? "good" as const : "stretch" as const,
      reason: "Candidate for local reasoning experiments, but keep hosted fallback for high-risk decisions."
    }
  ];
  const large = hardwareClass === "large" ? [
    {
      modelId: "qwen2.5-coder:32b",
      aliases: ["qwen2.5-coder:32b"],
      label: "Large coding candidate",
      primaryTier: "reasoning" as const,
      tierFit: ["standard", "reasoning"] as ModelTier[],
      hardwareFit: "good" as const,
      reason: "Stronger local candidate for bigger coding tasks when memory is available, still gated by eval evidence."
    }
  ] : [];
  const candidates = [...base, ...medium, ...large];
  return candidates.sort((a, b) => {
    const tierBoost = (item: typeof candidates[number]) => item.primaryTier === taskMix.dominantTier ? 2 : item.tierFit.includes(taskMix.dominantTier) ? 1 : 0;
    return tierBoost(b) - tierBoost(a);
  });
}

export function localModelDownloadCommand(runtimeId: string, modelId: string): string {
  if (runtimeId === "ollama" || runtimeId === "configured-local") {
    return `ollama pull ${modelId}`;
  }
  if (runtimeId === "lm-studio") {
    return `Open LM Studio and search for ${modelId}`;
  }
  if (runtimeId === "vllm") {
    return `Download a compatible ${modelId} checkpoint, then start vLLM with its model path.`;
  }
  if (runtimeId === "llama-cpp") {
    return `Download a compatible GGUF for ${modelId}, then start llama-server with that file.`;
  }
  return `Download ${modelId} in your local OpenAI-compatible runtime.`;
}

export function normalizeFeedbackRating(value: string): FeedbackRating | null {
  const normalized = normalizeLookup(value);
  if (normalized === "accept" || normalized === "accepted" || normalized === "good" || normalized === "approved") {
    return "accepted";
  }
  if (normalized === "revise" || normalized === "revised" || normalized === "edited" || normalized === "partial") {
    return "revised";
  }
  if (normalized === "reject" || normalized === "rejected" || normalized === "bad" || normalized === "wrong") {
    return "rejected";
  }
  return null;
}

export function normalizeRouteDecisionClass(value: string): DashboardRouteReceiptTrendGroup["classification"] | null {
  return value === "local-selected" || value === "local-skipped" || value === "hosted-fallback" || value === "hosted-selected" ? value : null;
}

export function normalizeRouteDecisionFeedbackRating(value: string): RouteDecisionFeedbackRating | null {
  return value === "helpful" || value === "costly" || value === "neutral" ? value : null;
}

export function offlineFallbackQueuePath(ctx: CliContext): string {
  return path.join(ctx.rootDir, ".agent-workflow", "offline", "sync-queue.json");
}

export function offlineFallbackSyncBaseResult(input: {
  generatedAt: string;
  execute: boolean;
  sourceDatabaseUrl: string;
  targetDatabaseUrl: string;
  pendingItems: OfflineFallbackQueueItem[];
  syncedQueueItems: number;
  status: OfflineFallbackSyncResult["status"];
  written: OfflineFallbackSyncResult["written"];
  notes: string[];
  warnings: string[];
  manifest?: OfflineFallbackSyncResult["manifest"];
  importResult?: OfflineFallbackSyncResult["importResult"];
}): OfflineFallbackSyncResult {
  return {
    kind: "agentflow_offline_sync_result",
    generatedAt: input.generatedAt,
    mode: input.execute ? "execute" : "dry-run",
    status: input.status,
    sourceDatabaseUrl: redactDashboardUrl(input.sourceDatabaseUrl),
    targetDatabaseUrl: input.targetDatabaseUrl ? redactDashboardUrl(input.targetDatabaseUrl) : "missing",
    pendingQueueItems: input.pendingItems.length,
    syncedQueueItems: input.syncedQueueItems,
    manifest: input.manifest ?? {
      path: null,
      status: null,
      sourceOnlyRows: 0,
      conflictRows: 0,
      projectIdRewriteRows: 0
    },
    importResult: input.importResult ?? {
      path: null,
      status: null,
      affectedRows: 0,
      staleManifest: null
    },
    written: input.written,
    notes: input.notes,
    warnings: input.warnings
  };
}

export function offlineSyncSchedulerStatusPath(ctx: CliContext): string {
  return path.join(ctx.rootDir, ".agent-workflow", "offline", "scheduler-status.json");
}

export function orderedUnique(values: string[]): string[] {
  return [...new Set(values)];
}

export function parseLearningDaemonMode(value: string): LearningDaemonMode {
  if (value === "observe" || value === "propose" || value === "apply-approved") return value;
  throw new Error(`Learning daemon mode must be observe, propose, or apply-approved. Received: ${value}`);
}

export function parseLearningRiskLevel(value: string): LearningRiskLevel {
  const normalized = normalizeLookup(value);
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return "medium";
}

export function parseModelTierOption(value: string): CandidateVariantPlan["modelTier"] {
  const normalized = normalizeLookup(value);
  if (normalized === "fast" || normalized === "standard" || normalized === "reasoning") {
    return normalized;
  }
  throw new Error(`Model tier must be one of: fast, standard, reasoning. Received: ${value}`);
}

export function parseOfflineFallbackQueueAction(value: string): OfflineFallbackQueueAction {
  const normalized = normalizeLookup(value);
  if (normalized === "start-local" || normalized === "startlocal") return "start-local";
  if (normalized === "offline-run" || normalized === "offlinerun" || normalized === "run") return "offline-run";
  if (normalized === "sync-back" || normalized === "syncback" || normalized === "sync") return "sync-back";
  if (normalized === "use-shared" || normalized === "useshared" || normalized === "shared") return "use-shared";
  throw new Error(`Offline fallback action must be one of: start-local, offline-run, sync-back, use-shared. Received: ${value}`);
}

export function parseProposalIds(value: string | undefined): string[] | "all" {
  if (!value || value.trim().toLowerCase() === "all") {
    return "all";
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function parsePsElapsedSeconds(value: string): number | null {
  const daySplit = value.split("-");
  const days = daySplit.length === 2 ? Number.parseInt(daySplit[0] ?? "", 10) : 0;
  const timePart = daySplit.at(-1) ?? "";
  const parts = timePart.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  const [hours, minutes, seconds] = parts.length === 3
    ? parts
    : parts.length === 2
      ? [0, parts[0], parts[1]]
      : [0, 0, parts[0]];
  return (Number.isFinite(days) ? days : 0) * 86400 + (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0);
}

export function parseRuntimeMcpStaleMinutes(value = process.env.AGENTFLOW_MCP_STALE_MINUTES): number {
  return parsePositiveInteger(value ?? "", 60);
}

export function parseStaleRunReconcileLimit(value = process.env.AGENTFLOW_STALE_RUN_RECONCILE_LIMIT): number {
  return parsePositiveInteger(value ?? "", 50);
}

export function priorityRank(priority: LearningProposalPriority): number {
  return priority === "high" ? 3 : priority === "medium" ? 2 : 1;
}

export function promotionStatusRank(status: AgentImprovementPromotionStatus): number {
  return status === "pending" ? 0 : status === "deferred" ? 1 : status === "approved" ? 2 : status === "applied" ? 3 : status === "rejected" ? 4 : 5;
}

export function proposeAgentImprovement(agent: AgentCard, candidate: AgentImprovementCandidate): AgentCard {
  const proposed = structuredClone(agent);
  const notes = buildAgentImprovementPromptNotes(candidate);
  if (candidate.suggestedMutableFields.includes("prompt")) {
    proposed.prompt = appendAgentPromptNotes(proposed.prompt, notes);
  }
  if (candidate.suggestedMutableFields.includes("can")) {
    proposed.can = addUniqueStrings(proposed.can, ["Produce role-specific validation evidence before handoff."]);
  }
  if (candidate.suggestedMutableFields.includes("requires_approval")) {
    proposed.requires_approval = addUniqueStrings(proposed.requires_approval, [
      "Destructive commands, external network or export actions, privilege expansion, provider changes, and edits to shared reusable definitions."
    ]);
  }
  if (candidate.suggestedMutableFields.includes("context_budget")) {
    proposed.context_budget = {
      ...proposed.context_budget,
      preferred_sources: addUniqueStrings(proposed.context_budget.preferred_sources, ["recent relevant receipts", "evaluation evidence", "project-local tuning notes"])
    };
  }
  if (candidate.suggestedMutableFields.includes("outputs")) {
    proposed.outputs = {
      ...proposed.outputs,
      schema: proposed.outputs.schema || "structured_summary"
    };
  }
  return proposed;
}

export async function publishRoadmapSnapshotIfChanged(projectDir: string, actor: string): Promise<RoadmapSnapshotPublication> {
  const project = await loadProjectConfig(projectDir);
  const projectId = await upsertProject({
    name: project.project.name,
    rootUri: projectDir,
    profile: project.project.autonomy === "wide-open" ? "enterprise" : "custom",
    config: project
  });
  const state = await getProjectIndexState({ projectId });
  const roadmapSnapshot = await buildStoredRoadmapSnapshot({ projectId, projectDir, project });
  const existing = state && "roadmapSnapshot" in state.metadata
    ? parseRoadmapSnapshot(state.metadata.roadmapSnapshot, projectId)
    : null;
  const changed = roadmapSnapshotNeedsPublication(existing, roadmapSnapshot);
  if (changed) {
    await upsertProjectIndexState({
      projectId,
      headCommit: state?.headCommit ?? undefined,
      indexedFiles: state?.indexedFiles ?? 0,
      deletedFiles: state?.deletedFiles ?? 0,
      metadata: { ...(state?.metadata ?? {}), roadmapSnapshot }
    });
  }
  const publication: RoadmapSnapshotPublication = {
    status: changed ? "published" : "unchanged",
    projectId,
    source: roadmapSnapshot.source,
    digest: roadmapSnapshot.digest,
    sourceModifiedAt: roadmapSnapshot.sourceModifiedAt,
    publishedAt: changed ? roadmapSnapshot.publishedAt : existing?.publishedAt ?? roadmapSnapshot.publishedAt,
    reason: changed
      ? existing ? "Configured roadmap source changed since the last durable snapshot." : "No durable roadmap snapshot existed for this project."
      : "The durable roadmap snapshot already matches the configured source."
  };
  const learningDir = path.join(projectDir, ".agent-workflow", "learning");
  await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
  const receipt = {
    kind: "agentflow_roadmap_snapshot_publication",
    recordedAt: new Date().toISOString(),
    actor,
    ...publication
  };
  await fs.writeFile(path.join(learningDir, "roadmap-snapshot-publication.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(learningDir, "roadmap-snapshot-publication.md"), [
    "# Roadmap Snapshot Publication",
    "",
    `Recorded: ${receipt.recordedAt}`,
    `Actor: ${actor}`,
    `Status: ${publication.status}`,
    `Source: ${publication.source}`,
    `Source modified: ${publication.sourceModifiedAt ?? "unknown"}`,
    `Published: ${publication.publishedAt}`,
    `Digest: ${publication.digest}`,
    `Reason: ${publication.reason}`,
    ""
  ].join("\n"), "utf8");
  return publication;
}

export async function readAgentImprovementPromotionQueue(projectDir: string): Promise<AgentImprovementPromotionQueue> {
  const queuePath = path.join(projectDir, ".agent-workflow", "learning", "agent-improvement-promotions.json");
  const raw = await fs.readFile(queuePath, "utf8");
  const parsed = JSON.parse(raw) as AgentImprovementPromotionQueue;
  if (parsed.kind !== "agentflow_agent_improvement_promotion_queue" || !Array.isArray(parsed.items)) {
    throw new Error(`Invalid agent improvement promotion queue: ${queuePath}`);
  }
  return parsed;
}

export async function readAgentImprovementPromotionReceipts(projectDir: string): Promise<AgentImprovementPromotionReceiptLog> {
  const receiptsPath = path.join(projectDir, ".agent-workflow", "learning", "agent-improvement-promotion-receipts.json");
  const raw = await fs.readFile(receiptsPath, "utf8");
  const parsed = JSON.parse(raw) as AgentImprovementPromotionReceiptLog;
  if (parsed.kind !== "agentflow_agent_improvement_promotion_receipts" || !Array.isArray(parsed.events)) {
    throw new Error(`Invalid agent improvement promotion receipts: ${receiptsPath}`);
  }
  return parsed;
}

export async function readDashboardJsonFile<T>(
  filePath: string,
  validate: (value: Record<string, unknown>) => boolean
): Promise<{ exists: boolean; value: T | null; error: string | null }> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const record = objectValue(parsed);
    if (!validate(record)) {
      return { exists: true, value: null, error: "unexpected file shape" };
    }
    return { exists: true, value: parsed as T, error: null };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exists: false, value: null, error: null };
    }
    return { exists: true, value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function readDirectoryModelEntries(
  roots: LocalLlmInventoryCacheRoot[],
  lastUsedByModel: Map<string, string>,
  recommendedIds: Set<string>
): Promise<LocalLlmInventoryModel[]> {
  const entries: LocalLlmInventoryModel[] = [];
  for (const root of roots) {
    if (root.id === "ollama") continue;
    const depth = localModelCacheRoots().find((item) => item.id === root.id)?.modelDepth ?? 1;
    const modelDirs = await listModelDirectories(root.path, depth);
    for (const modelDir of modelDirs.slice(0, 50)) {
      const scan = await scanDirectorySize(modelDir.path, { maxEntries: 5000, maxDepth: 6 });
      const modelId = modelDir.name;
      const lastUsedAt = lastUsedByModel.get(modelId) ?? null;
      const stale = !lastUsedAt && scan.latestMtimeMs !== null && Date.now() - scan.latestMtimeMs > 1000 * 60 * 60 * 24 * 90;
      entries.push({
        modelId,
        source: "cache-directory",
        cacheRoot: root.label,
        cachePath: modelDir.path,
        sizeBytes: scan.sizeBytes,
        sizeLabel: formatBytes(scan.sizeBytes),
        installed: true,
        recommended: recommendedIds.has(modelId),
        lastUsedAt,
        pruneCandidate: stale && !recommendedIds.has(modelId),
        reason: stale ? "Cache directory appears older than 90 days and has no recent route or benchmark evidence." : "Detected from local model cache directory."
      });
    }
  }
  return entries;
}

export async function readLatestLocalLlmBenchmarkSummary(projectDir: string): Promise<{
  averageLatencyMs: number | null;
  averageRubricScore: number | null;
}> {
  const receiptsPath = path.join(projectDir, ".agent-workflow", "model-improvement", "local-llm-benchmark-receipts.json");
  const raw = await fs.readFile(receiptsPath, "utf8").catch(() => null);
  if (!raw) return { averageLatencyMs: null, averageRubricScore: null };
  try {
    const parsed = JSON.parse(raw) as LocalLlmBenchmarkReceiptReport;
    return {
      averageLatencyMs: parsed.summary?.averageLatencyMs ?? null,
      averageRubricScore: parsed.summary?.averageRubricScore ?? null
    };
  } catch {
    return { averageLatencyMs: null, averageRubricScore: null };
  }
}

export async function readLearningActionReceipts(projectDir: string): Promise<LearningActionReceiptLog> {
  const receiptsPath = path.join(projectDir, ".agent-workflow", "learning", "action-receipts.json");
  const raw = await fs.readFile(receiptsPath, "utf8");
  const parsed = JSON.parse(raw) as LearningActionReceiptLog;
  if (parsed.kind !== "agentflow_learning_action_receipts" || !Array.isArray(parsed.events)) {
    throw new Error(`Invalid learning action receipts: ${receiptsPath}`);
  }
  return parsed;
}

export async function readLearningApprovalQueue(projectDir: string): Promise<LearningApprovalQueue> {
  const queuePath = path.join(projectDir, ".agent-workflow", "learning", "approval-inbox.json");
  const raw = await fs.readFile(queuePath, "utf8");
  const parsed = JSON.parse(raw) as LearningApprovalQueue;
  if (parsed.kind !== "agentflow_learning_approval_queue" || !Array.isArray(parsed.items)) {
    throw new Error(`Invalid learning approval inbox: ${queuePath}`);
  }
  return parsed;
}

export async function readLearningSettings(projectDir: string): Promise<LearningSettings> {
  const settingsPath = path.join(projectDir, ".agent-workflow", "learning", "settings.json");
  const raw = await fs.readFile(settingsPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<LearningSettings>;
  if (parsed.kind !== "agentflow_learning_settings" || typeof parsed.workflowShapeAutoUpdate !== "boolean") {
    throw new Error(`Invalid learning settings: ${settingsPath}`);
  }
  return {
    kind: "agentflow_learning_settings",
    projectRootUri: typeof parsed.projectRootUri === "string" ? parsed.projectRootUri : projectDir,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    workflowShapeAutoUpdate: parsed.workflowShapeAutoUpdate,
    agentImprovementProjectLocalAutoApply: typeof parsed.agentImprovementProjectLocalAutoApply === "boolean" ? parsed.agentImprovementProjectLocalAutoApply : true,
    autonomousApplyMaxRisk: parseLearningRiskLevel(String(parsed.autonomousApplyMaxRisk ?? "medium")),
    approvalAutopilotEnabled: typeof parsed.approvalAutopilotEnabled === "boolean" ? parsed.approvalAutopilotEnabled : false,
    approvalAutopilotMaxRisk: parseApprovalAutopilotRisk(String(parsed.approvalAutopilotMaxRisk ?? parsed.autonomousApplyMaxRisk ?? "medium")),
    daemonTrustLevels: normalizeDaemonTrustSettings(parsed.daemonTrustLevels),
    daemonEnabled: typeof parsed.daemonEnabled === "boolean" ? parsed.daemonEnabled : true,
    daemonPaused: typeof parsed.daemonPaused === "boolean" ? parsed.daemonPaused : false,
    daemonMode: parseLearningDaemonMode(String(parsed.daemonMode ?? "apply-approved")),
    daemonRunLimit: Math.max(1, Math.min(500, typeof parsed.daemonRunLimit === "number" ? parsed.daemonRunLimit : 50))
  };
}

export async function readLocalLlmCacheTrendHistory(projectDir: string): Promise<{ points: LocalLlmCacheTrendPoint[] }> {
  const historyPath = path.join(projectDir, ".agent-workflow", "model-improvement", "local-llm-cache-trends.json");
  const raw = await fs.readFile(historyPath, "utf8").catch(() => null);
  if (!raw) return { points: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<LocalLlmCacheTrendReport>;
    const points = Array.isArray(parsed.history) ? parsed.history.filter(isLocalLlmCacheTrendPoint) : [];
    return { points };
  } catch {
    return { points: [] };
  }
}

export async function readLocalLlmCostLedgerHistory(projectDir: string): Promise<{ points: LocalLlmCostLedgerPoint[] }> {
  const historyPath = path.join(projectDir, ".agent-workflow", "model-improvement", "local-llm-cost-ledger.json");
  const raw = await fs.readFile(historyPath, "utf8").catch(() => null);
  if (!raw) return { points: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<LocalLlmCostLedgerReport>;
    const points = Array.isArray(parsed.history) ? parsed.history.filter(isLocalLlmCostLedgerPoint) : [];
    return { points };
  } catch {
    return { points: [] };
  }
}

export async function readLocalModelCacheRoot(root: { id: string; label: string; path: string; modelDepth: number }): Promise<LocalLlmInventoryCacheRoot> {
  const stats = await fs.stat(root.path).catch(() => null);
  if (!stats?.isDirectory()) {
    return {
      id: root.id,
      label: root.label,
      path: root.path,
      exists: false,
      sizeBytes: 0,
      sizeLabel: "0 B",
      modelDirectories: 0,
      lastModifiedAt: null,
      error: null
    };
  }
  const scan = await scanDirectorySize(root.path, { maxEntries: 25000, maxDepth: 8 });
  const modelDirectories = root.modelDepth > 0 ? await countModelDirectories(root.path, root.modelDepth) : 0;
  return {
    id: root.id,
    label: root.label,
    path: root.path,
    exists: true,
    sizeBytes: scan.sizeBytes,
    sizeLabel: formatBytes(scan.sizeBytes),
    modelDirectories,
    lastModifiedAt: scan.latestMtimeMs ? new Date(scan.latestMtimeMs).toISOString() : null,
    error: scan.truncated ? `Inventory truncated after ${scan.entriesScanned} filesystem entries.` : scan.error
  };
}

export async function readModelImprovementPlan(projectDir: string): Promise<Omit<ModelImprovementPlan, "files">> {
  const planPath = path.join(projectDir, ".agent-workflow", "model-improvement", "model-improvement-plan.json");
  const raw = await fs.readFile(planPath, "utf8");
  const parsed = JSON.parse(raw) as Omit<ModelImprovementPlan, "files">;
  if (parsed.kind !== "agentflow_model_improvement_plan" || !Array.isArray(parsed.evalCases) || !Array.isArray(parsed.datasetPlans)) {
    throw new Error(`Invalid model-improvement plan: ${planPath}`);
  }
  return parsed;
}

export function readNumberEnv(name: string, fallback: number): number {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export async function readOfflineFallbackQueue(ctx: CliContext): Promise<OfflineFallbackQueue> {
  const queue = await ctx.readJsonFile<OfflineFallbackQueue>(offlineFallbackQueuePath(ctx));
  if (!queue || queue.kind !== "agentflow_offline_fallback_queue" || !Array.isArray(queue.items)) {
    return emptyOfflineFallbackQueue();
  }
  return {
    kind: "agentflow_offline_fallback_queue",
    version: 1,
    updatedAt: queue.updatedAt || new Date().toISOString(),
    items: queue.items.map((item): OfflineFallbackQueueItem => {
      const status: OfflineFallbackQueueItem["status"] = item.status === "synced" ? "synced" : "pending";
      return {
        id: item.id,
        action: parseOfflineFallbackQueueAction(item.action),
        status,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        actor: item.actor || "unknown",
        projectRootUri: item.projectRootUri || null,
        runId: item.runId || null,
        note: item.note || ""
      };
    }).filter((item) => Boolean(item.id && item.createdAt && item.updatedAt))
  };
}

export async function readOfflineSyncSchedulerStatus(ctx: CliContext): Promise<OfflineSyncSchedulerStatus> {
  const status = await ctx.readJsonFile<OfflineSyncSchedulerStatus>(offlineSyncSchedulerStatusPath(ctx));
  if (!status || status.kind !== "agentflow_offline_sync_scheduler_status") {
    return emptyOfflineSyncSchedulerStatus();
  }
  return {
    kind: "agentflow_offline_sync_scheduler_status",
    updatedAt: status.updatedAt || new Date().toISOString(),
    status: ["idle", "waiting", "ready", "blocked", "synced", "error"].includes(status.status) ? status.status : "idle",
    mode: status.mode === "execute" ? "execute" : "dry-run",
    pendingQueueItems: Number.isFinite(status.pendingQueueItems) ? status.pendingQueueItems : 0,
    lastRunAt: status.lastRunAt ?? null,
    nextRunAfter: status.nextRunAfter ?? null,
    lastResultPath: status.lastResultPath ?? null,
    message: status.message || ""
  };
}

export function readPackageVersion(root: string): string {
  const metadata = JSON.parse(fsSync.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof metadata.version !== "string" || metadata.version.length === 0) {
    throw new Error(`Package version is missing from ${path.join(root, "package.json")}`);
  }
  return metadata.version;
}

export async function readPromotionRoutingNoteFiles(projectDir: string): Promise<DashboardPromotionNoteFileSummary[]> {
  const files = [
    ".agent-workflow/tuning/promotion-routing-note-plan.md",
    ".agent-workflow/tuning/promotion-routing-note-plan.json"
  ];
  const projectRoot = path.resolve(projectDir);
  const summaries: DashboardPromotionNoteFileSummary[] = [];
  for (const relativePath of files) {
    const targetPath = path.resolve(projectRoot, relativePath);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      summaries.push({ path: relativePath, exists: false, bytes: 0, modifiedAt: null, preview: null, error: "path escaped project" });
      continue;
    }
    try {
      const stat = await fs.stat(targetPath);
      const content = await fs.readFile(targetPath, "utf8");
      summaries.push({
        path: relativePath,
        exists: true,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        preview: relativePath.endsWith(".md") ? truncateDashboardPreview(content, 4000) : null,
        error: null
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        summaries.push({ path: relativePath, exists: false, bytes: 0, modifiedAt: null, preview: null, error: null });
      } else {
        summaries.push({
          path: relativePath,
          exists: true,
          bytes: 0,
          modifiedAt: null,
          preview: null,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  return summaries;
}

export async function readRouteDecisionFeedbackLog(projectDir: string): Promise<RouteDecisionFeedbackLog> {
  const projectRoot = path.resolve(projectDir);
  const targetPath = path.join(projectRoot, ".agent-workflow", "model-improvement", "route-decision-feedback.json");
  try {
    const parsed = JSON.parse(await fs.readFile(targetPath, "utf8")) as Partial<RouteDecisionFeedbackLog>;
    if (parsed.kind !== "agentflow_route_decision_feedback" || !Array.isArray(parsed.events)) {
      throw new Error(`Invalid route decision feedback log: ${targetPath}`);
    }
    return {
      kind: "agentflow_route_decision_feedback",
      projectRootUri: typeof parsed.projectRootUri === "string" ? parsed.projectRootUri : projectRoot,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      events: parsed.events.filter(isRouteDecisionFeedbackEvent)
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        kind: "agentflow_route_decision_feedback",
        projectRootUri: projectRoot,
        updatedAt: new Date(0).toISOString(),
        events: []
      };
    }
    throw error;
  }
}

export async function readStoragePressure(targetPath: string): Promise<LocalLlmInventoryStorage> {
  const stat = await fs.statfs(targetPath).catch(() => null);
  if (!stat) {
    return { path: targetPath, totalBytes: null, freeBytes: null, freeRatio: null, status: "unknown" };
  }
  const totalBytes = stat.blocks * stat.bsize;
  const freeBytes = stat.bavail * stat.bsize;
  const freeRatio = totalBytes > 0 ? Number((freeBytes / totalBytes).toFixed(3)) : null;
  return {
    path: targetPath,
    totalBytes,
    freeBytes,
    freeRatio,
    status: freeRatio === null ? "unknown" : freeRatio < 0.12 ? "pressure" : freeRatio < 0.2 ? "watch" : "ok"
  };
}

export async function readTuningApprovalHistory(projectDir: string): Promise<TuningApprovalHistory> {
  const historyPath = path.join(projectDir, ".agent-workflow", "tuning", "approval-history.json");
  const raw = await fs.readFile(historyPath, "utf8");
  const parsed = JSON.parse(raw) as TuningApprovalHistory;
  if (parsed.kind !== "agentflow_tuning_approval_history" || !Array.isArray(parsed.events)) throw new Error(`Invalid tuning approval history: ${historyPath}`);
  return parsed;
}

export async function readTuningApprovalQueue(projectDir: string): Promise<TuningApprovalQueue> {
  const queuePath = path.join(projectDir, ".agent-workflow", "tuning", "approval-queue.json");
  const raw = await fs.readFile(queuePath, "utf8");
  const parsed = JSON.parse(raw) as TuningApprovalQueue;
  if (parsed.kind !== "agentflow_tuning_approval_queue" || !Array.isArray(parsed.items)) {
    throw new Error(`Invalid tuning approval queue: ${queuePath}`);
  }
  return parsed;
}

export async function recordRunFeedback(input: {
  runId: string;
  rating: string;
  note: string;
  source: string;
}): Promise<{ ok: true; rating: FeedbackRating; artifactUri: string } | { ok: false; error: string }> {
  const rating = normalizeFeedbackRating(input.rating);
  if (!rating) {
    return { ok: false, error: "Rating must be accepted, revised, or rejected." };
  }

  const details = await getWorkflowRunDetails(input.runId);
  if (!details.run) {
    return { ok: false, error: `Unknown workflow run: ${input.runId}` };
  }

  const note = input.note.trim();
  const artifactContent = {
    runId: input.runId,
    workflowId: details.run.workflowId,
    task: details.run.task,
    projectName: details.run.projectName,
    projectRootUri: details.run.projectRootUri,
    rating,
    note,
    source: input.source,
    recordedAt: new Date().toISOString()
  };
  const artifactUri = await recordRunAction({
    runId: input.runId,
    agentId: "workflow-orchestrator",
    actionType: "run_feedback",
    target: input.runId,
    summary: `${rating}${note ? `: ${note}` : ""}`,
    artifactKind: "run_feedback",
    artifactContent
  });

  await upsertMemoryItem({
    projectRootUri: details.run.projectRootUri,
    sourceUri: `agentflow://feedback/${input.runId}/${Date.now()}`,
    summary: [
      `Workflow ${details.run.workflowId} feedback: ${rating}.`,
      `Task: ${details.run.task}`,
      note ? `Note: ${note}` : ""
    ].filter(Boolean).join(" "),
    metadata: {
      kind: "run_feedback",
      runId: input.runId,
      workflowId: details.run.workflowId,
      rating,
      note,
      source: input.source
    }
  });

  return { ok: true, rating, artifactUri };
}

export async function recordTuningHistory(projectDir: string, proposalIds: string[], status: TuningHistoryStatus, actor?: string, note?: string, relatedProposalId?: string): Promise<void> {
  if (!proposalIds.length) return;
  const existing = await readTuningApprovalHistory(projectDir).catch(() => undefined);
  const compacted = existing ? compactAutonomousTuningApprovalHistory(existing) : existing;
  const idsToRecord = proposalIds.filter((proposalId) => shouldRecordTuningHistoryEvent(compacted, proposalId, status, actor, note, relatedProposalId));
  if (!idsToRecord.length) {
    if (existing && compacted && compacted.events.length !== existing.events.length) {
      await writeTuningApprovalHistory(projectDir, compacted);
    }
    return;
  }
  const history = appendTuningApprovalHistory(compacted, { projectRootUri: projectDir, proposalIds: idsToRecord, status, actor, note, relatedProposalId });
  await writeTuningApprovalHistory(projectDir, history);
}

export function resolveAgentImprovementSourcePath(ctx: CliContext, projectDir: string, record: { sourcePath: string; scope: "shared" | "project-local" }): string {
  return record.scope === "shared"
    ? path.join(ctx.rootDir, record.sourcePath)
    : path.join(projectDir, record.sourcePath);
}

export function resolveAgentPatchSourcePath(ctx: CliContext, projectDir: string, patch: AgentImprovementPatch): string {
  return patch.scope === "shared" ? path.join(ctx.rootDir, patch.sourcePath) : path.join(projectDir, patch.sourcePath);
}

export const roadmapCandidates = ["ROADMAP.md", "docs/roadmap.md", "roadmap.md"] as const;

export function roundCurrency(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function routeDecisionFeedbackEventForScorer(event: RouteDecisionFeedbackEvent): LocalRoutingFeedbackEvent {
  return {
    rating: event.rating,
    workflowId: event.workflowId,
    stageId: event.stageId,
    agentId: event.agentId,
    providerId: event.providerId,
    modelTier: event.modelTier,
    routeClass: event.routeClass
  };
}

export async function runDaemonOfflineSyncScheduler(ctx: CliContext, input: { actor: string; minIntervalMs: number; execute?: boolean }): Promise<OfflineSyncSchedulerStatus> {
  const now = new Date();
  const mode: OfflineSyncSchedulerStatus["mode"] = input.execute ? "execute" : "dry-run";
  const queue = await readOfflineFallbackQueue(ctx).catch(() => emptyOfflineFallbackQueue());
  const pendingItems = queue.items.filter((item) => item.status === "pending" && (item.action === "offline-run" || item.action === "sync-back"));
  const previous = await readOfflineSyncSchedulerStatus(ctx).catch(() => emptyOfflineSyncSchedulerStatus());
  if (!pendingItems.length) {
    const status: OfflineSyncSchedulerStatus = {
      kind: "agentflow_offline_sync_scheduler_status",
      updatedAt: now.toISOString(),
      status: "idle",
      mode,
      pendingQueueItems: 0,
      lastRunAt: previous.lastRunAt,
      nextRunAfter: null,
      lastResultPath: previous.lastResultPath,
      message: "No pending offline-run or sync-back queue items."
    };
    await writeOfflineSyncSchedulerStatus(ctx, status);
    return status;
  }

  const nextRunAfter = previous.lastRunAt ? new Date(Date.parse(previous.lastRunAt) + input.minIntervalMs) : null;
  if (nextRunAfter && nextRunAfter.getTime() > now.getTime()) {
    const status: OfflineSyncSchedulerStatus = {
      kind: "agentflow_offline_sync_scheduler_status",
      updatedAt: now.toISOString(),
      status: "waiting",
      mode,
      pendingQueueItems: pendingItems.length,
      lastRunAt: previous.lastRunAt,
      nextRunAfter: nextRunAfter.toISOString(),
      lastResultPath: previous.lastResultPath,
      message: `Waiting until ${nextRunAfter.toISOString()} before the next offline sync ${mode}.`
    };
    await writeOfflineSyncSchedulerStatus(ctx, status);
    return status;
  }

  const localServices = await checkServices(defaultServiceEndpoints({
    DATABASE_URL: "postgres://agentflow:agentflow@127.0.0.1:15432/agentflow",
    REDIS_URL: "redis://127.0.0.1:16379",
    OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:19000"
  }));
  const sharedServices = await checkServices();
  if (!localServices.every((service) => service.reachable) || !sharedServices.every((service) => service.reachable)) {
    const status: OfflineSyncSchedulerStatus = {
      kind: "agentflow_offline_sync_scheduler_status",
      updatedAt: now.toISOString(),
      status: "blocked",
      mode,
      pendingQueueItems: pendingItems.length,
      lastRunAt: previous.lastRunAt,
      nextRunAfter: new Date(now.getTime() + input.minIntervalMs).toISOString(),
      lastResultPath: previous.lastResultPath,
      message: "Pending fallback work exists, but localhost fallback storage and configured shared storage are not both reachable."
    };
    await writeOfflineSyncSchedulerStatus(ctx, status);
    return status;
  }

  try {
    const result = await runOfflineFallbackSync(ctx, {
      outDir: ".agent-workflow/migrations",
      execute: input.execute === true,
      actor: input.actor
    });
    const status: OfflineSyncSchedulerStatus = {
      kind: "agentflow_offline_sync_scheduler_status",
      updatedAt: new Date().toISOString(),
      status: result.status === "ready" ? "ready" : result.status === "completed" ? "synced" : "blocked",
      mode,
      pendingQueueItems: pendingItems.length,
      lastRunAt: result.generatedAt,
      nextRunAfter: new Date(Date.parse(result.generatedAt) + input.minIntervalMs).toISOString(),
      lastResultPath: result.written.receiptPath ?? null,
      message: result.status === "ready"
        ? `Offline sync ${mode} is ready. Review the manifest/import evidence${mode === "dry-run" ? ", then execute sync from Server Readiness when appropriate" : ""}.`
        : result.status === "completed"
          ? `Offline sync execute completed and marked ${result.syncedQueueItems} queue item(s) synced.`
        : `Offline sync ${mode} returned ${result.status}.`
    };
    await writeOfflineSyncSchedulerStatus(ctx, status);
    return status;
  } catch (error) {
    const status: OfflineSyncSchedulerStatus = {
      kind: "agentflow_offline_sync_scheduler_status",
      updatedAt: new Date().toISOString(),
      status: "error",
      mode,
      pendingQueueItems: pendingItems.length,
      lastRunAt: previous.lastRunAt,
      nextRunAfter: new Date(now.getTime() + input.minIntervalMs).toISOString(),
      lastResultPath: previous.lastResultPath,
      message: error instanceof Error ? error.message : String(error)
    };
    await writeOfflineSyncSchedulerStatus(ctx, status);
    return status;
  }
}

export async function runOfflineFallbackSync(ctx: CliContext, input: { outDir: string; execute: boolean; actor: string }): Promise<OfflineFallbackSyncResult> {
  const generatedAt = new Date().toISOString();
  const sourceDatabaseUrl = "postgres://agentflow:agentflow@127.0.0.1:15432/agentflow";
  const targetDatabaseUrl = process.env.DATABASE_URL ?? "";
  const written: OfflineFallbackSyncResult["written"] = {};
  const warnings: string[] = [];
  const notes: string[] = [];
  const queue = await readOfflineFallbackQueue(ctx).catch(() => emptyOfflineFallbackQueue());
  const pendingItems = queue.items.filter((item) => item.status === "pending" && (item.action === "offline-run" || item.action === "sync-back"));
  const localServices = await checkServices(defaultServiceEndpoints({
    DATABASE_URL: sourceDatabaseUrl,
    REDIS_URL: "redis://127.0.0.1:16379",
    OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:19000"
  }));
  const sharedServices = await checkServices();
  if (!targetDatabaseUrl) warnings.push("DATABASE_URL is required for the shared storage target.");
  if (!localServices.every((service) => service.reachable)) warnings.push("Local fallback services are not all reachable; start localhost storage before syncing.");
  if (!sharedServices.every((service) => service.reachable)) warnings.push("Configured shared storage is not all reachable; wait for shared host/shared storage to return.");
  if (targetDatabaseUrl && canonicalizeDashboardDatabaseUrl(sourceDatabaseUrl) === canonicalizeDashboardDatabaseUrl(targetDatabaseUrl)) {
    warnings.push("Source and target database URLs point at the same database.");
  }
  if (!pendingItems.length) {
    notes.push("No pending offline-run or sync-back queue items were found; a dry-run manifest can still prove there are no source-only rows.");
  }
  if (warnings.length) {
    const result = offlineFallbackSyncBaseResult({
      generatedAt,
      execute: input.execute,
      sourceDatabaseUrl,
      targetDatabaseUrl,
      pendingItems,
      syncedQueueItems: 0,
      status: "blocked",
      written,
      notes,
      warnings
    });
    written.receiptPath = await writeOfflineFallbackSyncReceipt(ctx, result);
    return { ...result, written };
  }

  const manifest = await buildStorageMergeManifest({ sourceDatabaseUrl, targetDatabaseUrl });
  const manifestRows = summarizeMergeManifestRows(manifest);
  const manifestWritten = await writeStorageMergeManifestFiles(manifest, input.outDir);
  written.manifestMarkdownPath = manifestWritten.markdownPath;
  written.manifestJsonPath = manifestWritten.jsonPath;
  if (manifest.status === "blocked") {
    warnings.push(...manifest.warnings);
    const result = offlineFallbackSyncBaseResult({
      generatedAt,
      execute: input.execute,
      sourceDatabaseUrl,
      targetDatabaseUrl,
      pendingItems,
      syncedQueueItems: 0,
      status: "blocked",
      written,
      notes,
      warnings,
      manifest: {
        path: manifestWritten.jsonPath,
        status: manifest.status,
        ...manifestRows
      }
    });
    written.receiptPath = await writeOfflineFallbackSyncReceipt(ctx, result);
    return { ...result, written };
  }

  const importResult = await runStorageMergeImport({
    manifestPath: manifestWritten.jsonPath,
    sourceDatabaseUrl,
    targetDatabaseUrl,
    execute: input.execute,
    backupDir: input.outDir
  });
  const importWritten = await writeStorageMergeImportResultFiles(importResult, input.outDir);
  written.importMarkdownPath = importWritten.markdownPath;
  written.importJsonPath = importWritten.jsonPath;
  let syncedQueueItems = 0;
  if (input.execute && importResult.status === "completed") {
    const itemIds = new Set(pendingItems.map((item) => item.id));
    const now = new Date().toISOString();
    queue.items = queue.items.map((item) => {
      if (!itemIds.has(item.id)) return item;
      syncedQueueItems += 1;
      return {
        ...item,
        status: "synced",
        updatedAt: now,
        note: item.note ? `${item.note} Synced by ${input.actor}.` : `Synced by ${input.actor}.`
      };
    });
    queue.updatedAt = now;
    await writeOfflineFallbackQueue(ctx, queue);
  }
  const status = importResult.status === "blocked" ? "blocked" : input.execute ? "completed" : "ready";
  if (importResult.status === "blocked") warnings.push(...importResult.warnings);
  const result = offlineFallbackSyncBaseResult({
    generatedAt,
    execute: input.execute,
    sourceDatabaseUrl,
    targetDatabaseUrl,
    pendingItems,
    syncedQueueItems,
    status,
    written,
    notes,
    warnings,
    manifest: {
      path: manifestWritten.jsonPath,
      status: manifest.status,
      ...manifestRows
    },
    importResult: {
      path: importWritten.jsonPath,
      status: importResult.status,
      affectedRows: importResult.operations.reduce((sum, operation) => sum + operation.affectedRows, 0),
      staleManifest: importResult.staleManifest
    }
  });
  written.receiptPath = await writeOfflineFallbackSyncReceipt(ctx, result);
  return { ...result, written };
}

export function runtimeMcpCleanupConfig(): RuntimeMonitorReport["mcpCleanup"]["autoCleanup"] {
  return {
    enabled: learningDaemonMcpCleanupEnabled(),
    mode: learningDaemonMcpCleanupMode(),
    staleMinutes: parseRuntimeMcpStaleMinutes()
  };
}

export function runtimeMcpSessionKey(
  row: { pid: number; parentPid: number | null; command: string },
  parentByPid: Map<number, { pid: number; parentPid: number | null; command: string }>
): string {
  const parent = row.parentPid ? parentByPid.get(row.parentPid) : undefined;
  if (parent?.command && /npm\b.*mcp|agentflow.*mcp|apps\/mcp\/src\/index\.ts/.test(parent.command)) {
    return `parent:${parent.pid}`;
  }
  return `pid:${row.pid}`;
}

export function selectAgentImprovementHoldoutTasks(patch: AgentImprovementPatch, runs: Awaited<ReturnType<typeof listWorkflowRunsForProject>>): AgentImprovementEval["holdoutTasks"] {
  const agentTerms = new Set([
    patch.agentId,
    patch.displayName,
    ...patch.changedFields
  ].map((item) => normalizeLookup(item)).filter(Boolean));
  return runs
    .filter((run) => {
      const haystack = normalizeLookup(`${run.workflowId} ${run.task} ${run.status}`);
      return patch.scope === "shared" || [...agentTerms].some((term) => haystack.includes(term));
    })
    .slice(0, 5)
    .map((run) => ({
      runId: run.id,
      workflowId: run.workflowId,
      task: run.task,
      status: run.status,
      startedAt: run.startedAt,
      evidence: run.status === "completed" ? "completed representative run" : run.status === "failed" ? "failed representative run" : "in-flight representative run"
    }));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// YAML canonicalization (2026-09-28): agent-card YAML files get rewritten by
// YAML.stringify when a patch is proposed, so a raw text diff flags pure
// serialization re-wrapping (flow vs block style, quoting, line wrapping) as a
// change. Canonicalize both sides through parse/stringify so the diff only
// ever shows semantic changes. Unparseable text falls back to raw so a broken
// file can never silently become "no change".

export function shouldCompactLearningActionReceipt(event: LearningActionReceipt): boolean {
  return event.actor === "learning-daemon"
    && (event.status === "planned" || event.status === "applied")
    && (event.note === "apply-approved planning tick" || event.note === "autonomous local apply tick");
}

export function shouldRecordTuningHistoryEvent(history: TuningApprovalHistory | undefined, proposalId: string, status: TuningHistoryStatus, actor?: string, note?: string, relatedProposalId?: string): boolean {
  const matching = [...(history?.events ?? [])].reverse().find((event) => event.proposalId === proposalId);
  return !matching ||
    matching.status !== status ||
    matching.actor !== actor ||
    matching.note !== note ||
    matching.relatedProposalId !== relatedProposalId;
}

export function staleRunReconcileConfig(): RuntimeMonitorReport["staleRuns"]["autoReconcile"] {
  const value = process.env.AGENTFLOW_DAEMON_RECONCILE_STALE_RUNS?.trim().toLowerCase();
  return {
    enabled: value ? value !== "0" && value !== "false" && value !== "no" && value !== "off" : true,
    limit: parseStaleRunReconcileLimit()
  };
}

export function sumEstimatedStageCost(groups: DashboardRouteReceiptTrendGroup[], rates: Record<string, number>): number {
  const total = groups.reduce((sum, group) => {
    const rate = rates[group.modelTier] ?? rates.standard ?? 0;
    return sum + group.runs * rate;
  }, 0);
  return roundCurrency(total);
}

export function summarizeAgentImprovementPromotionQueue(queue: AgentImprovementPromotionQueue): string[] {
  const activeItems = queue.items.filter((item) => item.status !== "superseded");
  return [
    `${activeItems.length} promotion-ready agent improvement patch(es) queued.`,
    `${activeItems.filter((item) => item.status === "pending").length} pending decision(s).`,
    `${activeItems.filter((item) => item.status === "deferred").length} deferred decision(s).`,
    `${activeItems.filter((item) => item.status === "approved").length} approved decision(s).`,
    `${activeItems.filter((item) => item.status === "applied").length} applied promotion(s).`,
    `${activeItems.filter((item) => item.status === "rejected").length} rejected decision(s).`,
    `${activeItems.filter((item) => item.autoApplyReady).length} project-local patch(es) meet future auto-apply gates.`,
    `${activeItems.filter((item) => item.status !== "applied" && item.approvalRequired).length} patch(es) still require owner approval before editing YAML.`,
    `${queue.items.filter((item) => item.status === "superseded").length} stale promotion item(s) marked superseded.`
  ];
}

export function summarizeMergeManifestRows(manifest: StorageMergeManifest): {
  sourceOnlyRows: number;
  conflictRows: number;
  projectIdRewriteRows: number;
} {
  return {
    sourceOnlyRows: manifest.tablePlans.reduce((sum, plan) => sum + plan.insertRows, 0),
    conflictRows: manifest.tablePlans.reduce((sum, plan) => sum + plan.conflictRows, 0),
    projectIdRewriteRows: manifest.tablePlans.reduce((sum, plan) => sum + plan.projectIdRewriteRows, 0)
  };
}

export function summarizeProjectSourceKinds(files: Awaited<ReturnType<typeof listProjectFileSummaries>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    const extension = path.extname(file.sourceUri).replace(/^\./, "") || "none";
    counts[extension] = (counts[extension] ?? 0) + 1;
  }
  return counts;
}

export async function summarizeWorkflowRun(runId: string): Promise<{ ok: true; value: RunSummary } | { ok: false }> {
  const details = await getWorkflowRunDetails(runId);
  if (!details.run) {
    return { ok: false };
  }

  const artifacts = await listArtifacts({ runId });
  const stageOutputs = artifacts.filter((artifact) => artifact.kind === "stage_output");
  const failures = details.receipts
    .filter((receipt) => receipt.actionType.includes("failed") || /failed|timed out|rejected/i.test(receipt.summary))
    .map((receipt) => `${receipt.agentId}: ${receipt.summary}`);
  const commandFailures = artifacts
    .filter((artifact) => artifact.kind === "command_output")
    .filter((artifact) => {
      const exitCode = artifact.content.exitCode;
      return typeof exitCode === "number" && exitCode !== 0 || artifact.content.timedOut === true;
    })
    .map((artifact) => {
      const commandLine = typeof artifact.content.commandLine === "string" ? artifact.content.commandLine : artifact.uri;
      return `Command failed: ${commandLine}`;
    });

  const findings = collectArtifactFindings(stageOutputs);
  const completedTasks = details.tasks.filter((task) => task.status === "completed").length;
  const failedTasks = details.tasks.filter((task) => task.status === "failed" || task.status === "blocked").length;
  const pendingApprovals = (await listActionApprovals({ runId, status: "pending", limit: 25 })).map((approval) => ({
    id: approval.id,
    actionType: approval.actionType,
    target: approval.target,
    stageId: approval.stageId,
    agentId: approval.agentId,
    executable: isExecutableApprovalAction(approval.actionType)
  }));

  return {
    ok: true,
    value: {
      runId,
      status: details.run.status,
      workflowId: details.run.workflowId,
      task: details.run.task,
      projectName: details.run.projectName,
      projectRootUri: details.run.projectRootUri,
      completedTasks,
      failedTasks,
      totalTasks: details.tasks.length,
      stageResults: details.tasks.map((task) => ({
        stageId: task.stageId,
        agentId: task.agentId,
        status: task.status,
        attempts: task.attempts
      })),
      keyFindings: findings.length ? findings.slice(0, 8) : details.receipts.slice(-5).map((receipt) => `${receipt.agentId}: ${receipt.summary}`),
      failures: [...failures, ...commandFailures].slice(0, 8),
      pendingApprovals,
      artifactUris: artifacts.map((artifact) => `${artifact.kind}: ${artifact.uri}`).slice(0, 12),
      recommendedNextAction: recommendRunNextAction({
        status: details.run.status,
        workflowId: details.run.workflowId,
        failedTasks,
        failures: [...failures, ...commandFailures],
        blockedReason: details.run.blockedReason,
        pendingApprovals: pendingApprovals.length,
        replacementRunId: details.run.replacementRunId
      })
    }
  };
}

export function truncateDashboardPreview(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars).trimEnd()}\n\n...truncated for dashboard preview...`;
}

export function tuningHistoryEventSignature(event: TuningApprovalHistory["events"][number]): string {
  return [
    event.proposalId,
    event.status,
    event.actor ?? "",
    event.note ?? "",
    event.relatedProposalId ?? ""
  ].join("\0");
}

export function uniqueSorted(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))].sort((a, b) => a.localeCompare(b));
}

export function weightedAverage<T>(items: T[], valueFor: (item: T) => number, weightFor: (item: T) => number): number | null {
  const totals = items.reduce((acc, item) => {
    const weight = weightFor(item);
    return {
      weighted: acc.weighted + valueFor(item) * weight,
      weight: acc.weight + weight
    };
  }, { weighted: 0, weight: 0 });
  return totals.weight > 0 ? Number((totals.weighted / totals.weight).toFixed(2)) : null;
}

export function weightedAverageNullable<T>(items: T[], valueFor: (item: T) => number | null, weightFor: (item: T) => number): number | null {
  const totals = items.reduce((acc, item) => {
    const value = valueFor(item);
    if (value === null) return acc;
    const weight = weightFor(item);
    return {
      weighted: acc.weighted + value * weight,
      weight: acc.weight + weight
    };
  }, { weighted: 0, weight: 0 });
  return totals.weight > 0 ? Number((totals.weighted / totals.weight).toFixed(2)) : null;
}

export async function writeAgentImprovementPromotionQueue(projectDir: string, queue: AgentImprovementPromotionQueue): Promise<void> {
  const learningDir = path.join(projectDir, ".agent-workflow", "learning");
  await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
  await fs.writeFile(path.join(learningDir, "agent-improvement-promotions.json"), `${JSON.stringify(queue, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(learningDir, "agent-improvement-promotions.md"), formatAgentImprovementPromotionQueueMarkdown(queue), "utf8");
}

// Framework-level pending-promotion notification (2026-09-28): the learning
// daemon rebuilds the promotion queue every tick, but nothing ever told Jason
// a promotion was waiting, so decisions piled up unseen. These helpers count
// undecided (pending/deferred, non-superseded) items straight from the saved
// queue files, so the dashboard can banner them without rebuilding the full
// report/patch/eval pipeline on every page load.

export async function writeAgentImprovementPromotionReceipts(projectDir: string, receipts: AgentImprovementPromotionReceiptLog): Promise<void> {
  const learningDir = path.join(projectDir, ".agent-workflow", "learning");
  await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
  await fs.writeFile(path.join(learningDir, "agent-improvement-promotion-receipts.json"), `${JSON.stringify(receipts, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(learningDir, "agent-improvement-promotion-receipts.md"), formatAgentImprovementPromotionReceiptsMarkdown(receipts), "utf8");
}

export async function writeCandidateComparisonPlan(projectDir: string, plan: CandidateComparisonPlan): Promise<void> {
  for (const file of plan.files) {
    const allowed =
      file.relativePath.startsWith(".agent-workflow/model-improvement/") ||
      file.relativePath.startsWith(".agent-workflow/evaluations/");
    if (!allowed) {
      throw new Error(`Refusing to write candidate comparison plan outside project-local Agent Workflow paths: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectDir, file.relativePath);
    const projectRoot = path.resolve(projectDir);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write candidate comparison plan outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

export async function writeLearningActionReceipts(projectDir: string, receipts: LearningActionReceiptLog): Promise<void> {
  const learningDir = path.join(projectDir, ".agent-workflow", "learning");
  await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
  await fs.writeFile(path.join(learningDir, "action-receipts.json"), `${JSON.stringify(receipts, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(learningDir, "action-receipts.md"), formatLearningActionReceiptsMarkdown(receipts), "utf8");
}

export async function writeLocalLlmRoutingRecommendationReport(projectDir: string, report: LocalLlmRoutingRecommendationReport): Promise<void> {
  const projectRoot = path.resolve(projectDir);
  for (const file of report.files) {
    if (!file.relativePath.startsWith(".agent-workflow/model-improvement/")) {
      throw new Error(`Refusing to write local LLM routing recommendations outside .agent-workflow/model-improvement: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectRoot, file.relativePath);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write local LLM routing recommendations outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

export async function writeModelImprovementPlan(projectDir: string, plan: ModelImprovementPlan): Promise<void> {
  for (const file of plan.files) {
    if (!file.relativePath.startsWith(".agent-workflow/model-improvement/")) {
      throw new Error(`Refusing to write model-improvement plan outside .agent-workflow/model-improvement: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectDir, file.relativePath);
    const projectRoot = path.resolve(projectDir);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write model-improvement plan outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

export async function writeOfflineFallbackQueue(ctx: CliContext, queue: OfflineFallbackQueue): Promise<void> {
  const filePath = offlineFallbackQueuePath(ctx);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
}

export async function writeOfflineFallbackSyncReceipt(ctx: CliContext, result: OfflineFallbackSyncResult): Promise<string> {
  const receiptDir = path.join(ctx.rootDir, ".agent-workflow", "offline", "receipts");
  await fs.mkdir(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, `offline-sync-${result.generatedAt.replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(receiptPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return receiptPath;
}

export async function writeOfflineSyncSchedulerStatus(ctx: CliContext, status: OfflineSyncSchedulerStatus): Promise<void> {
  const filePath = offlineSyncSchedulerStatusPath(ctx);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

export async function writeStorageMergeImportResultFiles(result: StorageMergeImportResult, outDir: string): Promise<{ markdownPath: string; jsonPath: string }> {
  const resolvedOut = path.resolve(process.cwd(), outDir);
  await fs.mkdir(resolvedOut, { recursive: true });
  const stamp = result.generatedAt.replace(/[:.]/g, "-");
  const base = `storage-merge-import-${stamp}`;
  const markdownPath = path.join(resolvedOut, `${base}.md`);
  const jsonPath = path.join(resolvedOut, `${base}.json`);
  await fs.writeFile(markdownPath, `${formatStorageMergeImportResult(result)}\n`, "utf8");
  await fs.writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return { markdownPath, jsonPath };
}

export async function writeStorageMergeManifestFiles(manifest: StorageMergeManifest, outDir: string): Promise<{ markdownPath: string; jsonPath: string }> {
  const resolvedOut = path.resolve(process.cwd(), outDir);
  await fs.mkdir(resolvedOut, { recursive: true });
  const stamp = manifest.generatedAt.replace(/[:.]/g, "-");
  const base = `storage-merge-manifest-${stamp}`;
  const markdownPath = path.join(resolvedOut, `${base}.md`);
  const jsonPath = path.join(resolvedOut, `${base}.json`);
  await fs.writeFile(markdownPath, `${formatStorageMergeManifest(manifest)}\n`, "utf8");
  await fs.writeFile(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { markdownPath, jsonPath };
}

export async function writeTuningApprovalHistory(projectDir: string, history: TuningApprovalHistory): Promise<void> {
  const tuningDir = path.join(projectDir, ".agent-workflow", "tuning");
  await fs.mkdir(tuningDir, { recursive: true });
  await fs.writeFile(path.join(tuningDir, "approval-history.json"), `${JSON.stringify(history, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(tuningDir, "approval-history.md"), formatTuningApprovalHistoryMarkdown(history), "utf8");
}


function escapeHtml(value: string): string {
  return escapeHtmlText(value);
}

export async function countAgentImprovementPendingPromotions(projectDir: string): Promise<{ pending: number; deferred: number } | null> {
  const queue = await readAgentImprovementPromotionQueue(path.resolve(process.cwd(), projectDir)).catch(() => null);
  if (!queue) {
    return null;
  }
  return {
    pending: queue.items.filter((item) => item.status === "pending").length,
    deferred: queue.items.filter((item) => item.status === "deferred").length
  };
}

export function renderAgentImprovementPendingBannerHtml(summary: AgentImprovementPendingSummary | null): string {
  if (!summary || summary.projects.length === 0) {
    return "";
  }
  const current = summary.projects.find((entry) => entry.current);
  const others = summary.projects.filter((entry) => entry !== current);
  const totalFor = (entry: AgentImprovementPendingProject) => entry.pending + entry.deferred;
  const reviewHref = (entry: AgentImprovementPendingProject) => `/learning?project=${encodeURIComponent(entry.projectRootUri)}&view=agent-improvements`;
  const currentBlock = current
    ? `<div><strong>${dashboardIcon("shield")} ${totalFor(current)} agent-improvement promotion${totalFor(current) === 1 ? "" : "s"} awaiting review</strong><span>${current.pending} pending \u00b7 ${current.deferred} deferred \u00b7 ${escapeHtml(current.name)}</span></div><a class="button" href="${escapeHtml(reviewHref(current))}">Review promotions</a>`
    : "";
  const othersBlock = others.length
    ? `<div><span class="muted">Also awaiting review: ${others.map((entry) => `<a href="${escapeHtml(reviewHref(entry))}">${escapeHtml(entry.name)} (${totalFor(entry)})</a>`).join(" \u00b7 ")}</span></div>`
    : "";
  return `<section class="panel flash-panel">${currentBlock}${othersBlock}</section>`;
}
