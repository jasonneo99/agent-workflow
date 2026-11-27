import { renderRouteReceiptTrendsHtml, renderLocalRouteDecisionDrilldownHtml, renderLocalHoldoutRoutingStatusHtml } from "../../ui/routing-components.js";
import { renderFeedbackTargetActionForms, renderFeedbackTargetEvidenceHtml, renderTuningProposalsHtml } from "../../ui/feedback-components.js";
import { renderRunInfoDialog } from "../../ui/run-actions.js";
import { formatNumber } from "../../ui/format.js";
import { escapeHtml, dashboardNav, iconLabel, renderDashboardFlash, renderDashboardActionHistory, renderDashboardDateTime, metricCard } from "../../ui/layout.js";
import type { DashboardLocalLlmRoutingDecisionTimeline, DashboardLocalLlmRoutingNoteApplicationStatus, DashboardLocalProviderEvidence, DashboardProjectSummary, LocalLlmBenchmarkReceiptReport, LocalLlmCacheTrendReport, LocalLlmCostLedgerReport, LocalLlmDownloadRecommendationReport, LocalLlmInstallationPlanReport, LocalLlmInventoryReport, LocalLlmPrunePlanReport, LocalLlmRoutingDecisionSnapshotReport, LocalLlmRoutingRecommendationReport, LocalLlmSetupChecklistReport, LocalLlmSetupGuideReport } from "../../../lib/cli-types.js";
import { formatUsd } from "../../../lib/builders-learning.js";
import { formatDashboardDateTimeText } from "../../../lib/builders-runs.js";
import { formatBytes, formatInlineCounts, truncateText } from "../../../lib/builders-shared.js";
import { renderPreferenceScorecardHtml } from "../../outcome-accuracy.js";
import { dashboardCss } from "../../styles.js";
import type { DashboardModelImprovementReport } from "../../../commands/daemon-types.js";

/** "On this page" links to every section heading of a long page, built in the browser. */
export function dashboardSectionIndex(): string {
  return `<nav class="panel section-index" aria-label="On this page" hidden><div class="section-index-head"><strong>On this page</strong><button type="button" class="secondary compact-button" data-section-toggle-all>Expand all</button></div><ul></ul></nav><script>(()=>{const nav=document.currentScript.previousElementSibling;document.addEventListener("DOMContentLoaded",()=>{const list=nav.querySelector("ul");const sections=[...document.querySelectorAll("main section.panel")].filter((section)=>section.querySelector("h2")&&!section.contains(nav)&&section.getClientRects().length>0);if(sections.length<6)return;nav.hidden=false;const setOpen=(section,open)=>{section.classList.toggle("is-collapsed",!open);const button=section.querySelector(":scope [data-section-toggle]");if(button){button.setAttribute("aria-expanded",String(open));button.textContent=open?"Hide":"Show"}};sections.forEach((section,index)=>{const heading=section.querySelector("h2");if(!section.id)section.id="section-"+(index+1);const item=document.createElement("li");const link=document.createElement("a");link.href="#"+section.id;link.textContent=heading.textContent.trim();link.addEventListener("click",()=>setOpen(section,true));item.append(link);list.append(item);const button=document.createElement("button");button.type="button";button.className="secondary compact-button section-toggle";button.setAttribute("data-section-toggle","");button.setAttribute("aria-label","Show or hide "+heading.textContent.trim());button.addEventListener("click",()=>setOpen(section,section.classList.contains("is-collapsed")));heading.after(button);setOpen(section,index<2)});nav.querySelector("[data-section-toggle-all]").addEventListener("click",(event)=>{const open=event.currentTarget.textContent==="Expand all";sections.forEach((section)=>setOpen(section,open));event.currentTarget.textContent=open?"Collapse all":"Expand all"})})})();</script>`;
}

export function renderLocalLlmBenchmarkReceiptsHtml(report: LocalLlmBenchmarkReceiptReport): string {
  const statusClass = report.status === "completed" ? "completed" : report.status === "runtime-needed" || report.status === "no-installed-models" ? "failed" : "queued";
  const rows = report.receipts.map((receipt) => `
    <tr>
      <td>${escapeHtml(receipt.id)}<br><span class="muted">${escapeHtml(receipt.taskLabel)}</span></td>
      <td><span class="flag ${receipt.status === "completed" ? "good" : receipt.status === "failed" ? "bad" : "warn"}">${escapeHtml(receipt.status)}</span><br><span class="muted">${escapeHtml(receipt.verdict)}</span></td>
      <td>${escapeHtml(receipt.modelId)}<br><span class="muted">${receipt.runtime ? escapeHtml(receipt.runtime.label) : "no runtime"}</span></td>
      <td>${receipt.latencyMs === null ? "n/a" : `${formatNumber(receipt.latencyMs)} ms`}<br><span class="muted">score ${receipt.rubricScore ?? "n/a"}</span></td>
      <td>${escapeHtml(truncateText(receipt.error ?? (receipt.evidence.join(" ") || "No evidence yet."), 180))}</td>
    </tr>
  `).join("");
  const returnTo = `/model-improvement?project=${encodeURIComponent(report.projectRootUri)}`;
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Local Benchmark Receipts</h2>
          <span class="muted">Tiny local-only prompts for measuring installed candidates before local smoke promotion.</span>
        </div>
        <span class="status ${statusClass}">${escapeHtml(report.status)}</span>
      </div>
      <div class="metric-grid">
        ${metricCard("Receipts", report.summary.receipts, `${report.summary.completed} completed, ${report.summary.planned} planned`)}
        ${metricCard("Runtime", report.runtime?.label ?? "none", report.runtime?.baseUrl ?? "start a local runtime")}
        ${metricCard("Avg Latency", report.summary.averageLatencyMs === null ? "n/a" : `${formatNumber(report.summary.averageLatencyMs)} ms`, "completed local prompts")}
        ${metricCard("Avg Score", report.summary.averageRubricScore ?? "n/a", "tiny rubric heuristic")}
      </div>
      <p class="muted">${escapeHtml(report.nextAction)}</p>
      <div class="actions">
        <form method="post" action="/api/follow-up">
          <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
          <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
          <input type="hidden" name="action" value="local-llm-benchmarks">
          <button type="submit">${iconLabel("file", "Write Benchmark Plan")}</button>
        </form>
        <form method="post" action="/api/follow-up">
          <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
          <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
          <input type="hidden" name="action" value="local-llm-benchmarks-execute">
          <button type="submit" class="secondary">${iconLabel("activity", "Execute Local Benchmark")}</button>
        </form>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Receipt</th><th>Status</th><th>Model</th><th>Measure</th><th>Evidence</th></tr></thead><tbody>${rows || "<tr><td colspan=\"5\">No local benchmark receipts yet.</td></tr>"}</tbody></table></div>
    </section>
  `;
}

export function renderLocalLlmCacheTrendHtml(report: LocalLlmCacheTrendReport): string {
  const statusClass = report.status === "tracking" ? "completed" : report.status === "started" ? "queued" : "failed";
  const rows = report.history.slice(-10).reverse().map((point) => `
    <tr>
      <td>${renderDashboardDateTime(point.capturedAt)}</td>
      <td>${escapeHtml(point.totalCacheLabel)}<br><span class="muted">${escapeHtml(point.storageStatus)}</span></td>
      <td>${point.freeBytes === null ? "unknown" : escapeHtml(formatBytes(point.freeBytes))}</td>
      <td>${formatNumber(point.modelCount)}</td>
      <td>${formatNumber(point.pruneCandidateCount)}<br><span class="muted">${escapeHtml(point.reclaimableLabel)} reclaim</span></td>
      <td>${formatNumber(point.localSelected)} local<br><span class="muted">${formatNumber(point.hostedSelected)} hosted</span></td>
    </tr>
  `).join("");
  const returnTo = `/model-improvement?project=${encodeURIComponent(report.projectRootUri)}`;
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Local Model Cache Trends</h2>
          <span class="muted">Compact storage and route history for local-model cost savings.</span>
        </div>
        <span class="status ${statusClass}">${escapeHtml(report.status)}</span>
      </div>
      <div class="metric-grid">
        ${metricCard("Snapshots", report.history.length, "rolling project-local history")}
        ${metricCard("Cache Delta", report.comparison.cacheDeltaLabel, report.comparison.previousAt ? `since ${formatDashboardDateTimeText(report.comparison.previousAt)}` : "no previous snapshot")}
        ${metricCard("Free Disk Delta", report.comparison.freeDeltaLabel, "available storage movement")}
        ${metricCard("Local Route Delta", report.comparison.localRouteDelta ?? "n/a", "local-selected receipts")}
        ${metricCard("Hosted Route Delta", report.comparison.hostedRouteDelta ?? "n/a", "hosted-selected receipts")}
        ${metricCard("Current Reclaim", report.current.reclaimableLabel, `${formatNumber(report.current.pruneCandidateCount)} prune candidate(s)`)}
      </div>
      <p class="muted">${escapeHtml(report.recommendation)}</p>
      <form method="post" action="/api/follow-up" class="inline-form">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
        <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
        <input type="hidden" name="action" value="local-llm-cache-trends">
        <button type="submit">${iconLabel("activity", "Write Trend Snapshot")}</button>
        <span class="muted">Appends aggregate history to <code>.agent-workflow/model-improvement/local-llm-cache-trends.*</code>.</span>
      </form>
      <div class="table-wrap"><table><thead><tr><th>Captured</th><th>Cache</th><th>Free Disk</th><th>Models</th><th>Prune</th><th>Routes</th></tr></thead><tbody>${rows || "<tr><td colspan=\"6\">No written trend snapshots yet.</td></tr>"}</tbody></table></div>
    </section>
  `;
}

