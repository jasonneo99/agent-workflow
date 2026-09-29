import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildAgentImprovementCandidate,
  buildAgentImprovementEval,
  buildAgentImprovementPromotionQueue,
  buildGroundedAgentImprovementRationale,
  buildUnifiedDiff,
  canonicalizeAgentImprovementYaml,
  countAgentImprovementPendingPromotions,
  decideAgentImprovementPromotions,
  loadOutcomeWeights,
  renderAgentImprovementPendingBannerHtml
} from "./index.js";

async function makeProjectDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeEvalProject(): Promise<{ projectDir: string; sourcePath: string; sourceHash: string }> {
  const projectDir = await makeProjectDir("agentflow-ai-eval-");
  const sourcePath = ".agent-workflow/agents/test-agent.yaml";
  const content = "id: test-agent\ndisplay_name: Test Agent\n";
  await fs.mkdir(path.join(projectDir, ".agent-workflow", "agents"), { recursive: true });
  await fs.writeFile(path.join(projectDir, sourcePath), content, "utf8");
  return { projectDir, sourcePath, sourceHash: createHash("sha256").update(content).digest("hex") };
}

function makePatch(input: { sourcePath: string; sourceHash: string; unifiedDiff: string }): any {
  return {
    id: "patch-agent-test-agent-improvement",
    candidateId: "agent-test-agent-improvement",
    agentId: "test-agent",
    displayName: "Test Agent",
    scope: "project-local",
    sourcePath: input.sourcePath,
    sourceHash: input.sourceHash,
    priority: "medium",
    riskLevel: "low",
    approvalRequired: false,
    autoApplyEligible: true,
    changedFields: ["prompt"],
    patternId: "missing-receipts",
    rationale: "Observed: Agent card does not explicitly require receipts. This patch proposes edits to prompt (+2/-0 canonical diff lines). Recommendation: Add receipt language.",
    validation: { schemaValid: true, errors: [] },
    unifiedDiff: input.unifiedDiff,
    proposedYaml: "id: test-agent\n",
    rollback: { restoreSourceHash: input.sourceHash, restorePath: input.sourcePath }
  } as never;
}

const evalRuns = [
  { id: "run-1", workflowId: "wf", task: "test-agent handled the prompt", status: "completed", startedAt: "2026-09-28T00:00:00.000Z" },
  { id: "run-2", workflowId: "wf", task: "test-agent second pass", status: "completed", startedAt: "2026-09-28T01:00:00.000Z" }
] as never;

const evalScorecard = { groups: [], feedbackCounts: { positive: 1 } } as never;

const semanticDiff = "--- a/x\n+++ b/x\n@@ full-file preview @@\n-a: 1\n+a: 2";

test("canonicalizeAgentImprovementYaml collapses serialization-only re-wrapping", () => {
  const raw = "purpose: Do things\nprompt: |\n  line one\n  line two\ncan:\n  - a\n  - b\n";
  const rewrapped = 'purpose: Do things\nprompt: "line one\\nline two\\n"\ncan: [a, b]\n';
  const canonicalRaw = canonicalizeAgentImprovementYaml(raw);
  const canonicalRewrapped = canonicalizeAgentImprovementYaml(rewrapped);
  assert.equal(canonicalRaw, canonicalRewrapped);
  assert.equal(buildUnifiedDiff("agents/x.yaml", canonicalRaw, canonicalRewrapped), "");
});

test("canonicalizeAgentImprovementYaml falls back to raw text when unparseable", () => {
  const broken = "a:\n\t- b\n";
  assert.equal(canonicalizeAgentImprovementYaml(broken), broken);
});

test("buildGroundedAgentImprovementRationale grounds the rationale in evidence and change", () => {
  const candidate = {
    evidence: ["3/12 recent task(s) failed in stages connected to this agent.", "Agent card does not explicitly require receipts."],
    recommendation: "Add stronger failure-mode handling."
  } as never;
  const rationale = buildGroundedAgentImprovementRationale(
    candidate,
    ["prompt", "outputs"],
    "--- a/x\n+++ b/x\n@@ full-file preview @@\n-a\n-b\n+c\n+d\n+e"
  );
  assert.ok(rationale.includes("3/12 recent task(s) failed"));
  assert.ok(rationale.includes("prompt, outputs"));
  assert.ok(rationale.includes("+3/-2"));
  assert.ok(rationale.includes("Add stronger failure-mode handling."));
});

