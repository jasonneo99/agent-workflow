import { formatNumber } from "../../ui/format.js";
import { escapeHtml, dashboardNav, iconLabel, renderDashboardFlash, renderDashboardActionHistory, renderDashboardDateTime, metricCard, dashboardReturnInput } from "../../ui/layout.js";
import { dashboardCss } from "../../styles.js";
import type { DashboardBundleReadiness } from "../../../commands/daemon-types.js";

export function bundleLifecyclePlanForm(readiness: DashboardBundleReadiness, params: URLSearchParams): string {
  if (!readiness.projectDir) {
    return '<p class="muted">Enter a project path and inspect readiness before generating a project-local lifecycle plan.</p>';
  }
  const selectedEntry = readiness.registry.entries.find((entry) => entry.selected) ?? readiness.registry.entries[0];
  const bundleId = params.get("bundleId")?.trim() || selectedEntry?.id || "agent-workflow-core";
  const targetVersion = params.get("targetVersion")?.trim() || selectedEntry?.latestVersion || "";
  const registry = params.get("registry")?.trim() || readiness.registry.registryPath;
  return `<form class="workflow-form" method="post" action="/api/bundle-lifecycle-plan">
    ${dashboardReturnInput("/bundles", params)}
    <input type="hidden" name="project" value="${escapeHtml(readiness.projectDir)}">
    <input type="hidden" name="registry" value="${escapeHtml(registry)}">
    <label>Bundle id<input name="bundleId" value="${escapeHtml(bundleId)}"></label>
    <label>Mode<select name="mode"><option value="upgrade">upgrade</option><option value="rollback">rollback</option></select></label>
    <label>Target version<input name="targetVersion" value="${escapeHtml(targetVersion)}" placeholder="latest for upgrade, required for rollback"></label>
    <label class="check-row"><input type="checkbox" name="write"> Write plan file</label>
    <div class="form-actions"><button type="submit">${iconLabel("clipboard", "Generate Plan")}</button></div>
  </form>`;
}

