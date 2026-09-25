import assert from "node:assert/strict";
import test from "node:test";
import { renderPreferenceScorecardHtml } from "./outcome-accuracy.js";

test("outcome accuracy dashboard separates completion from accepted results", () => {
  const html = renderPreferenceScorecardHtml({
    projectRootUri: "/project", runsAnalyzed: 2, feedbackCounts: { accepted: 1, revised: 1 }, recommendations: ["Tune implementation."],
    outcomeAccuracy: { runs: 2, completed: 2, completionRate: 1, rated: 2, feedbackCoverage: 1, accepted: 1, revised: 1, rejected: 0, expectedResultRate: 0.5, firstPassAccepted: 1, firstPassRate: 1, missingOutcomeEvidence: 0, qualityMismatch: 1, fallbackRuns: 0 },
    groups: [{ key: "w|s|a|p|standard", workflowId: "w", stageId: "s", agentId: "a", providerId: "p", modelTier: "standard", runs: 2, accepted: 1, revised: 1, rejected: 0, feedbackScore: 0.675, outcomeAccuracy: 0.5, calibratedQuality: 0.6, feedbackCoverage: 1, averageQuality: 1, fallbackRate: 0, averageLatencyMs: 31_000, latencyBudgetMs: 30_000, latencyBudgetPassed: false, feedbackRequested: true, recommendation: "Tune." }]
  });
  assert.match(html, /Expected Result[\s\S]+50%/u);
  assert.match(html, /Quality Mismatch[\s\S]+over budget/u);
  assert.doesNotMatch(html, /<script/u);
});
