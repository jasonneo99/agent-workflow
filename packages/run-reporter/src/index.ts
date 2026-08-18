import type {
  ActionReceiptStatus,
  ArtifactStatus,
  WorkflowRunStatus,
  WorkflowTaskStatus
} from "../../storage/src/postgres.js";

export interface RunExportInput {
  run: WorkflowRunStatus;
  tasks: WorkflowTaskStatus[];
  receipts: ActionReceiptStatus[];
  artifacts: ArtifactStatus[];
  scrub?: boolean;
}

export interface RunExportDocument {
  markdown: string;
  json: Record<string, unknown>;
}

export interface CostQualityReport {
  runId: string;
  workflowId: string;
  task: string;
  status: string;
  projectName: string;
  totalStages: number;
  routedStages: number;
  fallbackCount: number;
  qualityPassCount: number;
  qualityFailCount: number;
  averageQuality: number | null;
  totalLatencyMs: number;
  averageLatencyMs: number | null;
  estimatedCostMix: Record<string, number>;
  providerMix: Record<string, number>;
  modelTierMix: Record<string, number>;
  estimatedByoSavingsStages: number;
  feedback: FeedbackSummary;
  stages: CostQualityStage[];
  recommendations: string[];
}

export interface FeedbackSummary {
  counts: Record<string, number>;
  latest: RunFeedback | null;
  items: RunFeedback[];
}

export interface RunFeedback {
  rating: "accepted" | "revised" | "rejected";
  note: string;
  createdAt: string;
  source: string;
}

export interface CostQualityStage {
  stageId: string;
  agentId: string;
  providerId: string;
  model?: string;
  modelTier: string;
  requestedModelTier: string;
  estimatedCostTier: string;
  qualityScore: number | null;
  qualityPassed: boolean | null;
  fallbackUsed: boolean;
  fallbackProviderId?: string;
  latencyMs: number | null;
  reasons: string[];
}

export interface PreferenceScorecardInput {
  projectRootUri: string;
  reports: CostQualityReport[];
}

export interface PreferenceScorecard {
  projectRootUri: string;
  runsAnalyzed: number;
  feedbackCounts: Record<string, number>;
  groups: PreferenceScoreGroup[];
  recommendations: string[];
}

export interface PreferenceScoreGroup {
  key: string;
  workflowId: string;
  stageId: string;
  agentId: string;
  providerId: string;
  modelTier: string;
  runs: number;
  accepted: number;
  revised: number;
  rejected: number;
  feedbackScore: number;
  averageQuality: number | null;
  fallbackRate: number;
  averageLatencyMs: number | null;
  recommendation: string;
}

export interface TuningProposalSet {
  projectRootUri: string;
  generatedAt: string;
  sourceRunsAnalyzed: number;
  proposals: TuningProposal[];
  summary: string[];
}

export interface TuningProposal {
  id: string;
  priority: "high" | "medium" | "low";
  kind: "agent_prompt" | "context_budget" | "routing_preference" | "feedback_needed";
  workflowId: string;
  stageId: string;
  agentId: string;
  providerId: string;
  modelTier: string;
  reason: string;
  recommendation: string;
  patchHint: string;
}

export interface TuningApplicationPlan {
  projectRootUri: string;
  generatedAt: string;
  selectedIds: string[];
  skippedIds: string[];
  files: TuningApplicationFile[];
}

export interface TuningApplicationFile {
  relativePath: string;
  content: string;
}

export type TuningApprovalStatus = "pending" | "approved" | "rejected";

export interface TuningApprovalQueue {
  kind: "agentflow_tuning_approval_queue";
  projectRootUri: string;
  generatedAt: string;
  sourceGeneratedAt: string;
  sourceRunsAnalyzed: number;
  skippedIds: string[];
  items: TuningApprovalItem[];
}

export interface TuningApprovalItem {
  id: string;
  proposalId: string;
  status: TuningApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  reviewer?: string;
  note?: string;
  proposal: TuningProposal;
}

export interface TuningApprovalDecisionResult {
  queue: TuningApprovalQueue;
  selectedIds: string[];
  skippedIds: string[];
}

export interface TuningPatchPlan {
  projectRootUri: string;
  generatedAt: string;
  selectedIds: string[];
  skippedIds: string[];
  files: TuningApplicationFile[];
}

export interface TuningPatchPlanDocument {
  kind: "agentflow_tuning_patch_plan";
  projectRootUri: string;
  generatedAt: string;
  sourceQueueGeneratedAt: string;
  selectedIds: string[];
  patches: TuningPatchPlanEntry[];
}

export interface TuningPatchPlanEntry {
  proposalId: string;
  approvalId: string;
  status: "approved";
  target: string;
  action: string;
  proposal: TuningProposal;
  reviewer?: string;
  note?: string;
}