export function renderLocalLlmCostLedgerHtml(report: LocalLlmCostLedgerReport): string {
  const statusClass = report.status === "saving" ? "completed" : report.status === "watch" ? "queued" : "failed";
  const rows = report.history.slice(-10).reverse().map((point) => `
    <tr>
      <td>${renderDashboardDateTime(point.capturedAt)}</td>
      <td>${formatNumber(point.localSelectedStages)} local<br><span class="muted">${formatNumber(point.hostedSelectedStages)} hosted</span></td>
      <td>${escapeHtml(formatUsd(point.avoidedHostedUsd))}</td>
      <td>${escapeHtml(formatUsd(point.fallbackHostedUsd))}</td>
      <td>${escapeHtml(formatUsd(point.storageUsdPerMonth))}</td>
      <td>${escapeHtml(formatUsd(point.netEstimatedSavingsUsd))}</td>
    </tr>
  `).join("");
  const returnTo = `/model-improvement?project=${encodeURIComponent(report.projectRootUri)}`;
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Local Model Cost Ledger</h2>
          <span class="muted">Estimated savings from local routing, fallback cost, benchmark latency, and cache storage.</span>
        </div>
        <span class="status ${statusClass}">${escapeHtml(report.status)}</span>
      </div>
      <div class="metric-grid">
        ${metricCard("Net Savings", formatUsd(report.current.netEstimatedSavingsUsd), "estimated in this run window")}
        ${metricCard("Avoided Hosted", formatUsd(report.current.avoidedHostedUsd), `${formatNumber(report.current.localSelectedStages)} local-selected stages`)}
        ${metricCard("Fallback Cost", formatUsd(report.current.fallbackHostedUsd), `${formatNumber(report.current.hostedFallbackStages)} hosted fallback stages`)}
        ${metricCard("Storage/Month", formatUsd(report.current.storageUsdPerMonth), report.current.totalCacheLabel)}
        ${metricCard("Benchmark Latency", report.current.benchmarkAverageLatencyMs === null ? "n/a" : `${formatNumber(report.current.benchmarkAverageLatencyMs)}ms`, `score ${report.current.benchmarkAverageScore ?? "n/a"}`)}
        ${metricCard("Savings Delta", report.comparison.netSavingsDeltaUsd === null ? "n/a" : formatUsd(report.comparison.netSavingsDeltaUsd), report.comparison.previousAt ? `since ${formatDashboardDateTimeText(report.comparison.previousAt)}` : "no previous snapshot")}
      </div>
      <p class="muted">${escapeHtml(report.recommendation)}</p>
      <form method="post" action="/api/follow-up" class="inline-form">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
        <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
        <input type="hidden" name="action" value="local-llm-cost-ledger">
        <button type="submit">${iconLabel("activity", "Write Cost Snapshot")}</button>
        <span class="muted">Uses configurable <code>AGENTFLOW_COST_LEDGER_*</code> estimates and writes only project-local ledger files.</span>
      </form>
      <div class="meta-grid compact">
        <div><strong>Fast Stage</strong>${escapeHtml(formatUsd(report.assumptions.hostedUsdPerStageByTier.fast))}</div>
        <div><strong>Standard Stage</strong>${escapeHtml(formatUsd(report.assumptions.hostedUsdPerStageByTier.standard))}</div>
        <div><strong>Reasoning Stage</strong>${escapeHtml(formatUsd(report.assumptions.hostedUsdPerStageByTier.reasoning))}</div>
        <div><strong>Storage Rate</strong>${escapeHtml(formatUsd(report.assumptions.localStorageUsdPerGbMonth))} / GB-month</div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Captured</th><th>Routes</th><th>Avoided</th><th>Fallback</th><th>Storage</th><th>Net</th></tr></thead><tbody>${rows || "<tr><td colspan=\"6\">No written cost snapshots yet.</td></tr>"}</tbody></table></div>
    </section>
  `;
}

export function renderLocalLlmDownloadRecommendationsHtml(report: LocalLlmDownloadRecommendationReport): string {
  const statusClass = report.status === "ready" ? "completed" : report.status === "runtime-needed" ? "failed" : "queued";
  const rows = report.recommendations.map((item) => `
    <tr>
      <td><span class="flag ${item.priority === "high" ? "good" : item.priority === "medium" ? "warn" : "queued"}">${escapeHtml(item.priority)}</span></td>
      <td>${escapeHtml(item.modelId)}<br><span class="muted">${escapeHtml(item.label)}</span></td>
      <td>${escapeHtml(item.primaryTier)}<br><span class="muted">${escapeHtml(item.tierFit.join(", "))}</span></td>
      <td>${escapeHtml(item.hardwareFit)}<br><span class="muted">${item.installed ? "installed" : "download needed"}</span></td>
      <td><code>${escapeHtml(item.downloadCommand)}</code></td>
      <td>${escapeHtml(truncateText(item.rationale.join(" "), 180))}</td>
    </tr>
  `).join("");
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Local Model Download Recommendations</h2>
          <span class="muted">Suggests practical local models from hardware, runtime catalog, task mix, and smoke evidence.</span>
        </div>
        <span class="status ${statusClass}">${escapeHtml(report.status)}</span>
      </div>
      <div class="metric-grid">
        ${metricCard("Hardware", report.hardware.class, `${report.hardware.memoryGb} GB, ${report.hardware.cpuCount} cores`)}
        ${metricCard("Dominant Tier", report.taskMix.dominantTier, report.taskMix.costSavingsGoal)}
        ${metricCard("Runtime", report.runtime?.label ?? "none", report.runtime?.baseUrl ?? "start a local runtime")}
        ${metricCard("Recommended", report.recommendedModelId ?? "none", report.nextAction)}
      </div>
      <form method="post" action="/api/follow-up" class="inline-form">
        <input type="hidden" name="returnTo" value="/model-improvement?project=${escapeHtml(encodeURIComponent(report.projectRootUri))}">
        <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
        <input type="hidden" name="action" value="local-llm-download-recommendations">
        <button type="submit">${iconLabel("download", "Write Recommendation Report")}</button>
        <span class="muted">Writes only <code>.agent-workflow/model-improvement/local-llm-download-recommendations.*</code>.</span>
      </form>
      <div class="table-wrap"><table><thead><tr><th>Priority</th><th>Model</th><th>Tier</th><th>Fit</th><th>Download</th><th>Why</th></tr></thead><tbody>${rows || "<tr><td colspan=\"6\">Start a local runtime before model recommendations can be tested.</td></tr>"}</tbody></table></div>
    </section>
  `;
}

