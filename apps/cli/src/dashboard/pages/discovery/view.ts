import { formatNumber } from "../../ui/format.js";
import { escapeHtml, dashboardNav, renderDashboardFlash, renderDashboardActionHistory, metricCard, dashboardReturnInput } from "../../ui/layout.js";
import { matchesQuery, pageOf, pagerHtml } from "../../paging.js";
import type { ProjectDiscoveryReport } from "../../../lib/cli-types.js";
import { dashboardCss } from "../../styles.js";

export function renderDiscoveryHtml(report: ProjectDiscoveryReport, params: URLSearchParams): string {
  const spotlightOptions = ["auto", "on", "off"].map((mode) => `<option value="${mode}"${report.spotlight.requested === mode ? " selected" : ""}>${mode}</option>`).join("");
  const hiddenDiscoveryFields = [
    `<input type="hidden" name="roots" value="${escapeHtml(report.roots.join(","))}">`,
    `<input type="hidden" name="maxDepth" value="${escapeHtml(String(report.maxDepth))}">`,
    `<input type="hidden" name="maxCandidates" value="${escapeHtml(String(report.maxCandidates))}">`,
    `<input type="hidden" name="spotlight" value="${escapeHtml(report.spotlight.requested)}">`
  ].join("");
  const candidateQuery = params.get("q")?.trim() ?? "";
  const matchingCandidates = report.candidates.filter((candidate) => matchesQuery(candidateQuery, candidate.name, candidate.rootUri, candidate.markers.join(" ")));
  const candidatePage = pageOf(matchingCandidates, params, 25);
  const candidateSearchFields = ["roots", "maxDepth", "maxCandidates", "spotlight"].map((key) => params.get(key) ? `<input type="hidden" name="${key}" value="${escapeHtml(params.get(key) ?? "")}">` : "").join("");
  const rows = candidatePage.items.map((candidate) => `
    <tr>
      <td>${escapeHtml(candidate.name)}<br><span class="muted">${escapeHtml(candidate.rootUri)}</span></td>
      <td><span class="flag ${candidate.confidence === "high" ? "good" : candidate.confidence === "medium" ? "queued" : "warn"}">${escapeHtml(candidate.confidence)}</span></td>
      <td>${escapeHtml(candidate.source)}</td>
      <td>${candidate.initialized ? "yes" : "no"}</td>
      <td>${candidate.registered ? "yes" : "no"}</td>
      <td>${escapeHtml(candidate.markers.join(", "))}</td>
      <td>${candidate.suggestedCommands.map((command) => `<code>${escapeHtml(command)}</code>`).join("<br>")}</td>
      <td>
        ${candidate.initialized ? `
          <form method="post" action="/api/discovery-adopt" class="inline-form compact-form">
            ${dashboardReturnInput("/discovery", params)}
            ${hiddenDiscoveryFields}
            <input type="hidden" name="paths" value="${escapeHtml(candidate.rootUri)}">
            <input type="hidden" name="index" value="on">
            <input type="hidden" name="maxFiles" value="100">
            <button type="submit">Index</button>
          </form>
        ` : `
          <form method="post" action="/api/discovery-adopt" class="inline-form compact-form">
            ${dashboardReturnInput("/discovery", params)}
            ${hiddenDiscoveryFields}
            <input type="hidden" name="paths" value="${escapeHtml(candidate.rootUri)}">
            <input type="hidden" name="initialize" value="on">
            <input type="hidden" name="profile" value="enterprise">
            <button type="submit">Initialize</button>
          </form>
        `}
      </td>
    </tr>
  `).join("");
  const warningItems = report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  const nextItems = report.nextCommands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
  const jsonParams = new URLSearchParams(params);
  if (!jsonParams.has("roots")) jsonParams.set("roots", report.roots.join(","));
  if (!jsonParams.has("maxDepth")) jsonParams.set("maxDepth", String(report.maxDepth));
  if (!jsonParams.has("maxCandidates")) jsonParams.set("maxCandidates", String(report.maxCandidates));
  if (!jsonParams.has("spotlight")) jsonParams.set("spotlight", report.spotlight.requested);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Discovery</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("discovery")}
  <main id="main-content">
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Discovery</h1>
        <p class="muted">Local-only project discovery across governed roots. This page reads directory names and marker files only; it does not index file contents.</p>
      </div>
      <a class="button secondary" href="/api/discovery?${escapeHtml(jsonParams.toString())}">JSON</a>
    </div>
    ${renderDashboardFlash(params)}
    ${renderDashboardActionHistory()}
    <section class="panel">
      <form method="get" class="workflow-form">
        <label class="wide">Roots
          <input name="roots" value="${escapeHtml(report.roots.join(","))}" placeholder="/Users/you/Projects,/path/to/root">
        </label>
        <label>Max depth
          <input name="maxDepth" value="${escapeHtml(String(report.maxDepth))}" inputmode="numeric">
        </label>
        <label>Max candidates
          <input name="maxCandidates" value="${escapeHtml(String(report.maxCandidates))}" inputmode="numeric">
        </label>
        <label>Spotlight
          <select name="spotlight">${spotlightOptions}</select>
        </label>
        <div class="form-actions"><button type="submit">Discover</button></div>
      </form>
      <p class="muted">For a whole-drive preview on macOS, use root <code>/</code> with Spotlight <code>auto</code>. Default excludes skip system, cache, dependency, photo library, backup, and private runtime directories.</p>
    </section>
    <section class="panel">
      <div class="metric-grid">
        ${metricCard("Candidates", report.candidates.length, "review before indexing")}
        ${metricCard("Roots", report.roots.length, "governed scan roots")}
        ${metricCard("Spotlight", report.spotlight.used ? "used" : "not used", report.spotlight.available ? "available" : "unavailable")}
        ${metricCard("Max Depth", report.maxDepth, "filesystem fallback")}
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Adopt Candidates</h2>
          <span class="muted">Initialize writes project-local Agent Workflow files. Index registers initialized projects and stores compact source summaries.</span>
        </div>
      </div>
      <form method="post" action="/api/discovery-adopt" class="workflow-form">
        ${dashboardReturnInput("/discovery", params)}
        ${hiddenDiscoveryFields}
        <input type="hidden" name="all" value="on">
        <label>Max files per project
          <input name="maxFiles" value="100" inputmode="numeric">
        </label>
        <label>Profile
          <select name="profile"><option value="enterprise" selected>enterprise</option><option value="simple">simple</option></select>
        </label>
        <label class="checkbox-row"><input type="checkbox" name="initialize" value="on"> initialize missing project files</label>
        <label class="checkbox-row"><input type="checkbox" name="index" value="on" checked> index initialized projects</label>
        <div class="form-actions"><button type="submit">Adopt Selected Scope</button></div>
      </form>
    </section>
    ${warningItems ? `<section class="panel"><h2>Warnings</h2><ul>${warningItems}</ul></section>` : ""}
    <section class="panel" id="candidate-projects">
      <div class="section-heading"><h2>Candidate Projects</h2><form class="list-filter" method="get" action="/discovery#candidate-projects" role="search">${candidateSearchFields}<label>Filter candidates<input type="search" name="q" value="${escapeHtml(candidateQuery)}" placeholder="name, path or marker"></label><button class="secondary" type="submit">Filter</button></form></div>
      ${candidateQuery ? `<p class="muted">${formatNumber(matchingCandidates.length)} of ${formatNumber(report.candidates.length)} candidates match “${escapeHtml(candidateQuery)}”.</p>` : ""}
      ${pagerHtml("/discovery", params, candidatePage, "Candidate projects")}
      <div class="table-wrap"><table><thead><tr><th>Project</th><th>Confidence</th><th>Source</th><th>Initialized</th><th>Registered</th><th>Markers</th><th>Next Commands</th><th>Action</th></tr></thead><tbody>${rows || "<tr><td colspan=\"8\">No candidate projects found.</td></tr>"}</tbody></table></div>
      ${pagerHtml("/discovery", params, candidatePage, "Candidate projects")}
    </section>
    <section class="panel"><h2>Next Commands</h2><ul>${nextItems}</ul></section>
  </main>
</body>
</html>`;
}
