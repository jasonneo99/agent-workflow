import { graphPresetHref, workflowGraphDashboardHref, normalizeDashboardGraphPresetFilters, summarizeFocusedStageDelta } from "../../ui/graph-links.js";
import { titleCase, formatNumber, truncateMiddle, formatSignedRate, countBy } from "../../ui/format.js";
import { escapeHtml, dashboardNav, renderDashboardDateTime, metricCard } from "../../ui/layout.js";
import { uniqueSorted } from "../../../lib/builders-learning.js";
import { isPathInside } from "../../../lib/builders-project.js";
import { objectValue, shellQuote, stringValue } from "../../../lib/builders-shared.js";
import { safeFileSegment } from "../../../lib/builders-system.js";
import { type WorkflowDefinition } from "../../../../../../packages/agent-registry/src/schemas.js";
import { listWorkflowRuns, listWorkflowRunsForProject } from "../../../../../../packages/storage/src/postgres.js";
import { type WorkflowGraphReport } from "../../../../../../packages/workflow-inspector/src/index.js";
import { dashboardIcon } from "../../icons.js";
import { dashboardCss } from "../../styles.js";
import { parseDashboardRunLimit } from "../../../numeric-options.js";
import fsSync, { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DashboardGraphExportSummary, DashboardGraphHandoffViewResult, DashboardGraphPreset, DashboardGraphPresetFilters, DashboardWorkflowGraphReport, DashboardWorkflowGraphRun, DashboardWorkflowStageHealth, FocusedStageDeltaSummary } from "../../../commands/daemon-types.js";

export function dashboardGraphPresetHiddenFields(filters: DashboardGraphPresetFilters): string {
  const fields: Record<string, string> = {
    workflow: filters.workflow,
    project: filters.project,
    policyProfile: filters.policyProfile,
    view: filters.view,
    orientation: filters.orientation,
    category: filters.category,
    approval: filters.approval,
    policyStatus: filters.policyStatus,
    runStatus: filters.runStatus,
    runLimit: filters.runLimit,
    runScope: filters.runScope,
    stage: filters.stage
  };
  return Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
}

export function dashboardRunMatchesStatus(status: string, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "active") return status === "queued" || status === "leased" || status === "running";
  return status === filter;
}

export function dashboardWorkflowGraphRunFromStorage(run: Awaited<ReturnType<typeof listWorkflowRuns>>[number]): DashboardWorkflowGraphRun {
  return {
    id: run.id,
    status: run.status,
    workflowId: run.workflowId,
    task: run.task,
    projectName: run.projectName,
    projectRootUri: run.projectRootUri,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    providerOverride: run.providerOverride,
    modelTierOverride: run.modelTierOverride,
    evaluationMetadata: run.evaluationMetadata
  };
}

export function defaultGraphPresetName(filters: DashboardGraphPresetFilters): string {
  const scope = filters.runScope === "all-projects" ? "All Stored" : "Project";
  const view = filters.view === "mind-map" ? "Map" : filters.view === "network" ? "Network" : "Flow";
  const orientation = filters.view === "network" ? ` ${filters.orientation === "radial" ? "Radial" : "Horizontal"}` : "";
  const status = filters.runStatus === "all" ? "Runs" : `${titleCase(filters.runStatus)} Runs`;
  return `${titleCase(filters.workflow.replace(/[-_]+/g, " "))} ${scope} ${status} ${view}${orientation}`;
}

export function distributeLayerY(index: number, total: number, top: number, bottom: number): number {
  if (total <= 1) return (top + bottom) / 2;
  return top + ((bottom - top) * index) / (total - 1);
}

export function filterWorkflowGraphStages(report: WorkflowGraphReport, filters: { category: string; approval: string; policyStatus: string }): WorkflowGraphReport["stages"] {
  return report.stages.filter((stage) => {
    const category = stage.agentCategory ?? "uncategorized";
    const needsApproval = stage.approvalRequired || stage.policyApprovalRequired;
    if (filters.category && category !== filters.category) return false;
    if (filters.approval === "required" && !needsApproval) return false;
    if (filters.approval === "not-required" && needsApproval) return false;
    if (filters.policyStatus === "allowed" && !stage.policyAllowed) return false;
    if (filters.policyStatus === "blocked" && stage.policyAllowed) return false;
    return true;
  });
}

export function focusedStageSuggestFixForm(input: {
  project: string;
  workflowId: string;
  stageId: string;
  disabled: boolean;
}): string {
  return `<form class="inline-form" method="post" action="/api/follow-up">
    <input type="hidden" name="action" value="suggest-stage-fix">
    <input type="hidden" name="project" value="${escapeHtml(input.project)}">
    <input type="hidden" name="workflowId" value="${escapeHtml(input.workflowId)}">
    <input type="hidden" name="stageId" value="${escapeHtml(input.stageId)}">
    <button type="submit"${input.disabled ? " disabled" : ""}>Suggest Fix</button>
  </form>`;
}

export function formatNullableRate(value: number | null): string {
  return value === null ? "n/a" : `${value}%`;
}

export function formatStageHealthTitle(health: DashboardWorkflowStageHealth): string {
  const active = health.queuedTasks + health.runningTasks;
  return `${health.totalTasks} stage tasks: ${health.completedTasks} completed, ${health.failedTasks} failed, ${active} queued/running, ${health.cancelledTasks} cancelled`;
}

export function formatSvgNumber(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function graphHandoffSummaryFromPayload(projectDir: string, jsonPath: string, payload: unknown): DashboardGraphExportSummary | null {
  const record = objectValue(payload);
  if (record.kind !== "agentflow_graph_handoff") return null;
  const workflow = objectValue(record.workflow);
  const project = objectValue(record.project);
  const focusedStage = objectValue(record.focusedStage);
  const generatedAt = stringValue(record.generatedAt);
  const graphPath = stringValue(record.graphPath);
  const workflowId = stringValue(workflow.id);
  const projectName = stringValue(project.name) ?? "project";
  if (!generatedAt || !graphPath || !workflowId) return null;
  const workflowName = stringValue(workflow.name) ?? workflowId;
  const markdownPath = jsonPath.replace(/\.json$/u, ".md");
  return {
    jsonPath,
    markdownPath: fsSync.existsSync(markdownPath) ? markdownPath : null,
    fileName: path.basename(markdownPath),
    generatedAt,
    graphPath,
    projectPath: projectDir,
    workflowId,
    workflowName,
    projectName,
    focusedStageId: stringValue(focusedStage.id) ?? null,
    runCount: Array.isArray(record.runs) ? record.runs.length : 0,
    stageHealthCount: Array.isArray(record.stageHealth) ? record.stageHealth.length : 0
  };
}

export function graphHandoffViewerHref(project: string, fileName: string): string {
  const query = new URLSearchParams({ project, file: fileName });
  return `/graph-handoff?${query.toString()}`;
}

export function isFocusedStageFixRun(run: Awaited<ReturnType<typeof listWorkflowRunsForProject>>[number], workflowId: string, stageId: string): boolean {
  const metadata = run.evaluationMetadata ?? {};
  return metadata.kind === "stage_fix_suggestion"
    && metadata.sourceWorkflowId === workflowId
    && metadata.sourceStageId === stageId;
}

export function isFocusedStageVerificationRun(run: Awaited<ReturnType<typeof listWorkflowRunsForProject>>[number], workflowId: string, stageId: string): boolean {
  const metadata = run.evaluationMetadata ?? {};
  return metadata.kind === "stage_fix_verification"
    && metadata.sourceWorkflowId === workflowId
    && metadata.sourceStageId === stageId;
}

export async function listDashboardGraphHandoffExports(projectDir: string, limit: number): Promise<DashboardGraphExportSummary[]> {
  const exportDir = path.join(projectDir, ".agent-workflow", "exports", "graphs");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(exportDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const summaries = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => {
      const jsonPath = path.join(exportDir, entry.name);
      try {
        const payload = JSON.parse(await fs.readFile(jsonPath, "utf8")) as unknown;
        return graphHandoffSummaryFromPayload(projectDir, jsonPath, payload);
      } catch {
        return null;
      }
    }));
  return summaries
    .filter((summary): summary is DashboardGraphExportSummary => summary !== null)
    .sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt))
    .slice(0, Math.max(0, limit));
}

export async function loadDashboardGraphHandoffView(params: URLSearchParams): Promise<DashboardGraphHandoffViewResult> {
  const projectInput = params.get("project")?.trim() || process.env.AGENTFLOW_DASHBOARD_PROJECT || "templates/project";
  const projectDir = path.resolve(process.cwd(), projectInput);
  const fileInput = params.get("file")?.trim() || "";
  const fileName = path.basename(fileInput);
  if (!fileName || fileName !== fileInput || !fileName.endsWith(".md")) {
    return { ok: false, error: "Missing or invalid graph handoff file name.", projectDir };
  }
  const exportDir = path.resolve(projectDir, ".agent-workflow", "exports", "graphs");
  const markdownPath = path.resolve(exportDir, fileName);
  if (!isPathInside(markdownPath, exportDir)) {
    return { ok: false, error: "Graph handoff file must be inside the project graph export folder.", projectDir };
  }
  try {
    const markdown = await fs.readFile(markdownPath, "utf8");
    const jsonPath = markdownPath.replace(/\.md$/u, ".json");
    let summary: DashboardGraphExportSummary | null = null;
    if (fsSync.existsSync(jsonPath)) {
      try {
        summary = graphHandoffSummaryFromPayload(projectDir, jsonPath, JSON.parse(await fs.readFile(jsonPath, "utf8")) as unknown);
      } catch {
        summary = null;
      }
    }
    return { ok: true, projectDir, fileName, markdownPath, jsonPath: fsSync.existsSync(jsonPath) ? jsonPath : null, markdown, summary };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: false, error: "Graph handoff export was not found.", projectDir };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error), projectDir };
  }
}

