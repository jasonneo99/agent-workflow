import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { executeAllowedCommand } from "../../local-tools/src/command-executor.js";
import { dockerfileFor, ENVIRONMENT_COMMAND, planRunEnvironment, runEnvironmentCommand, runProcess, selectEnvironment,
  type ProcessResult, type ProcessRunner, type EnvironmentPlan } from "./index.js";
import { environmentProfileSchema } from "./schema.js";
import { testEvidence } from "./evidence.js";

const digest = "a".repeat(64), imageId = `sha256:${"b".repeat(64)}`;
const tap = "# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
const ok = (stdout = "", overrides: Partial<ProcessResult> = {}): ProcessResult =>
  ({ exitCode: 0, signal: null, stdout, stderr: "", timedOut: false, durationMs: 1, ...overrides });
async function fixture() {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "run-environment-test-")));
  await fs.mkdir(path.join(cwd, "src")); await fs.mkdir(path.join(cwd, "tests"));
  await fs.writeFile(path.join(cwd, "src", "index.js"), "export const value = 1;\n");
  await fs.writeFile(path.join(cwd, "tests", "index.test.js"), "import assert from 'node:assert/strict'; import test from 'node:test'; test('value', () => assert.equal(1, 1));\n");
  await fs.writeFile(path.join(cwd, "package-lock.json"), '{"lockfileVersion":3}\n');
  const project = projectConfigSchema.parse({ project: { name: "synthetic-project" }, execution: { environments: {
    profiles: { test: { platform: "linux/amd64", image: `node@sha256:${digest}`, source_paths: ["src", "tests"],
      dependency_paths: ["package-lock.json"], readiness: [{ argv: ["node", "--version"], expect_output: "v22" }],
      verification: [{ commands: ["node --test tests/index.test.js"], format: "node-test", expected_tests: 2 }] } }, default_profile: "test"
  } }, actions: { allowed_commands: [ENVIRONMENT_COMMAND, "node --test tests/index.test.js", "node --version"], command_timeout_ms: 30_000 } });
  return { cwd, project, cleanup: () => fs.rm(cwd, { recursive: true, force: true }) };
}
function dockerMock(plan: EnvironmentPlan, options: { failReady?: boolean; truncateTest?: boolean; skipTest?: boolean; failCleanup?: boolean; cached?: boolean } = {}) {
  const calls: string[][] = [], commands = new Map<string, string[]>();
  let sequence = 0, ready = false;
  const runner: ProcessRunner = async args => {
    calls.push(args);
    const command = args.slice(3);
    if (command[0] === "image" && command[1] === "inspect") {
      if (!ready && !options.cached) return ok("", { exitCode: 1 });
      return ok(JSON.stringify({ Id: imageId, Os: "linux", Architecture: "amd64", Config: { Labels: {
        "io.agentflow.recipe": plan.recipeHash, "io.agentflow.source": plan.sourceHash
      } } }));
    }
    if (command[0] === "build") { ready = true; return ok("built"); }
    if (command[0] === "create") {
      const id = (++sequence).toString(16).padStart(64, "0");
      commands.set(id, command); return ok(id);
    }
    if (command[0] === "start" && command[1] === "--attach") {
      const argv = commands.get(command[2]!)!;
      const isReady = argv.includes("--version");
      if (isReady) return options.failReady ? ok("", { exitCode: 1, stderr: "missing dependency" }) : ok("v22.0.0");
      return ok(options.skipTest ? tap.replace("# pass 2", "# pass 1").replace("# skipped 0", "# skipped 1") : tap, options.truncateTest ? { outputTruncated: true } : {});
    }
    if (command[0] === "inspect") return ok(JSON.stringify({ Running: false, ExitCode: 0, OOMKilled: false, Error: "" }));
    if (command[0] === "rm") return options.failCleanup ? ok("", { exitCode: 1, stderr: "engine unavailable" }) : ok();
    return ok();
  };
  return { runner, calls, commands };
}

