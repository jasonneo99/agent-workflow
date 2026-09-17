import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");

test("learning daemon heals approvals before expensive analysis", () => {
  assert.match(
    source,
    /async function runLearningDaemonTick[\s\S]+dismissDuplicateBlockedWorkflowRuns\(input\.projectDir[\s\S]+runApprovalAutopilot\([\s\S]+const repositoryMaintenance = await scanRepositoryMaintenance/u
  );
});

test("learning daemon dismisses older equivalent blockers and their approvals", () => {
  assert.match(
    source,
    /async function dismissDuplicateBlockedWorkflowRuns[\s\S]+newestByContract[\s\S]+decision: "rejected"[\s\S]+status: "dismissed"[\s\S]+dismissFailedWorkflowRun/u
  );
});
