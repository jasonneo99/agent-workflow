import { renderRuntimeMonitorPanel, renderWorkerStatusHtml } from "../../data/runtime-monitor.js";
import { formatNumber } from "../../ui/format.js";
import { escapeHtml, dashboardNav, renderDashboardFlash, renderDashboardActionHistory, renderDashboardDateTime, dashboardReturnInput } from "../../ui/layout.js";
import type { DashboardInfo, DashboardLaunchAgentStatus, DashboardSupervisorStatus } from "../../../lib/cli-types.js";
import { formatDuration } from "../../../lib/builders-learning.js";
import { dashboardCss } from "../../styles.js";

export function renderDashboardInfoHtml(info: DashboardInfo, params: URLSearchParams = new URLSearchParams()): string {
  const serviceRows = info.services.map((service) => `
    <tr>
      <td>${escapeHtml(service.name)}</td>
      <td><span class="status ${service.reachable ? "completed" : "failed"}">${service.reachable ? "reachable" : "missing"}</span></td>
      <td>${escapeHtml(service.message)}</td>
      <td>${escapeHtml(service.requiredFor)}</td>
    </tr>
  `).join("");
  const commands = info.commands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
  const providerRows = [
    ["Selected", info.provider.selected],
    ["Adapter", info.provider.adapter],
    ["Model", info.provider.model ?? "not set"],
    ["API key", typeof info.provider.apiKeyConfigured === "boolean" ? info.provider.apiKeyConfigured ? "configured" : "not configured" : "not used"]
  ].map(([label, value]) => `<div><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</div>`).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Agent Workflow Settings</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("info")}
  <main id="main-content">
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Settings</h1>
      </div>
      <a class="button secondary" href="/api/settings">JSON</a>
    </div>
    ${renderDashboardFlash(params)}
    ${renderDashboardActionHistory()}
    <section class="panel">
      <h2>Runtime</h2>
      <div class="meta-grid">
        <div><strong>App</strong>${escapeHtml(info.app.name)} ${escapeHtml(info.app.version)}</div>
        <div><strong>Root</strong>${escapeHtml(info.app.rootDir)}</div>
        <div><strong>Dashboard</strong>${escapeHtml(info.app.dashboardUrl)}</div>
        <div><strong>Registry</strong>${info.registry.agents} agents, ${info.registry.workflows} workflows</div>
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Provider Summary</h2>
          <span class="muted">Model and routing controls live on the Providers page.</span>
        </div>
        <a class="button secondary" href="/providers">Open Providers</a>
      </div>
      <div class="meta-grid">${providerRows}</div>
    </section>
    <section class="panel">
      <h2>Enterprise Services</h2>
      <table><thead><tr><th>Service</th><th>Status</th><th>Message</th><th>Required For</th></tr></thead><tbody>${serviceRows}</tbody></table>
    </section>
    ${renderRuntimeMonitorPanel(info.runtimeMonitor, params)}
    <section class="panel">
      <h2>Local Supervisor</h2>
      ${renderSupervisorStatusHtml(info.supervisor)}
    </section>
    <section class="panel">
      <h2>macOS LaunchAgent</h2>
      ${renderLaunchAgentStatusHtml(info.launchAgent, params)}
    </section>
    <section class="panel">
      <h2>Background Worker</h2>
      ${renderWorkerStatusHtml(info.worker)}
    </section>
    <section class="panel">
      <h2>Bundle Manifest</h2>
      ${info.bundle ? `<div class="meta-grid">
        <div><strong>Version</strong>${escapeHtml(info.bundle.version)}</div>
        <div><strong>Files</strong>${info.bundle.files}</div>
        <div><strong>Checksum</strong><code>${escapeHtml(info.bundle.checksum)}</code></div>
        <div><strong>Source</strong>${escapeHtml(info.bundle.source)}</div>
      </div>` : "<p>No committed bundle manifest found.</p>"}
    </section>
    <section class="panel">
      <h2>Storage Config</h2>
      <div class="meta-grid">
        <div><strong>DATABASE_URL</strong>${info.storage.databaseUrlConfigured ? "configured" : "missing"}</div>
        <div><strong>REDIS_URL</strong>${info.storage.redisUrlConfigured ? "configured" : "missing"}</div>
        <div><strong>Object storage</strong>${info.storage.objectStorageConfigured ? "configured" : "missing"}</div>
      </div>
    </section>
    <section class="panel">
      <h2>Useful Commands</h2>
      <ul>${commands}</ul>
    </section>
  </main>
</body>
</html>`;
}

export function renderLaunchAgentLogHtml(view: { ok: boolean; kind: "stdout" | "stderr"; filePath: string; content: string; error?: string }): string {
  const body = view.ok
    ? `<h1>LaunchAgent ${escapeHtml(view.kind)} Log</h1><p class="muted">${escapeHtml(view.filePath)}</p><pre>${escapeHtml(view.content)}</pre>`
    : `<h1>LaunchAgent Log Missing</h1><p class="muted">${escapeHtml(view.filePath)}</p><pre>${escapeHtml(view.error ?? "Log file could not be read.")}</pre>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LaunchAgent Log</title>
  <style>${dashboardCss()}</style>