test("preview is deterministic, source-bound and has no Docker or filesystem side effects", async () => {
  const f = await fixture(); try {
    const plan = await planRunEnvironment({ ...f, context: { runId: "repair-1" } });
    assert.equal(plan.recipeHash, (await planRunEnvironment({ ...f, context: { runId: "repair-2" } })).recipeHash);
    assert.deepEqual(plan.sourceFiles.map(file => file.path), ["package-lock.json", "src/index.js", "tests/index.test.js"]);
    await assert.rejects(fs.access(path.join(f.cwd, ".agent-workflow")));
    await fs.writeFile(path.join(f.cwd, "src/index.js"), "export const value = 2;\n");
    const next = await planRunEnvironment({ ...f, context: { runId: "repair-1" } });
    assert.equal(next.recipeHash, plan.recipeHash); assert.notEqual(next.sourceHash, plan.sourceHash); assert.notEqual(next.imageTag, plan.imageTag);
  } finally { await f.cleanup(); }
});

test("profiles are selected per run, workflow, stage and command without changing command authority", async () => {
  const f = await fixture(); try {
    const env = f.project.execution.environments!;
    env.profiles.other = { ...env.profiles.test!, readiness: [{ argv: ["node", "--version"], attempts: 1, interval_ms: 250 }] };
    env.selectors = [{ profile: "other", workflow: "build-feature", stage: "verify", command: "node --test *" }];
    assert.equal(selectEnvironment(f.project, { runId: "r", workflowId: "build-feature", stageId: "verify" }, "node --test tests/index.test.js"), "other");
    assert.equal(selectEnvironment(f.project, { runId: "r", stageId: "repair" }, "node --version"), "test");
    await assert.rejects(executeAllowedCommand({ ...f, commandLine: "node forbidden.js", environmentContext: { runId: "r" } }), /not allowed/u);
  } finally { await f.cleanup(); }
});

test("schema rejects floating images, impossible platforms and native automatic installation", () => {
  const profile = { platform: "linux/amd64", image: "node:latest", source_paths: ["src"], readiness: [{ argv: ["node", "--version"] }] };
  assert.equal(environmentProfileSchema.safeParse(profile).success, false);
  assert.equal(environmentProfileSchema.safeParse({ ...profile, image: `node@sha256:${digest}`, platform: "darwin/arm64" }).success, false);
  assert.equal(environmentProfileSchema.safeParse({ ...profile, image: undefined, kind: "native", setup: [["npm", "install"]] }).success, false);
  assert.equal(environmentProfileSchema.safeParse({ ...profile, image: `node@sha256:${digest}`, source_paths: ["../secret"] }).success, false);
});

test("snapshot blocks secrets, symlink escapes, missing inputs and byte limits", async () => {
  const f = await fixture(); try {
    await fs.writeFile(path.join(f.cwd, "src/.env"), "PRIVATE_TOKEN=hidden");
    let plan = await planRunEnvironment({ ...f, context: { runId: "r" } });
    assert.ok(!plan.sourceFiles.some(file => file.path.includes(".env")));
    f.project.execution.environments!.profiles.test!.dependency_paths.push("src/.env");
    await assert.rejects(planRunEnvironment({ ...f, context: { runId: "r" } }), /Private/u);
    f.project.execution.environments!.profiles.test!.dependency_paths.pop();
    await fs.symlink("/etc/hosts", path.join(f.cwd, "src/escape"));
    await assert.rejects(planRunEnvironment({ ...f, context: { runId: "r" } }), /symlink/u);
    await fs.unlink(path.join(f.cwd, "src/escape"));
    f.project.execution.environments!.profiles.test!.limits.max_source_bytes = 1;
    await assert.rejects(planRunEnvironment({ ...f, context: { runId: "r" } }), /limit/u);
    plan = { ...plan }; assert.ok(plan.sourceHash);
  } finally { await f.cleanup(); }
});

