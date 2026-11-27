import { formatNumber } from "../../ui/format.js";
import { escapeHtml, dashboardNav, iconLabel, renderDashboardFlash, renderDashboardActionHistory, renderDashboardDateTime, metricCard, dashboardPagePath, safeDashboardReturnPath } from "../../ui/layout.js";
import type { DashboardProjectAliasMergePlan, DashboardProjectIdentityGroup, DashboardProjectSummary } from "../../../lib/cli-types.js";
import { formatDuration } from "../../../lib/builders-learning.js";
import { countStrings } from "../../../lib/builders-shared.js";
import { type DashboardIconName } from "../../icons.js";
import { dashboardCss } from "../../styles.js";
import { parsePositiveInteger } from "../../../numeric-options.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { DashboardProjectDetail, RoadmapSuggestionDecision } from "../../../commands/daemon-types.js";

export async function loadDashboardProjectContextFiles(projectRootUri: string): Promise<DashboardProjectDetail["contextFiles"]> {
  const files = [
    ["AGENTS.md", "AGENTS.md"],
    ["Project Policy", ".agent-workflow/project.yaml"],
    ["Context", ".agent-workflow/context.md"],
    ["Commands", ".agent-workflow/commands.md"],
    ["Decisions", ".agent-workflow/decisions.md"],
    ["Schedules", ".agent-workflow/schedules.yaml"]
  ] as const;
  return Promise.all(files.map(async ([label, relativePath]) => {
    try {
      const raw = await fs.readFile(path.join(projectRootUri, relativePath), "utf8");
      return {
        label,
        relativePath,
        exists: true,
        preview: previewText(raw)
      };
    } catch {
      return {
        label,
        relativePath,
        exists: false,
        preview: ""
      };
    }
  }));
}

export function previewText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 500) {
    return trimmed;
  }
  return `${trimmed.slice(0, 500)}\n...`;
}

export function projectActionForm(project: string, action: string, label: string): string {
  const returnTo = `/project?root=${encodeURIComponent(project)}`;
  const iconName: DashboardIconName = action.includes("ux") ? "sparkles" : action.includes("review") ? "clipboard" : action.includes("readiness") ? "shield" : action.includes("context") ? "brain" : "rocket";
  return `<form method="post" action="/api/follow-up"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><input type="hidden" name="project" value="${escapeHtml(project)}"><input type="hidden" name="action" value="${escapeHtml(action)}"><button type="submit">${iconLabel(iconName, label)}</button></form>`;
}

export function projectIndexForm(project: string, returnTo = "/projects"): string {
  const safeReturnTo = safeDashboardReturnPath(returnTo) ?? "/projects";
  return `<form class="inline-form" method="post" action="/api/project-index"><input type="hidden" name="returnTo" value="${escapeHtml(safeReturnTo)}"><input type="hidden" name="project" value="${escapeHtml(project)}"><input name="maxFiles" inputmode="numeric" value="120" aria-label="Max files"><label class="check-row"><input type="checkbox" name="refine"> Refine</label><button type="submit">${iconLabel("search", "Index Project")}</button></form>`;
}

