import type { LearningLoopDashboard } from "../../../../packages/learning-loop/src/index.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shortHash(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

export function renderLearningLoopHtml(report: LearningLoopDashboard): string {
  const project = report.projectDir ?? "";
  const returnTo = `/learning?project=${encodeURIComponent(project)}&view=learning-loop`;
  const questionRows = report.openQuestions.map((question) => `
    <tr><td>${escapeHtml(question.taskClass)}</td><td>${escapeHtml(question.requesterAgentId)}</td><td>${escapeHtml(question.respondentAgentId)}</td><td>${escapeHtml(question.rubricVersion)}</td><td>${escapeHtml(question.expiresAt)}</td></tr>
  `).join("");
  const aggregateRows = report.recentAggregates.map((item) => {
    const decision = report.evidenceDecisions.find((candidate) => candidate.questionId === item.questionId);
    const missingGates = item.aggregate.missingGates ?? [
      ...(item.aggregate.deterministicChecksPassed ? [] : ["Deterministic verification evidence is not linked."]),
      ...(item.aggregate.humanFeedbackConfirmed ? [] : ["Human confirmation is not recorded."])
    ];
    return `
    <tr><td><code>${escapeHtml(shortHash(item.questionId))}</code></td><td><span class="status ${item.aggregate.status === "promotion-eligible" ? "completed" : "queued"}">${escapeHtml(item.aggregate.status)}</span></td><td>${item.aggregate.reviewerCount} independent / ${item.aggregate.calibratedReviewerCount ?? 0} calibrated</td><td>${item.aggregate.calibratedScore?.toFixed(2) ?? "n/a"}</td><td>${item.aggregate.disagreement?.toFixed(2) ?? "n/a"}</td><td>${escapeHtml(missingGates.join(" ") || "All evidence gates passed.")}
      <details><summary>Review evidence gates</summary>
        <form method="post" action="/api/learning-loop-evidence" class="stacked-form">
          <input type="hidden" name="project" value="${escapeHtml(project)}"><input type="hidden" name="questionId" value="${escapeHtml(item.questionId)}"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
          <label>Durable verification receipt <input name="deterministicReceipt" value="${escapeHtml(decision?.deterministicReceipt ?? "")}" placeholder=".agent-workflow/receipts/... or sha256:..."></label>
          <label><input type="checkbox" name="deterministicChecksPassed" ${decision?.deterministicChecksPassed ? "checked" : ""}> Deterministic checks passed</label>
          <label><input type="checkbox" name="humanFeedbackConfirmed" ${decision?.humanFeedbackConfirmed ? "checked" : ""}> I reviewed the evidence and confirm the result</label>
          <label>Confirmed by <input name="confirmedBy" value="${escapeHtml(decision?.confirmedBy ?? "dashboard-operator")}"></label>
          <button type="submit" class="button">Save evidence review</button>
        </form>
      </details></td></tr>`;
  }).join("");
  const experimentRows = report.experiments.map((experiment) => `
    <tr><td>${escapeHtml(experiment.target)}</td><td><span class="status ${experiment.status === "promoted" ? "completed" : experiment.status === "rolled-back" || experiment.status === "quarantined" ? "failed" : "queued"}">${escapeHtml(experiment.status)}</span></td><td>${experiment.sampleCount}</td><td>${experiment.canaryPercent ?? 0}%</td><td><code>${escapeHtml(shortHash(experiment.baselineHash))}</code></td><td><code>${escapeHtml(shortHash(experiment.candidateHash))}</code></td></tr>
  `).join("");
  const schedulerRows = report.latestSchedulerReceipts.map((receipt) => `
    <tr><td>${escapeHtml(receipt.completedAt)}</td><td><span class="status ${receipt.status === "completed" ? "completed" : receipt.status === "failed" ? "failed" : "queued"}">${escapeHtml(receipt.status)}</span></td><td>${escapeHtml(receipt.providerId ?? "disabled")}</td><td>${escapeHtml(receipt.questionId ?? "none")}</td><td>${escapeHtml(receipt.reason)}</td></tr>
  `).join("");
  const resolvedSchedulerRows = report.resolvedSchedulerFailures.map((receipt) => `
    <tr><td>${escapeHtml(receipt.completedAt)}</td><td><span class="status completed">resolved</span></td><td>${escapeHtml(receipt.providerId ?? "disabled")}</td><td>${escapeHtml(receipt.questionId ?? "none")}</td><td>${escapeHtml(receipt.reason)}</td></tr>
  `).join("");
  const calibrationRows = report.calibrations.map((item) => `<tr><td>${escapeHtml(item.reviewerAgentId)}</td><td>${item.sampleCount}</td><td>${(item.verifiedAgreement * 100).toFixed(0)}%</td><td>${(item.humanAgreement * 100).toFixed(0)}%</td><td>${item.sampleCount >= 3 ? "calibrated" : "needs 3 samples"}</td></tr>`).join("");
  const costLabel = report.usage.costUsd === null ? `${report.usage.unpricedCalls} unpriced calls` : `$${report.usage.costUsd.toFixed(4)}`;

  return `
    <section class="panel">
      <div class="section-heading"><div><h2>Learning Loop</h2><span class="muted">Evidence-bounded questions, independent peer review, and guarded experiments.</span></div><span class="status completed">private bodies excluded</span></div>
      <div class="metric-grid">
        <div class="metric-card"><strong>${report.summary.questions}</strong><span>Questions</span></div>
        <div class="metric-card"><strong>${report.summary.openQuestions}</strong><span>Open</span></div>
        <div class="metric-card"><strong>${report.summary.completedCycles}</strong><span>Completed cycles</span></div>
        <div class="metric-card"><strong>${report.summary.assessments}</strong><span>Assessments</span></div>
        <div class="metric-card"><strong>${report.summary.calibratedReviewers}</strong><span>Calibrated reviewers</span></div>
        <div class="metric-card"><strong>${report.summary.disagreements}</strong><span>Disagreements</span></div>
        <div class="metric-card"><strong>${report.summary.shadowExperiments}</strong><span>Shadow experiments</span></div>
        <div class="metric-card"><strong>${report.summary.schedulerFailures}</strong><span>Scheduler failures</span></div>
        <div class="metric-card"><strong>${report.summary.historicalSchedulerFailures}</strong><span>Historical failures</span></div>
        <div class="metric-card"><strong>${report.usage.totalTokens.toLocaleString()}</strong><span>Measured tokens</span></div>
        <div class="metric-card"><strong>${escapeHtml(costLabel)}</strong><span>Cost visibility (${report.usage.costCoverageCalls}/${report.usage.calls} priced)</span></div>
      </div>
      <p class="muted">This view exposes scores, state, hashes, and receipts—not private response text. Peer ratings remain advisory until deterministic evidence and governed promotion gates agree.</p>
    </section>
    <section class="panel">
      <h2>Open Peer Questions</h2>
      ${questionRows ? `<div class="table-wrap"><table><thead><tr><th>Task class</th><th>Requester</th><th>Respondent</th><th>Rubric</th><th>Expires</th></tr></thead><tbody>${questionRows}</tbody></table></div>` : `<p class="muted">No unanswered learning questions.</p>`}
    </section>
    <section class="panel">
      <h2>Peer Assessment Results</h2>
      ${aggregateRows ? `<div class="table-wrap"><table><thead><tr><th>Question</th><th>Decision</th><th>Reviewers</th><th>Score</th><th>Disagreement</th><th>Reason / next action</th></tr></thead><tbody>${aggregateRows}</tbody></table></div>` : `<p class="muted">No aggregated peer assessments yet.</p>`}
    </section>
    <section class="panel">
      <h2>Reviewer Calibration</h2>
      <p class="muted">Calibration is durable and immediately recomputes affected learning conclusions. At least three verified samples are required before a reviewer counts as calibrated.</p>
      ${calibrationRows ? `<div class="table-wrap"><table><thead><tr><th>Reviewer</th><th>Samples</th><th>Verified agreement</th><th>Human agreement</th><th>Status</th></tr></thead><tbody>${calibrationRows}</tbody></table></div>` : `<p class="muted">No reviewers are calibrated yet.</p>`}
      <form method="post" action="/api/learning-loop-calibration" class="stacked-form">
        <input type="hidden" name="project" value="${escapeHtml(project)}"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
        <label>Reviewer agent id <input name="reviewerAgentId" required></label>
        <label>Verified samples <input name="sampleCount" type="number" min="1" required></label>
        <label>Verified agreement (0–1) <input name="verifiedAgreement" type="number" min="0" max="1" step="0.01" required></label>
        <label>Human agreement (0–1) <input name="humanAgreement" type="number" min="0" max="1" step="0.01" required></label>
        <button type="submit" class="button">Record calibration</button>
      </form>
    </section>
    <section class="panel">
      <h2>Learning Experiments</h2>
      ${experimentRows ? `<div class="table-wrap"><table><thead><tr><th>Target</th><th>Status</th><th>Samples</th><th>Canary</th><th>Baseline</th><th>Candidate</th></tr></thead><tbody>${experimentRows}</tbody></table></div>` : `<p class="muted">No shadow or canary experiments queued.</p>`}
    </section>
    <section class="panel">
      <h2>Scheduler Receipts</h2>
      <p class="muted">The primary list shows the latest outcome per question, so a successful retry replaces a stale failure without erasing history.</p>
      ${schedulerRows ? `<div class="table-wrap"><table><thead><tr><th>Completed</th><th>Status</th><th>Provider</th><th>Question</th><th>Reason</th></tr></thead><tbody>${schedulerRows}</tbody></table></div>` : `<p class="muted">No scheduled learning exchanges have run.</p>`}
      ${resolvedSchedulerRows ? `<details><summary>${report.resolvedSchedulerFailures.length} resolved failed attempt(s)</summary><div class="table-wrap"><table><thead><tr><th>Completed</th><th>Status</th><th>Provider</th><th>Question</th><th>Original failure</th></tr></thead><tbody>${resolvedSchedulerRows}</tbody></table></div></details>` : ""}
    </section>
  `;
}
