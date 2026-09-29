import assert from "node:assert/strict";
import test from "node:test";
import { buildRunOutcomeContract } from "./run-outcome.js";

test("delivery requires both a governed write and successful command evidence", () => {
  const incomplete = buildRunOutcomeContract({ run: { status: "completed", workflowId: "build-feature" }, artifacts: [{ kind: "file_write", content: {} }], openApprovalCount: 0 });
  assert.equal(incomplete.state, "incomplete");
  assert.equal(incomplete.acceptReady, false);
  const delivered = buildRunOutcomeContract({ run: { status: "completed", workflowId: "build-feature" }, artifacts: [{ kind: "file_write", content: {} }, { kind: "command_output", content: { exitCode: 0 } }], openApprovalCount: 0 });
  assert.equal(delivered.state, "delivered");
  assert.equal(delivered.acceptReady, true);
});

test("blocked outcomes distinguish approvals while preserving the recorded reason", () => {
  const outcome = buildRunOutcomeContract({ run: { status: "blocked", blockedReason: "Permission is required." }, artifacts: [], openApprovalCount: 1 });
  assert.equal(outcome.state, "needs_input");
  assert.equal(outcome.title, "Waiting for your approval");
  assert.equal(outcome.detail, "Permission is required.");
  assert.equal(outcome.inputPrompt, undefined);
});

test("blocked outcomes give a specific conversational input prompt", () => {
  const outcome = buildRunOutcomeContract({ run: { status: "blocked", blockedReason: "Choose the target runtime." }, artifacts: [], openApprovalCount: 0 });
  assert.match(outcome.inputPrompt ?? "", /choice or decision/iu);
});

test("implementation specialist work is a delivery contract, not advisory completion", () => {
  const outcome = buildRunOutcomeContract({
    run: { status: "completed", workflowId: "agent-task-implementation-agent" },
    tasks: [{ agentId: "implementation-agent" }],
    artifacts: [{ kind: "file_write", content: {} }],
    openApprovalCount: 0
  });
  assert.equal(outcome.state, "incomplete");
  assert.match(outcome.detail, /verification command/iu);
});

test("lineage evidence can complete a verification-only continuation", () => {
  const outcome = buildRunOutcomeContract({
    run: { status: "completed", workflowId: "agent-task-implementation-agent" },
    tasks: [{ agentId: "implementation-agent" }],
    artifacts: [{ kind: "file_write", content: {} }, { kind: "command_output", content: { exitCode: 0 } }],
    lineageRunIds: ["source-run"],
    openApprovalCount: 0
  });
  assert.equal(outcome.state, "delivered");
  assert.deepEqual(outcome.lineageRunIds, ["source-run"]);
});

test("cancelled work is not presented as still running", () => {
  const outcome = buildRunOutcomeContract({
    run: { status: "cancelled", workflowId: "build-feature" },
    artifacts: [{ kind: "file_write" }, { kind: "command_output", content: { exitCode: 0 } }],
    openApprovalCount: 0
  });
  assert.equal(outcome.state, "incomplete");
  assert.equal(outcome.title, "Stopped before delivery");
  assert.equal(outcome.acceptReady, false);
});