export function normalizeDashboardGraphPreset(value: unknown): DashboardGraphPreset | null {
  const record = objectValue(value);
  const filters = objectValue(record.filters);
  const name = stringValue(record.name)?.trim();
  if (!name) return null;
  const id = stringValue(record.id)?.trim() || safeFileSegment(name);
  const now = new Date(0).toISOString();
  return {
    id: safeFileSegment(id),
    name,
    description: stringValue(record.description)?.trim() || "",
    createdAt: stringValue(record.createdAt) ?? now,
    updatedAt: stringValue(record.updatedAt) ?? now,
    filters: normalizeDashboardGraphPresetFilters(filters)
  };
}

export function renderDashboardGraphHandoffView(result: DashboardGraphHandoffViewResult): string {
  const backHref = result.ok
    ? `/workflow-graph?project=${encodeURIComponent(result.projectDir)}`
    : `/workflow-graph${result.projectDir ? `?project=${encodeURIComponent(result.projectDir)}` : ""}`;
  const body = result.ok
    ? `<div class="topbar"><div><a href="${escapeHtml(backHref)}">Graph</a><h1>Graph Handoff</h1><p class="muted">${escapeHtml(result.fileName)}</p></div><div class="actions">${result.summary ? `<a class="button secondary" href="${escapeHtml(result.summary.graphPath)}">Open Saved Graph</a>` : ""}</div></div>
      <section class="panel"><div class="meta-grid compact">
        <div><strong>Project</strong>${escapeHtml(result.projectDir)}</div>
        <div><strong>Markdown</strong>${escapeHtml(result.markdownPath)}</div>
        <div><strong>JSON</strong>${escapeHtml(result.jsonPath ?? "missing")}</div>
        <div><strong>Generated</strong>${result.summary ? renderDashboardDateTime(result.summary.generatedAt) : "unknown"}</div>
      </div>${renderGraphExportLifecycleHtml(result.projectDir, result.summary ? 1 : 0)}</section>
      <section class="panel"><h2>Handoff Markdown</h2><pre class="markdown-view">${escapeHtml(result.markdown)}</pre></section>`
    : `<div class="topbar"><div><a href="${escapeHtml(backHref)}">Graph</a><h1>Graph Handoff</h1><p class="muted">Unable to open the requested export.</p></div></div><section class="panel warn-panel"><pre>${escapeHtml(result.error)}</pre></section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Graph Handoff</title><style>${dashboardCss()}</style></head><body>${dashboardNav("workflow-graph")}<main id="main-content">${body}</main></body></html>`;
}

export function renderFocusedStageDeltaHtml(delta: FocusedStageDeltaSummary): string {
  const statusClass = delta.label === "Improved" ? "good" : delta.label === "Regressed" ? "bad" : "warn";
  return `<div class="stage-delta">
    <div class="stage-delta-card ${statusClass}">
      <strong>After Signal</strong>
      <span>${escapeHtml(delta.label)}</span>
      <small>${delta.verification.total ? "Verification reruns compared with source history." : "Run a source verification to calculate after health."}</small>
    </div>
    <div class="stage-delta-card">
      <strong>Completed</strong>
      <span>${formatNullableRate(delta.verification.completedRate)} <small>${formatSignedRate(delta.completedDelta)}</small></span>
      <small>Before ${formatNullableRate(delta.baseline.completedRate)} from ${formatNumber(delta.baseline.total)} stage tasks</small>
    </div>
    <div class="stage-delta-card">
      <strong>Failed</strong>
      <span>${formatNullableRate(delta.verification.failedRate)} <small>${formatSignedRate(delta.failedDelta)}</small></span>
      <small>Before ${formatNullableRate(delta.baseline.failedRate)} from ${formatNumber(delta.baseline.failed)} failures</small>
    </div>
    <div class="stage-delta-card">
      <strong>Active</strong>
      <span>${formatNullableRate(delta.verification.activeRate)} <small>${formatSignedRate(delta.activeDelta)}</small></span>
      <small>${formatNumber(delta.verification.active)} queued/running, ${formatNumber(delta.verification.cancelled)} cancelled</small>
    </div>
  </div>`;
}

export function renderFocusedStageRunsHtml(report: DashboardWorkflowGraphReport, project: string, clearStageHref: string): string {
  if (!report.focusedStageId) return "";
  const stage = report.stages.find((item) => item.id === report.focusedStageId);
  const health = report.stageHealth.find((item) => item.stageId === report.focusedStageId);
  const verificationRunIds = new Set(report.focusedStageVerificationRuns.map((run) => run.id));
  const baselineStageRuns = report.focusedStageRuns.filter((run) => !verificationRunIds.has(run.runId));
  const verificationStageRuns = report.focusedStageRuns.filter((run) => verificationRunIds.has(run.runId));
  const delta = summarizeFocusedStageDelta(baselineStageRuns, verificationStageRuns);
  const suggestFixForm = focusedStageSuggestFixForm({
    project,
    workflowId: report.workflow.id,
    stageId: report.focusedStageId,
    disabled: !stage
  });
  const rows = report.focusedStageRuns.map((run) => `
    <tr>
      <td><a href="/run?id=${encodeURIComponent(run.runId)}">${escapeHtml(run.runId.slice(0, 8))}</a></td>
      <td><span class="status ${escapeHtml(run.runStatus)}">${escapeHtml(run.runStatus)}</span></td>
      <td><span class="status ${escapeHtml(run.taskStatus)}">${escapeHtml(run.taskStatus)}</span></td>
      <td>${formatNumber(run.attempts)}</td>
      <td>${escapeHtml(run.agentId)}</td>
      <td>${escapeHtml(run.task)}</td>
      <td>${renderDashboardDateTime(run.taskStartedAt ?? run.runStartedAt)}</td>
    </tr>
  `).join("") || '<tr><td colspan="7">No task records found for this stage in the selected run history.</td></tr>';
  const healthText = health ? formatStageHealthTitle(health) : "No task-level stage history found for selected runs.";
  const fixRows = report.focusedStageFixRuns.map((run) => {
    const verifyForm = stageFixVerificationForm({
      project,
      workflowId: report.workflow.id,
      stageId: report.focusedStageId,
      fixRunId: run.id,
      disabled: run.status === "queued" || run.status === "leased" || run.status === "running"
    });
    return `
    <tr>
      <td><a href="/run?id=${encodeURIComponent(run.id)}">${escapeHtml(run.id.slice(0, 8))}</a></td>
      <td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
      <td>${escapeHtml(run.workflowId)}</td>
      <td>${escapeHtml(run.task)}</td>
      <td>${renderDashboardDateTime(run.startedAt)}</td>
      <td>${verifyForm}</td>
    </tr>
  `;
  }).join("") || '<tr><td colspan="6">No suggested fix runs have been queued from this stage yet.</td></tr>';
  const verificationRows = report.focusedStageVerificationRuns.map((run) => {
    const sourceFixRunId = stringValue(run.evaluationMetadata.sourceFixRunId);
    return `
    <tr>
      <td><a href="/run?id=${encodeURIComponent(run.id)}">${escapeHtml(run.id.slice(0, 8))}</a></td>
      <td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
      <td>${sourceFixRunId ? `<a href="/run?id=${encodeURIComponent(sourceFixRunId)}">${escapeHtml(sourceFixRunId.slice(0, 8))}</a>` : "unknown"}</td>
      <td>${escapeHtml(run.task)}</td>
      <td>${renderDashboardDateTime(run.startedAt)}</td>
    </tr>
  `;
  }).join("") || '<tr><td colspan="5">No source workflow verification reruns have been queued from suggested fixes yet.</td></tr>';
  const deltaHtml = renderFocusedStageDeltaHtml(delta);
  return `<section class="panel focused-stage-panel">
    <div class="section-heading">
      <div>
        <h2>Focused Stage: ${escapeHtml(report.focusedStageId)}</h2>
        <span class="muted">${escapeHtml(stage?.goal ?? "Stage details unavailable.")}</span>
      </div>
      <div class="actions">
        ${suggestFixForm}
        <a class="button secondary" href="${escapeHtml(clearStageHref)}">Clear Stage</a>
      </div>
    </div>
    <p class="muted">${escapeHtml(healthText)}</p>
    ${deltaHtml}
    <div class="table-wrap"><table><thead><tr><th>Run</th><th>Run Status</th><th>Stage Status</th><th>Attempts</th><th>Agent</th><th>Task</th><th>Started</th></tr></thead><tbody>${rows}</tbody></table></div>
    <h3>Suggested Fix Runs</h3>
    <p class="muted">Debug runs queued from this focused stage, shown beside the source-stage health signal for quick before/after triage.</p>
    <div class="table-wrap"><table><thead><tr><th>Run</th><th>Status</th><th>Workflow</th><th>Task</th><th>Started</th><th>Verify</th></tr></thead><tbody>${fixRows}</tbody></table></div>
    <h3>Verification Reruns</h3>
    <p class="muted">Source workflow reruns queued after a suggested fix, tagged for stage-health comparison.</p>
    <div class="table-wrap"><table><thead><tr><th>Run</th><th>Status</th><th>Fix Run</th><th>Task</th><th>Started</th></tr></thead><tbody>${verificationRows}</tbody></table></div>
  </section>`;
}