export function buildRunExport(input: RunExportInput): RunExportDocument {
  const redaction = input.scrub ? buildRedactedRunExport(input) : input;
  const stageOutputs = redaction.artifacts.filter((artifact) => artifact.kind === "stage_output");
  const commandOutputs = redaction.artifacts.filter((artifact) => artifact.kind === "command_output");
  const fileWrites = redaction.artifacts.filter((artifact) => artifact.kind === "file_write");
  const actionRejections = redaction.artifacts.filter((artifact) => artifact.kind === "action_rejection");

  const markdown = [
    `# Workflow Run ${redaction.run.id}`,
    "",
    "## Summary",
    input.scrub ? "- Redaction: scrubbed for sharing" : "",
    `- Status: ${redaction.run.status}`,
    `- Workflow: ${redaction.run.workflowId}`,
    `- Task: ${redaction.run.task}`,
    `- Project: ${redaction.run.projectName}`,
    `- Project root: ${redaction.run.projectRootUri}`,
    `- Autonomy: ${redaction.run.autonomy}`,
    `- Policy profile: ${redaction.run.policyProfile}`,
    `- Policy snapshot: ${redaction.run.policySnapshotHash || "legacy run"}`,
    `- Started: ${redaction.run.startedAt}`,
    `- Finished: ${redaction.run.finishedAt ?? "not finished"}`,
    "",
    "## Stages",
    redaction.tasks.length
      ? redaction.tasks.map((task) => `- ${task.stageId}: ${task.agentId} ${task.status} attempts=${task.attempts}`).join("\n")
      : "_No stages recorded._",
    "",
    "## Receipts",
    redaction.receipts.length
      ? redaction.receipts.map((receipt) => [
        `- ${receipt.actionType} ${receipt.agentId}`,
        `  - Target: ${receipt.target}`,
        `  - Summary: ${receipt.summary}`,
        `  - Created: ${receipt.createdAt}`
      ].join("\n")).join("\n")
      : "_No receipts recorded._",
    "",
    "## Stage Outputs",
    stageOutputs.length
      ? stageOutputs.map(formatStageOutput).join("\n\n")
      : "_No stage output artifacts recorded._",
    "",
    "## Command Outputs",
    commandOutputs.length
      ? commandOutputs.map(formatCommandOutput).join("\n\n")
      : "_No command output artifacts recorded._",
    "",
    "## File Writes",
    fileWrites.length
      ? fileWrites.map(formatFileWrite).join("\n\n")
      : "_No file write artifacts recorded._",
    "",
    "## Action Rejections",
    actionRejections.length
      ? actionRejections.map(formatActionRejection).join("\n\n")
      : "_No action rejections recorded._",
    "",
    "## Artifacts",
    redaction.artifacts.length
      ? redaction.artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.uri}`).join("\n")
      : "_No artifacts recorded._",
    ""
  ].join("\n");

  return {
    markdown,
    json: {
      exportedAt: new Date().toISOString(),
      redacted: Boolean(input.scrub),
      redactionNotes: input.scrub ? [
        "Absolute paths, emails, common secret patterns, and high-risk freeform artifact fields were scrubbed.",
        "Use unscreened local exports only for trusted internal debugging."
      ] : [],
      run: redaction.run,
      tasks: redaction.tasks,
      receipts: redaction.receipts,
      artifacts: redaction.artifacts
    }
  };
}

export function buildCostQualityReport(input: RunExportInput): CostQualityReport {
  const routeArtifacts = input.artifacts.filter((artifact) => artifact.kind === "model_route");
  const stageOutputArtifacts = input.artifacts.filter((artifact) => artifact.kind === "stage_output");
  const feedback = collectRunFeedback(input.artifacts);
  const stageOutputByKey = new Map(
    stageOutputArtifacts.map((artifact) => {
      const stageId = stringValue(artifact.content.stageId, "");
      const agentId = stringValue(artifact.content.agentId, "");
      return [`${stageId}:${agentId}`, artifact];
    })
  );

  const stages = routeArtifacts.map((artifact): CostQualityStage => {
    const route = objectValue(artifact.content.route);
    const quality = objectValue(artifact.content.quality);
    const routeFallback = parseRouteReason(stringValue(route.reason, ""));
    const target = stringValue(artifact.content.target, "");
    const targetStage = target.includes("/") ? target.split("/").at(-1) ?? target : target;
    const agentId = stringValue(artifact.content.agentId, routeFallback.agentId);
    const stageId = stringValue(artifact.content.stageId, targetStage || routeFallback.stageId);
    const stageArtifact = stageOutputByKey.get(`${stageId}:${agentId}`);
    const fallbackProviderId = stringValue(artifact.content.fallbackProviderId, "");

    return {
      stageId,
      agentId,
      providerId: stringValue(route.providerId, "unknown"),
      model: stageArtifact ? stringValue(stageArtifact.content.model, "") || undefined : undefined,
      modelTier: stringValue(route.modelTier, "standard"),
      requestedModelTier: stringValue(route.requestedModelTier, stringValue(route.modelTier, "standard")),
      estimatedCostTier: stringValue(route.estimatedCostTier, "unknown"),
      qualityScore: numberValue(quality.score),
      qualityPassed: booleanValue(quality.passed),
      fallbackUsed: booleanValue(artifact.content.fallbackUsed) ?? false,
      fallbackProviderId: fallbackProviderId || undefined,
      latencyMs: numberValue(artifact.content.latencyMs),
      reasons: arrayOfStrings(quality.reasons)
    };
  });

  const scoredStages = stages.filter((stage) => stage.qualityScore !== null);
  const latencyStages = stages.filter((stage) => stage.latencyMs !== null);
  const qualityPassCount = stages.filter((stage) => stage.qualityPassed === true).length;
  const qualityFailCount = stages.filter((stage) => stage.qualityPassed === false).length;
  const totalLatencyMs = latencyStages.reduce((sum, stage) => sum + (stage.latencyMs ?? 0), 0);
  const estimatedByoSavingsStages = stages.filter((stage) =>
    ["byo", "openai-compatible", "mock"].includes(stage.providerId) &&
    ["low", "medium", "none"].includes(stage.estimatedCostTier)
  ).length;

  return {
    runId: input.run.id,
    workflowId: input.run.workflowId,
    task: input.run.task,
    status: input.run.status,
    projectName: input.run.projectName,
    totalStages: input.tasks.length,
    routedStages: stages.length,
    fallbackCount: stages.filter((stage) => stage.fallbackUsed).length,
    qualityPassCount,
    qualityFailCount,
    averageQuality: scoredStages.length
      ? round(scoredStages.reduce((sum, stage) => sum + (stage.qualityScore ?? 0), 0) / scoredStages.length)
      : null,
    totalLatencyMs,
    averageLatencyMs: latencyStages.length ? Math.round(totalLatencyMs / latencyStages.length) : null,
    estimatedCostMix: countBy(stages, (stage) => stage.estimatedCostTier),
    providerMix: countBy(stages, (stage) => stage.providerId),
    modelTierMix: countBy(stages, (stage) => stage.modelTier),
    estimatedByoSavingsStages,
    feedback,
    stages,
    recommendations: recommendCostQualityActions(stages, input.run.status, feedback)
  };
}

export function formatCostQualityReport(report: CostQualityReport): string {
  return [
    `Cost & Quality Report: ${report.runId}`,
    `Status: ${report.status}`,
    `Workflow: ${report.workflowId}`,
    `Project: ${report.projectName}`,
    `Task: ${report.task}`,
    "",
    "Summary",
    `- Routed stages: ${report.routedStages}/${report.totalStages}`,
    `- Average quality: ${report.averageQuality ?? "n/a"}`,
    `- Quality pass/fail: ${report.qualityPassCount}/${report.qualityFailCount}`,
    `- Fallbacks used: ${report.fallbackCount}`,
    `- Total latency: ${report.totalLatencyMs}ms`,
    `- Estimated BYO/local savings stages: ${report.estimatedByoSavingsStages}`,
    `- Provider mix: ${formatCounts(report.providerMix)}`,
    `- Cost mix: ${formatCounts(report.estimatedCostMix)}`,
    `- Tier mix: ${formatCounts(report.modelTierMix)}`,
    `- Feedback: ${report.feedback.latest ? `${report.feedback.latest.rating}${report.feedback.latest.note ? ` - ${report.feedback.latest.note}` : ""}` : "none"}`,
    "",
    "Stages",
    report.stages.length
      ? report.stages.map((stage) => [
        `- ${stage.stageId}: ${stage.agentId}`,
        `  - Provider: ${stage.providerId}${stage.model ? ` / ${stage.model}` : ""}`,
        `  - Tier: ${stage.modelTier}${stage.requestedModelTier !== stage.modelTier ? ` (requested ${stage.requestedModelTier})` : ""}, cost=${stage.estimatedCostTier}, quality=${stage.qualityScore ?? "n/a"}`,
        `  - Fallback: ${stage.fallbackUsed ? stage.fallbackProviderId ?? "yes" : "no"}, latency=${stage.latencyMs ?? "n/a"}ms`,
        stage.reasons.length ? `  - Notes: ${stage.reasons.join("; ")}` : ""
      ].filter(Boolean).join("\n")).join("\n")
      : "- No model routing receipts found.",
    "",
    "Recommendations",
    report.recommendations.map((item) => `- ${item}`).join("\n")
  ].join("\n");
}

export function buildPreferenceScorecard(input: PreferenceScorecardInput): PreferenceScorecard {
  const groups = new Map<string, {
    workflowId: string;
    stageId: string;
    agentId: string;
    providerId: string;
    modelTier: string;
    runs: number;
    accepted: number;
    revised: number;
    rejected: number;
    qualityTotal: number;
    qualityCount: number;
    fallbackCount: number;
    latencyTotal: number;
    latencyCount: number;
  }>();

  for (const report of input.reports) {
    const rating = report.feedback.latest?.rating;
    for (const stage of report.stages) {
      const key = [report.workflowId, stage.stageId, stage.agentId, stage.providerId, stage.modelTier].join("|");
      const group = groups.get(key) ?? {
        workflowId: report.workflowId,
        stageId: stage.stageId,
        agentId: stage.agentId,
        providerId: stage.providerId,
        modelTier: stage.modelTier,
        runs: 0,
        accepted: 0,
        revised: 0,
        rejected: 0,
        qualityTotal: 0,
        qualityCount: 0,
        fallbackCount: 0,
        latencyTotal: 0,
        latencyCount: 0
      };
      group.runs += 1;
      if (rating === "accepted") {
        group.accepted += 1;
      } else if (rating === "revised") {
        group.revised += 1;
      } else if (rating === "rejected") {
        group.rejected += 1;
      }
      if (stage.qualityScore !== null) {
        group.qualityTotal += stage.qualityScore;
        group.qualityCount += 1;
      }
      if (stage.fallbackUsed) {
        group.fallbackCount += 1;
      }
      if (stage.latencyMs !== null) {
        group.latencyTotal += stage.latencyMs;
        group.latencyCount += 1;
      }
      groups.set(key, group);
    }
  }

  const scoredGroups = [...groups.entries()].map(([key, group]): PreferenceScoreGroup => {
    const feedbackScore = round((group.accepted * 1 + group.revised * 0.35 + group.rejected * -1) / Math.max(1, group.accepted + group.revised + group.rejected));
    const fallbackRate = round(group.fallbackCount / Math.max(1, group.runs));
    const averageQuality = group.qualityCount ? round(group.qualityTotal / group.qualityCount) : null;
    return {
      key,
      workflowId: group.workflowId,
      stageId: group.stageId,
      agentId: group.agentId,
      providerId: group.providerId,
      modelTier: group.modelTier,
      runs: group.runs,
      accepted: group.accepted,
      revised: group.revised,
      rejected: group.rejected,
      feedbackScore,
      averageQuality,
      fallbackRate,
      averageLatencyMs: group.latencyCount ? Math.round(group.latencyTotal / group.latencyCount) : null,
      recommendation: group.accepted + group.revised + group.rejected === 0
        ? "Collect accepted/revised/rejected feedback before changing this combination."
        : recommendScoreGroup(group.modelTier, feedbackScore, fallbackRate, averageQuality)
    };
  }).sort((a, b) => {
    const riskDelta = (b.revised + b.rejected + b.fallbackRate) - (a.revised + a.rejected + a.fallbackRate);
    return riskDelta || a.feedbackScore - b.feedbackScore || b.runs - a.runs;
  });

  return {
    projectRootUri: input.projectRootUri,
    runsAnalyzed: input.reports.length,
    feedbackCounts: countBy(input.reports.flatMap((report) => report.feedback.latest ? [report.feedback.latest] : []), (item) => item.rating),
    groups: scoredGroups,
    recommendations: recommendScorecard(scoredGroups, input.reports.length)
  };
}

export function formatPreferenceScorecard(scorecard: PreferenceScorecard): string {
  return [
    `Preference Scorecard: ${scorecard.projectRootUri}`,
    `Runs analyzed: ${scorecard.runsAnalyzed}`,
    `Feedback: ${formatCounts(scorecard.feedbackCounts)}`,
    "",
    "Recommendations",
    scorecard.recommendations.map((item) => `- ${item}`).join("\n"),
    "",
    "Groups",
    scorecard.groups.length
      ? scorecard.groups.map((group) => [
        `- ${group.workflowId}/${group.stageId}: ${group.agentId}`,
        `  - Provider/tier: ${group.providerId}/${group.modelTier}`,
        `  - Runs: ${group.runs}, accepted=${group.accepted}, revised=${group.revised}, rejected=${group.rejected}`,
        `  - Score: ${group.feedbackScore}, quality=${group.averageQuality ?? "n/a"}, fallbackRate=${group.fallbackRate}, latency=${group.averageLatencyMs ?? "n/a"}ms`,
        `  - Recommendation: ${group.recommendation}`
      ].join("\n")).join("\n")
      : "- No routed stages found."
  ].join("\n");
}

export function buildTuningProposals(scorecard: PreferenceScorecard): TuningProposalSet {
  const proposals: TuningProposal[] = [];
  const addProposal = (input: Omit<TuningProposal, "id">): void => {
    proposals.push({
      ...input,
      id: `tune-${String(proposals.length + 1).padStart(3, "0")}`
    });
  };

  for (const group of scorecard.groups) {
    const feedbackCount = group.accepted + group.revised + group.rejected;
    if (feedbackCount === 0) {
      if (group.runs >= 3) {
        addProposal({
          priority: "low",
          kind: "feedback_needed",
          workflowId: group.workflowId,
          stageId: group.stageId,
          agentId: group.agentId,
          providerId: group.providerId,
          modelTier: group.modelTier,
          reason: `${group.runs} run(s) have no accepted/revised/rejected signal.`,
          recommendation: "Collect feedback before changing prompts or routing for this combination.",
          patchHint: `Run: npm run agentflow -- feedback --run <run-id> --rating accepted|revised|rejected --note "<why>"`
        });
      }
      continue;
    }

    if (group.feedbackScore < 0) {
      addProposal({
        priority: "high",
        kind: "agent_prompt",
        workflowId: group.workflowId,
        stageId: group.stageId,
        agentId: group.agentId,
        providerId: group.providerId,
        modelTier: group.modelTier,
        reason: `Feedback score ${group.feedbackScore} with ${group.rejected} rejected run(s).`,
        recommendation: "Tighten the agent prompt around project evidence, explicit assumptions, and verifiable next actions.",
        patchHint: `In the ${group.agentId} agent prompt, add: "Ground every finding in project files, name assumptions, and include a concrete verification step."`
      });
    } else if (group.feedbackScore < 0.5) {
      addProposal({
        priority: "medium",
        kind: "context_budget",
        workflowId: group.workflowId,
        stageId: group.stageId,
        agentId: group.agentId,
        providerId: group.providerId,
        modelTier: group.modelTier,
        reason: `Feedback score ${group.feedbackScore} with ${group.revised} revised run(s).`,
        recommendation: "Increase context for this stage or add a targeted project preference note before changing providers.",
        patchHint: `In workflow ${group.workflowId}, consider raising stage ${group.stageId} context max_tokens by 15-25% or add a project decision note describing the expected output.`
      });
    }

    if (group.fallbackRate >= 0.5) {
      addProposal({
        priority: "high",
        kind: "routing_preference",
        workflowId: group.workflowId,
        stageId: group.stageId,
        agentId: group.agentId,
        providerId: group.providerId,
        modelTier: group.modelTier,
        reason: `Fallback rate is ${group.fallbackRate}.`,
        recommendation: "Route this stage to a stronger provider or higher tier by default.",
        patchHint: `Set AGENTFLOW_PROVIDER_${group.modelTier.toUpperCase()} to the fallback provider, or promote ${group.workflowId}/${group.stageId} to a stronger model tier in workflow config.`
      });
    }

    if (group.averageQuality !== null && group.averageQuality < 0.7) {
      addProposal({
        priority: "medium",
        kind: "agent_prompt",
        workflowId: group.workflowId,
        stageId: group.stageId,
        agentId: group.agentId,
        providerId: group.providerId,
        modelTier: group.modelTier,
        reason: `Average quality score is ${group.averageQuality}.`,
        recommendation: "Improve output contract compliance: summary length, findings, next action, and project-specific evidence.",
        patchHint: `In ${group.agentId}, require at least one file-backed finding and a nextAction that names the next workflow step.`
      });
    }
  }

  return {
    projectRootUri: scorecard.projectRootUri,
    generatedAt: new Date().toISOString(),
    sourceRunsAnalyzed: scorecard.runsAnalyzed,
    proposals,
    summary: summarizeTuningProposals(proposals, scorecard)
  };
}

export function formatTuningProposals(proposalSet: TuningProposalSet): string {
  return [
    `Tuning Proposals: ${proposalSet.projectRootUri}`,
    `Generated: ${proposalSet.generatedAt}`,
    `Runs analyzed: ${proposalSet.sourceRunsAnalyzed}`,
    "",
    "Summary",
    proposalSet.summary.map((item) => `- ${item}`).join("\n"),
    "",
    "Proposals",
    proposalSet.proposals.length
      ? proposalSet.proposals.map((proposal) => [
        `- ${proposal.id} [${proposal.priority}] ${proposal.kind}: ${proposal.workflowId}/${proposal.stageId} ${proposal.agentId}`,
        `  - Reason: ${proposal.reason}`,
        `  - Recommendation: ${proposal.recommendation}`,
        `  - Patch hint: ${proposal.patchHint}`
      ].join("\n")).join("\n")
      : "- No tuning proposals yet."
  ].join("\n");
}

export function buildTuningApplicationPlan(
  proposalSet: TuningProposalSet,
  selectedIds: string[] | "all" = "all"
): TuningApplicationPlan {
  const requestedIds = selectedIds === "all" ? proposalSet.proposals.map((proposal) => proposal.id) : selectedIds;
  const requestedIdSet = new Set(requestedIds);
  const selected = proposalSet.proposals.filter((proposal) => requestedIdSet.has(proposal.id));
  const selectedIdSet = new Set(selected.map((proposal) => proposal.id));
  const skippedIds = requestedIds.filter((id) => !selectedIdSet.has(id));
  const generatedAt = new Date().toISOString();
  const jsonDocument = {
    kind: "agentflow_tuning_overlay",
    projectRootUri: proposalSet.projectRootUri,
    generatedAt,
    sourceGeneratedAt: proposalSet.generatedAt,
    sourceRunsAnalyzed: proposalSet.sourceRunsAnalyzed,
    selectedIds: selected.map((proposal) => proposal.id),
    proposals: selected
  };

  return {
    projectRootUri: proposalSet.projectRootUri,
    generatedAt,
    selectedIds: selected.map((proposal) => proposal.id),
    skippedIds,
    files: [
      {
        relativePath: ".agent-workflow/tuning/proposals.md",
        content: formatTuningOverlayMarkdown(proposalSet, selected, generatedAt)
      },
      {
        relativePath: ".agent-workflow/tuning/proposals.json",
        content: `${JSON.stringify(jsonDocument, null, 2)}\n`
      }
    ]
  };
}

export function formatTuningApplicationPlan(plan: TuningApplicationPlan): string {
  return [
    `Tuning Application Plan: ${plan.projectRootUri}`,
    `Generated: ${plan.generatedAt}`,
    `Selected proposals: ${plan.selectedIds.length ? plan.selectedIds.join(", ") : "none"}`,
    plan.skippedIds.length ? `Skipped unknown ids: ${plan.skippedIds.join(", ")}` : "",
    "",
    "Files",
    plan.files.map((file) => `- ${file.relativePath} (${file.content.length} bytes)`).join("\n")
  ].filter(Boolean).join("\n");
}

export function buildTuningApprovalQueue(
  proposalSet: TuningProposalSet,
  selectedIds: string[] | "all" = "all",
  existingQueue?: TuningApprovalQueue
): TuningApprovalQueue {
  const requestedIds = selectedIds === "all" ? proposalSet.proposals.map((proposal) => proposal.id) : selectedIds;
  const requestedIdSet = new Set(requestedIds);
  const selected = proposalSet.proposals.filter((proposal) => requestedIdSet.has(proposal.id));
  const selectedIdSet = new Set(selected.map((proposal) => proposal.id));
  const existingByProposal = new Map((existingQueue?.items ?? []).map((item) => [item.proposalId, item]));
  const generatedAt = new Date().toISOString();

  return {
    kind: "agentflow_tuning_approval_queue",
    projectRootUri: proposalSet.projectRootUri,
    generatedAt,
    sourceGeneratedAt: proposalSet.generatedAt,
    sourceRunsAnalyzed: proposalSet.sourceRunsAnalyzed,
    skippedIds: requestedIds.filter((id) => !selectedIdSet.has(id)),
    items: selected.map((proposal) => {
      const existing = existingByProposal.get(proposal.id);
      return {
        id: existing?.id ?? `approval-${proposal.id.replace(/^tune-/, "")}`,
        proposalId: proposal.id,
        status: existing?.status ?? "pending",
        createdAt: existing?.createdAt ?? generatedAt,
        decidedAt: existing?.decidedAt,
        reviewer: existing?.reviewer,
        note: existing?.note,
        proposal
      };
    })
  };
}

export function decideTuningApprovals(input: {
  queue: TuningApprovalQueue;
  ids: string[] | "all";
  status: Exclude<TuningApprovalStatus, "pending">;
  reviewer?: string;
  note?: string;
}): TuningApprovalDecisionResult {
  const idSet = input.ids === "all" ? null : new Set(input.ids);
  const decidedAt = new Date().toISOString();
  const selectedIds: string[] = [];
  const matchedIds = new Set<string>();
  const items = input.queue.items.map((item) => {
    const selected = idSet === null || idSet.has(item.id) || idSet.has(item.proposalId);
    if (!selected) {
      return item;
    }
    selectedIds.push(item.proposalId);
    matchedIds.add(item.id);
    matchedIds.add(item.proposalId);
    return {
      ...item,
      status: input.status,
      decidedAt,
      reviewer: input.reviewer,
      note: input.note
    };
  });

  return {
    queue: {
      ...input.queue,
      generatedAt: decidedAt,
      items
    },
    selectedIds,
    skippedIds: input.ids === "all" ? [] : input.ids.filter((id) => !matchedIds.has(id))
  };
}

export function formatTuningApprovalQueue(queue: TuningApprovalQueue): string {
  const counts = queue.items.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
  return [
    `Tuning Approval Queue: ${queue.projectRootUri}`,
    `Generated: ${queue.generatedAt}`,
    `Source runs analyzed: ${queue.sourceRunsAnalyzed}`,
    `Counts: pending=${counts.pending ?? 0} approved=${counts.approved ?? 0} rejected=${counts.rejected ?? 0}`,
    queue.skippedIds.length ? `Skipped unknown ids: ${queue.skippedIds.join(", ")}` : "",
    "",
    queue.items.length
      ? queue.items.map((item) => [
        `- ${item.proposalId} ${item.status}: ${item.proposal.workflowId}/${item.proposal.stageId} ${item.proposal.agentId}`,
        `  - Approval id: ${item.id}`,
        `  - Recommendation: ${item.proposal.recommendation}`,
        item.note ? `  - Note: ${item.note}` : ""
      ].filter(Boolean).join("\n")).join("\n")
      : "- No approval items."
  ].filter(Boolean).join("\n");
}

export function formatTuningApprovalQueueMarkdown(queue: TuningApprovalQueue): string {
  const sections = queue.items.map((item) => [
    `## ${item.proposalId} - ${item.status}`,
    "",
    `- Approval id: ${item.id}`,
    `- Priority: ${item.proposal.priority}`,
    `- Kind: ${item.proposal.kind}`,
    `- Workflow: ${item.proposal.workflowId}`,
    `- Stage: ${item.proposal.stageId}`,
    `- Agent: ${item.proposal.agentId}`,
    `- Provider/tier: ${item.proposal.providerId} / ${item.proposal.modelTier}`,
    `- Created: ${item.createdAt}`,
    item.decidedAt ? `- Decided: ${item.decidedAt}` : "",
    item.reviewer ? `- Reviewer: ${item.reviewer}` : "",
    item.note ? `- Note: ${item.note}` : "",
    `- Reason: ${item.proposal.reason}`,
    `- Recommendation: ${item.proposal.recommendation}`,
    `- Patch hint: ${item.proposal.patchHint}`,
    ""
  ].filter(Boolean).join("\n"));

  return [
    "# Agent Workflow Tuning Approval Queue",
    "",
    `Generated: ${queue.generatedAt}`,
    `Project: ${queue.projectRootUri}`,
    `Source proposals generated: ${queue.sourceGeneratedAt}`,
    `Source runs analyzed: ${queue.sourceRunsAnalyzed}`,
    "",
    "This file is project-local. Approve or reject tuning proposals before turning them into behavior-changing patches.",
    "",
    queue.skippedIds.length ? `Skipped unknown ids: ${queue.skippedIds.join(", ")}` : "",
    "",
    sections.length ? sections.join("\n") : "_No approval items._",
    ""
  ].filter((line) => line !== undefined).join("\n");
}

