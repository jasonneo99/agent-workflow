import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { agentWorkflowEnvPath, findAgentWorkflowRoot, parseProjectRootAliases, resolveLocalProjectPath } from "./index.js";

test("finds the package root from source modules", () => {
  const root = findAgentWorkflowRoot(import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string };
  assert.equal(pkg.name, "@jasonneo99/agent-workflow");
});

test("installed packages use a user configuration path", () => {
  assert.match(agentWorkflowEnvPath("/opt/package", "/tmp/project"), /\.config\/agent-workflow\/\.env$/);
});

test("parses project root aliases from environment-style values", () => {
  assert.deepEqual(parseProjectRootAliases("/home/me/Projects=/Users/me/Projects;/srv=/Volumes/srv", "/"), [
    { from: "/home/me/Projects", to: "/Users/me/Projects", source: "env" },
    { from: "/srv", to: "/Volumes/srv", source: "env" }
  ]);
});

test("resolves Linux project roots to the current macOS home checkout", async () => {
  const resolution = await resolveLocalProjectPath("/home/example/Projects/fleet-config", {
    homeDir: "/Users/example",
    exists: (target) => target === "/Users/example/Projects/fleet-config"
  });
  assert.equal(resolution.storageRootUri, "/home/example/Projects/fleet-config");
  assert.equal(resolution.localRootUri, "/Users/example/Projects/fleet-config");
  assert.equal(resolution.mapped, true);
  assert.equal(resolution.source, "mac-home");
});

test("resolves explicit project root aliases before basename fallback", async () => {
  const resolution = await resolveLocalProjectPath("/mnt/shared/fleet-config", {
    cwd: "/",
    env: { AGENTFLOW_PROJECT_PATH_MAP: "/mnt/shared=/Users/example/Projects" },
    homeDir: "/Users/example",
    exists: (target) => target === "/Users/example/Projects/fleet-config"
  });
  assert.equal(resolution.localRootUri, "/Users/example/Projects/fleet-config");
  assert.equal(resolution.source, "env");
});
