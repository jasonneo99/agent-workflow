import { renderMobileApprovalCard, formatApprovalPayload, approvalExecuteForm, approvalDismissForm } from "../../ui/approval-components.js";
import { renderRunInfoDialog } from "../../ui/run-actions.js";
import { titleCase, formatNumber, truncateMiddle } from "../../ui/format.js";
import { escapeHtml, dashboardNav, iconLabel, renderDashboardFlash, renderDashboardActionHistory, renderDashboardDateTime, metricCard } from "../../ui/layout.js";
import type { ApprovalBacklogCategory, ApprovalBacklogItem, ApprovalBacklogReport, DashboardActionApproval, DashboardApprovalRuleSummary, DashboardProjectSummary } from "../../../lib/cli-types.js";
import { approvalOneLineSummary, approvalRuleBroadTarget, approvalRuleDisplayTarget, approvalRuleExactTarget, loadProjectApprovalRules, parseApprovalAutopilotRisk, rolePreviewForApproval } from "../../../lib/builders-approvals.js";
import { formatBytes, isDismissedApproval, isExecutableApprovalAction, isOpenApproval, truncateText } from "../../../lib/builders-shared.js";
import { projectConfigSchema } from "../../../../../../packages/agent-registry/src/schemas.js";
import { globalTrustedCommandsPath, loadGlobalTrustedCommands } from "../../../../../../packages/agent-registry/src/trusted-commands.js";
import { listActionApprovals, listProjectStorageSummaries } from "../../../../../../packages/storage/src/postgres.js";
import { dashboardCss } from "../../styles.js";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { DashboardTrustedCommandSummary } from "../../../commands/daemon-types.js";

export function approvalApprovedActionForms(approvalId: string): string {
  return `<div class="actions">${approvalExecuteForm(approvalId)}${approvalDismissForm(approvalId)}</div>`;
}

export function approvalBacklogCategoryHint(category: ApprovalBacklogCategory): string {
  switch (category) {
    case "missing_tool":
      return "Install dependency, then retry.";
    case "resolved_missing_tool":
      return "Dependency is now available.";
    case "command_failed":
      return "Fix command/input, then retry or dismiss.";
    case "ready_to_execute":
      return "Execute or autopilot can clear.";
    case "stale_review":
      return "Refresh evidence or dismiss.";
    case "manual_decision":
      return "Decision recorded, no local execution.";
    case "historical_info":
      return "Audit trail, no action.";
    case "needs_review":
      return "Choose the next action.";
  }
}

export function approvalBacklogCategoryLabel(category: ApprovalBacklogCategory): string {
  switch (category) {
    case "missing_tool":
      return "Missing Tool";
    case "resolved_missing_tool":
      return "Tool Available";
    case "command_failed":
      return "Command Failed";
    case "ready_to_execute":
      return "Ready To Execute";
    case "stale_review":
      return "Stale Review";
    case "manual_decision":
      return "Manual Decision";
    case "historical_info":
      return "Historical Info";
    case "needs_review":
      return "Needs Review";
  }
}

export function approvalBacklogTriageOrder(): ApprovalBacklogCategory[] {
  return ["missing_tool", "resolved_missing_tool", "command_failed", "ready_to_execute", "stale_review", "manual_decision", "needs_review", "historical_info"];
}

export function approvalDecisionForms(approval: Awaited<ReturnType<typeof listActionApprovals>>[number]): string {
  const approvalId = approval.id;
  const executable = isExecutableApprovalAction(approval.actionType);
  // One note serves every decision; the pressed button supplies the decision.
  return `<div class="actions">
    <form class="approval-form" method="post" action="/api/approval-action">
      <input type="hidden" name="approvalId" value="${escapeHtml(approvalId)}">
      <input type="hidden" name="actorRole" value="approver">
      <label class="approval-note-label">Note <input name="note" aria-label="Decision note" placeholder="Optional, saved with your decision"></label>
      <button type="submit" name="decision" value="${executable ? "approve_execute" : "approved"}">${executable ? "Approve and continue" : "Approve"}</button>
      ${executable ? `<button class="secondary" type="submit" name="decision" value="approved">Approve Only</button>` : ""}
      <button class="danger" type="submit" name="decision" value="rejected">Reject</button>
    </form>
    ${approvalRuleForms(approval)}
  </div>`;
}