export function buildTuningPatchPlan(
  queue: TuningApprovalQueue,
  selectedIds: string[] | "all" = "all"
): TuningPatchPlan {
  const approvedItems = queue.items.filter((item) => item.status === "approved");
  const requestedIds = selectedIds === "all" ? approvedItems.map((item) => item.proposalId) : selectedIds;
  const requestedIdSet = new Set(requestedIds);
  const selected = approvedItems.filter((item) => requestedIdSet.has(item.id) || requestedIdSet.has(item.proposalId));
  const matchedIds = new Set(selected.flatMap((item) => [item.id, item.proposalId]));
  const generatedAt = new Date().toISOString();
  const patchDocuments = selected.map((item) => ({
    relativePath: `.agent-workflow/tuning/patches/${item.proposalId}.md`,
    content: formatTuningPatchMarkdown(item, generatedAt)
  }));
  const jsonDocument: TuningPatchPlanDocument = {
    kind: "agentflow_tuning_patch_plan",
    projectRootUri: queue.projectRootUri,
    generatedAt,
    sourceQueueGeneratedAt: queue.generatedAt,
    selectedIds: selected.map((item) => item.proposalId),
    patches: selected.map((item) => ({
      proposalId: item.proposalId,
      approvalId: item.id,
      status: "approved" as const,
      target: tuningPatchTarget(item.proposal),
      action: tuningPatchAction(item.proposal),
      proposal: item.proposal,
      reviewer: item.reviewer,
      note: item.note
    }))
  };

  return {
    projectRootUri: queue.projectRootUri,
    generatedAt,
    selectedIds: selected.map((item) => item.proposalId),
    skippedIds: requestedIds.filter((id) => !matchedIds.has(id)),
    files: [
      {
        relativePath: ".agent-workflow/tuning/patches/README.md",
        content: formatTuningPatchPlanMarkdown(queue, selected, generatedAt)
      },
      {
        relativePath: ".agent-workflow/tuning/patches/patch-plan.json",
        content: `${JSON.stringify(jsonDocument, null, 2)}\n`
      },
      ...patchDocuments
    ]
  };
}

