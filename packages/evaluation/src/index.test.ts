import assert from "node:assert/strict";
import test from "node:test";
import type { CostQualityReport } from "../../run-reporter/src/index.js";
import { buildEvaluationReport, evaluationSuiteSchema, formatEvaluationReport } from "./index.js";

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