export function approvalFailedActionForms(approvalId: string, note: string): string {
  return `<div class="actions">
    <p class="muted">${escapeHtml(truncateText(humanizeApprovalFailureText(note), 220))}</p>
    <form class="approval-form" method="post" action="/api/approval-action">
      <input type="hidden" name="approvalId" value="${escapeHtml(approvalId)}">
      <input type="hidden" name="decision" value="execute">
      <input type="hidden" name="actorRole" value="operator">
      <button type="submit">${iconLabel("refresh", "Retry")}</button>
    </form>
    ${approvalDismissForm(approvalId)}
  </div>`;
}

export function approvalOneLineSummaryFromBacklog(item: ApprovalBacklogItem): string {
  return `${item.actionType} ${truncateMiddle(item.target, 120)}`;
}

export function approvalRuleForms(approval: Awaited<ReturnType<typeof listActionApprovals>>[number]): string {
  if (approval.actionType !== "local_command" && approval.actionType !== "file_write") {
    return "";
  }
  const exact = approvalRuleExactTarget(approval);
  const broad = approvalRuleBroadTarget(approval);
  const exactDisplay = approvalRuleDisplayTarget(approval, exact);
  const broadDisplay = approvalRuleDisplayTarget(approval, broad);
  const exactLabel = approval.actionType === "local_command" ? "Always shell" : "Always fswrite";
  const broadLabel = approval.actionType === "local_command" ? "Always shell prefix *" : "Always fswrite*";
  return `
    <form class="approval-form approval-rule-form" method="post" action="/api/approval-rule-action">
      <input type="hidden" name="approvalId" value="${escapeHtml(approval.id)}">
      <input type="hidden" name="actorRole" value="approver">
      <input type="hidden" name="target" value="${escapeHtml(exact)}">
      <input type="hidden" name="approveCurrent" value="on">
      <input name="note" aria-label="Rule note" value="Always approve ${escapeHtml(exactDisplay)}">
      <button class="secondary" type="submit" title="${escapeHtml(exactDisplay)}">${escapeHtml(exactLabel)}</button>
    </form>
    ${broad && broad !== exact ? `<form class="approval-form approval-rule-form" method="post" action="/api/approval-rule-action">
      <input type="hidden" name="approvalId" value="${escapeHtml(approval.id)}">
      <input type="hidden" name="actorRole" value="approver">
      <input type="hidden" name="target" value="${escapeHtml(broad)}">
      <input type="hidden" name="approveCurrent" value="on">
      <input name="note" aria-label="Rule note" value="Always approve ${escapeHtml(broadDisplay)}">
      <button class="secondary" type="submit" title="${escapeHtml(broadDisplay)}">${escapeHtml(broadLabel)}</button>
    </form>` : ""}`;
}

export function approvalTableRowClass(approval: DashboardActionApproval): string {
  if (approval.status === "executed" || approval.status === "dismissed" || approval.status === "rejected" || isDismissedApproval(approval)) return "approval-row-history";
  if (approval.status === "failed") return "approval-row-failed";
  return "";
}

export function humanizeApprovalFailureText(value: string): string {
  const missing = /spawn\s+([^\s]+)\s+ENOENT/iu.exec(value);
  if (missing) {
    return value.replace(missing[0], `${missing[1]} was not found on PATH`);
  }
  return value.replace(/ENOENT/giu, "missing executable");
}

export function isOpenApprovalBacklogItem(item: ApprovalBacklogItem): boolean {
  return item.status === "pending"
    || (item.status === "approved" && isExecutableApprovalAction(item.actionType))
    || (item.status === "failed" && isExecutableApprovalAction(item.actionType) && item.category !== "historical_info");
}

export async function loadDashboardApprovalRules(projectRootUri?: string): Promise<DashboardApprovalRuleSummary[]> {
  if (projectRootUri) {
    return loadProjectApprovalRules(projectRootUri);
  }
  const projects = await listProjectStorageSummaries(100);
  const rules: DashboardApprovalRuleSummary[] = [];
  for (const project of projects) {
    try {
      rules.push(...await loadProjectApprovalRules(project.rootUri));
    } catch {
      // Ignore projects whose local config is no longer available from this machine.
    }
  }
  return rules;
}