export function formatTuningPatchPlan(plan: TuningPatchPlan): string {
  return [
    `Tuning Patch Plan: ${plan.projectRootUri}`,
    `Generated: ${plan.generatedAt}`,
    `Selected approved proposals: ${plan.selectedIds.length ? plan.selectedIds.join(", ") : "none"}`,
    plan.skippedIds.length ? `Skipped unavailable ids: ${plan.skippedIds.join(", ")}` : "",
    "",
    "Files",
    plan.files.map((file) => `- ${file.relativePath} (${file.content.length} bytes)`).join("\n")
  ].filter(Boolean).join("\n");
}

export function buildTuningPatchApplicationPlan(
  patchPlan: TuningPatchPlanDocument,
  selectedIds: string[] | "all" = "all"
): TuningApplicationPlan {
  const requestedIds = selectedIds === "all" ? patchPlan.patches.map((patch) => patch.proposalId) : selectedIds;
  const requestedIdSet = new Set(requestedIds);
  const selected = patchPlan.patches.filter((patch) => requestedIdSet.has(patch.approvalId) || requestedIdSet.has(patch.proposalId));
  const matchedIds = new Set(selected.flatMap((patch) => [patch.approvalId, patch.proposalId]));
  const generatedAt = new Date().toISOString();
  const document = {
    kind: "agentflow_applied_tuning_patches",
    projectRootUri: patchPlan.projectRootUri,
    generatedAt,
    sourcePatchPlanGeneratedAt: patchPlan.generatedAt,
    selectedIds: selected.map((patch) => patch.proposalId),
    patches: selected
  };

  return {
    projectRootUri: patchPlan.projectRootUri,
    generatedAt,
    selectedIds: selected.map((patch) => patch.proposalId),
    skippedIds: requestedIds.filter((id) => !matchedIds.has(id)),
    files: [
      {
        relativePath: ".agent-workflow/tuning/applied-patches.md",
        content: formatAppliedTuningPatchesMarkdown(patchPlan, selected, generatedAt)
      },
      {
        relativePath: ".agent-workflow/tuning/applied-patches.json",
        content: `${JSON.stringify(document, null, 2)}\n`
      },
      {
        relativePath: ".agent-workflow/tuning/agent-notes.md",
        content: formatAppliedTuningCategoryMarkdown("Agent Prompt Notes", selected.filter((patch) => patch.proposal.kind === "agent_prompt"), generatedAt)
      },
      {
        relativePath: ".agent-workflow/tuning/context-budget-notes.md",
        content: formatAppliedTuningCategoryMarkdown("Context Budget Notes", selected.filter((patch) => patch.proposal.kind === "context_budget"), generatedAt)
      },
      {
        relativePath: ".agent-workflow/tuning/routing-preferences.md",
        content: formatAppliedTuningCategoryMarkdown("Routing Preference Notes", selected.filter((patch) => patch.proposal.kind === "routing_preference"), generatedAt)
      }
    ]
  };
}

