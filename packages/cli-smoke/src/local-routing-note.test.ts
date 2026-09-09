import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const rootDir = process.cwd();

async function createProjectWithRoutingNotePlan(): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-routing-note-"));
  const tuningDir = path.join(projectDir, ".agent-workflow", "tuning");
  await fs.mkdir(tuningDir, { recursive: true });
  await fs.writeFile(path.join(tuningDir, "local-routing-note-plan.json"), `${JSON.stringify({
    kind: "agentflow_local_llm_routing_note_plan",
    generatedAt: "2026-09-08T00:00:00.000Z",
    projectRootUri: projectDir,
    sourceRecommendationsGeneratedAt: "2026-09-08T00:00:00.000Z",
    selectedRecommendationIds: ["route-001"],
    skippedRecommendationIds: [],
    summary: ["1 reviewed local routing note prepared."],
    notes: [
      {
        id: "routing-note-route-001",
        recommendationId: "route-001",
        action: "expand",
        priority: "medium",
        workflowId: "build-feature",
        stageId: "document",
        agentId: "auto-docs-update",
        direction: "prefer_local_trial",
        targetFile: ".agent-workflow/tuning/routing-preferences.md",
        draftNote: "Trial local routing for build-feature/document with hosted fallback.",
        reasons: ["Fast-tier hosted work is eligible for a local trial."]
      }
    ]
  }, null, 2)}\n`, "utf8");
  return projectDir;
}

function runAgentflow(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "apps/cli/src/index.ts", ...args], {
    cwd: rootDir,
    encoding: "utf8"
  });
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fullFileDiffFromYaml(yaml: string): string {
  return [
    "--- a/.agent-workflow/agents/local-helper.yaml",
    "+++ b/.agent-workflow/agents/local-helper.yaml",
    "@@",
    ...yaml.trimEnd().split("\n").map((line) => `+${line}`)
  ].join("\n");
}

test("local routing note application requires approval before writes", async () => {
  const projectDir = await createProjectWithRoutingNotePlan();
  const result = runAgentflow(["apply-local-llm-routing-note-plan", "--project", projectDir, "--write"]);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /Refusing to write routing preferences without --approved/);
});

test("local routing note application writes receipts and skips duplicates", async () => {
  const projectDir = await createProjectWithRoutingNotePlan();
  const first = runAgentflow(["apply-local-llm-routing-note-plan", "--project", projectDir, "--approved", "--write"]);

  assert.equal(first.status, 0, first.stderr);
  const preferences = await fs.readFile(path.join(projectDir, ".agent-workflow", "tuning", "routing-preferences.md"), "utf8");
  assert.match(preferences, /agentflow-local-routing-note:routing-note-route-001/);
  assert.match(preferences, /Trial local routing for build-feature\/document/);

  const receiptPath = path.join(projectDir, ".agent-workflow", "tuning", "local-routing-note-application.json");
  const firstReceipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as {
    appliedNoteIds: string[];
    skippedNoteIds: string[];
    beforeHash: string;
    afterHash: string;
  };
  assert.deepEqual(firstReceipt.appliedNoteIds, ["routing-note-route-001"]);
  assert.deepEqual(firstReceipt.skippedNoteIds, []);
  assert.notEqual(firstReceipt.beforeHash, firstReceipt.afterHash);

  const second = runAgentflow(["apply-local-llm-routing-note-plan", "--project", projectDir, "--approved", "--write"]);

  assert.equal(second.status, 0, second.stderr);
  const secondReceipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as {
    appliedNoteIds: string[];
    skippedNoteIds: string[];
    beforeHash: string;
    afterHash: string;
  };
  assert.deepEqual(secondReceipt.appliedNoteIds, []);
  assert.deepEqual(secondReceipt.skippedNoteIds, ["routing-note-route-001"]);
  assert.equal(secondReceipt.beforeHash, secondReceipt.afterHash);
});

test("local route feedback writes project-local learning artifacts", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-route-feedback-"));
  const result = runAgentflow([
    "local-route-feedback",
    "--project", projectDir,
    "--workflow", "build-feature",
    "--stage", "verify",
    "--agent", "auto-test-runner",
    "--provider", "local",
    "--tier", "fast",
    "--class", "local-selected",
    "--rating", "helpful",
    "--note", "fast enough for low-risk verification",
    "--runs", "3",
    "--fallbacks", "0",
    "--quality", "0.91",
    "--latency-ms", "1200"
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Recorded helpful route feedback/);

  const jsonPath = path.join(projectDir, ".agent-workflow", "model-improvement", "route-decision-feedback.json");
  const markdownPath = path.join(projectDir, ".agent-workflow", "model-improvement", "route-decision-feedback.md");
  const log = JSON.parse(await fs.readFile(jsonPath, "utf8")) as {
    kind: string;
    events: Array<{
      rating: string;
      routeClass: string;
      workflowId: string;
      stageId: string;
      agentId: string;
      providerId: string;
      modelTier: string;
      runs: number;
      fallbackCount: number;
      averageQuality: number;
      averageLatencyMs: number;
    }>;
  };

  assert.equal(log.kind, "agentflow_route_decision_feedback");
  assert.equal(log.events.length, 1);
  assert.deepEqual(log.events[0], {
    ...log.events[0],
    rating: "helpful",
    routeClass: "local-selected",
    workflowId: "build-feature",
    stageId: "verify",
    agentId: "auto-test-runner",
    providerId: "local",
    modelTier: "fast",
    runs: 3,
    fallbackCount: 0,
    averageQuality: 0.91,
    averageLatencyMs: 1200
  });

  const markdown = await fs.readFile(markdownPath, "utf8");
  assert.match(markdown, /Agent Workflow Route Decision Feedback/);
  assert.match(markdown, /fast enough for low-risk verification/);
});