export async function loadDashboardTrustedCommands(projects: DashboardProjectSummary[], projectRootUri?: string): Promise<DashboardTrustedCommandSummary[]> {
  const rows: DashboardTrustedCommandSummary[] = (await loadGlobalTrustedCommands()).map((pattern) => ({
    scope: "global",
    pattern,
    configPath: globalTrustedCommandsPath()
  }));
  const selectedProjects = projectRootUri
    ? projects.filter((project) => path.resolve(project.rootUri) === path.resolve(projectRootUri))
    : projects;
  for (const project of selectedProjects) {
    try {
      const projectRoot = path.resolve(project.rootUri);
      const configPath = path.join(projectRoot, ".agent-workflow", "project.yaml");
      const raw = YAML.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
      const parsed = projectConfigSchema.parse(raw);
      for (const pattern of parsed.actions.allowed_commands) {
        rows.push({ scope: "project", pattern, projectName: parsed.project.name, projectRootUri: projectRoot, configPath });
      }
    } catch {
      // Ignore projects whose local config is no longer available from this machine.
    }
  }
  return rows;
}

export function renderApprovalBacklogPanel(report: ApprovalBacklogReport): string {
  const warningCount = report.severityCounts.warning ?? 0;
  const errorCount = report.severityCounts.error ?? 0;
  const approvedReadyToExecuteCount = report.items.filter((item) => item.status === "approved" && isExecutableApprovalAction(item.actionType) && item.category === "ready_to_execute").length;
  const attentionItems = report.items.filter((item) => item.severity !== "info").slice(0, 12);
  const missingToolFailures = report.items.filter((item) => item.status === "failed" && item.category === "missing_tool" && isExecutableApprovalAction(item.actionType)).length;
  const resolvedMissingToolFailures = report.items.filter((item) => item.status === "failed" && item.category === "resolved_missing_tool" && isExecutableApprovalAction(item.actionType)).length;
  const commandFailures = report.items.filter((item) => item.status === "failed" && item.category === "command_failed" && isExecutableApprovalAction(item.actionType)).length;
  const triageCards = approvalBacklogTriageOrder().map((category) => {
    const count = report.categoryCounts[category] ?? 0;
    return count ? `<div><strong>${escapeHtml(approvalBacklogCategoryLabel(category))}</strong><span>${formatNumber(count)}</span><small>${escapeHtml(approvalBacklogCategoryHint(category))}</small></div>` : "";
  }).join("");
  const rows = attentionItems.map((item) => `
    <tr>
      <td><span class="flag ${item.severity === "error" ? "warn" : "queued"}">${escapeHtml(item.severity)}</span><br><span class="muted">${escapeHtml(item.status)}</span></td>
      <td>${escapeHtml(approvalBacklogCategoryLabel(item.category))}<br><span class="muted">${escapeHtml(item.actionType)}</span><br><span class="muted">${escapeHtml(item.stageId)} / ${escapeHtml(item.agentId)}</span></td>
      <td><code>${escapeHtml(truncateMiddle(item.target, 96))}</code></td>
      <td><a href="/run?id=${encodeURIComponent(item.runId)}">${escapeHtml(item.runId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(item.workflowId)}</span></td>
      <td>${escapeHtml(humanizeApprovalFailureText(item.reason))}${item.autopilotRisk ? `<br><span class="muted">autopilot ${item.autopilotEligible ? "eligible" : "blocked"} / ${escapeHtml(item.autopilotRisk)}</span>` : ""}<br><strong>Next:</strong> ${escapeHtml(item.nextAction)}</td>
    </tr>
  `).join("");
  const radarParams = new URLSearchParams();
  radarParams.set("limit", String(report.limit));
  radarParams.set("staleMinutes", String(report.staleMinutes));
  radarParams.set("status", report.statusFilter ?? "all");
  if (report.projectRootUri) radarParams.set("project", report.projectRootUri);
  const triageHiddenInputs = `
    <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri ?? "")}">
    <input type="hidden" name="limit" value="${escapeHtml(String(report.limit))}">
    <input type="hidden" name="staleMinutes" value="${escapeHtml(String(report.staleMinutes))}">
  `;
  const triageActions = missingToolFailures || resolvedMissingToolFailures || commandFailures
    ? `<div class="approval-triage-actions">
        ${missingToolFailures || resolvedMissingToolFailures ? `<form method="post" action="/api/approval-triage-action">
          ${triageHiddenInputs}
          <input type="hidden" name="action" value="retry-missing-tools">
          <label class="check-row"><input type="checkbox" name="confirmed" required> Retry ${formatNumber(missingToolFailures + resolvedMissingToolFailures)} missing-tool failure${missingToolFailures + resolvedMissingToolFailures === 1 ? "" : "s"}</label>
          <button type="submit">${iconLabel("refresh", "Retry Missing Tools")}</button>
        </form>` : ""}
        ${commandFailures ? `<form method="post" action="/api/approval-triage-action">
          ${triageHiddenInputs}
          <input type="hidden" name="action" value="dismiss-command-failures">
          <label class="check-row"><input type="checkbox" name="confirmed" required> Dismiss ${formatNumber(commandFailures)} reviewed command failure${commandFailures === 1 ? "" : "s"}</label>
          <button class="secondary" type="submit">${iconLabel("trash", "Dismiss Reviewed Failures")}</button>
        </form>` : ""}
      </div>`
    : "";
  return `
    <section class="panel ${errorCount ? "warn-panel" : ""}">
      <div class="section-heading">
        <div>
          <h2>Approval Backlog Radar</h2>
          <span class="muted">Daemon-style scan across approval states for missed, stale, warning, and failed approval items.</span>
        </div>
        <a class="button secondary" href="/api/approval-backlog?${escapeHtml(radarParams.toString())}">JSON</a>
      </div>
      <div class="metric-grid">
        ${metricCard("Total", report.total, "approval records")}
        ${metricCard("Inspected", report.scanned, report.truncated ? `newest ${formatNumber(report.scanned)}` : "all records")}
        ${metricCard("Pending", report.counts.pending ?? 0, "waiting")}
        ${metricCard("Approved", approvedReadyToExecuteCount, "ready to execute")}
        ${metricCard("Failed", report.counts.failed ?? 0, "errors")}
        ${metricCard("Warnings", warningCount, "stale or needs action")}
        ${metricCard("Errors", errorCount, "failed approvals")}
      </div>
      ${triageCards ? `<div class="approval-triage-grid">${triageCards}</div>` : ""}
      ${triageActions}
      <p class="muted">This radar inspects ${report.truncated ? `the newest ${formatNumber(report.scanned)} of ${formatNumber(report.total)}` : `all ${formatNumber(report.total)}`} approval records across states, even when the table above is filtered. Items older than ${formatNumber(report.staleMinutes)} minute(s) are treated as stale. Low/medium eligible items can be cleared by Approval Autopilot; high-risk or failed items stay visible for review.</p>
      <div class="table-wrap"><table><thead><tr><th>Severity</th><th>Triage</th><th>Target</th><th>Run</th><th>Reason / Next Action</th></tr></thead><tbody>${rows || "<tr><td colspan=\"5\">No warning or error approval backlog items found.</td></tr>"}</tbody></table></div>
    </section>
  `;
}

