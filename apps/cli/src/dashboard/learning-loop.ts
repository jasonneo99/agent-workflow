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
  const questionRows = report.openQuestions.map((question) => `
    <tr><td>${escapeHtml(question.taskClass)}</td><td>${escapeHtml(question.requesterAgentId)}</td><td>${escapeHtml(question.respondentAgentId)}</td><td>${escapeHtml(question.rubricVersion)}</td><td>${escapeHtml(question.expiresAt)}</td></tr>
  `).join("");
  const aggregateRows = report.recentAggregates.map((item) => `
    <tr><td>${escapeHtml(item.questionId)}</td><td><span class="status ${item.aggregate.status === "promotion-eligible" ? "completed" : "queued"}">${escapeHtml(item.aggregate.status)}</span></td><td>${item.aggregate.reviewerCount}</td><td>${item.aggregate.calibratedScore?.toFixed(2) ?? "n/a"}</td><td>${item.aggregate.disagreement?.toFixed(2) ?? "n/a"}</td><td>${escapeHtml(item.aggregate.risks.join("; ") || "none")}</td></tr>
  `).join("");
  const experimentRows = report.experiments.map((experiment) => `
    <tr><td>${escapeHtml(experiment.target)}</td><td><span class="status ${experiment.status === "promoted" ? "completed" : experiment.status === "rolled-back" || experiment.status === "quarantined" ? "failed" : "queued"}">${escapeHtml(experiment.status)}</span></td><td>${experiment.sampleCount}</td><td>${experiment.canaryPercent ?? 0}%</td><td><code>${escapeHtml(shortHash(experiment.baselineHash))}</code></td><td><code>${escapeHtml(shortHash(experiment.candidateHash))}</code></td></tr>
  `).join("");
  const schedulerRows = report.schedulerReceipts.map((receipt) => `
    <tr><td>${escapeHtml(receipt.completedAt)}</td><td><span class="status ${receipt.status === "completed" ? "completed" : receipt.status === "failed" ? "failed" : "queued"}">${escapeHtml(receipt.status)}</span></td><td>${escapeHtml(receipt.providerId ?? "disabled")}</td><td>${escapeHtml(receipt.questionId ?? "none")}</td><td>${escapeHtml(receipt.reason)}</td></tr>
  `).join("");

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
        <div class="metric-card"><strong>${report.usage.totalTokens.toLocaleString()}</strong><span>Measured tokens</span></div>
        <div class="metric-card"><strong>${report.usage.costUsd === null ? "n/a" : `$${report.usage.costUsd.toFixed(4)}`}</strong><span>Estimated cost</span></div>
      </div>
      <p class="muted">This view exposes scores, state, hashes, and receipts—not private response text. Peer ratings remain advisory until deterministic evidence and governed promotion gates agree.</p>
    </section>
    <section class="panel">
      <h2>Open Peer Questions</h2>
      ${questionRows ? `<div class="table-wrap"><table><thead><tr><th>Task class</th><th>Requester</th><th>Respondent</th><th>Rubric</th><th>Expires</th></tr></thead><tbody>${questionRows}</tbody></table></div>` : `<p class="muted">No unanswered learning questions.</p>`}
    </section>
    <section class="panel">
      <h2>Peer Assessment Results</h2>
      ${aggregateRows ? `<div class="table-wrap"><table><thead><tr><th>Question</th><th>Decision</th><th>Reviewers</th><th>Score</th><th>Disagreement</th><th>Risks</th></tr></thead><tbody>${aggregateRows}</tbody></table></div>` : `<p class="muted">No aggregated peer assessments yet.</p>`}
    </section>
    <section class="panel">
      <h2>Learning Experiments</h2>
      ${experimentRows ? `<div class="table-wrap"><table><thead><tr><th>Target</th><th>Status</th><th>Samples</th><th>Canary</th><th>Baseline</th><th>Candidate</th></tr></thead><tbody>${experimentRows}</tbody></table></div>` : `<p class="muted">No shadow or canary experiments queued.</p>`}
    </section>
    <section class="panel">
      <h2>Scheduler Receipts</h2>
      ${schedulerRows ? `<div class="table-wrap"><table><thead><tr><th>Completed</th><th>Status</th><th>Provider</th><th>Question</th><th>Reason</th></tr></thead><tbody>${schedulerRows}</tbody></table></div>` : `<p class="muted">No scheduled learning exchanges have run.</p>`}
    </section>
  `;
}
