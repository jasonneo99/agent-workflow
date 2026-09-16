import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWorkflowRunTransition,
  assertWorkflowRunFence,
  isTerminalWorkflowRunState,
  workflowRunStatuses
} from "./run-state-machine.js";

test("run states expose only the authoritative lifecycle", () => {
  assert.deepEqual(workflowRunStatuses, ["queued", "leased", "running", "completed", "blocked", "failed", "cancelled"]);
});

test("superseded and cross-worker fencing tokens are rejected", () => {
  const current = { leaseEpoch: "12", leaseOwner: "worker-new" };
  assert.doesNotThrow(() => assertWorkflowRunFence(current, { leaseEpoch: "12", leaseOwner: "worker-new" }));
  assert.throws(() => assertWorkflowRunFence(current, { leaseEpoch: "11", leaseOwner: "worker-old" }), /Stale workflow run fencing token/u);
  assert.throws(() => assertWorkflowRunFence(current, { leaseEpoch: "12", leaseOwner: "worker-other" }), /Stale workflow run fencing token/u);
});

test("forward lifecycle transitions and idempotent repeats are accepted", () => {
  assert.equal(assertWorkflowRunTransition("queued", "leased"), "transition");
  assert.equal(assertWorkflowRunTransition("leased", "running"), "transition");
  assert.equal(assertWorkflowRunTransition("running", "completed"), "transition");
  assert.equal(assertWorkflowRunTransition("running", "running"), "idempotent");
});

test("backward transitions and terminal mutation are rejected", () => {
  assert.throws(() => assertWorkflowRunTransition("running", "queued"), /Invalid workflow run transition/u);
  for (const terminal of ["completed", "blocked", "failed", "cancelled"] as const) {
    assert.equal(isTerminalWorkflowRunState(terminal), true);
    assert.throws(() => assertWorkflowRunTransition(terminal, "queued"), /terminal state is immutable/u);
  }
});
