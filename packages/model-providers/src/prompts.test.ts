import assert from "node:assert/strict";
import test from "node:test";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { buildStagePrompt, normalizeStageArtifact } from "./prompts.js";

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
  assert.match(prompt, /outcome: completed only when the stage goal was actually achieved/u);
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
