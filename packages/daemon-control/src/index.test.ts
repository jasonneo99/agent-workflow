import assert from "node:assert/strict";
import test from "node:test";
import { daemonLanes, daemonMayAct, defaultDaemonTrustSettings, normalizeDaemonTrustSettings } from "./index.js";
import { lowerTrustLevel, trustSettingsFromForm } from "./settings.js";
import { buildDaemonControlStatus } from "./status.js";
import { renderDaemonControl } from "../../../apps/cli/src/dashboard/daemon-control.js";

test("registers all daemon lanes with conservative defaults", () => {
  assert.equal(daemonLanes.length, 8);
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