export function renderGraphExportLifecycleHtml(projectDir: string, exportCount: number): string {
  const exportDir = path.join(projectDir, ".agent-workflow", "exports", "graphs");
  const quotedExportDir = shellQuote(exportDir);
  const quotedProjectDir = shellQuote(projectDir);
  const commands = [
    `du -sh ${quotedExportDir}`,
    `find ${quotedExportDir} -maxdepth 1 -type f \\( -name '*.md' -o -name '*.json' \\) -print | sort | tail -40`,
    `find ${quotedExportDir} -maxdepth 1 -type f \\( -name '*.md' -o -name '*.json' \\) -mtime +30 -print`,
    `tar -czf agentflow-graph-handoffs.tgz -C ${quotedProjectDir} .agent-workflow/exports/graphs`
  ].join("\n");
  return `<details class="lifecycle-help">
    <summary>Export lifecycle commands</summary>
    <p class="muted">${formatNumber(exportCount)} recent handoff export${exportCount === 1 ? "" : "s"} shown. These commands inspect, preview prune candidates, or package graph handoffs without deleting files.</p>
    <pre>${escapeHtml(commands)}</pre>
  </details>`;
}

export function renderGraphPresetsHtml(presets: DashboardGraphPreset[], current: DashboardGraphPresetFilters): string {
  const hiddenFields = dashboardGraphPresetHiddenFields(current);
  const rows = presets.map((preset) => {
    const href = graphPresetHref(preset);
    return `<tr>
      <td><strong>${escapeHtml(preset.name)}</strong>${preset.description ? `<br><span class="muted">${escapeHtml(preset.description)}</span>` : ""}</td>
      <td>${escapeHtml(preset.filters.workflow)}</td>
      <td>${escapeHtml(preset.filters.view)} / ${escapeHtml(preset.filters.orientation)}</td>
      <td>${escapeHtml(preset.filters.runScope === "all-projects" ? "all projects" : "selected project")}</td>
      <td>${escapeHtml(preset.filters.runStatus)} / ${escapeHtml(preset.filters.runLimit)}</td>
      <td>${renderDashboardDateTime(preset.updatedAt)}</td>
      <td><a class="button secondary" href="${escapeHtml(href)}">Open</a></td>
      <td><form method="post" action="/api/graph-preset-delete" class="inline-form compact-form">${hiddenFields}<input type="hidden" name="presetId" value="${escapeHtml(preset.id)}"><button class="secondary" type="submit">Delete</button></form></td>
    </tr>`;
  }).join("") || '<tr><td colspan="8">No saved graph presets yet.</td></tr>';
  return `<section class="panel capture-hide">
    <div class="section-heading">
      <div>
        <h2>Graph Presets</h2>
        <span class="muted">Save the current workflow, filters, run scope, and graph layout as project-local Agent Workflow state.</span>
      </div>
    </div>
    <form method="post" action="/api/graph-preset-save" class="workflow-form compact-form">
      ${hiddenFields}
      <label>Name<input name="name" value="${escapeHtml(defaultGraphPresetName(current))}" required></label>
      <label class="wide">Description<input name="description" placeholder="Optional note for the team"></label>
      <div class="form-actions"><button type="submit">Save Preset</button></div>
    </form>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Workflow</th><th>View</th><th>Run Scope</th><th>Runs</th><th>Updated</th><th>Open</th><th>Remove</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

export function renderNetworkLabel(node: { label: string; caption?: string; labelX?: number; labelY?: number; labelAnchor?: string }): string {
  if (node.labelX === undefined || node.labelY === undefined || !node.labelAnchor) return "";
  return `<text class="network-label" x="${formatSvgNumber(node.labelX)}" y="${formatSvgNumber(node.labelY)}" text-anchor="${node.labelAnchor}">${escapeHtml(truncateMiddle(node.caption ?? node.label, 24))}</text>`;
}

export function renderNetworkOrientationActions(orientation: "horizontal" | "radial", horizontalHref: string, radialHref: string): string {
  return `<div class="network-toolbar"><div><strong>Network Orientation</strong><span>Horizontal is best for stage progression. Radial web is best for dependency shape.</span></div><div class="network-toolbar-actions"><div class="segmented-actions compact-segments" role="group" aria-label="Network orientation"><a class="segment ${orientation === "horizontal" ? "active" : ""}" href="${escapeHtml(horizontalHref)}"><strong>Horizontal</strong><span>Layered</span></a><a class="segment ${orientation === "radial" ? "active" : ""}" href="${escapeHtml(radialHref)}"><strong>Radial</strong><span>Web</span></a></div><button type="button" class="network-fullscreen-toggle secondary compact-button" aria-pressed="false">${dashboardIcon("maximize")}Full screen</button></div></div>`;
}

export function renderNetworkStateExplainer(isRadial: boolean): string {
  const layoutText = isRadial
    ? "Read outward from the workflow core through stage, agent, and run rings."
    : "Read left to right from workflow input through stages, agents, and run outputs.";
  const items = [
    ["Layout", layoutText],
    ["Solid Lines", "Primary stage-to-agent and agent-to-run paths."],
    ["Dashed Lines", "Sequence or supporting subagent connections."],
    ["Health Rings", "Stage task outcomes: completed, failed, queued/running, and cancelled."],
    ["Click Targets", "Stage nodes focus history; run nodes open run details."]
  ];
  return `<div class="network-explainer">${items.map(([label, text]) => `
    <div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(text)}</span></div>
  `).join("")}</div>`;
}

export function renderRecentGraphExportsHtml(exports: DashboardGraphExportSummary[], project: string): string {
  const projectDir = path.resolve(process.cwd(), project);
  const rows = exports.map((item) => `
    <tr>
      <td>${renderDashboardDateTime(item.generatedAt)}</td>
      <td><strong>${escapeHtml(item.workflowId)}</strong><br><span class="muted">${escapeHtml(item.workflowName)}</span></td>
      <td>${escapeHtml(item.focusedStageId ?? "all stages")}</td>
      <td>${formatNumber(item.runCount)}</td>
      <td>${formatNumber(item.stageHealthCount)}</td>
      <td><a class="button secondary" href="${escapeHtml(item.graphPath)}">Open Graph</a></td>
      <td>${item.markdownPath ? `<a href="${escapeHtml(graphHandoffViewerHref(item.projectPath, item.fileName))}">View</a><br><code>${escapeHtml(item.markdownPath)}</code>` : "<code>missing</code>"}</td>
      <td><code>${escapeHtml(item.jsonPath)}</code></td>
    </tr>
  `).join("") || '<tr><td colspan="8">No graph handoff exports yet. Use Export Handoff to save the current graph state beside project reports.</td></tr>';
  return `<section class="panel capture-hide">
    <div class="section-heading">
      <div>
        <h2>Recent Graph Handoffs</h2>
        <span class="muted">Project-local graph exports that can be reopened, shared, or attached to a review.</span>
      </div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Generated</th><th>Workflow</th><th>Stage</th><th>Runs</th><th>Health Rows</th><th>Graph</th><th>Markdown</th><th>JSON</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${renderGraphExportLifecycleHtml(projectDir, exports.length)}
  </section>`;
}

export function renderStageHealthRing(radius: number, health: DashboardWorkflowStageHealth): string {
  if (health.totalTasks <= 0) return "";
  const ringRadius = radius + 7;
  const circumference = Math.PI * 2 * ringRadius;
  const segments = [
    { className: "completed", value: health.completedTasks },
    { className: "failed", value: health.failedTasks },
    { className: "active", value: health.queuedTasks + health.runningTasks },
    { className: "cancelled", value: health.cancelledTasks }
  ].filter((segment) => segment.value > 0);
  let offset = 0;
  const gap = segments.length > 1 ? 2.2 : 0;
  return segments.map((segment) => {
    const length = Math.max(0, (segment.value / health.totalTasks) * circumference - gap);
    const svg = `<circle class="network-health-ring ${segment.className}" r="${formatSvgNumber(ringRadius)}" fill="none" stroke-dasharray="${formatSvgNumber(length)} ${formatSvgNumber(circumference - length)}" stroke-dashoffset="${formatSvgNumber(-offset)}"></circle>`;
    offset += length + gap;
    return svg;
  }).join("");
}

export function renderWorkflowGraphDashboardHtml(report: DashboardWorkflowGraphReport, workflows: WorkflowDefinition[], params: URLSearchParams): string {
  const workflowOptions = workflows
    .filter((workflow) => workflow.triggers.manual)
    .map((workflow) => `<option value="${escapeHtml(workflow.id)}"${workflow.id === report.workflow.id ? " selected" : ""}>${escapeHtml(workflow.name)} (${escapeHtml(workflow.id)})</option>`)
    .join("");
  const projectValue = params.get("project")?.trim() || process.env.AGENTFLOW_DASHBOARD_PROJECT || "templates/project";
  const policyValue = params.get("policyProfile")?.trim() || report.project.policyProfile;
  const viewParam = params.get("view");
  const view = viewParam === "mind-map" || viewParam === "network" ? viewParam : "graph";
  const orientation: "horizontal" | "radial" = params.get("orientation") === "radial" ? "radial" : "horizontal";
  const categoryFilter = params.get("category")?.trim() || "";
  const approvalFilter = params.get("approval")?.trim() || "all";
  const policyFilter = params.get("policyStatus")?.trim() || "all";
  const runLimit = String(parseDashboardRunLimit(params.get("runLimit") ?? "50", 50));
  const runScope = report.runScope;
  const runStatusFilter = report.runStatusFilter;
  const focusedStageId = report.focusedStageId;
  const capture = params.get("capture") === "1";
  const baseHrefOptions = { orientation, category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter, runLimit, runStatus: runStatusFilter, runScope, capture, stage: focusedStageId };
  const graphHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view: "graph" });
  const mindMapHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view: "mind-map" });
  const networkHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view: "network" });
  const networkHorizontalHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view: "network", orientation: "horizontal" });
  const networkRadialHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view: "network", orientation: "radial" });
  const captureHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view, capture: true });
  const exitCaptureHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view, capture: false });
  const clearStageHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view, stage: "" });
  const jsonHref = workflowGraphApiHref(report.workflow.id, projectValue, policyValue, { category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter, runLimit, runStatus: runStatusFilter, runScope, stage: focusedStageId });
  const filteredStages = filterWorkflowGraphStages(report, { category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter });
  const categories = uniqueSorted(report.stages.map((stage) => stage.agentCategory ?? "uncategorized"));
  const stageCards = filteredStages.map((stage, index) => {
    const subagents = stage.subagents.length
      ? stage.subagents.map((subagent) => `<span class="chip">${escapeHtml(subagent.id)}</span>`).join("")
      : `<span class="muted">No subagents</span>`;
    const className = stage.policyAllowed ? stage.approvalRequired || stage.policyApprovalRequired ? "warn" : "good" : "bad";
    return `<div class="graph-stage ${className}">
      <div class="graph-step">${index + 1}</div>
      <div>
        <h3>${escapeHtml(stage.id)}</h3>
        <p>${escapeHtml(stage.goal)}</p>
        <p class="muted">${escapeHtml(stagePatternExplanation(stage))}</p>
        <div class="meta-grid compact">
          <div><strong>Agent</strong>${escapeHtml(stage.agentDisplayName ?? stage.agentId)}</div>
          <div><strong>Pattern</strong>${escapeHtml(stage.pattern.type)}</div>
          <div><strong>Tier</strong>${escapeHtml(stage.modelTier ?? "not set")}</div>
          <div><strong>Context</strong>${formatNumber(stage.contextMaxTokens)} tokens</div>
          <div><strong>Policy</strong>${stage.policyAllowed ? "allowed" : "blocked"}</div>
          <div><strong>Gate</strong>${escapeHtml(stage.pattern.promotionGate)}</div>
        </div>
        <div class="chip-row">${subagents}</div>
      </div>
    </div>`;
  }).join("");
  const stageRows = filteredStages.map((stage) => `
    <tr id="${escapeHtml(stageAnchorId(stage.id))}"><td>${stage.order}</td><td>${escapeHtml(stage.id)}</td><td>${escapeHtml(stage.agentId)}</td><td>${escapeHtml(stage.pattern.type)}<br><span class="muted">${escapeHtml(stage.pattern.promotionGate)}</span></td><td>${escapeHtml(stage.subagents.map((item) => item.id).join(", ") || "none")}</td><td>${formatNumber(stage.contextMaxTokens)}</td><td>${stage.approvalRequired || stage.policyApprovalRequired ? "yes" : "no"}</td><td>${stage.policyAllowed ? "allowed" : "blocked"}</td></tr>
  `).join("") || '<tr><td colspan="8">No stages match the selected filters.</td></tr>';
  const warnings = [...report.warnings, ...report.runWarnings];
  const warningHtml = warnings.length
    ? `<section class="panel warn-panel"><h2>Warnings</h2><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></section>`
    : "";
  const visual = view === "mind-map"
    ? `<section class="panel"><h2>Mind Map</h2>${renderWorkflowMindMapHtml(report, filteredStages)}</section>`
    : view === "network"
      ? `<section class="panel network-panel"><h2>Network Map</h2>${renderNetworkOrientationActions(orientation, networkHorizontalHref, networkRadialHref)}${renderWorkflowNetworkHtml(report, filteredStages, orientation, (stageId) => workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view: "network", stage: stageId }), focusedStageId)}</section>`
      : `<section class="panel"><h2>Connection Graph</h2><div class="graph-flow">${stageCards}</div></section>`;
  const categoryOptions = [`<option value="">all</option>`, ...categories.map((category) => `<option value="${escapeHtml(category)}"${categoryFilter === category ? " selected" : ""}>${escapeHtml(category)}</option>`)].join("");
  const approvalOptions = ["all", "required", "not-required"].map((value) => `<option value="${value}"${approvalFilter === value ? " selected" : ""}>${value}</option>`).join("");
  const policyOptions = ["all", "allowed", "blocked"].map((value) => `<option value="${value}"${policyFilter === value ? " selected" : ""}>${value}</option>`).join("");
  const runStatusOptions = ["all", "active", "failed", "completed", "queued", "leased", "running", "cancelled"].map((value) => `<option value="${value}"${runStatusFilter === value ? " selected" : ""}>${value}</option>`).join("");
  const runScopeOptions = [
    { value: "project", label: "selected project" },
    { value: "all-projects", label: "all projects" }
  ].map((item) => `<option value="${item.value}"${runScope === item.value ? " selected" : ""}>${item.label}</option>`).join("");
  const captureActions = capture
    ? `<a class="button secondary" href="${escapeHtml(exitCaptureHref)}">Exit Capture</a><button type="button" onclick="window.print()">Print</button>`
    : `<a class="button secondary" href="${escapeHtml(captureHref)}">Capture View</a>`;
  const exportHandoffForm = workflowGraphHandoffExportForm({
    workflowId: report.workflow.id,
    project: projectValue,
    policyProfile: policyValue,
    view,
    orientation,
    category: categoryFilter,
    approval: approvalFilter,
    policyStatus: policyFilter,
    runStatus: runStatusFilter,
    runLimit,
    runScope,
    stage: focusedStageId
  });
  const quickRunLinks = [
    { label: "All Stored Runs", runStatus: "all", runLimit: "50", runScope: "all-projects", category: "", approval: "all", policyStatus: "all" },
    { label: "All Project Runs", runStatus: "all", runLimit: "50", runScope: "project", category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter },
    { label: "Active Project Runs", runStatus: "active", runLimit: "50", runScope: "project", category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter },
    { label: "Failed Project Runs", runStatus: "failed", runLimit: "50", runScope: "project", category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter },
    { label: "Definition Only", runStatus: "all", runLimit: "0", runScope, category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter }
  ].map((item) => {
    const active = runStatusFilter === item.runStatus && runLimit === item.runLimit && runScope === item.runScope && categoryFilter === item.category && approvalFilter === item.approval && policyFilter === item.policyStatus;
    const href = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view, runLimit: item.runLimit, runStatus: item.runStatus, runScope: item.runScope as "project" | "all-projects", category: item.category, approval: item.approval, policyStatus: item.policyStatus });
    return `<a class="button ${active ? "" : "secondary"}" href="${escapeHtml(href)}">${escapeHtml(item.label)}</a>`;
  }).join("");
  const runScopeLabel = runScope === "all-projects" ? "all stored projects" : "selected project";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Graph</title><style>${dashboardCss()}</style></head><body${capture ? ' class="capture-page"' : ""}>
  ${capture ? "" : dashboardNav("workflow-graph")}
  <main id="main-content">
    <div class="topbar"><div>${capture ? "" : '<a href="/">Dashboard</a>'}<h1>Agent Graph</h1><p class="muted">Read-only view of workflow stages, primary agents, subagents, context budgets, approvals, and policy fit.</p></div><div class="actions print-hide"><a class="button secondary capture-hide" href="${escapeHtml(jsonHref)}">JSON</a>${exportHandoffForm}${captureActions}</div></div>
    <section class="panel capture-hide"><form method="get" class="workflow-form"><input type="hidden" name="view" value="${escapeHtml(view)}"><input type="hidden" name="orientation" value="${escapeHtml(orientation)}"><input type="hidden" name="stage" value="${escapeHtml(focusedStageId)}"><label>Workflow<select name="workflow">${workflowOptions}</select></label><label class="wide">Project path<input name="project" value="${escapeHtml(projectValue)}"></label><label>Policy profile<input name="policyProfile" value="${escapeHtml(policyValue)}"></label><label>Agent category<select name="category">${categoryOptions}</select></label><label>Approval<select name="approval">${approvalOptions}</select></label><label>Policy status<select name="policyStatus">${policyOptions}</select></label><label>Run status<select name="runStatus">${runStatusOptions}</select></label><label>Run scope<select name="runScope">${runScopeOptions}</select></label><label>Runs shown<input name="runLimit" inputmode="numeric" value="${escapeHtml(runLimit)}"></label><div class="form-actions"><button type="submit">Render Graph</button></div></form><div class="actions quick-actions">${quickRunLinks}</div></section>
    ${warningHtml}
    <section class="panel"><div class="metric-grid">
      ${metricCard("Workflow", report.workflow.id, report.workflow.name)}
      ${metricCard("Stages", report.totals.stages, `${report.totals.subagentLinks} subagent links`)}
      ${metricCard("Visible", filteredStages.length, "stages after filters")}
      ${metricCard("Runs", report.runs.length, `${escapeHtml(runStatusFilter)} ${escapeHtml(report.workflow.id)} runs across ${escapeHtml(runScopeLabel)}`)}
      ${metricCard("Context Budget", formatNumber(report.totals.contextBudgetTokens), "compiled source-token ceiling")}
      ${metricCard("Approvals", report.totals.approvalStages, `${report.totals.blockedStages} blocked stages`)}
    </div></section>
    ${renderGraphPresetsHtml(report.graphPresets, {
      workflow: report.workflow.id,
      project: projectValue,
      policyProfile: policyValue,
      view,
      orientation,
      category: categoryFilter,
      approval: approvalFilter,
      policyStatus: policyFilter,
      runStatus: runStatusFilter,
      runLimit,
      runScope,
      stage: focusedStageId
    })}
    <section class="panel capture-hide">
      <div class="section-heading">
        <div>
          <h2>Graph View</h2>
          <span class="muted">Switch between implementation flow, planning map, and run history network.</span>
        </div>
      </div>
      <div class="segmented-actions" role="group" aria-label="Graph view">
        <a class="segment ${view === "graph" ? "active" : ""}" href="${escapeHtml(graphHref)}"><strong>Flow</strong><span>Stages in order</span></a>
        <a class="segment ${view === "mind-map" ? "active" : ""}" href="${escapeHtml(mindMapHref)}"><strong>Map</strong><span>Workflow branches</span></a>
        <a class="segment ${view === "network" ? "active" : ""}" href="${escapeHtml(networkHref)}"><strong>Network</strong><span>Runs and agents</span></a>
      </div>
    </section>
    ${visual}
    ${renderRecentGraphExportsHtml(report.recentGraphExports, projectValue)}
    ${renderFocusedStageRunsHtml(report, projectValue, clearStageHref)}
    <section class="panel"><h2>Stage Matrix</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Stage</th><th>Agent</th><th>Pattern</th><th>Subagents</th><th>Tokens</th><th>Approval</th><th>Policy</th></tr></thead><tbody>${stageRows}</tbody></table></div></section>
    <section class="panel"><h2>Mermaid</h2><pre>${escapeHtml(report.mermaid)}</pre></section>
  </main></body></html>`;
}

