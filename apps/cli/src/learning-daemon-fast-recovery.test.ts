import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (
  await Promise.all(
    [
      "./index.ts",
      "./commands/system.ts",
      "./commands/bundle.ts",
      "./commands/project.ts",
      "./commands/storage.ts",
      "./commands/runs.ts",
      "./commands/approvals.ts",
      "./commands/learning.ts",
      "./commands/local-llm.ts",
      "./commands/server.ts",
      "./commands/context-extra.ts",
      "./commands/daemon.ts",
      "./lib/builders-shared.ts",
      "./lib/builders-learning.ts",
      "./lib/builders-server.ts",
      "./lib/builders-system.ts",
      "./lib/builders-bundle.ts",
      "./lib/builders-project.ts",
      "./lib/builders-storage.ts",
      "./lib/builders-runs.ts",
      "./lib/builders-approvals.ts",
      "./lib/builders-local-llm.ts",
      "./lib/builders-context.ts",
      "./lib/context.ts",
      "./lib/cli-types.ts",
    ].map(async (p) => {
      try {
        return await readFile(new URL(p, import.meta.url), "utf8");
      } catch {
        return "";
      }
    }),
  )
).join("\n");

test("learning daemon heals approvals before expensive analysis", () => {
  assert.match(
    source,
    /async function runLearningDaemonTick[\s\S]+dismissDuplicateBlockedWorkflowRuns\(input\.projectDir[\s\S]+runApprovalAutopilot\([\s\S]+const repositoryMaintenance = await scanRepositoryMaintenance/u
  );
});

test("learning daemon dismisses older equivalent blockers and their approvals", () => {
  assert.match(
    source,
    /async function dismissDuplicateBlockedWorkflowRuns[\s\S]+newestByContract[\s\S]+decision: "rejected"[\s\S]+status: "dismissed"[\s\S]+supersedeWorkflowRun/u
  );
});

test("all-project daemon sweeps every queue between expensive project analyses", () => {
  assert.match(
    source,
    /const runQueueRecoveryLane = async[\s\S]+runLearningDaemonStaleRunReconciliation\(projectDir\)[\s\S]+requeueExpiredWorkflowTaskLeases[\s\S]+learnFromWorkflowRepairs\(target\.projectDir\)[\s\S]+autoRepairOneWorkflowRun\(target\.projectDir, target\.mode\)[\s\S]+const runFastRecoverySweep = async[\s\S]+runQueueRecoveryLane\(\)[\s\S]+dismissDuplicateBlockedWorkflowRuns\(recoveryTarget\.projectDir[\s\S]+runApprovalAutopilot/u
  );
  assert.match(
    source,
    /for \(const target of targets\) \{\s+await runFastRecoverySweep\(\);[\s\S]+await runFastRecoverySweep\(\);\s+mcpCleanup/u
  );
});

test("daemon heartbeats reread persisted trust settings instead of retaining stale risk values", () => {
  assert.match(source, /autonomousApplyMaxRisk: update\?\.autonomousApplyMaxRisk \?\? await learningAutonomousApplyMaxRisk\(statusProjectDir\)/u);
  assert.match(source, /approvalAutopilotEnabled: aggregate\?\.approvalAutopilotEnabled \?\? update\?\.approvalAutopilotEnabled \?\? await learningApprovalAutopilotEnabled\(statusProjectDir\)/u);
  assert.match(source, /approvalAutopilotMaxRisk: aggregate\?\.approvalAutopilotMaxRisk \?\? update\?\.approvalAutopilotMaxRisk \?\? await learningApprovalAutopilotMaxRisk\(statusProjectDir\)/u);
  assert.doesNotMatch(source, /lastStatus\?\.approvalAutopilotMaxRisk \?\? await learningApprovalAutopilotMaxRisk/u);
});

test("queue health and root repair run before slow project learning", () => {
  const fastSweep = source.indexOf("await runFastRecoverySweep();", source.indexOf("for (const target of targets)"));
  const learningTick = source.indexOf("await runLearningDaemonTick({", fastSweep);
  assert.ok(fastSweep >= 0);
  assert.ok(learningTick > fastSweep);
  assert.match(source.slice(source.indexOf("const runFastRecoverySweep"), fastSweep), /runQueueRecoveryLane/u);
  assert.match(source, /await runQueueRecoveryLane\(\);[\s\S]+setInterval\([\s\S]+runQueueRecoveryLane\(\)[\s\S]+Math\.min\(intervalMs, 10_000\)/u);
});
