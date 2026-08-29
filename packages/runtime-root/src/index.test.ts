import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { agentWorkflowEnvPath, findAgentWorkflowRoot } from "./index.js";

test("finds the package root from source modules", () => {
  const root = findAgentWorkflowRoot(import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string };
  assert.equal(pkg.name, "@jasonneo99/agent-workflow");
});

test("installed packages use a user configuration path", () => {
  assert.match(agentWorkflowEnvPath("/opt/package", "/tmp/project"), /\.config\/agent-workflow\/\.env$/);
});
