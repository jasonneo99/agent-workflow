import assert from "node:assert/strict";
import test from "node:test";
import { buildEvaluationGateReport, evaluationGateSchema } from "./index.js";
import type { CostQualityReport } from "../../run-reporter/src/index.js";

const baseReport: CostQualityReport = {
  runId: "candidate",
  workflowId: "review-pr",
  task: "Review changes",
  status: "completed",
  projectName: "Example",
  totalStages: 2,
  routedStages: 2,
  fallbackCount: 0,
  qualityPassCount: 2,
  qualityFailCount: 0,
  averageQuality: 0.82,
  totalLatencyMs: 1200,
  averageLatencyMs: 600,
  estimatedCostMix: { low: 1, medium: 1 },
  providerMix: { byo: 1, openai: 1 },
  modelTierMix: { fast: 1, standard: 1 },
  estimatedByoSavingsStages: 1,
  feedback: { counts: {}, latest: null, items: [] },
  stages: [
    {
      stageId: "inspect",
      agentId: "technical-architect",
      providerId: "byo",
      modelTier: "fast",
      requestedModelTier: "fast",
      estimatedCostTier: "low",
      qualityScore: 0.8,
      qualityPassed: true,
      fallbackUsed: false,
      latencyMs: 500,
      reasons: []
    },
    {
      stageId: "review",
      agentId: "security-reviewer",
      providerId: "openai",
      modelTier: "standard",
      requestedModelTier: "standard",
      estimatedCostTier: "medium",
      qualityScore: 0.84,
      qualityPassed: true,
      fallbackUsed: false,
      latencyMs: 700,
      reasons: []
    }
  ],
  recommendations: []
};

test("evaluation gate passes healthy run thresholds", () => {
  const gate = evaluationGateSchema.parse({
    id: "local",
    thresholds: {
      minimum_average_quality: 0.8,
      maximum_fallbacks: 0,
      maximum_average_latency_ms: 1000,
      maximum_high_cost_stages: 0
    }
  });
  const report = buildEvaluationGateReport({ gate, candidate: baseReport });
  assert.equal(report.passed, true);
});

test("evaluation gate fails threshold violations", () => {
  const gate = evaluationGateSchema.parse({
    id: "strict",
    thresholds: {
      minimum_average_quality: 0.9,
      maximum_fallbacks: 0
    }
  });
  const report = buildEvaluationGateReport({
    gate,
    candidate: { ...baseReport, fallbackCount: 1 }
  });
  assert.equal(report.passed, false);
  assert.deepEqual(report.checks.filter((check) => !check.passed).map((check) => check.id), [
    "minimum_average_quality",
    "maximum_fallbacks"
  ]);
});

test("evaluation gate checks baseline regression budgets", () => {
  const gate = evaluationGateSchema.parse({
    id: "baseline",
    regression_budgets: {
      maximum_quality_drop: 0.05,
      maximum_average_latency_increase_ms: 100,
      maximum_fallback_increase: 0
    }
  });
  const report = buildEvaluationGateReport({
    gate,
    baseline: { ...baseReport, runId: "baseline", averageQuality: 0.9, averageLatencyMs: 550 },
    candidate: { ...baseReport, averageQuality: 0.82, averageLatencyMs: 800, fallbackCount: 1 }
  });
  assert.equal(report.passed, false);
  assert.deepEqual(report.checks.filter((check) => !check.passed).map((check) => check.id), [
    "maximum_quality_drop",
    "maximum_average_latency_increase_ms",
    "maximum_fallback_increase"
  ]);
});
