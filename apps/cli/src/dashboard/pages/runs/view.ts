import { renderMobileApprovalCard } from "../../ui/approval-components.js";
import { queueRunActionForm, failedRunResolution } from "../../ui/run-actions.js";
import { titleCase, formatNumber, truncateMiddle } from "../../ui/format.js";
import { escapeHtml, iconLabel, renderDashboardDateTime, metricCard } from "../../ui/layout.js";
import { workflowDisplayName } from "../../../dashboard-http.js";
import type { DashboardRunStatus, FeedbackRating, RunSummary } from "../../../lib/cli-types.js";
import { formatDuration } from "../../../lib/builders-learning.js";
import { formatInlineCounts, isOpenApproval, loadLocalProjectConfig, objectValue } from "../../../lib/builders-shared.js";
import { type ObservabilityReport } from "../../../../../../packages/observability/src/index.js";
import { resolveExecutionPolicy } from "../../../../../../packages/policy-engine/src/index.js";
import { type GovernedReusePlan } from "../../../../../../packages/reuse-engine/src/index.js";
import { type CostQualityReport } from "../../../../../../packages/run-reporter/src/index.js";
import { getWorkflowRunDetails, listActionApprovals, listArtifacts, listProjectFileSummaries } from "../../../../../../packages/storage/src/postgres.js";
import { buildRunPresentation } from "../../../../../../packages/storage/src/run-presentation.js";
import { type DashboardIconName } from "../../icons.js";
import { serializeInlineScriptJson } from "../../security.js";
import type { RunDecisionExplanation, RunUsageEstimate } from "../../../commands/daemon-types.js";

export function buildRunDecisionExplanations(
  run: NonNullable<Awaited<ReturnType<typeof getWorkflowRunDetails>>["run"]>,
  qualityReport: CostQualityReport | null,
  summary: RunSummary | null
): RunDecisionExplanation[] {
  const workflowEvidence = [
    `Workflow id: ${run.workflowId}`,
    `Policy profile: ${run.policyProfile}`,
    `Autonomy: ${run.autonomy}`,
    summary?.recommendedNextAction ? `Recommended next action: ${summary.recommendedNextAction}` : ""
  ].filter(Boolean);
  const explanations: RunDecisionExplanation[] = [
    {
      title: "Workflow Selection",
      status: "good",
      detail: workflowSelectionExplanation(run, summary),
      evidence: workflowEvidence
    }
  ];

  if (!qualityReport || qualityReport.stages.length === 0) {
    explanations.push({
      title: "Model Routing",
      status: "warn",
      detail: "No model_route receipts were found yet, so the dashboard cannot explain provider, tier, or fallback selection for this run.",
      evidence: ["Process at least one model-routed stage, then reopen this run."]
    });
    return explanations;
  }

  const tierChanges = qualityReport.stages.filter((stage) => stage.modelTier !== stage.requestedModelTier);
  const fallbacks = qualityReport.stages.filter((stage) => stage.fallbackUsed);
  const providerMix = formatInlineCounts(qualityReport.providerMix) || "unknown";
  const tierMix = formatInlineCounts(qualityReport.modelTierMix) || "unknown";
  explanations.push({
    title: "Model Tier Selection",
    status: tierChanges.length ? "warn" : "good",
    detail: tierChanges.length
      ? `${tierChanges.length} stage(s) changed tier after routing evidence was considered.`
      : "Stages used their requested model tiers.",
    evidence: [
      `Tier mix: ${tierMix}`,
      ...tierChanges.slice(0, 4).map((stage) => `${stage.stageId}: requested ${stage.requestedModelTier}, used ${stage.modelTier}`)
    ]
  });
  explanations.push({
    title: "Provider Selection",
    status: qualityReport.providerMix.mock ? "warn" : "good",
    detail: `Provider routing used ${providerMix}. ${qualityReport.estimatedByoSavingsStages} stage(s) are estimated local/BYO savings opportunities.`,
    evidence: qualityReport.stages.slice(0, 6).map((stage) =>
      `${stage.stageId}: ${stage.providerId}${stage.model ? ` / ${stage.model}` : ""} (${stage.estimatedCostTier})${stage.routeReason ? ` - ${stage.routeReason}` : ""}`
    )
  });
  explanations.push({
    title: "Fallback Behavior",
    status: fallbacks.length ? "warn" : "good",
    detail: fallbacks.length
      ? `${fallbacks.length} fallback stage(s) ran because the primary output did not pass the local quality threshold.`
      : "No fallback provider was used for this run.",
    evidence: fallbacks.length
      ? fallbacks.slice(0, 5).map((stage) => `${stage.stageId}: ${stage.providerId} -> ${stage.fallbackProviderId ?? "fallback"}; quality ${stage.qualityScore ?? "n/a"}`)
      : [`Fallback count: ${qualityReport.fallbackCount}`]
  });
  return explanations;
}

export async function buildRunUsageEstimate(input: {
  run: DashboardRunStatus;
  artifacts: Awaited<ReturnType<typeof listArtifacts>>;
  routedStages: number;
  projectTokenTotals?: Map<string, number>;
}): Promise<RunUsageEstimate> {
  const compiledBriefText = compiledBriefTextFromArtifacts(input.artifacts);
  const compiledBriefTokens = estimateDashboardTokens(compiledBriefText);
  const selectedSourceTokens = sumApproxSourceTokens(compiledBriefText);
  const indexedProjectTokens = await loadIndexedProjectTokenTotal(input.run.projectRootUri, input.projectTokenTotals);
  const routedStages = Math.max(1, input.routedStages);
  const estimatedPromptTokens = compiledBriefTokens * routedStages;
  const estimatedBaselineTokens = Math.max(indexedProjectTokens, selectedSourceTokens, compiledBriefTokens) * routedStages;
  const estimatedTokensSaved = Math.max(0, estimatedBaselineTokens - estimatedPromptTokens);

  return {
    runId: input.run.id,
    routedStages,
    indexedProjectTokens,
    compiledBriefTokens,
    selectedSourceTokens,
    estimatedPromptTokens,
    estimatedBaselineTokens,
    estimatedTokensSaved,
    tokenReductionPercent: estimatedBaselineTokens > 0 ? Math.round((estimatedTokensSaved / estimatedBaselineTokens) * 100) : null,
    runDurationMs: runDurationMs(input.run)
  };
}

