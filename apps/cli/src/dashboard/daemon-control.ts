import { daemonLanes, type DaemonTrustSettings } from "../../../../packages/daemon-control/src/index.js";

type RenderInput = { project: string; limit: number; workflow: string; trust: DaemonTrustSettings; shapeAutoUpdate: boolean; agentAutoApply: boolean; autonomousMaxRisk: string; autopilotEnabled: boolean; autopilotMaxRisk: string };
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

export function renderDaemonControl(input: RenderInput): string {
  const cards = daemonLanes.map((lane) => {
    const options = (["low", "medium", "high"] as const).map((level) => `<option value="${level}"${input.trust[lane.id] === level ? " selected" : ""}>${level}</option>`).join("");
    return `<div class="card"><h3>${escape(lane.name)}</h3><p>${escape(lane.purpose)}</p><p class="muted">${escape(lane.capabilities.join(" · "))}</p><label>Maximum autonomous risk<select name="daemonTrust.${escape(lane.id)}">${options}</select></label></div>`;
  }).join("");
  return `<section class="panel"><div class="section-heading"><div><h2>Daemon Control Plane</h2><span class="muted">Project-scoped supervised lanes with independent trust ceilings. Saved for ${escape(input.project)}.</span></div><a class="button secondary" href="/api/daemon-control-status?project=${encodeURIComponent(input.project)}">JSON</a></div>
    <p class="warn-box">Trust is a maximum eligible risk level. It never bypasses project policy, command/write allowlists, validation, receipts, the open-source boundary, or destructive-action gates.</p>
    <form method="post" action="/api/learning-settings"><input type="hidden" name="settingsSection" value="daemon-trust"><input type="hidden" name="project" value="${escape(input.project)}"><input type="hidden" name="limit" value="${escape(String(input.limit))}"><input type="hidden" name="workflow" value="${escape(input.workflow)}"><div class="metric-grid">${cards}</div><div class="form-actions"><button type="submit">Save daemon trust levels</button></div></form></section>`;
}
