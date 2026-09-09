import assert from "node:assert/strict";
import test from "node:test";
import { buildSavingsAwareLocalRoutingRecommendations, summarizeLocalRoutingFeedbackForGroup } from "./local-routing-recommendations.js";

const hostedFastGroup = {
  workflowId: "build-feature",
  stageId: "verify",
  agentId: "auto-test-runner",
  providerId: "openai",
  modelTier: "fast",
  classification: "hosted-selected" as const,
  runs: 2,
  fallbackCount: 0,
  averageLatencyMs: 900,
  averageQuality: 0.76
};

test("helpful route feedback strengthens eligible fast hosted stages for local expansion", () => {
  const recommendations = buildSavingsAwareLocalRoutingRecommendations({
    routeGroups: [hostedFastGroup],
    netEstimatedSavingsUsd: 0.42,
    storagePressure: false,
    routeFeedbackEvents: [
      { rating: "helpful", workflowId: "build-feature", stageId: "verify", agentId: "auto-test-runner", providerId: "openai", modelTier: "fast", routeClass: "hosted-selected" },
      { rating: "helpful", workflowId: "build-feature", stageId: "verify", agentId: "auto-test-runner", providerId: "openai", modelTier: "fast", routeClass: "hosted-selected" }
    ]
  });

  assert.equal(recommendations.length, 1);
  assert.equal(recommendations[0].action, "expand");
  assert.equal(recommendations[0].priority, "medium");
  assert.deepEqual(recommendations[0].routeFeedback, {
    helpful: 2,
    costly: 0,
    neutral: 0,
    total: 2
  });
  assert.match(recommendations[0].reasons.join(" "), /helpful feedback strengthens/u);
});

test("costly route feedback blocks local expansion for matching skipped or hosted groups", () => {
  const recommendations = buildSavingsAwareLocalRoutingRecommendations({
    routeGroups: [{ ...hostedFastGroup, averageQuality: 0.91, runs: 4 }],
    netEstimatedSavingsUsd: 1.2,
    storagePressure: false,
    routeFeedbackEvents: [
      { rating: "costly", workflowId: "build-feature", stageId: "verify", agentId: "auto-test-runner", providerId: "openai", modelTier: "fast", routeClass: "hosted-selected" },
      { rating: "costly", workflowId: "build-feature", stageId: "verify", agentId: "auto-test-runner", providerId: "openai", modelTier: "fast", routeClass: "hosted-selected" }
    ]
  });

  assert.equal(recommendations[0].action, "hold");
  assert.equal(recommendations[0].priority, "medium");
  assert.match(recommendations[0].reasons.join(" "), /blocks local expansion/u);
});

test("costly route feedback recommends retreat for matching active local groups", () => {
  const recommendations = buildSavingsAwareLocalRoutingRecommendations({
    routeGroups: [{
      ...hostedFastGroup,
      providerId: "local",
      classification: "local-selected",
      averageQuality: 0.92,
      runs: 4
    }],
    netEstimatedSavingsUsd: 1.2,
    storagePressure: false,
    routeFeedbackEvents: [
      { rating: "costly", workflowId: "build-feature", stageId: "verify", agentId: "auto-test-runner", providerId: "local", modelTier: "fast", routeClass: "local-selected" },
      { rating: "costly", workflowId: "build-feature", stageId: "verify", agentId: "auto-test-runner", providerId: "local", modelTier: "fast", routeClass: "local-selected" }
    ]
  });

  assert.equal(recommendations[0].action, "retreat");
  assert.equal(recommendations[0].priority, "high");
  assert.match(recommendations[0].reasons.join(" "), /marked this local route as costly/u);
});

test("route feedback only matches the exact route decision group", () => {
  const summary = summarizeLocalRoutingFeedbackForGroup([
    { rating: "helpful", workflowId: "build-feature", stageId: "verify", agentId: "auto-test-runner", providerId: "openai", modelTier: "fast", routeClass: "hosted-selected" },
    { rating: "costly", workflowId: "build-feature", stageId: "plan", agentId: "technical-architect", providerId: "openai", modelTier: "fast", routeClass: "hosted-selected" }
  ], hostedFastGroup);

  assert.deepEqual(summary, {
    helpful: 1,
    costly: 0,
    neutral: 0,
    total: 1
  });
});