export function renderApprovalRulesHtml(
  rules: DashboardApprovalRuleSummary[],
  trustedCommands: DashboardTrustedCommandSummary[],
  projects: DashboardProjectSummary[],
  params: URLSearchParams
): string {
  const selectedProject = params.get("project") ?? "";
  const returnTo = `/approval-rules${selectedProject ? `?project=${encodeURIComponent(selectedProject)}` : ""}`;
  const commandRows = trustedCommands.map((command) => `
    <tr>
      <td><strong>${command.scope === "global" ? "Global" : "Project"}</strong></td>
      <td><code>${escapeHtml(command.pattern)}</code></td>
      <td>${command.scope === "global" ? "All projects on this machine" : `${escapeHtml(command.projectName ?? "Project")}<br><span class="muted">${escapeHtml(command.projectRootUri ?? "")}</span>`}</td>
      <td><code>${escapeHtml(command.configPath)}</code></td>
      <td>
        <form class="approval-form" method="post" action="/api/trusted-command-remove">
          <input type="hidden" name="scope" value="${command.scope}">
          <input type="hidden" name="pattern" value="${escapeHtml(command.pattern)}">
          <input type="hidden" name="project" value="${escapeHtml(command.projectRootUri ?? "")}">
          <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
          <button class="danger" type="submit">Remove</button>
        </form>
      </td>
    </tr>
  `).join("");
  const ruleRows = rules.map((rule) => `
    <tr>
      <td><strong>${escapeHtml(rule.id)}</strong><br><span class="muted">${escapeHtml(rule.description || "No description")}</span></td>
      <td><code>${escapeHtml(rule.functionLabel)}</code><br><span class="muted">${escapeHtml(rule.effect)}${rule.maxBytes ? ` · max ${escapeHtml(formatBytes(rule.maxBytes))}` : ""}</span></td>
      <td>${escapeHtml(rule.projectName)}<br><span class="muted">${escapeHtml(rule.projectRootUri)}</span></td>
      <td><code>${escapeHtml(rule.configPath)}</code></td>
      <td>
        <form class="approval-form" method="post" action="/api/approval-rule-remove">
          <input type="hidden" name="project" value="${escapeHtml(rule.projectRootUri)}">
          <input type="hidden" name="ruleId" value="${escapeHtml(rule.id)}">
          <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
          <button class="danger" type="submit">Remove</button>
        </form>
      </td>
    </tr>
  `).join("");
  const projectOptions = [
    `<option value=""${selectedProject ? "" : " selected"}>All registered projects</option>`,
    ...projects.map((project) => `<option value="${escapeHtml(project.rootUri)}"${selectedProject === project.rootUri ? " selected" : ""}>${escapeHtml(project.name)} - ${escapeHtml(project.rootUri)}</option>`)
  ].join("");
  const commandProjectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}"${selectedProject === project.rootUri ? " selected" : ""}>${escapeHtml(project.name)} - ${escapeHtml(project.rootUri)}</option>`).join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Trusted Commands</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("approval-rules")}
  <main id="main-content">
    <div class="topbar">
      <div>
        <a href="/approvals">Approvals</a>
        <h1>Trusted Commands</h1>
        <p class="muted">Manage command patterns that are eligible to run for one project or every project on this machine.</p>
      </div>
      <a class="button secondary" href="/api/approval-rules${selectedProject ? `?project=${encodeURIComponent(selectedProject)}` : ""}">JSON</a>
    </div>
    <section class="panel">
      <form class="workflow-form" method="get" action="/approval-rules">
        <label class="wide">Project<select name="project">${projectOptions}</select></label>
        <div class="form-actions"><button type="submit">Filter Rules</button><a class="button secondary" href="/approvals">Pending Approvals</a></div>
      </form>
    </section>
    <section class="panel approval-explainer">
      <h2>Add a Trusted Command</h2>
      <p>Patterns use the same matching syntax as project command policy. For example, <code>gh *</code> or <code>npm *</code>. Project scope updates that project's <code>.agent-workflow/project.yaml</code>; global scope uses a private user-local file and applies on this machine only.</p>
      <form class="workflow-form" method="post" action="/api/trusted-command-add">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
        <label>Scope<select name="scope" required><option value="project">Project</option><option value="global">Global on this machine</option></select></label>
        <label class="wide">Project<select name="project"><option value="">Choose a project</option>${commandProjectOptions}</select></label>
        <label class="wide">Command pattern<input name="pattern" required maxlength="500" placeholder="npm *" autocomplete="off"></label>
        <div class="form-actions"><button type="submit">Add Trusted Command</button></div>
      </form>
      <p class="muted">Trusted means policy-eligible, not automatically approved. Blocked-command rules still win, and approval, role, risk, and immutable run-snapshot checks still apply.</p>
    </section>
    <section class="panel">
      <h2>Trusted Command Patterns</h2>
      <table>
        <thead><tr><th>Scope</th><th>Pattern</th><th>Applies To</th><th>Config</th><th>Action</th></tr></thead>
        <tbody>${commandRows || "<tr><td colspan=\"5\">No trusted command patterns found.</td></tr>"}</tbody>
      </table>
    </section>
    <section class="panel approval-explainer">
      <h2>Auto-execute Rules</h2>
      <p>These project-local shortcuts allow recurring side effects that already passed human review to execute automatically. They do not bypass trusted command/path policy, size limits, blocklists, or immutable run policy snapshots.</p>
      <table>
        <thead><tr><th>Rule</th><th>Function</th><th>Project</th><th>Config</th><th>Action</th></tr></thead>
        <tbody>${ruleRows || "<tr><td colspan=\"5\">No auto-execute rules found.</td></tr>"}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

