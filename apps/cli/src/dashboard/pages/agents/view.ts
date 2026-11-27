import { formatNumber } from "../../ui/format.js";
import { escapeHtml, dashboardNav, renderDashboardFlash, renderDashboardActionHistory, renderDashboardDateTime, metricCard } from "../../ui/layout.js";
import type { DashboardProjectSummary } from "../../../lib/cli-types.js";
import { walk } from "../../../lib/builders-shared.js";
import { loadYamlFile } from "../../../../../../packages/agent-registry/src/loaders.js";
import { agentCardSchema } from "../../../../../../packages/agent-registry/src/schemas.js";
import { dashboardCss } from "../../styles.js";
import fs from "node:fs/promises";
import type { DashboardAgentSource, DashboardAgentSummary, DashboardAgentsReport } from "../../../commands/daemon-types.js";

export function compareAgentSummaries(a: DashboardAgentSummary, b: DashboardAgentSummary): number {
  return a.category.localeCompare(b.category) || a.id.localeCompare(b.id);
}

export async function loadDashboardAgentSummaries(
  directory: string,
  source: DashboardAgentSource,
  warnings: string[],
  sharedIds = new Set<string>()
): Promise<DashboardAgentSummary[]> {
  let files: string[];
  try {
    files = (await walk(directory)).filter((filePath) => /\.ya?ml$/u.test(filePath)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || source === "shared") {
      warnings.push(`Could not read ${source} agents from ${directory}: ${(error as Error).message}`);
    }
    return [];
  }
  const summaries: DashboardAgentSummary[] = [];
  for (const filePath of files) {
    try {
      const agent = await loadYamlFile(filePath, agentCardSchema);
      const stat = await fs.stat(filePath).catch(() => null);
      summaries.push({
        id: agent.id,
        displayName: agent.display_name,
        category: agent.category,
        autonomy: agent.autonomy,
        modelStrategy: agent.model_strategy,
        modelTier: agent.model_tier,
        purpose: agent.purpose,
        useWhen: agent.use_when,
        can: agent.can,
        requiresApproval: agent.requires_approval,
        contextMaxTokens: agent.context_budget.max_tokens,
        source,
        sourcePath: filePath,
        modifiedAt: stat?.mtime.toISOString() ?? null,
        overridesShared: source === "project-local" && sharedIds.has(agent.id)
      });
    } catch (error) {
      warnings.push(`Could not load agent ${filePath}: ${(error as Error).message}`);
    }
  }
  return summaries.sort(compareAgentSummaries);
}

/** Filters the rows of the table named by each [data-filter-rows] search box, in the page. */
export function dashboardRowFilterScript(): string {
  return `<script>document.querySelectorAll("input[data-filter-rows]").forEach((input)=>{const table=document.getElementById(input.getAttribute("data-filter-rows"));if(!table)return;input.addEventListener("input",()=>{const needle=input.value.trim().toLowerCase();table.querySelectorAll("tbody tr").forEach((row)=>{row.hidden=Boolean(needle)&&!row.textContent.toLowerCase().includes(needle)})})});</script>`;
}

