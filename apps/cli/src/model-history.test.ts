import assert from "node:assert/strict";
import test from "node:test";
import type { CostQualityReport } from "../../../packages/run-reporter/src/index.js";
import { buildDashboardModelHistory } from "./lib/builders-learning.js";

function report(model: string, quality: number | null, latencyMs: number | null): CostQualityReport {
  return {
    runId: model, workflowId: "test", task: "test", status: "completed", projectName: "test",
    totalStages: 1, routedStages: 1, fallbackCount: 0, qualityPassCount: quality === null ? 0 : 1,
    qualityFailCount: 0, averageQuality: quality, totalLatencyMs: latencyMs ?? 0, averageLatencyMs: latencyMs,
    estimatedCostMix: {}, providerMix: { openai: 1 }, modelTierMix: { standard: 1 }, estimatedByoSavingsStages: 0,
    feedback: { counts: {}, latest: null, items: [] }, recommendations: [],
    stages: [{ stageId: "one", agentId: "test", providerId: "openai", model, modelTier: "standard", requestedModelTier: "standard", estimatedCostTier: "medium", qualityScore: quality, qualityPassed: quality === null ? null : true, fallbackUsed: false, latencyMs, reasons: [] }]
  };
}

test("model history aggregates every model into selectable calendar buckets", () => {
  const reports = [
    { startedAt: "2026-09-01T03:00:00.000Z", report: report("gpt-a", 0.8, 100) },
    { startedAt: "2026-09-01T15:00:00.000Z", report: report("gpt-a", 1, 200) },
    { startedAt: "2026-10-05T15:00:00.000Z", report: report("gpt-b", 0.7, 50) }
  ];
  const daily = buildDashboardModelHistory({ reports, bucket: "day", range: "all" });
  assert.equal(daily.models.length, 2);
  assert.equal(daily.points.length, 2);
  assert.equal(daily.models.find((item) => item.model === "gpt-a")?.averageQuality, 0.9);
  assert.equal(daily.models.find((item) => item.model === "gpt-a")?.averageLatencyMs, 150);
  const monthly = buildDashboardModelHistory({ reports, bucket: "month", range: "all" });
  assert.deepEqual(monthly.points.map((item) => item.bucketStart), ["2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
});

test("model history range filtering is based on the selected window", () => {
  const result = buildDashboardModelHistory({
    reports: [
      { startedAt: "2026-10-01T00:00:00.000Z", report: report("old", 1, 10) },
      { startedAt: "2026-10-19T00:00:00.000Z", report: report("new", 1, 10) }
    ],
    bucket: "hour", range: "7d", now: new Date("2026-10-20T00:00:00.000Z")
  });
  assert.deepEqual(result.models.map((item) => item.model), ["new"]);
});

test("model history supports minute buckets and exact start and end dates", () => {
  const result = buildDashboardModelHistory({
    reports: [
      { startedAt: "2026-10-20T10:01:30.000Z", report: report("early", 1, 10) },
      { startedAt: "2026-10-20T10:02:30.000Z", report: report("inside", 0.9, 20) },
      { startedAt: "2026-10-20T10:03:30.000Z", report: report("late", 0.8, 30) }
    ],
    bucket: "minute", range: "1h", from: "2026-10-20T10:02:00.000Z", to: "2026-10-20T10:03:00.000Z"
  });
  assert.deepEqual(result.models.map((item) => item.model), ["inside"]);
  assert.equal(result.points[0]?.bucketStart, "2026-10-20T10:02:00.000Z");
  assert.equal(result.windowFrom, "2026-10-20T10:02:00.000Z");
  assert.equal(result.windowTo, "2026-10-20T10:03:00.000Z");
});