export function renderWorkflowMindMapHtml(report: WorkflowGraphReport, stages: WorkflowGraphReport["stages"]): string {
  const branches = stages.map((stage) => {
    const subagents = stage.subagents.length
      ? stage.subagents.map((subagent) => `<span class="chip">${escapeHtml(subagent.displayName ?? subagent.id)}</span>`).join("")
      : '<span class="muted">No subagents</span>';
    const state = stage.policyAllowed ? stage.approvalRequired || stage.policyApprovalRequired ? "warn" : "good" : "bad";
    return `<article class="mind-node ${state}">
      <strong>${formatNumber(stage.order)}. ${escapeHtml(stage.id)}</strong>
      <span>${escapeHtml(stage.agentDisplayName ?? stage.agentId)}</span>
      <small>${escapeHtml(stage.goal)}</small>
      <small>${escapeHtml(stagePatternExplanation(stage))}</small>
      <div class="mind-node-meta">
        <span>${escapeHtml(stage.pattern.type)}</span>
        <span>${formatNumber(stage.contextMaxTokens)} tokens</span>
        <span>${stage.approvalRequired || stage.policyApprovalRequired ? "approval" : "no approval"}</span>
        <span>${escapeHtml(stage.pattern.promotionGate)}</span>
        <span>${stage.policyAllowed ? "allowed" : "blocked"}</span>
      </div>
      <div class="chip-row">${subagents}</div>
    </article>`;
  }).join("") || '<p class="muted">No stages match the selected filters.</p>';
  return `<div class="mind-map">
    <div class="mind-center">
      <strong>${escapeHtml(report.workflow.name)}</strong>
      <span>${escapeHtml(report.workflow.id)}</span>
      <small>${formatNumber(report.totals.stages)} stages &middot; ${formatNumber(report.totals.subagentLinks)} subagent links</small>
    </div>
    <div class="mind-branches">${branches}</div>
  </div>`;
}

