import { escapeHtml, dashboardNav, metricCard } from "../../ui/layout.js";
import type { DashboardProjectSummary } from "../../../lib/cli-types.js";
import { loadContextOperatorReport } from "../../../lib/builders-context.js";
import { dashboardCss } from "../../styles.js";

export function renderContextGatewayHtml(report: Awaited<ReturnType<typeof loadContextOperatorReport>>, projects: DashboardProjectSummary[], selected: string): string {
  const options = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}"${project.rootUri === selected ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  const plans = report.codegen.plans.map((plan) => `<tr><td>${escapeHtml(plan.id)}</td><td>${escapeHtml(plan.target)}</td><td>${escapeHtml(plan.status)}</td><td><code>${escapeHtml(plan.receipt)}</code></td></tr>`).join("") || `<tr><td colspan="4">No governed generation plans.</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Context Gateway</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("context-gateway")}
  <main id="main-content"><header><div><p class="eyebrow">Optimize</p><h1>Context Gateway</h1><p>Body-free operating evidence, readiness gates, and review queues.</p></div></header>
  <section class="panel"><form method="get" action="/context-gateway"><label>Project<select name="project">${options}</select></label><button type="submit">Inspect</button></form></section>
  <section class="metrics">
    ${metricCard("Projected Savings", `${report.efficiency.projectedSavingsPercent}%`, `${report.efficiency.projectedFrontierTokensAvoided} frontier tokens avoided`)}
    ${metricCard("Evidence", report.efficiency.observations, `${report.efficiency.eligibleReads} eligible reads`)}
    ${metricCard("Cache Health", `${report.cache.validEntries}/${report.cache.entries}`, `${report.cache.bytes} bytes; ${report.cache.expiredEntries} expired`)}
    ${metricCard("Pending Review", report.codegen.awaitingReview, `${report.codegen.total} generation plans`)}
  </section>
  <section class="grid two"><article class="panel"><h2>Readiness</h2><dl><dt>Policy</dt><dd>${escapeHtml(report.policyMode)}</dd><dt>Holdout approved</dt><dd>${report.holdoutApproved ? "yes" : "no"}</dd><dt>Claude Code</dt><dd>${report.hosts.claude ? "installed" : "not installed"}</dd><dt>Cursor</dt><dd>${report.hosts.cursor ? "installed" : "not installed"}</dd><dt>Codex</dt><dd>${report.hosts.codex ? "installed" : "not installed"}</dd></dl></article>
  <article class="panel"><h2>Calibration</h2>${report.calibration ? `<p><strong>${escapeHtml(report.calibration.corpus)}</strong></p><p>${report.calibration.cases} cases · quality ${(report.calibration.qualityPassRate * 100).toFixed(1)}% · citations ${(report.calibration.citationPassRate * 100).toFixed(1)}% · savings ${report.calibration.tokenSavingsPercent}%</p><p>Regression ${report.calibration.regression.passed ? "passed" : "failed"}; enforcement ${report.calibration.enforcementReady ? "ready" : "not ready"}.</p>` : "<p>No repository calibration evidence yet.</p>"}</article></section>
  <section class="panel"><h2>Governed generation plans</h2><table><thead><tr><th>ID</th><th>Target</th><th>Status</th><th>Receipt</th></tr></thead><tbody>${plans}</tbody></table></section>
  <section class="panel"><h2>Safe actions</h2><p>Use <code>context-host-setup</code> without <code>--write</code> to preview hooks, and <code>context-calibrate</code> to write evidence. Threshold proposals remain review-required and never modify policy automatically.</p><p><a href="/api/context-gateway?project=${encodeURIComponent(selected)}">JSON status</a></p></section>
  </main></body></html>`;
}