function formatStageOutput(artifact: ArtifactStatus): string {
  const content = artifact.content;
  return [
    `### ${stringValue(content.stageId, artifact.taskId ?? artifact.id)} - ${stringValue(content.agentName, stringValue(content.agentId, "unknown agent"))}`,
    `- Artifact: ${artifact.uri}`,
    `- Summary: ${stringValue(content.summary, "No summary.")}`,
    formatStringArray("Findings", content.findings),
    stringValue(content.nextAction, "") ? `- Next action: ${stringValue(content.nextAction, "")}` : "",
    formatStringArray("Requested commands", content.requestedCommands),
    formatFileWriteRequests(content.requestedFileWrites)
  ].filter(Boolean).join("\n");
}

function formatTuningOverlayMarkdown(
  proposalSet: TuningProposalSet,
  selected: TuningProposal[],
  generatedAt: string
): string {
  const sections = selected.map((proposal) => [
    `## ${proposal.id} [${proposal.priority}] ${proposal.kind}`,
    "",
    `- Workflow: ${proposal.workflowId}`,
    `- Stage: ${proposal.stageId}`,
    `- Agent: ${proposal.agentId}`,
    `- Provider/tier: ${proposal.providerId} / ${proposal.modelTier}`,
    `- Reason: ${proposal.reason}`,
    `- Recommendation: ${proposal.recommendation}`,
    `- Patch hint: ${proposal.patchHint}`,
    ""
  ].join("\n"));

  return [
    "# Agent Workflow Tuning Overlay",
    "",
    `Generated: ${generatedAt}`,
    `Project: ${proposalSet.projectRootUri}`,
    `Source proposals generated: ${proposalSet.generatedAt}`,
    `Source runs analyzed: ${proposalSet.sourceRunsAnalyzed}`,
    "",
    "This file is project-local. It records selected tuning proposals without modifying shared agents or workflows.",
    "",
    "## Summary",
    "",
    proposalSet.summary.map((item) => `- ${item}`).join("\n") || "- No proposal summary available.",
    "",
    selected.length ? sections.join("\n") : "_No proposals selected._",
    ""
  ].join("\n");
}

