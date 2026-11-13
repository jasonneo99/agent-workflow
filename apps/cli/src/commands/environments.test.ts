import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { runProcess, ENVIRONMENT_COMMAND } from "../../../../packages/run-environments/src/index.js";

const cli = path.resolve("apps/cli/src/index.ts");
async function fixture() {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "environment-cli-test-")));
  await fs.mkdir(path.join(cwd, ".agent-workflow")); await fs.mkdir(path.join(cwd, "tests"));
  await fs.writeFile(path.join(cwd, "tests/check.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('example', () => assert.ok(true));\n");
  await fs.writeFile(path.join(cwd, ".agent-workflow/project.yaml"), YAML.stringify({ project: { name: "example" }, execution: { environments: {
    default_profile: "test", profiles: { test: { kind: "native", platform: `${process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`,
      source_paths: ["tests"], readiness: [{ argv: ["node", "--version"] }], verification: [{ commands: ["node --test tests/check.test.js"], format: "node-test", expected_tests: 1 }] } }
  } }, actions: { allowed_commands: [ENVIRONMENT_COMMAND, "node --version", "node --test tests/check.test.js"] } }));
  const call = (...args: string[]) => runProcess([process.execPath, "--import", "tsx", cli, "environments", "--project", cwd, "--run", "example-run", ...args],
    { cwd: process.cwd(), timeoutMs: 30_000, maxOutputChars: 30_000 });
  return { cwd, call, cleanup: () => fs.rm(cwd, { recursive: true, force: true }) };
}

test("source CLI previews without contacting an engine or creating run evidence", async () => {
  const f = await fixture(); try {
    const result = await f.call("--command", "node --test tests/check.test.js", "--json");
    assert.equal(result.exitCode, 0, result.stderr);
    const plan = JSON.parse(result.stdout); assert.equal(plan.preview, true); assert.equal(plan.kind, "native");
    await assert.rejects(fs.access(path.join(f.cwd, ".agent-workflow/runtime")));
  } finally { await f.cleanup(); }
});

test("source CLI executes the real collection and returns ready source-bound evidence", async () => {
  const f = await fixture(); try {
    const result = await f.call("--command", "node --test tests/check.test.js", "--verify", "--execute", "--json");
    assert.equal(result.exitCode, 0, result.stderr);
    const actual = JSON.parse(result.stdout); assert.equal(actual.preview, false);
    assert.equal(actual.verificationRecipe.passed, 1); assert.equal(actual.verificationRecipe.skipped, 0);
    assert.equal(actual.environment.status, "ready"); assert.match(actual.environment.runtimeHash, /^[a-f0-9]{64}$/u);
  } finally { await f.cleanup(); }
});

test("source CLI never executes a command outside project policy", async () => {
  const f = await fixture(); try {
    const result = await f.call("--command", "node arbitrary.js", "--execute");
    assert.notEqual(result.exitCode, 0); assert.match(result.stderr, /not allowed/u);
    await assert.rejects(fs.access(path.join(f.cwd, ".agent-workflow/runtime")));
  } finally { await f.cleanup(); }
});