export function compiledBriefTextFromArtifacts(artifacts: Awaited<ReturnType<typeof listArtifacts>>): string {
  const artifact = artifacts.find((item) => item.kind === "compiled_brief");
  if (!artifact) {
    return "";
  }
  const text = artifact.content.text;
  if (typeof text === "string") {
    return text;
  }
  return JSON.stringify(artifact.content);
}

export function dashboardRunPresentation(run: { task: string; workflowId: string; projectName: string; displayTitle?: string | null; displayDescription?: string | null }) {
  const fallback = buildRunPresentation(run);
  return {
    title: run.displayTitle?.trim() || fallback.title,
    description: run.displayDescription?.trim() || fallback.description
  };
}

export function estimateDashboardTokens(text: string): number {
  if (!text.trim()) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

export function feedbackForm(runId: string, rating: FeedbackRating, label: string): string {
  const iconName: DashboardIconName = rating === "accepted" ? "check" : rating === "rejected" ? "x" : "message";
  return `<form class="feedback-form" method="post" action="/api/follow-up"><input type="hidden" name="runId" value="${escapeHtml(runId)}"><input type="hidden" name="action" value="feedback"><input type="hidden" name="rating" value="${escapeHtml(rating)}"><input name="note" aria-label="${escapeHtml(label)} note" placeholder="Optional note"><button type="submit">${iconLabel(iconName, label)}</button></form>`;
}

export async function loadIndexedProjectTokenTotal(projectRootUri: string, cache = new Map<string, number>()): Promise<number> {
  const cached = cache.get(projectRootUri);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const summaries = await listProjectFileSummaries({
      projectRootUri,
      limit: 5000
    });
    const total = summaries.reduce((sum, summary) => sum + summary.tokenEstimate, 0);
    cache.set(projectRootUri, total);
    return total;
  } catch {
    cache.set(projectRootUri, 0);
    return 0;
  }
}

export async function loadRunApprovalCeiling(run: NonNullable<Awaited<ReturnType<typeof getWorkflowRunDetails>>["run"]>): Promise<string> {
  const configured = await loadLocalProjectConfig(run.projectRootUri);
  return String(resolveExecutionPolicy(configured, run.policyProfile).project.project.autonomy);
}

export function readGovernedReusePlan(artifacts: Awaited<ReturnType<typeof listArtifacts>>): GovernedReusePlan | null {
  const compiled = artifacts.find((artifact) => artifact.kind === "compiled_brief");
  const metadata = objectValue(compiled?.content?.metadata);
  const plan = objectValue(metadata?.governedReusePlan);
  if (plan?.version !== 1 || !Array.isArray(plan.candidates) || !Array.isArray(plan.memory)) return null;
  return plan as unknown as GovernedReusePlan;
}

export function renderCostQualityHtml(report: CostQualityReport): string {
  const stageRows = report.stages.map((stage) => `
    <tr>
      <td>${escapeHtml(stage.stageId)}</td>
      <td>${escapeHtml(stage.agentId)}</td>
      <td>${escapeHtml(stage.providerId)}${stage.model ? `<br><span class="muted">${escapeHtml(stage.model)}</span>` : ""}</td>
      <td>${escapeHtml(stage.modelTier)}${stage.requestedModelTier !== stage.modelTier ? `<br><span class="muted">requested ${escapeHtml(stage.requestedModelTier)}</span>` : ""}</td>
      <td>${escapeHtml(stage.estimatedCostTier)}</td>
      <td>${stage.qualityScore ?? "n/a"} ${stage.qualityPassed === false ? "<span class=\"flag bad\">Review</span>" : stage.qualityPassed === true ? "<span class=\"flag good\">Pass</span>" : ""}</td>
      <td>${stage.fallbackUsed ? escapeHtml(stage.fallbackProviderId ?? "yes") : "no"}</td>
      <td>${stage.latencyMs ?? "n/a"}</td>
    </tr>
  `).join("");
  const recommendations = report.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("");

  return `
    <div class="metric-grid">
      ${metricCard("Quality", report.averageQuality ?? "n/a", `${report.qualityPassCount} pass / ${report.qualityFailCount} review`)}
      ${metricCard("Fallbacks", report.fallbackCount, "retry count")}
      ${metricCard("Latency", `${report.totalLatencyMs}ms`, `avg ${report.averageLatencyMs ?? "n/a"}ms`)}
      ${metricCard("Local/BYO Savings", report.estimatedByoSavingsStages, "local or low-cost stages")}
    </div>
    <div class="meta-grid compact">
      <div><strong>Providers</strong>${escapeHtml(formatInlineCounts(report.providerMix))}</div>
      <div><strong>Cost Mix</strong>${escapeHtml(formatInlineCounts(report.estimatedCostMix))}</div>
      <div><strong>Model Tiers</strong>${escapeHtml(formatInlineCounts(report.modelTierMix))}</div>
    </div>
    <table>
      <thead><tr><th>Stage</th><th>Agent</th><th>Provider</th><th>Tier</th><th>Cost</th><th>Quality</th><th>Fallback</th><th>Latency ms</th></tr></thead>
      <tbody>${stageRows || "<tr><td colspan=\"8\">No routing receipts found.</td></tr>"}</tbody>
    </table>
    <h3>Recommendations</h3>
    <ul>${recommendations}</ul>
  `;
}

export function renderFailedRunResolutionPanel(run: NonNullable<Awaited<ReturnType<typeof getWorkflowRunDetails>>["run"]>): string {
  const resolution = failedRunResolution(run.failedReason);
  return `<section class="failure-resolution" aria-labelledby="failure-resolution-title">
    <h3 id="failure-resolution-title">Reason Failed</h3>
    <p class="warn-box">${escapeHtml(run.failedReason?.trim() || "No specific failure reason was recorded. This is a workflow defect; use Diagnose & Fix to gather fresh evidence.")}</p>
    <h3>How to resolve</h3>
    <p>${escapeHtml(resolution.summary)}</p>
    <ol>${resolution.instructions.map((instruction) => `<li>${escapeHtml(instruction)}</li>`).join("")}</ol>
    <p class="muted">Automatic root repair: ${resolution.automaticRepair === "eligible" ? "eligible when policy and evidence permit" : "waiting for an operator-managed prerequisite"}.</p>
    <div class="actions">
      ${queueRunActionForm(run.id, "retry-failed", "Retry Failed Stages")}
      ${queueRunActionForm(run.id, "repair-blocked", "Diagnose & Fix")}
      <a class="button secondary" href="/providers">Open Providers</a>
      <a class="button secondary" href="/approvals?status=open&run=${encodeURIComponent(run.id)}">Open Approvals</a>
    </div>
  </section>`;
}