export function renderApprovalStatusContextPanel(status: string, backlog?: ApprovalBacklogReport): string {
  if (!backlog) return "";
  const activeFailures = backlog.categoryCounts.missing_tool ?? 0;
  const commandFailures = backlog.categoryCounts.command_failed ?? 0;
  const resolvedFailures = backlog.categoryCounts.resolved_missing_tool ?? 0;
  const auditRows = backlog.categoryCounts.historical_info ?? 0;
  const reviewedCandidateCount = commandFailures + resolvedFailures;
  if (status === "failed") {
    return `<section class="panel approval-context-panel">
      <div class="section-heading">
        <div>
          <h2>Failed Approval Rows Are Audit Evidence</h2>
          <span class="muted">This filter shows side effects that were attempted and failed at the time. Use the radar below for what needs action now.</span>
        </div>
      </div>
      <div class="status-context-grid">
        <div class="${activeFailures ? "bad" : "good"}"><strong>${formatNumber(activeFailures)}</strong><span>active failure${activeFailures === 1 ? "" : "s"} to review</span></div>
        <div class="${commandFailures ? "warn" : "neutral"}"><strong>${formatNumber(commandFailures)}</strong><span>command failure${commandFailures === 1 ? "" : "s"} ready to review</span></div>
        <div class="${resolvedFailures ? "warn" : "neutral"}"><strong>${formatNumber(resolvedFailures)}</strong><span>missing-tool failure${resolvedFailures === 1 ? "" : "s"} now retry-ready</span></div>
        <div class="neutral"><strong>${formatNumber(auditRows)}</strong><span>historical row${auditRows === 1 ? "" : "s"} retained for receipts</span></div>
      </div>
      ${reviewedCandidateCount ? `<form class="inline-action-form" method="post" action="/api/approval-triage-action">
        <input type="hidden" name="action" value="dismiss-reviewed-failures">
        <input type="hidden" name="project" value="${escapeHtml(backlog.projectRootUri ?? "")}">
        <input type="hidden" name="limit" value="${escapeHtml(String(backlog.scanned || 500))}">
        <input type="hidden" name="staleMinutes" value="${escapeHtml(String(backlog.staleMinutes))}">
        <label class="checkbox-label"><input type="checkbox" name="confirmed" required> Mark ${formatNumber(reviewedCandidateCount)} old failed approval${reviewedCandidateCount === 1 ? "" : "s"} reviewed/not actionable</label>
        <button class="secondary" type="submit">${iconLabel("check", "Mark Reviewed")}</button>
      </form>` : ""}
    </section>`;
  }
  if (status === "dismissed" || status === "executed" || status === "rejected") {
    return `<section class="panel approval-context-panel">
      <h2>${escapeHtml(titleCase(status))} Rows Are History</h2>
      <p class="muted">These approvals are retained as receipts. They should not be counted as open work unless a new run asks for the same side effect again.</p>
    </section>`;
  }
  return "";
}

