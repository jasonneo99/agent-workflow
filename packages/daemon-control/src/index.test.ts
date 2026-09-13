import assert from "node:assert/strict";
import test from "node:test";
import { daemonLanes, daemonMayAct, defaultDaemonTrustSettings, normalizeDaemonTrustSettings } from "./index.js";

test("registers all daemon lanes with conservative defaults", () => {
  assert.equal(daemonLanes.length, 8);
  assert.ok(Object.values(defaultDaemonTrustSettings()).every((level) => level === "low"));
});
test("trust never bypasses policy or validation", () => {
  const settings = normalizeDaemonTrustSettings({ "workflow-optimizer": "high", "action-executor": "invalid" });
  assert.equal(settings["workflow-optimizer"], "high");
  assert.equal(settings["action-executor"], "low");
  assert.equal(daemonMayAct({ trust: "high", risk: "high", policyAllowed: true, validationPassed: true }), true);
  assert.equal(daemonMayAct({ trust: "high", risk: "low", policyAllowed: false, validationPassed: true }), false);
  assert.equal(daemonMayAct({ trust: "high", risk: "low", policyAllowed: true, validationPassed: false }), false);
});