export function renderFeedbackHtml(runId: string, report: CostQualityReport): string {
  const latest = report.feedback.latest
    ? `<p><strong>Latest:</strong> ${escapeHtml(report.feedback.latest.rating)}${report.feedback.latest.note ? ` - ${escapeHtml(report.feedback.latest.note)}` : ""}</p>`
    : "<p>No feedback recorded yet.</p>";
  return `
    ${latest}
    <div class="actions">
      ${feedbackForm(runId, "accepted", "Accept")}
      ${feedbackForm(runId, "revised", "Mark Revised")}
      ${feedbackForm(runId, "rejected", "Reject")}
    </div>
  `;
}

export function renderGovernedReusePanel(plan: GovernedReusePlan): string {
  const best = plan.candidates[0];
  const candidateRows = plan.candidates.map((candidate) => `<tr>
    <td><a href="/run?id=${encodeURIComponent(candidate.runId)}">${escapeHtml(candidate.runId.slice(0, 8))}</a></td>
    <td><span class="status ${candidate.evidenceCurrent ? "completed" : "blocked"}">${escapeHtml(candidate.recommendation)}</span></td>
    <td>${Math.round(candidate.taskSimilarity * 100)}%</td>
    <td>${candidate.evidenceCurrent ? "current" : escapeHtml(candidate.staleReasons.join(", ") || "stale")}</td>
    <td>${candidate.projectedSavings.stages} stages · ${formatNumber(candidate.projectedSavings.tokens)} tokens · ${formatDuration(candidate.projectedSavings.latencyMs)} · ${candidate.projectedSavings.costUsd === null ? "cost unavailable" : `$${candidate.projectedSavings.costUsd.toFixed(6)}`}</td>
  </tr>`).join("");
  return `<section class="panel governed-reuse-panel">
    <div class="section-heading"><div><p class="eyebrow">Governed reuse</p><h2>${escapeHtml(titleCase(plan.recommendation))}</h2><span class="muted">Exact fingerprints and semantic matches are advisory until an operator accepts them.</span></div><span class="status ${best?.evidenceCurrent ? "completed" : "queued"}">${plan.requiresApproval ? "approval required" : "fresh run"}</span></div>
    <div class="actions">
      <button type="button" ${plan.recommendation === "reuse-result" ? "" : "disabled"}>Reuse result</button>
      <button type="button" ${plan.recommendation === "resume-from-stage" ? "" : "disabled"}>Resume from checkpoint</button>
      <span class="button secondary" aria-current="true">Run fresh</span>
    </div>
    <p class="muted">Reuse controls remain non-executing until the selected candidate is revalidated against current policy, workflow, and source hashes.</p>
    <div class="table-wrap"><table><thead><tr><th>Source run</th><th>Decision</th><th>Similarity</th><th>Evidence</th><th>Projected savings</th></tr></thead><tbody>${candidateRows || '<tr><td colspan="5">No safe prior run matched. This run started fresh.</td></tr>'}</tbody></table></div>
  </section>`;
}

export function renderObservabilityHtml(report: ObservabilityReport): string {
  const spanCount = report.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)).length;
  const metricCount = report.resourceMetrics.flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics)).length;
  return `
    <div class="metric-grid">
      ${metricCard("Run Duration", report.summary.runDurationMs === null ? "n/a" : `${report.summary.runDurationMs}ms`, "workflow wall time")}
      ${metricCard("Queue Delay", report.summary.queueDelayMs === null ? "n/a" : `${report.summary.queueDelayMs}ms`, "created to first stage")}
      ${metricCard("Model Latency", `${report.summary.totalModelLatencyMs}ms`, `avg ${report.summary.averageModelLatencyMs ?? "n/a"}ms`)}
      ${metricCard("Command Time", `${report.summary.commandExecutionMs}ms`, `${report.summary.fileWriteExecutionMs}ms governed writes`)}
      ${metricCard("Budget Breaches", report.summary.latencyBudgetBreaches, "task-class latency budgets")}
      ${metricCard("Spans", spanCount, `${metricCount} metrics`)}
    </div>
    <div class="meta-grid compact">
      <div><strong>Provider Calls</strong>${formatNumber(report.summary.providerCalls)}</div>
      <div><strong>Fallbacks</strong>${formatNumber(report.summary.fallbackCount)}</div>
      <div><strong>Compact Prompt</strong>${report.summary.estimatedCompactPromptTokens === null ? "n/a" : `${formatNumber(report.summary.estimatedCompactPromptTokens)} tokens`}</div>
      <div><strong>Payload Export</strong>disabled</div>
    </div>
  `;
}

export function renderRunBlockerGuide(
  run: NonNullable<Awaited<ReturnType<typeof getWorkflowRunDetails>>["run"]>,
  tasks: Awaited<ReturnType<typeof getWorkflowRunDetails>>["tasks"]
): string {
  const blockedStages = tasks.filter((task) => task.status === "blocked" || task.status === "failed").map((task) => task.stageId);
  return `<div class="run-blocker-guide">
    <div>
      <p class="eyebrow">Not sure what to choose?</p>
      <h3>How to move this run forward</h3>
      <ul>
        <li><strong>Retry After Fix</strong> when you have already corrected the issue or supplied the missing input.</li>
        <li><strong>Diagnose as New Run</strong> when you want Agent Workflow to investigate and attempt a governed repair.</li>
        <li><strong>Skip blocked stage</strong> when this stage is optional and you accept that its checks or output will be missing.</li>
      </ul>
    </div>
    <form class="run-skip-blocker-form" method="post" action="/api/queue-action">
      <input type="hidden" name="runId" value="${escapeHtml(run.id)}">
      <input type="hidden" name="action" value="skip-blocker">
      <label>Why is it safe to skip ${escapeHtml(blockedStages.join(", ") || "this stage")}?<input name="reason" required placeholder="Example: optional verification is unavailable; I accept the risk"></label>
      <label class="check-row"><input type="checkbox" name="confirmed" required> I understand this stage’s evidence or output will be missing.</label>
      <button class="warning" type="submit">Skip blocked stage &amp; continue →</button>
    </form>
  </div>`;
}

