import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { projectConfigSchema, workflowSchema } from "../../agent-registry/src/schemas.js";
import { assertSnapshot, createExecutorSnapshots, executeExecutorSnapshot, type ExecutorResult } from "./index.js";

const revision = "a".repeat(40);

function fixture(overrides: Record<string, unknown> = {}) {
  const project = projectConfigSchema.parse({
    project: { name: "agent-workflow" },
    execution: {
      executor_adapters: {
        "hulk-exact-revision": {
          type: "hulk-exact-revision",
          projects: ["agent-workflow"],
          operations: ["typecheck", "validate", "test"],
          host: "hulk",
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
    stages: [{ id: "verify", agent: "test-engineer", goal: "verify", executor: { id: "hulk-exact-revision", operation: "typecheck" } }]
  });
  return createExecutorSnapshots({ project, workflow, revision, runId: "run-1", taskIds: { verify: "task-1" } }).verify;
}

test("immutable executor snapshots bind all envelope fields and have stable idempotency evidence", () => {
  const left = fixture();
  const right = fixture();
  assert.deepEqual(left, right);
  assert.equal(left.executorId, "hulk-exact-revision");
  assert.equal(left.registeredProject, "agent-workflow");
  assert.equal(left.runId, "run-1");
  assert.equal(left.taskId, "task-1");
  assert.equal(left.revision, revision);
  assert.equal(left.timeoutMs, 500);
  assert.equal(left.maxOutputChars, 20);
  assert.throws(() => assertSnapshot({ ...left, taskId: "changed" }), /hash mismatch/);
});

test("snapshot creation rejects unknown adapters, projects, and operations", () => {
  const base = projectConfigSchema.parse({ project: { name: "agent-workflow" } });
  const unknown = workflowSchema.parse({ id: "x", name: "x", description: "x", lead: "x", stages: [{ id: "s", agent: "x", goal: "x", executor: { id: "missing", operation: "test" } }] });
  assert.throws(() => createExecutorSnapshots({ project: base, workflow: unknown, revision, runId: "r", taskIds: { s: "t" } }), /Unknown executor/);
  assert.throws(() => fixture({ projects: ["another-project"] }), /not registered for project/);
  assert.throws(() => fixture({ operations: ["test"] }), /does not permit operation typecheck/);
  assert.throws(() => assertSnapshot({ ...fixture(), registeredProject: "unknown", snapshotHash: fixture().snapshotHash }), /Unregistered executor project/);
  assert.throws(() => assertSnapshot({ ...fixture(), operation: "deploy" as never }), /Unregistered executor operation/);
});

test("unreachable Hulk fails closed unless explicit local fallback is configured", async () => {
  await assert.rejects(() => executeExecutorSnapshot(fixture(), { executable: "/definitely/missing/hulk-executor" }), /ENOENT/);
  let fallbackCalls = 0;
  const fallback = async (): Promise<ExecutorResult> => {
    fallbackCalls += 1;
    return { status: "passed", exitCode: 0, signal: null, stdout: "local", stderr: "", durationMs: 1, timedOut: false, requestedHost: "hulk", executionHost: "local", fallbackUsed: true, artifactReference: null };
  };
  const result = await executeExecutorSnapshot(fixture({ local_fallback: "explicit" }), { executable: "/definitely/missing/hulk-executor", localFallback: fallback });
  assert.equal(fallbackCalls, 1);
  assert.equal(result.fallbackUsed, true);
  assert.notEqual(result.executionHost, "hulk");
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
  assert.equal(result.artifactReference, "hulk-job://proof-job");
});
