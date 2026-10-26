import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectConfigSchema, workflowSchema } from "../../agent-registry/src/schemas.js";
import { createExecutorSnapshots, executeExecutorSnapshot } from "../../executor-adapters/src/index.js";
import { evaluateSuspendResumeAcceptance, shouldRecordSuspendResumeCanary, suspendResumeCanaryMode } from "./suspend-resume-canary.js";

test("canary defaults to shadow and has an explicit rollback switch", () => {
  assert.equal(suspendResumeCanaryMode({}), "shadow");
  assert.equal(shouldRecordSuspendResumeCanary({ AGENTFLOW_SUSPEND_RESUME_CANARY: "shadow" }), true);
  assert.equal(shouldRecordSuspendResumeCanary({ AGENTFLOW_SUSPEND_RESUME_CANARY: "off" }), false);
  assert.throws(() => suspendResumeCanaryMode({ AGENTFLOW_SUSPEND_RESUME_CANARY: "broken" }), /must be off, shadow, or authoritative/);
});

test("independent acceptance refuses authority until every gate passes", () => {
  const baseline = { realExecutorPassed: true, approvalPassed: true, rejectionPassed: true, restartResumePassed: true, rollbackPassed: true, receiptChainPassed: true };
  assert.deepEqual(evaluateSuspendResumeAcceptance(baseline), { accepted: true, schedulingMode: "authoritative-eligible", missing: [] });
  assert.deepEqual(evaluateSuspendResumeAcceptance({ ...baseline, rollbackPassed: false }), {
    accepted: false, schedulingMode: "shadow", missing: ["rollback to existing executor"]
  });
});

test("real bounded executor process completes through the canary contract", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentflow-canary-"));
  const executable = path.join(directory, "executor.sh");
  await writeFile(executable, "#!/bin/sh\nprintf 'job=suspend-resume-canary-%s\\n' \"$2\"\n", "utf8");
  await chmod(executable, 0o700);
  const project = projectConfigSchema.parse({ project: { name: "agent-workflow" }, execution: { executor_adapters: {
    "ssh-exact-revision": { type: "ssh-exact-revision", projects: ["agent-workflow"], operations: ["typecheck"], host: "sharedHost", project_root: process.cwd() }
  } } });
  const workflow = workflowSchema.parse({ id: "canary", name: "Canary", description: "Acceptance canary", lead: "test-engineer",
    stages: [{ id: "verify", agent: "test-engineer", goal: "verify", executor: { id: "ssh-exact-revision", operation: "typecheck" } }] });
  const snapshot = createExecutorSnapshots({ project, workflow, revision: "a".repeat(40), runId: "canary-run", taskIds: { verify: "canary-task" }, projectRootUri: process.cwd() }).verify!;
  const result = await executeExecutorSnapshot(snapshot, { executable });
  assert.equal(result.status, "passed");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.executionHost, "sharedHost");
  assert.match(result.artifactReference ?? "", /^sharedHost-job:\/\/suspend-resume-canary-/);
});