export function renderLocalLlmInstallationPlanHtml(report: LocalLlmInstallationPlanReport): string {
  const statusClass = report.status === "already-installed" ? "completed" : report.status === "no-selection" ? "failed" : "queued";
  const rows = report.actions.map((action) => `
    <tr>
      <td>${escapeHtml(action.id)}<br><span class="muted">${escapeHtml(action.modelId)}</span></td>
      <td><span class="flag ${action.risk === "high" ? "bad" : action.risk === "medium" ? "warn" : "good"}">${escapeHtml(action.risk)}</span><br><span class="muted">${formatNumber(action.diskEstimateGb)} GB est.</span></td>
      <td>${escapeHtml(action.runtime)}<br><span class="muted">${escapeHtml(action.primaryTier)} / ${escapeHtml(action.hardwareFit)}</span></td>
      <td>${action.commands.map((command) => `<code>${escapeHtml(command.command)}</code>${command.requiresApproval ? "<br><span class=\"muted\">review before running</span>" : ""}`).join("<hr>")}</td>
      <td>${action.envHints.map((hint) => `<code>${escapeHtml(hint)}</code>`).join("<br>")}</td>
    </tr>
  `).join("");
  const returnTo = `/model-improvement?project=${encodeURIComponent(report.projectRootUri)}`;
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Local Model Installation Plan</h2>
          <span class="muted">Reviewed runtime-specific commands for installing recommended local models.</span>
        </div>
        <span class="status ${statusClass}">${escapeHtml(report.status)}</span>
      </div>
      <div class="metric-grid">
        ${metricCard("Selected", report.selectedModels, `${formatNumber(report.actions.length)} model action(s)`)}
        ${metricCard("Recommended", report.recommendedModelId ?? "none", `runtime ${report.runtimeStatus}`)}
        ${metricCard("Downloads", report.safety.executesDownloads ? "executes" : "plan only", "operator runs download commands")}
        ${metricCard("Provider Edits", report.safety.editsProviderSettings ? "yes" : "no", "env hints only")}
      </div>
      <p class="muted">${escapeHtml(report.safety.approvalBoundary)}</p>
      <form method="post" action="/api/follow-up" class="inline-form">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
        <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
        <input type="hidden" name="action" value="local-llm-install-plan">
        <input name="model" value="${escapeHtml(report.selectedModels)}" aria-label="model selection">
        <button type="submit">${iconLabel("download", "Write Install Plan")}</button>
        <span class="muted">Writes Markdown, JSON, and a reviewed shell script under <code>.agent-workflow/model-improvement/</code>.</span>
      </form>
      <div class="table-wrap"><table><thead><tr><th>Action</th><th>Risk</th><th>Runtime</th><th>Commands</th><th>Env Hints</th></tr></thead><tbody>${rows || "<tr><td colspan=\"5\">No local model install actions selected.</td></tr>"}</tbody></table></div>
    </section>
  `;
}

export function renderLocalLlmInventoryHtml(report: LocalLlmInventoryReport): string {
  const statusClass = report.status === "ready" ? "completed" : report.status === "storage-pressure" ? "failed" : "queued";
  const rootRows = report.cacheRoots.map((root) => `
    <tr>
      <td>${escapeHtml(root.label)}<br><code>${escapeHtml(root.path)}</code></td>
      <td><span class="flag ${root.exists ? "good" : "queued"}">${root.exists ? "found" : "missing"}</span></td>
      <td>${escapeHtml(root.sizeLabel)}<br><span class="muted">${formatNumber(root.modelDirectories)} model dir(s)</span></td>
      <td>${renderDashboardDateTime(root.lastModifiedAt, "n/a")}</td>
      <td>${escapeHtml(root.error ?? "none")}</td>
    </tr>
  `).join("");
  const modelRows = report.models.slice(0, 12).map((model) => `
    <tr>
      <td>${escapeHtml(model.modelId)}<br><span class="muted">${escapeHtml(model.source)}</span></td>
      <td>${escapeHtml(model.cacheRoot)}<br><span class="muted">${escapeHtml(model.sizeLabel)}</span></td>
      <td>${renderDashboardDateTime(model.lastUsedAt, "unknown")}</td>
      <td>${model.recommended ? "<span class=\"flag good\">recommended</span>" : "<span class=\"flag queued\">other</span>"}</td>
      <td>${model.pruneCandidate ? "<span class=\"flag warn\">review prune</span>" : "<span class=\"flag good\">keep</span>"}<br><span class="muted">${escapeHtml(truncateText(model.reason, 100))}</span></td>
    </tr>
  `).join("");
  const returnTo = `/model-improvement?project=${encodeURIComponent(report.projectRootUri)}`;
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Local Model Disk Inventory</h2>
          <span class="muted">Read-only cache scan before recommending additional local model downloads.</span>
        </div>
        <span class="status ${statusClass}">${escapeHtml(report.status)}</span>
      </div>
      <div class="metric-grid">
        ${metricCard("Total Cache", report.totalCacheLabel, `${formatNumber(report.cacheRoots.filter((root) => root.exists).length)} cache root(s) found`)}
        ${metricCard("Free Disk", report.storage.freeBytes === null ? "unknown" : formatBytes(report.storage.freeBytes), report.storage.status)}
        ${metricCard("Models", report.models.length, "runtime catalog and cache directories")}
        ${metricCard("Prune Review", report.pruneCandidates.length, "stale, unrecommended candidates")}
      </div>
      <p class="muted">${escapeHtml(report.recommendation)}</p>
      <form method="post" action="/api/follow-up" class="inline-form">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
        <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
        <input type="hidden" name="action" value="local-llm-inventory">
        <button type="submit">${iconLabel("activity", "Write Inventory Report")}</button>
        <span class="muted">Writes only <code>.agent-workflow/model-improvement/local-llm-inventory.*</code>.</span>
      </form>
      <div class="table-wrap"><table><thead><tr><th>Cache Root</th><th>Status</th><th>Size</th><th>Modified</th><th>Notes</th></tr></thead><tbody>${rootRows}</tbody></table></div>
      <div class="table-wrap"><table><thead><tr><th>Model</th><th>Cache/Size</th><th>Last Used</th><th>Recommendation</th><th>Prune</th></tr></thead><tbody>${modelRows || "<tr><td colspan=\"5\">No local model entries found yet.</td></tr>"}</tbody></table></div>
    </section>
  `;
}

