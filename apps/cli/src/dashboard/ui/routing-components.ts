import { formatNumber } from "./format.js";
import { escapeHtml, iconLabel, metricCard } from "./layout.js";
import type { DashboardLocalHoldoutRoutingStatus, DashboardRouteReceiptTrendGroup, DashboardRouteReceiptTrendReport } from "../../lib/cli-types.js";
import { truncateText } from "../../lib/builders-shared.js";

export function localRouteDecisionExplanation(
  group: DashboardRouteReceiptTrendGroup,
  holdout: DashboardLocalHoldoutRoutingStatus
): { label: string; severity: "good" | "warning" | "info"; reason: string; nextAction: string } {
  if (group.classification === "local-selected") {
    return {
      label: "local selected",
      severity: group.fallbackCount ? "warning" : "good",
      reason: holdout.thresholdSummary
        ? `Approved holdout routing is active. ${holdout.thresholdSummary}. ${holdout.evidenceSummary ?? ""}`.trim()
        : "Local routing was selected from a reviewed local preference or provider route.",
      nextAction: group.fallbackCount
        ? "Watch fallback and quality before expanding this route further."
        : "Keep collecting quality, latency, and feedback evidence."
    };
  }
  if (group.classification === "local-skipped") {
    return {
      label: "local skipped",
      severity: "warning",
      reason: group.latestReason || "Local routing was requested, but readiness or threshold evidence prevented local execution.",
      nextAction: holdout.approved
        ? "Check the local endpoint/model readiness and rerun the low-risk route smoke."
        : "Capture and approve passing holdout results before expecting local selection."
    };
  }
  if (group.classification === "hosted-fallback") {
    return {
      label: "hosted fallback",
      severity: "warning",
      reason: group.latestReason || "Hosted fallback was used after local or candidate routing could not complete.",
      nextAction: "Inspect route receipts, local endpoint health, and fallback thresholds before raising local routing scope."
    };
  }
  return {
    label: "hosted selected",
    severity: "info",
    reason: group.latestReason || "Hosted provider remained the selected route for this stage.",
    nextAction: holdout.status === "needs-promotion"
      ? "Approve low-risk local routing if holdout evidence is acceptable."
      : "Keep hosted routing unless cost, quality, and holdout evidence recommend a local trial."
  };
}

export function renderLocalHoldoutRoutingStatusHtml(status: DashboardLocalHoldoutRoutingStatus): string {
  const statusClass = status.status === "active" || status.status === "approved"
    ? "completed"
    : status.status === "error" || status.status === "blocked"
      ? "failed"
      : "queued";
  const evidenceSuites = status.evidenceSuites.length ? status.evidenceSuites.join(", ") : "none";
  const promotableSuites = status.promotableSuites.length ? status.promotableSuites.join(", ") : "none";
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Local Holdout Routing</h2>
          <span class="muted">Reviewed local LLM promotion state and hosted fallback posture.</span>
        </div>
        <span class="status ${statusClass}">${escapeHtml(status.status)}</span>
      </div>
      <div class="metric-grid">
        ${metricCard("Results", status.resultsExists ? status.resultsDecision ?? "present" : "missing", status.resultsPath)}
        ${metricCard("Promotion", status.promotionExists ? status.promotionStatus ?? "present" : "missing", status.promotionPath)}
        ${metricCard("Approved", status.approved ? "yes" : "no", status.maxRisk ? `max risk ${status.maxRisk}` : "approval gate")}
        ${metricCard("Thresholds", status.thresholdSummary ?? "missing", "promotion gate")}
        ${metricCard("Holdout Evidence", status.evidenceSummary ?? "missing", "captured result")}
        ${metricCard("Local Routed", status.localStageCount, "recent local/BYO stages")}
        ${metricCard("Hosted Routed", status.hostedStageCount, "recent hosted stages")}
        ${metricCard("Local Fallback", status.localFallbackRate === null ? "n/a" : status.localFallbackRate, "recent local/BYO fallback rate")}
      </div>
      <div class="meta-grid compact">
        <div><strong>Evidence Suites</strong>${escapeHtml(evidenceSuites)}</div>
        <div><strong>Promotable Suites</strong>${escapeHtml(promotableSuites)}</div>
        <div><strong>Fallback Boundary</strong>${escapeHtml(status.hostedFallbackBoundary)}</div>
        <div><strong>Recommendation</strong>${escapeHtml(status.recommendation)}</div>
      </div>
      ${status.error ? `<p class="error">${escapeHtml(status.error)}</p>` : ""}
    </section>
  `;
}

export function renderLocalRouteDecisionDrilldownHtml(
  trends: DashboardRouteReceiptTrendReport,
  holdout: DashboardLocalHoldoutRoutingStatus
): string {
  const rows = trends.topGroups.map((group) => {
    const explanation = localRouteDecisionExplanation(group, holdout);
    return `
      <tr>
        <td>${escapeHtml(group.workflowId)}<br><span class="muted">${escapeHtml(group.stageId)} / ${escapeHtml(group.agentId)}</span></td>
        <td><span class="flag ${explanation.severity === "good" ? "good" : explanation.severity === "warning" ? "warn" : "queued"}">${escapeHtml(explanation.label)}</span></td>
        <td>${escapeHtml(group.providerId)} / ${escapeHtml(group.modelTier)}<br><span class="muted">${formatNumber(group.runs)} receipt(s)</span></td>
        <td>${group.averageQuality ?? "n/a"}<br><span class="muted">${group.averageLatencyMs === null ? "latency n/a" : `${formatNumber(group.averageLatencyMs)}ms avg`}</span></td>
        <td>${group.fallbackCount}<br><span class="muted">${group.runs ? Number((group.fallbackCount / group.runs).toFixed(2)) : 0} fallback rate</span></td>
        <td><span>${escapeHtml(truncateText(explanation.reason, 220))}</span>${explanation.reason.length > 220 ? `<details class="run-task-details"><summary>View rationale</summary><div>${escapeHtml(truncateText(explanation.reason, 1200))}</div></details>` : ""}<strong>Next:</strong> ${escapeHtml(explanation.nextAction)}</td>
        <td>${routeDecisionFeedbackForm(trends.projectRootUri, group)}</td>
      </tr>
    `;
  }).join("");
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Local Route Decision Drilldown</h2>
          <span class="muted">Why recent stages selected local, skipped local, or used hosted fallback.</span>
        </div>
        <span class="status ${holdout.approved ? "completed" : "queued"}">${holdout.approved ? "holdout approved" : holdout.status}</span>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Stage</th><th>Decision</th><th>Route</th><th>Quality/Latency</th><th>Fallback</th><th>Reason / Next Action</th><th>Feedback</th></tr></thead><tbody>${rows || "<tr><td colspan=\"7\">No recent route receipts are available yet.</td></tr>"}</tbody></table></div>
    </section>
  `;
}

