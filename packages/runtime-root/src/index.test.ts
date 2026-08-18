import assert from "node:assert/strict";
import test from "node:test";
import { agentWorkflowEnvPath, findAgentWorkflowRoot } from "./index.js";

test("finds the package root from source modules", () => {
  assert.match(findAgentWorkflowRoot(import.meta.url), /Agent Workflow$/);
});

test("installed packages use a user configuration path", () => {
  assert.match(agentWorkflowEnvPath("/opt/package", "/tmp/project"), /\.config\/agent-workflow\/\.env$/);
});
