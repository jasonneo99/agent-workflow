import { titleCase } from "../../ui/format.js";
import { escapeHtml, dashboardNav, renderDashboardDateTime, metricCard } from "../../ui/layout.js";
import { pageOf, pagerHtml } from "../../paging.js";
import type { DashboardProjectSummary } from "../../../lib/cli-types.js";
import { formatInlineCounts } from "../../../lib/builders-shared.js";
import { dashboardCss } from "../../styles.js";
import type { UnifiedActivityReport } from "../../../commands/daemon-types.js";

export function renderUnifiedActivityHtml(report: UnifiedActivityReport, projects: DashboardProjectSummary[], params: URLSearchParams): string {
  const option = (value: string, label: string, selected: string | null) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const projectOptions = projects.map((project) => option(project.rootUri, project.name, report.filters.project)).join("");
  const categoryOptions = ["workflow", "stage", "action", "approval", "learning", "daemon", "roadmap", "server"].map((value) => option(value, titleCase(value), report.filters.category)).join("");
  const severityOptions = ["info", "warning", "error"].map((value) => option(value, titleCase(value), report.filters.severity)).join("");
  const eventPage = pageOf(report.events, params, 50);
  const rows = eventPage.items.map((event) => `<tr>
    <td>${renderDashboardDateTime(event.occurredAt)}<br><span class="muted">${escapeHtml(event.occurredAt)}</span></td>
    <td><span class="status ${event.severity === "error" ? "failed" : event.severity === "warning" ? "blocked" : "completed"}">${escapeHtml(event.severity)}</span><br><span class="muted">${escapeHtml(event.category)}</span></td>
    <td>${event.href ? `<a href="${escapeHtml(event.href)}"><strong>${escapeHtml(event.title)}</strong></a>` : `<strong>${escapeHtml(event.title)}</strong>`}<br><span class="muted">${escapeHtml(event.eventType)} · ${escapeHtml(event.source)}</span></td>
    <td>${escapeHtml(event.projectName)}${event.runId ? `<br><a class="muted" href="/run?id=${encodeURIComponent(event.runId)}">run ${escapeHtml(event.runId.slice(0, 8))}</a>` : ""}</td>
    <td><span class="status ${escapeHtml(event.status)}">${escapeHtml(event.status)}</span>${event.actor ? `<br><span class="muted">${escapeHtml(event.actor)}</span>` : ""}</td>
    <td>${escapeHtml(event.detail)}</td>
  </tr>`).join("");
  const jsonQuery = params.toString();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Activity</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("activity")}
  <main id="main-content"><header><div><p class="eyebrow">Audit</p><h1>Activity</h1><p>One chronological, redacted view of workflow, action, approval, daemon, roadmap, learning, and server events.</p></div><div class="actions"><a class="button secondary" href="/api/activity${jsonQuery ? `?${escapeHtml(jsonQuery)}` : ""}">JSON</a><a class="button secondary" href="/activity">Reset</a></div></header>
  <section class="panel"><form class="workflow-form" method="get" action="/activity">
    <label>Project<select name="project"><option value="">All projects</option>${projectOptions}</select></label>
    <label>Category<select name="category"><option value="">All categories</option>${categoryOptions}</select></label>
    <label>Severity<select name="severity"><option value="">All severities</option>${severityOptions}</select></label>
    <label>Status<input name="status" value="${escapeHtml(report.filters.status ?? "")}" placeholder="blocked, completed…"></label>
    <label class="wide">Search<input name="q" value="${escapeHtml(report.filters.query ?? "")}" placeholder="event, actor, project, or detail"></label>
    <label>Limit<input type="number" name="limit" min="1" max="1000" value="${report.filters.limit}"></label>
    <div class="form-actions"><button type="submit">Apply Filters</button></div>
  </form></section>
  <section class="metrics">
    ${metricCard("Events", report.counts.returned, "latest matching events")}
    ${metricCard("Warnings", report.counts.bySeverity.warning ?? 0, "attention events")}
    ${metricCard("Errors", report.counts.bySeverity.error ?? 0, "failed or rejected events")}
    ${metricCard("Sources", Object.keys(report.counts.byCategory).length, formatInlineCounts(report.counts.byCategory))}
  </section>
  <section class="panel"><div class="section-heading"><div><h2>Unified Timeline</h2><span class="muted">Newest first · generated ${renderDashboardDateTime(report.generatedAt)}</span></div></div>${pagerHtml("/activity", params, eventPage, "Timeline")}<div class="table-wrap"><table><thead><tr><th>When</th><th>Level</th><th>Event</th><th>Project / Run</th><th>Status / Actor</th><th>Detail</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No activity matches these filters.</td></tr>'}</tbody></table></div>${pagerHtml("/activity", params, eventPage, "Timeline")}</section>
  <section class="panel"><h2>Coverage and privacy</h2><ul>${report.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul></section>
  </main></body></html>`;
}