export function renderApprovalsHtml(
  approvals: Awaited<ReturnType<typeof listActionApprovals>>,
  status: string,
  params: URLSearchParams = new URLSearchParams(),
  backlog?: ApprovalBacklogReport
): string {
  const pendingCount = approvals.filter((approval) => approval.status === "pending").length;
  const openCount = approvals.filter(isOpenApproval).length;
  const totalOpenCount = status === "open"
    ? openCount
    : backlog?.items.filter(isOpenApprovalBacklogItem).length ?? openCount;
  const projectFilter = params.get("project") ?? "";
  const runFilter = params.get("run") ?? "";
  const maxRisk = parseApprovalAutopilotRisk(params.get("maxRisk") ?? process.env.AGENTFLOW_APPROVAL_AUTOPILOT_MAX_RISK);
  const bulkParams = new URLSearchParams();
  if (runFilter) bulkParams.set("run", runFilter);
  if (projectFilter) bulkParams.set("project", projectFilter);
  bulkParams.set("limit", params.get("limit") ?? "100");
  const bulkHref = `/approvals/bulk?${bulkParams.toString()}`;
  const rows = approvals.map((approval) => `
    <tr class="${approvalTableRowClass(approval)}">
      <td>${escapeHtml(approval.id.slice(0, 8))}<br><span class="muted">${escapeHtml(approval.id)}</span></td>
      <td><span class="status ${escapeHtml(approval.status)}">${escapeHtml(approval.status)}</span></td>
      <td>${escapeHtml(approval.actionType)}<br><span class="muted">${escapeHtml(approval.stageId)} (${escapeHtml(approval.agentId)})</span></td>
      <td><code>${escapeHtml(approval.target)}</code><br><span class="muted">${escapeHtml(formatApprovalPayload(approval.payload))}</span></td>
      <td><a href="/run?id=${encodeURIComponent(approval.runId)}">${escapeHtml(approval.runId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(approval.workflowId)}</span><div class="row-tools">${renderRunInfoDialog({
        idSuffix: approval.id,
        runId: approval.runId,
        workflowId: approval.workflowId,
        status: approval.status,
        projectName: approval.projectName,
        projectRootUri: approval.projectRootUri,
        summary: [
          `${approval.actionType}: ${approval.target}`,
          `stage: ${approval.stageId} (${approval.agentId})`,
          approval.rationale
        ]
      })}</div></td>
      <td>${escapeHtml(approval.projectName)}<br><span class="muted">${escapeHtml(approval.projectRootUri)}</span></td>
      <td>${escapeHtml(approval.rationale)}<br><span class="muted">${escapeHtml(rolePreviewForApproval(approval))}</span>${approval.decidedBy ? `<br><span class="muted">Decided by ${escapeHtml(approval.decidedBy)}${approval.decidedRole ? ` (${escapeHtml(approval.decidedRole)})` : ""} at ${renderDashboardDateTime(approval.decidedAt)}</span>` : ""}</td>
      <td>${approval.status === "pending" ? approvalDecisionForms(approval) : approval.status === "approved" && isExecutableApprovalAction(approval.actionType) ? approvalApprovedActionForms(approval.id) : approval.status === "failed" && isExecutableApprovalAction(approval.actionType) ? approvalFailedActionForms(approval.id, approval.decisionNote ?? "") : escapeHtml(approval.decisionNote ?? "")}</td>
    </tr>
  `).join("");
  const mobileCards = approvals.map((approval) => renderMobileApprovalCard(
    approval,
    backlog?.items.find((item) => item.approvalId === approval.id)
  )).join("");
  const approvalsJsonParams = new URLSearchParams(params);
  approvalsJsonParams.set("status", status);
  const filterLink = (value: string, label: string) => {
    const nextParams = new URLSearchParams(params);
    nextParams.set("status", value);
    return `<a class="button filter-${escapeHtml(value)} ${status === value ? "" : "secondary"}" href="/approvals?${escapeHtml(nextParams.toString())}">${escapeHtml(label)}</a>`;
  };

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Approvals</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("approvals")}
  <main id="main-content">
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Approvals</h1>
        <p class="muted approval-intro">Review and act on open workflow requests.</p>
      </div>
      <a class="button secondary" href="/api/approvals?${escapeHtml(approvalsJsonParams.toString())}">JSON</a>
    </div>
    ${renderDashboardFlash(params)}
    ${renderDashboardActionHistory()}
    <section class="panel">
      <div class="actions approval-filters" aria-label="Approval status filters">
        ${filterLink("open", `Open (${totalOpenCount})`)}
        ${filterLink("pending", "Pending")}
        ${filterLink("approved", "Approved")}
        ${filterLink("executed", "Executed")}
        ${filterLink("failed", "Failed")}
        ${filterLink("dismissed", "Dismissed")}
        ${filterLink("rejected", "Rejected")}
        ${filterLink("all", "All")}
        <a class="button secondary" href="/approval-rules">Trusted Commands</a>
      </div>
    </section>
    <section class="panel approval-inbox-panel">
      <div class="section-heading">
        <div>
          <h2>${status === "open" ? `${openCount} Open Action${openCount === 1 ? "" : "s"}` : "Action Requests"}</h2>
          <span class="muted">${status === "open" ? "Pending decisions, approved actions ready to run, and failures needing review." : `Showing ${escapeHtml(status)} approval records.`}</span>
        </div>
      </div>
      <div class="mobile-approval-list">${mobileCards || `<div class="approval-empty"><strong>No ${status === "open" ? "open actions" : `${escapeHtml(status)} approvals`}</strong><span>${status === "open" ? "No human decision is waiting. Eligible low/medium local actions may execute automatically and appear in run receipts or Activity instead of creating approval cards." : "You’re all caught up."}</span></div>`}</div>
      <div class="desktop-approval-table table-wrap">
        <table>
          <thead><tr><th>Approval</th><th>Status</th><th>Action</th><th>Target</th><th>Run</th><th>Project</th><th>Rationale</th><th>Decision</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="8">${status === "open" ? "No human decision is waiting. Eligible low/medium local actions may execute automatically and appear in run receipts or Activity." : "No approvals found."}</td></tr>`}</tbody>
        </table>
      </div>
      ${pendingCount ? `<div class="bulk-action-footer"><span class="muted">Bulk action: review the list above first. The next page shows every affected approval before anything is approved.</span><a class="button secondary" href="${escapeHtml(bulkHref)}">Review and approve all ${pendingCount} pending...</a></div>` : ""}
    </section>
    ${renderApprovalStatusContextPanel(status, backlog)}
    ${backlog ? renderApprovalBacklogPanel(backlog) : ""}
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Approval Autopilot</h2>
          <span class="muted">Approve and execute eligible low/medium local side effects after policy and role rechecks. Already-approved eligible actions are executed too. High-risk items stay pending.</span>
        </div>
      </div>
      <form class="routing-form" method="post" action="/api/approval-autopilot">
        <input type="hidden" name="project" value="${escapeHtml(projectFilter)}">
        <input type="hidden" name="runId" value="${escapeHtml(runFilter)}">
        <label>Max risk
          <select name="maxRisk">
            <option value="low"${maxRisk === "low" ? " selected" : ""}>low</option>
            <option value="medium"${maxRisk === "medium" ? " selected" : ""}>medium</option>
            <option value="high"${maxRisk === "high" ? " selected" : ""}>high</option>
          </select>
        </label>
        <label>Limit
          <input name="limit" value="${escapeHtml(params.get("limit") ?? "100")}" inputmode="numeric">
        </label>
        <label class="checkbox-row">
          <input type="checkbox" name="execute" value="on" checked>
          Execute eligible actions now
        </label>
        <div class="form-actions"><button type="submit">Run Autopilot</button></div>
      </form>
      <p class="muted">Default max risk comes from <code>AGENTFLOW_APPROVAL_AUTOPILOT_MAX_RISK</code> and falls back to <code>medium</code>. Autopilot scans pending and already-approved unexecuted actions. It does not execute deployment, autonomy, destructive prune, blocked policy, secret-looking file, server, provider, or network actions.</p>
    </section>
    <section class="panel approval-explainer">
      <h2>How Approvals Work</h2>
      <p>Approvals are permission for side effects. A queued approval does not mean the whole workflow is stopped; it means that specific command, file write, deployment decision, artifact lifecycle action, or autonomy change is waiting for a human decision.</p>
      <div class="grid">
        <div><strong>Approve</strong><span>Records a one-time decision for this request.</span></div>
        <div><strong>Execute</strong><span>Runs an approved command or file write when execution is supported.</span></div>
        <div><strong>Always</strong><span>Adds a project-local rule so future matching safe requests can proceed automatically.</span></div>
        <div><strong>Reject</strong><span>Leaves the side effect skipped and records why it should not run.</span></div>
      </div>
    </section>
  </main>
</body>
</html>`;
}

