import { renderRouteReceiptTrendsHtml, renderLocalRouteDecisionDrilldownHtml, renderLocalHoldoutRoutingStatusHtml } from "../../ui/routing-components.js";
import { renderFeedbackTargetActionForms, feedbackTargetActionForm, renderFeedbackTargetEvidenceHtml } from "../../ui/feedback-components.js";
import { queueRunActionForm, renderRunInfoDialog } from "../../ui/run-actions.js";
import { titleCase, formatNumber } from "../../ui/format.js";
import { escapeHtml, dashboardNav, iconLabel, renderDashboardFlash, renderDashboardActionHistory, renderDashboardDateTime, metricCard, dashboardReturnInput } from "../../ui/layout.js";
import type { AgentImprovementEvalPlan, AgentImprovementPromotionQueue, AgentImprovementReport, ApprovalAutopilotRisk, DashboardCandidateComparisonReport, DashboardFeedbackBucket, DashboardFeedbackInboxItem, DashboardFeedbackInboxReport, DashboardLearningDaemonStatus, DashboardProjectPathResolution, DashboardProjectSummary, DashboardSupervisorStatus, FeedbackRating, LearningActionReceiptHealth, LearningActionReceiptLog, LearningFailureTriageReport, LearningReport, LearningRouteFeedbackGroup, LearningRouteFeedbackSummary, LearningSettings, AgentImprovementPendingProject, AgentImprovementPendingSummary } from "../../../lib/cli-types.js";
import { countAgentImprovementPendingPromotions, renderAgentImprovementPendingBannerHtml } from "../../../lib/builders-learning.js";
import { defaultFeedbackNote, formatDuration, formatDurationDelta } from "../../../lib/builders-learning.js";
import { formatDashboardDateTimeText } from "../../../lib/builders-runs.js";
import { countStrings, ensureProjectSubdir, formatInlineCounts, isRecord, shellQuote, stringValue, truncateText } from "../../../lib/builders-shared.js";
import { projectConfigSchema } from "../../../../../../packages/agent-registry/src/schemas.js";
import { type DaemonTrustSettings, defaultDaemonTrustSettings } from "../../../../../../packages/daemon-control/src/index.js";
import { type LearningApplicationPlan, type LearningApprovalQueue, type LearningRiskLevel } from "../../../../../../packages/learning-loop/src/governance.js";
import { type LearningLoopDashboard } from "../../../../../../packages/learning-loop/src/index.js";
import { type WorkflowShapeOptimizationReport } from "../../../../../../packages/run-reporter/src/index.js";
import { getWorkflowRunDetails, listArtifacts } from "../../../../../../packages/storage/src/postgres.js";
import { type TrainingDiscoveryReport, type TrainingProposalInbox } from "../../../../../../packages/training-discovery/src/index.js";
import { isCompleteTrainingHoldoutReport, readTrainingHoldoutReport } from "../../../training-holdout-runner.js";
import { renderDaemonControl } from "../../daemon-control.js";
import { dashboardIcon } from "../../icons.js";
import { renderLearningLoopHtml } from "../../learning-loop.js";
import { guideEvidenceCheckpointStorageKey } from "../../../lib/guide-evidence-checkpoint-store.js";
import { serializeInlineScriptJson } from "../../security.js";
import { dashboardCss } from "../../styles.js";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { TrainingProposalEvaluationView } from "../../../commands/daemon-types.js";

export function feedbackRatingForBucket(bucket: DashboardFeedbackBucket): FeedbackRating {
  if (bucket === "probably_accept") return "accepted";
  if (bucket === "probably_reject") return "rejected";
  return "revised";
}

