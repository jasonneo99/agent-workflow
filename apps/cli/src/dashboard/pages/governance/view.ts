import { formatNumber } from "../../ui/format.js";
import { escapeHtml, dashboardNav, renderDashboardFlash, renderDashboardActionHistory, renderDashboardDateTime, dashboardReturnInput } from "../../ui/layout.js";
import type { DashboardProjectSummary, DashboardRoleAuditExportSummary, DashboardRoleGovernanceReport } from "../../../lib/cli-types.js";
import { uniqueSorted } from "../../../lib/builders-learning.js";
import { type GovernanceReport, buildGovernanceReport } from "../../../../../../packages/governance/src/index.js";
import { dashboardCss } from "../../styles.js";
import type { DashboardRoleAuditViewResult } from "../../../commands/daemon-types.js";

export function filterGovernanceReport(report: GovernanceReport, params: URLSearchParams): GovernanceReport {
  const health = params.get("health");
  const provider = params.get("provider");
  const profile = params.get("policyProfile");
  const projects = report.projects.filter((project) =>
    (!health || health === "all" || project.health === health) &&
    (!provider || project.provider === provider) &&
    (!profile || project.policyProfile === profile)
  );
  return buildGovernanceReport(report.bundleVersion, report.servicesReady, projects, report.configuredProvider, report.definitionsReady);
}

export function renderDashboardRoleAuditView(result: DashboardRoleAuditViewResult): string {
  const backHref = result.projectDir ? `/roles?project=${encodeURIComponent(result.projectDir)}` : "/roles";
  const body = result.ok
    ? `<div class="topbar"><div><a href="${escapeHtml(backHref)}">Roles</a><h1>Role Audit Snapshot</h1><p class="muted">${escapeHtml(result.fileName)}</p></div></div>
      <section class="panel"><div class="meta-grid compact">
        <div><strong>Project</strong>${escapeHtml(result.summary?.projectPath ?? result.projectDir ?? "all registered projects")}</div>
        <div><strong>Markdown</strong>${escapeHtml(result.markdownPath)}</div>
        <div><strong>JSON</strong>${escapeHtml(result.jsonPath ?? "missing")}</div>
        <div><strong>Generated</strong>${result.summary ? renderDashboardDateTime(result.summary.generatedAt) : "unknown"}</div>
        <div><strong>Filters</strong>${escapeHtml(`${result.summary?.role ?? "all"} / ${result.summary?.status ?? "all"} / ${result.summary?.actionType ?? "all"}`)}</div>
        <div><strong>Approvals</strong>${formatNumber(result.summary?.approvalCount ?? 0)}</div>
      </div></section>
      <section class="panel"><h2>Snapshot Markdown</h2><pre class="markdown-view">${escapeHtml(result.markdown)}</pre></section>`
    : `<div class="topbar"><div><a href="${escapeHtml(backHref)}">Roles</a><h1>Role Audit Snapshot</h1><p class="muted">Unable to open the requested export.</p></div></div><section class="panel warn-panel"><pre>${escapeHtml(result.error)}</pre></section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Role Audit Snapshot</title><style>${dashboardCss()}</style></head><body>${dashboardNav("roles")}<main id="main-content">${body}</main></body></html>`;
}

