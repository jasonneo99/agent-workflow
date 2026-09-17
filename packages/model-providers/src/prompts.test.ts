import assert from "node:assert/strict";
import test from "node:test";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { buildStageExecutionOutput, buildStagePrompt, normalizeStageArtifact, reviewEvidenceGapIsFinding } from "./prompts.js";

const project = projectConfigSchema.parse({ project: { name: "portable-project" } });

test("downstream stages receive immutable prior stage artifacts, not receipt summaries alone", () => {
  const prompt = buildStagePrompt({
    runId: "run-1",
    taskId: "task-2",
    projectConfig: project,
    workflowId: "build-feature",
    workflowTask: "Implement and verify the requested change.",
    stageId: "implement",
    agentId: "implementation-agent",
    agentName: "Implementation Agent",
    agentPrompt: "Implement narrowly.",
    stageGoal: "Apply the approved plan locally.",
    compiledBrief: "Immutable compiled project context.",
    priorReceipts: [{ agentId: "technical-architect", actionType: "stage_completed", summary: "Plan ready." }],
    priorStageArtifacts: [{
      stageId: "plan",
      agentId: "technical-architect",
      summary: "Plan ready.",
      artifact: { findings: ["Edit packages/runtime.ts"], nextAction: "Implement the bounded change." }
    }]
  });

  assert.match(prompt, /Immutable compiled project context/u);
  assert.match(prompt, /Prior stage artifacts \(authoritative outputs from this run\)/u);
  assert.match(prompt, /Edit packages\/runtime\.ts/u);
  assert.match(prompt, /outcome: completed when the stage goal was achieved/u);
  assert.match(prompt, /PINNED KEYWORD CONTRACT: BUILD means create, verify, package, and deliver a usable product/u);
  assert.match(prompt, /evidence gaps do not block the review itself/u);
});

test("review evidence gaps become findings while real authority blockers remain blocked", () => {
  const reviewInput = {
    runId: "run-1",
    taskId: "task-1",
    projectConfig: project,
    workflowId: "review-pr",
    workflowTask: "Review the implementation.",
    stageId: "specialist-review",
    agentId: "ux-reviewer",
    agentName: "UX Reviewer",
    agentPrompt: "Review the product.",
    stageGoal: "Report prioritized findings.",
    compiledBrief: "Project evidence.",
    priorReceipts: []
  };
  const evidenceGap = normalizeStageArtifact({
    outcome: "blocked",
    blockedReason: "Missing implementation evidence for exact recovery and draft retention.",
    summary: "Production acceptance remains unproven.",
    findings: ["Exact recovery proof is absent."],
    nextAction: "Add a focused recovery test.",
    requestedCommands: [],
    requestedFileWrites: []
  });
  assert.equal(reviewEvidenceGapIsFinding(reviewInput, evidenceGap), true);
  const output = buildStageExecutionOutput(reviewInput, evidenceGap, { provider: "test" });
  assert.equal(output.outcome, "completed");
  assert.equal(output.blockedReason, undefined);
  assert.equal(output.artifact.evidenceGapReclassifiedAsFinding, true);

  const authorityBlocker = normalizeStageArtifact({
    outcome: "blocked",
    blockedReason: "Deployment approval is required and unavailable.",
    summary: "Cannot inspect the protected deployment.",
    findings: [],
    nextAction: "Request approval.",
    requestedCommands: [],
    requestedFileWrites: []
  });
  assert.equal(reviewEvidenceGapIsFinding(reviewInput, authorityBlocker), false);

  const missingDesignSystem = normalizeStageArtifact({
    outcome: "blocked",
    blockedReason: "No specific platform guidance or design system has been provided for review.",
    summary: "The UX review cannot proceed without a design system.",
    findings: ["Use the repository standards registry as the baseline."],
    nextAction: "Review against the registered platform standards.",
    requestedCommands: [],
    requestedFileWrites: []
  });
  assert.equal(reviewEvidenceGapIsFinding(reviewInput, missingDesignSystem), true);
});