export function renderBulkApprovalsHtml(
  approvals: Awaited<ReturnType<typeof listActionApprovals>>,
  params: URLSearchParams = new URLSearchParams()
): string {
  const rows = approvals.map((approval) => `
    <label class="bulk-approval-row">
      <input type="checkbox" name="approvalId" value="${escapeHtml(approval.id)}" checked>
      <span>
        <strong>${escapeHtml(approvalOneLineSummary(approval))}</strong>
        <small>${escapeHtml(approval.id)} · ${escapeHtml(approval.projectName)} · ${escapeHtml(approval.workflowId)}</small>
      </span>
    </label>
  `).join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Approve Pending Actions</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("approvals")}
  <main id="main-content">
    <div class="topbar">
      <div>
        <a href="/approvals">Approvals</a>
        <h1>Approve Pending Actions</h1>
        <p class="muted">Review each one-line summary and uncheck anything you do not want approved.</p>
      </div>
    </div>
    ${renderDashboardFlash(params)}
    ${renderDashboardActionHistory()}
    <section class="panel">
      ${approvals.length ? `<form method="post" action="/api/approval-bulk-action" class="bulk-approval-form">
        <input type="hidden" name="returnTo" value="/approvals/bulk?${escapeHtml(params.toString())}">
        <input type="hidden" name="actorRole" value="approver">
        <label>Decision note
          <input name="note" value="Bulk approved from dashboard after review">
        </label>
        <div class="bulk-approval-list">${rows}</div>
        <div class="actions">
          <button type="submit" name="decision" value="approve">Approve Checked</button>
          <button type="submit" name="decision" value="approve_execute">Approve Checked + Execute</button>
          <a class="button secondary" href="/approvals">Cancel</a>
        </div>
      </form>` : `<p class="muted">No pending approvals are available.</p><a class="button secondary" href="/approvals">Back to Approvals</a>`}
    </section>
  </main>
</body>
</html>`;
}
