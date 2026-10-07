import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./commands/learning.ts", import.meta.url), "utf8");

test("automatic replay and retry call sites retain the shared dispatch guard", () => {
  const replayCalls = [...source.matchAll(/const replay = await replayWorkflowRun\(/gu)];
  assert.equal(replayCalls.length, 3);
  for (const call of replayCalls) {
    assert.match(source.slice(call.index! - 150, call.index), /if \(!await allowAutomaticRepairDispatch\(run, (?:reason|discoveryReason)\)\) continue;/u);
  }
  const retry = source.indexOf("const requeued = await retryFailedWorkflowRun(");
  assert.ok(retry > 0);
  assert.match(source.slice(retry - 250, retry), /allowAutomaticRepairDispatch\(item.details.run, signature\)/u);
  const supervised = source.slice(source.indexOf("async function queueSupervisedWorkflowRepair"), source.indexOf("async function readAgentImprovementApplyReceipts"));
  assert.ok(supervised.indexOf("allowAutomaticRepairDispatch(input.run, input.reason)") < supervised.indexOf("await queueWorkflow("));
  assert.ok(supervised.includes("allowAutomaticRepairDispatch(input.run, input.reason)"));
});

test("shared dispatch helper evaluates recorded evidence before taking a repair reservation", () => {
  const helper = source.slice(source.indexOf("async function allowAutomaticRepairDispatch"), source.indexOf("async function autoRepairOneWorkflowRun"));
  assert.ok(helper.indexOf("await preflightWorkflowAcceptance") < helper.indexOf("reserveSupervisedRepair"));
  assert.match(helper, /if \(preflight.accepted\) return false/u);
});
