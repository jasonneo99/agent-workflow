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

test("all-project daemon sweeps every queue between expensive project analyses", () => {
  assert.match(
    source,
    /const runFastRecoverySweep = async[\s\S]+runLearningDaemonStaleRunReconciliation\(projectDir\)[\s\S]+for \(const recoveryTarget of targets\)[\s\S]+dismissDuplicateBlockedWorkflowRuns\(recoveryTarget\.projectDir[\s\S]+runApprovalAutopilot\([\s\S]+requeueExpiredWorkflowTaskLeases[\s\S]+learnFromWorkflowRepairs\(recoveryTarget\.projectDir\)[\s\S]+autoRepairOneWorkflowRun\(recoveryTarget\.projectDir, recoveryTarget\.mode\)/u
  );
  assert.match(
    source,
    /for \(const target of targets\) \{\s+await runFastRecoverySweep\(\);[\s\S]+await runFastRecoverySweep\(\);\s+mcpCleanup/u
  );
});

test("queue health and root repair run before slow project learning", () => {
  const fastSweep = source.indexOf("await runFastRecoverySweep();", source.indexOf("for (const target of targets)"));
  const learningTick = source.indexOf("await runLearningDaemonTick({", fastSweep);
  assert.ok(fastSweep >= 0);
  assert.ok(learningTick > fastSweep);
  assert.match(source.slice(source.indexOf("const runFastRecoverySweep"), fastSweep), /runLearningDaemonStaleRunReconciliation[\s\S]+learnFromWorkflowRepairs[\s\S]+autoRepairOneWorkflowRun/u);
});
