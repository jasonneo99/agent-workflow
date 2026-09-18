import assert from "node:assert/strict";
import test from "node:test";
import { selectLearningProjectRoot } from "./daemon-settings.js";

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
      { rootUri: "/Users/example/Projects/jarvis" }
    ]
  });
  assert.equal(selected, "/Users/example/Projects/jarvis");
});

test("an explicit project selection remains authoritative", () => {
  const selected = selectLearningProjectRoot({
    requested: "/Users/example/Projects/fleet-config",
    runtimeRoot: "/Users/example/Projects/Agent Workflow",
    projects: [{ rootUri: "/Users/example/Projects/Agent Workflow" }]
  });
  assert.equal(selected, "/Users/example/Projects/fleet-config");
});