export function renderRunCommandCenterBody(
  run: NonNullable<Awaited<ReturnType<typeof getWorkflowRunDetails>>["run"]>,
  tasks: Awaited<ReturnType<typeof getWorkflowRunDetails>>["tasks"],
  approvals: Awaited<ReturnType<typeof listActionApprovals>>
): string {
  const openApprovals = approvals.filter((approval) => isOpenApproval(approval) && (approval.status !== "failed" || run.status === "blocked" || run.status === "failed"));
  const completed = tasks.filter((task) => task.status === "completed" && !task.skipped).length;
  const skipped = tasks.filter((task) => task.skipped).length;
  const failed = tasks.filter((task) => task.status === "failed" || task.status === "blocked").length;
  const active = tasks.filter((task) => task.status === "queued" || task.status === "leased" || task.status === "running").length;
  const blocked = run.status === "blocked";
  const failedRun = run.status === "failed";
  const failureResolution = failedRunResolution(run.failedReason);
  const superseded = Boolean(run.replacementRunId) || Boolean(run.superseded);
  const attention = !superseded && (openApprovals.length > 0 || blocked || failedRun);
  const headline = superseded
    ? "This run is read-only history"
    : openApprovals.length
    ? `Awaiting approval · ${openApprovals.length} request${openApprovals.length === 1 ? "" : "s"}`
    : blocked
      ? "Workflow is blocked"
      : failedRun
        ? failureResolution.headline
        : run.status === "completed"
          ? skipped > 0 ? "Workflow completed with exceptions" : "Workflow completed"
          : "Workflow is progressing";
  const guidance = superseded
    ? `Do not act on blockers here. Work continued in replacement run ${escapeHtml(run.replacementRunId?.slice(0, 8) ?? "")}.`
    : openApprovals.length
    ? "Review each requested side effect below. Approve and run, approve only, reject, or create an exact recurring rule. The workflow resumes automatically after its final required action is resolved."
    : blocked
      ? escapeHtml(run.blockedReason?.trim() || "No open approval remains. Resolve the blocker, resume from a checkpoint, or start a focused diagnosis.")
      : failedRun
        ? escapeHtml(`${run.failedReason?.trim() || "No specific failure reason was recorded."} ${failureResolution.summary}`)
        : run.status === "completed"
          ? skipped > 0
            ? `${skipped} stage${skipped === 1 ? " was" : "s were"} explicitly skipped. Review the missing evidence before treating this run as a fully verified delivery.`
            : "Review the outcome, summarize it, or replay the run with current project state."
          : "No operator decision is required right now. Keep this page open to watch progress, or run the worker until completion.";
  const runPath = `/run?id=${encodeURIComponent(run.id)}`;
  const primaryActions = superseded
    ? `<a class="button" href="/run?id=${encodeURIComponent(run.replacementRunId ?? run.id)}">Open current continuation →</a>`
    : openApprovals.length && !blocked && !failedRun
    ? `<a class="button" href="#run-command-center">Review approval below</a>${queueRunActionForm(run.id, "cancel", "Cancel Run", "secondary")}`
    : blocked
    ? `${queueRunActionForm(run.id, "resolve-blocker", "Retry After Fix")}${queueRunActionForm(run.id, "repair-blocked", "Diagnose as New Run", "secondary")}${queueRunActionForm(run.id, "resume-checkpoint", "Resume Checkpoint", "secondary")}${queueRunActionForm(run.id, "replay-run", "Replay Run", "secondary")}`
    : failedRun
      ? `${queueRunActionForm(run.id, "retry-failed", "Retry Failed Stages")}${queueRunActionForm(run.id, "repair-blocked", "Diagnose as New Run", "secondary")}${queueRunActionForm(run.id, "replay-run", "Replay Run", "secondary")}`
      : run.status === "completed"
        ? `${runActionForm(run.id, "summarize", "Summarize Run")}${queueRunActionForm(run.id, "replay-run", "Replay Run", "secondary")}`
        : `${workerActionForm(run.id, "batch", "Process Next Batch")}${workerActionForm(run.id, "watch", "Run Until Complete", "secondary")}${queueRunActionForm(run.id, "cancel", "Cancel Run", "secondary")}`;
  const approvalCards = openApprovals.map((approval) => renderMobileApprovalCard(approval)).join("");
  const approvalHistory = approvals.filter((approval) => !isOpenApproval(approval)).slice(0, 5).map((approval) => `
    <tr><td>${escapeHtml(approval.actionType)}</td><td><span class="status ${escapeHtml(approval.status)}">${escapeHtml(approval.status)}</span></td><td>${escapeHtml(truncateMiddle(approval.target, 92))}</td><td>${renderDashboardDateTime(approval.updatedAt)}</td></tr>
  `).join("");
  return `
    <div class="section-heading run-command-heading">
      <div><p class="eyebrow">Command Center</p><h2>${escapeHtml(headline)}</h2><span class="muted">${guidance}</span></div>
      <span class="status ${attention ? "blocked" : escapeHtml(run.status)}">${attention ? "attention" : escapeHtml(run.status)}</span>
    </div>
    <div class="metric-grid run-command-metrics">
      ${metricCard("Stages complete", `${formatNumber(completed)}/${formatNumber(tasks.length)}`, skipped ? `${formatNumber(skipped)} skipped` : "of this run", "check")}
      ${metricCard("Active or queued", formatNumber(active), "stages", "activity")}
      ${metricCard("Blocked or failed", formatNumber(failed), "stages", "warning")}
      ${metricCard("Open approvals", formatNumber(openApprovals.length), openApprovals.length ? "decision needed" : "none waiting", "shield", openApprovals.length ? "needs-attention" : "")}
    </div>
    <div class="actions run-command-actions">${primaryActions}<a class="button secondary" href="/approvals?status=open&run=${encodeURIComponent(run.id)}">All Run Approvals</a></div>
    ${blocked && !superseded ? renderRunBlockerGuide(run, tasks) : ""}
    ${openApprovals.length && !superseded ? `<div class="run-approval-section"><div class="section-heading"><div><h3>Decisions Required</h3><span class="muted">These controls use the same project role gates, execution claims, receipts, and policy checks as the Approvals page.</span></div></div><div class="run-approval-grid">${approvalCards}</div></div>` : ""}
    ${approvalHistory ? `<details class="governance-details"><summary>Recent approval history</summary><div class="table-wrap"><table><thead><tr><th>Action</th><th>Status</th><th>Target</th><th>Updated</th></tr></thead><tbody>${approvalHistory}</tbody></table></div></details>` : ""}
    <input type="hidden" data-run-return-path value="${escapeHtml(runPath)}">
  `;
}

