import assert from "node:assert/strict";
import test from "node:test";
import { recommendRunNextAction } from "./run-recommendation.js";

test("run recommendations name the actual blocker or approval", () => {
  assert.match(recommendRunNextAction({ status: "blocked", workflowId: "build-feature", failedTasks: 1, failures: [], blockedReason: "Choose a deployment target." }), /Choose a deployment target/);
  assert.match(recommendRunNextAction({ status: "blocked", workflowId: "build-feature", failedTasks: 1, failures: [], pendingApprovals: 2 }), /2 pending approvals/);
});

test("run recommendations follow continuation lineage and delivery outcomes", () => {
  assert.match(recommendRunNextAction({ status: "completed", workflowId: "build-feature", failedTasks: 0, failures: [], replacementRunId: "12345678-abcd" }), /continuation run 12345678/);
  assert.match(recommendRunNextAction({ status: "completed", workflowId: "dynamic-feature-delivery-example", failedTasks: 0, failures: [] }), /delivered changes and verification evidence/);
});
