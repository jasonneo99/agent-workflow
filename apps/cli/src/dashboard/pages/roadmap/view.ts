import { titleCase, formatNumber, truncateMiddle } from "../../ui/format.js";
import { escapeHtml, dashboardNav, iconLabel, renderDashboardActionHistory, renderDashboardDateTime, metricCard, dashboardReturnInput } from "../../ui/layout.js";
import { dashboardCss, roadmapDashboardCss } from "../../styles.js";
import type { RoadmapDashboardReport, RoadmapMilestone, RoadmapTask } from "../../../commands/daemon-types.js";
import { compareRoadmapTasks, roadmapPriorityOrder } from "../../../lib/roadmap-tasks.js";

export function renderRoadmapCaptureForm(report: RoadmapDashboardReport, params: URLSearchParams): string {
  const milestoneOptions = report.milestones.map((milestone) => `<option value="${milestone.number}">${milestone.number}. ${escapeHtml(milestone.title)}</option>`).join("");
  const priorityOptions = roadmapPriorityOrder().map((priority) => `<option value="${priority}"${priority === "medium" ? " selected" : ""}>${escapeHtml(titleCase(priority))}</option>`).join("");
  return `<section class="panel">
    <div class="section-heading"><div><h2>Record Task Or Bug</h2><span class="muted">Append a milestone-linked item to the roadmap register. This writes only <code>docs/roadmap.md</code>.</span></div></div>
    <form class="workflow-form" method="post" action="/api/roadmap-item">
      ${dashboardReturnInput("/roadmap", params)}
      <label>Type<select name="kind"><option value="task">Task</option><option value="bug">Bug</option></select></label>
      <label>Milestone<select name="milestone">${milestoneOptions}</select></label>
      <label>Priority<select name="priority">${priorityOptions}</select></label>
      <label class="wide">Title<input name="title" maxlength="180" placeholder="Add the smallest useful description"></label>
      <label class="wide">Note<input name="note" maxlength="240" placeholder="Optional context, evidence, or acceptance hint"></label>
      <div class="form-actions"><button type="submit">${iconLabel("plus", "Add To Roadmap")}</button></div>
    </form>
  </section>`;
}