function formatTuningPatchPlanMarkdown(
  queue: TuningApprovalQueue,
  selected: TuningApprovalItem[],
  generatedAt: string
): string {
  return [
    "# Agent Workflow Tuning Patch Plan",
    "",
    `Generated: ${generatedAt}`,
    `Project: ${queue.projectRootUri}`,
    `Source queue generated: ${queue.generatedAt}`,
    "",
    "These files are review artifacts. They do not mutate project config, workflow config, or agent prompts by themselves.",
    "",
    "## Approved Proposals",
    "",
    selected.length
      ? selected.map((item) => `- ${item.proposalId}: ${tuningPatchTarget(item.proposal)} - ${item.proposal.recommendation}`).join("\n")
      : "- No approved proposals selected.",
    "",
    "## Review Flow",
    "",
    "1. Read each proposal patch file in this directory.",
    "2. Copy the suggested change into the named project-local target only if it fits the project.",
    "3. Run the relevant project checks.",
    "4. Record feedback on the original Agent Workflow run so future proposals improve.",
    ""
  ].join("\n");
}

function formatTuningPatchMarkdown(item: TuningApprovalItem, generatedAt: string): string {
  const proposal = item.proposal;
  return [
    `# Reviewable Tuning Patch: ${proposal.id}`,
    "",
    `Generated: ${generatedAt}`,
    `Approval id: ${item.id}`,
    `Status: ${item.status}`,
    item.reviewer ? `Reviewer: ${item.reviewer}` : "",
    item.note ? `Review note: ${item.note}` : "",
    "",
    "## Target",
    "",
    tuningPatchTarget(proposal),
    "",
    "## Suggested Action",
    "",
    tuningPatchAction(proposal),
    "",
    "## Rationale",
    "",
    `- Priority: ${proposal.priority}`,
    `- Kind: ${proposal.kind}`,
    `- Workflow: ${proposal.workflowId}`,
    `- Stage: ${proposal.stageId}`,
    `- Agent: ${proposal.agentId}`,
    `- Provider/tier: ${proposal.providerId} / ${proposal.modelTier}`,
    `- Reason: ${proposal.reason}`,
    `- Recommendation: ${proposal.recommendation}`,
    `- Patch hint: ${proposal.patchHint}`,
    "",
    "## Review Checklist",
    "",
    "- The change is project-local and does not edit shared reusable agents unless intentionally promoted later.",
    "- The change does not expose secrets, customer data, private prompts, or product-specific heuristics.",
    "- The change can be verified with a local command or a follow-up Agent Workflow run.",
    ""
  ].filter(Boolean).join("\n");
}

function tuningPatchTarget(proposal: TuningProposal): string {
  if (proposal.kind === "agent_prompt") {
    return `.agent-workflow/agents/${proposal.agentId}.yaml or .agent-workflow/tuning/agent-notes.md`;
  }
  if (proposal.kind === "context_budget") {
    return `.agent-workflow/workflows/${proposal.workflowId}.yaml or .agent-workflow/project.yaml context settings`;
  }
  if (proposal.kind === "routing_preference") {
    return `.agent-workflow/project.yaml routing preferences or provider environment settings`;
  }
  return "No behavior patch yet; collect explicit run feedback first.";
}

