import assert from "node:assert/strict";
import test from "node:test";
import { defaultDaemonTrustSettings } from "../../../../packages/daemon-control/src/index.js";
import { parseLearningSettingsSection, selectDaemonTrustSettings, selectLearningProjectRoot } from "./daemon-settings.js";

test("learning settings require an explicit mutation section", () => {
  const form = (value: string | null) => ({ get: (name: string) => name === "settingsSection" ? value : null });
  assert.equal(parseLearningSettingsSection(form("daemon-trust")), "daemon-trust");
  assert.equal(parseLearningSettingsSection(form("workflow-shape")), "workflow-shape");
  assert.equal(parseLearningSettingsSection(form(null)), null);
  assert.equal(parseLearningSettingsSection(form("all")), null);
});

test("workflow settings cannot overwrite existing daemon trust", () => {
  const existing = { ...defaultDaemonTrustSettings(), "action-executor": "high" as const };
  const staleForm = { get: (name: string) => name === "daemonTrust.action-executor" ? "low" : null };
  assert.deepEqual(selectDaemonTrustSettings("workflow-shape", staleForm, existing), existing);
  assert.equal(selectDaemonTrustSettings("daemon-trust", staleForm, existing)["action-executor"], "low");
});

test("learning settings prefer the mutable runtime checkout over a versioned release registration", () => {
  const selected = selectLearningProjectRoot({
    runtimeRoot: "/Users/example/Projects/Agent Workflow",
    projects: [
      { rootUri: "/home/example/releases/agent-workflow/abc123" },
      { rootUri: "/Users/example/Projects/Agent Workflow" }
    ]
  });
  assert.equal(selected, "/Users/example/Projects/Agent Workflow");
});

test("learning settings never choose a release registration by default when a mutable project exists", () => {
  const selected = selectLearningProjectRoot({
    runtimeRoot: "/opt/agent-workflow/current",
    projects: [
      { rootUri: "/home/example/releases/agent-workflow/abc123" },
      { rootUri: "/Users/example/Projects/sample-app" }
    ]
  });
  assert.equal(selected, "/Users/example/Projects/sample-app");
});

test("an explicit project selection remains authoritative", () => {
  const selected = selectLearningProjectRoot({
    requested: "/Users/example/Projects/platform-config",
    runtimeRoot: "/Users/example/Projects/Agent Workflow",
    projects: [{ rootUri: "/Users/example/Projects/Agent Workflow" }]
  });
  assert.equal(selected, "/Users/example/Projects/platform-config");
});