export async function loadAgentImprovementPendingSummary(projects: DashboardProjectSummary[], selectedLocalDir?: string): Promise<AgentImprovementPendingSummary> {
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

export async function loadTrainingProposalEvaluationViews(inbox: TrainingProposalInbox, projectDir?: string): Promise<Map<string, TrainingProposalEvaluationView>> {
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

export function localHoldoutComparisonForm(report: DashboardCandidateComparisonReport): string {
  const returnTo = `/candidate-comparisons?project=${encodeURIComponent(report.projectDir)}`;
  return `<form class="inline-form" method="post" action="/api/follow-up">
    <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
    <input type="hidden" name="project" value="${escapeHtml(report.projectDir)}">
    <input type="hidden" name="action" value="local-holdout-comparison">
    <button type="submit">${iconLabel("brain", "Generate Local Holdout Plan")}</button>
  </form>`;
}

export function localHoldoutPromotionForm(report: DashboardCandidateComparisonReport): string {
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

export function localHoldoutResultsForm(report: DashboardCandidateComparisonReport): string {
  const returnTo = `/candidate-comparisons?project=${encodeURIComponent(report.projectDir)}`;
  return `<form class="inline-form" method="post" action="/api/follow-up">
    <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
    <input type="hidden" name="project" value="${escapeHtml(report.projectDir)}">
    <input type="hidden" name="action" value="local-holdout-results">
    <button type="submit">${iconLabel("clipboard", "Capture Holdout Results")}</button>
  </form>`;
}

export function promotionNotePlanForm(report: DashboardCandidateComparisonReport): string {
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

export function renderAgentImprovementHtml(report: AgentImprovementReport, evalPlan: AgentImprovementEvalPlan | null, promotionQueue: AgentImprovementPromotionQueue | null): string {
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

export function renderCandidateComparisonReportHtml(report: DashboardCandidateComparisonReport): string {
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

export function renderCandidateComparisonsHtml(
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

export function renderDashboardProjectPathResolutionHtml(projectPath: DashboardProjectPathResolution): string {
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

export function renderFeedbackBulkReviewHtml(report: DashboardFeedbackInboxReport, params: URLSearchParams): string {
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

export function renderFeedbackInboxGroupHtml(
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

export function renderFeedbackInboxHtml(
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

export function renderFeedbackTargetPrimaryActionForm(target: DashboardFeedbackInboxItem, rating: FeedbackRating): string {
  return `
    <div class="recommended-feedback">
      <strong>Recommended</strong>
      ${feedbackTargetActionForm(target.runId, rating, `Mark ${titleCase(rating)}`, defaultFeedbackNote(target, rating))}
    </div>
  `;
}

export function renderLearningActionReceiptHealthHtml(health: LearningActionReceiptHealth, limit: number, workflowId: string): string {
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

export function renderLearningActionReceiptsHtml(log: LearningActionReceiptLog, limit: number): string {
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

export function renderLearningDaemonStatusHtml(status: DashboardLearningDaemonStatus, supervisor: DashboardSupervisorStatus): string {
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

export function renderGuideEvidenceDiagnosticsPanel(project: string): string {
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

export function renderGuideAdoptionHoldMetricsPanel(project: string): string {
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

export function renderLearningDashboardHtml(report: LearningReport | null, learningQueue: LearningApprovalQueue | null, learningDaemon: DashboardLearningDaemonStatus | null, learningApplicationPlan: LearningApplicationPlan | null, learningActionReceipts: LearningActionReceiptLog | null, learningActionReceiptHealth: LearningActionReceiptHealth | null, workflowShape: WorkflowShapeOptimizationReport | null, agentImprovement: AgentImprovementReport | null, agentImprovementEval: AgentImprovementEvalPlan | null, agentImprovementPromotion: AgentImprovementPromotionQueue | null, learningSettings: LearningSettings | null, supervisor: DashboardSupervisorStatus, projects: DashboardProjectSummary[], params: URLSearchParams, projectPath: DashboardProjectPathResolution | null = null, learningLoop: LearningLoopDashboard | null = null, agentImprovementPending: AgentImprovementPendingSummary | null = null): string {
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

export function renderLearningFailureTriageHtml(report: LearningFailureTriageReport): string {
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

export function renderLearningReportHtml(report: LearningReport, learningQueue: LearningApprovalQueue | null, learningDaemon: DashboardLearningDaemonStatus | null, learningApplicationPlan: LearningApplicationPlan | null, learningActionReceipts: LearningActionReceiptLog | null, learningActionReceiptHealth: LearningActionReceiptHealth | null, workflowShape: WorkflowShapeOptimizationReport | null, agentImprovement: AgentImprovementReport | null, agentImprovementEval: AgentImprovementEvalPlan | null, agentImprovementPromotion: AgentImprovementPromotionQueue | null, shapeAutoUpdate: boolean, agentImprovementProjectLocalAutoApply: boolean, autonomousApplyMaxRisk: LearningRiskLevel, approvalAutopilotEnabled: boolean, approvalAutopilotMaxRisk: ApprovalAutopilotRisk, daemonTrustLevels: DaemonTrustSettings, supervisor: DashboardSupervisorStatus, projectPath: DashboardProjectPathResolution | null = null): string {
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

export function renderLearningRouteFeedbackHtml(summary: LearningRouteFeedbackSummary): string {
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

export function renderLearningSupervisorTargetHtml(projectDir: string, supervisor: DashboardSupervisorStatus): string {
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

export function renderTrainingProposalActions(item: TrainingProposalInbox["items"][number], selected: string, params: URLSearchParams, evaluation?: TrainingProposalEvaluationView): string {
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

export function renderTrainingProposalsHtml(inbox: TrainingProposalInbox, report: TrainingDiscoveryReport | null, projects: DashboardProjectSummary[], selected: string, params: URLSearchParams, evaluationViews = new Map<string, TrainingProposalEvaluationView>()): string {
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

export function renderWorkflowShapeOptimizationHtml(report: WorkflowShapeOptimizationReport, command: string, autoUpdate: boolean, agentImprovementProjectLocalAutoApply: boolean, autonomousApplyMaxRisk: LearningRiskLevel, approvalAutopilotEnabled: boolean, approvalAutopilotMaxRisk: ApprovalAutopilotRisk, daemonTrustLevels: DaemonTrustSettings): string {
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

export function trainingEvaluationVerdict(summary: string | null | undefined): "PASS" | "FAIL" | "INCONCLUSIVE" | null {
  const match = summary?.trim().match(/^(PASS|FAIL|INCONCLUSIVE)\b/u);
  return match ? match[1] as "PASS" | "FAIL" | "INCONCLUSIVE" : null;
}

export async function writeLearningSettings(projectDir: string, settings: LearningSettings): Promise<void> {
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