export function renderGovernanceHtml(report: GovernanceReport, params: URLSearchParams): string {
  const providers = [...new Set(report.projects.map((project) => project.provider))].sort();
  const profiles = [...new Set(report.projects.map((project) => project.policyProfile))].sort();
  const rows = report.projects.map((project) => `
    <tr>
      <td><strong>${escapeHtml(project.name)}</strong><br><span class="muted">${escapeHtml(project.rootUri)}</span></td>
      <td><span class="flag ${project.health === "healthy" ? "good" : project.health === "warning" ? "warn" : "bad"}">${project.health}</span></td>
      <td>${escapeHtml(project.policyProfile)}<br><span class="muted">policy drift: ${project.policyDrift ?? "unknown"}<br>config drift: ${project.configDrift ?? "unknown"}</span></td>
      <td>${escapeHtml(project.provider)}<br><span class="muted">${escapeHtml(project.modelTier ?? "default tier")}</span></td>
      <td>${project.activeRuns} active / ${project.staleActiveRuns} stale<br><span class="muted">${project.failedRuns} failed · ${project.runCount} total</span></td>
      <td>${project.indexedFiles}<br><span class="muted">config: ${project.projectConfig}</span></td>
      <td>${renderGovernanceProjectActionHtml(project)}</td>
    </tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Governance</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("governance")}
  <main id="main-content"><div class="topbar"><div><a href="/">Dashboard</a><h1>Multi-project Governance</h1><p class="muted">Read-only project health, policy drift, provider, queue, and remediation inspection.</p></div><a class="button secondary" href="/api/governance?${escapeHtml(params.toString())}">JSON</a></div>
  ${renderDashboardFlash(params)}
  ${renderDashboardActionHistory()}
  <section class="panel"><div class="meta-grid"><div><strong>Healthy</strong>${report.counts.healthy}</div><div><strong>Warning</strong>${report.counts.warning}</div><div><strong>Critical</strong>${report.counts.critical}</div><div><strong>Services</strong>${report.servicesReady ? "ready" : "attention"}</div><div><strong>Definitions</strong>${report.definitionsReady ? "ready" : "attention"}</div><div><strong>Configured Provider</strong>${escapeHtml(report.configuredProvider)}</div></div>
  <form method="get" class="form-grid"><label>Health<select name="health"><option value="all">all</option>${["healthy", "warning", "critical"].map((value) => `<option${params.get("health") === value ? " selected" : ""}>${value}</option>`).join("")}</select></label><label>Provider<select name="provider"><option value="">all</option>${providers.map((value) => `<option${params.get("provider") === value ? " selected" : ""}>${escapeHtml(value)}</option>`).join("")}</select></label><label>Policy profile<select name="policyProfile"><option value="">all</option>${profiles.map((value) => `<option${params.get("policyProfile") === value ? " selected" : ""}>${escapeHtml(value)}</option>`).join("")}</select></label><div class="form-actions"><button type="submit">Filter</button></div></form></section>
  <section class="panel"><div class="table-wrap"><table><thead><tr><th>Project</th><th>Health</th><th>Policy</th><th>Provider</th><th>Runs</th><th>Context</th><th>Recommended action</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No projects match these filters.</td></tr>'}</tbody></table></div></section></main></body></html>`;
}

export function renderGovernanceProjectActionHtml(project: GovernanceReport["projects"][number]): string {
  const failingChecks = project.healthChecks.filter((check) => check.status === "warning" || check.status === "critical");
  const summary = failingChecks.length
    ? `${failingChecks.length} health check${failingChecks.length === 1 ? "" : "s"} need attention`
    : "All governance checks are clean";
  const checks = (failingChecks.length ? failingChecks : project.healthChecks).map((check) => `
    <li>
      <span class="flag ${check.status === "pass" ? "good" : check.status === "warning" ? "warn" : check.status === "critical" ? "bad" : ""}">${escapeHtml(check.status)}</span>
      <strong>${escapeHtml(check.label)}</strong>
      <span>${escapeHtml(check.evidence)}</span>
      ${check.recommendation ? `<small>${escapeHtml(check.recommendation)}</small>` : ""}
      ${check.command ? `<code>${escapeHtml(check.command)}</code>` : ""}
    </li>
  `).join("");
  return `
    ${project.recommendations.length ? `<ul>${project.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : '<span class="flag good">No action</span>'}
    <details class="governance-details">
      <summary>${escapeHtml(summary)}</summary>
      <ul>${checks}</ul>
    </details>
  `;
}

export function renderRecentRoleAuditExportsHtml(exports: DashboardRoleAuditExportSummary[], projectRootUri: string | null): string {
  const rows = exports.map((item) => `
    <tr>
      <td>${renderDashboardDateTime(item.generatedAt)}</td>
      <td>${escapeHtml(item.projectPath ?? projectRootUri ?? "all registered projects")}</td>
      <td>${escapeHtml(item.role ?? "all")} / ${escapeHtml(item.status)} / ${escapeHtml(item.actionType ?? "all")}</td>
      <td>${formatNumber(item.approvalCount)}</td>
      <td>${formatNumber(item.projectCount)}</td>
      <td>${item.markdownPath ? `<a href="${escapeHtml(roleAuditViewerHref(item.projectPath ?? projectRootUri, item.fileName))}">View</a><br><code>${escapeHtml(item.markdownPath)}</code>` : "<code>missing</code>"}</td>
      <td><code>${escapeHtml(item.jsonPath)}</code></td>
    </tr>
  `).join("") || '<tr><td colspan="7">No role audit snapshots yet. Use Export Snapshot to save the current filters locally.</td></tr>';
  return `<section class="panel">
    <div class="section-heading">
      <div>
        <h2>Recent Role Audit Snapshots</h2>
        <span class="muted">Local Markdown and JSON snapshots created from the active role filters.</span>
      </div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Generated</th><th>Project</th><th>Filters</th><th>Approvals</th><th>Projects</th><th>Markdown</th><th>JSON</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

export function renderRolesHtml(report: DashboardRoleGovernanceReport, projects: DashboardProjectSummary[], params: URLSearchParams): string {
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}"${report.projectRootUri === project.rootUri ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  const roleOptions = uniqueSorted([
    ...report.projects.flatMap((project) => project.roles.map((role) => role.id)),
    "pending",
    "unrecorded"
  ]).map((role) => `<option value="${escapeHtml(role)}"${report.filters.role === role ? " selected" : ""}>${escapeHtml(role)}</option>`).join("");
  const statusOptions = uniqueSorted(["all", "pending", "approved", "rejected", "executed", "failed", ...Object.keys(report.statusCounts)])
    .map((status) => `<option value="${escapeHtml(status)}"${report.filters.status === status ? " selected" : ""}>${escapeHtml(status)}</option>`)
    .join("");
  const actionOptions = uniqueSorted([
    "local_command",
    "file_write",
    "artifact_archive",
    "artifact_restore",
    "artifact_prune",
    "object_mirror",
    "deployment",
    "autonomy",
    ...Object.keys(report.actionCounts)
  ])
    .map((action) => `<option value="${escapeHtml(action)}"${report.filters.actionType === action ? " selected" : ""}>${escapeHtml(action)}</option>`)
    .join("");
  const roleRows = report.projects.flatMap((project) => project.roles.map((role) => `
    <tr>
      <td><strong>${escapeHtml(role.id)}</strong>${project.defaultActorRole === role.id ? ' <span class="flag good">default</span>' : ""}<br><span class="muted">${escapeHtml(role.description || "No description")}</span></td>
      <td>${escapeHtml(project.name)}<br><span class="muted">${escapeHtml(project.rootUri)}</span></td>
      <td><span class="flag ${project.enforcement === "enforce" ? "warn" : "good"}">${project.enforcement}</span><br><span class="muted">separation: ${project.separationOfDuties}<br>config: ${project.configStatus}</span></td>
      <td><div class="chip-row">${role.capabilities.map((capability) => `<span class="chip">${escapeHtml(capability)}</span>`).join("") || '<span class="muted">No capabilities configured.</span>'}</div></td>
    </tr>`)).join("");
  const decisionRows = report.decisionsByRole.map((role) => `
    <tr>
      <td><strong>${escapeHtml(role.role)}</strong></td>
      <td>${role.total}</td>
      <td>${role.pending}</td>
      <td>${role.approved}</td>
      <td>${role.rejected}</td>
      <td>${role.executed}</td>
      <td>${role.failed}</td>
    </tr>`).join("");
  const approvalRows = report.recentApprovals.map((approval) => `
    <tr>
      <td><span class="status ${escapeHtml(approval.status)}">${escapeHtml(approval.status)}</span></td>
      <td><strong>${escapeHtml(approval.actionType)}</strong><br><span class="muted">${escapeHtml(approval.target)}</span></td>
      <td>${escapeHtml(approval.decidedRole ?? (approval.status === "pending" ? "pending" : "unrecorded"))}<br><span class="muted">${escapeHtml(approval.decidedBy ?? "not decided")}</span></td>
      <td>${escapeHtml(approval.executedRole ?? "not executed")}<br><span class="muted">${escapeHtml(approval.executedBy ?? "not executed")}</span></td>
      <td>${escapeHtml(approval.projectName)}<br><span class="muted">${escapeHtml(approval.workflowId)} / ${escapeHtml(approval.stageId)}</span></td>
      <td>${renderDashboardDateTime(approval.updatedAt)}</td>
    </tr>`).join("");
  const filters = `<form method="get" class="form-grid">
    <label>Project<select name="project"><option value="">all registered projects</option>${projectOptions}</select></label>
    <label>Role<select name="role"><option value="">all roles</option>${roleOptions}</select></label>
    <label>Status<select name="status">${statusOptions}</select></label>
    <label>Action<select name="action"><option value="">all actions</option>${actionOptions}</select></label>
    <label>Recent approvals<input name="limit" inputmode="numeric" value="${escapeHtml(String(report.limit))}"></label>
    <div class="form-actions"><button type="submit">Filter</button></div>
  </form>`;
  const exportForm = `<form method="post" action="/api/role-audit-export" class="inline-form">
    ${dashboardReturnInput("/roles", params)}
    <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri ?? "")}">
    <input type="hidden" name="role" value="${escapeHtml(report.filters.role ?? "")}">
    <input type="hidden" name="status" value="${escapeHtml(report.filters.status)}">
    <input type="hidden" name="action" value="${escapeHtml(report.filters.actionType ?? "")}">
    <input type="hidden" name="limit" value="${escapeHtml(String(report.limit))}">
    <button type="submit">Export Snapshot</button>
  </form>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Roles</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("roles")}
  <main id="main-content"><div class="topbar"><div><a href="/">Dashboard</a><h1>Roles & Decisions</h1><p class="muted">Read-only team role configuration and recent approval decisions by recorded actor role.</p></div><div class="actions"><a class="button secondary" href="/api/roles?${escapeHtml(params.toString())}">JSON</a>${exportForm}</div></div>
  ${renderDashboardFlash(params)}
  ${renderDashboardActionHistory()}
  <section class="panel">${filters}<div class="meta-grid"><div><strong>Projects</strong>${report.projects.length}</div><div><strong>Recent approvals</strong>${report.recentApprovals.length}</div><div><strong>Recorded roles</strong>${report.decisionsByRole.length}</div><div><strong>Pending approvals</strong>${report.statusCounts.pending ?? 0}</div></div></section>
  ${renderRecentRoleAuditExportsHtml(report.recentRoleAuditExports, report.projectRootUri)}
  <section class="panel"><div class="section-heading"><div><h2>Configured Roles</h2><span class="muted">Project-local roles from .agent-workflow/project.yaml, falling back to stored config when the path is unavailable.</span></div></div><div class="table-wrap"><table><thead><tr><th>Role</th><th>Project</th><th>Mode</th><th>Capabilities</th></tr></thead><tbody>${roleRows || '<tr><td colspan="4">No project roles found.</td></tr>'}</tbody></table></div></section>
  <section class="panel"><div class="section-heading"><div><h2>Recent Decisions By Role</h2><span class="muted">Pending and older unrecorded decisions are separated so migration gaps stay visible.</span></div></div><div class="table-wrap"><table><thead><tr><th>Role</th><th>Total</th><th>Pending</th><th>Approved</th><th>Rejected</th><th>Executed</th><th>Failed</th></tr></thead><tbody>${decisionRows || '<tr><td colspan="7">No recent approvals found.</td></tr>'}</tbody></table></div></section>
  <section class="panel"><div class="section-heading"><div><h2>Recent Approval Activity</h2><span class="muted">Latest approval rows used by the role summary.</span></div></div><div class="table-wrap"><table><thead><tr><th>Status</th><th>Action</th><th>Decision Role</th><th>Execution Role</th><th>Project</th><th>Updated</th></tr></thead><tbody>${approvalRows || '<tr><td colspan="6">No recent approval activity found.</td></tr>'}</tbody></table></div></section></main></body></html>`;
}

export function roleAuditViewerHref(project: string | null, fileName: string): string {
  const query = new URLSearchParams({ file: fileName });
  if (project) query.set("project", project);
  return `/role-audit?${query.toString()}`;
}
