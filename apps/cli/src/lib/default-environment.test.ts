import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { projectConfigSchema } from "../../../../packages/agent-registry/src/schemas.js";
import { assertCommandAllowed } from "../../../../packages/local-tools/src/command-executor.js";
import { assertFileReadAllowed } from "../../../../packages/local-tools/src/file-reader.js";
import { REPAIR_COMMIT_COMMAND, assertRepairCommitEnabled } from "../../../../packages/run-environments/src/repair-checkpoint.js";
import { ENVIRONMENT_COMMAND, runEnvironmentsSchema } from "../../../../packages/run-environments/src/schema.js";
import { pipelineEnvironmentPlans } from "../../../../packages/run-environments/src/workspace.js";
import { detectDefaultEnvironment, hostEnvironmentPlatform, writeDefaultEnvironment } from "./default-environment.js";

const templateConfig = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "templates", "project", ".agent-workflow", "project.yaml");

async function withProject(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aw-default-env-"));
  try {
    for (const [relative, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
      await writeFile(path.join(dir, relative), body);
    }
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const nodeProject = (scripts: Record<string, string>) => ({
  "package.json": JSON.stringify({ name: "example-node", type: "module", scripts }),
  "src/add.js": "export const add = (a, b) => a + b;\n",
  "test/add.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\ntest('adds', () => assert.equal(add(1, 2), 3));\n",
  "index.js": "export * from './src/add.js';\n"
});

test("host platforms map to environment platforms", () => {
  assert.equal(hostEnvironmentPlatform("darwin", "arm64"), "darwin/arm64");
  assert.equal(hostEnvironmentPlatform("linux", "x64"), "linux/amd64");
  assert.equal(hostEnvironmentPlatform("win32", "arm64"), "win32/arm64");
  assert.equal(hostEnvironmentPlatform("freebsd", "x64"), null);
  assert.equal(hostEnvironmentPlatform("linux", "ia32"), null);
});

test("a node --test project gets a native profile and only test, build, typecheck and lint commands", async () => {
  await withProject(nodeProject({ test: "node --test", build: "tsc", typecheck: "tsc --noEmit", lint: "eslint .", deploy: "./deploy.sh", publish: "npm publish" }), async (dir) => {
    const result = await detectDefaultEnvironment(dir, { platform: "linux/amd64" });
    assert.ok(result.ok);
    const { environment } = result;
    assert.equal(environment.stack, "node");
    assert.deepEqual(environment.allowedCommands, [ENVIRONMENT_COMMAND, REPAIR_COMMIT_COMMAND, "node --version", "npm test", "npm run build", "npm run typecheck", "npm run lint"]);
    const parsed = runEnvironmentsSchema.parse(environment.environments);
    const profile = parsed.profiles["node-tests"]!;
    assert.equal(parsed.default_profile, "node-tests");
    assert.equal(profile.kind, "native");
    assert.equal(profile.platform, "linux/amd64");
    assert.deepEqual(profile.setup, []);
    assert.equal(profile.build_network, "none");
    assert.deepEqual(profile.readiness.map(probe => probe.argv), [["node", "--version"]]);
    assert.deepEqual(profile.verification, [{ commands: ["npm test"], format: "node-test", minimum_tests: 1 }]);
    assert.deepEqual(profile.source_paths, ["package.json", "src", "test", "index.js"]);
  });
});

test("only scripts that exist are allowed, and runner wrappers around node --test count", async () => {
  await withProject(nodeProject({ test: "node --import tsx --test test/*.test.ts" }), async (dir) => {
    const result = await detectDefaultEnvironment(dir, { platform: "darwin/arm64" });
    assert.ok(result.ok);
    assert.deepEqual(result.environment.allowedCommands, [ENVIRONMENT_COMMAND, REPAIR_COMMIT_COMMAND, "node --version", "npm test"]);
  });
});

test("node projects with another test runner, or none, get no profile and a clear reason", async () => {
  for (const scripts of [{ test: "jest" }, { test: "vitest run" }, { build: "tsc" }, { test: "echo node --testing" }] as Array<Record<string, string>>) {
    await withProject(nodeProject(scripts), async (dir) => {
      const result = await detectDefaultEnvironment(dir, { platform: "darwin/arm64" });
      assert.equal(result.ok, false, JSON.stringify(scripts));
      if (!result.ok) assert.match(result.reason, /no "test" script that runs node --test.*node --test, pytest and unittest.*docs\/run-environments\.md/u);
    });
  }
  await withProject({ "package.json": "{ not json" }, async (dir) => {
    const result = await detectDefaultEnvironment(dir, { platform: "darwin/arm64" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not valid JSON/u);
  });
});

test("pytest and unittest projects get python profiles", async () => {
  await withProject({ "pyproject.toml": "[project]\nname = \"example\"\n\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n\n[tool.ruff]\nline-length = 100\n",
    "example/__init__.py": "", "tests/test_example.py": "def test_ok():\n    assert True\n" }, async (dir) => {
    const result = await detectDefaultEnvironment(dir, { platform: "linux/arm64" });
    assert.ok(result.ok);
    assert.equal(result.environment.stack, "python");
    assert.deepEqual(result.environment.allowedCommands, [ENVIRONMENT_COMMAND, REPAIR_COMMIT_COMMAND, "python3 --version", "python3 -m pytest", "python3 -m ruff check ."]);
    const profile = runEnvironmentsSchema.parse(result.environment.environments).profiles["python-tests"]!;
    assert.equal(profile.verification[0]!.format, "pytest");
    assert.deepEqual(profile.source_paths, ["pyproject.toml", "example", "tests"]);
  });
  await withProject({ "tests/test_example.py": "import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n" }, async (dir) => {
    const result = await detectDefaultEnvironment(dir, { platform: "darwin/arm64" });
    assert.ok(result.ok);
    assert.equal(result.environment.testCommand, "python3 -m unittest discover");
    assert.equal(runEnvironmentsSchema.parse(result.environment.environments).profiles["python-tests"]!.verification[0]!.format, "unittest");
  });
  await withProject({ "requirements.txt": "requests==2.32.0\n" }, async (dir) => {
    const result = await detectDefaultEnvironment(dir, { platform: "darwin/arm64" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /No pytest configuration or tests\/test_\*\.py/u);
  });
});

test("other stacks and unsupported hosts get no profile", async () => {
  await withProject({ "go.mod": "module example\n", "main.go": "package main\n" }, async (dir) => {
    const result = await detectDefaultEnvironment(dir, { platform: "darwin/arm64" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /No Node \(package\.json\) or Python project was detected/u);
  });
  await withProject(nodeProject({ test: "node --test" }), async (dir) => {
    const result = await detectDefaultEnvironment(dir, { platform: null });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /no native environment target/u);
  });
});

test("explicit files outside the read policy are left out of the profile", async () => {
  await withProject(nodeProject({ test: "node --test" }), async (dir) => {
    const result = await detectDefaultEnvironment(dir, { platform: "darwin/arm64", readable: relative => relative === "package.json" });
    assert.ok(result.ok);
    assert.deepEqual(runEnvironmentsSchema.parse(result.environment.environments).profiles["node-tests"]!.source_paths, ["package.json", "src", "test"]);
  });
});

test("the template project with the default profile passes prepared-execution planning and keeps its blocks", async () => {
  await withProject(nodeProject({ test: "node --test", lint: "node --check index.js" }), async (dir) => {
    await mkdir(path.join(dir, ".agent-workflow"), { recursive: true });
    await copyFile(templateConfig, path.join(dir, ".agent-workflow", "project.yaml"));
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.email=dev@example.com", "-c", "user.name=Example", "commit", "-qm", "init"]]) execFileSync("git", args, { cwd: dir });
    const template = await loadProjectConfig(dir);
    await assert.rejects(pipelineEnvironmentPlans(dir, template, "default-env-before", "build-feature", "implement"), /needs declared environment profiles/u);

    const host = hostEnvironmentPlatform();
    assert.ok(host, "the test host has a native platform");
    const result = await detectDefaultEnvironment(dir, { readable: relative => { try { assertFileReadAllowed(relative, template); return true; } catch { return false; } } });
    assert.ok(result.ok);
    await writeDefaultEnvironment(dir, result.environment);
    const project = await loadProjectConfig(dir);
    assert.doesNotThrow(() => assertRepairCommitEnabled(project));
    const plans = await pipelineEnvironmentPlans(dir, project, "default-env-after", "build-feature", "implement");
    assert.deepEqual(plans.map(plan => [plan.profile, plan.kind, plan.platform]), [["node-tests", "native", host]]);
    assert.ok(plans[0]!.sourceFiles.some(file => file.path === "test/add.test.js"));

    // The project file's own policy, without commands a host trusts globally.
    const raw = YAML.parse(await readFile(path.join(dir, ".agent-workflow", "project.yaml"), "utf8"));
    const own = projectConfigSchema.parse(raw);
    assert.deepEqual(own.actions.allowed_commands, [ENVIRONMENT_COMMAND, REPAIR_COMMIT_COMMAND, "node --version", "npm test", "npm run lint"]);
    for (const command of ["npm test", "npm run lint", "node --version"]) assert.doesNotThrow(() => assertCommandAllowed(command, own));
    for (const command of ["git push origin master", "npm publish", "npm install", "npm run deploy", "curl https://example.com"]) assert.throws(() => assertCommandAllowed(command, own), Error, command);
    const before = projectConfigSchema.parse(YAML.parse(await readFile(templateConfig, "utf8")));
    assert.deepEqual(own.actions.blocked_commands, before.actions.blocked_commands);
    assert.deepEqual(own.actions.allowed_write_paths, before.actions.allowed_write_paths);
    assert.equal(raw.execution.pipeline.required, true, "other execution settings are kept");
    await assert.rejects(writeDefaultEnvironment(dir, result.environment), /already declares execution\.environments/u);
  });
});