export function renderRunContinuationBanner(
  run: NonNullable<Awaited<ReturnType<typeof getWorkflowRunDetails>>["run"]>
): string {
  const sourceRunId = typeof run.evaluationMetadata?.replayOfRunId === "string"
    ? run.evaluationMetadata.replayOfRunId.trim()
    : typeof run.evaluationMetadata?.sourceRunId === "string"
      ? run.evaluationMetadata.sourceRunId.trim()
      : "";
  if (run.replacementRunId) {
    const replacementActive = run.replacementRunStatus === "queued" || run.replacementRunStatus === "leased" || run.replacementRunStatus === "running";
    const replacementCompleted = run.replacementRunStatus === "completed";
    const recoveryHeadline = replacementActive
      ? "This run has active follow-up work"
      : replacementCompleted
        ? "This run was recovered by follow-up work"
        : "The latest follow-up needs attention";
    const recoveryDetail = replacementActive
      ? `Current work is happening in run <strong>${escapeHtml(run.replacementRunId.slice(0, 8))}</strong>${run.replacementRunStartedAt ? `, started ${renderDashboardDateTime(run.replacementRunStartedAt)}` : ""}.`
      : replacementCompleted
        ? `Recovery run <strong>${escapeHtml(run.replacementRunId.slice(0, 8))}</strong> completed successfully.`
        : `Latest follow-up run <strong>${escapeHtml(run.replacementRunId.slice(0, 8))}</strong> is ${escapeHtml(run.replacementRunStatus ?? "unavailable")}; review that run before taking further action.`;
    return `<section class="run-continuation-banner source-run" aria-labelledby="run-continuation-title">
      <div class="run-continuation-icon" aria-hidden="true">→</div>
      <div class="run-continuation-copy">
        <p class="eyebrow">Recovery chain</p>
        <h2 id="run-continuation-title">${recoveryHeadline}</h2>
        <p>The original ${escapeHtml(run.status)} result remains immutable history. ${recoveryDetail}</p>
      </div>
      <div class="run-continuation-action">
        ${run.replacementRunStatus ? `<span class="status ${escapeHtml(run.replacementRunStatus)}">${escapeHtml(run.replacementRunStatus)}</span>` : ""}
        <a class="button" href="/run?id=${encodeURIComponent(run.replacementRunId)}">Open continuation run →</a>
      </div>
    </section>`;
  }
  if (sourceRunId) {
    return `<section class="run-continuation-banner replacement-run" aria-labelledby="run-continuation-title">
      <div class="run-continuation-icon" aria-hidden="true">✓</div>
      <div class="run-continuation-copy">
        <p class="eyebrow">Recovery active</p>
        <h2 id="run-continuation-title">Follow-up run in progress</h2>
        <p>This run continues or repairs source run <strong>${escapeHtml(sourceRunId.slice(0, 8))}</strong>. The source history and evidence remain available.</p>
      </div>
      <div class="run-continuation-action">
        <span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
        <a class="button secondary" href="/run?id=${encodeURIComponent(sourceRunId)}">View source run</a>
      </div>
    </section>`;
  }
  return "";
}

export function renderRunDecisionExplanationsHtml(explanations: RunDecisionExplanation[]): string {
  const cards = explanations.map((item) => `
    <article class="decision-card ${item.status}">
      <strong>${escapeHtml(item.title)}</strong>
      <p>${escapeHtml(item.detail)}</p>
      <ul>${item.evidence.map((evidence) => `<li>${escapeHtml(evidence)}</li>`).join("")}</ul>
    </article>
  `).join("");
  return `<section class="panel">
    <div class="section-heading">
      <div>
        <h2>Why This Ran This Way</h2>
        <span class="muted">Evidence-backed explanations for workflow choice, model tier, provider routing, and fallback behavior.</span>
      </div>
    </div>
    <div class="decision-grid">${cards}</div>
  </section>`;
}

