import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailureForTriage, failureTriageRiskAllowed } from "./index.js";

test("groups provider failures into a health-checked low-risk retry decision", () => {
  const decision = classifyFailureForTriage({ runId: "run-1", workflowId: "provider-smoke", providerId: "anthropic", taskAttempts: 2, receipts: [{ actionType: "model_route_failed", target: "anthropic", summary: "Provider configuration is incomplete." }] });
  assert.equal(decision.signature, "provider:anthropic:configuration");
  assert.equal(decision.risk, "low");
  assert.equal(decision.retryAfterVerification, true);
});

test("does not bypass approval failures or high-risk workflows", () => {
  const decision = classifyFailureForTriage({ runId: "run-2", workflowId: "ship-release", providerId: null, taskAttempts: 1, receipts: [{ actionType: "stage_failed", target: "release", summary: "Approval required." }] });
  assert.equal(decision.category, "policy");
  assert.equal(decision.risk, "high");
  assert.equal(decision.retryAfterVerification, false);
  assert.equal(failureTriageRiskAllowed("high", "medium"), false);
});