export function renderBundleTrustHtml(readiness: DashboardBundleReadiness, params: URLSearchParams): string {
  const verification = readiness.verification;
  const statusClass = verification.status === "trusted" ? "good" : verification.allowed ? "warn" : "bad";
  const query = params.toString();
  const jsonHref = `/api/bundles${query ? `?${query}` : ""}`;
  const projectValue = readiness.projectDir ?? "";
  const failedContracts = readiness.contractTests.results.filter((result) => result.status === "fail").length;
  const skippedContracts = readiness.contractTests.results.filter((result) => result.status === "skip").length;
  const migrationCount = readiness.migrationPlan.migrations.length;
  const registryRows = readiness.registry.entries.map((entry) => `
    <tr><td>${entry.selected ? "<strong>" : ""}${escapeHtml(entry.name)}${entry.selected ? "</strong>" : ""}<br><span class="muted">${escapeHtml(entry.id)}</span></td><td><span class="flag ${entry.status === "installed-current" ? "good" : entry.status === "upgrade-available" ? "warn" : "neutral"}">${escapeHtml(entry.status)}</span></td><td>${escapeHtml(entry.latestVersion)}</td><td>${escapeHtml(entry.packageName ?? "none")}</td><td>${entry.install.npm ? `<code>${escapeHtml(entry.install.npm)}</code>` : escapeHtml(entry.source)}</td></tr>
  `).join("");
  const pinHtml = readiness.pin
    ? readiness.pin.value
      ? `<h3>Project Pin</h3><div class="meta-grid compact"><div><strong>Bundle</strong>${escapeHtml(readiness.pin.value.bundle.id)} ${escapeHtml(readiness.pin.value.bundle.version)}</div><div><strong>Package</strong>${escapeHtml(readiness.pin.value.bundle.packageName ?? "none")}</div><div><strong>Pinned</strong>${renderDashboardDateTime(readiness.pin.value.bundle.pinnedAt)}</div><div><strong>By</strong>${escapeHtml(readiness.pin.value.bundle.pinnedBy)}</div></div><p class="muted">${escapeHtml(readiness.pin.path)}</p>`
      : `<h3>Project Pin</h3><p class="muted">No project-local bundle pin found at ${escapeHtml(readiness.pin.path)}.</p>`
    : "";
  const compatibilityRows = readiness.compatibility.checks.map((check) => `
    <tr><td>${escapeHtml(check.label)}</td><td><span class="flag ${check.compatible ? "good" : "bad"}">${check.compatible ? "pass" : "fail"}</span></td><td><code>${escapeHtml(check.actual)}</code></td><td><code>${escapeHtml(check.required)}</code></td><td>${escapeHtml(check.detail)}</td></tr>
  `).join("");
  const contractRows = readiness.contractTests.results.slice(0, 16).map((result) => `
    <tr><td><span class="flag ${result.status === "pass" ? "good" : result.status === "skip" ? "warn" : "bad"}">${escapeHtml(result.status)}</span></td><td>${escapeHtml(result.id)}</td><td>${escapeHtml(result.detail)}</td></tr>
  `).join("");
  const lifecycleForm = bundleLifecyclePlanForm(readiness, params);
  const migrationItems = readiness.migrationPlan.migrations.map((migration) => `
    <details class="artifact"><summary>${escapeHtml(migration.id)}: ${escapeHtml(migration.from)} to ${escapeHtml(migration.to)}</summary>
      <p>${escapeHtml(migration.summary)}</p>
      <h3>Validation</h3><ul>${migration.validation.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      <h3>Rollback</h3><ul>${migration.rollbackSteps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </details>
  `).join("");
  const errorBlock = readiness.errors.length
    ? `<section class="panel warn-panel"><h2>Needs attention</h2><ul>${readiness.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></section>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Bundle Trust</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("bundles")}
  <main id="main-content"><div class="topbar"><div><a href="/">Dashboard</a><h1>Workflow Bundle Readiness</h1><p class="muted">Read-only trust, compatibility, migration, and contract-test visibility. A signature never expands project execution permissions.</p></div><a class="button secondary" href="${escapeHtml(jsonHref)}">JSON</a></div>
  ${renderDashboardFlash(params)}
  ${renderDashboardActionHistory()}
  <section class="panel"><form method="get" class="workflow-form"><label class="wide">Project path<input name="project" value="${escapeHtml(projectValue)}" placeholder="/path/to/project"></label><label>Trust policy<select name="policy">${["allow", "warn", "require"].map((policy) => `<option value="${policy}"${verification.policy === policy ? " selected" : ""}>${policy}</option>`).join("")}</select></label><div class="form-actions"><button type="submit">Inspect</button></div></form><p class="muted">Leave project path blank to inspect shared bundle readiness without project adoption state.</p></section>
  ${errorBlock}
  <section class="panel"><div class="metric-grid">
    ${metricCard("Trust", verification.status, verification.allowed ? "Current policy allows this bundle" : "Current policy rejects this bundle")}
    ${metricCard("Compatibility", readiness.compatibility.compatible ? "pass" : "fail", `${readiness.compatibility.checks.length} runtime checks`)}
    ${metricCard("Upgrade", readiness.upgradePreview.status, readiness.upgradePreview.source.kind)}
    ${metricCard("Migrations", migrationCount, readiness.migrationPlan.status)}
    ${metricCard("Contract Tests", readiness.contractTests.passed ? "pass" : "fail", `${failedContracts} failed, ${skippedContracts} skipped`)}
  </div><p class="muted">Generated ${renderDashboardDateTime(readiness.generatedAt)}${readiness.projectDir ? ` for ${escapeHtml(readiness.projectDir)}` : ""}.</p></section>
  <section class="panel"><div class="section-heading"><div><h2>${escapeHtml(verification.bundleId)} ${escapeHtml(verification.bundleVersion)}</h2><span class="muted">Manifest ${escapeHtml(verification.manifestChecksum)}</span></div><span class="flag ${statusClass}">${escapeHtml(verification.status)}</span></div>
  <div class="meta-grid"><div><strong>Policy</strong>${escapeHtml(verification.policy)}</div><div><strong>Decision</strong>${verification.allowed ? "allowed" : "rejected"}</div><div><strong>Signer</strong>${escapeHtml(verification.signerId ?? "none")}</div><div><strong>Trusted</strong>${verification.trusted}</div></div>
  <p><strong>Fingerprint:</strong> <code>${escapeHtml(verification.keyFingerprint ?? "none")}</code></p><p><strong>Signed:</strong> ${renderDashboardDateTime(verification.signedAt, "not signed")}<br><strong>Expires:</strong> ${renderDashboardDateTime(verification.expiresAt, "none")}</p>
  <h3>Verification</h3><ul>${verification.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></section>
  <section class="panel"><div class="section-heading"><div><h2>Trusted Registry</h2><span class="muted">${escapeHtml(readiness.registry.registryPath)}</span></div><a class="button secondary" href="/api/bundle-registry">JSON</a></div><div class="table-wrap"><table><thead><tr><th>Bundle</th><th>Status</th><th>Latest</th><th>Package</th><th>Install</th></tr></thead><tbody>${registryRows || '<tr><td colspan="5">No registry entries found.</td></tr>'}</tbody></table></div>${pinHtml}<p class="muted">Registry entries are discovery and governance metadata. Installing or adopting a bundle still requires explicit package-manager and trust-verification steps.</p></section>
  <section class="panel"><h2>Lifecycle Plan</h2><p class="muted">Generate a reviewed upgrade or rollback command plan. The dashboard never installs packages or changes adoption state.</p>${lifecycleForm}</section>
  <section class="panel"><h2>Compatibility</h2><div class="table-wrap"><table><thead><tr><th>Check</th><th>Status</th><th>Actual</th><th>Required</th><th>Detail</th></tr></thead><tbody>${compatibilityRows}</tbody></table></div></section>
  <section class="panel"><h2>Project Adoption</h2><div class="meta-grid"><div><strong>Source</strong>${escapeHtml(readiness.upgradePreview.source.kind)}</div><div><strong>Status</strong>${escapeHtml(readiness.upgradePreview.status)}</div><div><strong>Source Version</strong>${escapeHtml(readiness.upgradePreview.source.version ?? "none")}</div><div><strong>Recorded</strong>${renderDashboardDateTime(readiness.upgradePreview.source.recordedAt, "none")}</div></div><h3>Recommended Actions</h3><ul>${readiness.upgradePreview.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>
  <section class="panel"><h2>Definition Migrations</h2>${migrationItems || "<p>No applicable definition migrations.</p>"}<h3>Recommended Actions</h3><ul>${readiness.migrationPlan.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>
  <section class="panel"><h2>Contract-Test Readiness</h2><div class="meta-grid compact"><div><strong>Definitions</strong>${escapeHtml(readiness.contractTests.definitionsDir)}</div><div><strong>Project</strong>${escapeHtml(readiness.contractTests.projectDir ?? "none")}</div><div><strong>Provider</strong>${escapeHtml(readiness.contractTests.providerId)}</div><div><strong>Live Provider</strong>${readiness.contractTests.liveProvider ? "yes" : "no"}</div></div><div class="table-wrap"><table><thead><tr><th>Status</th><th>Check</th><th>Detail</th></tr></thead><tbody>${contractRows}</tbody></table></div>${readiness.contractTests.results.length > 16 ? `<p class="muted">${formatNumber(readiness.contractTests.results.length - 16)} additional checks are available in JSON.</p>` : ""}</section>
  <section class="panel"><h2>Trust policy</h2><p>Set <code>AGENTFLOW_BUNDLE_TRUST_POLICY</code> to <code>allow</code>, <code>warn</code>, or <code>require</code>. Use the CLI to add public signer keys; private signing keys are never stored by Agent Workflow.</p></section></main></body></html>`;
}