export function renderRunLiveProgressScript(runId: string, initiallyActive: boolean): string {
  return `(() => {
    const runId = ${serializeInlineScriptJson(runId)};
    const terminal = new Set(['completed', 'failed', 'blocked', 'cancelled', 'dismissed']);
    const log = document.getElementById('run-live-log');
    const connection = document.getElementById('run-live-connection');
    const indicator = document.getElementById('run-live-indicator');
    const toggle = document.getElementById('run-live-toggle');
    const verboseToggle = document.getElementById('run-live-verbose');
    const livePanel = log.closest('.run-live-panel');
    const liveScope = document.getElementById('run-live-scope');
    const stages = document.getElementById('run-live-stages');
    const continuation = document.getElementById('run-continuation');
    const stageTimeline = document.getElementById('run-stage-timeline');
    const commandCenter = document.getElementById('run-command-center');
    const eta = document.getElementById('run-live-eta');
    let selectedStage = '';
    let stageTimer = 0;
    let verbose = false;
    let paused = false;
    let stopped = ${initiallyActive ? "false" : "true"};
    let loaded = false;
    let failures = 0;
    let lastSummaryEvents = [];
    let lastVerboseEvents = [];

    const text = (tag, value, className) => {
      const node = document.createElement(tag);
      node.textContent = value == null ? '' : String(value);
      if (className) node.className = className;
      return node;
    };
    const formatTime = (value) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };
    const formatDuration = (value) => {
      if (!Number.isFinite(value)) return '';
      if (value < 60000) return Math.max(1, Math.round(value / 1000)) + 's';
      const minutes = Math.floor(value / 60000);
      const seconds = Math.round((value % 60000) / 1000);
      return minutes + 'm ' + seconds + 's';
    };
    const statusClass = (value) => ['queued', 'leased', 'running', 'completed', 'failed', 'blocked', 'cancelled'].includes(value) ? value : 'queued';

    function eventKey(event) {
      return String(event.id || [event.occurredAt, event.eventType, event.title, event.detail, event.status].join('|'));
    }

    function renderEvents(events, forceReset = false) {
      const followTail = !loaded || log.scrollHeight - log.scrollTop - log.clientHeight < 64;
      if (forceReset) {
        log.replaceChildren();
        loaded = false;
      }
      const empty = log.querySelector('.run-live-empty');
      if (events.length && empty) empty.remove();
      const existing = new Set(Array.from(log.querySelectorAll('[data-event-key]')).map((node) => node.getAttribute('data-event-key')));
      if (!events.length && !log.children.length) log.append(text('li', verbose ? 'Waiting for verbose activity…' : 'No run activity has been recorded yet.', 'run-live-empty'));
      for (const event of events) {
        const key = eventKey(event);
        if (existing.has(key)) continue;
        const item = document.createElement('li');
        item.className = 'run-live-entry ' + (event.severity || 'info');
        item.dataset.eventKey = key;
        const time = text('time', formatTime(event.occurredAt), 'run-live-time');
        time.dateTime = event.occurredAt || '';
        const body = document.createElement('div');
        body.append(text('strong', event.title || event.eventType || 'Activity'));
        if (event.detail) body.append(text('span', event.detail));
        const badge = text('span', event.status || event.category || 'info', 'status ' + statusClass(event.status));
        item.append(time, body, badge);
        log.append(item);
      }
      if (followTail) log.scrollTop = log.scrollHeight;
      loaded = true;
    }

    function renderStages(tasks) {
      stages.replaceChildren();
      for (const task of tasks) {
        const row = document.createElement('tr');
        for (const value of [task.stageId, task.agentId]) row.append(text('td', value));
        const statusCell = document.createElement('td');
        statusCell.append(text('span', task.skipped ? 'skipped' : task.status, 'status ' + (task.skipped ? 'skipped' : statusClass(task.status))));
        row.append(statusCell, text('td', task.attempts), text('td', task.executor));
        stages.append(row);
      }
    }

    function verboseRunEntries(payload) {
      const entries = [...(Array.isArray(payload.events) ? payload.events : [])];
      for (const task of (Array.isArray(payload.tasks) ? payload.tasks : [])) entries.push({ id: 'task:' + task.stageId + ':' + task.status + ':' + task.attempts, occurredAt: payload.generatedAt, title: 'Stage snapshot · ' + task.stageId, detail: task.agentId + ' · attempt ' + task.attempts + ' · ' + task.executor, status: task.skipped ? 'skipped' : task.status, category: 'stage' });
      for (const receipt of (Array.isArray(payload.receipts) ? payload.receipts : [])) entries.push({ id: 'receipt:' + receipt.id, occurredAt: receipt.createdAt, title: 'Action · ' + receipt.actionType, detail: receipt.summary, status: 'completed', category: 'receipt' });
      for (const approval of (Array.isArray(payload.approvals) ? payload.approvals : [])) entries.push({ id: 'approval:' + approval.id, occurredAt: approval.createdAt, title: 'Approval · ' + approval.actionType, detail: approval.target, status: approval.status, category: 'approval' });
      for (const artifact of (Array.isArray(payload.artifacts) ? payload.artifacts : [])) entries.push({ id: 'artifact:' + artifact.id, occurredAt: artifact.createdAt, title: 'Artifact · ' + artifact.kind, detail: artifact.uri, status: 'recorded', category: 'artifact' });
      return entries.sort((left, right) => String(left.occurredAt || '').localeCompare(String(right.occurredAt || '')));
    }

    function setVerbose(next, stageId = '') {
      verbose = next;
      selectedStage = next ? stageId : '';
      verboseToggle.textContent = verbose ? 'Summary' : 'Verbose';
      verboseToggle.setAttribute('aria-pressed', String(verbose));
      livePanel.classList.toggle('verbose', verbose);
      liveScope.hidden = !verbose;
      liveScope.textContent = selectedStage
        ? 'Streaming full activity for stage “' + selectedStage + '”. Choose Summary to return to the run feed.'
        : 'Streaming all recorded run activity as it arrives. Choose a stage number to focus this stream.';
      log.setAttribute('aria-label', selectedStage ? 'Verbose stage activity stream' : (verbose ? 'Verbose run activity stream' : 'Run progress log'));
      renderEvents([], true);
      if (!selectedStage) renderEvents(verbose ? lastVerboseEvents : lastSummaryEvents);
      window.clearTimeout(stageTimer);
      if (verbose && selectedStage) refreshStage();
    }

    async function refreshStage() {
      if (!verbose || !selectedStage) return;
      try {
        const response = await fetch('/api/run-stage?id=' + encodeURIComponent(runId) + '&stage=' + encodeURIComponent(selectedStage), { cache: 'no-store', headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const payload = await response.json();
        const entries = [{
          id: 'stage-snapshot:' + payload.task.stageId + ':' + payload.task.status + ':' + payload.task.attempts,
          occurredAt: payload.task.finishedAt || payload.task.startedAt || payload.generatedAt,
          title: payload.task.stageId + ' · ' + payload.task.agentId,
          detail: 'Status ' + payload.task.status + ' · attempt ' + payload.task.attempts + ' · ' + payload.task.executor,
          status: payload.task.status,
          category: 'stage'
        }];
        for (const event of (Array.isArray(payload.events) ? payload.events : [])) entries.push(event);
        for (const receipt of payload.receipts) entries.push({ id: 'receipt:' + receipt.actionType + ':' + receipt.createdAt, occurredAt: receipt.createdAt, title: 'Action · ' + receipt.actionType, detail: receipt.summary, status: 'completed', category: 'receipt' });
        for (const approval of payload.approvals) entries.push({ id: 'approval:' + approval.actionType + ':' + approval.createdAt, occurredAt: approval.createdAt, title: 'Approval · ' + approval.actionType, detail: approval.target, status: approval.status, category: 'approval' });
        for (const artifact of payload.artifacts) entries.push({ id: 'artifact:' + artifact.uri + ':' + artifact.createdAt, occurredAt: artifact.createdAt, title: 'Artifact · ' + artifact.kind, detail: artifact.uri, status: 'recorded', category: 'artifact' });
        entries.sort((left, right) => String(left.occurredAt || '').localeCompare(String(right.occurredAt || '')));
        renderEvents(entries);
        connection.textContent = 'Verbose stage stream · updated ' + formatTime(payload.generatedAt) + (terminal.has(payload.task.status) ? '' : ' · next update in 2s');
        window.clearTimeout(stageTimer);
        if (!terminal.has(payload.task.status) && !terminal.has(payload.runStatus)) stageTimer = window.setTimeout(refreshStage, document.hidden ? 5000 : 2000);
      } catch (error) {
        connection.textContent = 'Verbose stage stream unavailable (' + (error instanceof Error ? error.message : 'request failed') + ') · retrying';
        window.clearTimeout(stageTimer);
        stageTimer = window.setTimeout(refreshStage, 5000);
      }
    }

    document.addEventListener('click', (event) => {
      const trigger = event.target instanceof Element ? event.target.closest('[data-stage-watch]') : null;
      if (!trigger) return;
      selectedStage = trigger.getAttribute('data-stage-watch') || '';
      setVerbose(true, selectedStage);
      livePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    verboseToggle.addEventListener('click', () => {
      setVerbose(!verbose);
      if (verbose) refresh();
    });

    async function refresh() {
      if (paused) return schedule();
      try {
        const response = await fetch('/api/run-progress?id=' + encodeURIComponent(runId), { cache: 'no-store', headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const payload = await response.json();
        failures = 0;
        lastSummaryEvents = Array.isArray(payload.events) ? payload.events : [];
        lastVerboseEvents = verboseRunEntries(payload);
        if (!selectedStage) renderEvents(verbose ? lastVerboseEvents : lastSummaryEvents);
        renderStages(Array.isArray(payload.tasks) ? payload.tasks : []);
        if (typeof payload.continuationHtml === 'string' && continuation.innerHTML !== payload.continuationHtml) {
          continuation.innerHTML = payload.continuationHtml;
        }
        if (typeof payload.stageTimelineHtml === 'string' && stageTimeline.innerHTML !== payload.stageTimelineHtml) {
          stageTimeline.innerHTML = payload.stageTimelineHtml;
        }
        if (typeof payload.commandCenterHtml === 'string' && commandCenter.innerHTML !== payload.commandCenterHtml) {
          commandCenter.innerHTML = payload.commandCenterHtml;
        }
        const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
        const completed = tasks.filter((task) => task.status === 'completed' && !task.skipped).length;
        const failed = tasks.filter((task) => task.status === 'failed').length;
        const active = tasks.filter((task) => ['queued', 'leased', 'running'].includes(task.status)).length;
        document.getElementById('run-live-completed').textContent = completed + '/' + tasks.length + ' completed';
        document.getElementById('run-live-failed').textContent = String(failed);
        document.getElementById('run-live-active').textContent = String(active);
        if (eta && payload.eta) {
          eta.textContent = payload.eta.state === 'complete'
            ? 'Complete'
            : payload.eta.state === 'paused'
              ? 'Paused'
              : payload.eta.state === 'waiting'
              ? 'Waiting — no worker is running'
              : payload.eta.state === 'estimated' && Number.isFinite(payload.eta.remainingMs)
                ? '~' + formatDuration(payload.eta.remainingMs) + ' remaining · ' + new Date(payload.eta.estimatedCompletionAt).toLocaleString([], { hour: 'numeric', minute: '2-digit' }) + ' · ' + payload.eta.confidence + ' confidence'
                : 'Estimating…';
          eta.title = payload.eta.reason || '';
        }
        const status = document.getElementById('run-live-status');
        status.textContent = payload.run.status;
        status.className = 'status ' + statusClass(payload.run.status);
        stopped = terminal.has(payload.run.status);
        indicator.classList.toggle('active', !stopped);
        connection.textContent = stopped
          ? 'Run ' + payload.run.status + ' · final activity loaded ' + formatTime(payload.generatedAt)
          : 'Live · updated ' + formatTime(payload.generatedAt) + ' · next update in 2s';
        toggle.hidden = stopped;
        if (stopped && ${initiallyActive ? "true" : "false"}) window.setTimeout(() => { if (document.documentElement.dataset.queuePartnerOpen !== "true") window.location.reload(); }, 1200);
      } catch (error) {
        failures += 1;
        connection.textContent = 'Live update unavailable (' + (error instanceof Error ? error.message : 'request failed') + ') · retrying';
        indicator.classList.remove('active');
      }
      schedule();
    }

    function schedule() {
      if (!stopped) window.setTimeout(refresh, failures ? Math.min(15000, 2000 * failures) : (document.hidden ? 5000 : 2000));
    }
    toggle.addEventListener('click', () => {
      paused = !paused;
      toggle.textContent = paused ? 'Resume updates' : 'Pause updates';
      indicator.classList.toggle('active', !paused && !stopped);
      connection.textContent = paused ? 'Live updates paused' : 'Resuming live updates…';
      if (!paused) refresh();
    });
    refresh();
  })();`;
}

