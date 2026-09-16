import assert from "node:assert/strict"; import test from "node:test";
import { buildCostOpportunities, buildEvaluationGaps, buildFailurePatterns, buildProposalPreview, selectFailedRuns, summarizeRouteFeedback } from "./index.js";
test("learning evidence helpers aggregate all six report domains", () => { const runs = [{ id: "1", workflowId: "build", task: "x", startedAt: "2026-01-01", status: "failed" }]; assert.equal(selectFailedRuns(runs).length, 1); assert.equal(buildFailurePatterns([{ stageId: "test", failedTasks: 1, totalTasks: 2 }], () => ({ workflowId: "build", agentId: "tester" }))[0].failureRate, .5); assert.equal(buildCostOpportunities([{ workflowId: "b", stageId: "s", agentId: "a", providerId: "p", modelTier: "fast", runs: 1, fallbackRate: 1, averageLatencyMs: 2, recommendation: "Review", feedbackScore: 0 }]).length, 1); assert.equal(summarizeRouteFeedback([{ workflowId: "b", stageId: "s", agentId: "a", providerId: "p", modelTier: "fast", routeClass: "hosted", rating: "costly", createdAt: "2026-01-01" }]).costlyGroups.length, 1); assert.equal(buildEvaluationGaps({ runs: 1, feedbackCount: 0, evaluationRuns: 0, failedRuns: 1, failurePatterns: 0, feedbackNeeded: false }).length, 3); assert.deepEqual(buildProposalPreview([{ kind: "routing", priority: "high" }]), { total: 1, highPriority: 1, byKind: { routing: 1 } }); });

test("learning failure selection excludes evaluation evidence and dismissed failures", () => {
  const common = { workflowId: "provider-smoke", task: "compare", startedAt: "2026-01-01", status: "failed" };
  assert.deepEqual(selectFailedRuns([
    { ...common, id: "evaluation", evaluationMetadata: { suiteId: "fleet-comparison" } },
    { ...common, id: "dismissed", dismissed: true },
    { ...common, id: "actionable" }
  ]).map((run) => run.runId), ["actionable"]);
});
