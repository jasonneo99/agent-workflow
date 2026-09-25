import assert from "node:assert/strict";
import test from "node:test";
import { buildOutcomeAccuracyReport, calibratedOutcomeScore, latencyBudgetMs } from "./outcome-accuracy.js";

const run = (rating: "accepted" | "revised" | "rejected" | null, quality = 1, fallbackCount = 0) => ({ status: "completed", totalStages: 1, routedStages: 1, fallbackCount, averageQuality: quality, feedback: { latest: rating ? { rating } : null } });

test("outcome accuracy separates terminal completion from expected-result acceptance", () => {
  const report = buildOutcomeAccuracyReport([run("accepted"), run("revised"), run(null), run("rejected", 0.9, 1)]);
  assert.equal(report.completionRate, 1);
  assert.equal(report.expectedResultRate, 0.333);
  assert.equal(report.feedbackCoverage, 0.75);
  assert.equal(report.missingOutcomeEvidence, 1);
  assert.equal(report.qualityMismatch, 2);
  assert.equal(report.firstPassRate, 1);
});

test("calibrated outcome score gives reviewed outcomes more weight than heuristic quality", () => {
  assert.equal(calibratedOutcomeScore({ accepted: 0, revised: 5, rejected: 0, averageQuality: 1 }), 0.6);
  assert.equal(calibratedOutcomeScore({ accepted: 0, revised: 0, rejected: 0, averageQuality: 0.8 }), 0.8);
});

test("latency budgets are stage-specific", () => {
  assert.equal(latencyBudgetMs({ workflowId: "provider-smoke", stageId: "contract", agentId: "task-triager", modelTier: "fast" }), 8_000);
  assert.equal(latencyBudgetMs({ workflowId: "build-feature", stageId: "implement", agentId: "implementation-agent", modelTier: "standard" }), 180_000);
  assert.equal(latencyBudgetMs({ workflowId: "review-pr", stageId: "inspect", agentId: "technical-architect", modelTier: "reasoning" }), 45_000);
});