test("semantic-change gate fails churn patches so they cannot reach pass", async () => {
  const { projectDir, sourcePath, sourceHash } = await makeEvalProject();
  const evaluation = await buildAgentImprovementEval(projectDir, makePatch({ sourcePath, sourceHash, unifiedDiff: "" }), evalRuns, evalScorecard);
  const gate = evaluation.gates.find((item) => item.id === "semantic-change");
  assert.ok(gate, "semantic-change gate present");
  assert.equal(gate.passed, false);
  assert.equal(gate.weight, 25);
  assert.ok(evaluation.score < 80, `churn patch scored ${evaluation.score}, must stay below the pass threshold`);
  assert.notEqual(evaluation.status, "pass");
  assert.equal(evaluation.promotionReady, false);
});

test("semantic-change gate passes patches with real canonical diffs", async () => {
  const { projectDir, sourcePath, sourceHash } = await makeEvalProject();
  const evaluation = await buildAgentImprovementEval(projectDir, makePatch({ sourcePath, sourceHash, unifiedDiff: semanticDiff }), evalRuns, evalScorecard);
  const gate = evaluation.gates.find((item) => item.id === "semantic-change");
  assert.ok(gate, "semantic-change gate present");
  assert.equal(gate.passed, true);
  assert.equal(evaluation.score, 100);
  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.promotionReady, true);
});

test("buildAgentImprovementCandidate assigns stable sorted pattern ids", () => {
  const agent = {
    id: "test-reviewer",
    display_name: "Test Reviewer",
    category: "operations",
    autonomy: "supervised",
    purpose: "Reviews work.",
    use_when: [],
    avoid_when: [],
    can: [],
    cannot: [],
    requires_approval: [],
    prompt: "Do the review work."
  } as never;
  const candidate = buildAgentImprovementCandidate({
    record: { agent, sourcePath: "agents/test-reviewer.yaml", scope: "shared" },
    workflowRefs: [],
    runs: [],
    scorecard: { groups: [], feedbackCounts: {} } as never,
    reports: [],
    stageHealth: [],
    outcomeWeights: new Map()
  });
  assert.ok(candidate);
  assert.equal(candidate.patternId, "missing-receipts+missing-validation+no-workflow-refs");
  assert.equal(candidate.outcomeWeight, 0.5);
  assert.equal(candidate.outcomeEvidence, null);
});

test("buildAgentImprovementCandidate attaches outcome weights when decisions exist", () => {
  const agent = {
    id: "test-reviewer",
    display_name: "Test Reviewer",
    category: "operations",
    autonomy: "supervised",
    purpose: "Reviews work.",
    use_when: [],
    avoid_when: [],
    can: [],
    cannot: [],
    requires_approval: [],
    prompt: "Do the review work."
  } as never;
  const candidate = buildAgentImprovementCandidate({
    record: { agent, sourcePath: "agents/test-reviewer.yaml", scope: "shared" },
    workflowRefs: [],
    runs: [],
    scorecard: { groups: [], feedbackCounts: {} } as never,
    reports: [],
    stageHealth: [],
    outcomeWeights: new Map([["missing-receipts+missing-validation+no-workflow-refs", { weight: 0.8, approvals: 4, rejections: 1 }]])
  });
  assert.ok(candidate);
  assert.equal(candidate.outcomeWeight, 0.8);
  assert.deepEqual(candidate.outcomeEvidence, { approvals: 4, rejections: 1 });
});