export function renderLocalLlmPrunePlanHtml(report: LocalLlmPrunePlanReport): string {
  const statusClass = report.status === "no-candidates" ? "completed" : report.status === "needs-review" ? "failed" : "queued";
  const rows = report.actions.map((action) => `
    <tr>
      <td>${escapeHtml(action.id)}<br><span class="muted">${escapeHtml(action.modelId)}</span></td>
      <td>${escapeHtml(action.cacheRoot)}<br><code>${escapeHtml(action.cachePath ?? "no path detected")}</code></td>
      <td>${escapeHtml(action.sizeLabel)}<br><span class="muted">last used ${renderDashboardDateTime(action.lastUsedAt, "unknown")}</span></td>
      <td><span class="flag ${action.risk === "high" ? "warn" : "queued"}">${escapeHtml(action.risk)}</span><br>${action.recommended ? "<span class=\"flag good\">recommended</span>" : "<span class=\"flag queued\">not recommended</span>"}</td>
      <td><code>${escapeHtml(action.command)}</code><br><span class="muted">${escapeHtml(truncateText(action.reason, 120))}</span></td>
    </tr>
  `).join("");
  const returnTo = `/model-improvement?project=${encodeURIComponent(report.projectRootUri)}`;
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Local Model Prune Plan</h2>
          <span class="muted">Reviewed cleanup commands from inventory candidates. Nothing is deleted automatically.</span>
        </div>
        <span class="status ${statusClass}">${escapeHtml(report.status)}</span>
      </div>
      <div class="metric-grid">
        ${metricCard("Actions", report.actions.length, "reviewable cleanup commands")}
        ${metricCard("Potential Reclaim", report.reclaimableLabel, "cache bytes from selected actions")}
        ${metricCard("High Risk", report.actions.filter((action) => action.risk === "high").length, "extra review")}
        ${metricCard("Deletes Executed", report.safety.executesDeletes ? "yes" : "no", "planner boundary")}
      </div>
      <p class="muted">${escapeHtml(report.nextAction)}</p>
      <form method="post" action="/api/follow-up" class="inline-form">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
        <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
        <input type="hidden" name="action" value="local-llm-prune-plan">
        <input name="model" value="${escapeHtml(report.selectedModels)}" aria-label="model selection">
        <button type="submit">${iconLabel("trash", "Write Prune Plan")}</button>
        <span class="muted">Use <code>candidates</code>, <code>all</code>, or specific prune/model ids. Writes only <code>.agent-workflow/model-improvement/local-llm-prune-plan.*</code>.</span>
      </form>
      <div class="table-wrap"><table><thead><tr><th>Action</th><th>Cache Path</th><th>Size</th><th>Risk</th><th>Command</th></tr></thead><tbody>${rows || "<tr><td colspan=\"5\">No prune candidates found yet.</td></tr>"}</tbody></table></div>
    </section>
  `;
}

export function renderLocalLlmRoutingDecisionSnapshotsHtml(report: LocalLlmRoutingDecisionSnapshotReport): string {
  const latest = report.snapshots.at(-1) ?? null;
  const previous = report.latestDelta.previousAt ?? "none";
  const stateChanges = report.latestDelta.stateChanges.length
    ? report.latestDelta.stateChanges.join("; ")
    : "none";
  const rows = report.snapshots.slice(-8).reverse().map((snapshot) => `
    <tr>
      <td>${renderDashboardDateTime(snapshot.generatedAt)}<br><span class="muted">${escapeHtml(snapshot.decisionHash.slice(0, 12))}</span></td>
      <td><span class="flag ${snapshot.status === "active" ? "good" : snapshot.status === "recommended" ? "warn" : "queued"}">${escapeHtml(snapshot.status)}</span></td>
      <td>${formatNumber(snapshot.items.length)} item(s)<br><span class="muted">applied ${formatNumber(snapshot.counts.applied ?? 0)}, planned ${formatNumber(snapshot.counts.planned ?? 0)}, recommended ${formatNumber(snapshot.counts.recommended ?? 0)}</span></td>
      <td>${escapeHtml(formatUsd(snapshot.totalNetSavingsUsd))}</td>
    </tr>
  `).join("");
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Routing Decision Snapshots</h2>
          <span class="muted">Persisted timeline history for comparing routing decisions over time.</span>
        </div>
        <span class="status ${report.captured ? "completed" : "queued"}">${report.captured ? "changed" : "unchanged"}</span>
      </div>
      <div class="metric-grid snapshot-metrics">
        ${metricCard("Snapshots", report.snapshots.length, "kept locally")}
        ${metricCard("Latest", latest ? formatDashboardDateTimeText(latest.generatedAt) : "none", "last persisted")}
        ${metricCard("Previous", previous === "none" ? "none" : formatDashboardDateTimeText(previous), "comparison baseline")}
        ${metricCard("Changed Items", report.latestDelta.changedItems, `${report.latestDelta.added} added, ${report.latestDelta.removed} removed`)}
        ${metricCard("Savings Delta", formatUsd(report.latestDelta.netSavingsDeltaUsd), "latest vs previous")}
        ${metricCard("Current Hash", report.currentSnapshot.decisionHash.slice(0, 10), report.captured ? "new projection" : "same projection")}
      </div>
      <form method="post" action="/api/follow-up" class="inline-form">
        <input type="hidden" name="returnTo" value="/model-improvement?project=${encodeURIComponent(report.projectRootUri)}">
        <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
        <input type="hidden" name="action" value="local-llm-routing-decision-snapshot">
        <button type="submit">${iconLabel("activity", "Capture Decision Snapshot")}</button>
        <span class="muted">Appends only if the routing decision hash changed.</span>
      </form>
      <div class="meta-grid compact">
        <div><strong>State Changes</strong>${escapeHtml(stateChanges)}</div>
        <div><strong>Files</strong><code>.agent-workflow/model-improvement/local-routing-decision-snapshots.*</code></div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Captured</th><th>Status</th><th>Items</th><th>Net Savings</th></tr></thead><tbody>${rows || "<tr><td colspan=\"4\">No persisted decision snapshots yet.</td></tr>"}</tbody></table></div>
    </section>
  `;
}

