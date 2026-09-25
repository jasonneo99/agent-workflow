import assert from "node:assert/strict";
import test from "node:test";
import { buildAcceptedWorkflowOutcome, buildAcceptedWorkflowOutcomeReport } from "./outcome-metrics.js";
import type { ArtifactStatus } from "../../storage/src/postgres.js";

function route(id: string, content: Record<string, unknown>): ArtifactStatus {
  return { id, runId: "run", taskId: null, kind: "model_route", uri: `db:///${id}`, content, createdAt: "2026-01-01T00:00:00.000Z" };
}

test("accepted workflow outcomes count measured frontier tokens without projections", () => {
  const outcome = buildAcceptedWorkflowOutcome({ accepted: true, routeArtifacts: [
    route("frontier", { route: { modelTier: "reasoning", estimatedCostTier: "high" }, usage: { inputTokens: 1200, costUsd: 0.03 } }),
    route("fast", { route: { modelTier: "fast", estimatedCostTier: "low" }, usage: { inputTokens: 300, costUsd: 0.001 } })
  ] });
  assert.equal(outcome.measuredFrontierInputTokens, 1200);
  assert.equal(outcome.measuredInputTokens, 1500);
  assert.equal(outcome.measuredCostUsd, 0.031);
  assert.equal(outcome.measurementStatus, "measured");
  const aggregate = buildAcceptedWorkflowOutcomeReport([outcome, { ...outcome, accepted: false }]);
  assert.equal(aggregate.acceptedWorkflows, 1);
  assert.equal(aggregate.averageFrontierInputTokensPerAcceptedWorkflow, 1200);
  assert.equal(aggregate.tokenCoveragePercent, 100);
  assert.equal(aggregate.costCoveragePercent, 100);
});

test("accepted workflow outcomes backfill catalog cost from immutable route evidence", () => {
  const outcome = buildAcceptedWorkflowOutcome({ accepted: true, routeArtifacts: [
    route("priced", { actualModel: "gpt-5.6-luna", route: { modelTier: "fast" }, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } })
  ] });
  assert.equal(outcome.measuredCostUsd, 1.4);
  assert.equal(outcome.costCoverageStages, 1);
});
