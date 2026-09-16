import assert from "node:assert/strict";
import test from "node:test";
import type { StageExecutionInput, StageExecutionOutput } from "./types.js";
import { scoreStageOutput, unfulfilledCompletionReason } from "./quality.js";

const input = {
  stageId: "implement",
  agentId: "implementation-agent",
  projectConfig: { project: { name: "example" } }
} as StageExecutionInput;

test("implementation completion fails closed when the output says no implementation occurred", () => {
  const output = {
    outcome: "completed",
    summary: "Completed read-only inspection. Implementation remains incomplete; no files were changed.",
    artifact: { findings: ["The plan is present."], nextAction: "Implement the requested changes." },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput;
  assert.match(unfulfilledCompletionReason(input, output) ?? "", /claimed completion/i);
  const quality = scoreStageOutput(input, output);
  assert.equal(quality.passed, false);
  assert.equal(quality.score, 0);
});

test("review stages may correctly report that they made no source changes", () => {
  const output = {
    outcome: "completed",
    summary: "Review completed with no source changes.",
    artifact: {}
  } as StageExecutionOutput;
  assert.equal(unfulfilledCompletionReason({ ...input, stageId: "review", agentId: "security-reviewer" }, output), null);
});