export function renderRunStageTimeline(tasks: Awaited<ReturnType<typeof getWorkflowRunDetails>>["tasks"]): string {
  const steps = tasks.map((task, index) => {
    const state = task.skipped
      ? "skipped"
      : task.status === "completed"
      ? "completed"
      : task.status === "running" || task.status === "leased"
        ? "active"
        : task.status === "failed" || task.status === "blocked"
          ? "failed"
          : task.status === "cancelled"
            ? "cancelled"
            : "pending";
    const stateLabel = state === "active" ? "in progress" : state;
    return `<li class="run-stage-step ${state}" aria-label="Stage ${index + 1}: ${escapeHtml(task.stageId)}, ${escapeHtml(stateLabel)}">
      <div class="run-stage-track"><button type="button" class="run-stage-circle" data-stage-watch="${escapeHtml(task.stageId)}" aria-label="Watch stage ${escapeHtml(task.stageId)}" title="Focus verbose stream on this stage">${index + 1}</button></div>
      <strong>${escapeHtml(task.stageId)}</strong>
      <span class="run-stage-agent">${escapeHtml(task.agentId)}</span>
      <small>${escapeHtml(stateLabel)}</small>
    </li>`;
  }).join("");
  const completed = tasks.filter((task) => task.status === "completed" && !task.skipped).length;
  const skipped = tasks.filter((task) => task.skipped).length;
  return `<div class="section-heading"><div><p class="eyebrow">Stage Timeline</p><h2>${formatNumber(completed)} of ${formatNumber(tasks.length)} complete${skipped ? ` · ${formatNumber(skipped)} skipped` : ""}</h2></div><span class="muted">Updates live</span></div>
    <div class="run-stage-timeline-scroll"><ol class="run-stage-timeline" aria-label="Workflow stage progress">${steps || '<li class="run-stage-empty">No stages were created for this run.</li>'}</ol></div>`;
}