test("patternId propagates from patch to promotion item to decision receipt", async () => {
  const { projectDir, sourcePath, sourceHash } = await makeEvalProject();
  const patch = makePatch({ sourcePath, sourceHash, unifiedDiff: semanticDiff });
  const queue = buildAgentImprovementPromotionQueue(
    projectDir,
    { patches: [patch] } as never,
    {
      evaluations: [{
        id: `eval-${patch.id}`,
        patchId: patch.id,
        candidateId: patch.candidateId,
        agentId: patch.agentId,
        score: 95,
        promotionReady: true,
        autoApplyReady: false,
        rollback: { restoreSourceHash: "x", restorePath: "y", sourceHashCurrent: true }
      }]
    } as never,
    "all",
    undefined
  );
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].patternId, "missing-receipts");
  assert.equal(queue.items[0].status, "pending");
  const result = await decideAgentImprovementPromotions({ projectDir, queue, ids: "all", status: "approved", reviewer: "tester" });
  assert.equal(result.receipts.events.length, 1);
  assert.equal(result.receipts.events[0].patternId, "missing-receipts");
  assert.equal(result.queue.items[0].status, "approved");
});

test("loadOutcomeWeights is neutral on cold start", async () => {
  const weights = await loadOutcomeWeights(await makeProjectDir("agentflow-ai-cold-"));
  assert.equal(weights.size, 0);
});

test("loadOutcomeWeights applies Laplace smoothing per pattern", async () => {
  const projectDir = await makeProjectDir("agentflow-ai-warm-");
  await fs.mkdir(path.join(projectDir, ".agent-workflow", "learning"), { recursive: true });
  const events = [
    { status: "approved", patternId: "missing-receipts" },
    { status: "approved", patternId: "missing-receipts" },
    { status: "rejected", patternId: "missing-receipts" },
    { status: "deferred", patternId: "missing-receipts" },
    { status: "approved", patternId: "failing-stages" }
  ];
  await fs.writeFile(
    path.join(projectDir, ".agent-workflow", "learning", "agent-improvement-promotion-receipts.json"),
    JSON.stringify({ kind: "agentflow_agent_improvement_promotion_receipts", projectRootUri: projectDir, updatedAt: new Date().toISOString(), events }),
    "utf8"
  );
  const weights = await loadOutcomeWeights(projectDir);
  const entry = weights.get("missing-receipts");
  assert.ok(entry);
  assert.equal(entry.approvals, 2);
  assert.equal(entry.rejections, 1);
  assert.equal(entry.weight, (2 + 1) / (2 + 1 + 2));
  assert.equal(weights.get("failing-stages")?.weight, (1 + 1) / (1 + 0 + 2));
  assert.equal(weights.has("missing-validation"), false);
});

test("countAgentImprovementPendingPromotions counts undecided items only", async () => {
  const projectDir = await makeProjectDir("agentflow-ai-count-");
  await fs.mkdir(path.join(projectDir, ".agent-workflow", "learning"), { recursive: true });
  const items = ["pending", "pending", "deferred", "superseded", "rejected", "approved", "applied"].map((status, index) => ({ id: `p-${index}`, status }));
  await fs.writeFile(
    path.join(projectDir, ".agent-workflow", "learning", "agent-improvement-promotions.json"),
    JSON.stringify({ kind: "agentflow_agent_improvement_promotion_queue", items }),
    "utf8"
  );
  assert.deepEqual(await countAgentImprovementPendingPromotions(projectDir), { pending: 2, deferred: 1 });
  assert.equal(await countAgentImprovementPendingPromotions(path.join(projectDir, "missing")), null);
});

test("renderAgentImprovementPendingBannerHtml links pending promotions to the review view", () => {
  const html = renderAgentImprovementPendingBannerHtml({
    projects: [{ projectRootUri: "/tmp/proj", name: "Proj", pending: 2, deferred: 1, current: true }]
  });
  assert.match(html, /3 agent-improvement promotions awaiting review/);
  assert.ok(html.includes("/learning?project=%2Ftmp%2Fproj&amp;view=agent-improvements"), `banner links to review view: ${html}`);
});

test("renderAgentImprovementPendingBannerHtml renders nothing without pending work", () => {
  assert.equal(renderAgentImprovementPendingBannerHtml({ projects: [] }), "");
  assert.equal(renderAgentImprovementPendingBannerHtml(null), "");
});