test("learning daemon applies route-feedback recommendation refresh with receipts", { timeout: 60_000 }, async (t) => {
  const doctor = runAgentflow(["doctor"]);
  if (doctor.status !== 0) {
    t.skip("Agent Workflow storage services are not reachable for daemon smoke coverage.");
    return;
  }

  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-route-feedback-daemon-"));
  for (const rating of ["costly", "costly"] as const) {
    const result = runAgentflow([
      "local-route-feedback",
      "--project", projectDir,
      "--workflow", "build-feature",
      "--stage", "verify",
      "--agent", "auto-test-runner",
      "--provider", "local",
      "--tier", "fast",
      "--class", "local-selected",
      "--rating", rating,
      "--note", "local verification route was slower than expected",
      "--runs", "4",
      "--fallbacks", "0",
      "--quality", "0.72",
      "--latency-ms", "12000"
    ]);
    assert.equal(result.status, 0, result.stderr);
  }

  const daemon = runAgentflow([
    "learning-daemon",
    "--project", projectDir,
    "--mode", "apply-approved",
    "--once",
    "--json"
  ]);
  assert.equal(daemon.status, 0, daemon.stderr);

  const proposals = await readJsonFile<{
    proposals: Array<{ kind: string; riskLevel: string; approvalRequired: boolean; title: string }>;
  }>(path.join(projectDir, ".agent-workflow", "learning", "proposals.json"));
  const routeFeedbackProposals = proposals.proposals.filter((proposal) => proposal.kind === "route_feedback");
  assert.equal(routeFeedbackProposals.length, 1);
  assert.equal(routeFeedbackProposals[0].riskLevel, "low");
  assert.equal(routeFeedbackProposals[0].approvalRequired, false);
  assert.match(routeFeedbackProposals[0].title, /costly route feedback/i);

  const recommendationsPath = path.join(projectDir, ".agent-workflow", "model-improvement", "local-llm-routing-recommendations.json");
  const recommendationMarkdownPath = path.join(projectDir, ".agent-workflow", "model-improvement", "local-llm-routing-recommendations.md");
  const recommendations = await readJsonFile<{
    kind: string;
    evidence: { routeFeedbackEvents: number; routeFeedbackCounts: Record<string, number> };
    summary: string[];
  }>(recommendationsPath);
  assert.equal(recommendations.kind, "agentflow_local_llm_routing_recommendations");
  assert.equal(recommendations.evidence.routeFeedbackEvents, 2);
  assert.equal(recommendations.evidence.routeFeedbackCounts.costly, 2);
  assert.ok(recommendations.summary.some((item) => /costly=2/i.test(item)));
  assert.match(await fs.readFile(recommendationMarkdownPath, "utf8"), /Route feedback: helpful=0, costly=2, neutral=0/);

  const autonomous = await readJsonFile<{
    appliedActions: number;
    skippedActions: number;
    filesWritten: string[];
    notes: string[];
  }>(path.join(projectDir, ".agent-workflow", "learning", "autonomous-application.json"));
  assert.ok(autonomous.appliedActions >= 1);
  assert.ok(autonomous.skippedActions >= 0);
  assert.ok(autonomous.filesWritten.includes(".agent-workflow/model-improvement/local-llm-routing-recommendations.json"));
  assert.ok(autonomous.notes.some((note) => /route feedback/i.test(note)));

  const receipts = await readJsonFile<{
    events: Array<{ status: string; actionType: string; note: string; writesOwnedLearningStateOnly: boolean }>;
  }>(path.join(projectDir, ".agent-workflow", "learning", "action-receipts.json"));
  assert.ok(receipts.events.some((event) =>
    event.status === "applied" &&
    event.actionType === "refresh_routing_recommendations" &&
    event.note === "autonomous local apply tick" &&
    event.writesOwnedLearningStateOnly
  ));
});