export function renderRunUsageEstimateHtml(estimate: RunUsageEstimate): string {
  return `
    <div class="metric-grid">
      ${metricCard("Est. Prompt Tokens", formatNumber(estimate.estimatedPromptTokens), `${estimate.routedStages} routed stages`)}
      ${metricCard("Est. Tokens Saved", formatNumber(estimate.estimatedTokensSaved), `${estimate.tokenReductionPercent ?? "n/a"}% reduction`)}
      ${metricCard("Indexed Context", formatNumber(estimate.indexedProjectTokens), "project baseline")}
      ${metricCard("Compiled Brief", formatNumber(estimate.compiledBriefTokens), "per-stage compact context")}
      ${metricCard("Selected Sources", formatNumber(estimate.selectedSourceTokens), "source summary budget")}
      ${metricCard("Run Duration", estimate.runDurationMs === null ? "n/a" : formatDuration(estimate.runDurationMs), "wall-clock")}
    </div>
    <p class="muted">Estimate compares the indexed project context baseline with the compact compiled brief that each model-routed stage received.</p>
  `;
}

/** The Workflow column already names the workflow, so drop a matching "Workflow name: " prefix from the task. */
export function withoutWorkflowPrefix(title: string, workflowId: string): string {
  const index = title.indexOf(": ");
  if (index <= 0) return title;
  const prefix = title.slice(0, index).toLowerCase();
  const names = [workflowDisplayName(workflowId), workflowId.replace(/-/gu, " ")].map((name) => name.toLowerCase());
  return names.includes(prefix) ? title.slice(index + 2) : title;
}

/** "Running" covers leased runs too: both hold a worker lease. */
export function runsPageStatusMatches(status: string, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "running") return status === "running" || status === "leased";
  if (filter === "active") return status === "queued" || status === "running" || status === "leased";
  return status === filter;
}

export function runActionForm(runId: string, action: string, label: string, variant: "primary" | "secondary" = "primary"): string {
  return `<form method="post" action="/api/follow-up"><input type="hidden" name="runId" value="${escapeHtml(runId)}"><input type="hidden" name="action" value="${escapeHtml(action)}"><button${variant === "secondary" ? ' class="secondary"' : ""} type="submit">${iconLabel("play", label)}</button></form>`;
}

export function runDurationMs(run: DashboardRunStatus): number | null {
  if (!run.finishedAt) {
    return null;
  }
  const started = Date.parse(run.startedAt);
  const finished = Date.parse(run.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    return null;
  }
  return finished - started;
}

export function sumApproxSourceTokens(text: string): number {
  return [...text.matchAll(/Approx tokens:\s*(\d+)/gu)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
}

export function workerActionForm(runId: string, mode: "batch" | "watch", label: string, variant: "primary" | "secondary" = "primary"): string {
  return `<form class="worker-form" method="post" action="/api/run-worker"><input type="hidden" name="runId" value="${escapeHtml(runId)}"><input type="hidden" name="mode" value="${escapeHtml(mode)}"><input type="hidden" name="workerLimit" value="6"><input type="hidden" name="workerConcurrency" value="1"><input type="hidden" name="timeoutMs" value="${mode === "watch" ? "60000" : "1000"}"><button${variant === "secondary" ? ' class="secondary"' : ""} type="submit">${iconLabel(mode === "watch" ? "activity" : "play", label)}</button></form>`;
}

export function workflowSelectionExplanation(run: NonNullable<Awaited<ReturnType<typeof getWorkflowRunDetails>>["run"]>, summary: RunSummary | null): string {
  if (run.evaluationMetadata?.kind === "stage_fix_suggestion") {
    return "This run was created from a focused graph-stage fix action, so it used the debug workflow shape instead of a broad feature workflow.";
  }
  if (run.evaluationMetadata?.kind === "stage_fix_verification") {
    return "This run verifies a previously suggested stage fix and is tagged for before/after workflow graph health comparison.";
  }
  if (/debug|failure|fix/i.test(run.workflowId)) {
    return "The run used a failure/debug workflow, usually selected when the task or source run points at broken checks, errors, or failed stages.";
  }
  if (/review|readiness|ship|release/i.test(run.workflowId)) {
    return "The run used a verifier-heavy workflow, usually selected for review, release, production, or launch-risk work.";
  }
  if (/build|feature|implement/i.test(run.workflowId)) {
    return "The run used the planner-executor feature workflow, usually selected when the task asks Agent Workflow to build, change, or implement something.";
  }
  if (summary?.recommendedNextAction) {
    return `The run used ${run.workflowId}; the current evidence suggests: ${summary.recommendedNextAction}`;
  }
  return `The run used ${run.workflowId}. Open the workflow graph to inspect its pattern metadata, agents, gates, and stage order.`;
}
