import assert from "node:assert/strict";
import test from "node:test";
import { deliveryMetrics } from "./delivery-metrics.js";

const runs = [{ id: "one", startedAt: "2026-01-01T00:00:00Z", status: "completed" }];
test("completion without acceptance never manufactures delivery or zero-cost measurements", () => {
  const metrics = deliveryMetrics(runs, [], []);
  assert.equal(metrics.verifiedDelivery, false);
  assert.equal(metrics.firstAttemptVerifiedSuccess, null);
  assert.equal(metrics.timeToVerifiedDeliveryMs, null);
  assert.equal(metrics.modelLatencyMs, null);
  assert.equal(metrics.unnecessaryRetries, null);
  for (const observation of [metrics.observedUnnecessaryRetries, metrics.observedFalseBlocks,
    metrics.observedApprovals, metrics.observedHumanInterventions, metrics.repeatedReadRequests,
    metrics.repeatedDiscoveryRequests, metrics.observedModelCalls]) {
    assert.equal(observation.coverage, "unknown");
    assert.equal(observation.count, null);
  }
});
test("metrics retain exact acceptance and repeated-discovery receipt references", () => {
  const receipts = ["a", "b"].map((id) => ({ id, runId: "one", actionType: "file_search", target: "source", createdAt: runs[0].startedAt, metadata: {} }));
  const metrics = deliveryMetrics(runs, receipts, [{ runId: "one", uri: "db://audit", accepted: true, createdAt: "2026-01-01T00:00:10Z" }]);
  assert.equal(metrics.firstAttemptVerifiedSuccess, true);
  assert.equal(metrics.timeToVerifiedDeliveryMs, 10000);
  assert.deepEqual(metrics.repeatedDiscoveryRequests, { coverage: "partial", count: 1, receiptIds: ["b"] });
  assert.equal(deliveryMetrics(runs, [], [{ runId: "other", uri: "db://other", accepted: true, createdAt: "2026-01-01T00:00:10Z" }]).verifiedDelivery, false);
});

test("observed model latency is deduplicated by invocation and never substituted for complete coverage", () => {
  const receipts = ["a", "b"].map((id) => ({ id, runId: "one", actionType: "model_route", target: "stage", createdAt: runs[0].startedAt,
    metadata: { attempts: [{ attemptId: "call", latencyMs: 12 }] } }));
  const metrics = deliveryMetrics(runs, receipts, []);
  assert.equal(metrics.observedModelCalls.count, 1);
  assert.equal(metrics.observedModelCalls.totalLatencyMs, 12);
  assert.equal(metrics.observedModelCalls.coverage, "partial");
  assert.equal(metrics.modelLatencyMs, null);
});

test("stale and foreign model observations cannot manufacture measurements", () => {
  const receipts = ["foreign", "stale"].map((id) => ({ id, runId: id === "foreign" ? "other" : "one", actionType: "model_route", target: "stage", createdAt: "2025-12-31T23:59:59Z", metadata: { attempts: [{ attemptId: "call", latencyMs: 12 }] } }));
  const metrics = deliveryMetrics(runs, receipts, [{ runId: "one", uri: "db://stale", accepted: true, createdAt: "2025-12-31T23:59:59Z" }]);
  assert.equal(metrics.observedModelCalls.count, null);
  assert.equal(metrics.verifiedDelivery, false);
});

test("equal invocation IDs in different runs retain both latency observations", () => {
  const metrics = deliveryMetrics([...runs, { ...runs[0], id: "two" }], ["one", "two"].map((runId) => ({ id: runId, runId, actionType: "model_route", target: "stage", createdAt: runs[0].startedAt, metadata: { attempts: [{ attemptId: "call", latencyMs: 12 }] } })), []);
  assert.equal(metrics.observedModelCalls.totalLatencyMs, 24);
});

test("audited delivery measurements retain concrete evidence without manufacturing complete totals", () => {
  const classifications = ["unnecessary_retry", "false_block", "approval", "human_intervention"];
  const receipts = classifications.map((classification) => ({ id: classification, runId: "one",
    actionType: "delivery_metric_audit", target: "synthetic", createdAt: runs[0].startedAt,
    metadata: { audited: true, classification, evidenceUri: `db://synthetic/${classification}` } }));
  const metrics = deliveryMetrics(runs, receipts, [{ runId: "one", uri: "db://synthetic/failed", accepted: false, createdAt: runs[0].startedAt }]);
  const observations = [metrics.observedUnnecessaryRetries, metrics.observedFalseBlocks, metrics.observedApprovals, metrics.observedHumanInterventions];
  observations.forEach((observation, index) => {
    assert.equal(observation.coverage, "partial");
    assert.equal(observation.count, 1);
    assert.deepEqual(observation.receiptIds, [classifications[index]]);
    assert.deepEqual(observation.evidenceUris, [`db://synthetic/${classifications[index]}`]);
  });
  assert.equal(metrics.verifiedDelivery, false);
  for (const total of [metrics.unnecessaryRetries, metrics.falseBlocks, metrics.approvals, metrics.humanInterventions]) assert.equal(total, null);
  assert.equal(deliveryMetrics(runs, receipts.map((receipt) => ({ ...receipt, metadata: { ...receipt.metadata, audited: false } })), []).observedApprovals.count, null);
});
