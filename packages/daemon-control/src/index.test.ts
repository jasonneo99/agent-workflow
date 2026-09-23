import assert from "node:assert/strict";
import test from "node:test";
import { classifyFleetProject, daemonLanes, daemonMayAct, defaultDaemonTrustSettings, fleetProjectAvailable, isEphemeralFleetProject, normalizeDaemonTrustSettings } from "./index.js";
import { lowerTrustLevel, trustSettingsFromForm } from "./settings.js";
import { buildDaemonControlStatus } from "./status.js";
import { renderDaemonControl } from "../../../apps/cli/src/dashboard/daemon-control.js";

test("registers all daemon lanes with conservative defaults", () => {
  assert.equal(daemonLanes.length, 9);
  assert.ok(daemonLanes.some((lane) => lane.id === "training-scout" && lane.mutationClass === "read-only"));
  assert.ok(Object.values(defaultDaemonTrustSettings()).every((level) => level === "low"));
});
test("form parsing, effective ceilings, and status reporting share one contract", () => {
  const values = new Map<string, string>([["daemonTrust.action-executor", "high"], ["daemonTrust.security-sentinel", "medium"]]);
  const trust = trustSettingsFromForm({ get: (key: string) => values.get(key) ?? null });
  assert.equal(trust["action-executor"], "high");
  assert.equal(trust["security-sentinel"], "medium");
  assert.equal(lowerTrustLevel("high", "medium"), "medium");
  const status = buildDaemonControlStatus(trust);
  assert.equal(status.lanes.length, daemonLanes.length);
  assert.equal(status.lanes.find((lane) => lane.id === "action-executor")?.trust, "high");
});
test("dashboard control contract renders every lane and the status endpoint target", () => {
  const trust = defaultDaemonTrustSettings();
  trust["action-executor"] = "high";
  const html = renderDaemonControl({ project: "/portable/project", limit: 50, workflow: "build-feature", trust, shapeAutoUpdate: true, agentAutoApply: true, autonomousMaxRisk: "medium", autopilotEnabled: true, autopilotMaxRisk: "medium" });
  assert.match(html, /Daemon Control Plane/);
  assert.match(html, /Backup &amp; Recovery Verifier/);
  assert.match(html, /Training Scout/);
  assert.match(html, /api\/daemon-control-status/);
  assert.match(html, /value="high" selected/);
});
test("trust never bypasses policy or validation", () => {
  const settings = normalizeDaemonTrustSettings({ "workflow-optimizer": "high", "action-executor": "invalid" });
  assert.equal(settings["workflow-optimizer"], "high");
  assert.equal(settings["action-executor"], "low");
  assert.equal(daemonMayAct({ trust: "high", risk: "high", policyAllowed: true, validationPassed: true }), true);
  assert.equal(daemonMayAct({ trust: "high", risk: "low", policyAllowed: false, validationPassed: true }), false);
  assert.equal(daemonMayAct({ trust: "high", risk: "low", policyAllowed: true, validationPassed: false }), false);
});
test("fleet health excludes ephemeral, disabled, paused, and remote projects from local availability", () => {
  assert.equal(isEphemeralFleetProject({ name: "Provider Smoke Project", rootUri: "/tmp/agentflow-provider-smoke.123" }), true);
  assert.equal(isEphemeralFleetProject({ name: "Example Project", rootUri: "/releases/agent-workflow/abc/templates/project" }), true);
  assert.deepEqual(classifyFleetProject({ name: "App", rootUri: "/projects/app", localPathExists: true, enabled: true, paused: false }), {
    scope: "local", availabilityTracked: true, reason: "Local enabled project."
  });
  assert.equal(classifyFleetProject({ name: "Remote", rootUri: "/srv/projects/app", localPathExists: false, enabled: true, paused: false }).availabilityTracked, false);
  assert.equal(classifyFleetProject({ name: "Disabled", rootUri: "/projects/disabled", localPathExists: true, enabled: false, paused: false }).availabilityTracked, false);
  assert.equal(classifyFleetProject({ name: "Paused", rootUri: "/projects/paused", localPathExists: true, enabled: true, paused: true }).availabilityTracked, false);
  assert.equal(fleetProjectAvailable({ availabilityTracked: true, daemonStatus: "stale", heartbeatAgeMs: 3 * 60_000 }), true);
  assert.equal(fleetProjectAvailable({ availabilityTracked: true, daemonStatus: "stale", heartbeatAgeMs: 11 * 60_000 }), false);
  assert.equal(fleetProjectAvailable({ availabilityTracked: false, daemonStatus: "missing", heartbeatAgeMs: null }), true);
});