function tuningPatchAction(proposal: TuningProposal): string {
  if (proposal.kind === "agent_prompt") {
    return `Add a project-local instruction for ${proposal.agentId}: ${proposal.patchHint}`;
  }
  if (proposal.kind === "context_budget") {
    return `Adjust project-local context settings for ${proposal.workflowId}/${proposal.stageId}: ${proposal.patchHint}`;
  }
  if (proposal.kind === "routing_preference") {
    return `Review provider routing for ${proposal.workflowId}/${proposal.stageId}: ${proposal.patchHint}`;
  }
  return proposal.patchHint;
}

function formatAppliedTuningPatchesMarkdown(
  patchPlan: TuningPatchPlanDocument,
  selected: TuningPatchPlanEntry[],
  generatedAt: string
): string {
  return [
    "# Applied Agent Workflow Tuning Patches",
    "",
    `Generated: ${generatedAt}`,
    `Project: ${patchPlan.projectRootUri}`,
    `Source patch plan generated: ${patchPlan.generatedAt}`,
    "",
    "These are project-local tuning notes derived from approved patch-plan items. They record accepted intent but do not edit shared reusable agents or workflows.",
    "",
    selected.length
      ? selected.map((patch) => [
        `## ${patch.proposalId}`,
        "",
        `- Approval id: ${patch.approvalId}`,
        `- Kind: ${patch.proposal.kind}`,
        `- Target: ${patch.target}`,
        `- Action: ${patch.action}`,
        patch.reviewer ? `- Reviewer: ${patch.reviewer}` : "",
        patch.note ? `- Note: ${patch.note}` : "",
        `- Reason: ${patch.proposal.reason}`,
        ""
      ].filter(Boolean).join("\n")).join("\n")
      : "_No approved patch-plan items selected._",
    ""
  ].join("\n");
}

function formatAppliedTuningCategoryMarkdown(
  title: string,
  patches: TuningPatchPlanEntry[],
  generatedAt: string
): string {
  return [
    `# ${title}`,
    "",
    `Generated: ${generatedAt}`,
    "",
    patches.length
      ? patches.map((patch) => [
        `## ${patch.proposalId}`,
        "",
        `- Workflow/stage: ${patch.proposal.workflowId}/${patch.proposal.stageId}`,
        `- Agent: ${patch.proposal.agentId}`,
        `- Recommendation: ${patch.proposal.recommendation}`,
        `- Suggested local action: ${patch.action}`,
        `- Verification hint: run the affected workflow or project checks after making any behavior-changing edit.`,
        ""
      ].join("\n")).join("\n")
      : "_No applied notes in this category._",
    ""
  ].join("\n");
}

function formatCommandOutput(artifact: ArtifactStatus): string {
  const content = artifact.content;
  return [
    `### ${stringValue(content.commandLine, artifact.uri)}`,
    `- Artifact: ${artifact.uri}`,
    `- Exit code: ${stringValue(content.exitCode, "unknown")}`,
    `- Timed out: ${stringValue(content.timedOut, "unknown")}`,
    `- Duration ms: ${stringValue(content.durationMs, "unknown")}`,
    stringValue(content.stdout, "") ? fenced("stdout", stringValue(content.stdout, "")) : "",
    stringValue(content.stderr, "") ? fenced("stderr", stringValue(content.stderr, "")) : ""
  ].filter(Boolean).join("\n");
}

function formatFileWrite(artifact: ArtifactStatus): string {
  const content = artifact.content;
  return [
    `### ${stringValue(content.relativePath, artifact.uri)}`,
    `- Artifact: ${artifact.uri}`,
    `- Existed: ${stringValue(content.existed, "unknown")}`,
    `- Bytes written: ${stringValue(content.bytesWritten, "unknown")}`,
    `- Previous hash: ${stringValue(content.previousHash, "none")}`,
    `- Next hash: ${stringValue(content.nextHash, "unknown")}`
  ].join("\n");
}

function formatActionRejection(artifact: ArtifactStatus): string {
  const content = artifact.content;
  return [
    `### ${stringValue(content.actionType, "action")} rejected`,
    `- Artifact: ${artifact.uri}`,
    `- Target: ${stringValue(content.target, "unknown")}`,
    `- Error: ${stringValue(content.error, "unknown")}`
  ].join("\n");
}

function buildRedactedRunExport(input: RunExportInput): RunExportInput {
  const projectRoot = input.run.projectRootUri;
  const redactedRun = redactRecord(input.run, projectRoot) as WorkflowRunStatus;
  return {
    ...input,
    run: {
      ...redactedRun,
      task: "[REDACTED_TASK]",
      projectName: "Scrubbed Project",
      projectRootUri: "[PROJECT_ROOT]"
    },
    tasks: input.tasks.map((task) => redactRecord(task, projectRoot) as WorkflowTaskStatus),
    receipts: input.receipts.map((receipt) => redactRecord(receipt, projectRoot, new Set(["summary"])) as ActionReceiptStatus),
    artifacts: input.artifacts.map((artifact) => ({
      ...redactRecord(artifact, projectRoot) as ArtifactStatus,
      content: scrubArtifactContent(artifact.kind, artifact.content, projectRoot)
    })),
    scrub: true
  };
}

function scrubArtifactContent(kind: string, content: Record<string, unknown>, projectRoot: string): Record<string, unknown> {
  if (kind === "compiled_brief") {
    return { redacted: true, reason: "Compiled brief content may include private project context, prompts, schemas, or tenant details." };
  }

  const highRiskKeys = new Set([
    "compiledBrief",
    "workflowTask",
    "task",
    "prompt",
    "systemPrompt",
    "developerPrompt",
    "userPrompt",
    "text",
    "summary",
    "findings",
    "nextAction",
    "stdout",
    "stderr",
    "output",
    "content",
    "diff",
    "patch",
    "code",
    "schema",
    "tenant",
    "tenantId",
    "customer",
    "customerId"
  ]);

  return redactRecord(content, projectRoot, highRiskKeys) as Record<string, unknown>;
}

function redactRecord(value: unknown, projectRoot: string, highRiskKeys = new Set<string>()): unknown {
  if (typeof value === "string") {
    return redactString(value, projectRoot);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactRecord(item, projectRoot, highRiskKeys));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (highRiskKeys.has(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactRecord(item, projectRoot, highRiskKeys);
    }
  }
  return output;
}