test("fresh containers run dependency readiness before tests, retain evidence and clean only owned IDs", async () => {
  const f = await fixture(); try {
    const context = { runId: "repair-1", taskId: "task-1" }, commandLine = "node --test tests/index.test.js";
    const plan = await planRunEnvironment({ ...f, context }), mock = dockerMock(plan);
    const result = await runEnvironmentCommand({ ...f, context, commandLine, argv: ["node", "--test", "tests/index.test.js"], runner: mock.runner });
    assert.equal(result.environment.status, "ready"); assert.equal(result.environment.imageId, imageId);
    assert.equal(result.environment.phase, "command"); assert.equal(result.verificationRecipe?.passed, 2);
    assert.equal(result.environment.cleanup, "complete");
    const creates = mock.calls.filter(args => args[3] === "create"); assert.equal(creates.length, 2);
    assert.ok(creates[0]!.includes("--version")); assert.ok(creates[1]!.includes("--test"));
    for (const args of creates) {
      assert.ok(args.includes("none")); assert.ok(args.includes("no-new-privileges"));
      assert.ok(!args.includes("--privileged")); assert.ok(!args.includes("--mount")); assert.ok(!args.includes("--volume"));
      assert.ok(args.includes(imageId));
    }
    assert.equal(mock.calls.filter(args => args[3] === "rm").length, 2);
    const receipt = JSON.parse(await fs.readFile(result.environment.receiptPath!, "utf8"));
    assert.equal(receipt.result.environment.sourceHash, plan.sourceHash);
    assert.equal(receipt.result.verificationRecipe.status, "passed");
    assert.match(dockerfileFor(plan), /COPY dependencies[\s\S]*COPY source/u);
    const verifier = await runEnvironmentCommand({ ...f, context: { runId: "verify-1", reuseRunId: "repair-1", requireVerification: true },
      commandLine, argv: ["node", "--test", "tests/index.test.js"], runner: dockerMock(plan, { cached: true }).runner });
    assert.equal(verifier.environment.recipeHash, result.environment.recipeHash);
    assert.equal(verifier.environment.imageId, imageId); assert.notEqual(verifier.environment.attemptId, result.environment.attemptId);
  } finally { await f.cleanup(); }
});

test("missing dependencies stop before the requested command and do not invoke a native fallback", async () => {
  const f = await fixture(); try {
    const context = { runId: "repair-1" }, plan = await planRunEnvironment({ ...f, context }), mock = dockerMock(plan, { failReady: true });
    let nativeCalls = 0;
    const result = await runEnvironmentCommand({ ...f, context, commandLine: "node --test tests/index.test.js", argv: ["node", "--test", "tests/index.test.js"], runner: mock.runner,
      nativeRunner: async () => { nativeCalls++; return ok(); } });
    assert.equal(result.environment.status, "blocked"); assert.match(result.environment.reason!, /readiness/u);
    assert.equal(nativeCalls, 0); assert.equal(mock.commands.size, 1); assert.equal(result.exitCode, 126);
  } finally { await f.cleanup(); }
});

test("frozen dependency drift, profile changes, symlinked evidence and invalid identities fail closed", async () => {
  const f = await fixture(); try {
    const context = { runId: "repair-1" }, plan = await planRunEnvironment({ ...f, context });
    await runEnvironmentCommand({ ...f, context, commandLine: "node --version", argv: ["node", "--version"], runner: dockerMock(plan).runner });
    await fs.writeFile(path.join(f.cwd, "package-lock.json"), '{"lockfileVersion":2}\n');
    await assert.rejects(runEnvironmentCommand({ ...f, context, commandLine: "node --version", argv: ["node", "--version"], runner: async () => { throw Error("must not execute"); } }), /drift/u);
    await assert.rejects(planRunEnvironment({ ...f, context: { runId: "../escape" } }), /identity/u);
    await fs.rm(path.join(f.cwd, ".agent-workflow/runtime/run-environments"), { recursive: true });
    await fs.symlink(os.tmpdir(), path.join(f.cwd, ".agent-workflow/runtime/run-environments"));
    const freshPlan = await planRunEnvironment({ ...f, context: { runId: "fresh" } });
    await assert.rejects(runEnvironmentCommand({ ...f, context: { runId: "fresh" }, commandLine: "node --version", argv: ["node", "--version"], runner: dockerMock(freshPlan).runner }), /owned directory/u);
  } finally { await f.cleanup(); }
});

