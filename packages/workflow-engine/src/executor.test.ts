import assert from "node:assert/strict";
import test from "node:test";
import { actionIdempotencyKey, buildBoundedReactLoopReceiptContent } from "./executor.js";

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

test("bounded ReAct loop receipts capture action, policy, result, and stop reason", () => {
  const receipt = buildBoundedReactLoopReceiptContent({
    task: {
      runId: "run-1",
      taskId: "task-1",
      workflowId: "debug-failure",
      workflowTask: "Fix a failed test.",
      stageId: "reproduce",
      stageGoal: "Reproduce the failure.",
      agentId: "ci-debugger"
    },
    stagePattern: {
      type: "react",
      maxIterations: 3,
      requiresVerifier: true,
      promotionGate: "evaluation",
      stopConditions: ["test reproduced", "max iterations reached"]
    },
    iteration: 2,
    totalRequestedActions: 2,
    actionType: "local_command",
    target: "npm test",
    payloadHash: "hash-1",
    policyDecision: {
      status: "allowed",
      approvalRequired: false,
      allowedByPolicy: true
    },
    resultReceipt: {
      status: "completed",
      exitCode: 0,
      artifactUri: "db://artifacts/1"
    }
  });

  assert.equal(receipt.kind, "agentflow_bounded_react_loop_receipt");
  assert.equal(receipt.workflowId, "debug-failure");
  assert.equal(receipt.stageId, "reproduce");
  assert.equal(receipt.iteration, 2);
  assert.equal(receipt.maxIterations, 3);
  assert.equal(receipt.overBudget, false);
  assert.equal(receipt.stopReason, "provider_returned_no_more_actions");
  assert.deepEqual(receipt.actionRequested, {
    type: "local_command",
    target: "npm test",
    payloadHash: "hash-1"
  });
  assert.deepEqual(receipt.policyDecision, {
    status: "allowed",
    approvalRequired: false,
    allowedByPolicy: true
  });
  assert.deepEqual(receipt.resultReceipt, {
    status: "completed",
    exitCode: 0,
    artifactUri: "db://artifacts/1"
  });
});

test("bounded ReAct loop receipts mark actions beyond max iterations", () => {
  const receipt = buildBoundedReactLoopReceiptContent({
    task: {
      runId: "run-1",
      taskId: "task-1",
      workflowId: "wide-open-automation",
      workflowTask: "Run trusted automation.",
      stageId: "execute",
      stageGoal: "Complete the configured task.",
      agentId: "auto-wide-open-executor"
    },
    stagePattern: {
      type: "react",
      maxIterations: 1,
      requiresVerifier: true,
      promotionGate: "policy",
      stopConditions: []
    },
    iteration: 2,
    totalRequestedActions: 2,
    actionType: "file_write",
    target: ".agent-workflow/notes/result.md",
    payloadHash: "hash-2",
    policyDecision: {
      status: "auto_approved_by_rule"
    },
    resultReceipt: {
      status: "completed"
    }
  });

  assert.equal(receipt.overBudget, true);
  assert.equal(receipt.stopReason, "max_iterations_exceeded");
});
