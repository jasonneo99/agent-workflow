import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildLearningProposalSet, formatLearningProposalMarkdown, formatLearningProposalSet, writeLearningProposalFiles } from "./index.js";
test("proposal generation preserves risk gates, stable ids, summaries, and formats", () => { const set = buildLearningProposalSet({ projectDir: "/portable/project", generatedAt: "2026-01-01", runsAnalyzed: 3, evaluationRuns: 0, repeatedFailurePatterns: [{ workflowId: "build", stageId: "test", agentId: "tester", failedTasks: 2, totalTasks: 3, failureRate: .667 }], costOpportunities: [], routeFeedback: { total: 0, counts: {}, latestAt: null, costlyGroups: [], helpfulGroups: [] }, evalGaps: ["Run evaluation coverage."], proposalPreview: { total: 0, highPriority: 0, byKind: {} } }); assert.deepEqual(set.proposals.map((p) => p.id), ["learn-001", "learn-002"]); assert.ok(set.proposals.every((p) => p.approvalRequired)); assert.match(formatLearningProposalSet(set), /Learning Proposals/); assert.match(formatLearningProposalMarkdown(set), /Evidence:/); });

test("proposal files are persisted under the project learning directory", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-learning-proposals-"));
  const proposalSet = buildLearningProposalSet({
    projectDir,
    generatedAt: "2026-01-01",
    runsAnalyzed: 0,
    evaluationRuns: 0,
    repeatedFailurePatterns: [],
    costOpportunities: [],
    routeFeedback: { total: 0, counts: {}, latestAt: null, costlyGroups: [], helpfulGroups: [] },
    evalGaps: [],
    proposalPreview: { total: 0, highPriority: 0, byKind: {} }
  });

  const files = await writeLearningProposalFiles(projectDir, proposalSet);
  assert.equal(files.directory, path.join(projectDir, ".agent-workflow", "learning"));
  assert.equal(JSON.parse(await fs.readFile(files.jsonPath, "utf8")).kind, "agentflow_learning_proposals");
  assert.match(await fs.readFile(files.markdownPath, "utf8"), /Agent Workflow Learning Proposals/);
});