export function renderProjectDetailHtml(detail: DashboardProjectDetail, params: URLSearchParams = new URLSearchParams()): string {
  const project = detail.project;
  const contextRows = detail.contextFiles.map((file) => `
    <details class="artifact" ${file.exists ? "" : ""}>
      <summary>${escapeHtml(file.label)} <span class="muted">${escapeHtml(file.relativePath)} - ${file.exists ? "found" : "missing"}</span></summary>
      ${file.exists ? `<pre>${escapeHtml(file.preview)}</pre>` : "<p class=\"muted\">File not found in this project.</p>"}
    </details>
  `).join("");
  const runRows = detail.runs.map((run) => `
    <tr>
      <td><a href="/run?id=${encodeURIComponent(run.id)}">${escapeHtml(run.id.slice(0, 8))}</a></td>
      <td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
      <td>${escapeHtml(run.workflowId)}</td>
      <td>${escapeHtml(run.task)}</td>
      <td>${renderDashboardDateTime(run.startedAt)}</td>
    </tr>
  `).join("");
  const fileRows = detail.files.map((file) => `
    <tr>
      <td>${escapeHtml(file.sourceUri)}</td>
      <td>${formatNumber(file.tokenEstimate)}</td>
      <td>${renderDashboardDateTime(file.updatedAt)}</td>
      <td>${escapeHtml(file.summary)}</td>
    </tr>
  `).join("");
  const memoryRows = detail.memory.map((item) => `
    <tr>
      <td>${escapeHtml(item.sourceUri)}</td>
      <td>${renderDashboardDateTime(item.updatedAt)}</td>
      <td>${escapeHtml(item.summary)}</td>
    </tr>
  `).join("");
  const suggestionDecisionById = new Map(detail.roadmapSuggestionDecisions.decisions.map((item) => [item.suggestionId, item]));
  const visibleSuggestions = (detail.roadmapSuggestions?.suggestions ?? []).filter((item) => suggestionDecisionById.get(item.id)?.decision !== "dismissed");
  const suggestionRows = visibleSuggestions.map((item) => {
    const recorded = suggestionDecisionById.get(item.id);
    const decisionForm = (decision: RoadmapSuggestionDecision["decision"], label: string, secondary = false) => `<form method="post" action="/api/project-roadmap-suggestion" style="display:inline"><input type="hidden" name="project" value="${escapeHtml(project.rootUri)}"><input type="hidden" name="suggestionId" value="${escapeHtml(item.id)}"><input type="hidden" name="decision" value="${decision}"><button type="submit" class="compact-button${secondary ? " secondary" : ""}">${label}</button></form>`;
    return `
    <tr>
      <td><span class="flag ${item.priority === "high" ? "warn" : item.source === "learning-evidence" ? "queued" : "good"}">${escapeHtml(item.priority ?? "planned")}</span></td>
      <td><strong>${escapeHtml(item.title)}</strong><br><span class="muted">${escapeHtml(item.source === "learning-evidence" ? "Daemon learning evidence" : `${item.section ?? "Roadmap"}, line ${item.line}`)}</span></td>
      <td>${escapeHtml(item.rationale ?? item.recommendation ?? "Existing unchecked roadmap item.")}</td>
      <td>${recorded ? `<span class="status ${recorded.decision === "approved" ? "completed" : "queued"}">${escapeHtml(recorded.decision)}</span><br>` : ""}<div class="actions">${item.source === "learning-evidence" && recorded?.decision !== "approved" ? decisionForm("approved", "Add to roadmap") : ""}${decisionForm("deferred", "Defer", true)}${decisionForm("dismissed", "Dismiss", true)}</div></td>
    </tr>
  `;}).join("");
  const newlyAlertedIds = new Set(detail.roadmapSuggestions?.newHighPrioritySuggestions ?? []);
  const highPrioritySuggestions = visibleSuggestions.filter((item) => item.priority === "high" && !suggestionDecisionById.has(item.id) && (newlyAlertedIds.size === 0 || newlyAlertedIds.has(item.id)));
  const decisionCounts = countStrings(detail.roadmapSuggestionDecisions.decisions.map((item) => item.decision));
  const daemonAgeMs = detail.learningDaemon?.lastHeartbeatAt ? Math.max(0, Date.now() - Date.parse(detail.learningDaemon.lastHeartbeatAt)) : null;
  const daemonHealthy = detail.learningDaemon?.status === "running" && daemonAgeMs !== null && daemonAgeMs <= Math.max(120_000, (detail.learningDaemon.intervalMs ?? 60_000) * 3);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(project.name)} - Agent Workflow</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("projects")}
  <main id="main-content">
    <div class="topbar">
      <div>
        <a href="/projects">Projects</a>
        <h1>${escapeHtml(project.name)}</h1>
        <p class="muted">${escapeHtml(project.rootUri)}</p>
      </div>
      <a class="button secondary" href="/api/preferences?project=${encodeURIComponent(project.rootUri)}">Preference JSON</a>
    </div>
    ${renderDashboardFlash(params)}
    ${renderDashboardActionHistory()}
    <section class="panel">
      <div class="meta-grid">
        <div><strong>Initialized</strong>${detail.initialized ? "yes" : "no"}</div>
        <div><strong>Profile</strong>${escapeHtml(project.profile)}</div>
        <div><strong>Write Policy</strong>${detail.allowWrites ? "configured" : "read-only or missing"}</div>
        <div><strong>Indexed Files</strong>${formatNumber(project.indexedFiles)}</div>
        <div><strong>Indexed Tokens</strong>${formatNumber(project.indexedTokens)}</div>
        <div><strong>Memory Items</strong>${formatNumber(project.memoryItems)}</div>
        <div><strong>Runs</strong>${formatNumber(project.runCount)}</div>
        <div><strong>Last Indexed</strong>${renderDashboardDateTime(project.lastIndexedAt, "not indexed")}</div>
      </div>
    </section>
    <section class="panel">
      <h2>Project Actions</h2>
      <div class="actions">
        ${projectIndexForm(project.rootUri, dashboardPagePath("/project", params))}
        ${projectActionForm(project.rootUri, "mira-ux-pass", "UX Pass")}
        ${projectActionForm(project.rootUri, "pr-review", "Review")}
        ${projectActionForm(project.rootUri, "production-readiness", "Production Readiness")}
        ${projectActionForm(project.rootUri, "maintain-context", "Maintain Context")}
      </div>
    </section>
    <section class="panel">
      <div class="section-heading"><div><h2>Suggested Next Work</h2><span class="muted">Evidence-backed daemon proposals and open roadmap work for this project.</span></div><a class="button secondary" href="/learning?project=${encodeURIComponent(project.rootUri)}&view=approvals">Open learning inbox</a></div>
      ${highPrioritySuggestions.length ? `<div class="callout queued"><strong>${highPrioritySuggestions.length} new high-priority suggestion${highPrioritySuggestions.length === 1 ? "" : "s"}</strong><p>Human review is requested; these remain advisory until approved.</p></div>` : ""}
      <div class="metric-grid compact">${metricCard("Visible", visibleSuggestions.length, "current suggestions")}${metricCard("Approved", decisionCounts.approved ?? 0, "added to roadmap")}${metricCard("Deferred", decisionCounts.deferred ?? 0, "kept for later")}${metricCard("Dismissed", decisionCounts.dismissed ?? 0, "hidden with history retained")}</div>
      <p class="muted">${detail.roadmapSuggestions ? `Generated ${escapeHtml(detail.roadmapSuggestions.generatedAt)} · ${detail.roadmapSuggestions.openItems} open roadmap item(s)` : "The learning daemon has not published suggestions for this project yet."}</p>
      <table><thead><tr><th>Priority</th><th>Suggestion</th><th>Why</th><th>Action</th></tr></thead><tbody>${suggestionRows || "<tr><td colspan=\"4\">No current suggestions. The daemon will populate this after its next successful project tick.</td></tr>"}</tbody></table>
    </section>
    <section class="panel">
      <div class="section-heading"><div><h2>Suggestion Pipeline Health</h2><span class="muted">Per-project daemon timing and durable decision outcomes.</span></div><span class="status ${daemonHealthy ? "completed" : "failed"}">${daemonHealthy ? "healthy" : "needs attention"}</span></div>
      <div class="meta-grid compact"><div><strong>Daemon</strong>${escapeHtml(detail.learningDaemon?.status ?? "unavailable")}</div><div><strong>Last heartbeat</strong>${detail.learningDaemon?.lastHeartbeatAt ? renderDashboardDateTime(detail.learningDaemon.lastHeartbeatAt) : "never"}</div><div><strong>Heartbeat age</strong>${daemonAgeMs === null ? "unknown" : formatDuration(daemonAgeMs)}</div><div><strong>Per-project budget</strong>${formatDuration(parsePositiveInteger(process.env.AGENTFLOW_LEARNING_PROJECT_TIMEOUT_MS ?? "", 120_000))}</div></div>
      ${detail.learningDaemon?.lastError ? `<div class="callout warn"><strong>Latest daemon error</strong><p>${escapeHtml(detail.learningDaemon.lastError)}</p></div>` : ""}
      <p class="muted">Approved, deferred, and dismissed outcomes are retained in project-local learning state so future ranking can distinguish accepted work from unwanted repetition.</p>
    </section>
    <section class="panel">
      <h2>Context Files</h2>
      ${contextRows}
    </section>
    <section class="panel">
      <h2>Recent Runs</h2>
      <table><thead><tr><th>Run</th><th>Status</th><th>Workflow</th><th>Task</th><th>Started</th></tr></thead><tbody>${runRows || "<tr><td colspan=\"5\">No runs.</td></tr>"}</tbody></table>
    </section>
    <section class="panel">
      <h2>Indexed Files</h2>
      <table><thead><tr><th>File</th><th>Tokens</th><th>Indexed</th><th>Summary</th></tr></thead><tbody>${fileRows || "<tr><td colspan=\"4\">No indexed files.</td></tr>"}</tbody></table>
    </section>
    <section class="panel">
      <h2>Memory</h2>
      <table><thead><tr><th>Source</th><th>Updated</th><th>Summary</th></tr></thead><tbody>${memoryRows || "<tr><td colspan=\"3\">No memory items.</td></tr>"}</tbody></table>
    </section>
  </main>