export function renderRoadmapDashboardHtml(report: RoadmapDashboardReport, params: URLSearchParams): string {
  const view = params.get("view") === "gantt" ? "gantt" : "list";
  const milestoneFilter = params.get("milestone") ?? "all";
  const statusFilter = params.get("status") ?? "open";
  const priorityFilter = params.get("priority") ?? "all";
  const visibleTasks = report.tasks.filter((task) => {
    const milestoneOk = milestoneFilter === "all" || String(task.milestoneNumber ?? "none") === milestoneFilter;
    const statusOk = statusFilter === "all" || task.status === statusFilter || (statusFilter === "open" && task.status === "next");
    const priorityOk = priorityFilter === "all" || task.priority === priorityFilter;
    return milestoneOk && statusOk && priorityOk;
  }).sort(compareRoadmapTasks);
  const milestoneOptions = [
    `<option value="all"${milestoneFilter === "all" ? " selected" : ""}>All milestones</option>`,
    `<option value="none"${milestoneFilter === "none" ? " selected" : ""}>Unlinked</option>`,
    ...report.milestones.map((milestone) => `<option value="${milestone.number}"${milestoneFilter === String(milestone.number) ? " selected" : ""}>${milestone.number}. ${escapeHtml(milestone.title)}</option>`)
  ].join("");
  const statusOptions = ["open", "next", "done", "all"].map((status) => `<option value="${status}"${statusFilter === status ? " selected" : ""}>${escapeHtml(titleCase(status))}</option>`).join("");
  const priorityOptions = [
    `<option value="all"${priorityFilter === "all" ? " selected" : ""}>All priorities</option>`,
    ...roadmapPriorityOrder().map((priority) => `<option value="${priority}"${priorityFilter === priority ? " selected" : ""}>${escapeHtml(titleCase(priority))}</option>`)
  ].join("");
  const viewParams = new URLSearchParams(params);
  viewParams.set("view", view === "gantt" ? "list" : "gantt");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Roadmap</title>
  <style>${dashboardCss()}${roadmapDashboardCss()}</style>
</head>
<body>
  ${dashboardNav("roadmap")}
  <main id="main-content">
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Roadmap</h1>
        <p class="muted">Live milestone, task, and bug view generated from <code>docs/roadmap.md</code>.</p>
      </div>
      <div class="actions">
        <a class="button secondary" href="/api/roadmap">JSON</a>
        <a class="button secondary" href="/roadmap?${escapeHtml(viewParams.toString())}">${view === "gantt" ? "List View" : "Gantt View"}</a>
      </div>
    </div>
    ${renderDashboardActionHistory()}
    <section class="panel">
      <form class="workflow-form" method="get" action="/roadmap">
        <input type="hidden" name="view" value="${escapeHtml(view)}">
        <label>Milestone<select name="milestone">${milestoneOptions}</select></label>
        <label>Status<select name="status">${statusOptions}</select></label>
        <label>Priority<select name="priority">${priorityOptions}</select></label>
        <div class="form-actions"><button type="submit">${iconLabel("search", "Filter")}</button><a class="button secondary" href="/roadmap?view=${escapeHtml(view)}">Reset</a></div>
      </form>
    </section>
    ${renderRoadmapCaptureForm(report, params)}
    <section class="panel">
      <div class="metric-grid">
        ${metricCard("Milestones", report.summary.milestoneCount, "goal lanes", "clipboard")}
        ${metricCard("Open", report.summary.openCount + report.summary.nextCount, "active tasks", "activity")}
        ${metricCard("Done", report.summary.doneCount, "completed items", "check")}
        ${metricCard("Bugs", report.summary.bugCount, "tracked defects", "warning")}
        ${metricCard("High Priority", report.summary.priorityCounts.critical + report.summary.priorityCounts.high, "critical/high", "warning")}
        ${metricCard("Unlinked", report.summary.unlinkedCount, "missing milestone", report.summary.unlinkedCount ? "warning" : "check")}
      </div>
      <p class="muted">Generated ${renderDashboardDateTime(report.generatedAt)}. Tasks link to milestones by explicit <code>Milestone:</code> notes when present, otherwise by roadmap keyword inference.</p>
    </section>
    ${renderRoadmapIntegrityPanel(report)}
    ${renderRoadmapMcpRecoveryPanel(report, params)}
    ${renderRoadmapMilestoneIndex(report)}
    ${view === "gantt" ? renderRoadmapGantt(visibleTasks, report.milestones) : renderRoadmapTaskList(visibleTasks, params)}
  </main>
</body>
</html>`;
}

export function renderRoadmapGantt(tasks: RoadmapTask[], milestones: RoadmapMilestone[]): string {
  const orderedMilestones = milestones.filter((milestone) => tasks.some((task) => task.milestoneNumber === milestone.number));
  const unlinkedTasks = tasks.filter((task) => !task.milestoneNumber);
  const rows = [
    ...orderedMilestones.map((milestone) => renderRoadmapGanttLane(`${milestone.number}. ${milestone.title}`, tasks.filter((task) => task.milestoneNumber === milestone.number), milestone.number)),
    ...(unlinkedTasks.length ? [renderRoadmapGanttLane("Unlinked", unlinkedTasks, 12)] : [])
  ].join("");
  return `<section class="panel"><h2>Gantt View</h2><p class="muted">Relative roadmap timeline by milestone. No calendar dates are invented; bar placement follows task order and status.</p><div class="roadmap-gantt"><div class="roadmap-gantt-head"><span>Milestone</span><span>Now</span><span>Next</span><span>Later</span><span>Future</span></div>${rows || "<p class=\"muted\">No matching roadmap tasks found.</p>"}</div></section>`;
}

export function renderRoadmapGanttLane(label: string, tasks: RoadmapTask[], seed: number): string {
  const bars = tasks.map((task, index) => {
    const column = task.status === "done" ? 1 : task.status === "next" ? 2 : Math.min(4, 2 + ((index + seed) % 3));
    const width = Math.min(3, Math.max(1, 1 + Math.floor(task.details.length / 4)));
    return `<a class="roadmap-bar ${task.kind} ${task.status} priority-${task.priority}" style="grid-column:${column} / span ${width}" title="${escapeHtml(`${task.priority}: ${task.title}`)}" href="/roadmap?milestone=${encodeURIComponent(String(task.milestoneNumber ?? "none"))}&status=all"><small>${escapeHtml(task.priority)}</small><span>${escapeHtml(truncateMiddle(task.title, 72))}</span></a>`;
  }).join("");
  return `<div class="roadmap-gantt-row"><strong>${escapeHtml(label)}</strong><div class="roadmap-bars">${bars}</div></div>`;
}

export function renderRoadmapIntegrityPanel(report: RoadmapDashboardReport): string {
  const unlinkedRows = report.tasks
    .filter((task) => task.milestoneSource === "missing")
    .slice(0, 12)
    .map((task) => `<li><code>docs/roadmap.md:${task.sourceLine}</code> ${escapeHtml(task.title)}</li>`)
    .join("");
  const inferredRows = report.tasks
    .filter((task) => task.milestoneSource === "inferred")
    .slice(0, 8)
    .map((task) => `<li><code>docs/roadmap.md:${task.sourceLine}</code> milestone ${escapeHtml(String(task.milestoneNumber ?? "none"))}: ${escapeHtml(task.title)}</li>`)
    .join("");
  const statusClass = report.summary.unlinkedCount ? "failed" : "completed";
  return `<section class="panel">
    <div class="section-heading">
      <div><h2>Milestone Integrity</h2><span class="muted">Keeps roadmap tasks tied to the larger goal instead of drifting into loose notes.</span></div>
      <a class="button secondary" href="/roadmap?milestone=none&status=all">Unlinked</a>
    </div>
    <div class="metric-grid">
      ${metricCard("Explicit", report.summary.explicitMilestoneCount, "Milestone lines", "check")}
      ${metricCard("Inferred", report.summary.inferredMilestoneCount, "keyword fallback", "activity")}
      ${metricCard("Missing", report.summary.unlinkedCount, "needs link", report.summary.unlinkedCount ? "warning" : "check")}
    </div>
    <div class="callout ${statusClass}">
      <strong>${report.summary.unlinkedCount ? "Milestone links need attention" : "Milestone audit is clean"}</strong>
      <p>${report.summary.unlinkedCount ? "Add an explicit Milestone line to each unlinked checklist row before treating the roadmap as ready." : "Every checklist row is milestone-linked explicitly or by dashboard inference. New dashboard-created items require explicit milestone selection."}</p>
    </div>
    ${unlinkedRows ? `<h3>Unlinked Items</h3><ul>${unlinkedRows}</ul>` : ""}
    ${inferredRows ? `<details class="governance-details"><summary>Inferred Links To Review</summary><ul>${inferredRows}</ul></details>` : ""}
  </section>`;
}

export function renderRoadmapMcpRecoveryPanel(report: RoadmapDashboardReport, params: URLSearchParams): string {
  const transportBug = report.bugs.find((bug) => bug.status !== "done" && /mcp transport closes|transport closed|stdio/iu.test(`${bug.title} ${bug.details.join(" ")}`));
  if (!transportBug) return "";
  return `<section class="panel">
    <div class="section-heading">
      <div><h2>MCP Recovery</h2><span class="muted">High-priority ecosystem bug: Codex or another IDE can close its private stdio pipe while Agent Workflow services stay healthy.</span></div>
      <div class="actions"><a class="button secondary" href="/server-readiness">Runtime Monitor</a><a class="button secondary" href="/api/runtime-monitor?checkMcp=1">JSON</a></div>
    </div>
    <div class="metric-grid">
      ${metricCard("Roadmap Bug", transportBug.priority, `docs/roadmap.md:${transportBug.sourceLine}`, "warning")}
      ${metricCard("Milestone", transportBug.milestoneNumber ?? "none", transportBug.milestoneTitle ?? "unlinked", "route")}
      ${metricCard("Status", transportBug.status, "tracked recovery", "activity")}
    </div>
    <div class="callout queued">
      <strong>Recovery command</strong>
      <p><code>npm run runtime-monitor -- --check-mcp --write-mcp-recovery</code></p>
      <p class="muted">If launcher smoke passes but a specific Codex task still reports <code>Transport closed</code>, reload that task or the IDE client so it creates a fresh stdio subprocess.</p>
    </div>
    <form class="inline-form compact-form" method="post" action="/api/runtime-monitor-action">
      ${dashboardReturnInput("/roadmap", params)}
      <input type="hidden" name="action" value="write-mcp-recovery">
      <button type="submit">${iconLabel("shield", "Write Recovery Package")}</button>
      <a class="button secondary" href="/roadmap?milestone=12&status=all&priority=high">View Ecosystem Bug</a>
    </form>
  </section>`;
}

export function renderRoadmapMilestoneIndex(report: RoadmapDashboardReport): string {
  const rows = report.milestones.map((milestone) => {
    const linked = report.tasks.filter((task) => task.milestoneNumber === milestone.number);
    const open = linked.filter((task) => task.status !== "done").length;
    return `<tr>
      <td><strong>${milestone.number}. ${escapeHtml(milestone.title)}</strong><br><span class="muted">${escapeHtml(milestone.status || "No status text recorded.")}</span></td>
      <td>${formatNumber(linked.length)}<br><span class="muted">${formatNumber(open)} open</span></td>
      <td>${milestone.workstreams.slice(0, 8).map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join(" ")}</td>
      <td><a href="/roadmap?milestone=${milestone.number}&status=all">Open</a></td>
    </tr>`;
  }).join("");
  return `<section class="panel"><h2>Milestone Index</h2><div class="table-wrap"><table><thead><tr><th>Milestone</th><th>Tasks</th><th>Workstreams</th><th>View</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

export function renderRoadmapPriorityControls(task: RoadmapTask, params: URLSearchParams): string {
  if (task.status === "next") return "";
  const options = roadmapPriorityOrder().map((priority) => `<option value="${priority}"${priority === task.priority ? " selected" : ""}>${escapeHtml(titleCase(priority))}</option>`).join("");
  return `<form class="inline-form compact-form" method="post" action="/api/roadmap-priority">
    ${dashboardReturnInput("/roadmap", params)}
    <input type="hidden" name="line" value="${escapeHtml(String(task.sourceLine))}">
    <select name="priority" aria-label="Priority for ${escapeHtml(task.title)}">${options}</select>
    <button class="secondary" type="submit">Set Priority</button>
  </form>`;
}

export function renderRoadmapRowActions(task: RoadmapTask, params: URLSearchParams): string {
  if (task.status === "next") return renderRoadmapStatusControls(task, params);
  return `<div class="roadmap-row-actions">${renderRoadmapStatusControls(task, params)}${renderRoadmapPriorityControls(task, params)}</div>`;
}

export function renderRoadmapStatusControls(task: RoadmapTask, params: URLSearchParams): string {
  if (task.status === "next") return "<span class=\"muted\">Derived next action</span>";
  const nextStatus = task.status === "done" ? "open" : "done";
  return `<form class="inline-form compact-form" method="post" action="/api/roadmap-status">
    ${dashboardReturnInput("/roadmap", params)}
    <input type="hidden" name="line" value="${escapeHtml(String(task.sourceLine))}">
    <input type="hidden" name="status" value="${escapeHtml(nextStatus)}">
    <button class="${nextStatus === "done" ? "" : "secondary"}" type="submit">${nextStatus === "done" ? "Mark Done" : "Reopen"}</button>
  </form>`;
}

export function renderRoadmapTaskList(tasks: RoadmapTask[], params: URLSearchParams): string {
  const rows = tasks.map((task) => `
    <tr class="roadmap-${task.kind}">
      <td><span class="status ${task.status === "done" ? "completed" : task.status === "next" ? "running" : "queued"}">${escapeHtml(task.status)}</span><br><span class="priority priority-${escapeHtml(task.priority)}">${escapeHtml(task.priority)}</span><br><span class="muted">${escapeHtml(task.kind)}</span></td>
      <td>${task.milestoneNumber ? `<strong>${task.milestoneNumber}. ${escapeHtml(task.milestoneTitle ?? "Milestone")}</strong>` : "<span class=\"muted\">Unlinked</span>"}<br><span class="tag">${escapeHtml(task.milestoneSource)}</span><br><span class="muted">${escapeHtml(task.phase)}</span></td>
      <td><strong>${escapeHtml(task.title)}</strong>${task.details.length ? `<br><span class="muted">${escapeHtml(task.details.slice(0, 2).join(" "))}</span>` : ""}</td>
      <td><code>docs/roadmap.md:${task.sourceLine}</code></td>
      <td>${renderRoadmapRowActions(task, params)}</td>
    </tr>
  `).join("");
  return `<section class="panel"><h2>Task And Bug List</h2><div class="table-wrap"><table><thead><tr><th>Status</th><th>Milestone</th><th>Task</th><th>Source</th><th>Actions</th></tr></thead><tbody>${rows || "<tr><td colspan=\"5\">No matching roadmap tasks found.</td></tr>"}</tbody></table></div></section>`;
}