export function renderWorkflowNetworkHtml(report: DashboardWorkflowGraphReport, stages: WorkflowGraphReport["stages"], orientation: "horizontal" | "radial", stageHref: (stageId: string) => string, focusedStageId: string): string {
  if (!stages.length) return '<p class="muted">No stages match the selected filters.</p>';
  const isRadial = orientation === "radial";
  const width = 1120;
  const height = isRadial ? 760 : 680;
  const centerX = width / 2;
  const centerY = height / 2;
  const stageRadius = 148;
  const agentRadius = 252;
  const runRadius = 338;
  const layerTop = 118;
  const layerBottom = 560;
  const workflowX = 118;
  const stageX = 350;
  const agentX = 650;
  const runX = 982;
  const palette: Record<string, string> = {
    automatic: "#f59e0b",
    core: "#38bdf8",
    development: "#22d3ee",
    operations: "#a855f7",
    product: "#f43f5e",
    uncategorized: "#94a3b8"
  };
  const runPalette: Record<string, string> = {
    completed: "#22c55e",
    failed: "#ef4444",
    running: "#f59e0b",
    queued: "#f59e0b",
    cancelled: "#94a3b8"
  };
  type NetworkNode = { id: string; label: string; title: string; x: number; y: number; r: number; color: string; kind: string; href?: string; labelX?: number; labelY?: number; labelAnchor?: string; caption?: string; stageId?: string; stageHealth?: DashboardWorkflowStageHealth; focused?: boolean };
  const nodeById = new Map<string, NetworkNode>();
  const links: Array<{ from: string; to: string; width: number; dashed?: boolean; className?: string; title?: string; handoffId?: string; status?: string }> = [];
  const requestSizedRadius = (baseRadius: number, requestCount: number, maxExtra: number): number => baseRadius + Math.min(maxExtra, Math.sqrt(Math.max(0, requestCount)) * 3.2);
  const stageNodeLabel = (stageId: string): string => truncateMiddle(stageId, 10);
  const stageHealthById = new Map(report.stageHealth.map((health) => [health.stageId, health]));
  const radialPoint = (angle: number, radius: number): { x: number; y: number } => ({
    x: centerX + Math.cos(angle) * radius,
    y: centerY + Math.sin(angle) * radius
  });
  const ringAngle = (index: number, total: number, offset = -Math.PI / 2): number => offset + (Math.PI * 2 * index) / Math.max(total, 1);
  const applyRadialLabel = (node: NetworkNode, angle: number, offset: number): void => {
    node.labelX = node.x + Math.cos(angle) * (node.r + offset);
    node.labelY = node.y + Math.sin(angle) * (node.r + offset) + 4;
    const horizontal = Math.cos(angle);
    node.labelAnchor = Math.abs(horizontal) < 0.24 ? "middle" : horizontal > 0 ? "start" : "end";
  };
  nodeById.set("workflow", {
    id: "workflow",
    label: isRadial ? "core" : report.workflow.id,
    caption: report.workflow.id,
    title: `${report.workflow.name} workflow`,
    x: isRadial ? centerX : workflowX,
    y: isRadial ? centerY : height / 2,
    r: isRadial ? 38 : 34,
    color: "#38bdf8",
    kind: "workflow",
    labelX: isRadial ? centerX : workflowX,
    labelY: isRadial ? centerY + 62 : height / 2 + 58,
    labelAnchor: "middle"
  });

  const agentEntries = new Map<string, { id: string; label: string; category: string; stageIds: Set<string>; isPrimary: boolean }>();
  stages.forEach((stage, index) => {
    const angle = ringAngle(index, stages.length);
    const point = isRadial ? radialPoint(angle, stageRadius) : { x: stageX, y: distributeLayerY(index, stages.length, layerTop, layerBottom) };
    const stageNodeId = `stage:${stage.id}`;
    const stageNode: NetworkNode = {
      id: stageNodeId,
      label: stageNodeLabel(stage.id),
      title: `${stage.id}: ${stage.goal} (${stage.pattern.type}; gate ${stage.pattern.promotionGate})`,
      x: point.x,
      y: point.y,
      r: 22,
      color: stage.policyAllowed ? (stage.approvalRequired || stage.policyApprovalRequired ? "#f59e0b" : "#2563eb") : "#dc2626",
      kind: "stage",
      href: stageHref(stage.id),
      stageId: stage.id,
      stageHealth: stageHealthById.get(stage.id),
      focused: focusedStageId === stage.id
    };
    if (stageNode.stageHealth) stageNode.title = `${stageNode.title} - ${formatStageHealthTitle(stageNode.stageHealth)}`;
    nodeById.set(stageNodeId, stageNode);
    links.push({ from: "workflow", to: stageNodeId, width: 1.2, className: "signal" });
    if (!report.handoffPackets.length) {
      for (const dependency of stage.dependsOn) links.push({ from: `stage:${dependency}`, to: stageNodeId, width: 2.8, dashed: true, className: "sequence" });
    }
    const primary = agentEntries.get(stage.agentId) ?? {
      id: stage.agentId,
      label: stage.agentDisplayName ?? stage.agentId,
      category: stage.agentCategory ?? "uncategorized",
      stageIds: new Set<string>(),
      isPrimary: true
    };
    primary.stageIds.add(stageNodeId);
    primary.isPrimary = true;
    agentEntries.set(stage.agentId, primary);
    links.push({ from: stageNodeId, to: `agent:${stage.agentId}`, width: 2.2, className: "signal" });
    stage.subagents.forEach((subagent) => {
      const entry = agentEntries.get(subagent.id) ?? {
        id: subagent.id,
        label: subagent.displayName ?? subagent.id,
        category: subagent.category ?? "uncategorized",
        stageIds: new Set<string>(),
        isPrimary: false
      };
      entry.stageIds.add(stageNodeId);
      agentEntries.set(subagent.id, entry);
      links.push({ from: stageNodeId, to: `agent:${subagent.id}`, width: 1.7, dashed: true, className: "support" });
    });
  });

  for (const handoff of report.handoffPackets) {
    if (!nodeById.has(`stage:${handoff.sourceStageId}`) || !nodeById.has(`stage:${handoff.destinationStageId}`)) continue;
    const duration = handoff.completedAt && handoff.proposedAt ? Math.max(0, Date.parse(handoff.completedAt) - Date.parse(handoff.proposedAt)) : null;
    links.push({
      from: `stage:${handoff.sourceStageId}`,
      to: `stage:${handoff.destinationStageId}`,
      width: handoff.status === "failed" ? 3.6 : 3,
      dashed: handoff.status === "retrying" || handoff.status === "failed",
      className: `handoff handoff-${handoff.status}`,
      handoffId: handoff.id,
      status: handoff.status,
      title: `${handoff.senderAgentId} → ${handoff.receiverAgentId}; ${handoff.status}; ${handoff.transferredArtifacts.length} artifact(s); ${handoff.events.filter((event) => event.status === "retrying").length} retry event(s)${duration === null ? "" : `; ${duration}ms`}`
    });
  }

  const agents = [...agentEntries.values()].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.category.localeCompare(b.category) || a.id.localeCompare(b.id);
  });
  const categories = uniqueSorted(agents.map((agent) => agent.category || "uncategorized"));
  agents.forEach((agent, index) => {
    const angle = ringAngle(index, agents.length, -Math.PI / 2 + Math.PI / Math.max(agents.length, 8));
    const point = isRadial
      ? radialPoint(angle, agent.isPrimary ? agentRadius - 18 : agentRadius + 22)
      : { x: agentX + (agent.isPrimary ? -28 : 34), y: distributeLayerY(index, agents.length, layerTop, layerBottom) };
    const agentNode: NetworkNode = {
      id: `agent:${agent.id}`,
      label: agent.id,
      title: `${agent.label} (${agent.category})`,
      x: point.x,
      y: point.y,
      r: agent.isPrimary ? 18 : 11,
      color: palette[agent.category] ?? palette.uncategorized,
      kind: agent.isPrimary ? "primary agent" : "subagent"
    };
    if (agent.isPrimary) {
      if (isRadial) applyRadialLabel(agentNode, angle, 10);
      else {
        agentNode.labelX = agentNode.x + 30;
        agentNode.labelY = agentNode.y + 4;
        agentNode.labelAnchor = "start";
      }
    }
    nodeById.set(`agent:${agent.id}`, agentNode);
  });

  const runs = report.runs.slice(0, 36);
  runs.forEach((run, index) => {
    const angle = ringAngle(index, Math.max(runs.length, 1), -Math.PI / 2 + Math.PI / Math.max(runs.length, 10));
    const point = isRadial ? radialPoint(angle, runRadius) : { x: runX, y: distributeLayerY(index, Math.max(runs.length, 1), layerTop, layerBottom) };
    const active = run.status === "queued" || run.status === "leased" || run.status === "running";
    const runNode: NetworkNode = {
      id: `run:${run.id}`,
      label: active ? run.status.slice(0, 1).toUpperCase() : "",
      title: `${run.status}: ${run.task} (${run.id}) - ${run.projectName}`,
      x: point.x,
      y: point.y,
      r: active ? 14 : run.status === "failed" ? 11 : 8,
      color: runPalette[run.status] ?? "#64748b",
      kind: "run",
      href: `/run?id=${encodeURIComponent(run.id)}`
    };
    if (active || run.status === "failed") {
      if (isRadial) applyRadialLabel(runNode, angle, 10);
      else {
        runNode.labelX = runNode.x + 22;
        runNode.labelY = runNode.y + 4;
        runNode.labelAnchor = "start";
      }
    }
    nodeById.set(`run:${run.id}`, runNode);
    const sourceAgents = agents.filter((agent) => agent.isPrimary).slice(0, 5);
    sourceAgents.forEach((agent) => {
      links.push({ from: `agent:${agent.id}`, to: `run:${run.id}`, width: run.status === "failed" ? 1.8 : active ? 1.1 : 1.25, dashed: !active, className: "outcome" });
    });
  });

  const inboundCounts = countBy(links.map((link) => link.to));
  nodeById.forEach((node) => {
    const requestCount = inboundCounts[node.id] ?? 0;
    if (!requestCount) return;
    const originalRadius = node.r;
    const maxExtra = node.kind === "run" ? 9 : node.kind === "subagent" ? 11 : node.kind === "primary agent" ? 12 : 7;
    node.r = requestSizedRadius(originalRadius, requestCount, maxExtra);
    node.title = `${node.title} - ${requestCount} incoming request${requestCount === 1 ? "" : "s"}`;
    if (isRadial && node.kind !== "stage" && node.kind !== "workflow" && node.labelX !== undefined && node.labelY !== undefined) {
      const angle = Math.atan2(node.y - centerY, node.x - centerX);
      applyRadialLabel(node, angle, node.kind === "stage" ? 14 : 10);
    }
    if (!isRadial && node.kind === "primary agent") node.labelX = node.x + node.r + 12;
    if (!isRadial && node.kind === "run" && node.labelX !== undefined) node.labelX = node.x + node.r + 10;
  });

  const linkSvg = links.map((link, index) => {
    const from = nodeById.get(link.from);
    const to = nodeById.get(link.to);
    if (!from || !to) return "";
    const dash = link.dashed ? ' stroke-dasharray="7 7"' : "";
    const classes = [link.className, link.dashed ? "dashed" : undefined].filter(Boolean).join(" ");
    const className = classes ? ` class="${escapeHtml(classes)}"` : "";
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const pull = link.from === "workflow" || link.to === "workflow" ? 0.42 : 0.22;
    const controlOneX = isRadial ? from.x + (centerX - from.x) * pull : midX;
    const controlOneY = isRadial ? from.y + (centerY - from.y) * pull : from.y;
    const controlTwoX = isRadial ? to.x + (centerX - to.x) * pull : midX;
    const controlTwoY = isRadial ? to.y + (centerY - to.y) * pull : midY;
    const pathData = `M ${formatSvgNumber(from.x)} ${formatSvgNumber(from.y)} C ${formatSvgNumber(controlOneX)} ${formatSvgNumber(controlOneY)}, ${formatSvgNumber(controlTwoX)} ${formatSvgNumber(controlTwoY)}, ${formatSvgNumber(to.x)} ${formatSvgNumber(to.y)}`;
    const delay = formatSvgNumber((index % 9) * 0.34);
    const duration = formatSvgNumber(2.4 + (index % 5) * 0.22);
    const animateSignal = link.className !== "outcome" || index % 18 === 0;
    return `<g class="network-synapse" data-from="${escapeHtml(link.from)}" data-to="${escapeHtml(link.to)}"${link.handoffId ? ` data-handoff-id="${escapeHtml(link.handoffId)}" data-handoff-status="${escapeHtml(link.status ?? "")}"` : ""} style="--signal-delay:${delay}s">
      ${link.title ? `<title>${escapeHtml(link.title)}</title>` : ""}
      <path${className} d="${pathData}" stroke-width="${link.width}"${dash}></path>
      ${animateSignal ? `<path class="network-signal-trail" d="${pathData}" pathLength="1"></path>
      <circle class="network-packet" r="3.6">
        <animateMotion dur="${duration}s" begin="${delay}s" repeatCount="indefinite" path="${pathData}"></animateMotion>
      </circle>` : ""}
    </g>`;
  }).join("");
  const nodeSvg = [...nodeById.values()].map((node) => {
    const nodeClasses = ["network-node", `network-${node.kind.replace(/\s+/g, "-")}`, node.focused ? "network-focused" : ""].filter(Boolean).join(" ");
    const body = `<g class="${escapeHtml(nodeClasses)}" data-node-id="${escapeHtml(node.id)}" style="color:${escapeHtml(node.color)}" transform="translate(${formatSvgNumber(node.x)} ${formatSvgNumber(node.y)})">
      <title>${escapeHtml(node.title)}</title>
      ${node.kind === "stage" && node.stageHealth ? renderStageHealthRing(node.r, node.stageHealth) : ""}
      <circle r="${node.r}"></circle>
      ${node.kind === "stage" || node.kind === "workflow" || (node.kind === "run" && node.label) ? `<text text-anchor="middle" dominant-baseline="central">${escapeHtml(node.label)}</text>` : ""}
    </g>`;
    return node.href ? `<a href="${escapeHtml(node.href)}" aria-label="${escapeHtml(node.title)}">${body}</a>` : body;
  }).join("");
  const labelSvg = [...nodeById.values()]
    .filter((node) => node.kind === "workflow" || node.kind === "primary agent" || node.labelX !== undefined)
    .map((node) => renderNetworkLabel(node))
    .join("");
  const layerLabels = [
    ...(isRadial
      ? [
          { x: 62, y: 54, label: "core", anchor: "start" },
          { x: 134, y: 54, label: "stage web", anchor: "start" },
          { x: 252, y: 54, label: "agent web", anchor: "start" },
          { x: 374, y: 54, label: "run orbit", anchor: "start" }
        ]
      : [
          { x: workflowX, y: 54, label: "workflow input", anchor: "middle" },
          { x: stageX, y: 54, label: "stage layer", anchor: "middle" },
          { x: agentX, y: 54, label: "agent layer", anchor: "middle" },
          { x: runX, y: 54, label: "run outputs", anchor: "middle" }
        ])
  ].map((layer) => `<text class="network-layer-label" x="${formatSvgNumber(layer.x)}" y="${formatSvgNumber(layer.y)}" text-anchor="${layer.anchor}">${escapeHtml(layer.label)}</text>`).join("");
  const runCounts = countBy(report.runs.map((run) => run.status));
  const runLegend = Object.entries(runCounts).map(([status, count]) => `<span><i style="background:${runPalette[status] ?? "#64748b"}"></i>${escapeHtml(status)} runs (${count})</span>`).join("");
  const legend = categories.map((category) => `<span><i style="background:${palette[category] ?? palette.uncategorized}"></i>${escapeHtml(category)}</span>`).join("");
  const totalStageHealthTasks = report.stageHealth.reduce((total, health) => total + health.totalTasks, 0);
  const stageHealthSummary = report.stageHealth.length
    ? `Stage health rings summarize ${formatNumber(totalStageHealthTasks)} task records across ${formatNumber(report.stageHealth.length)} stages.`
    : "Stage health rings appear when selected runs include task-level stage history.";
  const explainer = renderNetworkStateExplainer(isRadial);
  const networkDefs = `<defs>
        <radialGradient id="neuralCoreGlow" cx="50%" cy="50%" r="65%">
          <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.62"></stop>
          <stop offset="42%" stop-color="#0f172a" stop-opacity="0.92"></stop>
          <stop offset="100%" stop-color="#020617" stop-opacity="1"></stop>
        </radialGradient>
        <linearGradient id="neuralSignal" x1="0%" x2="100%" y1="0%" y2="0%">
          <stop offset="0%" stop-color="#38bdf8"></stop>
          <stop offset="54%" stop-color="#f59e0b"></stop>
          <stop offset="100%" stop-color="#f43f5e"></stop>
        </linearGradient>
        <pattern id="neuralGrid" width="34" height="34" patternUnits="userSpaceOnUse">
          <path d="M 34 0 L 0 0 0 34" fill="none" stroke="#38bdf8" stroke-opacity="0.06" stroke-width="1"></path>
        </pattern>
        <filter id="neuralGlow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="4" result="coloredBlur"></feGaussianBlur>
          <feMerge>
            <feMergeNode in="coloredBlur"></feMergeNode>
            <feMergeNode in="SourceGraphic"></feMergeNode>
          </feMerge>
        </filter>
      </defs>`;
  return `<div class="network-shell">
    <div class="network-canvas-scroll" tabindex="0" aria-label="Scrollable animated workflow canvas">
    <svg class="network-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="Animated workflow network map for ${escapeHtml(report.workflow.name)}">
      ${networkDefs}
      <rect class="network-backdrop" width="${width}" height="${height}" rx="0"></rect>
      <rect class="network-grid" width="${width}" height="${height}" rx="0"></rect>
      ${isRadial ? `<g class="network-rings">
        <circle cx="${formatSvgNumber(centerX)}" cy="${formatSvgNumber(centerY)}" r="${stageRadius}"></circle>
        <circle cx="${formatSvgNumber(centerX)}" cy="${formatSvgNumber(centerY)}" r="${agentRadius}"></circle>
        <circle cx="${formatSvgNumber(centerX)}" cy="${formatSvgNumber(centerY)}" r="${runRadius}"></circle>
      </g>` : ""}
      <g>${layerLabels}</g>
      <g class="network-links">${linkSvg}</g>
      <g class="network-nodes">${nodeSvg}</g>
      <g>${labelSvg}</g>
    </svg>
    </div>
    <div class="network-playback" aria-label="Workflow signal playback">
      <div class="network-playback-actions">
        <button type="button" class="network-replay secondary compact-button">${dashboardIcon("refresh")}Replay request</button>
        <button type="button" class="network-pause secondary compact-button" aria-pressed="false">${dashboardIcon("pause")}Pause</button>
      </div>
      <div class="network-timeline" aria-live="polite">
        <span class="network-live-dot"></span>
        <strong class="network-event-title">Request received</strong>
        <span class="network-event-detail">Routing through ${formatNumber(stages.length)} workflow stages</span>
      </div>
      <div class="network-phases" aria-label="Request progress">
        <span class="active">Request</span><span>Planning</span><span>Agents</span><span>Verification</span><span>Complete</span>
      </div>
    </div>
    <div class="network-legend">${legend}<span><i class="legend-stage"></i>stage</span><span><i class="legend-workflow"></i>workflow</span><span><i class="legend-health-completed"></i>stage completed</span><span><i class="legend-health-failed"></i>stage failed</span><span><i class="legend-health-active"></i>stage queued/running</span><span class="legend-note">circle size = incoming requests</span>${runLegend}</div>
    <p class="network-health-summary">${escapeHtml(stageHealthSummary)}</p>
    ${explainer}
    <script>
      (() => {
        const shell = document.currentScript?.closest('.network-shell');
        const svg = shell?.querySelector('.network-map');
        const replay = shell?.querySelector('.network-replay');
        const pause = shell?.querySelector('.network-pause');
        const panel = shell?.closest('.network-panel');
        const fullscreen = panel?.querySelector('.network-fullscreen-toggle');
        const title = shell?.querySelector('.network-event-title');
        const detail = shell?.querySelector('.network-event-detail');
        const phases = [...(shell?.querySelectorAll('.network-phases span') || [])];
        if (!shell || !svg || !replay || !pause || !title || !detail) return;
        const fullscreenKey = 'agentflow.network.fullscreen';
        const setFullscreen = (active) => {
          if (!panel || !fullscreen) return;
          panel.classList.toggle('is-fullscreen', active);
          document.body.classList.toggle('network-fullscreen-open', active);
          fullscreen.setAttribute('aria-pressed', String(active));
          fullscreen.lastChild.textContent = active ? 'Exit full screen' : 'Full screen';
          try { window.sessionStorage.setItem(fullscreenKey, active ? '1' : '0'); } catch {}
        };
        fullscreen?.addEventListener('click', () => setFullscreen(!panel?.classList.contains('is-fullscreen')));
        document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && panel?.classList.contains('is-fullscreen')) setFullscreen(false); });
        try { if (window.sessionStorage.getItem(fullscreenKey) === '1') setFullscreen(true); } catch {}
        const nodeElements = [...shell.querySelectorAll('[data-node-id]')];
        const synapses = [...shell.querySelectorAll('.network-synapse')];
        const initialRunIds = new Set(nodeElements.map((node) => node.dataset.nodeId).filter((id) => id?.startsWith('run:')).map((id) => id.slice(4)));
        const apiUrl = new URL(window.location.href);
        apiUrl.pathname = '/api/workflow-graph';
        apiUrl.searchParams.delete('view');
        apiUrl.searchParams.delete('orientation');
        apiUrl.searchParams.delete('capture');
        let pollTimer = 0;
        let paused = false;
        let pollInFlight = false;
        let latestReport = null;
        const showEvent = (index, heading, message) => {
          title.textContent = heading;
          detail.textContent = message;
          phases.forEach((phase, phaseIndex) => phase.classList.toggle('active', phaseIndex <= index));
          shell.dataset.phase = String(index);
        };
        const setNodeState = (nodeId, state) => {
          const node = nodeElements.find((item) => item.dataset.nodeId === nodeId);
          if (!node) return;
          ['live-firing', 'live-complete', 'live-failed', 'live-queued'].forEach((className) => node.classList.remove(className));
          if (state) node.classList.add('live-' + state);
        };
        const renderLiveReport = (report) => {
          latestReport = report;
          shell.classList.add('live-connected');
          nodeElements.forEach((node) => ['live-firing', 'live-complete', 'live-failed', 'live-queued'].forEach((className) => node.classList.remove(className)));
          synapses.forEach((synapse) => synapse.classList.remove('live-active', 'live-complete'));
          const runs = Array.isArray(report?.runs) ? report.runs : [];
          const activeRun = runs.find((run) => run.status === 'running') || runs.find((run) => run.status === 'queued');
          const latestRun = activeRun || runs[0];
          if (activeRun && !initialRunIds.has(activeRun.id)) {
            window.location.reload();
            return;
          }
          const liveRows = (Array.isArray(report?.liveStageRuns) ? report.liveStageRuns : []).filter((row) => row.runId === activeRun?.id);
          const stageOrder = new Map((report?.stages || []).map((stage, index) => [stage.id, index]));
          const currentRow = liveRows.find((row) => row.taskStatus === 'running') || liveRows.find((row) => row.taskStatus === 'queued');
          liveRows.forEach((row) => {
            const state = row.taskStatus === 'running' ? 'firing' : row.taskStatus === 'completed' ? 'complete' : row.taskStatus === 'failed' ? 'failed' : row.taskStatus === 'queued' ? 'queued' : '';
            setNodeState('stage:' + row.stageId, state);
            setNodeState('agent:' + row.agentId, state);
          });
          if (latestRun) setNodeState('run:' + latestRun.id, activeRun ? (activeRun.status === 'running' ? 'firing' : 'queued') : latestRun.status === 'completed' ? 'complete' : latestRun.status === 'failed' ? 'failed' : '');
          if (activeRun) setNodeState('workflow', 'firing');
          const activeIds = new Set(activeRun ? ['workflow', 'run:' + activeRun.id] : []);
          if (currentRow) {
            activeIds.add('stage:' + currentRow.stageId);
            activeIds.add('agent:' + currentRow.agentId);
          }
          synapses.forEach((synapse) => {
            const from = synapse.dataset.from;
            const to = synapse.dataset.to;
            if (activeIds.has(from) && activeIds.has(to)) synapse.classList.add('live-active');
            if (liveRows.some((row) => row.taskStatus === 'completed' && ((from === 'stage:' + row.stageId && to === 'agent:' + row.agentId) || (from === 'workflow' && to === 'stage:' + row.stageId)))) synapse.classList.add('live-complete');
          });
          if (!latestRun) {
            showEvent(0, 'Watching for requests', 'No stored runs yet; waiting for workflow activity');
          } else if (!activeRun) {
            const complete = latestRun.status === 'completed';
            showEvent(complete ? 4 : 3, complete ? 'Complete' : 'Latest run ' + latestRun.status, latestRun.task || 'Workflow activity is idle');
          } else if (!currentRow) {
            showEvent(0, activeRun.status === 'queued' ? 'Request queued' : 'Request received', activeRun.task || 'Waiting for the first stage');
          } else {
            const order = stageOrder.get(currentRow.stageId) ?? 0;
            const verification = /verify|test|review|security/i.test(currentRow.stageId + ' ' + currentRow.agentId);
            const phase = verification ? 3 : order <= 1 ? 1 : 2;
            showEvent(phase, currentRow.taskStatus === 'running' ? currentRow.stageId + ' firing' : currentRow.stageId + ' queued', currentRow.agentId + ' · run ' + activeRun.id.slice(0, 8));
          }
        };
        const poll = async () => {
          if (paused || document.hidden || pollInFlight) return;
          pollInFlight = true;
          try {
            const response = await fetch(apiUrl, { headers: { accept: 'application/json' }, cache: 'no-store' });
            if (!response.ok) throw new Error('status ' + response.status);
            renderLiveReport(await response.json());
          } catch (error) {
            shell.classList.remove('live-connected');
            showEvent(0, 'Live feed unavailable', error instanceof Error ? error.message : 'Could not refresh workflow state');
          } finally {
            pollInFlight = false;
          }
        };
        const replayLatest = () => {
          svg.setCurrentTime?.(0);
          if (latestReport) renderLiveReport(latestReport);
          else void poll();
        };
        replay.addEventListener('click', replayLatest);
        pause.addEventListener('click', () => {
          paused = !paused;
          pause.setAttribute('aria-pressed', String(paused));
          pause.lastChild.textContent = paused ? 'Resume' : 'Pause';
          if (paused) svg.pauseAnimations?.();
          else { svg.unpauseAnimations?.(); void poll(); }
        });
        document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
        void poll();
        pollTimer = window.setInterval(() => { void poll(); }, 2000);
      })();
    </script>
  </div>`;
}

