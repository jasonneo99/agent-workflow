import assert from "node:assert/strict";
import test from "node:test";
import { compareRegression, compareWorkflowToDirect, summarize } from "./index.js";

test("summarize calculates bounded percentile evidence", () => {
  assert.deepEqual(summarize([1, 2, 3, 4, 100]), { count: 5, p50: 3, p95: 100, average: 22, min: 1, max: 100 });
});

test("regression comparison fails closed and enforces its budget", () => {
  assert.equal(compareRegression({ baselineP95: 100, candidateP95: 109, budgetPercent: 10 }).passed, true);
  assert.equal(compareRegression({ baselineP95: 100, candidateP95: 111, budgetPercent: 10 }).passed, false);
  assert.equal(compareRegression({ baselineP95: 0, candidateP95: 1, budgetPercent: 10 }).passed, false);
});

test("workflow comparison uses a measured direct baseline and explains overhead", () => {
  const direct = { totalMs: 100, queueDelayMs: 0, modelLatencyMs: 80, commandExecutionMs: 20, approvalWaitMs: 0, orchestrationOverheadMs: 0, retries: 0, usefulParallelism: 1 };
  const workflow = { totalMs: 145, queueDelayMs: 15, modelLatencyMs: 90, commandExecutionMs: 20, approvalWaitMs: 0, orchestrationOverheadMs: 20, retries: 0, usefulParallelism: 1 };
  const result = compareWorkflowToDirect({ direct, workflow, maximumMultiplier: 1.5 });
  assert.equal(result.passed, true);
  assert.equal(result.multiplier, 1.45);
  assert.equal(result.dominantContributor, "model");
  assert.ok(result.recommendations.length >= 2);
  assert.throws(() => compareWorkflowToDirect({ direct: { ...direct, totalMs: 0 }, workflow, maximumMultiplier: 1.5 }), /positive direct baseline/u);
});