export function renderRouteReceiptTrendsHtml(report: DashboardRouteReceiptTrendReport): string {
  const rows = report.topGroups.map((group) => `
    <tr>
      <td>${escapeHtml(group.workflowId)}<br><span class="muted">${escapeHtml(group.stageId)} / ${escapeHtml(group.agentId)}</span></td>
      <td><span class="flag ${group.classification === "local-selected" ? "good" : group.classification === "local-skipped" || group.classification === "hosted-fallback" ? "warn" : "queued"}">${escapeHtml(group.classification.replace(/-/g, " "))}</span></td>
      <td>${escapeHtml(group.providerId)} / ${escapeHtml(group.modelTier)}</td>
      <td>${formatNumber(group.runs)}</td>
      <td>${formatNumber(group.fallbackCount)}</td>
      <td>${group.averageQuality ?? "n/a"}</td>
      <td>${group.averageLatencyMs === null ? "n/a" : `${formatNumber(group.averageLatencyMs)}ms`}</td>
      <td>${escapeHtml(truncateText(group.latestReason || "no route reason recorded", 180))}</td>
    </tr>
  `).join("");
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Route Receipt Trends</h2>
          <span class="muted">Recent model_route receipts grouped by local selection, skipped local preference, and fallback behavior.</span>
        </div>
        <span class="flag ${report.totalReceipts ? "good" : "warn"}">${formatNumber(report.totalReceipts)} receipts</span>
      </div>
      <div class="metric-grid">
        ${metricCard("Reports", report.reportsAnalyzed, "recent runs with quality data")}
        ${metricCard("Local Selected", report.localSelected, "approved local holdout route")}
        ${metricCard("Local Skipped", report.localSkipped, "local preference present but unavailable")}
        ${metricCard("Hosted Fallback", report.hostedFallback, "provider retry receipts")}
        ${metricCard("Hosted Selected", report.hostedSelected, "normal hosted or default route")}
        ${metricCard("Selection Rate", report.localSelectionRate === null ? "n/a" : report.localSelectionRate, "local-selected / all receipts")}
        ${metricCard("Fallback Rate", report.fallbackRate === null ? "n/a" : report.fallbackRate, "fallbacks / all receipts")}
      </div>
      <div class="table-wrap"><table><thead><tr><th>Workflow</th><th>Class</th><th>Provider/Tier</th><th>Runs</th><th>Fallbacks</th><th>Quality</th><th>Latency</th><th>Latest Reason</th></tr></thead><tbody>${rows || "<tr><td colspan=\"8\">No route receipts found in the inspected run window.</td></tr>"}</tbody></table></div>
    </section>
  `;
}

export function routeDecisionFeedbackForm(projectDir: string, group: DashboardRouteReceiptTrendGroup): string {
  const returnTo = `/model-improvement?project=${encodeURIComponent(projectDir)}&limit=50`;
  const commonInputs = [
    ["returnTo", returnTo],
    ["project", projectDir],
    ["action", "route-feedback"],
    ["workflowId", group.workflowId],
    ["stageId", group.stageId],
    ["agentId", group.agentId],
    ["providerId", group.providerId],
    ["modelTier", group.modelTier],
    ["routeClass", group.classification],
    ["runs", String(group.runs)],
    ["fallbackCount", String(group.fallbackCount)],
    ["averageQuality", group.averageQuality === null ? "" : String(group.averageQuality)],
    ["averageLatencyMs", group.averageLatencyMs === null ? "" : String(group.averageLatencyMs)]
  ].map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join("");
  return `<form class="feedback-form route-feedback-form" method="post" action="/api/follow-up">
    ${commonInputs}
    <input name="note" aria-label="Route feedback note" placeholder="optional note">
    <div class="button-row compact">
      <button type="submit" name="rating" value="helpful">${iconLabel("check", "Helpful")}</button>
      <button type="submit" name="rating" value="costly">${iconLabel("warning", "Costly")}</button>
      <button type="submit" name="rating" value="neutral" class="secondary">${iconLabel("message", "Neutral")}</button>
    </div>
  </form>`;
}