test("cached image provenance and platform are checked before starting containers", async () => {
  const f = await fixture(); try {
    let calls = 0;
    const result = await runEnvironmentCommand({ ...f, context: { runId: "r" }, commandLine: "node --version", argv: ["node", "--version"], runner: async () => { calls++; return ok(JSON.stringify({ Id: imageId, Os: "linux", Architecture: "arm64" })); } });
    assert.equal(result.environment.status, "blocked"); assert.match(result.environment.reason!, /binding/u); assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test("skipped, truncated, empty and unknown collections cannot pass verification", async () => {
  const f = await fixture(); try {
    const declaration = f.project.execution.environments!.profiles.test!.verification[0]!;
    for (const stdout of ["", "everything passed", tap.replaceAll("2", "0"), tap + tap, tap.replace("# skipped 0", "# skipped 1")]) {
      assert.equal(testEvidence(ok(stdout), declaration).status, "failed");
    }
    assert.equal(testEvidence(ok(tap, { outputTruncated: true }), declaration).status, "failed");
    assert.equal(testEvidence(ok(tap), declaration).status, "passed");
    const unittest = { ...declaration, format: "unittest" as const };
    assert.equal(testEvidence(ok("Ran 2 tests in 0.01s\n\nOK\n"), unittest).status, "passed");
    assert.equal(testEvidence(ok("Ran 2 tests in 0.01s\n\nOK (skipped=2)\n"), unittest).status, "failed");
    const pytest = { ...declaration, format: "pytest" as const };
    assert.equal(testEvidence(ok("================= 2 passed in 0.01s =================\n"), pytest).status, "passed");
    assert.equal(testEvidence(ok("1 passed, 1 skipped in 0.01s\n"), pytest).status, "failed");
    assert.equal(testEvidence(ok("2 passed, 1 deselected in 0.01s\n"), pytest).status, "failed");
  } finally { await f.cleanup(); }
});

test("cleanup failure remains visible and cannot be reported as a successful run", async () => {
  const f = await fixture(); try {
    const context = { runId: "r" }, plan = await planRunEnvironment({ ...f, context });
    const result = await runEnvironmentCommand({ ...f, context, commandLine: "node --version", argv: ["node", "--version"], runner: dockerMock(plan, { failCleanup: true }).runner });
    assert.equal(result.environment.cleanup, "failed"); assert.equal(result.environment.status, "blocked"); assert.notEqual(result.exitCode, 0);
  } finally { await f.cleanup(); }
});

test("native runner is explicit, platform-matched and readiness remains allowlisted", async () => {
  const f = await fixture(); try {
    f.project.execution.environments!.profiles.test = environmentProfileSchema.parse({ kind: "native", platform: `${process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`,
      source_paths: ["tests"], readiness: [{ argv: ["node", "--version"] }] });
    const result = await executeAllowedCommand({ ...f, commandLine: "node --test tests/index.test.js", environmentContext: { runId: "native-1" } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.environment?.status, "ready"); assert.equal(result.environment?.imageId, null);
    f.project.actions.allowed_commands = [ENVIRONMENT_COMMAND, "node --test tests/index.test.js"];
    const blocked = await executeAllowedCommand({ ...f, commandLine: "node --test tests/index.test.js", environmentContext: { runId: "native-2" } });
    assert.equal(blocked.environment?.status, "blocked"); assert.match(blocked.stderr, /not allowed/u);
    f.project.execution.environments!.profiles.test!.platform = process.platform === "darwin" ? "linux/amd64" : "darwin/arm64";
    const mismatch = await executeAllowedCommand({ ...f, commandLine: "node --test tests/index.test.js", environmentContext: { runId: "native-3" } });
    assert.match(mismatch.stderr, /matching native runner/u);
  } finally { await f.cleanup(); }
});

test("process runner limits output and does not inherit host secrets", async () => {
  const original = process.env.AGENTFLOW_TEST_SECRET;
  process.env.AGENTFLOW_TEST_SECRET = "private-test-value";
  try {
    const result = await runProcess([process.execPath, "-e", "process.stdout.write(String(process.env.AGENTFLOW_TEST_SECRET))"], { cwd: os.tmpdir(), timeoutMs: 3000, maxOutputChars: 1000 });
    assert.equal(result.stdout, "undefined");
    const bounded = await runProcess([process.execPath, "-e", "process.stdout.write('x'.repeat(10000))"], { cwd: os.tmpdir(), timeoutMs: 3000, maxOutputChars: 500 });
    assert.equal(bounded.stdout.length, 500); assert.equal(bounded.outputTruncated, true);
  } finally { if (original === undefined) delete process.env.AGENTFLOW_TEST_SECRET; else process.env.AGENTFLOW_TEST_SECRET = original; }
});
