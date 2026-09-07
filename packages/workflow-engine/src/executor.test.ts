import assert from "node:assert/strict";
import test from "node:test";
import { actionIdempotencyKey, runExecutorApprovalGate } from "./executor.js";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";

test("action idempotency keys are stable for the same normalized action", () => {
  const base = {
    taskId: "task-1",
    stageId: "verify",
    agentId: "test-engineer",
    actionType: "local_command",
    target: "npm   test",
    payload: "npm   test",
    normalizePayload: true
  };

  assert.equal(
    actionIdempotencyKey(base),
    actionIdempotencyKey({ ...base, target: "npm test", payload: "npm test" })
  );
});

test("action idempotency keys change when the payload changes", () => {
  const base = {
    taskId: "task-1",
    stageId: "document",
    agentId: "docs-maintainer",
    actionType: "file_write",
    target: ".agent-workflow/notes/summary.md",
    payload: "first version"
  };

  assert.notEqual(
    actionIdempotencyKey(base),
    actionIdempotencyKey({ ...base, payload: "second version" })
  );
});

const executorTarget = `hulk-exact-revision/typecheck@hulk#${"a".repeat(40)}:/registered/root`;

function approvalProject(withRule = false) {
  return projectConfigSchema.parse({
    project: { name: "agent-workflow" },
    policies: { require_approval_for_external_actions: true },
    actions: { approval_rules: withRule ? [{ id: "exact-remote", action_type: "executor_adapter", target: executorTarget, effect: "auto_execute" }] : [] }
  });
}

test("pending executor approval prevents remote execution", async () => {
  let executions = 0;
  const result = await runExecutorApprovalGate({ project: approvalProject(), target: executorTarget, approved: false, execute: async () => ++executions });
  assert.equal(result.status, "pending");
  assert.equal(executions, 0);
});

test("approved executor approval executes once", async () => {
  let executions = 0;
  const result = await runExecutorApprovalGate({ project: approvalProject(), target: executorTarget, approved: true, execute: async () => ++executions });
  assert.equal(result.status, "executed");
  assert.equal(executions, 1);
});

test("narrow recurring executor rule executes only its exact target", async () => {
  let executions = 0;
  const project = approvalProject(true);
  const exact = await runExecutorApprovalGate({ project, target: executorTarget, approved: false, execute: async () => ++executions });
  const different = await runExecutorApprovalGate({ project, target: executorTarget.replace("typecheck", "test"), approved: false, execute: async () => ++executions });
  assert.equal(exact.status, "executed");
  assert.equal(different.status, "pending");
  assert.equal(executions, 1);
});
