import assert from "node:assert/strict";
import test from "node:test";
import { buildGovernedReusePlan, buildReuseFingerprint, semanticSimilarity } from "./index.js";

const target = {
  task: "Build a governed workflow reuse layer with cached evidence",
  workflowId: "build-feature",
  workflowHash: "workflow-v1",
  policySnapshotHash: "policy-v1",
  selectedSources: [{ sourceUri: "src/reuse.ts", contentHash: "source-v1" }]
};

test("fingerprints are stable across task wording order and source ordering", () => {
  const first = buildReuseFingerprint({ ...target, selectedSources: [...target.selectedSources, { sourceUri: "src/a.ts", contentHash: "a" }] });
  const second = buildReuseFingerprint({ ...target, task: "cached evidence with a governed workflow reuse layer build", selectedSources: [{ sourceUri: "src/a.ts", contentHash: "a" }, ...target.selectedSources] });
  assert.equal(first.fingerprint, second.fingerprint);
});

test("exact current completed evidence recommends approval-gated result reuse", () => {
  const plan = buildGovernedReusePlan({
    target,
    candidates: [{ runId: "run-1", ...target, completedStages: ["plan", "implement", "verify"], totalStages: 3, startedAt: new Date(0).toISOString(), finishedAt: new Date(10_000).toISOString(), compiledBriefTokens: 900, estimatedCostUsd: 0.12 }]
  });
  assert.equal(plan.recommendation, "reuse-result");
  assert.equal(plan.requiresApproval, true);
  assert.deepEqual(plan.candidates[0].projectedSavings, { stages: 3, tokens: 900, latencyMs: 10000, costUsd: 0.12 });
});

test("changed source evidence forces a fresh run", () => {
  const plan = buildGovernedReusePlan({
    target,
    candidates: [{ runId: "run-2", ...target, selectedSources: [{ sourceUri: "src/reuse.ts", contentHash: "old" }], completedStages: ["plan", "implement"], totalStages: 3, startedAt: new Date(0).toISOString(), finishedAt: new Date(5_000).toISOString() }]
  });
  assert.equal(plan.recommendation, "run-fresh");
  assert.match(plan.candidates[0].staleReasons.join(" "), /source evidence changed/u);
});

test("similar current work can recommend checkpoint continuation", () => {
  const plan = buildGovernedReusePlan({
    target,
    candidates: [{ runId: "run-3", ...target, completedStages: ["plan", "implement"], totalStages: 4, startedAt: new Date(0).toISOString(), finishedAt: new Date(20_000).toISOString() }]
  });
  assert.equal(plan.recommendation, "resume-from-stage");
  assert.equal(plan.candidates[0].resumeAfterStage, "implement");
});

test("memory ranking uses deterministic semantic similarity", () => {
  assert.ok(semanticSimilarity("repair failed workflow leases", "fix a workflow lease failure") > semanticSimilarity("repair failed workflow leases", "design a colorful landing page"));
  const plan = buildGovernedReusePlan({ target, candidates: [], memory: [
    { sourceUri: "memory/reuse", kind: "orchestration_memory", summary: "Implemented governed workflow reuse and cached evidence", updatedAt: new Date().toISOString() },
    { sourceUri: "memory/unrelated", kind: "run_feedback", summary: "Prefer purple marketing illustrations", updatedAt: new Date().toISOString() }
  ] });
  assert.equal(plan.memory[0].sourceUri, "memory/reuse");
});

test("repair lesson consumption requires verified reinforcement before ranking", () => {
  const base = { sourceUri: "memory/repair", kind: "workflow_repair_learning", summary: target.task, updatedAt: new Date(0).toISOString() };
  for (const gates of [{}, { acceptanceVerified: false, outcome: "reinforce" }, { acceptanceVerified: true, outcome: "avoid" }, { acceptanceVerified: true, outcome: "observe" }, { acceptanceVerified: true }]) {
    const plan = buildGovernedReusePlan({ target, candidates: [], memory: [{ ...base, ...gates }] });
    assert.deepEqual(plan.memory, []);
  }
  const accepted = { ...base, acceptanceVerified: true, outcome: "reinforce" };
  const plan = buildGovernedReusePlan({ target, candidates: [], memory: [accepted], maxMemory: 1 });
  assert.equal(plan.memory[0]?.sourceUri, accepted.sourceUri);
  assert.equal(plan.recommendation, "run-fresh");
  assert.deepEqual(buildGovernedReusePlan({ target, candidates: [], memory: [{ ...base, kind: "orchestration_memory" }] }).memory.map((item) => item.sourceUri), [base.sourceUri]);
});
