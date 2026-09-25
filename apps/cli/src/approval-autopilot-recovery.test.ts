import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("approval autopilot replays a blocked run after its final required action executes", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /runApprovalAutopilot[\s\S]+details\.run\?\.status === "blocked"[\s\S]+!unresolved[\s\S]+retryFailedWorkflowRun\(approval\.runId\)/u);
});

test("approval autopilot does not create a second replacement after inline approval recovery", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /result\.runId !== approval\.runId[\s\S]+resumedRuns\.add\(approval\.runId\)[\s\S]+!resumedRuns\.has\(approval\.runId\)/u);
});

test("learning daemon recovers approval executions interrupted by its prior process", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /recoverInterruptedActionApprovalExecutions\(\{ actor: daemonId \}\)/u);
  assert.match(source, /Recovered \$\{recoveredApprovalExecutions\.length\} interrupted approval execution/u);
  assert.match(source, /Autopilot approved and requested immediate execution/u);
});

test("exact project policy approvals execute with rollback evidence and resume blocked work", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /approval\.actionType === "project_policy_change"/u);
  assert.match(source, /rollbackPath: path\.relative\(projectRoot, backupPath\)/u);
  assert.match(source, /beforeHash: createHash\("sha256"\)/u);
  assert.match(source, /afterHash: createHash\("sha256"\)/u);
  assert.match(source, /approveAndExecuteAction[\s\S]+resumeBlockedRunAfterResolvedApprovals\(approval\.runId\)/u);
});
