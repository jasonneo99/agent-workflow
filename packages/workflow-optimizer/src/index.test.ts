import test from "node:test";
import assert from "node:assert/strict";
import { canSchedule, createJarvisIntent, fleetHealth, optimizationReceipt, rankRecommendations, sharedBrainSummary, shouldWake, simulateRecommendation } from "./index.js";

test("event wakeups deduplicate and budgets enforce quiet hours and backpressure", () => {
  assert.equal(shouldWake({ id: "e1", kind: "run.completed", projectId: "p", occurredAt: "now" }, new Set()), true);
  assert.equal(canSchedule({ projectId: "p", maxActions: 2, consumedActions: 0, queueDepth: 2 }, 12).reason, "backpressure");
  assert.equal(canSchedule({ projectId: "p", maxActions: 4, consumedActions: 0, queueDepth: 0, quietHours: { start: 22, end: 7 } }, 23).reason, "quiet hours");
});

test("recommendations are explainably ranked, shadowed, receipted, and summarized", () => {
  const ranked = rankRecommendations([{ id: "r", projectId: "p", kind: "handoff", evidence: 1, impact: .8, reversibility: 1, risk: "low", confidence: .9 }]);
  assert.equal(simulateRecommendation(ranked[0], [.1, .2, .3]).promotable, true);
  assert.equal(optimizationReceipt({ recommendationId: "r", action: "rollback", beforeHash: "a", afterHash: "b" }).receiptId.length, 64);
  assert.equal(fleetHealth([{ projectId: "p", maxActions: 4, consumedActions: 1, queueDepth: 0 }], ranked, 0).status, "healthy");
});

test("Jarvis intents are non-executable and summaries exclude raw memory", () => {
  const intent = createJarvisIntent({ requestId: "r", conversationId: "c", goal: "build", requestedAutonomy: "propose", createdAt: "now" });
  assert.equal(intent.executable, false);
  assert.equal(sharedBrainSummary({ activeGoals: [], recentDecisions: [], openApprovalCount: 1, learnedPreferenceCount: 2, degradedServices: [] }).rawMemoryIncluded, false);
});
