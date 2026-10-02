import type { CliContext } from "./context.js";
import type { DashboardCandidateComparisonReport, DashboardLocalHoldoutRoutingStatus, DashboardLocalLlmRoutingDecisionTimeline, DashboardLocalLlmRoutingDecisionTimelineItem, DashboardLocalLlmRoutingNoteApplicationStatus, DashboardRouteReceiptTrendReport, LocalHoldoutResultSummary, LocalHoldoutRoutingPromotion, LocalLlmBenchmarkReceipt, LocalLlmBenchmarkReceiptReport, LocalLlmBenchmarkTask, LocalLlmCacheTrendReport, LocalLlmCostLedgerReport, LocalLlmDownloadRecommendationReport, LocalLlmInstallationPlanReport, LocalLlmInventoryReport, LocalLlmPrunePlanReport, LocalLlmRouteSmokeResult, LocalLlmRoutingDecisionSnapshot, LocalLlmRoutingDecisionSnapshotDelta, LocalLlmRoutingDecisionSnapshotItem, LocalLlmRoutingDecisionSnapshotLog, LocalLlmRoutingDecisionSnapshotReport, LocalLlmRoutingNoteApplicationPlan, LocalLlmRoutingNotePlan, LocalLlmRoutingNotePlanDocument, LocalLlmRoutingRecommendation, LocalLlmRoutingRecommendationReport, LocalLlmRuntimeProbe, LocalLlmSetupChecklistReport, LocalLlmSetupGuideReport, RouteDecisionFeedbackEvent, RouteDecisionFeedbackLog, RouteDecisionFeedbackResult } from "./cli-types.js";
import { buildDashboardLocalProviderEvidence, buildDashboardRouteReceiptTrends, buildLocalLlmCacheTrendReport, buildLocalLlmCostLedgerReport, buildLocalLlmDownloadRecommendationReport, buildLocalLlmInstallationPlanReport, buildLocalLlmInventoryReport, buildLocalLlmPrunePlanReport, buildLocalLlmRoutingRecommendationReport, buildLocalLlmSmokeOutcomeTrend, classifyDashboardRouteReceipt, formatDurationDelta, formatUsd, loadCostQualityReportsForDashboardRuns, loadDashboardLocalHoldoutRoutingStatus, loadLocalLlmSetupChecklistReport, loadLocalLlmSetupGuideReport, loadPreferenceScorecard, normalizeRouteDecisionClass, normalizeRouteDecisionFeedbackRating, readModelImprovementPlan, readRouteDecisionFeedbackLog, readTuningApprovalQueue, roundCurrency, truncateDashboardPreview, writeModelImprovementPlan } from "./builders-learning.js";
import { countStrings, formatBytes, isRecord, loadCostQualityReport, normalizeWorkerId, queueWorkflow, shellQuote, sleep, truncateText } from "./builders-shared.js";
import { type ModelImprovementPlan, buildModelImprovementPlan, buildRunExport } from "../../../../packages/run-reporter/src/index.js";
import { checkServices } from "../../../../packages/storage/src/doctor.js";
import { getWorkflowRunDetails, listArtifacts, listWorkflowRunsForProject } from "../../../../packages/storage/src/postgres.js";
import { runWorkerOnce } from "../../../../packages/workflow-engine/src/executor.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function buildDashboardLocalLlmRoutingDecisionTimeline(input: {
  projectDir: string;
  recommendations: LocalLlmRoutingRecommendationReport;
  noteApplication: DashboardLocalLlmRoutingNoteApplicationStatus;
  routeReceiptTrends: DashboardRouteReceiptTrendReport;
}): Promise<DashboardLocalLlmRoutingDecisionTimeline> {
  const projectRoot = path.resolve(input.projectDir);
  const notePlan = await readLocalLlmRoutingNotePlan(projectRoot).catch(() => null);
  const noteByRecommendation = new Map((notePlan?.notes ?? []).map((note) => [note.recommendationId, note]));
  const applied = new Set(input.noteApplication.appliedNoteIds);
  const skipped = new Set(input.noteApplication.skippedNoteIds);
  const activeMarkers = input.noteApplication.activePreferencePreview ?? "";
  const topRecommendations = input.recommendations.recommendations
    .slice()
    .sort((a, b) => {
      const actionRank = { retreat: 0, expand: 1, hold: 2 };
      return actionRank[a.action] - actionRank[b.action] || b.runs - a.runs || a.id.localeCompare(b.id);
    })
    .slice(0, 12);
  const items = topRecommendations.map((recommendation): DashboardLocalLlmRoutingDecisionTimelineItem => {
    const note = noteByRecommendation.get(recommendation.id) ?? null;
    const routeGroup = input.routeReceiptTrends.topGroups.find((group) =>
      group.workflowId === recommendation.workflowId &&
      group.stageId === recommendation.stageId &&
      group.agentId === recommendation.agentId
    ) ?? null;
    const marker = note ? `agentflow-local-routing-note:${note.id}` : "";
    const active = marker ? activeMarkers.includes(marker) : false;
    const state: DashboardLocalLlmRoutingDecisionTimelineItem["state"] = active || (note && applied.has(note.id))
      ? "applied"
      : note && skipped.has(note.id)
        ? "skipped"
        : note
          ? "planned"
          : recommendation.action === "hold"
            ? "monitoring"
            : "recommended";
    return {
      recommendationId: recommendation.id,
      state,
      action: recommendation.action,
      priority: recommendation.priority,
      target: `${recommendation.workflowId}/${recommendation.stageId}`,
      agentId: recommendation.agentId,
      noteId: note?.id ?? null,
      routeClass: routeGroup?.classification ?? recommendation.routeClass,
      providerTier: `${recommendation.providerId}/${recommendation.modelTier}`,
      runs: routeGroup?.runs ?? recommendation.runs,
      fallbackRate: routeGroup && routeGroup.runs ? Number((routeGroup.fallbackCount / routeGroup.runs).toFixed(2)) : recommendation.fallbackRate,
      quality: routeGroup?.averageQuality ?? recommendation.averageQuality,
      netSavingsUsd: recommendation.estimatedNetSavingsUsd,
      outcome: routeGroup?.latestReason || recommendation.recommendation
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    projectRootUri: projectRoot,
    status: items.some((item) => item.state === "applied")
      ? "active"
      : items.some((item) => item.state === "planned")
        ? "planned"
        : items.some((item) => item.state === "recommended")
          ? "recommended"
          : "monitoring",
    sourceRecommendationGeneratedAt: input.recommendations.generatedAt,
    sourceNotePlanGeneratedAt: notePlan?.generatedAt ?? null,
    sourceApplicationGeneratedAt: input.noteApplication.generatedAt,
    summary: [
      `${items.length} routing decision timeline item(s).`,
      `${items.filter((item) => item.state === "applied").length} applied, ${items.filter((item) => item.state === "planned").length} planned, ${items.filter((item) => item.state === "recommended").length} recommended.`,
      "Later quality outcome is read from current route receipt trends."
    ],
    items
  };
}

export function buildLocalHoldoutResultSummary(report: DashboardCandidateComparisonReport): LocalHoldoutResultSummary {
  const generatedAt = new Date().toISOString();
  const results = report.promotionRecommendations.map((recommendation) => {
    const outcome = report.outcomes.find((item) => item.suiteId === recommendation.suiteId);
    return {
      suiteId: recommendation.suiteId,
      decision: recommendation.decision,
      gateReady: outcome?.gateReady ?? false,
      baselineRuns: outcome?.baselineRuns ?? 0,
      candidateRuns: outcome?.candidateRuns ?? 0,
      qualityDelta: outcome?.qualityDelta ?? null,
      latencyDeltaMs: outcome?.latencyDeltaMs ?? null,
      latestAt: outcome?.latestAt ?? null,
      rationale: recommendation.rationale,
      nextAction: recommendation.nextAction
    };
  });
  const summary = {
    suites: report.comparisonPlan?.suites.length ?? 0,
    gateReady: results.filter((item) => item.gateReady).length,
    promotable: results.filter((item) => item.decision === "propose_routing_note").length,
    preferHosted: results.filter((item) => item.decision === "keep_baseline").length,
    needsEvidence: results.filter((item) => item.decision === "run_more_evals").length
  };
  const decision: LocalHoldoutResultSummary["decision"] = !report.comparisonPlan
    ? "no_plan"
    : summary.needsEvidence === summary.suites
      ? "needs_evidence"
      : summary.promotable > 0 && summary.preferHosted === 0 && summary.needsEvidence === 0
        ? "eligible_for_review"
        : summary.preferHosted > 0 && summary.promotable === 0
          ? "prefer_hosted"
          : "mixed";
  const document = {
    kind: "agentflow_local_holdout_results" as const,
    projectRootUri: report.projectDir,
    generatedAt,
    sourceComparisonPlanGeneratedAt: report.comparisonPlan?.generatedAt ?? null,
    decision,
    summary,
    results
  };
  return {
    ...document,
    files: [
      {
        relativePath: ".agent-workflow/model-improvement/local-holdout-results.md",
        content: formatLocalHoldoutResultSummaryMarkdown(document)
      },
      {
        relativePath: ".agent-workflow/model-improvement/local-holdout-results.json",
        content: `${JSON.stringify(document, null, 2)}\n`
      }
    ]
  };
}

export function buildLocalHoldoutRoutingPromotion(
  projectDir: string,
  results: Omit<LocalHoldoutResultSummary, "files">,
  approved: boolean
): LocalHoldoutRoutingPromotion {
  const generatedAt = new Date().toISOString();
  const eligibleResults = results.results.filter((result) => result.decision === "propose_routing_note" && result.gateReady);
  const eligibleSuites = eligibleResults.map((result) => result.suiteId);
  const qualityDeltas = eligibleResults.map((result) => result.qualityDelta).filter((value): value is number => typeof value === "number");
  const latencyDeltas = eligibleResults.map((result) => result.latencyDeltaMs).filter((value): value is number => typeof value === "number");
  const thresholds = {
    minEvidenceSuites: 1,
    minQualityDelta: 0,
    maxLatencyRegressionMs: 500,
    maxFallbackRate: 0.1
  };
  const evidence = {
    gateReadySuites: results.summary.gateReady,
    promotableSuites: eligibleSuites.length,
    worstQualityDelta: qualityDeltas.length ? Math.min(...qualityDeltas) : null,
    worstLatencyDeltaMs: latencyDeltas.length ? Math.max(...latencyDeltas) : null,
    fallbackRate: null as number | null
  };
  const thresholdPassed = evidence.promotableSuites >= thresholds.minEvidenceSuites
    && (evidence.worstQualityDelta ?? -1) >= thresholds.minQualityDelta
    && (evidence.worstLatencyDeltaMs ?? 0) <= thresholds.maxLatencyRegressionMs;
  const status: LocalHoldoutRoutingPromotion["status"] = results.decision === "eligible_for_review" && approved && thresholdPassed
    ? "ready"
    : "blocked";
  const reason = !approved
    ? "Owner approval is required before writing project-local local-model routing preferences."
    : results.decision !== "eligible_for_review"
      ? `Captured holdout result decision is ${results.decision}; collect more evidence before promoting local routing.`
      : !thresholdPassed
        ? "Captured holdout results did not satisfy the minimum suite, quality, and latency thresholds for local routing promotion."
        : "Local routing is approved for low-risk project-local developer stages only.";
  const preference = status === "ready"
    ? {
      provider: "local" as const,
      maxRisk: "low" as const,
      scope: "low-risk read-only developer stages with hosted fallback",
      evidenceSuites: eligibleSuites,
      thresholds,
      evidence,
      rollback: "Remove .agent-workflow/tuning/local-routing-threshold.json and regenerate routing-preferences.md from reviewed tuning overlays."
    }
    : null;
  const document = {
    kind: "agentflow_local_holdout_routing_promotion" as const,
    projectRootUri: projectDir,
    generatedAt,
    sourceResultsGeneratedAt: results.generatedAt ?? null,
    status,
    approved,
    reason,
    preference
  };
  return {
    ...document,
    files: status === "ready"
      ? [
        {
          relativePath: ".agent-workflow/tuning/local-routing-threshold.json",
          content: `${JSON.stringify(document, null, 2)}\n`
        },
        {
          relativePath: ".agent-workflow/tuning/routing-preferences.md",
          content: formatLocalHoldoutRoutingPreferenceMarkdown(document)
        }
      ]
      : []
  };
}

export async function buildLocalLlmBenchmarkReceiptReport(input: {
  projectDir: string;
  execute: boolean;
  timeoutMs: number;
  checklist: LocalLlmSetupChecklistReport;
  setupGuide: LocalLlmSetupGuideReport;
  downloads: LocalLlmDownloadRecommendationReport;
}): Promise<LocalLlmBenchmarkReceiptReport> {
  const generatedAt = new Date().toISOString();
  const runtime = input.setupGuide.recommendedRuntime
    ?? input.setupGuide.runtimes.find((item) => item.status === "ready")
    ?? null;
  const installed = input.downloads.recommendations.filter((candidate) => candidate.installed);
  const fallbackPlan = input.downloads.recommendations.slice(0, 2);
  const candidates = (installed.length ? installed : fallbackPlan).slice(0, 3);
  const benchmarkTasks = localLlmBenchmarkTasks();
  const receipts: LocalLlmBenchmarkReceipt[] = [];
  for (const candidate of candidates) {
    for (const task of benchmarkTasks) {
      const startedAt = new Date().toISOString();
      const executable = Boolean(input.execute && runtime && candidate.installed);
      if (!executable) {
        receipts.push({
          id: `bench-${String(receipts.length + 1).padStart(3, "0")}`,
          generatedAt,
          startedAt,
          finishedAt: null,
          status: input.execute ? "skipped" : "planned",
          modelId: candidate.modelId,
          runtime: runtime ? { id: runtime.id, label: runtime.label, baseUrl: runtime.baseUrl } : null,
          taskId: task.id,
          taskLabel: task.label,
          latencyMs: null,
          outputChars: null,
          rubricScore: null,
          verdict: "needs-runtime",
          evidence: executable ? [] : [
            runtime ? "Candidate model was not detected in the local runtime catalog." : "No ready local OpenAI-compatible runtime was detected.",
            "Use --execute only after the runtime is running and /v1/models lists the candidate."
          ],
          error: null
        });
        continue;
      }
      const activeRuntime = runtime!;
      const result = await executeLocalLlmBenchmarkPrompt(activeRuntime, candidate.modelId, task.prompt, input.timeoutMs);
      receipts.push({
        id: `bench-${String(receipts.length + 1).padStart(3, "0")}`,
        generatedAt,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: result.ok ? "completed" : "failed",
        modelId: candidate.modelId,
        runtime: { id: activeRuntime.id, label: activeRuntime.label, baseUrl: activeRuntime.baseUrl },
        taskId: task.id,
        taskLabel: task.label,
        latencyMs: result.latencyMs,
        outputChars: result.output?.length ?? null,
        rubricScore: result.ok ? scoreLocalLlmBenchmarkOutput(task, result.output ?? "") : null,
        verdict: result.ok ? "measured" : "failed",
        evidence: result.ok
          ? [`Completed tiny ${task.label} benchmark locally.`, `Output sample: ${truncateText(result.output ?? "", 120)}`]
          : [],
        error: result.error
      });
    }
  }
  const completed = receipts.filter((receipt) => receipt.status === "completed");
  const averageLatencyMs = completed.length
    ? Math.round(completed.reduce((sum, receipt) => sum + (receipt.latencyMs ?? 0), 0) / completed.length)
    : null;
  const averageRubricScore = completed.length
    ? Number((completed.reduce((sum, receipt) => sum + (receipt.rubricScore ?? 0), 0) / completed.length).toFixed(2))
    : null;
  const status: LocalLlmBenchmarkReceiptReport["status"] = !runtime
    ? "runtime-needed"
    : !installed.length
      ? "no-installed-models"
      : input.execute
        ? completed.length === receipts.length ? "completed" : "partial"
        : "planned";
  const nextAction = status === "completed"
    ? "Use these receipts as local promotion evidence before expanding local routing."
    : status === "planned"
      ? `Run npm run agentflow -- local-llm-benchmarks --project ${shellQuote(input.projectDir)} --execute --write to measure installed local candidates.`
      : status === "no-installed-models"
        ? "Download one recommended model, confirm it appears in /v1/models, then rerun local-llm-benchmarks."
        : "Start a local OpenAI-compatible runtime, then rerun local-llm-benchmarks.";
  const document = {
    kind: "agentflow_local_llm_benchmark_receipts" as const,
    generatedAt,
    projectRootUri: input.projectDir,
    status,
    execute: input.execute,
    timeoutMs: input.timeoutMs,
    runtime: runtime ? { id: runtime.id, label: runtime.label, baseUrl: runtime.baseUrl, modelCount: runtime.modelCount } : null,
    candidateModels: candidates.map((candidate) => ({
      modelId: candidate.modelId,
      installed: candidate.installed,
      primaryTier: candidate.primaryTier,
      hardwareFit: candidate.hardwareFit
    })),
    tasks: benchmarkTasks.map(({ id, label, rubric }) => ({ id, label, rubric })),
    summary: {
      receipts: receipts.length,
      completed: completed.length,
      failed: receipts.filter((receipt) => receipt.status === "failed").length,
      planned: receipts.filter((receipt) => receipt.status === "planned").length,
      skipped: receipts.filter((receipt) => receipt.status === "skipped").length,
      averageLatencyMs,
      averageRubricScore
    },
    receipts,
    nextAction
  };
  return {
    ...document,
    files: [
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-benchmark-receipts.md",
        content: formatLocalLlmBenchmarkReceiptMarkdown(document)
      },
      {
        relativePath: ".agent-workflow/model-improvement/local-llm-benchmark-receipts.json",
        content: `${JSON.stringify(document, null, 2)}\n`
      }
    ]
  };
}

export async function buildLocalLlmRoutingDecisionSnapshotReport(
  projectDir: string,
  timeline: DashboardLocalLlmRoutingDecisionTimeline,
  write: boolean
): Promise<LocalLlmRoutingDecisionSnapshotReport> {
  const existing = await readLocalLlmRoutingDecisionSnapshotLog(projectDir);
  const snapshot = createLocalLlmRoutingDecisionSnapshot(timeline);
  const latest = existing.snapshots.at(-1) ?? null;
  const changed = latest?.decisionHash !== snapshot.decisionHash;
  const snapshots = changed ? [...existing.snapshots, snapshot].slice(-50) : existing.snapshots;
  const previous = snapshots.length >= 2 ? snapshots.at(-2) ?? null : null;
  const latestForComparison = snapshots.at(-1) ?? snapshot;
  const delta = compareLocalLlmRoutingDecisionSnapshots(previous, latestForComparison);
  const log: LocalLlmRoutingDecisionSnapshotLog = {
    kind: "agentflow_local_llm_routing_decision_snapshots",
    projectRootUri: path.resolve(projectDir),
    updatedAt: new Date().toISOString(),
    snapshots,
    latestDelta: delta
  };
  const files = [
    {
      relativePath: ".agent-workflow/model-improvement/local-routing-decision-snapshots.md",
      content: formatLocalLlmRoutingDecisionSnapshotMarkdown(log)
    },
    {
      relativePath: ".agent-workflow/model-improvement/local-routing-decision-snapshots.json",
      content: `${JSON.stringify(log, null, 2)}\n`
    }
  ];
  const report = {
    ...log,
    captured: changed,
    currentSnapshot: snapshot,
    files
  };
  if (write) {
    await writeLocalLlmRoutingDecisionSnapshotReport(projectDir, report);
  }
  return report;
}

export async function buildLocalLlmRoutingNoteApplicationPlan(input: {
  projectDir: string;
  notePlan: LocalLlmRoutingNotePlanDocument;
  selectedIds: string[] | "all";
  approved: boolean;
}): Promise<LocalLlmRoutingNoteApplicationPlan> {
  const projectRoot = path.resolve(input.projectDir);
  const generatedAt = new Date().toISOString();
  const requestedIds = input.selectedIds === "all"
    ? input.notePlan.notes.map((note) => note.id)
    : input.selectedIds;
  const requestedSet = new Set(requestedIds);
  const selectedNotes = input.notePlan.notes.filter((note) =>
    requestedSet.has(note.id) || requestedSet.has(note.recommendationId)
  );
  const matchedIds = new Set(selectedNotes.flatMap((note) => [note.id, note.recommendationId]));
  const routingPath = path.join(projectRoot, ".agent-workflow", "tuning", "routing-preferences.md");
  const existingContent = await fs.readFile(routingPath, "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const beforeHash = createHash("sha256").update(existingContent).digest("hex");
  const selectedFreshNotes = selectedNotes.filter((note) => !existingContent.includes(`agentflow-local-routing-note:${note.id}`));
  const appendedSection = selectedFreshNotes.length
    ? [
      existingContent.trimEnd(),
      "",
      `## Local LLM Routing Notes (${generatedAt})`,
      "",
      ...selectedFreshNotes.map((note) => [
        `<!-- agentflow-local-routing-note:${note.id} -->`,
        `### ${note.workflowId}/${note.stageId}`,
        "",
        `- Action: ${note.action}`,
        `- Priority: ${note.priority}`,
        `- Agent: ${note.agentId}`,
        `- Direction: ${note.direction}`,
        "",
        note.draftNote,
        ""
      ].join("\n"))
    ].join("\n").trimStart()
    : existingContent;
  const nextContent = appendedSection && !appendedSection.endsWith("\n") ? `${appendedSection}\n` : appendedSection;
  const afterHash = createHash("sha256").update(nextContent).digest("hex");
  const document = {
    kind: "agentflow_local_llm_routing_note_application" as const,
    generatedAt,
    projectRootUri: projectRoot,
    sourcePlanGeneratedAt: input.notePlan.generatedAt,
    approved: input.approved,
    selectedNoteIds: selectedNotes.map((note) => note.id),
    appliedNoteIds: selectedFreshNotes.map((note) => note.id),
    skippedNoteIds: [
      ...requestedIds.filter((id) => !matchedIds.has(id)),
      ...selectedNotes.filter((note) => !selectedFreshNotes.some((fresh) => fresh.id === note.id)).map((note) => note.id)
    ],
    targetFile: ".agent-workflow/tuning/routing-preferences.md" as const,
    beforeHash,
    afterHash,
    rollback: "Restore .agent-workflow/tuning/routing-preferences.md to the recorded beforeHash content or remove sections marked agentflow-local-routing-note:<id>.",
    summary: [
      `${selectedFreshNotes.length} routing note(s) ready to append.`,
      selectedNotes.length === selectedFreshNotes.length ? "No duplicate selected notes were detected." : `${selectedNotes.length - selectedFreshNotes.length} duplicate selected note(s) were skipped.`,
      input.approved ? "Approved flag is present for write mode." : "Dry-run mode requires --approved before writing."
    ]
  };
  return {
    ...document,
    files: [
      {
        relativePath: ".agent-workflow/tuning/routing-preferences.md",
        content: nextContent
      },
      {
        relativePath: ".agent-workflow/tuning/local-routing-note-application.md",
        content: formatLocalLlmRoutingNoteApplicationMarkdown(document)
      },
      {
        relativePath: ".agent-workflow/tuning/local-routing-note-application.json",
        content: `${JSON.stringify(document, null, 2)}\n`
      }
    ]
  };
}

export function buildLocalLlmRoutingNotePlan(
  report: LocalLlmRoutingRecommendationReport,
  selectedIds: string[] | "all" = "all"
): LocalLlmRoutingNotePlan {
  const requestedIds = selectedIds === "all"
    ? report.recommendations.map((recommendation) => recommendation.id)
    : selectedIds;
  const requestedSet = new Set(requestedIds);
  const selectedRecommendations = report.recommendations.filter((recommendation): recommendation is LocalLlmRoutingRecommendation & { action: "expand" | "retreat" } =>
    requestedSet.has(recommendation.id) && recommendation.action !== "hold"
  );
  const selectedSet = new Set(selectedRecommendations.map((recommendation) => recommendation.id));
  const generatedAt = new Date().toISOString();
  const notes = selectedRecommendations.map((recommendation) => {
    const direction: LocalLlmRoutingNotePlan["notes"][number]["direction"] = recommendation.action === "expand" ? "prefer_local_trial" : "prefer_hosted_fallback";
    const targetFile: LocalLlmRoutingNotePlan["notes"][number]["targetFile"] = ".agent-workflow/tuning/routing-preferences.md";
    return {
      id: `routing-note-${recommendation.id}`,
      recommendationId: recommendation.id,
      action: recommendation.action,
      priority: recommendation.priority,
      workflowId: recommendation.workflowId,
      stageId: recommendation.stageId,
      agentId: recommendation.agentId,
      direction,
      targetFile,
      draftNote: [
        `For ${recommendation.workflowId}/${recommendation.stageId} (${recommendation.agentId}), ${recommendation.action === "expand" ? "trial local routing" : "prefer hosted fallback"} based on savings-aware routing evidence.`,
        `Route evidence: ${recommendation.routeClass} via ${recommendation.providerId}/${recommendation.modelTier}; runs=${recommendation.runs}; fallback=${recommendation.fallbackRate}; quality=${recommendation.averageQuality ?? "n/a"}.`,
        `Economics: estimated net savings ${formatUsd(recommendation.estimatedNetSavingsUsd)}.`,
        "Rollback: remove this note from .agent-workflow/tuning/routing-preferences.md and regenerate the routing recommendation report."
      ].join(" "),
      reasons: recommendation.reasons
    };
  });
  const document = {
    kind: "agentflow_local_llm_routing_note_plan" as const,
    projectRootUri: report.projectRootUri,
    generatedAt,
    sourceRecommendationsGeneratedAt: report.generatedAt,
    selectedRecommendationIds: selectedRecommendations.map((recommendation) => recommendation.id),
    skippedRecommendationIds: requestedIds.filter((id) => !selectedSet.has(id)),
    summary: [
      `${notes.length} reviewed local routing note(s) prepared.`,
      "Only expand and retreat recommendations become routing-note patch plans.",
      "This plan does not edit shared workflows, reusable agents, provider settings, or project source."
    ],
    notes
  };
  return {
    ...document,
    files: [
      {
        relativePath: ".agent-workflow/tuning/local-routing-note-plan.md",
        content: formatLocalLlmRoutingNotePlanMarkdown(document)
      },
      {
        relativePath: ".agent-workflow/tuning/local-routing-note-plan.json",
        content: `${JSON.stringify(document, null, 2)}\n`
      }
    ]
  };
}

export function compareLocalLlmRoutingDecisionSnapshots(
  previous: LocalLlmRoutingDecisionSnapshot | null,
  current: LocalLlmRoutingDecisionSnapshot
): LocalLlmRoutingDecisionSnapshotDelta {
  if (!previous) {
    return emptyLocalLlmRoutingDecisionSnapshotDelta(null);
  }
  const previousByKey = new Map(previous.items.map((item) => [localLlmRoutingDecisionSnapshotItemKey(item), item]));
  const currentByKey = new Map(current.items.map((item) => [localLlmRoutingDecisionSnapshotItemKey(item), item]));
  const added = [...currentByKey.keys()].filter((key) => !previousByKey.has(key));
  const removed = [...previousByKey.keys()].filter((key) => !currentByKey.has(key));
  const changed = [...currentByKey.entries()].filter(([key, item]) => {
    const old = previousByKey.get(key);
    return old && createHash("sha256").update(JSON.stringify(old)).digest("hex") !== createHash("sha256").update(JSON.stringify(item)).digest("hex");
  });
  return {
    previousAt: previous.generatedAt,
    changed: previous.decisionHash !== current.decisionHash,
    added: added.length,
    removed: removed.length,
    changedItems: changed.length,
    netSavingsDeltaUsd: roundCurrency(current.totalNetSavingsUsd - previous.totalNetSavingsUsd),
    stateChanges: changed
      .map(([key, item]) => {
        const old = previousByKey.get(key);
        return old && old.state !== item.state ? `${key}: ${old.state} -> ${item.state}` : "";
      })
      .filter(Boolean)
      .slice(0, 12)
  };
}

export function createLocalLlmRoutingDecisionSnapshot(timeline: DashboardLocalLlmRoutingDecisionTimeline): LocalLlmRoutingDecisionSnapshot {
  const items = timeline.items.map((item) => ({
    recommendationId: item.recommendationId,
    state: item.state,
    action: item.action,
    priority: item.priority,
    target: item.target,
    agentId: item.agentId,
    routeClass: item.routeClass,
    providerTier: item.providerTier,
    runs: item.runs,
    fallbackRate: item.fallbackRate,
    quality: item.quality,
    netSavingsUsd: item.netSavingsUsd,
    outcome: item.outcome
  }));
  const decisionHash = createHash("sha256").update(JSON.stringify(items)).digest("hex");
  return {
    generatedAt: new Date().toISOString(),
    sourceTimelineGeneratedAt: timeline.generatedAt,
    decisionHash,
    status: timeline.status,
    counts: countStrings(items.map((item) => item.state)),
    totalNetSavingsUsd: roundCurrency(items.reduce((sum, item) => sum + item.netSavingsUsd, 0)),
    summary: timeline.summary,
    items
  };
}

export function emptyLocalHoldoutResultSummary(projectDir: string, rationale: string): Omit<LocalHoldoutResultSummary, "files"> {
  return {
    kind: "agentflow_local_holdout_results",
    projectRootUri: projectDir,
    generatedAt: new Date().toISOString(),
    sourceComparisonPlanGeneratedAt: null,
    decision: "no_plan",
    summary: {
      suites: 0,
      gateReady: 0,
      promotable: 0,
      preferHosted: 0,
      needsEvidence: 0
    },
    results: [
      {
        suiteId: "none",
        decision: "run_more_evals",
        gateReady: false,
        baselineRuns: 0,
        candidateRuns: 0,
        qualityDelta: null,
        latencyDeltaMs: null,
        latestAt: null,
        rationale: [rationale],
        nextAction: `npm run agentflow -- local-holdout-results --project ${shellQuote(projectDir)} --write`
      }
    ]
  };
}

export function emptyLocalLlmRoutingDecisionSnapshotDelta(previousAt: string | null): LocalLlmRoutingDecisionSnapshotDelta {
  return {
    previousAt,
    changed: false,
    added: 0,
    removed: 0,
    changedItems: 0,
    netSavingsDeltaUsd: 0,
    stateChanges: []
  };
}

export async function emptyLocalLlmSetupChecklistForFailure(ctx: CliContext, projectDir: string, reason: string): Promise<LocalLlmSetupChecklistReport> {
  const emptyHoldout: DashboardLocalHoldoutRoutingStatus = {
    status: "error",
    generatedAt: new Date().toISOString(),
    projectRootUri: projectDir,
    resultsPath: ".agent-workflow/model-improvement/local-holdout-results.json",
    promotionPath: ".agent-workflow/tuning/local-routing-threshold.json",
    resultsExists: false,
    promotionExists: false,
    resultsDecision: null,
    promotionStatus: null,
    approved: false,
    maxRisk: null,
    evidenceSuites: [],
    thresholdSummary: null,
    evidenceSummary: null,
    promotableSuites: [],
    localStageCount: 0,
    hostedStageCount: 0,
    localFallbackRate: null,
    hostedFallbackBoundary: "Hosted providers remain the required fallback for high-risk, command, secret, policy, production, network, reusable bundle, and export actions.",
    recommendation: reason,
    error: reason
  };
  return loadLocalLlmSetupChecklistReport(ctx, {
    projectDir,
    localHoldoutRouting: emptyHoldout,
    routeReceiptTrends: buildDashboardRouteReceiptTrends(projectDir, []),
    smokeOutcomes: buildLocalLlmSmokeOutcomeTrend(projectDir, [], [])
  });
}

export function escapeMarkdownTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/gu, " ").trim();
}

