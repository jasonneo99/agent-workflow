import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { projectConfigSchema, workflowSchema } from "../../agent-registry/src/schemas.js";
import {
  assertExecutorRegistration,
  assertSnapshot,
  createExecutorSnapshots,
  executeExecutorSnapshot,
  executorEvidenceHash,
  type ExecutorResult,
  type ExecutorSnapshot
} from "./index.js";

const revision = "a".repeat(40);

function fixture(overrides: Record<string, unknown> = {}) {
  const project = projectConfigSchema.parse({
    project: { name: "agent-workflow" },
    execution: {
      executor_adapters: {
        "ssh-exact-revision": {
          type: "ssh-exact-revision",
          projects: ["agent-workflow"],
          operations: ["typecheck", "validate", "test"],
          host: "sharedHost",
          project_root: process.cwd(),
          timeout_ms: 500,
          max_output_chars: 20,
          local_fallback: "off",
          ...overrides
        }
      }
    }
  });
  const workflow = workflowSchema.parse({
    id: "remote", name: "Remote", description: "test", lead: "test-engineer",
    stages: [{ id: "verify", agent: "test-engineer", goal: "verify", executor: { id: "ssh-exact-revision", operation: "typecheck" } }]
  });
  return createExecutorSnapshots({ project, workflow, revision, runId: "run-1", taskIds: { verify: "task-1" }, projectRootUri: process.cwd() }).verify;
}

test("immutable executor snapshots bind all envelope fields and have stable idempotency evidence", () => {
  const left = fixture();
  const right = fixture();
  assert.deepEqual(left, right);
  assert.equal(left.executorId, "ssh-exact-revision");
  assert.equal(left.registeredProject, "agent-workflow");
  assert.equal(left.registeredProjectRoot, process.cwd());
  assert.equal(left.runId, "run-1");
  assert.equal(left.taskId, "task-1");
  assert.equal(left.revision, revision);
  assert.equal(left.timeoutMs, 500);
  assert.equal(left.maxOutputChars, 20);
  assert.throws(() => assertSnapshot({ ...left, taskId: "changed" }), /hash mismatch/);
});

test("snapshot evidence survives PostgreSQL jsonb key reordering", () => {
  const snapshot = fixture();
  const reordered = Object.fromEntries(
    Object.entries(snapshot).reverse()
  ) as unknown as ExecutorSnapshot;
  assert.doesNotThrow(() => assertSnapshot(reordered));
});

test("executor evidence hashing recursively canonicalizes object keys", () => {
  const left = { outer: { beta: 2, alpha: 1 }, list: [{ delta: 4, gamma: 3 }] };
  const right = { list: [{ gamma: 3, delta: 4 }], outer: { alpha: 1, beta: 2 } };
  assert.equal(executorEvidenceHash(left), executorEvidenceHash(right));
});

test("snapshot creation rejects unknown adapters, projects, and operations", () => {
  const base = projectConfigSchema.parse({ project: { name: "agent-workflow" } });
  const unknown = workflowSchema.parse({ id: "x", name: "x", description: "x", lead: "x", stages: [{ id: "s", agent: "x", goal: "x", executor: { id: "missing", operation: "test" } }] });
  assert.throws(() => createExecutorSnapshots({ project: base, workflow: unknown, revision, runId: "r", taskIds: { s: "t" }, projectRootUri: process.cwd() }), /Unknown executor/);
  assert.throws(() => fixture({ projects: ["another-project"] }), /not registered for project/);
  assert.throws(() => fixture({ operations: ["test"] }), /does not permit operation typecheck/);
  assert.throws(() => fixture({ host: "loki" }), /Invalid literal value|Invalid input/);
  assert.throws(() => fixture({ project_root: "relative/path" }), /project_root must be absolute/);
  assert.throws(() => fixture({ project_root: path.join(process.cwd(), "spoof") }), /not registered for project root/);
  assert.throws(() => assertSnapshot({ ...fixture(), registeredProject: "unknown", snapshotHash: fixture().snapshotHash }), /Unregistered executor project/);
  assert.throws(() => assertSnapshot({ ...fixture(), operation: "deploy" as never }), /Unregistered executor operation/);
  assert.throws(() => assertSnapshot({ ...fixture(), requestedHost: "loki" }), /Unregistered executor host/);
});