export function renderAgentsHtml(report: DashboardAgentsReport, projects: DashboardProjectSummary[], params: URLSearchParams): string {
  const selectedProject = report.projectRootUri ?? "";
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}"${selectedProject === project.rootUri ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  const categoryCounts = report.effectiveAgents.reduce<Record<string, number>>((counts, agent) => {
    counts[agent.category] = (counts[agent.category] ?? 0) + 1;
    return counts;
  }, {});
  const sharedOverridden = report.projectAgents.filter((agent) => agent.overridesShared).length;
  const jsonParams = new URLSearchParams();
  if (selectedProject) jsonParams.set("project", selectedProject);
  const renderAgentRows = (agents: DashboardAgentSummary[]) => agents.map((agent) => `
    <tr>
      <td><strong>${escapeHtml(agent.displayName)}</strong><br><code>${escapeHtml(agent.id)}</code></td>
      <td><span class="flag ${agent.source === "project-local" ? "good" : "neutral"}">${escapeHtml(agent.source)}</span>${agent.overridesShared ? '<br><span class="flag warn">overrides shared</span>' : ""}</td>
      <td>${escapeHtml(agent.category)}<br><span class="muted">autonomy ${escapeHtml(String(agent.autonomy))}</span></td>
      <td>${escapeHtml(agent.purpose)}</td>
      <td>${agent.can.slice(0, 6).map((capability) => `<code>${escapeHtml(capability)}</code>`).join(" ") || '<span class="muted">none listed</span>'}</td>
      <td>${agent.requiresApproval.map((approval) => `<code>${escapeHtml(approval)}</code>`).join(" ") || '<span class="muted">none</span>'}</td>
      <td>${formatNumber(agent.contextMaxTokens)}<br><span class="muted">${escapeHtml(agent.modelStrategy)} / ${escapeHtml(agent.modelTier)}</span></td>
      <td>${renderDashboardDateTime(agent.modifiedAt, "unknown")}<br><code>${escapeHtml(agent.sourcePath)}</code></td>
    </tr>
  `).join("");
  const effectiveRows = renderAgentRows(report.effectiveAgents);
  const projectRows = renderAgentRows(report.projectAgents);
  const sharedRows = renderAgentRows(report.sharedAgents);
  const warningRows = report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Agents</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("agents")}
  <main id="main-content">
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Agents</h1>
        <p class="muted">Shared reusable agents plus project-local agents from <code>.agent-workflow/agents</code>.</p>
      </div>
      <a class="button secondary" href="/api/agents?${escapeHtml(jsonParams.toString())}">JSON</a>
    </div>
    ${renderDashboardFlash(params)}
    ${renderDashboardActionHistory()}
    <section class="panel">
      <form method="get" class="workflow-form">
        <label class="wide">Project
          <select name="project"><option value="">shared agents only</option>${projectOptions}</select>
        </label>
        <div class="form-actions"><button type="submit">Inspect</button></div>
      </form>
      <p class="muted">Use this page to confirm which local specialists a selected project adds on top of the open-source bundle.</p>
    </section>
    ${report.warnings.length ? `<section class="panel warn-panel"><h2>Warnings</h2><ul>${warningRows}</ul></section>` : ""}
    <section class="panel">
      <div class="metric-grid">
        ${metricCard("Effective Agents", report.effectiveAgents.length, "available for selected project")}
        ${metricCard("Shared", report.sharedAgents.length, "from reusable bundle")}
        ${metricCard("Project Local", report.projectAgents.length, selectedProject || "no project selected")}
        ${metricCard("Overrides", sharedOverridden, "project-local cards replacing shared ids")}
        ${metricCard("Automatic", categoryCounts.automatic ?? 0, "background-capable agents")}
        ${metricCard("Product", categoryCounts.product ?? 0, "UX, product, and site agents")}
      </div>
      <p class="muted">Generated ${renderDashboardDateTime(report.generatedAt)}${selectedProject ? ` for ${escapeHtml(selectedProject)}` : ""}.</p>
    </section>
    <section class="panel">
      <div class="section-heading"><h2>Effective Roster</h2><label class="list-filter">Filter agents<input type="search" data-filter-rows="effective-roster" placeholder="name, category or purpose"></label></div>
      <div class="table-wrap"><table id="effective-roster"><thead><tr><th>Agent</th><th>Source</th><th>Category</th><th>Purpose</th><th>Capabilities</th><th>Approvals</th><th>Context</th><th>Definition</th></tr></thead><tbody>${effectiveRows || '<tr><td colspan="8">No agents found.</td></tr>'}</tbody></table></div>
    </section>
    <section class="panel">
      <h2>Project-Local Agents</h2>
      <div class="table-wrap"><table><thead><tr><th>Agent</th><th>Source</th><th>Category</th><th>Purpose</th><th>Capabilities</th><th>Approvals</th><th>Context</th><th>Definition</th></tr></thead><tbody>${projectRows || '<tr><td colspan="8">No project-local agents found for the selected project.</td></tr>'}</tbody></table></div>
    </section>
    <details class="panel collapsible-panel">
      <summary><h2>Shared Bundle Agents (${formatNumber(report.sharedAgents.length)})</h2><span class="muted">The reusable cards behind the roster above; project-local cards replace shared ids.</span></summary>
      <div class="table-wrap"><table><thead><tr><th>Agent</th><th>Source</th><th>Category</th><th>Purpose</th><th>Capabilities</th><th>Approvals</th><th>Context</th><th>Definition</th></tr></thead><tbody>${sharedRows || '<tr><td colspan="8">No shared agents found.</td></tr>'}</tbody></table></div>
    </details>
    ${dashboardRowFilterScript()}
  </main>
</body>
</html>`;
}