export function renderLocalLlmRoutingDecisionTimelineHtml(report: DashboardLocalLlmRoutingDecisionTimeline): string {
  const statusClass = report.status === "active" ? "completed" : report.status === "recommended" ? "failed" : "queued";
  const rows = report.items.map((item) => `
    <tr>
      <td><span class="flag ${item.state === "applied" ? "good" : item.state === "recommended" ? "warn" : "queued"}">${escapeHtml(item.state)}</span><br><span class="muted">${escapeHtml(item.recommendationId)}</span></td>
      <td>${escapeHtml(item.action)}<br><span class="muted">${escapeHtml(item.priority)}</span></td>
      <td>${escapeHtml(item.target)}<br><span class="muted">${escapeHtml(item.agentId)}</span></td>
      <td>${escapeHtml(item.noteId ?? "none")}<br><span class="muted">${escapeHtml(item.providerTier)}</span></td>
      <td>${formatNumber(item.runs)} run(s)<br><span class="muted">fallback ${item.fallbackRate}, quality ${item.quality ?? "n/a"}</span></td>
      <td>${escapeHtml(formatUsd(item.netSavingsUsd))}<br><span class="muted">${escapeHtml(truncateText(item.outcome, 140))}</span></td>
    </tr>
  `).join("");
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Model Routing Decision Timeline</h2>
          <span class="muted">Recommendation to note plan to applied receipt to current route outcome.</span>
        </div>
        <span class="status ${statusClass}">${escapeHtml(report.status)}</span>
      </div>
      <div class="metric-grid">
        ${metricCard("Timeline Items", report.items.length, "top routing decisions")}
        ${metricCard("Applied", report.items.filter((item) => item.state === "applied").length, "active routing notes")}
        ${metricCard("Planned", report.items.filter((item) => item.state === "planned").length, "reviewed note plans")}
        ${metricCard("Recommended", report.items.filter((item) => item.state === "recommended").length, "not yet planned")}
        ${metricCard("Monitoring", report.items.filter((item) => item.state === "monitoring").length, "hold decisions")}
        ${metricCard("Application Receipt", report.sourceApplicationGeneratedAt ? formatDashboardDateTimeText(report.sourceApplicationGeneratedAt) : "n/a", "latest apply evidence")}
      </div>
      <p class="muted">${report.summary.map((item) => escapeHtml(item)).join(" ")}</p>
      <div class="table-wrap"><table><thead><tr><th>State</th><th>Decision</th><th>Target</th><th>Plan/Route</th><th>Outcome Evidence</th><th>Economics</th></tr></thead><tbody>${rows || "<tr><td colspan=\"6\">No routing decisions are available yet.</td></tr>"}</tbody></table></div>
    </section>
  `;
}

export function renderLocalLlmRoutingNoteApplicationHtml(report: DashboardLocalLlmRoutingNoteApplicationStatus): string {
  const statusClass = report.error ? "failed" : report.exists ? "completed" : report.activePreferenceExists ? "queued" : "queued";
  const selected = report.selectedNoteIds.length ? report.selectedNoteIds.join(", ") : "none";
  const applied = report.appliedNoteIds.length ? report.appliedNoteIds.join(", ") : "none";
  const skipped = report.skippedNoteIds.length ? report.skippedNoteIds.join(", ") : "none";
  const hashPair = report.beforeHash && report.afterHash
    ? `${report.beforeHash.slice(0, 10)} -> ${report.afterHash.slice(0, 10)}`
    : "n/a";
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Applied Local Routing Notes</h2>
          <span class="muted">Active project-local routing preferences and rollback receipt evidence.</span>
        </div>
        <span class="status ${statusClass}">${report.exists ? "receipt" : report.activePreferenceExists ? "preferences only" : "missing"}</span>
      </div>
      <div class="metric-grid">
        ${metricCard("Applied", report.appliedNoteIds.length, "selected notes appended")}
        ${metricCard("Skipped", report.skippedNoteIds.length, "duplicates or unmatched ids")}
        ${metricCard("Active Markers", report.activeLocalRoutingNoteMarkers, "agentflow local note sections")}
        ${metricCard("Receipt Approved", report.approved ? "yes" : "no", report.generatedAt ? `generated ${formatDashboardDateTimeText(report.generatedAt)}` : "no receipt yet")}
        ${metricCard("Preference Size", formatBytes(report.activePreferenceBytes), report.activePreferenceExists ? report.targetFile : "not written")}
        ${metricCard("Hash Change", hashPair, "before -> after")}
      </div>
      <div class="meta-grid compact">
        <div><strong>Receipt File</strong><code>${escapeHtml(report.path)}</code></div>
        <div><strong>Target File</strong><code>${escapeHtml(report.targetFile)}</code></div>
        <div><strong>Source Plan</strong>${renderDashboardDateTime(report.sourcePlanGeneratedAt)}</div>
        <div><strong>Active Hash</strong><code>${escapeHtml(report.activePreferenceHash?.slice(0, 16) ?? "n/a")}</code></div>
      </div>
      <div class="meta-grid compact">
        <div><strong>Selected</strong><code>${escapeHtml(selected)}</code></div>
        <div><strong>Applied</strong><code>${escapeHtml(applied)}</code></div>
        <div><strong>Skipped</strong><code>${escapeHtml(skipped)}</code></div>
        <div><strong>Rollback</strong>${escapeHtml(report.rollback ?? "Apply a reviewed note plan to create rollback evidence.")}</div>
      </div>
      ${report.error ? `<p class="error">${escapeHtml(report.error)}</p>` : ""}
      ${report.activePreferencePreview ? `<pre>${escapeHtml(report.activePreferencePreview)}</pre>` : "<p class=\"muted\">No active local routing preference notes have been written yet.</p>"}
    </section>
  `;
}