</body>
</html>`;
}

export function renderProjectsHtml(projects: DashboardProjectSummary[], identities: DashboardProjectIdentityGroup[], aliasMergePlan: DashboardProjectAliasMergePlan, suggestionCounts: Map<string, number> = new Map()): string {
  const canonicalIdentities = identities.filter((identity) => identity.visibility === "canonical");
  const supportingIdentities = identities.filter((identity) => identity.visibility === "supporting");
  const renderIdentityRow = (identity: DashboardProjectIdentityGroup) => `
    <tr>
      <td><a href="/project?root=${encodeURIComponent(identity.primaryRootUri)}">${escapeHtml(identity.canonicalName)}</a><br><span class="muted">${escapeHtml(identity.canonicalRootUri)}</span></td>
      <td><span class="status ${identity.localPathExists ? "completed" : "queued"}">${identity.localPathExists ? "local" : "remote only"}</span><br><span class="muted">${escapeHtml(identity.source)}</span></td>
      <td>${formatNumber(identity.projects.length)}<br><span class="muted">${identity.aliases.map((alias) => escapeHtml(alias.rootUri)).join("<br>")}</span></td>
      <td>${formatNumber(identity.totalRuns)}<br><span class="muted">${formatNumber(identity.activeRuns)} active / ${formatNumber(identity.failedRuns)} failed</span></td>
      <td>${formatNumber(identity.totalIndexedFiles)}</td>
      <td>${formatNumber(identity.totalMemoryItems)}</td>
      <td>${renderDashboardDateTime(identity.lastRunAt, "none")}<br><a href="/project?root=${encodeURIComponent(identity.primaryRootUri)}"><span class="flag ${suggestionCounts.get(identity.primaryRootUri) ? "queued" : "good"}">${formatNumber(suggestionCounts.get(identity.primaryRootUri) ?? 0)} suggestions</span></a></td>
    </tr>
  `;
  const identityRows = canonicalIdentities.map(renderIdentityRow).join("");
  const supportingIdentityRows = supportingIdentities.map(renderIdentityRow).join("");
  const rows = projects.map((project) => `
    <tr>
      <td><a href="/project?root=${encodeURIComponent(project.rootUri)}">${escapeHtml(project.name)}</a><br><span class="muted">${escapeHtml(project.rootUri)}</span></td>
      <td>${escapeHtml(project.profile)}</td>
      <td>${formatNumber(project.indexedFiles)}<br><span class="muted">${formatNumber(project.indexedTokens)} tokens</span></td>
      <td>${formatNumber(project.memoryItems)}</td>
      <td>${formatNumber(project.runCount)}<br><span class="muted">${project.completedRuns} ok / ${project.failedRuns} failed / ${project.queuedRuns + project.runningRuns} active</span></td>
      <td>${project.lastRunId ? `<a href="/run?id=${encodeURIComponent(project.lastRunId)}">${escapeHtml(project.lastRunId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(project.lastWorkflowId ?? "unknown")} ${escapeHtml(project.lastRunStatus ?? "")}</span>` : "none"}</td>
      <td>${renderDashboardDateTime(project.lastIndexedAt, "not indexed")}</td>
    </tr>
  `).join("");
  const aliasMergeRows = aliasMergePlan.groups.slice(0, 12).map((group) => `
    <tr>
      <td><strong>${escapeHtml(group.target.name)}</strong><br><span class="muted">${escapeHtml(group.canonicalRootUri)}</span></td>
      <td><span class="flag ${group.risk === "high" ? "bad" : group.risk === "medium" ? "warn" : "good"}">${escapeHtml(group.risk)}</span></td>
      <td>${escapeHtml(group.target.rootUri)}<br><code>${escapeHtml(group.target.id)}</code></td>
      <td>${group.sources.map((source) => `${escapeHtml(source.rootUri)}<br><code>${escapeHtml(source.id)}</code>`).join("<br>")}</td>
      <td>${formatNumber(group.impactedRows.workflowRuns)} runs<br><span class="muted">${formatNumber(group.impactedRows.projectFiles)} files / ${formatNumber(group.impactedRows.memoryItems)} memory / ${formatNumber(group.impactedRows.activeRuns)} active</span></td>
      <td>${group.conflictWarnings.map((warning) => `<span class="muted">${escapeHtml(warning)}</span>`).join("<br>") || '<span class="muted">No conflicts predicted from summary data.</span>'}</td>
    </tr>
  `).join("");
  const aliasMergeSummary = aliasMergePlan.summary.map((item) => `<li>${escapeHtml(item)}</li>`).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Projects</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("projects")}
  <main id="main-content">
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Projects</h1>
      </div>
      <div class="button-row">
        <a class="button secondary" href="/api/project-alias-merge-plan">Alias Merge JSON</a>
        <a class="button secondary" href="/api/project-identities">Identity JSON</a>
        <a class="button secondary" href="/api/projects">Projects JSON</a>
      </div>
    </div>
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Project Identities</h2>
          <span class="muted">Canonical local identity groups for shared storage paths, mounted paths, and host-specific aliases.</span>
        </div>
      </div>
      <div class="metric-grid">
        ${metricCard("Canonical", canonicalIdentities.length, "top-level projects")}
        ${metricCard("Registered Paths", projects.length, "stored project roots")}
        ${metricCard("Aliased", canonicalIdentities.filter((identity) => identity.projects.length > 1).length, "multi-path identities")}
        ${metricCard("Other Roots", supportingIdentities.length, "history and supporting checkouts")}
      </div>
      <table>
        <thead><tr><th>Identity</th><th>Local</th><th>Aliases</th><th>Runs</th><th>Indexed</th><th>Memory</th><th>Last Run</th></tr></thead>
        <tbody>${identityRows || "<tr><td colspan=\"7\">No project identities found.</td></tr>"}</tbody>
      </table>
      ${supportingIdentities.length ? `<details class="panel-inset"><summary><strong>Other registered roots (${formatNumber(supportingIdentities.length)})</strong> <span class="muted">Temporary, template, remote-only, or supporting checkouts retained for history</span></summary><div class="table-wrap"><table><thead><tr><th>Identity</th><th>Local</th><th>Aliases</th><th>Runs</th><th>Indexed</th><th>Memory</th><th>Last Run</th></tr></thead><tbody>${supportingIdentityRows}</tbody></table></div></details>` : ""}
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Alias Merge Plan</h2>
          <span class="muted">Dry-run consolidation plan for duplicate project rows created by host path aliases.</span>
        </div>
        <a class="button secondary" href="/api/project-alias-merge-plan">JSON</a>
      </div>
      <div class="metric-grid">
        ${metricCard("Candidates", aliasMergePlan.candidateCount, "identity groups")}
        ${metricCard("Source Rows", aliasMergePlan.sourceProjectCount, "would move into canonical targets")}
        ${metricCard("Dry Run", aliasMergePlan.dryRun ? "yes" : "no", "no database writes")}
        ${metricCard("High Risk", aliasMergePlan.groups.filter((group) => group.risk === "high").length, "must resolve before execution")}
      </div>
      <ul>${aliasMergeSummary}</ul>
      <div class="table-wrap"><table>
        <thead><tr><th>Identity</th><th>Risk</th><th>Target</th><th>Source Aliases</th><th>Impact</th><th>Warnings</th></tr></thead>
        <tbody>${aliasMergeRows || '<tr><td colspan="6">No alias merge candidates found.</td></tr>'}</tbody>
      </table></div>
      ${aliasMergePlan.groups.length > 12 ? `<p class="muted">${formatNumber(aliasMergePlan.groups.length - 12)} additional merge candidate(s) are available in JSON.</p>` : ""}
      <p class="muted">Execution remains intentionally separate: first create a backup, run storage verification, clear active source runs, and generate an auditable mapping receipt.</p>
    </section>
    <section class="panel">
      <details>
        <summary><strong>Storage records (${formatNumber(projects.length)})</strong> <span class="muted">Exact registered roots retained for provenance and troubleshooting</span></summary>
        <div class="table-wrap"><table>
          <thead><tr><th>Project</th><th>Profile</th><th>Indexed</th><th>Memory</th><th>Runs</th><th>Last Run</th><th>Last Indexed</th></tr></thead>
          <tbody>${rows || "<tr><td colspan=\"7\">No projects found. Run onboarding or index a project first.</td></tr>"}</tbody>
        </table></div>
      </details>
    </section>
  </main>
</body>
</html>`;
}
