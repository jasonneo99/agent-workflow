import escapeHtmlText from "escape-html";
import type { PreferenceScorecard } from "../../../../packages/run-reporter/src/index.js";

export function renderPreferenceScorecardHtml(scorecard: PreferenceScorecard): string {
  const outcome = scorecard.outcomeAccuracy;
  const recommendations = scorecard.recommendations.map((item) => `<li>${escape(item)}</li>`).join("");
  const rows = scorecard.groups.slice(0, 12).map((group) => `
    <tr>
      <td>${escape(group.workflowId)}<br><span class="muted">${escape(group.stageId)}</span></td>
      <td>${escape(group.agentId)}</td>
      <td>${escape(group.providerId)} / ${escape(group.modelTier)}</td>
      <td>${group.runs}</td>
      <td>${group.accepted}/${group.revised}/${group.rejected}</td>
      <td>${percent(group.outcomeAccuracy ?? null)}<br><span class="muted">${percent(group.feedbackCoverage ?? 0)} covered</span></td>
      <td>${group.calibratedQuality ?? group.averageQuality ?? "n/a"}<br><span class="muted">raw ${group.averageQuality ?? "n/a"}</span></td>
      <td>${group.averageLatencyMs ?? "n/a"} / ${group.latencyBudgetMs ?? "n/a"}<br>${group.latencyBudgetPassed === false ? '<span class="flag warn">over budget</span>' : group.latencyBudgetPassed === true ? '<span class="flag good">within budget</span>' : ""}</td>
      <td>${group.feedbackRequested ? '<span class="flag warn">feedback needed</span><br>' : ""}${escape(group.recommendation)}</td>
    </tr>
  `).join("");

  return `
    <div class="section-heading">
      <div><h3>Outcome Accuracy</h3><span class="muted">Completion is lifecycle state; expected-result accuracy is based on reviewed outcomes.</span></div>
      <span class="status ${outcome.expectedResultRate !== null && outcome.expectedResultRate >= 0.8 ? "completed" : "queued"}">${percent(outcome.expectedResultRate)}</span>
    </div>
    <div class="metric-grid">
      ${metric("Completion", percent(outcome.completionRate), `${outcome.completed}/${outcome.runs} terminally completed`)}
      ${metric("Expected Result", percent(outcome.expectedResultRate), `${outcome.accepted}/${outcome.rated} accepted`)}
      ${metric("Feedback Coverage", percent(outcome.feedbackCoverage), `${outcome.missingOutcomeEvidence} completed run(s) unrated`)}
      ${metric("First Pass", percent(outcome.firstPassRate), `${outcome.firstPassAccepted} accepted without fallback`)}
      ${metric("Quality Mismatch", outcome.qualityMismatch, "revised/rejected despite high heuristic quality")}
      ${metric("Fallback Runs", outcome.fallbackRuns, "runs requiring provider fallback")}
    </div>
    <ul>${recommendations}</ul>
    <div class="table-wrap"><table>
      <thead><tr><th>Workflow</th><th>Agent</th><th>Provider/Tier</th><th>Runs</th><th>A/R/R</th><th>Outcome</th><th>Calibrated Quality</th><th>Latency/Budget ms</th><th>Recommendation</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9">No scored combinations yet.</td></tr>'}</tbody>
    </table></div>
  `;
}

function metric(label: string, value: string | number, note: string): string { return `<div class="metric-card"><strong>${escape(label)}</strong><span>${escape(String(value))}</span><small>${escape(note)}</small></div>`; }
function percent(value: number | null): string { return value === null ? "n/a" : `${Math.round(value * 1000) / 10}%`; }
function escape(value: string): string { return escapeHtmlText(value); }