test("unreachable shared host fails closed unless explicit local fallback is configured", async () => {
  await assert.rejects(() => executeExecutorSnapshot(fixture(), { executable: "/definitely/missing/sharedHost-executor" }), /ENOENT/);
  let fallbackCalls = 0;
  const fallback = async (): Promise<ExecutorResult> => {
    fallbackCalls += 1;
    return { status: "passed", exitCode: 0, signal: null, stdout: "local", stderr: "", durationMs: 1, timedOut: false, requestedHost: "sharedHost", executionHost: "local", fallbackUsed: true, artifactReference: null };
  };
  const result = await executeExecutorSnapshot(fixture({ local_fallback: "explicit" }), { executable: "/definitely/missing/sharedHost-executor", localFallback: fallback });
  assert.equal(fallbackCalls, 1);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.requestedHost, "sharedHost");
  assert.equal(result.executionHost, hostname());
  assert.equal(result.stdout, "local");
});

test("current registration recheck rejects project-name spoofing and configuration drift", () => {
  const snapshot = fixture();
  const valid = projectConfigSchema.parse({ project: { name: "agent-workflow" }, execution: { executor_adapters: { "ssh-exact-revision": { type: "ssh-exact-revision", projects: ["agent-workflow"], operations: ["typecheck"], host: "sharedHost", project_root: process.cwd() } } } });
  assert.doesNotThrow(() => assertExecutorRegistration(snapshot, valid, process.cwd()));
  const spoofedName = projectConfigSchema.parse({ ...valid, project: { name: "spoofed" } });
  assert.throws(() => assertExecutorRegistration(snapshot, spoofedName, process.cwd()), /Unregistered executor project/);
  const driftedRoot = projectConfigSchema.parse({ ...valid, execution: { ...valid.execution, executor_adapters: { "ssh-exact-revision": { ...valid.execution.executor_adapters!["ssh-exact-revision"], project_root: path.join(process.cwd(), "other") } } } });
  assert.throws(() => assertExecutorRegistration(snapshot, driftedRoot, process.cwd()), /Unregistered executor project root/);
});

test("adapter enforces timeout and bounded output", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentflow-executor-"));
  const noisy = path.join(directory, "noisy.sh");
  await writeFile(noisy, "#!/bin/sh\nprintf '123456789012345678901234567890'\n", "utf8");
  await chmod(noisy, 0o700);
  const bounded = await executeExecutorSnapshot(fixture({ timeout_ms: 1000 }), { executable: noisy });
  assert.match(bounded.stdout, /truncated/);
  assert.ok(bounded.stdout.length < 80);
  const sleepy = path.join(directory, "sleepy.sh");
  await writeFile(sleepy, "#!/bin/sh\nsleep 2\n", "utf8");
  await chmod(sleepy, 0o700);
  const timed = await executeExecutorSnapshot(fixture({ timeout_ms: 200 }), { executable: sleepy });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.status, "failed");
});

test("adapter passes only the registered operation and exact revision", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentflow-executor-"));
  const echoArgs = path.join(directory, "args.sh");
  await writeFile(echoArgs, "#!/bin/sh\nprintf '%s\\n' \"$#:$1:$2\"\nprintf 'job=proof-job\\n'\n", "utf8");
  await chmod(echoArgs, 0o700);
  const result = await executeExecutorSnapshot(fixture({ max_output_chars: 200 }), { executable: echoArgs });
  assert.match(result.stdout, new RegExp(`^2:typecheck:${revision}`));
  assert.equal(result.artifactReference, "sharedHost-job://proof-job");
});
