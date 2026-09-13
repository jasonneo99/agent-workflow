import assert from "node:assert/strict";
import test from "node:test";
import { defaultDaemonTrustSettings } from "../../../../packages/daemon-control/src/index.js";
import { renderDaemonControl } from "./daemon-control.js";

test("daemon control rendering exposes every lane and selected trust", () => {
  const trust = defaultDaemonTrustSettings();
  trust["action-executor"] = "high";
  const html = renderDaemonControl({ project: "/portable/project", limit: 50, workflow: "build-feature", trust, shapeAutoUpdate: true, agentAutoApply: true, autonomousMaxRisk: "medium", autopilotEnabled: true, autopilotMaxRisk: "medium" });
  assert.match(html, /Daemon Control Plane/);
  assert.match(html, /Backup &amp; Recovery Verifier/);
  assert.match(html, /daemonTrust\.action-executor/);
  assert.match(html, /value="high" selected/);
  assert.doesNotMatch(html, /Users\//);
});