function redactString(value: string, projectRoot: string): string {
  let output = value;
  if (projectRoot) {
    output = output.split(projectRoot).join("[PROJECT_ROOT]");
  }
  output = output
    .replace(/\/Users\/[A-Za-z0-9._-]+\/[^\s)'"`]+/g, "[LOCAL_PATH]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/\bsk-proj-[A-Za-z0-9_-]{12,}\b/g, "[OPENAI_PROJECT_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[OPENAI_KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[AWS_ACCESS_KEY]")
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key)\s*=\s*([^\s'"`]+)/gi, "$1=[REDACTED]");
  return output;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item) || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(", ") : "none";
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function collectRunFeedback(artifacts: ArtifactStatus[]): FeedbackSummary {
  const items = artifacts
    .filter((artifact) => artifact.kind === "run_feedback")
    .map((artifact): RunFeedback | null => {
      const rating = stringValue(artifact.content.rating, "");
      if (!["accepted", "revised", "rejected"].includes(rating)) {
        return null;
      }
      return {
        rating: rating as RunFeedback["rating"],
        note: stringValue(artifact.content.note, ""),
        createdAt: artifact.createdAt,
        source: stringValue(artifact.content.source, "user")
      };
    })
    .filter((item): item is RunFeedback => item !== null);

  return {
    counts: countBy(items, (item) => item.rating),
    latest: items.at(-1) ?? null,
    items
  };
}

function recommendCostQualityActions(stages: CostQualityStage[], status: string, feedback: FeedbackSummary): string[] {
  const recommendations: string[] = [];
  const weakStages = stages.filter((stage) => stage.qualityPassed === false || (stage.qualityScore !== null && stage.qualityScore < 0.7));
  const fallbackStages = stages.filter((stage) => stage.fallbackUsed);
  const highCostStages = stages.filter((stage) => stage.estimatedCostTier === "high");

  if (!stages.length) {
    recommendations.push("Run a workflow with adaptive routing enabled to collect model_route receipts.");
  }
  if (weakStages.length) {
    recommendations.push(`Review ${weakStages.length} weak stage output(s) and tune prompts, context budget, or model tier for those agents.`);
  }
  if (fallbackStages.length) {
    recommendations.push(`Inspect ${fallbackStages.length} fallback stage(s); repeated fallback usage means the primary provider is underpowered for that work.`);
  }
  if (highCostStages.length && highCostStages.length === stages.length) {
    recommendations.push("Move fast or standard stages to BYO/local providers to reduce cost without using reasoning models for every stage.");
  }
  if (status === "failed") {
    recommendations.push("Use the failed stage and quality notes to run debug-failure before retrying the full workflow.");
  }
  if (!feedback.latest) {
    recommendations.push("Mark this run accepted, revised, or rejected so future routing can learn from the result.");
  } else if (feedback.latest.rating === "rejected") {
    recommendations.push("Treat this run as negative training signal; inspect weak stages before reusing the same provider mix.");
  } else if (feedback.latest.rating === "revised") {
    recommendations.push("Capture the revision note as a project preference before repeating this workflow.");
  }
  if (!recommendations.length) {
    recommendations.push("Routing looks healthy. Keep this mix and compare future runs for latency and fallback drift.");
  }

  return recommendations;
}

function recommendScoreGroup(modelTier: string, feedbackScore: number, fallbackRate: number, averageQuality: number | null): string {
  if (feedbackScore < 0) {
    return modelTier === "fast"
      ? "Promote this stage to standard and add more project-specific context before retrying."
      : "Review agent prompt and context selection; this combination is trending negative.";
  }
  if (feedbackScore < 0.5) {
    return "Keep this combination under review; revised feedback suggests prompt or context-budget tuning may help.";
  }
  if (fallbackRate >= 0.5) {
    return "Primary provider is often insufficient; route this stage to a stronger default provider or model tier.";
  }
  if (averageQuality !== null && averageQuality < 0.7) {
    return "Quality score is low despite feedback; improve output structure, findings, or project evidence.";
  }
  return "This combination is performing well; keep current routing and context settings.";
}

function recommendScorecard(groups: PreferenceScoreGroup[], runsAnalyzed: number): string[] {
  const recommendations: string[] = [];
  if (runsAnalyzed === 0) {
    recommendations.push("Run and rate workflows to build a project-specific preference scorecard.");
    return recommendations;
  }
  const risky = groups.filter((group) => {
    const hasFeedback = group.accepted + group.revised + group.rejected > 0;
    return hasFeedback && (group.feedbackScore < 0.5 || group.fallbackRate >= 0.5 || (group.averageQuality !== null && group.averageQuality < 0.7));
  });
  const strong = groups.filter((group) => group.feedbackScore >= 0.75 && group.fallbackRate < 0.25 && (group.averageQuality === null || group.averageQuality >= 0.7));
  if (risky.length) {
    const top = risky.slice(0, 3).map((group) => `${group.workflowId}/${group.stageId}/${group.agentId}`).join(", ");
    recommendations.push(`Tune the riskiest combinations first: ${top}.`);
  }
  if (strong.length) {
    recommendations.push(`Keep ${strong.length} high-performing combination(s) on their current provider/tier.`);
  }
  if (!groups.some((group) => group.accepted + group.revised + group.rejected > 0)) {
    recommendations.push("Add accepted/revised/rejected feedback to recent runs so the scorecard can distinguish quality from mere completion.");
  }
  if (!recommendations.length) {
    recommendations.push("No urgent tuning needed. Continue collecting feedback across more workflows.");
  }
  return recommendations;
}

function summarizeTuningProposals(proposals: TuningProposal[], scorecard: PreferenceScorecard): string[] {
  const summary: string[] = [];
  const high = proposals.filter((proposal) => proposal.priority === "high").length;
  const medium = proposals.filter((proposal) => proposal.priority === "medium").length;
  const feedbackNeeded = proposals.filter((proposal) => proposal.kind === "feedback_needed").length;

  if (scorecard.runsAnalyzed === 0) {
    summary.push("No runs analyzed yet. Run and rate workflows before applying tuning.");
    return summary;
  }
  if (high) {
    summary.push(`${high} high-priority tuning proposal(s) should be reviewed before repeating the affected workflows.`);
  }
  if (medium) {
    summary.push(`${medium} medium-priority proposal(s) can improve revised or low-quality outputs.`);
  }
  if (feedbackNeeded) {
    summary.push(`${feedbackNeeded} combination(s) need feedback before a confident tuning recommendation.`);
  }
  if (!proposals.length) {
    summary.push("No prompt, context, or routing changes are recommended yet. Continue collecting rated runs.");
  }
  summary.push("Treat proposals as reviewable patches; apply them intentionally after checking project goals and policy.");
  return summary;
}

function parseRouteReason(reason: string): { stageId: string; agentId: string } {
  const match = reason.match(/stage\s+[^/]+\/([^\s]+)\s+\(([^)]+)\)/u);
  return {
    stageId: match?.[1] ?? "",
    agentId: match?.[2] ?? ""
  };
}

function formatStringArray(label: string, value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "";
  }
  const items = value.filter((item): item is string => typeof item === "string");
  if (!items.length) {
    return "";
  }
  return [`- ${label}:`, ...items.map((item) => `  - ${item}`)].join("\n");
}

function formatFileWriteRequests(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "";
  }
  const items = value
    .filter((item): item is { path: string; content: string } => Boolean(item) && typeof item.path === "string")
    .map((item) => `  - ${item.path}`);
  if (!items.length) {
    return "";
  }
  return ["- Requested file writes:", ...items].join("\n");
}

function fenced(label: string, value: string): string {
  return [
    `- ${label}:`,
    "```text",
    value.trim(),
    "```"
  ].join("\n");
}

function stringValue(value: unknown, fallback: string): string {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}