export function renderLocalLlmRoutingRecommendationHtml(report: LocalLlmRoutingRecommendationReport): string {
  const statusClass = report.status === "expand" ? "completed" : report.status === "retreat" ? "failed" : "queued";
  const rows = report.recommendations.map((item) => `
    <tr>
      <td><span class="flag ${item.priority === "high" ? "warn" : item.priority === "medium" ? "queued" : "good"}">${escapeHtml(item.priority)}</span><br>${escapeHtml(item.id)}</td>
      <td><span class="flag ${item.action === "expand" ? "good" : item.action === "retreat" ? "warn" : "queued"}">${escapeHtml(item.action)}</span></td>
      <td>${escapeHtml(item.workflowId)}<br><span class="muted">${escapeHtml(item.stageId)} / ${escapeHtml(item.agentId)}</span></td>
      <td>${escapeHtml(item.routeClass)}<br><span class="muted">${escapeHtml(item.providerId)} / ${escapeHtml(item.modelTier)}</span></td>
      <td>${formatNumber(item.runs)} run(s)<br><span class="muted">fallback ${item.fallbackRate}, quality ${item.averageQuality ?? "n/a"}</span></td>
      <td>${formatNumber(item.routeFeedback.total)} signal(s)<br><span class="muted">helpful ${item.routeFeedback.helpful}, costly ${item.routeFeedback.costly}, neutral ${item.routeFeedback.neutral}</span></td>
      <td>${escapeHtml(formatUsd(item.estimatedNetSavingsUsd))}<br><span class="muted">${escapeHtml(truncateText(item.recommendation, 120))}</span></td>
    </tr>
  `).join("");
  const returnTo = `/model-improvement?project=${encodeURIComponent(report.projectRootUri)}`;
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Savings-Aware Local Routing</h2>
          <span class="muted">Expand, hold, or retreat recommendations from quality, fallback, latency, storage, and savings evidence.</span>
        </div>
        <span class="status ${statusClass}">${escapeHtml(report.status)}</span>
      </div>
      <div class="metric-grid">
        ${metricCard("Expand", report.recommendations.filter((item) => item.action === "expand").length, "local trial candidates")}
        ${metricCard("Hold", report.recommendations.filter((item) => item.action === "hold").length, "keep current boundary")}
        ${metricCard("Retreat", report.recommendations.filter((item) => item.action === "retreat").length, "move back toward hosted")}
        ${metricCard("Net Savings", formatUsd(report.evidence.netEstimatedSavingsUsd), "current cost ledger")}
        ${metricCard("Route Receipts", report.evidence.routeReceipts, "inspected model_route receipts")}
        ${metricCard("Storage", report.evidence.storageStatus, `${formatNumber(report.evidence.pruneCandidateCount)} prune candidate(s)`)}
      </div>
      <p class="muted">${escapeHtml(report.nextAction)}</p>
      <form method="post" action="/api/follow-up" class="inline-form">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
        <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
        <input type="hidden" name="action" value="local-llm-routing-recommendations">
        <button type="submit">${iconLabel("activity", "Write Routing Recommendations")}</button>
        <span class="muted">Writes advisory files only. Routing/provider settings are not changed.</span>
      </form>
      <form method="post" action="/api/follow-up" class="inline-form">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
        <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
        <input type="hidden" name="action" value="local-llm-routing-note-plan">
        <input type="hidden" name="ids" value="all">
        <button type="submit" class="secondary">${iconLabel("file", "Write Routing Note Plan")}</button>
        <span class="muted">Turns expand/retreat recommendations into reviewed project-local tuning notes.</span>
      </form>
      <form method="post" action="/api/follow-up" class="inline-form">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
        <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
        <input type="hidden" name="action" value="apply-local-llm-routing-note-plan">
        <input type="hidden" name="ids" value="all">
        <button type="submit" class="secondary">${iconLabel("check", "Dry Run Apply Notes")}</button>
        <span class="muted">Previews appending reviewed notes to <code>.agent-workflow/tuning/routing-preferences.md</code>.</span>
      </form>
      <div class="table-wrap"><table><thead><tr><th>Priority</th><th>Action</th><th>Target</th><th>Route</th><th>Evidence</th><th>Feedback</th><th>Economics</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>
  `;
}

export function renderLocalLlmSetupChecklistHtml(report: LocalLlmSetupChecklistReport): string {
  const statusClass = report.status === "pass" ? "completed" : report.status === "fail" ? "failed" : "queued";
  const smoke = report.smokeOutcomes;
  const tierModels = report.localProvider.selectedTierModels
    .map((item) => `${item.tier}=${item.model} (${item.source})`)
    .join(", ") || "none";
  const rows = report.checks.map((check) => `
    <tr>
      <td><span class="flag ${check.status === "pass" ? "good" : check.status === "fail" ? "bad" : "warn"}">${escapeHtml(check.status)}</span></td>
      <td>${escapeHtml(check.label)}<br><span class="muted">${escapeHtml(check.detail)}</span></td>
      <td>${escapeHtml(check.nextAction)}</td>
    </tr>
  `).join("");
  const commandRows = report.nextCommands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
  const smokeRows = smoke.latestOutcomes.map((outcome) => `
    <tr>
      <td><a href="/run?id=${encodeURIComponent(outcome.runId)}">${escapeHtml(outcome.runId.slice(0, 8))}</a><br><span class="muted">${renderDashboardDateTime(outcome.startedAt)}</span></td>
      <td><span class="flag ${outcome.routeClass === "local-selected" ? "good" : outcome.routeClass === "missing" || outcome.status === "failed" ? "bad" : "warn"}">${escapeHtml(outcome.routeClass.replace(/-/g, " "))}</span><br><span class="muted">${escapeHtml(outcome.status)}</span></td>
      <td>${escapeHtml(outcome.providerId ?? "none")}<br><span class="muted">${escapeHtml([outcome.modelTier, outcome.requestedModelTier].filter(Boolean).join(" / ") || "no tier")}</span></td>
      <td>${outcome.qualityScore ?? "n/a"}</td>
      <td>${escapeHtml(truncateText(outcome.routeReason ?? "No route reason recorded.", 160))}</td>
    </tr>
  `).join("");
  const returnTo = `/model-improvement?project=${encodeURIComponent(report.projectRootUri)}`;
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Local LLM Setup Checklist</h2>
          <span class="muted">Verifies endpoint readiness, catalog model selection, routing visibility, and the first low-risk local route receipt.</span>
        </div>
        <div class="actions">
          <span class="status ${statusClass}">${escapeHtml(report.status)}</span>
          <a class="button secondary" href="/api/local-llm-checklist?project=${encodeURIComponent(report.projectRootUri)}">JSON</a>
        </div>
      </div>
      <div class="metric-grid">
        ${metricCard("Endpoint", report.localProvider.status, report.localProvider.baseUrl)}
        ${metricCard("Models Listed", report.localProvider.modelsListed, report.localProvider.model)}
        ${metricCard("Tier Models", report.localProvider.selectedTierModels.length, tierModels)}
        ${metricCard("Auto Routing", report.routing.defaultProvider, `fast=${report.routing.fastProvider}, standard=${report.routing.standardProvider}`)}
        ${metricCard("Holdout", report.routing.localHoldoutApproved ? "approved" : report.routing.localHoldoutStatus, "low-risk local promotion")}
        ${metricCard("Local Receipts", report.routing.localRouteReceipts, `${report.routing.localSkippedReceipts} skipped, ${report.routing.hostedFallbackReceipts} hosted fallback`)}
      </div>
      <section class="subpanel">
        <div class="section-heading">
          <div>
            <h3>Local Smoke Outcomes</h3>
            <span class="muted">Compares low-risk local route smoke runs over time.</span>
          </div>
          <span class="flag ${smoke.counts["local-selected"] > 0 ? "good" : smoke.smokeRuns ? "warn" : "queued"}">${formatNumber(smoke.smokeRuns)} smoke runs</span>
        </div>
        <div class="metric-grid">
          ${metricCard("Local Successes", smoke.counts["local-selected"], "completed local/BYO selections")}
          ${metricCard("First Local Success", smoke.firstSuccessAt ? formatDashboardDateTimeText(smoke.firstSuccessAt) : "none", "true local-selected receipt")}
          ${metricCard("Latest Smoke", smoke.latestSmokeAt ? formatDashboardDateTimeText(smoke.latestSmokeAt) : "none", "most recent setup smoke")}
          ${metricCard("Latest Issue", smoke.latestFailureReason ? truncateText(smoke.latestFailureReason, 72) : "none", "failure, skip, fallback, or hosted selection")}
        </div>
        <p class="muted">${escapeHtml(smoke.recommendation)}</p>
        <div class="table-wrap"><table><thead><tr><th>Run</th><th>Outcome</th><th>Provider/Tier</th><th>Quality</th><th>Reason</th></tr></thead><tbody>${smokeRows || "<tr><td colspan=\"5\">No local LLM smoke runs found yet.</td></tr>"}</tbody></table></div>
      </section>
      <div class="table-wrap"><table><thead><tr><th>Status</th><th>Check</th><th>Next Action</th></tr></thead><tbody>${rows}</tbody></table></div>
      <form class="inline-form" method="post" action="/api/follow-up">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
        <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
        <input type="hidden" name="action" value="local-llm-smoke">
        <button type="submit">${iconLabel("activity", "Run Low-Risk Local Route Smoke")}</button>
        <span class="muted">Queues one <code>provider-smoke</code> fast-tier stage and writes normal route receipts.</span>
      </form>
      <details>
        <summary>CLI commands</summary>
        <ul>${commandRows}</ul>
      </details>
    </section>
  `;
}