export async function executeLocalLlmBenchmarkPrompt(runtime: LocalLlmRuntimeProbe, modelId: string, prompt: string, timeoutMs: number): Promise<{
  ok: boolean;
  latencyMs: number | null;
  output: string | null;
  error: string | null;
}> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${runtime.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(process.env.LOCAL_MODEL_API_KEY ? { authorization: `Bearer ${process.env.LOCAL_MODEL_API_KEY}` } : {})
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: "system", content: "You are a concise local developer-assistant benchmark. Follow the requested format exactly." },
          { role: "user", content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 160
      })
    });
    const latencyMs = Date.now() - started;
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, latencyMs, output: null, error: `HTTP ${response.status}: ${truncateText(text, 220)}` };
    }
    const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const output = parsed.choices?.[0]?.message?.content?.trim() ?? "";
    return output
      ? { ok: true, latencyMs, output, error: null }
      : { ok: false, latencyMs, output: null, error: "No chat completion content returned." };
  } catch (error) {
    const latencyMs = Date.now() - started;
    return {
      ok: false,
      latencyMs,
      output: null,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function exportWorkflowRun(input: {
  runId: string;
  outDir: string;
  scrub?: boolean;
}): Promise<
  | { ok: true; markdownPath: string; jsonPath: string }
  | { ok: false }
> {
  const details = await getWorkflowRunDetails(input.runId);
  if (!details.run) {
    return { ok: false };
  }

  const artifacts = await listArtifacts({ runId: input.runId });
  const document = buildRunExport({
    run: details.run,
    tasks: details.tasks,
    receipts: details.receipts,
    artifacts,
    scrub: input.scrub
  });
  await fs.mkdir(input.outDir, { recursive: true });
  const markdownPath = path.join(input.outDir, `${input.runId}.md`);
  const jsonPath = path.join(input.outDir, `${input.runId}.json`);
  await fs.writeFile(markdownPath, document.markdown, "utf8");
  await fs.writeFile(jsonPath, `${JSON.stringify(document.json, null, 2)}\n`, "utf8");

  return {
    ok: true,
    markdownPath,
    jsonPath
  };
}

export function formatLocalHoldoutResultSummary(result: LocalHoldoutResultSummary): string {
  return [
    `Local Holdout Results: ${result.projectRootUri}`,
    `Generated: ${result.generatedAt}`,
    `Decision: ${result.decision}`,
    `Suites: ${result.summary.suites}`,
    `Gate ready: ${result.summary.gateReady}`,
    `Promotable: ${result.summary.promotable}`,
    `Prefer hosted: ${result.summary.preferHosted}`,
    `Needs evidence: ${result.summary.needsEvidence}`,
    "",
    "Files",
    result.files.map((file) => `- ${file.relativePath} (${file.content.length} bytes)`).join("\n")
  ].join("\n");
}

export function formatLocalHoldoutResultSummaryMarkdown(result: Omit<LocalHoldoutResultSummary, "files">): string {
  const rows = result.results.map((item) =>
    `| ${item.suiteId} | ${item.decision} | ${item.gateReady ? "yes" : "no"} | ${item.baselineRuns} | ${item.candidateRuns} | ${item.qualityDelta ?? "n/a"} | ${item.latencyDeltaMs === null ? "n/a" : formatDurationDelta(item.latencyDeltaMs)} | ${item.latestAt ?? "n/a"} |`
  ).join("\n");
  return [
    "# Agent Workflow Local Holdout Results",
    "",
    `Generated: ${result.generatedAt}`,
    `Project: ${result.projectRootUri}`,
    `Source comparison plan: ${result.sourceComparisonPlanGeneratedAt ?? "unavailable"}`,
    `Decision: ${result.decision}`,
    "",
    "This file captures local LLM versus hosted-provider evidence. It does not change live routing, provider settings, approval policy, or shared workflow definitions.",
    "",
    "## Summary",
    "",
    `- Suites: ${result.summary.suites}`,
    `- Gate ready: ${result.summary.gateReady}`,
    `- Promotable: ${result.summary.promotable}`,
    `- Prefer hosted: ${result.summary.preferHosted}`,
    `- Needs evidence: ${result.summary.needsEvidence}`,
    "",
    "## Suites",
    "",
    "| Suite | Decision | Gate Ready | Baseline Runs | Candidate Runs | Quality Delta | Latency Delta | Latest |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
    rows || "| none | needs_evidence | no | 0 | 0 | n/a | n/a | n/a |",
    "",
    "## Rationale",
    "",
    result.results.length
      ? result.results.map((item) => [
        `### ${item.suiteId}`,
        "",
        ...item.rationale.map((rationale) => `- ${rationale}`),
        `- Next action: ${item.nextAction}`
      ].join("\n")).join("\n\n")
      : "- No comparison outcomes are available yet."
  ].join("\n");
}

export function formatLocalHoldoutRoutingPreferenceMarkdown(promotion: Omit<LocalHoldoutRoutingPromotion, "files">): string {
  const preference = promotion.preference;
  return [
    "# Agent Workflow Routing Preference Notes",
    "",
    `Generated: ${promotion.generatedAt}`,
    `Source local holdout results: ${promotion.sourceResultsGeneratedAt ?? "unavailable"}`,
    "",
    "## Local Holdout Promotion",
    "",
    `- Status: ${promotion.status}`,
    `- Approved: ${promotion.approved ? "yes" : "no"}`,
    `- Reason: ${promotion.reason}`,
    preference ? `- Provider: ${preference.provider}` : "",
    preference ? `- Max risk: ${preference.maxRisk}` : "",
    preference ? `- Scope: ${preference.scope}` : "",
    preference ? `- Evidence suites: ${preference.evidenceSuites.join(", ")}` : "",
    preference ? `- Min evidence suites: ${preference.thresholds.minEvidenceSuites}` : "",
    preference ? `- Min quality delta: ${preference.thresholds.minQualityDelta}` : "",
    preference ? `- Max latency regression ms: ${preference.thresholds.maxLatencyRegressionMs}` : "",
    preference ? `- Max fallback rate: ${preference.thresholds.maxFallbackRate}` : "",
    preference ? `- Promotable suites: ${preference.evidence.promotableSuites}` : "",
    preference ? `- Worst quality delta: ${preference.evidence.worstQualityDelta ?? "n/a"}` : "",
    preference ? `- Worst latency delta ms: ${preference.evidence.worstLatencyDeltaMs ?? "n/a"}` : "",
    preference ? `- Observed fallback rate: ${preference.evidence.fallbackRate ?? "n/a"}` : "",
    preference ? `- Rollback: ${preference.rollback}` : "",
    "",
    "Use this preference only for low-risk read-only developer stages. Hosted providers remain the fallback for authorization, command policy, secret handling, production deployment, and high-risk changes.",
    ""
  ].filter(Boolean).join("\n");
}

export function formatLocalHoldoutRoutingPromotion(promotion: LocalHoldoutRoutingPromotion): string {
  return [
    `Local Holdout Routing Promotion: ${promotion.projectRootUri}`,
    `Generated: ${promotion.generatedAt}`,
    `Status: ${promotion.status}`,
    `Approved: ${promotion.approved ? "yes" : "no"}`,
    `Reason: ${promotion.reason}`,
    promotion.preference ? `Scope: ${promotion.preference.scope}` : "",
    promotion.preference ? `Evidence suites: ${promotion.preference.evidenceSuites.join(", ")}` : "",
    promotion.preference ? `Thresholds: minSuites=${promotion.preference.thresholds.minEvidenceSuites}, minQualityDelta=${promotion.preference.thresholds.minQualityDelta}, maxLatencyRegressionMs=${promotion.preference.thresholds.maxLatencyRegressionMs}, maxFallbackRate=${promotion.preference.thresholds.maxFallbackRate}` : "",
    promotion.preference ? `Evidence: promotableSuites=${promotion.preference.evidence.promotableSuites}, worstQualityDelta=${promotion.preference.evidence.worstQualityDelta ?? "n/a"}, worstLatencyDeltaMs=${promotion.preference.evidence.worstLatencyDeltaMs ?? "n/a"}` : "",
    "",
    "Files",
    promotion.files.length
      ? promotion.files.map((file) => `- ${file.relativePath} (${file.content.length} bytes)`).join("\n")
      : "- No files will be written."
  ].filter(Boolean).join("\n");
}

export function formatLocalLlmBenchmarkReceiptMarkdown(report: Omit<LocalLlmBenchmarkReceiptReport, "files">): string {
  const rows = report.receipts.map((receipt) =>
    `| ${receipt.id} | ${receipt.status} | ${receipt.modelId} | ${receipt.taskLabel} | ${receipt.latencyMs ?? "n/a"} | ${receipt.rubricScore ?? "n/a"} | ${receipt.verdict} | ${receipt.error ?? receipt.evidence.join(" ")} |`
  ).join("\n");
  return [
    "# Agent Workflow Local LLM Benchmark Receipts",
    "",
    `Generated: ${report.generatedAt}`,
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    `Mode: ${report.execute ? "execute" : "plan"}`,
    "",
    "These receipts benchmark installed local model candidates with tiny developer prompts before local smoke promotion. They do not call hosted models, change provider settings, or edit shared workflow definitions.",
    "",
    "## Summary",
    "",
    `- Receipts: ${report.summary.receipts}`,
    `- Completed: ${report.summary.completed}`,
    `- Failed: ${report.summary.failed}`,
    `- Planned: ${report.summary.planned}`,
    `- Skipped: ${report.summary.skipped}`,
    `- Average latency: ${report.summary.averageLatencyMs ?? "n/a"} ms`,
    `- Average rubric score: ${report.summary.averageRubricScore ?? "n/a"}`,
    "",
    "## Receipts",
    "",
    "| ID | Status | Model | Task | Latency ms | Score | Verdict | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    rows || "| none | n/a | n/a | n/a | n/a | n/a | n/a | No candidates found. |",
    "",
    "## Next Action",
    "",
    report.nextAction,
    ""
  ].join("\n");
}

export function formatLocalLlmBenchmarkReceiptReport(report: LocalLlmBenchmarkReceiptReport): string {
  return [
    "Local LLM Benchmark Receipts",
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    `Mode: ${report.execute ? "execute" : "plan"}`,
    `Runtime: ${report.runtime ? `${report.runtime.label} ${report.runtime.baseUrl}` : "none"}`,
    `Candidates: ${report.candidateModels.map((candidate) => `${candidate.modelId}${candidate.installed ? "" : " (not installed)"}`).join(", ") || "none"}`,
    `Summary: completed=${report.summary.completed}, failed=${report.summary.failed}, planned=${report.summary.planned}, skipped=${report.summary.skipped}, avgLatency=${report.summary.averageLatencyMs ?? "n/a"}ms, avgScore=${report.summary.averageRubricScore ?? "n/a"}`,
    `Next: ${report.nextAction}`,
    "",
    ...report.receipts.map((receipt) => [
      `- ${receipt.id} ${receipt.status}: ${receipt.modelId} / ${receipt.taskLabel}`,
      `  latency: ${receipt.latencyMs ?? "n/a"}ms; score: ${receipt.rubricScore ?? "n/a"}; verdict: ${receipt.verdict}`,
      receipt.error ? `  error: ${receipt.error}` : "",
      receipt.evidence.length ? `  evidence: ${receipt.evidence.join(" ")}` : ""
    ].filter(Boolean).join("\n"))
  ].join("\n");
}

export function formatLocalLlmCacheTrendReport(report: LocalLlmCacheTrendReport): string {
  return [
    "Local LLM Cache Trend History",
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    `Snapshots: ${report.history.length}`,
    `Current cache: ${report.current.totalCacheLabel}; free disk: ${report.current.freeBytes === null ? "unknown" : formatBytes(report.current.freeBytes)}`,
    `Models: ${report.current.modelCount}; prune candidates: ${report.current.pruneCandidateCount}; reclaimable: ${report.current.reclaimableLabel}`,
    `Route mix: local selected ${report.current.localSelected}, local skipped ${report.current.localSkipped}, hosted fallback ${report.current.hostedFallback}, hosted selected ${report.current.hostedSelected}`,
    `Delta: cache ${report.comparison.cacheDeltaLabel}, free disk ${report.comparison.freeDeltaLabel}, models ${report.comparison.modelDelta ?? "n/a"}, prune candidates ${report.comparison.pruneCandidateDelta ?? "n/a"}`,
    `Recommendation: ${report.recommendation}`
  ].join("\n");
}

export function formatLocalLlmCostLedgerReport(report: LocalLlmCostLedgerReport): string {
  return [
    "Local LLM Cost Ledger",
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    `Snapshots: ${report.history.length}`,
    `Net estimated savings: ${formatUsd(report.current.netEstimatedSavingsUsd)}`,
    `Avoided hosted cost: ${formatUsd(report.current.avoidedHostedUsd)}; fallback hosted cost: ${formatUsd(report.current.fallbackHostedUsd)}; local storage/month: ${formatUsd(report.current.storageUsdPerMonth)}`,
    `Routes: local selected ${report.current.localSelectedStages}, local skipped ${report.current.localSkippedStages}, hosted fallback ${report.current.hostedFallbackStages}, hosted selected ${report.current.hostedSelectedStages}`,
    `Benchmark: latency ${report.current.benchmarkAverageLatencyMs === null ? "n/a" : `${report.current.benchmarkAverageLatencyMs}ms`}, score ${report.current.benchmarkAverageScore ?? "n/a"}`,
    `Recommendation: ${report.recommendation}`
  ].join("\n");
}

export function formatLocalLlmDownloadRecommendationReport(report: LocalLlmDownloadRecommendationReport): string {
  return [
    "Local LLM Download Recommendations",
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    `Hardware: ${report.hardware.class} (${report.hardware.memoryGb} GB RAM, ${report.hardware.cpuCount} CPU cores, ${report.hardware.platform}/${report.hardware.arch})`,
    `Task mix: dominant=${report.taskMix.dominantTier}, runs=${report.taskMix.runsAnalyzed}`,
    `Recommended model: ${report.recommendedModelId ?? "none"}`,
    `Next: ${report.nextAction}`,
    "",
    ...report.recommendations.map((item) => [
      `- ${item.modelId} (${item.priority}, ${item.primaryTier}, ${item.hardwareFit})`,
      `  installed: ${item.installed ? "yes" : "no"}`,
      `  command: ${item.downloadCommand}`,
      `  why: ${item.rationale.join(" ")}`
    ].join("\n"))
  ].join("\n");
}

export function formatLocalLlmInstallationPlanReport(report: LocalLlmInstallationPlanReport): string {
  return [
    "Local LLM Installation Plan",
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    `Selected: ${report.selectedModels}`,
    `Recommended model: ${report.recommendedModelId ?? "none"}`,
    report.missingIds.length ? `Missing selections: ${report.missingIds.join(", ")}` : "",
    `Next: ${report.nextAction}`,
    "",
    ...report.actions.map((action) => [
      `- ${action.id} ${action.modelId} (${action.priority}, ${action.primaryTier}, ${action.risk} risk)`,
      `  runtime: ${action.runtime}; disk estimate: ${action.diskEstimateGb} GB; installed: ${action.installed ? "yes" : "no"}`,
      ...action.commands.map((command) => `  ${command.requiresApproval ? "[approval] " : ""}${command.label}: ${command.command}`),
      `  env hints: ${action.envHints.join("; ")}`
    ].join("\n"))
  ].filter(Boolean).join("\n");
}

export function formatLocalLlmInventoryReport(report: LocalLlmInventoryReport): string {
  return [
    "Local LLM Disk/Cache Inventory",
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    `Total cache: ${report.totalCacheLabel}`,
    `Storage: ${report.storage.status}${report.storage.freeBytes === null ? "" : `, ${formatBytes(report.storage.freeBytes)} free`}`,
    `Models: ${report.models.length}; prune candidates: ${report.pruneCandidates.length}`,
    `Recommendation: ${report.recommendation}`,
    "",
    "Cache roots",
    ...report.cacheRoots.map((root) => `- ${root.label}: ${root.exists ? root.sizeLabel : "missing"} (${root.path})${root.error ? ` - ${root.error}` : ""}`),
    "",
    "Models",
    ...(report.models.length ? report.models.map((model) => `- ${model.modelId}: ${model.sizeLabel}, ${model.cacheRoot}, last used ${model.lastUsedAt ?? "unknown"}${model.pruneCandidate ? " [prune candidate]" : ""}`) : ["- none"])
  ].join("\n");
}

export function formatLocalLlmPrunePlanReport(report: LocalLlmPrunePlanReport): string {
  return [
    "Local LLM Prune Plan",
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    `Selected: ${report.selectedModels}`,
    `Potential reclaim: ${report.reclaimableLabel}`,
    report.missingIds.length ? `Missing selections: ${report.missingIds.join(", ")}` : "",
    `Next: ${report.nextAction}`,
    "",
    ...report.actions.map((action) => [
      `- ${action.id} ${action.modelId} (${action.risk} risk, ${action.sizeLabel})`,
      `  cache: ${action.cacheRoot}${action.cachePath ? ` ${action.cachePath}` : ""}`,
      `  last used: ${action.lastUsedAt ?? "unknown"}; recommended: ${action.recommended ? "yes" : "no"}`,
      `  [approval] Cleanup command: ${action.command}`,
      `  reason: ${action.reason}`
    ].join("\n"))
  ].filter(Boolean).join("\n");
}

export function formatLocalLlmRouteSmokeResult(result: LocalLlmRouteSmokeResult): string {
  return [
    "Local LLM Route Smoke",
    `Project: ${result.projectRootUri}`,
    `Status: ${result.status}`,
    `Run: ${result.runId ?? "not queued"}`,
    `Route class: ${result.routeClass}`,
    result.route ? `Provider/tier: ${result.route.providerId}/${result.route.modelTier}` : "",
    result.route ? `Route reason: ${result.route.routeReason}` : "",
    result.exportMarkdownPath ? `Exported Markdown: ${result.exportMarkdownPath}` : "",
    result.exportJsonPath ? `Exported JSON: ${result.exportJsonPath}` : "",
    `Summary: ${result.summary}`,
    `Next: ${result.nextAction}`,
    "",
    formatLocalLlmSetupChecklistReport(result.checklist)
  ].filter(Boolean).join("\n");
}

export function formatLocalLlmRoutingDecisionSnapshotMarkdown(log: LocalLlmRoutingDecisionSnapshotLog): string {
  const latest = log.snapshots.at(-1) ?? null;
  const rows = log.snapshots.slice(-20).reverse().map((snapshot) =>
    `| ${snapshot.generatedAt} | ${snapshot.status} | ${snapshot.decisionHash.slice(0, 12)} | ${snapshot.items.length} | ${snapshot.counts.applied ?? 0} | ${snapshot.counts.planned ?? 0} | ${snapshot.counts.recommended ?? 0} | ${formatUsd(snapshot.totalNetSavingsUsd)} |`
  ).join("\n");
  return [
    "# Agent Workflow Local Routing Decision Snapshots",
    "",
    `Project: ${log.projectRootUri}`,
    `Updated: ${log.updatedAt}`,
    "",
    "This append-only local history stores compact routing-decision state for dashboard comparison. It does not store prompt text, model outputs, API keys, or project source.",
    "",
    "## Latest",
    "",
    `- Snapshot: ${latest?.generatedAt ?? "none"}`,
    `- Status: ${latest?.status ?? "none"}`,
    `- Decision hash: ${latest?.decisionHash ?? "none"}`,
    `- Previous snapshot: ${log.latestDelta.previousAt ?? "none"}`,
    `- Delta: added=${log.latestDelta.added}, removed=${log.latestDelta.removed}, changed=${log.latestDelta.changedItems}, net savings=${formatUsd(log.latestDelta.netSavingsDeltaUsd)}`,
    "",
    "## History",
    "",
    "| Captured | Status | Hash | Items | Applied | Planned | Recommended | Net Savings |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    rows || "| none | none | none | 0 | 0 | 0 | 0 | $0.0000 |",
    ""
  ].join("\n");
}

export function formatLocalLlmRoutingDecisionSnapshotReport(report: LocalLlmRoutingDecisionSnapshotReport): string {
  return [
    `Local Routing Decision Snapshots: ${report.projectRootUri}`,
    `Updated: ${report.updatedAt}`,
    `Snapshots: ${report.snapshots.length}`,
    `Captured current snapshot: ${report.captured ? "yes" : "no, unchanged from latest"}`,
    `Current hash: ${report.currentSnapshot.decisionHash.slice(0, 16)}`,
    `Previous snapshot: ${report.latestDelta.previousAt ?? "none"}`,
    `Delta: added=${report.latestDelta.added} removed=${report.latestDelta.removed} changed=${report.latestDelta.changedItems} netSavings=${formatUsd(report.latestDelta.netSavingsDeltaUsd)}`,
    report.latestDelta.stateChanges.length ? `State changes: ${report.latestDelta.stateChanges.join("; ")}` : "State changes: none"
  ].join("\n");
}

export function formatLocalLlmRoutingNoteApplicationMarkdown(plan: Omit<LocalLlmRoutingNoteApplicationPlan, "files">): string {
  return [
    "# Agent Workflow Local LLM Routing Note Application",
    "",
    `Generated: ${plan.generatedAt}`,
    `Project: ${plan.projectRootUri}`,
    `Source plan: ${plan.sourcePlanGeneratedAt}`,
    `Approved: ${plan.approved ? "yes" : "no"}`,
    "",
    "## Summary",
    "",
    ...plan.summary.map((item) => `- ${item}`),
    "",
    "## Receipts",
    "",
    `- Target file: ${plan.targetFile}`,
    `- Selected notes: ${plan.selectedNoteIds.length ? plan.selectedNoteIds.join(", ") : "none"}`,
    `- Applied notes: ${plan.appliedNoteIds.length ? plan.appliedNoteIds.join(", ") : "none"}`,
    `- Skipped notes: ${plan.skippedNoteIds.length ? plan.skippedNoteIds.join(", ") : "none"}`,
    `- Before hash: ${plan.beforeHash}`,
    `- After hash: ${plan.afterHash}`,
    `- Rollback: ${plan.rollback}`,
    ""
  ].join("\n");
}

export function formatLocalLlmRoutingNoteApplicationPlan(plan: LocalLlmRoutingNoteApplicationPlan): string {
  return [
    `Local LLM Routing Note Application: ${plan.projectRootUri}`,
    `Generated: ${plan.generatedAt}`,
    `Approved: ${plan.approved ? "yes" : "no"}`,
    `Selected notes: ${plan.selectedNoteIds.length ? plan.selectedNoteIds.join(", ") : "none"}`,
    `Applied notes: ${plan.appliedNoteIds.length ? plan.appliedNoteIds.join(", ") : "none"}`,
    plan.skippedNoteIds.length ? `Skipped notes: ${plan.skippedNoteIds.join(", ")}` : "",
    ...plan.summary.map((item) => `- ${item}`),
    `Rollback: ${plan.rollback}`,
    "",
    "Files",
    plan.files.map((file) => `- ${file.relativePath} (${file.content.length} bytes)`).join("\n")
  ].filter(Boolean).join("\n");
}

export function formatLocalLlmRoutingNotePlan(plan: LocalLlmRoutingNotePlan): string {
  return [
    `Local LLM Routing Note Plan: ${plan.projectRootUri}`,
    `Generated: ${plan.generatedAt}`,
    `Selected recommendations: ${plan.selectedRecommendationIds.length ? plan.selectedRecommendationIds.join(", ") : "none"}`,
    plan.skippedRecommendationIds.length ? `Skipped recommendations: ${plan.skippedRecommendationIds.join(", ")}` : "",
    ...plan.summary.map((item) => `- ${item}`),
    "",
    "Files",
    plan.files.map((file) => `- ${file.relativePath} (${file.content.length} bytes)`).join("\n")
  ].filter(Boolean).join("\n");
}

export function formatLocalLlmRoutingNotePlanMarkdown(plan: Omit<LocalLlmRoutingNotePlan, "files">): string {
  return [
    "# Agent Workflow Local LLM Routing Note Plan",
    "",
    `Generated: ${plan.generatedAt}`,
    `Project: ${plan.projectRootUri}`,
    `Source recommendations: ${plan.sourceRecommendationsGeneratedAt}`,
    "",
    "This plan is review-only. It converts savings-aware expand/retreat recommendations into project-local routing notes. It does not edit shared workflows, reusable agents, provider settings, project source, or live routing by itself.",
    "",
    "## Summary",
    "",
    ...plan.summary.map((item) => `- ${item}`),
    "",
    "## Draft Notes",
    "",
    plan.notes.length
      ? plan.notes.map((note) => [
        `### ${note.id}`,
        "",
        `- Recommendation: ${note.recommendationId}`,
        `- Action: ${note.action}`,
        `- Priority: ${note.priority}`,
        `- Target: ${note.workflowId}/${note.stageId} (${note.agentId})`,
        `- Direction: ${note.direction}`,
        `- Target file: ${note.targetFile}`,
        "",
        "Reasons:",
        note.reasons.map((item) => `- ${item}`).join("\n"),
        "",
        "Draft routing note:",
        "",
        note.draftNote,
        ""
      ].join("\n")).join("\n")
      : "_No expand or retreat recommendations selected._",
    ""
  ].join("\n");
}

export function formatLocalLlmRoutingRecommendationReport(report: LocalLlmRoutingRecommendationReport): string {
  return [
    "Local LLM Routing Recommendations",
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    ...report.summary.map((item) => `- ${item}`),
    `Next: ${report.nextAction}`,
    "",
    ...report.recommendations.map((item) => [
      `- ${item.id} ${item.priority} ${item.action}: ${item.workflowId}/${item.stageId}/${item.agentId}`,
      `  route: ${item.routeClass} ${item.providerId}/${item.modelTier}; runs=${item.runs}; fallback=${item.fallbackRate}; quality=${item.averageQuality ?? "n/a"}; latency=${item.averageLatencyMs ?? "n/a"}ms`,
      `  savings: ${formatUsd(item.estimatedNetSavingsUsd)}`,
      `  recommendation: ${item.recommendation}`,
      `  reasons: ${item.reasons.join(" ")}`
    ].join("\n"))
  ].join("\n");
}

export function formatLocalLlmSetupChecklistReport(report: LocalLlmSetupChecklistReport): string {
  return [
    "Local LLM Setup Checklist",
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    `Endpoint: ${report.localProvider.baseUrl}`,
    `Model: ${report.localProvider.model}`,
    `Provider status: ${report.localProvider.status}`,
    `Models listed: ${report.localProvider.modelsListed}`,
    `Tier models: ${report.localProvider.selectedTierModels.map((item) => `${item.tier}=${item.model} (${item.source})`).join(", ") || "none"}`,
    `Routing: default=${report.routing.defaultProvider}, auto=${report.routing.autoProviders}, fast=${report.routing.fastProvider}, standard=${report.routing.standardProvider}`,
    `Smoke outcomes: ${report.smokeOutcomes.smokeRuns} run(s), first local success=${report.smokeOutcomes.firstSuccessAt ?? "none"}, latest=${report.smokeOutcomes.latestSmokeAt ?? "none"}`,
    `Latest smoke issue: ${report.smokeOutcomes.latestFailureReason ?? "none"}`,
    `Smoke recommendation: ${report.smokeOutcomes.recommendation}`,
    "",
    "Checks:",
    ...report.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}\n  Next: ${check.nextAction}`),
    "",
    "Next commands:",
    ...report.nextCommands.map((command) => `- ${command}`)
  ].join("\n");
}

export function formatLocalLlmSetupGuideReport(report: LocalLlmSetupGuideReport): string {
  return [
    "Local LLM Setup Guide",
    `Project: ${report.projectRootUri}`,
    `Status: ${report.status}`,
    `Approved: ${report.approved ? "yes" : "no"}`,
    `Routing note eligible: ${report.routingNoteEligible ? "yes" : "no"}`,
    `Recommended runtime: ${report.recommendedRuntime ? `${report.recommendedRuntime.label} ${report.recommendedRuntime.baseUrl}` : "none"}`,
    `Recommendation: ${report.recommendation}`,
    "",
    "Blockers:",
    ...(report.blockers.length ? report.blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
    "",
    "Detected runtimes:",
    ...report.runtimes.map((runtime) => `- ${runtime.label}: ${runtime.status} at ${runtime.baseUrl} (${runtime.modelCount} models). Next: ${runtime.nextAction}`),
    "",
    "Files:",
    ...(report.files.length ? report.files.map((file) => `- ${file.relativePath} (${file.content.length} bytes)`) : ["- none"])
  ].join("\n");
}

export function formatRouteDecisionFeedbackMarkdown(log: RouteDecisionFeedbackLog): string {
  const rows = log.events.slice(-50).reverse().map((event) =>
    `| ${event.createdAt} | ${event.rating} | ${event.workflowId}/${event.stageId}/${event.agentId} | ${event.providerId}/${event.modelTier} | ${event.routeClass} | ${event.runs} | ${event.fallbackCount} | ${escapeMarkdownTableCell(event.note || "n/a")} |`
  ).join("\n");
  return [
    "# Agent Workflow Route Decision Feedback",
    "",
    `Project: ${log.projectRootUri}`,
    `Updated: ${log.updatedAt}`,
    "",
    "This local learning log stores user feedback about route decisions shown in the model-improvement drilldown. It does not store prompt text, model outputs, API keys, or project source.",
    "",
    "| Created | Rating | Target | Route | Class | Runs | Fallbacks | Note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    rows || "| none | none | none | none | none | 0 | 0 | none |",
    ""
  ].join("\n");
}

export function formatRouteDecisionFeedbackResult(result: Extract<RouteDecisionFeedbackResult, { ok: true }>): string {
  return [
    `Recorded ${result.event.rating} route feedback.`,
    `Target: ${result.event.workflowId}/${result.event.stageId}/${result.event.agentId}`,
    `Route: ${result.event.providerId}/${result.event.modelTier} (${result.event.routeClass})`,
    `Artifact: ${result.artifactUri}`,
    `Events: ${result.totalEvents}`
  ].join("\n");
}

export function isLocalLlmRoutingDecisionSnapshot(value: unknown): value is LocalLlmRoutingDecisionSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LocalLlmRoutingDecisionSnapshot>;
  return typeof candidate.generatedAt === "string"
    && typeof candidate.decisionHash === "string"
    && Array.isArray(candidate.items);
}

export async function loadDashboardLocalLlmRoutingNoteApplicationStatus(projectDir: string): Promise<DashboardLocalLlmRoutingNoteApplicationStatus> {
  const projectRoot = path.resolve(projectDir);
  const applicationPath = path.join(projectRoot, ".agent-workflow", "tuning", "local-routing-note-application.json");
  const routingPath = path.join(projectRoot, ".agent-workflow", "tuning", "routing-preferences.md");
  const base = {
    exists: false,
    path: ".agent-workflow/tuning/local-routing-note-application.json" as const,
    targetFile: ".agent-workflow/tuning/routing-preferences.md" as const,
    generatedAt: null,
    sourcePlanGeneratedAt: null,
    approved: false,
    selectedNoteIds: [] as string[],
    appliedNoteIds: [] as string[],
    skippedNoteIds: [] as string[],
    beforeHash: null,
    afterHash: null,
    rollback: null,
    activePreferenceExists: false,
    activePreferenceBytes: 0,
    activePreferenceHash: null,
    activePreferencePreview: null,
    activeLocalRoutingNoteMarkers: 0,
    error: null
  };
  try {
    const [rawApplication, routingStatResult, routingContent] = await Promise.all([
      fs.readFile(applicationPath, "utf8"),
      fs.stat(routingPath).catch(() => null),
      fs.readFile(routingPath, "utf8").catch(() => "")
    ]);
    const parsed = JSON.parse(rawApplication) as Partial<LocalLlmRoutingNoteApplicationPlan>;
    if (parsed.kind !== "agentflow_local_llm_routing_note_application") {
      throw new Error(`Invalid local routing note application receipt: ${applicationPath}`);
    }
    return {
      ...base,
      exists: true,
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : null,
      sourcePlanGeneratedAt: typeof parsed.sourcePlanGeneratedAt === "string" ? parsed.sourcePlanGeneratedAt : null,
      approved: parsed.approved === true,
      selectedNoteIds: Array.isArray(parsed.selectedNoteIds) ? parsed.selectedNoteIds.filter((item): item is string => typeof item === "string") : [],
      appliedNoteIds: Array.isArray(parsed.appliedNoteIds) ? parsed.appliedNoteIds.filter((item): item is string => typeof item === "string") : [],
      skippedNoteIds: Array.isArray(parsed.skippedNoteIds) ? parsed.skippedNoteIds.filter((item): item is string => typeof item === "string") : [],
      beforeHash: typeof parsed.beforeHash === "string" ? parsed.beforeHash : null,
      afterHash: typeof parsed.afterHash === "string" ? parsed.afterHash : null,
      rollback: typeof parsed.rollback === "string" ? parsed.rollback : null,
      activePreferenceExists: Boolean(routingStatResult),
      activePreferenceBytes: routingStatResult?.size ?? 0,
      activePreferenceHash: routingContent ? createHash("sha256").update(routingContent).digest("hex") : null,
      activePreferencePreview: routingContent.trim() ? truncateDashboardPreview(routingContent, 2200) : null,
      activeLocalRoutingNoteMarkers: [...routingContent.matchAll(/agentflow-local-routing-note:/g)].length,
      error: null
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      const routingContent = await fs.readFile(routingPath, "utf8").catch(() => "");
      const routingStatResult = await fs.stat(routingPath).catch(() => null);
      return {
        ...base,
        activePreferenceExists: Boolean(routingStatResult),
        activePreferenceBytes: routingStatResult?.size ?? 0,
        activePreferenceHash: routingContent ? createHash("sha256").update(routingContent).digest("hex") : null,
        activePreferencePreview: routingContent.trim() ? truncateDashboardPreview(routingContent, 2200) : null,
        activeLocalRoutingNoteMarkers: [...routingContent.matchAll(/agentflow-local-routing-note:/g)].length
      };
    }
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function loadLocalHoldoutModelPlan(projectDir: string, writeGeneratedPlan: boolean): Promise<{ modelPlan: Omit<ModelImprovementPlan, "files">; source: string }> {
  try {
    return {
      modelPlan: await readModelImprovementPlan(projectDir),
      source: "model-improvement-plan.json"
    };
  } catch {
    try {
      const queue = await readTuningApprovalQueue(projectDir);
      const generatedPlan = buildModelImprovementPlan(queue, "all");
      if (writeGeneratedPlan) {
        await writeModelImprovementPlan(projectDir, generatedPlan);
      }
      return {
        modelPlan: generatedPlan,
        source: "generated from tuning approval queue"
      };
    } catch {
      const generatedAt = new Date().toISOString();
      return {
        modelPlan: {
          kind: "agentflow_model_improvement_plan",
          projectRootUri: projectDir,
          generatedAt,
          sourceQueueGeneratedAt: "unavailable",
          selectedIds: [],
          skippedIds: [],
          evalCases: [],
          datasetPlans: []
        },
        source: "empty fallback; run model-improvement-plan or queue tuning approvals to create holdout cases"
      };
    }
  }
}

export async function loadLocalLlmBenchmarkReceiptReport(ctx: CliContext, input: {
  projectDir: string;
  limit: number;
  execute: boolean;
  timeoutMs: number;
}): Promise<LocalLlmBenchmarkReceiptReport> {
  const scorecard = await loadPreferenceScorecard({ projectDir: input.projectDir, limit: input.limit });
  const projectRuns = await listWorkflowRunsForProject({ projectRootUri: input.projectDir, limit: input.limit });
  const recentRouteReports = await loadCostQualityReportsForDashboardRuns(projectRuns.slice(0, Math.min(projectRuns.length, 50)));
  const localProviderEvidence = buildDashboardLocalProviderEvidence(scorecard);
  const localHoldoutRouting = await loadDashboardLocalHoldoutRoutingStatus(input.projectDir, localProviderEvidence);
  const routeReceiptTrends = buildDashboardRouteReceiptTrends(input.projectDir, recentRouteReports);
  const smokeOutcomes = buildLocalLlmSmokeOutcomeTrend(input.projectDir, projectRuns, recentRouteReports);
  const checklist = await loadLocalLlmSetupChecklistReport(ctx, { projectDir: input.projectDir, localHoldoutRouting, routeReceiptTrends, smokeOutcomes });
  const setupGuide = await loadLocalLlmSetupGuideReport({ projectDir: input.projectDir, checklist, approved: false });
  const downloads = buildLocalLlmDownloadRecommendationReport({ projectDir: input.projectDir, scorecard, checklist, setupGuide });
  return buildLocalLlmBenchmarkReceiptReport({
    projectDir: input.projectDir,
    execute: input.execute,
    timeoutMs: input.timeoutMs,
    checklist,
    setupGuide,
    downloads
  });
}

export async function loadLocalLlmCacheTrendReport(ctx: CliContext, input: {
  projectDir: string;
  limit: number;
  write: boolean;
}): Promise<LocalLlmCacheTrendReport> {
  const projectDir = path.resolve(process.cwd(), input.projectDir);
  const inventory = await loadLocalLlmInventoryReport(ctx, { projectDir, limit: input.limit });
  const prunePlan = buildLocalLlmPrunePlanReport(projectDir, inventory, "candidates");
  const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: input.limit });
  const recentRouteReports = await loadCostQualityReportsForDashboardRuns(projectRuns.slice(0, Math.min(projectRuns.length, 50)));
  const routeReceiptTrends = buildDashboardRouteReceiptTrends(projectDir, recentRouteReports);
  const report = await buildLocalLlmCacheTrendReport(projectDir, inventory, prunePlan, routeReceiptTrends, input.write);
  if (input.write) {
    await writeLocalLlmCacheTrendReport(projectDir, report);
  }
  return report;
}

export async function loadLocalLlmCostLedgerReport(ctx: CliContext, input: {
  projectDir: string;
  limit: number;
  write: boolean;
}): Promise<LocalLlmCostLedgerReport> {
  const projectDir = path.resolve(process.cwd(), input.projectDir);
  const inventory = await loadLocalLlmInventoryReport(ctx, { projectDir, limit: input.limit });
  const prunePlan = buildLocalLlmPrunePlanReport(projectDir, inventory, "candidates");
  const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: input.limit });
  const recentRouteReports = await loadCostQualityReportsForDashboardRuns(projectRuns.slice(0, Math.min(projectRuns.length, 50)));
  const routeReceiptTrends = buildDashboardRouteReceiptTrends(projectDir, recentRouteReports);
  const cacheTrends = await buildLocalLlmCacheTrendReport(projectDir, inventory, prunePlan, routeReceiptTrends, false);
  const report = await buildLocalLlmCostLedgerReport(projectDir, routeReceiptTrends, cacheTrends, input.write);
  if (input.write) {
    await writeLocalLlmCostLedgerReport(projectDir, report);
  }
  return report;
}

export async function loadLocalLlmInstallationPlanReport(ctx: CliContext, input: {
  projectDir: string;
  selectedModels: string;
  limit: number;
}): Promise<LocalLlmInstallationPlanReport> {
  const scorecard = await loadPreferenceScorecard({ projectDir: input.projectDir, limit: input.limit });
  const projectRuns = await listWorkflowRunsForProject({ projectRootUri: input.projectDir, limit: input.limit });
  const recentRouteReports = await loadCostQualityReportsForDashboardRuns(projectRuns.slice(0, Math.min(projectRuns.length, 50)));
  const localProviderEvidence = buildDashboardLocalProviderEvidence(scorecard);
  const localHoldoutRouting = await loadDashboardLocalHoldoutRoutingStatus(input.projectDir, localProviderEvidence);
  const routeReceiptTrends = buildDashboardRouteReceiptTrends(input.projectDir, recentRouteReports);
  const smokeOutcomes = buildLocalLlmSmokeOutcomeTrend(input.projectDir, projectRuns, recentRouteReports);
  const checklist = await loadLocalLlmSetupChecklistReport(ctx, { projectDir: input.projectDir, localHoldoutRouting, routeReceiptTrends, smokeOutcomes });
  const setupGuide = await loadLocalLlmSetupGuideReport({ projectDir: input.projectDir, checklist, approved: false });
  const downloads = buildLocalLlmDownloadRecommendationReport({ projectDir: input.projectDir, scorecard, checklist, setupGuide });
  return buildLocalLlmInstallationPlanReport(input.projectDir, downloads, input.selectedModels);
}

export async function loadLocalLlmInventoryReport(ctx: CliContext, input: {
  projectDir: string;
  limit: number;
}): Promise<LocalLlmInventoryReport> {
  const scorecard = await loadPreferenceScorecard({ projectDir: input.projectDir, limit: input.limit });
  const projectRuns = await listWorkflowRunsForProject({ projectRootUri: input.projectDir, limit: input.limit });
  const recentRouteReports = await loadCostQualityReportsForDashboardRuns(projectRuns.slice(0, Math.min(projectRuns.length, 50)));
  const localProviderEvidence = buildDashboardLocalProviderEvidence(scorecard);
  const localHoldoutRouting = await loadDashboardLocalHoldoutRoutingStatus(input.projectDir, localProviderEvidence);
  const routeReceiptTrends = buildDashboardRouteReceiptTrends(input.projectDir, recentRouteReports);
  const smokeOutcomes = buildLocalLlmSmokeOutcomeTrend(input.projectDir, projectRuns, recentRouteReports);
  const checklist = await loadLocalLlmSetupChecklistReport(ctx, { projectDir: input.projectDir, localHoldoutRouting, routeReceiptTrends, smokeOutcomes });
  const setupGuide = await loadLocalLlmSetupGuideReport({ projectDir: input.projectDir, checklist, approved: false });
  const downloads = buildLocalLlmDownloadRecommendationReport({ projectDir: input.projectDir, scorecard, checklist, setupGuide });
  const installPlan = buildLocalLlmInstallationPlanReport(input.projectDir, downloads, "recommended");
  return buildLocalLlmInventoryReport(input.projectDir, setupGuide, downloads, installPlan, recentRouteReports);
}

export async function loadLocalLlmRoutingDecisionSnapshotReport(ctx: CliContext, input: {
  projectDir: string;
  limit: number;
  write: boolean;
}): Promise<LocalLlmRoutingDecisionSnapshotReport> {
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
  const localLlmRoutingRecommendations = buildLocalLlmRoutingRecommendationReport({
    projectDir,
    localProviderEvidence,
    routeReceiptTrends,
    costLedger: localLlmCostLedger,
    cacheTrends: localLlmCacheTrends,
    routeDecisionFeedback
  });
  const localLlmRoutingNoteApplication = await loadDashboardLocalLlmRoutingNoteApplicationStatus(projectDir);
  const timeline = await buildDashboardLocalLlmRoutingDecisionTimeline({
    projectDir,
    recommendations: localLlmRoutingRecommendations,
    noteApplication: localLlmRoutingNoteApplication,
    routeReceiptTrends
  });
  return buildLocalLlmRoutingDecisionSnapshotReport(projectDir, timeline, input.write);
}

export function localLlmBenchmarkTasks(): LocalLlmBenchmarkTask[] {
  return [
    {
      id: "tiny-summary",
      label: "tiny summarization",
      prompt: "Summarize this developer task in one concise sentence: Add audit logging to a TypeScript API without exposing secrets.",
      rubric: "One sentence, mentions audit logging, TypeScript/API scope, and secret safety."
    },
    {
      id: "tiny-code-review",
      label: "tiny code review",
      prompt: "Review this change in two bullets for risk: a dashboard form now writes a project-local JSON report under .agent-workflow/model-improvement/.",
      rubric: "Two bullets, covers write-boundary risk and validation or user-visible behavior."
    }
  ];
}

export function localLlmRoutingDecisionSnapshotItemKey(item: LocalLlmRoutingDecisionSnapshotItem): string {
  return `${item.recommendationId}:${item.target}:${item.agentId}`;
}

export async function readLocalHoldoutResultSummary(projectDir: string): Promise<Omit<LocalHoldoutResultSummary, "files">> {
  const resultPath = path.join(projectDir, ".agent-workflow", "model-improvement", "local-holdout-results.json");
  const raw = await fs.readFile(resultPath, "utf8");
  const parsed = JSON.parse(raw) as Omit<LocalHoldoutResultSummary, "files">;
  if (parsed.kind !== "agentflow_local_holdout_results" || !isRecord(parsed.summary) || !Array.isArray(parsed.results)) {
    throw new Error(`Invalid local holdout results: ${resultPath}`);
  }
  return parsed;
}

export async function readLocalLlmRoutingDecisionSnapshotLog(projectDir: string): Promise<LocalLlmRoutingDecisionSnapshotLog> {
  const projectRoot = path.resolve(projectDir);
  const targetPath = path.join(projectRoot, ".agent-workflow", "model-improvement", "local-routing-decision-snapshots.json");
  try {
    const parsed = JSON.parse(await fs.readFile(targetPath, "utf8")) as Partial<LocalLlmRoutingDecisionSnapshotLog>;
    if (parsed.kind !== "agentflow_local_llm_routing_decision_snapshots" || !Array.isArray(parsed.snapshots)) {
      throw new Error(`Invalid local routing decision snapshot log: ${targetPath}`);
    }
    return {
      kind: "agentflow_local_llm_routing_decision_snapshots",
      projectRootUri: typeof parsed.projectRootUri === "string" ? parsed.projectRootUri : projectRoot,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      snapshots: parsed.snapshots.filter(isLocalLlmRoutingDecisionSnapshot),
      latestDelta: parsed.latestDelta && typeof parsed.latestDelta === "object"
        ? parsed.latestDelta as LocalLlmRoutingDecisionSnapshotDelta
        : emptyLocalLlmRoutingDecisionSnapshotDelta(null)
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        kind: "agentflow_local_llm_routing_decision_snapshots",
        projectRootUri: projectRoot,
        updatedAt: new Date(0).toISOString(),
        snapshots: [],
        latestDelta: emptyLocalLlmRoutingDecisionSnapshotDelta(null)
      };
    }
    throw error;
  }
}

export async function readLocalLlmRoutingNotePlan(projectDir: string): Promise<LocalLlmRoutingNotePlanDocument> {
  const planPath = path.join(projectDir, ".agent-workflow", "tuning", "local-routing-note-plan.json");
  const raw = await fs.readFile(planPath, "utf8");
  const parsed = JSON.parse(raw) as LocalLlmRoutingNotePlanDocument;
  if (parsed.kind !== "agentflow_local_llm_routing_note_plan" || !Array.isArray(parsed.notes)) {
    throw new Error(`Invalid local LLM routing note plan: ${planPath}`);
  }
  return parsed;
}

export async function recordRouteDecisionFeedback(input: {
  projectDir: string;
  workflowId: string;
  stageId: string;
  agentId: string;
  providerId: string;
  modelTier: string;
  routeClass: string;
  rating: string;
  note: string;
  runs: number;
  fallbackCount: number;
  averageQuality: number | null;
  averageLatencyMs: number | null;
  source: "cli" | "dashboard";
}): Promise<RouteDecisionFeedbackResult> {
  const projectRoot = path.resolve(input.projectDir);
  const routeClass = normalizeRouteDecisionClass(input.routeClass);
  if (!routeClass) {
    return { ok: false, error: `Unsupported route decision class: ${input.routeClass || "missing"}` };
  }
  const rating = normalizeRouteDecisionFeedbackRating(input.rating);
  if (!rating) {
    return { ok: false, error: `Unsupported route feedback rating: ${input.rating || "missing"}` };
  }
  const missing = [
    ["workflow", input.workflowId],
    ["stage", input.stageId],
    ["agent", input.agentId],
    ["provider", input.providerId],
    ["tier", input.modelTier]
  ].filter(([, value]) => !String(value).trim()).map(([label]) => label);
  if (missing.length) {
    return { ok: false, error: `Missing route feedback field(s): ${missing.join(", ")}` };
  }
  const existing = await readRouteDecisionFeedbackLog(projectRoot);
  const event: RouteDecisionFeedbackEvent = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: input.source,
    rating,
    note: input.note.trim(),
    workflowId: input.workflowId.trim(),
    stageId: input.stageId.trim(),
    agentId: input.agentId.trim(),
    providerId: input.providerId.trim(),
    modelTier: input.modelTier.trim(),
    routeClass,
    runs: input.runs,
    fallbackCount: input.fallbackCount,
    averageQuality: input.averageQuality,
    averageLatencyMs: input.averageLatencyMs
  };
  const log: RouteDecisionFeedbackLog = {
    kind: "agentflow_route_decision_feedback",
    projectRootUri: projectRoot,
    updatedAt: event.createdAt,
    events: [...existing.events, event].slice(-250)
  };
  await writeRouteDecisionFeedbackLog(projectRoot, log);
  return {
    ok: true,
    event,
    artifactUri: path.join(projectRoot, ".agent-workflow", "model-improvement", "route-decision-feedback.json"),
    totalEvents: log.events.length
  };
}

export async function runLocalLlmRouteSmoke(ctx: CliContext, input: {
  projectDir: string;
  timeoutMs: number;
}): Promise<LocalLlmRouteSmokeResult> {
  const projectDir = path.resolve(input.projectDir);
  const serviceChecks = await checkServices();
  const missingServices = serviceChecks.filter((check) => !check.reachable && check.endpoint.requiredFor === "enterprise");
  if (missingServices.length) {
    const checklist = await emptyLocalLlmSetupChecklistForFailure(ctx, projectDir, `Missing storage service: ${missingServices.map((check) => check.endpoint.name).join(", ")}`);
    return {
      kind: "agentflow_local_llm_route_smoke",
      generatedAt: new Date().toISOString(),
      projectRootUri: projectDir,
      status: "failed",
      runId: null,
      workflowId: "provider-smoke",
      routeClass: "missing",
      route: null,
      checklist,
      summary: "Storage services are not reachable, so the smoke run was not queued.",
      nextAction: "Run npm run doctor, start the configured storage services, then retry local-llm-smoke.",
      exportMarkdownPath: null,
      exportJsonPath: null
    };
  }

  const queued = await queueWorkflow(ctx, {
    workflowId: "provider-smoke",
    projectPath: projectDir,
    task: "Run a low-risk local LLM route smoke. Return concise structured output only. Do not request commands or file writes.",
    modelTierOverride: "fast",
    sourceTokenBudget: "1200",
    sourceMaxFiles: "8",
    evaluationMetadata: {
      kind: "local_llm_route_smoke",
      purpose: "Generate route receipt evidence for local LLM setup checklist.",
      requestedTier: "fast",
      createdFrom: "local-llm-checklist"
    }
  });
  if (!queued.ok) {
    const checklist = await emptyLocalLlmSetupChecklistForFailure(ctx, projectDir, queued.error);
    return {
      kind: "agentflow_local_llm_route_smoke",
      generatedAt: new Date().toISOString(),
      projectRootUri: projectDir,
      status: "failed",
      runId: null,
      workflowId: "provider-smoke",
      routeClass: "missing",
      route: null,
      checklist,
      summary: "The smoke run could not be queued.",
      nextAction: queued.error,
      exportMarkdownPath: null,
      exportJsonPath: null
    };
  }

  const watchResult = await watchWorkflowRun({
    runId: queued.run.runId,
    workerLimit: 1,
    workerConcurrency: 1,
    projectRootUri: queued.projectDir,
    intervalMs: 1000,
    timeoutMs: input.timeoutMs
  });
  const exportResult = await exportWorkflowRun({
    runId: queued.run.runId,
    outDir: path.join(projectDir, ".agent-workflow", "exports")
  });
  const quality = await loadCostQualityReport(queued.run.runId);
  const route = quality?.stages[0] ?? null;
  const routeClass = route ? classifyDashboardRouteReceipt(route) : "missing";
  const scorecard = await loadPreferenceScorecard({ projectDir, limit: 50 });
  const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: 50 });
  const recentRouteReports = await loadCostQualityReportsForDashboardRuns(projectRuns.slice(0, Math.min(projectRuns.length, 50)));
  const localProviderEvidence = buildDashboardLocalProviderEvidence(scorecard);
  const localHoldoutRouting = await loadDashboardLocalHoldoutRoutingStatus(projectDir, localProviderEvidence);
  const routeReceiptTrends = buildDashboardRouteReceiptTrends(projectDir, recentRouteReports);
  const smokeOutcomes = buildLocalLlmSmokeOutcomeTrend(projectDir, projectRuns, recentRouteReports);
  const checklist = await loadLocalLlmSetupChecklistReport(ctx, {
    projectDir,
    localHoldoutRouting,
    routeReceiptTrends,
    smokeOutcomes
  });
  const completed = watchResult.status === "completed";
  const nextAction = routeClass === "local-selected"
    ? "Local route receipt exists. Continue monitoring quality, fallback, latency, and feedback before expanding local routing."
    : routeClass === "local-skipped"
      ? "Local routing was requested but the endpoint was not ready. Start the local runtime and rerun the smoke."
      : "The smoke completed without selecting local. Check DEFAULT_MODEL_PROVIDER, AGENTFLOW_AUTO_PROVIDERS, and low-risk holdout promotion.";
  return {
    kind: "agentflow_local_llm_route_smoke",
    generatedAt: new Date().toISOString(),
    projectRootUri: projectDir,
    status: completed ? "completed" : "failed",
    runId: queued.run.runId,
    workflowId: "provider-smoke",
    routeClass,
    route,
    checklist,
    summary: completed
      ? `Smoke run completed with route class ${routeClass}.`
      : `Smoke run ended with status ${watchResult.status}.`,
    nextAction,
    exportMarkdownPath: exportResult.ok ? exportResult.markdownPath : null,
    exportJsonPath: exportResult.ok ? exportResult.jsonPath : null
  };
}

export function scoreLocalLlmBenchmarkOutput(task: LocalLlmBenchmarkTask, output: string): number {
  const normalized = output.toLowerCase();
  if (task.id === "tiny-summary") {
    let score = 0;
    if (normalized.includes("audit")) score += 0.3;
    if (normalized.includes("typescript") || normalized.includes("api")) score += 0.3;
    if (normalized.includes("secret")) score += 0.25;
    if (output.split(/[.!?]\s+/u).filter(Boolean).length <= 2) score += 0.15;
    return Number(Math.min(1, score).toFixed(2));
  }
  let score = 0;
  if (output.includes("-") || output.includes("•") || output.includes("*")) score += 0.25;
  if (normalized.includes("write") || normalized.includes("path") || normalized.includes("boundary")) score += 0.3;
  if (normalized.includes("valid") || normalized.includes("test") || normalized.includes("user")) score += 0.3;
  if (output.length <= 700) score += 0.15;
  return Number(Math.min(1, score).toFixed(2));
}

export async function watchWorkflowRun(input: {
  runId: string;
  workerLimit: number;
  workerConcurrency?: number;
  projectRootUri?: string;
  intervalMs: number;
  timeoutMs: number;
  onTick?: (result: Awaited<ReturnType<typeof runWorkerOnce>>) => void;
}): Promise<{
  status: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  receipts: number;
}> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= input.timeoutMs) {
    const workerResult = await runWorkerOnce(input.workerLimit, {
      workerId: normalizeWorkerId("dashboard"),
      projectRootUri: input.projectRootUri,
      concurrency: input.workerConcurrency
    });
    input.onTick?.(workerResult);

    const details = await getWorkflowRunDetails(input.runId);
    if (!details.run) {
      throw new Error(`Unknown workflow run: ${input.runId}`);
    }

    const failedTasks = details.tasks.filter((task) => task.status === "failed" || task.status === "blocked").length;
    const completedTasks = details.tasks.filter((task) => task.status === "completed").length;
    if (["completed", "failed", "blocked"].includes(details.run.status)) {
      return {
        status: details.run.status,
        totalTasks: details.tasks.length,
        completedTasks,
        failedTasks,
        receipts: details.receipts.length
      };
    }

    if (workerResult.claimed === 0) {
      await sleep(input.intervalMs);
    }
  }

  const details = await getWorkflowRunDetails(input.runId);
  if (!details.run) {
    throw new Error(`Unknown workflow run: ${input.runId}`);
  }

  return {
    status: "timed_out",
    totalTasks: details.tasks.length,
    completedTasks: details.tasks.filter((task) => task.status === "completed").length,
    failedTasks: details.tasks.filter((task) => task.status === "failed" || task.status === "blocked").length,
    receipts: details.receipts.length
  };
}

export async function writeLocalHoldoutResultSummary(projectDir: string, result: LocalHoldoutResultSummary): Promise<void> {
  for (const file of result.files) {
    if (!file.relativePath.startsWith(".agent-workflow/model-improvement/")) {
      throw new Error(`Refusing to write local holdout results outside .agent-workflow/model-improvement: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectDir, file.relativePath);
    const projectRoot = path.resolve(projectDir);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write local holdout results outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

export async function writeLocalHoldoutRoutingPromotion(projectDir: string, promotion: LocalHoldoutRoutingPromotion): Promise<void> {
  for (const file of promotion.files) {
    if (!file.relativePath.startsWith(".agent-workflow/tuning/")) {
      throw new Error(`Refusing to write local holdout promotion outside .agent-workflow/tuning: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectDir, file.relativePath);
    const projectRoot = path.resolve(projectDir);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write local holdout promotion outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

export async function writeLocalLlmBenchmarkReceiptReport(projectDir: string, report: LocalLlmBenchmarkReceiptReport): Promise<void> {
  const projectRoot = path.resolve(projectDir);
  for (const file of report.files) {
    if (!file.relativePath.startsWith(".agent-workflow/model-improvement/")) {
      throw new Error(`Refusing to write local LLM benchmark receipts outside .agent-workflow/model-improvement: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectRoot, file.relativePath);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write local LLM benchmark receipts outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

export async function writeLocalLlmCacheTrendReport(projectDir: string, report: LocalLlmCacheTrendReport): Promise<void> {
  const projectRoot = path.resolve(projectDir);
  for (const file of report.files) {
    if (!file.relativePath.startsWith(".agent-workflow/model-improvement/")) {
      throw new Error(`Refusing to write local LLM cache trends outside .agent-workflow/model-improvement: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectRoot, file.relativePath);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write local LLM cache trends outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

export async function writeLocalLlmCostLedgerReport(projectDir: string, report: LocalLlmCostLedgerReport): Promise<void> {
  const projectRoot = path.resolve(projectDir);
  for (const file of report.files) {
    if (!file.relativePath.startsWith(".agent-workflow/model-improvement/")) {
      throw new Error(`Refusing to write local LLM cost ledger outside .agent-workflow/model-improvement: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectRoot, file.relativePath);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write local LLM cost ledger outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

export async function writeLocalLlmDownloadRecommendationReport(projectDir: string, report: LocalLlmDownloadRecommendationReport): Promise<void> {
  const projectRoot = path.resolve(projectDir);
  for (const file of report.files) {
    if (!file.relativePath.startsWith(".agent-workflow/model-improvement/")) {
      throw new Error(`Refusing to write local LLM download recommendations outside .agent-workflow/model-improvement: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectRoot, file.relativePath);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write local LLM download recommendations outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

export async function writeLocalLlmInstallationPlanReport(projectDir: string, report: LocalLlmInstallationPlanReport): Promise<void> {
  const projectRoot = path.resolve(projectDir);
  for (const file of report.files) {
    if (!file.relativePath.startsWith(".agent-workflow/model-improvement/")) {
      throw new Error(`Refusing to write local LLM installation plan outside .agent-workflow/model-improvement: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectRoot, file.relativePath);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write local LLM installation plan outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
    if (file.relativePath.endsWith(".sh")) {
      await fs.chmod(targetPath, 0o755);
    }
  }
}

export async function writeLocalLlmInventoryReport(projectDir: string, report: LocalLlmInventoryReport): Promise<void> {
  const projectRoot = path.resolve(projectDir);
  for (const file of report.files) {
    if (!file.relativePath.startsWith(".agent-workflow/model-improvement/")) {
      throw new Error(`Refusing to write local LLM inventory outside .agent-workflow/model-improvement: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectRoot, file.relativePath);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write local LLM inventory outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

export async function writeLocalLlmPrunePlanReport(projectDir: string, report: LocalLlmPrunePlanReport): Promise<void> {
  const projectRoot = path.resolve(projectDir);
  for (const file of report.files) {
    if (!file.relativePath.startsWith(".agent-workflow/model-improvement/")) {
      throw new Error(`Refusing to write local LLM prune plan outside .agent-workflow/model-improvement: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectRoot, file.relativePath);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write local LLM prune plan outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
    if (file.relativePath.endsWith(".sh")) {
      await fs.chmod(targetPath, 0o755);
    }
  }
}

export async function writeLocalLlmRoutingDecisionSnapshotReport(projectDir: string, report: LocalLlmRoutingDecisionSnapshotReport): Promise<void> {
  const projectRoot = path.resolve(projectDir);
  for (const file of report.files) {
    if (!file.relativePath.startsWith(".agent-workflow/model-improvement/")) {
      throw new Error(`Refusing to write routing decision snapshots outside .agent-workflow/model-improvement: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectRoot, file.relativePath);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write routing decision snapshots outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

export async function writeLocalLlmRoutingNotePlan(projectDir: string, plan: LocalLlmRoutingNotePlan): Promise<void> {
  const projectRoot = path.resolve(projectDir);
  for (const file of plan.files) {
    if (!file.relativePath.startsWith(".agent-workflow/tuning/")) {
      throw new Error(`Refusing to write local LLM routing note plan outside .agent-workflow/tuning: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectRoot, file.relativePath);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write local LLM routing note plan outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

export async function writeLocalLlmSetupGuideReport(projectDir: string, report: LocalLlmSetupGuideReport): Promise<void> {
  const projectRoot = path.resolve(projectDir);
  for (const file of report.files) {
    const allowed = file.relativePath.startsWith(".agent-workflow/model-improvement/")
      || file.relativePath.startsWith(".agent-workflow/tuning/");
    if (!allowed) {
      throw new Error(`Refusing to write local LLM setup guide outside Agent Workflow project-local paths: ${file.relativePath}`);
    }
    if (file.relativePath.startsWith(".agent-workflow/tuning/") && report.status !== "ready") {
      throw new Error(`Refusing to write local LLM routing note before setup evidence is healthy: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectRoot, file.relativePath);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write local LLM setup guide outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

export async function writeRouteDecisionFeedbackLog(projectDir: string, log: RouteDecisionFeedbackLog): Promise<void> {
  const projectRoot = path.resolve(projectDir);
  const directory = path.join(projectRoot, ".agent-workflow", "model-improvement");
  const jsonPath = path.join(directory, "route-decision-feedback.json");
  const markdownPath = path.join(directory, "route-decision-feedback.md");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(jsonPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, formatRouteDecisionFeedbackMarkdown(log), "utf8");
}