test("stage prompt reserves a bounded section for named commit evidence", () => {
  const compiledBrief = [
    "# Compiled Agent Workflow Brief",
    "Task: review commit deadbee",
    "## Action Policy",
    "policy ".repeat(500),
    "## Project Context",
    "project ".repeat(1800),
    "## Indexed Source Summaries",
    "summary ".repeat(800),
    "## Exact Source Evidence",
    "### git-commit/deadbee.patch",
    "Evidence metadata: kind=named_commit; completeness=truncated; includedChars=8000; originalChars=12000; omittedChars=4000",
    "NAMED_COMMIT_SENTINEL\n" + "diff --git a/a.ts b/a.ts\n".repeat(300),
    "## Agent Instructions",
    "tail that should not displace exact evidence"
  ].join("\n");
  const prompt = buildStagePrompt({
    runId: "run-commit",
    taskId: "task-commit",
    projectConfig: project,
    workflowId: "review-pr",
    workflowTask: "Review deadbee.",
    stageId: "review",
    agentId: "technical-architect",
    agentName: "Technical Architect",
    agentPrompt: "Review the named commit.",
    stageGoal: "Review exact evidence.",
    compiledBrief,
    priorReceipts: []
  });

  assert.match(prompt, /strategy=section-budgeted; completeness=truncated/u);
  assert.match(prompt, /git-commit\/deadbee\.patch/u);
  assert.match(prompt, /NAMED_COMMIT_SENTINEL/u);
  assert.match(prompt, /Selection metadata: completeness=truncated/u);
  assert.ok(prompt.indexOf("NAMED_COMMIT_SENTINEL") < prompt.indexOf("Project Context"));
});

test("blocked implementation and verification shapes resolve as blocked", () => {
  const implementation = normalizeStageArtifact({
    summary: "Implementation is blocked by missing authoritative inputs. No changes were applied, and no tests were run.",
    findings: [],
    nextAction: "Supply context.",
    requestedCommands: [],
    requestedFileWrites: []
  });
  const verification = normalizeStageArtifact({
    outcome: "blocked",
    blockedReason: "Implementation made no changes, so verification cannot proceed.",
    summary: "Verification is blocked and no tests ran.",
    findings: [],
    nextAction: "Return to implementation.",
    requestedCommands: [],
    requestedFileWrites: []
  });

  assert.equal(implementation.outcome, "blocked");
  assert.match(implementation.blockedReason, /missing authoritative inputs/u);
  assert.equal(verification.outcome, "blocked");
  assert.match(verification.blockedReason, /cannot proceed/u);
});

test("actionable blocked output continues through the governed action runner", () => {
  const result = normalizeStageArtifact({
    outcome: "blocked",
    blockedReason: "The analysis stage cannot install the prepared regression.",
    summary: "A regression is ready to run.",
    findings: [],
    nextAction: "Write and run the regression.",
    requestedCommands: ["npm test"],
    requestedFileWrites: [{ path: "tests/regression.test.ts", content: "export {};\n" }]
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.blockedReason, "");
  assert.deepEqual(result.requestedCommands, ["npm test"]);
  assert.equal(result.requestedFileWrites.length, 1);
});

test("stage prompts distinguish historical failure language from a current blocker", () => {
  const prompt = buildStagePrompt({
    runId: "run-final",
    taskId: "task-final",
    projectConfig: project,
    workflowId: "review-pr",
    workflowTask: "Finalize the review.",
    stageId: "final-review",
    agentId: "pr-preparer",
    agentName: "PR Preparer",
    agentPrompt: "Summarize actionable findings.",
    stageGoal: "Produce the final review.",
    compiledBrief: "Project-specific source and diff evidence.",
    priorReceipts: [{ agentId: "reviewer", actionType: "stage_completed", summary: "Delegation failed, so the review continued locally." }],
    priorStageArtifacts: [{ stageId: "review", agentId: "reviewer", summary: "Review completed.", artifact: { outcome: "completed", findings: ["Concrete issue"] } }]
  });
  assert.match(prompt, /historical evidence/u);
  assert.match(prompt, /do not make the current stage blocked/u);
  assert.match(prompt, /Do not claim project context is missing/u);
});

test("empty action placeholders cannot turn a blocked stage into completed work", () => {
  const result = normalizeStageArtifact({ outcome: "blocked", blockedReason: "Authority is missing.", requestedCommands: ["  "], requestedFileWrites: [{ path: "", content: "" }] });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.requestedCommands.length, 0);
  assert.equal(result.requestedFileWrites.length, 0);
});