export function renderLocalLlmSetupGuideHtml(report: LocalLlmSetupGuideReport): string {
  const statusClass = report.status === "ready" ? "completed" : "queued";
  const runtimeRows = report.runtimes.map((runtime) => `
    <tr>
      <td>${escapeHtml(runtime.label)}<br><code>${escapeHtml(runtime.baseUrl)}</code></td>
      <td><span class="flag ${runtime.status === "ready" ? "good" : runtime.status === "empty" ? "warn" : "bad"}">${escapeHtml(runtime.status)}</span></td>
      <td>${formatNumber(runtime.modelCount)}<br><span class="muted">${escapeHtml(runtime.models.slice(0, 4).join(", ") || "none listed")}</span></td>
      <td>${escapeHtml(runtime.selectedTierModels.map((item) => `${item.tier}=${item.model}`).join(", "))}</td>
      <td>${escapeHtml(runtime.nextAction)}</td>
    </tr>
  `).join("");
  const blockerRows = report.blockers.length
    ? report.blockers.map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join("")
    : "<li>No blockers. The routing note can be written after approval.</li>";
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Guided Local Model Setup</h2>
          <span class="muted">Detects local OpenAI-compatible runtimes and prepares project-local setup or routing notes.</span>
        </div>
        <span class="status ${statusClass}">${escapeHtml(report.status)}</span>
      </div>
      <div class="metric-grid">
        ${metricCard("Detected Ready", report.runtimes.filter((runtime) => runtime.status === "ready").length, "runtime catalogs")}
        ${metricCard("Recommended", report.recommendedRuntime?.label ?? "none", report.recommendedRuntime?.baseUrl ?? "start a local runtime")}
        ${metricCard("Routing Note", report.routingNoteEligible ? "eligible" : "blocked", report.approved ? "approved" : "needs approval")}
        ${metricCard("First Local Smoke", report.firstLocalSmokeSuccessAt ? formatDashboardDateTimeText(report.firstLocalSmokeSuccessAt) : "none", "required evidence")}
      </div>
      <p class="muted">${escapeHtml(report.recommendation)}</p>
      <div class="split-grid compact">
        <div>
          <h3>Blockers</h3>
          <ul>${blockerRows}</ul>
        </div>
        <div>
          <h3>Safe Writes</h3>
          <ul>
            <li><code>.agent-workflow/model-improvement/local-llm-setup-guide.*</code></li>
            <li><code>.agent-workflow/tuning/local-model-routing-note.*</code> only when healthy and approved</li>
          </ul>
        </div>
      </div>
      <div class="actions">
        <form method="post" action="/api/follow-up">
          <input type="hidden" name="returnTo" value="/model-improvement?project=${escapeHtml(encodeURIComponent(report.projectRootUri))}">
          <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
          <input type="hidden" name="action" value="local-llm-setup-guide">
          <button type="submit">${iconLabel("file", "Write Setup Guide")}</button>
        </form>
        <form method="post" action="/api/follow-up">
          <input type="hidden" name="returnTo" value="/model-improvement?project=${escapeHtml(encodeURIComponent(report.projectRootUri))}">
          <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
          <input type="hidden" name="action" value="local-llm-setup-approve">
          <button type="submit" class="secondary">${iconLabel("check", "Approve Healthy Routing Note")}</button>
        </form>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Runtime</th><th>Status</th><th>Models</th><th>Tier Selection</th><th>Next Action</th></tr></thead><tbody>${runtimeRows || "<tr><td colspan=\"5\">No local runtime probes were configured.</td></tr>"}</tbody></table></div>
    </section>
  `;
}

export function renderLocalProviderEvidenceHtml(evidence: DashboardLocalProviderEvidence): string {
  const statusClass = evidence.status === "ready" ? "completed" : evidence.status === "not-configured" ? "failed" : "queued";
  const feedback = `${evidence.localAccepted}/${evidence.localRevised}/${evidence.localRejected}`;
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Local Provider Evidence</h2>
          <span class="muted">Cost-saving signal for local/BYO model routes before expanding automatic routing.</span>
        </div>
        <span class="status ${statusClass}">${escapeHtml(evidence.status)}</span>
      </div>
      <div class="metric-grid">
        ${metricCard("Local Stages", evidence.localStageCount, evidence.providerIds.length ? evidence.providerIds.join(", ") : "none yet")}
        ${metricCard("Hosted Stages", evidence.hostedStageCount, "OpenAI, Bedrock, Kiro, or other non-local providers")}
        ${metricCard("Avoided Hosted Calls", evidence.estimatedAvoidedHostedCalls, "local/BYO routed stages")}
        ${metricCard("Fallback Rate", evidence.localFallbackRate === null ? "n/a" : evidence.localFallbackRate, "local/BYO fallback")}
        ${metricCard("Local Quality", evidence.localAverageQuality === null ? "n/a" : evidence.localAverageQuality, `feedback A/R/R ${feedback}`)}
        ${metricCard("Local Latency", evidence.localAverageLatencyMs === null ? "n/a" : `${Math.round(evidence.localAverageLatencyMs)}ms`, "weighted average")}
      </div>
      <div class="meta-grid compact">
        <div><strong>Configured</strong>${evidence.configured ? "yes" : "no"}</div>
        <div><strong>Local Providers Seen</strong>${evidence.providerIds.length ? escapeHtml(evidence.providerIds.join(", ")) : "none"}</div>
        <div><strong>Hosted Quality</strong>${evidence.hostedAverageQuality === null ? "n/a" : evidence.hostedAverageQuality}</div>
        <div><strong>Hosted Latency</strong>${evidence.hostedAverageLatencyMs === null ? "n/a" : `${Math.round(evidence.hostedAverageLatencyMs)}ms`}</div>
      </div>
      <p class="muted">${escapeHtml(evidence.recommendation)}</p>
    </section>
  `;
}

export function renderModelImprovementFeedbackCaptureHtml(report: DashboardModelImprovementReport): string {
  const runOptions = report.feedbackTargets.map((target) => `
    <option value="${escapeHtml(target.runId)}">${escapeHtml(`${target.workflowId} ${target.status} ${target.runId.slice(0, 8)}`)}</option>
  `).join("");
  const rows = report.feedbackTargets.map((target) => `
    <tr>
      <td><a href="/run?id=${encodeURIComponent(target.runId)}">${escapeHtml(target.runId.slice(0, 8))}</a><br><span class="muted">${renderDashboardDateTime(target.startedAt)}</span><div class="row-tools">${renderRunInfoDialog({
        runId: target.runId,
        workflowId: target.workflowId,
        status: target.status,
        task: target.task,
        startedAt: target.startedAt,
        summary: [
          target.summary ? `${target.summary.completedTasks}/${target.summary.totalTasks} stages complete, ${target.summary.failedTasks} failed` : "summary unavailable",
          target.summary?.recommendedNextAction ?? "next action unavailable",
          target.quality ? `quality ${target.quality.averageQuality ?? "n/a"}, ${target.quality.qualityPassCount} pass, ${target.quality.qualityFailCount} review` : "quality unavailable"
        ]
      })}</div></td>
      <td>${escapeHtml(target.workflowId)}<br><span class="status ${escapeHtml(target.status)}">${escapeHtml(target.status)}</span></td>
      <td>
        <strong>${escapeHtml(target.task)}</strong>
        ${target.summary ? `<br><span class="muted">${target.summary.completedTasks}/${target.summary.totalTasks} stages complete · ${target.summary.failedTasks} failed · ${escapeHtml(target.summary.recommendedNextAction)}</span>` : ""}
      </td>
      <td>${renderFeedbackTargetEvidenceHtml(target)}</td>
      <td>${escapeHtml(target.provider ?? "default")}<br><span class="muted">${escapeHtml(target.modelTier ?? "auto tier")}</span></td>
      <td>${renderFeedbackTargetActionForms(target)}</td>
    </tr>
  `).join("");
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Feedback Capture</h2>
          <span class="muted">Turn recent run reviews into local model-improvement evidence.</span>
        </div>
        <span class="flag ${report.feedbackTargets.length ? "warn" : "good"}">${report.feedbackTargets.length ? `${report.feedbackTargets.length} need feedback` : "caught up"}</span>
      </div>
      <form class="inline-action-form" method="post" action="/api/follow-up">
        <input type="hidden" name="action" value="feedback">
        <label>Run
          <select name="runId">${runOptions || "<option value=\"\">No recent runs need feedback</option>"}</select>
        </label>
        <label>Rating
          <select name="rating">
            <option value="accepted">accepted</option>
            <option value="revised">revised</option>
            <option value="rejected">rejected</option>
          </select>
        </label>
        <label class="wide">Note
          <input name="note" placeholder="What should future runs learn?">
        </label>
        <button type="submit" ${report.feedbackTargets.length ? "" : "disabled"}>Record Feedback</button>
      </form>
      <p class="muted">A few good notes are enough to move tuning proposals from generic <code>feedback_needed</code> hints toward concrete routing, prompt, or context-budget recommendations. Use accepted for useful output, revised for mostly useful output that needed correction, and rejected for wrong or wasteful output.</p>
      <div class="table-wrap"><table><thead><tr><th>Run</th><th>Workflow</th><th>Summary</th><th>Evidence</th><th>Route</th><th>Feedback</th></tr></thead><tbody>${rows || "<tr><td colspan=\"6\">Recent finished runs already have feedback or no finished runs were found.</td></tr>"}</tbody></table></div>
    </section>
  `;
}

export function renderModelImprovementHtml(
  report: DashboardModelImprovementReport | null,
  projects: DashboardProjectSummary[],
  params: URLSearchParams
): string {
  const selectedProject = report?.projectDir ?? params.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT ?? "";
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}">${escapeHtml(project.name)} - ${escapeHtml(project.rootUri)}</option>`).join("");
  const jsonHref = report ? `/api/model-improvement?project=${encodeURIComponent(report.projectDir)}` : "";
  const body = report
    ? renderModelImprovementReportHtml(report)
    : `<section class="panel"><h2>No Project Selected</h2><p class="muted">Run onboarding or enter a project path to inspect local model-improvement evidence.</p></section>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Model Improvement</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("model-improvement")}
  <main id="main-content">
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Model Improvement</h1>
        <p class="muted">Read-only local evidence for quality, cost, feedback, eval coverage, routing, and promotion readiness.</p>
      </div>
      ${jsonHref ? `<a class="button secondary" href="${escapeHtml(jsonHref)}">JSON</a>` : ""}
    </div>
    ${renderDashboardFlash(params)}
    ${renderDashboardActionHistory()}
    ${report ? dashboardSectionIndex() : ""}
    <section class="panel">
      <form method="get" class="workflow-form">
        <label class="wide">Project path
          <input name="project" value="${escapeHtml(selectedProject)}" list="model-improvement-projects" placeholder="/path/to/project">
          <datalist id="model-improvement-projects">${projectOptions}</datalist>
        </label>
        <label>Run limit
          <input name="limit" value="${escapeHtml(params.get("limit") ?? "50")}" inputmode="numeric">
        </label>
        <div class="form-actions"><button type="submit">Inspect</button></div>
      </form>
    </section>
    ${body}
  </main>
</body>
</html>`;
}