export function stageAnchorId(stageId: string): string {
  return `stage-${stageId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

export function stageFixVerificationForm(input: {
  project: string;
  workflowId: string;
  stageId: string;
  fixRunId: string;
  disabled: boolean;
}): string {
  return `<form class="inline-form compact-form" method="post" action="/api/follow-up">
    <input type="hidden" name="action" value="verify-stage-fix">
    <input type="hidden" name="project" value="${escapeHtml(input.project)}">
    <input type="hidden" name="workflowId" value="${escapeHtml(input.workflowId)}">
    <input type="hidden" name="stageId" value="${escapeHtml(input.stageId)}">
    <input type="hidden" name="runId" value="${escapeHtml(input.fixRunId)}">
    <button type="submit"${input.disabled ? " disabled" : ""}>Rerun Source</button>
  </form>`;
}

export function stagePatternExplanation(stage: WorkflowGraphReport["stages"][number]): string {
  const gate = stage.pattern.promotionGate === "none" ? "" : ` Promotion gate: ${stage.pattern.promotionGate}.`;
  const verifier = stage.pattern.requiresVerifier ? " Verifier evidence is expected before promotion." : "";
  const maxIterations = stage.pattern.maxIterations ? ` Limited to ${stage.pattern.maxIterations} observe-act iteration${stage.pattern.maxIterations === 1 ? "" : "s"}.` : "";
  const approval = stage.approvalRequired || stage.policyApprovalRequired ? " Approval is required before this stage can fully execute." : "";
  const base: Record<string, string> = {
    "single-shot": "Used for one bounded model call with no explicit agent loop.",
    planner: "Used to decompose the request, choose specialists, and set implementation direction.",
    executor: "Used to apply scoped implementation work under project policy.",
    react: "Used when the stage may observe, request a local action, inspect the result, and stop on evidence.",
    reflexive: "Used to critique or update previous work before handing it forward.",
    verifier: "Used to independently check behavior, tests, policy, or release readiness.",
    finalizer: "Used to package decisions, evidence, and remaining risk into a handoff."
  };
  return `${base[stage.pattern.type] ?? "Used for a provider-neutral workflow stage."}${maxIterations}${gate}${verifier}${approval}`.trim();
}

export function workflowGraphApiHref(
  workflowId: string,
  project: string,
  policyProfile: string,
  options: { category: string; approval: string; policyStatus: string; runLimit: string; runStatus: string; runScope: "project" | "all-projects"; stage?: string }
): string {
  const query = new URLSearchParams({
    workflow: workflowId,
    project,
    policyProfile
  });
  if (options.category) query.set("category", options.category);
  if (options.approval !== "all") query.set("approval", options.approval);
  if (options.policyStatus !== "all") query.set("policyStatus", options.policyStatus);
  if (options.runLimit !== "50") query.set("runLimit", options.runLimit);
  if (options.runStatus !== "all") query.set("runStatus", options.runStatus);
  if (options.runScope === "all-projects") query.set("runScope", "all-projects");
  if (options.stage) query.set("stage", options.stage);
  return `/api/workflow-graph?${query.toString()}`;
}

export function workflowGraphHandoffExportForm(input: {
  workflowId: string;
  project: string;
  policyProfile: string;
  view: string;
  orientation: "horizontal" | "radial";
  category: string;
  approval: string;
  policyStatus: string;
  runStatus: string;
  runLimit: string;
  runScope: "project" | "all-projects";
  stage: string;
}): string {
  const fields: Record<string, string> = {
    workflow: input.workflowId,
    project: input.project,
    policyProfile: input.policyProfile,
    view: input.view,
    orientation: input.orientation,
    category: input.category,
    approval: input.approval,
    policyStatus: input.policyStatus,
    runStatus: input.runStatus,
    runLimit: input.runLimit,
    runScope: input.runScope,
    stage: input.stage
  };
  const hiddenFields = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  return `<form class="inline-form compact-form" method="post" action="/api/graph-handoff-export">${hiddenFields}<button type="submit">Export Handoff</button></form>`;
}
