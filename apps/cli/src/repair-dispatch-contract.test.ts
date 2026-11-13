import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {automaticRepairProjectAllowed} from './repair-project-boundary.js';

const source = readFileSync(new URL("./commands/learning.ts", import.meta.url), "utf8");

test("production repair-of-repair refusal emits evidence and never reaches dispatch", async () => {
  const parsed = ts.createSourceFile("learning.ts", source, ts.ScriptTarget.Latest, true);
  let body: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "queueSupervisedWorkflowRepair") body = node;
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(body);
  const executable = ts.transpileModule(body.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  for (const receiptFails of [false, true]) {
    const receipts: Array<Record<string, unknown>> = [];
    const forbidden = () => { assert.fail("Recursive repair reached an execution effect"); };
    const run = { id: "synthetic-repair", projectRootUri:'/synthetic/project', evaluationMetadata: {
      source: "workflow-supervisor-repair", sourceRunId: "synthetic-original"
    } };
    const before = JSON.stringify(run);
    const execute = runInNewContext(`${executable}; queueSupervisedWorkflowRepair`, {
      ctx: {}, automaticRepairProjectAllowed, stringValue: (value: unknown) => typeof value === 'string' ? value : undefined,
      getWorkflowRunDetails: async (id: string) => ({ run: { id, projectRootUri: run.projectRootUri, task: 'Original scoped source outcome', evaluationMetadata: {} } }),
      recordRunAction: async (receipt: Record<string, unknown>) => {
        receipts.push(receipt);
        if (receiptFails) throw new Error("Synthetic receipt outage");
      }, indexProjectForRun: forbidden, allowAutomaticRepairDispatch: forbidden,
      supervisedRepairWorkflowId: forbidden, queueWorkflow: forbidden
    }) as (input: Record<string, unknown>) => Promise<boolean>;
    assert.equal(await execute({ run, projectDir: "/synthetic/project", reason: "Synthetic failure", actor: "test" }), false);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].actionType, "workflow_supervisor_repair_refused");
    assert.equal(receipts[0].target, "synthetic-original");
    assert.equal(JSON.stringify(run), before);
  }
});

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
