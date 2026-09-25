import assert from "node:assert/strict";
import test from "node:test";
import { buildModelRouteReceiptContent } from "./model-route-receipt.js";

test("model route receipts enrich measured usage and preserve routing", () => {
  const receipt = buildModelRouteReceiptContent({
    workflowId: "build-feature", stageId: "implement", agentId: "implementation-agent",
    route: { providerId: "openai", modelTier: "reasoning" }, fallbackUsed: false, latencyMs: 12,
    stagePattern: { type: "executor" }, quality: { passed: true },
    actualModel: "gpt-5.6-sol",
    output: { summary: "done", artifact: {}, usage: { inputTokens: 1200, outputTokens: 100, totalTokens: 1300 } }
  });
  assert.deepEqual(receipt.usage, {
    inputTokens: 1200,
    outputTokens: 100,
    totalTokens: 1300,
    costUsd: 0.0068,
    costSource: "catalog-estimate",
    pricingVersion: "2026-09-25"
  });
  assert.equal(receipt.actualProviderId, "openai");
  assert.deepEqual(receipt.route, { providerId: "openai", modelTier: "reasoning" });
});
