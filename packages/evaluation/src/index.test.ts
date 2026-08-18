import assert from "node:assert/strict";
import test from "node:test";
import type { CostQualityReport } from "../../run-reporter/src/index.js";
import { buildEvaluationReport, evaluationScoringProfileSchema, evaluationSuiteSchema, formatEvaluationReport } from "./index.js";

const suite = evaluationSuiteSchema.parse({
  version: 1,
  id: "comparison",
  name: "Comparison",
  workflow: "review-pr",
  cases: [{ id: "case-1", task: "Review it" }],
  variants: [
    { id: "fast", provider: "mock", model_tier: "fast" },
    { id: "reasoning", provider: "mock", model_tier: "reasoning" }
  ]
});

function qualityReport(runId: string, quality: number, latency: number, fallbacks = 0): CostQualityReport {
  return {
    runId,
    workflowId: "review-pr",
    task: "Review it",
    status: "completed",
    projectName: "fixture",
    totalStages: 1,
    routedStages: 1,
    fallbackCount: fallbacks,
    qualityPassCount: quality >= 0.7 ? 1 : 0,
    qualityFailCount: quality >= 0.7 ? 0 : 1,
    averageQuality: quality,
    totalLatencyMs: latency,
    averageLatencyMs: latency,
    estimatedCostMix: { none: 1 },
    providerMix: { mock: 1 },
    modelTierMix: { fast: 1 },
    estimatedByoSavingsStages: 1,
    feedback: { counts: {}, latest: null, items: [] },
    stages: [],
    recommendations: []
  };
}

test("evaluation ranks passing quality ahead of faster failing output", () => {
  const report = buildEvaluationReport(suite, [
    { caseId: "case-1", variantId: "fast", runId: "run-fast", report: qualityReport("run-fast", 0.6, 10) },
    { caseId: "case-1", variantId: "reasoning", runId: "run-reasoning", report: qualityReport("run-reasoning", 0.9, 30) }
  ]);
  assert.equal(report.winner, "reasoning");
  assert.equal(report.rows.find((row) => row.variantId === "fast")?.passed, false);
  assert.match(formatEvaluationReport(report), /Variant comparison/);
});

test("evaluation expectations include fallback limits", () => {
  const report = buildEvaluationReport(suite, [
    { caseId: "case-1", variantId: "fast", runId: "run-fast", report: qualityReport("run-fast", 0.9, 10, 1) }
  ]);
  assert.equal(report.rows[0].passed, false);
  assert.match(report.rows[0].failures.join(" "), /fallbacks/);
});

test("private scoring weights change ranking without entering the report", () => {
  const profile = evaluationScoringProfileSchema.parse({
    version: 1,
    id: "product-fit-v1",
    weights: { pass_rate: 0, quality: 0, latency: 2 }
  });
  const report = buildEvaluationReport(suite, [
    { caseId: "case-1", variantId: "fast", runId: "run-fast", report: qualityReport("run-fast", 0.8, 10) },
    { caseId: "case-1", variantId: "reasoning", runId: "run-reasoning", report: qualityReport("run-reasoning", 0.9, 30000) }
  ], { profile, checksum: "abc123" });

  assert.equal(report.winner, "fast");
  assert.deepEqual(report.scoringProfile, { id: "product-fit-v1", checksum: "abc123" });
  assert.equal("weights" in (report.scoringProfile ?? {}), false);
});

test("private case priorities influence product ranking", () => {
  const weightedSuite = evaluationSuiteSchema.parse({
    version: 1,
    id: "product-cases",
    name: "Product cases",
    workflow: "review-pr",
    cases: [{ id: "critical", task: "Critical" }, { id: "edge", task: "Edge" }],
    variants: [{ id: "a", provider: "mock", model_tier: "fast" }, { id: "b", provider: "mock", model_tier: "fast" }]
  });
  const profile = evaluationScoringProfileSchema.parse({
    id: "private",
    weights: { pass_rate: 0, quality: 1 },
    case_weights: { critical: 10, edge: 1 }
  });
  const report = buildEvaluationReport(weightedSuite, [
    { caseId: "critical", variantId: "a", runId: "a1", report: qualityReport("a1", 1, 10) },
    { caseId: "edge", variantId: "a", runId: "a2", report: qualityReport("a2", 0.1, 10) },
    { caseId: "critical", variantId: "b", runId: "b1", report: qualityReport("b1", 0.6, 10) },
    { caseId: "edge", variantId: "b", runId: "b2", report: qualityReport("b2", 1, 10) }
  ], { profile, checksum: "private" });
  assert.equal(report.winner, "a");
});