export function renderModelImprovementReportHtml(report: DashboardModelImprovementReport): string {
  const proposalRows = Object.entries(report.proposalCounts).map(([kind, count]) => `
    <tr><td>${escapeHtml(kind)}</td><td>${formatNumber(count)}</td></tr>
  `).join("");
  const commandRows = report.nextCommands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
  const overlayKindRows = Object.entries(report.tuningOverlay.proposalKinds).map(([kind, count]) => `
    <tr><td>${escapeHtml(kind)}</td><td>${formatNumber(count)}</td></tr>
  `).join("");
  const overlayIds = report.tuningOverlay.selectedIds.length ? report.tuningOverlay.selectedIds.join(", ") : "none";
  return `
    <section class="panel">
      <div class="metric-grid">
        ${metricCard("Runs Analyzed", report.scorecard.runsAnalyzed, "recent project runs")}
        ${metricCard("Feedback", formatInlineCounts(report.scorecard.feedbackCounts) || "none", "accepted / revised / rejected")}
        ${metricCard("Eval Runs", report.evaluationRuns, report.latestEvaluationAt ? `latest ${new Date(report.latestEvaluationAt).toLocaleDateString()}` : "none found")}
        ${metricCard("High Priority", report.highPriorityProposals, "tuning proposals")}
        ${metricCard("Routing Proposals", report.routingProposals, "provider or tier changes")}
        ${metricCard("Promotion Ready", report.promotionReady ? "yes" : "not yet", "baseline evidence gate")}
      </div>
      <p class="muted">Generated ${renderDashboardDateTime(report.generatedAt)} for ${escapeHtml(report.projectDir)}.</p>
    </section>
    ${renderLocalProviderEvidenceHtml(report.localProviderEvidence)}
    ${renderLocalHoldoutRoutingStatusHtml(report.localHoldoutRouting)}
    ${renderLocalRouteDecisionDrilldownHtml(report.routeReceiptTrends, report.localHoldoutRouting)}
    ${renderLocalLlmSetupChecklistHtml(report.localLlmSetup)}
    ${renderLocalLlmSetupGuideHtml(report.localLlmSetupGuide)}
    ${renderLocalLlmDownloadRecommendationsHtml(report.localLlmDownloadRecommendations)}
    ${renderLocalLlmInstallationPlanHtml(report.localLlmInstallationPlan)}
    ${renderLocalLlmInventoryHtml(report.localLlmInventory)}
    ${renderLocalLlmPrunePlanHtml(report.localLlmPrunePlan)}
    ${renderLocalLlmCacheTrendHtml(report.localLlmCacheTrends)}
    ${renderLocalLlmCostLedgerHtml(report.localLlmCostLedger)}
    ${renderLocalLlmRoutingRecommendationHtml(report.localLlmRoutingRecommendations)}
    ${renderLocalLlmRoutingNoteApplicationHtml(report.localLlmRoutingNoteApplication)}
    ${renderLocalLlmRoutingDecisionTimelineHtml(report.localLlmRoutingDecisionTimeline)}
    ${renderLocalLlmRoutingDecisionSnapshotsHtml(report.localLlmRoutingDecisionSnapshots)}
    ${renderLocalLlmBenchmarkReceiptsHtml(report.localLlmBenchmarks)}
    ${renderRouteReceiptTrendsHtml(report.routeReceiptTrends)}
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Applied Tuning Overlay</h2>
          <span class="muted">Project-local tuning state written by Agent Workflow.</span>
        </div>
        <span class="flag ${report.tuningOverlay.exists ? "good" : report.tuningOverlay.error ? "bad" : "warn"}">${report.tuningOverlay.exists ? "written" : report.tuningOverlay.error ? "error" : "missing"}</span>
      </div>
      <div class="meta-grid compact">
        <div><strong>Overlay File</strong><code>${escapeHtml(report.tuningOverlay.path)}</code></div>
        <div><strong>Generated</strong>${renderDashboardDateTime(report.tuningOverlay.generatedAt)}</div>
        <div><strong>Source Runs</strong>${report.tuningOverlay.sourceRunsAnalyzed === null ? "n/a" : formatNumber(report.tuningOverlay.sourceRunsAnalyzed)}</div>
        <div><strong>Selected IDs</strong>${formatNumber(report.tuningOverlay.selectedIds.length)}</div>
        <div><strong>Applied Events</strong>${formatNumber(report.tuningOverlay.appliedEvents)}</div>
        <div><strong>Latest Applied</strong>${renderDashboardDateTime(report.tuningOverlay.latestAppliedAt)}</div>
      </div>
      <p class="muted">Applied here means the project-local overlay file exists and can be read by Agent Workflow. These current proposals are evidence-gathering recommendations unless the proposal kind is a routing, prompt, or context-budget change.</p>
      <p><code>${escapeHtml(overlayIds)}</code></p>
      ${report.tuningOverlay.error ? `<p class="error">${escapeHtml(report.tuningOverlay.error)}</p>` : ""}
      ${report.tuningOverlay.duplicateAppliedEvents > 0 ? `<p class="warning">${formatNumber(report.tuningOverlay.duplicateAppliedEvents)} duplicate applied-history event(s) were detected before compaction.</p>` : ""}
      <div class="table-wrap"><table><thead><tr><th>Overlay Proposal Kind</th><th>Count</th></tr></thead><tbody>${overlayKindRows || "<tr><td colspan=\"2\">No written overlay proposals.</td></tr>"}</tbody></table></div>
    </section>
    <section class="panel">
      <h2>Readiness</h2>
      <ul>${report.readiness.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </section>
    ${renderModelImprovementFeedbackCaptureHtml(report)}
    <section class="panel">
      <h2>Proposal Mix</h2>
      <div class="table-wrap"><table><thead><tr><th>Kind</th><th>Count</th></tr></thead><tbody>${proposalRows || "<tr><td colspan=\"2\">No proposals yet.</td></tr>"}</tbody></table></div>
    </section>
    <section class="panel">
      <h2>Preference Scorecard</h2>
      ${renderPreferenceScorecardHtml(report.scorecard)}
    </section>
    <section class="panel">
      <h2>Tuning Proposals</h2>
      ${renderTuningProposalsHtml(report.proposals, report.tuningOverlay)}
    </section>
    <section class="panel">
      <h2>Next Commands</h2>
      <ul>${commandRows}</ul>
    </section>
  `;
}