</head>
<body>${dashboardNav("info")}<main id="main-content"><p><a href="/settings">Settings</a></p>${body}</main></body>
</html>`;
}

export function renderLaunchAgentStatusHtml(launchAgent: DashboardLaunchAgentStatus, params: URLSearchParams = new URLSearchParams()): string {
  const statusClass = launchAgent.status === "running" ? "completed" : launchAgent.status === "missing" || launchAgent.status === "unavailable" ? "queued" : launchAgent.status === "error" ? "failed" : "queued";
  const installDisabled = !launchAgent.supported ? " disabled" : "";
  const uninstallDisabled = !launchAgent.supported || !launchAgent.installed ? " disabled" : "";
  return `
    <div class="meta-grid">
      <div><strong>Status</strong><span class="status ${statusClass}">${escapeHtml(launchAgent.status)}</span></div>
      <div><strong>Installed</strong>${launchAgent.installed ? "yes" : "no"}</div>
      <div><strong>PID</strong>${launchAgent.pid ?? "none"}</div>
      <div><strong>Runs</strong>${launchAgent.runs ?? "n/a"}</div>
      <div><strong>Label</strong>${escapeHtml(launchAgent.label)}</div>
      <div><strong>Platform</strong>${escapeHtml(launchAgent.platform)}</div>
    </div>
    <div class="meta-grid compact">
      <div><strong>Plist</strong>${escapeHtml(launchAgent.plistPath)}</div>
      <div><strong>Stdout</strong>${escapeHtml(launchAgent.stdoutPath)} ${launchAgent.stdoutExists ? `<a href="/launchagent-log?kind=stdout">open</a>` : ""}</div>
      <div><strong>Stderr</strong>${escapeHtml(launchAgent.stderrPath)} ${launchAgent.stderrExists ? `<a href="/launchagent-log?kind=stderr">open</a>` : ""}</div>
      <div><strong>Install Command</strong><code>${escapeHtml(launchAgent.installCommand)}</code></div>
      <div><strong>Uninstall Command</strong><code>${escapeHtml(launchAgent.uninstallCommand)}</code></div>
      ${launchAgent.lastError ? `<div><strong>Last launchctl note</strong>${escapeHtml(launchAgent.lastError)}</div>` : ""}
    </div>
    <div class="form-actions">
      <form method="post" action="/api/launchagent-action">
        ${dashboardReturnInput("/settings", params)}
        <input type="hidden" name="action" value="install">
        <button type="submit"${installDisabled}>Install / Refresh</button>
      </form>
      <form method="post" action="/api/launchagent-action">
        ${dashboardReturnInput("/settings", params)}
        <input type="hidden" name="action" value="uninstall">
        <button class="secondary" type="submit"${uninstallDisabled}>Uninstall</button>
      </form>
      <a class="button secondary" href="/api/settings">Refresh JSON</a>
    </div>
    <p class="muted">LaunchAgent is optional macOS durability: it starts the local supervisor at login and restarts it after crashes. The supervisor then manages the dashboard, worker lanes, and learning daemon.</p>
  `;
}

export function renderSupervisorStatusHtml(supervisor: DashboardSupervisorStatus): string {
  const age = supervisor.ageMs === null ? "n/a" : formatDuration(Math.max(0, supervisor.ageMs));
  return `
    <div class="meta-grid">
      <div><strong>Status</strong><span class="status ${supervisor.status === "running" ? "completed" : supervisor.status === "missing" ? "queued" : "failed"}">${escapeHtml(supervisor.status)}</span></div>
      <div><strong>PID</strong>${supervisor.pid ?? "none"}</div>
      <div><strong>Process</strong>${supervisor.processAlive ? "alive" : "not running"}</div>
      <div><strong>Last Heartbeat</strong>${renderDashboardDateTime(supervisor.lastHeartbeatAt, "none")}</div>
      <div><strong>Heartbeat Age</strong>${escapeHtml(age)}</div>
      <div><strong>Tick Count</strong>${formatNumber(supervisor.ticks)}</div>
      <div><strong>Dashboard</strong>${supervisor.dashboardManaged ? "managed" : "external or stopped"}</div>
      <div><strong>Worker</strong>${supervisor.workerManaged ? "managed" : "external or stopped"}</div>
      <div><strong>Learning</strong>${supervisor.learningEnabled ? (supervisor.learningManaged ? "managed" : "enabled, external or stopped") : "disabled"}</div>
      <div><strong>Learning Mode</strong>${escapeHtml(supervisor.learningMode ?? "n/a")}</div>
      <div><strong>Learning Scope</strong>${escapeHtml(supervisor.learningScope ?? "n/a")}</div>
    </div>
    <div class="meta-grid compact">
      <div><strong>Message</strong>${escapeHtml(supervisor.message || "n/a")}</div>
      <div><strong>Heartbeat File</strong>${escapeHtml(supervisor.heartbeatPath)}</div>
      <div><strong>Learning Project</strong>${escapeHtml(supervisor.learningProject ?? "n/a")}</div>
      <div><strong>Learning Heartbeat</strong>${escapeHtml(supervisor.learningHeartbeatPath ?? "n/a")}</div>
      <div><strong>Start Command</strong><code>${escapeHtml(supervisor.command || "npm run dev:agentflow")}</code></div>
    </div>
  `;
}

export function tailText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `...truncated to latest ${maxChars} characters...\n${value.slice(-maxChars)}`;
}