test("agent improvement apply can autonomously apply only project-local auto-ready promotions", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-agent-auto-apply-"));
  const learningDir = path.join(projectDir, ".agent-workflow", "learning");
  const agentsDir = path.join(projectDir, ".agent-workflow", "agents");
  await fs.mkdir(learningDir, { recursive: true });
  await fs.mkdir(agentsDir, { recursive: true });

  const sourceYaml = [
    "id: local-helper",
    "display_name: Local Helper",
    "category: development",
    "purpose: Help with local project tasks.",
    "model_strategy: provider-agnostic",
    "model_tier: fast",
    "autonomy: 1",
    "use_when:",
    "  - local edits",
    "avoid_when:",
    "  - shared workflow changes",
    "can:",
    "  - inspect_project",
    "cannot: []",
    "requires_approval: []",
    "context_budget:",
    "  max_tokens: 1000",
    "  preferred_sources:",
    "    - AGENTS.md",
    "outputs:",
    "  schema: notes",
    "prompt: >",
    "  Help with local project tasks."
  ].join("\n") + "\n";
  const proposedYaml = sourceYaml.replace("  - inspect_project\n", "  - inspect_project\n  - summarize_findings\n");
  const sourceHash = sha256(sourceYaml);
  await fs.writeFile(path.join(agentsDir, "local-helper.yaml"), sourceYaml, "utf8");

  const queue = {
    kind: "agentflow_agent_improvement_promotion_queue",
    generatedAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    projectRootUri: projectDir,
    sourceEvalPlanGeneratedAt: "2026-09-09T00:00:00.000Z",
    selectedIds: ["eval-patch-local-helper"],
    skippedIds: [],
    summary: ["1 promotion-ready agent improvement patch queued."],
    items: [
      {
        id: "promotion-patch-local-helper",
        patchId: "patch-local-helper",
        evalId: "eval-patch-local-helper",
        candidateId: "candidate-local-helper",
        agentId: "local-helper",
        displayName: "Local Helper",
        scope: "project-local",
        status: "pending",
        createdAt: "2026-09-09T00:00:00.000Z",
        decidedAt: null,
        reviewer: null,
        note: null,
        score: 95,
        promotionReady: true,
        autoApplyReady: true,
        priority: "medium",
        riskLevel: "low",
        sourcePath: ".agent-workflow/agents/local-helper.yaml",
        sourceHash,
        diff: fullFileDiffFromYaml(proposedYaml),
        rollback: {
          restorePath: ".agent-workflow/agents/local-helper.yaml",
          restoreHash: sourceHash,
          sourceHashCurrent: true
        },
        approvalRequired: false,
        recommendation: "Eligible for project-local auto-apply.",
        rationale: "Low-risk local agent capability refinement."
      },
      {
        id: "promotion-patch-shared-helper",
        patchId: "patch-shared-helper",
        evalId: "eval-patch-shared-helper",
        candidateId: "candidate-shared-helper",
        agentId: "shared-helper",
        displayName: "Shared Helper",
        scope: "shared",
        status: "approved",
        createdAt: "2026-09-09T00:00:00.000Z",
        decidedAt: "2026-09-09T00:00:00.000Z",
        reviewer: "test",
        note: "approved fixture",
        score: 95,
        promotionReady: true,
        autoApplyReady: true,
        priority: "medium",
        riskLevel: "low",
        sourcePath: "agents/development/shared-helper.yaml",
        sourceHash,
        diff: fullFileDiffFromYaml(proposedYaml),
        rollback: {
          restorePath: "agents/development/shared-helper.yaml",
          restoreHash: sourceHash,
          sourceHashCurrent: true
        },
        approvalRequired: true,
        recommendation: "Manual shared promotion fixture.",
        rationale: "Shared agents should not apply through project-local auto mode."
      }
    ],
    ownedLearningFiles: [
      ".agent-workflow/learning/agent-improvement-promotions.json",
      ".agent-workflow/learning/agent-improvement-promotions.md",
      ".agent-workflow/learning/agent-improvement-promotion-receipts.json",
      ".agent-workflow/learning/agent-improvement-promotion-receipts.md"
    ]
  };
  await fs.writeFile(path.join(learningDir, "agent-improvement-promotions.json"), `${JSON.stringify(queue, null, 2)}\n`, "utf8");

  const result = runAgentflow([
    "agent-improvement-apply",
    "--project", projectDir,
    "--project-local-auto-ready",
    "--write",
    "--json"
  ]);

  assert.equal(result.status, 0, result.stderr);
  const applyResult = JSON.parse(result.stdout) as { appliedIds: string[]; selectedIds: string[] };
  assert.deepEqual(applyResult.selectedIds, ["promotion-patch-local-helper"]);
  assert.deepEqual(applyResult.appliedIds, ["promotion-patch-local-helper"]);
  assert.match(await fs.readFile(path.join(agentsDir, "local-helper.yaml"), "utf8"), /summarize_findings/);

  const updatedQueue = await readJsonFile<{ items: Array<{ id: string; status: string }> }>(path.join(learningDir, "agent-improvement-promotions.json"));
  assert.equal(updatedQueue.items.find((item) => item.id === "promotion-patch-local-helper")?.status, "applied");
  assert.equal(updatedQueue.items.find((item) => item.id === "promotion-patch-shared-helper")?.status, "approved");

  const receipts = await readJsonFile<{ events: Array<{ status: string; scope: string; reason: string }> }>(path.join(learningDir, "agent-improvement-apply-receipts.json"));
  assert.ok(receipts.events.some((event) =>
    event.status === "applied" &&
    event.scope === "project-local" &&
    /Applied approved agent YAML promotion/.test(event.reason)
  ));
});
