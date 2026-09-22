import assert from "node:assert/strict";
import test from "node:test";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { buildStagePrompt, normalizeStageArtifact } from "./prompts.js";

const project = projectConfigSchema.parse({ project: { name: "read-contract-project" } });

function baseInput(overrides = {}) {
  return {
    runId: "run-reads",
    taskId: "task-reads",
    projectConfig: project,
    workflowId: "wf",
    workflowTask: "task",
    stageId: "implementation",
    agentId: "implementation-agent",
    agentName: "Implementation Agent",
    agentPrompt: "Do it.",
    stageGoal: "Ship it.",
    compiledBrief: "Brief.",
    modelTier: "standard",
    priorReceipts: [],
    ...overrides
  };
}

test("stage prompt instructs API providers to request file reads and shows read policy", () => {
  const prompt = buildStagePrompt(baseInput());
  assert.match(prompt, /requestedFileReads/u);
  assert.match(prompt, /Allowed read paths:/u);
  assert.match(prompt, /Blocked read paths:/u);
  assert.match(prompt, /Max read bytes:/u);
});

test("stage prompt renders requested file contents for re-prompt context", () => {
  const prompt = buildStagePrompt(baseInput({
    fileReads: [
      { path: "src/app.ts", content: "export const answer = 42;", truncated: false }
    ]
  }));
  assert.match(prompt, /File contents you requested to read/u);
  assert.match(prompt, /src\/app\.ts/u);
  assert.match(prompt, /answer = 42/u);
});

test("normalizeStageArtifact parses requestedFileReads as strings and {path} objects", () => {
  const artifact = normalizeStageArtifact({
    summary: "Need source context before writing.",
    findings: [],
    nextAction: "Read then implement.",
    requestedCommands: [],
    requestedFileWrites: [],
    requestedFileReads: ["src/app.ts", { path: "src/other.ts" }, "", 42, null]
  });
  assert.deepEqual(artifact.requestedFileReads, ["src/app.ts", "src/other.ts"]);
});

test("read requests count as actionable recovery so the stage continues instead of blocking", () => {
  const withReads = normalizeStageArtifact({
    outcome: "blocked",
    blockedReason: "Missing schema for the target module.",
    summary: "Blocked.",
    findings: [],
    nextAction: "Provide schema.",
    requestedCommands: [],
    requestedFileWrites: [],
    requestedFileReads: ["src/app.ts"]
  });
  assert.equal(withReads.outcome, "completed");
  assert.deepEqual(withReads.requestedFileReads, ["src/app.ts"]);

  const withoutRecovery = normalizeStageArtifact({
    outcome: "blocked",
    blockedReason: "Missing schema for the target module.",
    summary: "Blocked.",
    findings: [],
    nextAction: "Provide schema.",
    requestedCommands: [],
    requestedFileWrites: [],
    requestedFileReads: []
  });
  assert.equal(withoutRecovery.outcome, "blocked");
  assert.match(withoutRecovery.blockedReason, /Missing schema/u);
});
