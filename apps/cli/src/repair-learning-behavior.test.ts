import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { buildGovernedReusePlan, type ReuseMemoryCandidate } from "../../../packages/reuse-engine/src/index.js";
import { workflowAutomaticRepairEnabled, workflowRepairLesson } from "./workflow-supervision.js";

// Production function bodies, synthetic persistence only: no daemon or live storage imports.
const text = readFileSync(new URL("./commands/learning.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("learning.ts", text, ts.ScriptTarget.Latest, true);
const registration = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "registerLearningCommands");
assert.ok(registration?.body);
function entry(name: string, adapters: Record<string, unknown>) {
  const declaration = registration!.body!.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Production function missing: ${name}`);
  const executable = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  return runInNewContext(`${executable}\n${name}`, adapters);
}

test("production repair learning persists only accepted reinforcement for subsequent consumption", async () => {
  const cases = [
    { id: "accepted", status: "completed", accepted: true },
    { id: "unaccepted", status: "completed", accepted: false },
    { id: "failed", status: "failed", accepted: false },
    { id: "cancelled", status: "cancelled", accepted: false }
  ];
  const runs = cases.map((item) => ({ ...item, workflowId: "review-pr", evaluationMetadata: {
    source: "workflow-root-repair", sourceRunId: "original", rootRepairKind: "replay-original"
  } }));
  const recorded = new Set<string>();
  const memory: ReuseMemoryCandidate[] = [];
  let receiptCount = 0;
  const learn = entry("learnFromWorkflowRepairs", {
    stringValue: (value: unknown) => typeof value === "string" ? value : undefined,
    workflowRepairLesson,
    listWorkflowRunsForProject: async () => runs,
    getWorkflowRunDetails: async (id: string) => ({
      receipts: recorded.has(id) ? [{ actionType: "workflow_repair_learning" }] : [],
      tasks: [{ status: id === "failed" ? "failed" : "completed" }]
    }),
    listArtifacts: async ({ runId }: { runId: string }) => [{ content: { runId } }],
    preflightWorkflowAcceptance: async (id: string, output: { runId: string }) => {
      assert.equal(output.runId, id);
      return { accepted: cases.find((item) => item.id === id)!.accepted };
    },
    recordRunAction: async (action: { runId: string; artifactContent: { acceptanceVerified: boolean; outcome: string } }) => {
      assert.equal(action.artifactContent.acceptanceVerified, action.runId === "accepted");
      assert.equal(action.artifactContent.outcome === "reinforce", action.runId === "accepted");
      recorded.add(action.runId);
      receiptCount += 1;
    },
    upsertMemoryItem: async (item: { sourceUri: string; summary: string; metadata: { kind: string; acceptanceVerified: boolean; outcome: string } }) => {
      memory.push({ sourceUri: item.sourceUri, summary: item.summary, ...item.metadata, updatedAt: new Date(0).toISOString() });
    }
  }) as (project: string) => Promise<number>;
  assert.equal(await learn("synthetic-project"), 4);
  assert.equal(await learn("synthetic-project"), 0);
  assert.equal(receiptCount, 4);
  assert.equal(memory.length, 4);
  // Serialize and reload to model a later consumer, retaining acceptance metadata.
  const persisted = JSON.parse(JSON.stringify(memory)) as ReuseMemoryCandidate[];
  const accepted = persisted.find((item) => item.sourceUri.endsWith("/accepted"))!;
  const plan = buildGovernedReusePlan({
    target: { task: accepted.summary, workflowId: "build-feature", workflowHash: "synthetic-workflow", policySnapshotHash: "synthetic-policy", selectedSources: [] },
    candidates: [], memory: persisted
  });
  assert.deepEqual(plan.memory.map((item) => item.sourceUri), [accepted.sourceUri]);
  assert.equal(plan.recommendation, "run-fresh");
});

test("disabled production dispatch stays closed across reconstructed callers", async () => {
  for (const value of [undefined, "", "0", "true", "off"]) {
    for (let restart = 0; restart < 3; restart += 1) {
      const forbidden = async () => { assert.fail("Disabled dispatch reached storage or an effect"); };
      const dispatch = entry("allowAutomaticRepairDispatch", {
        process: { env: { AGENTFLOW_WORKFLOW_AUTO_REPAIR: value } },
        workflowAutomaticRepairEnabled,
        listActionApprovals: forbidden, listArtifacts: forbidden,
        preflightWorkflowAcceptance: forbidden, recordRunAction: forbidden,
        reserveSupervisedRepair: forbidden
      }) as (run: { id: string; task: string }, failure: string) => Promise<boolean>;
      assert.equal(await dispatch({ id: "synthetic-original", task: "Synthetic original task" }, "Synthetic failure"), false);
    }
  }
});

test("production supervisor refuses legacy wrappers and derived recoveries with bounded lineage", async () => {
  const original = { id: "00000000-0000-0000-0000-000000000001", task: "Fix the named parser defect", projectRootUri: "synthetic-project" };
  const cases = [
    { task: `Repair supervised Agent Workflow run ${original.id}.\n\nOriginal task: Resolve every currently failed or blocked item`, evaluationMetadata: {} },
    { task: "Resolve every currently failed or blocked item", evaluationMetadata: {} },
    ...["blocked-run-repair", "workflow-supervisor-repair", "workflow-root-repair"].map(source => ({ task: original.task, evaluationMetadata: { source, sourceRunId: original.id } })),
    { task: original.task, evaluationMetadata: { replayOfRunId: original.id } }
  ];
  for (const candidate of cases) {
    const receipts: Array<{ artifactContent: Record<string, unknown> }> = [];
    const forbidden = async () => assert.fail("Refused recovery reached dispatch");
    const dispatch = entry("queueSupervisedWorkflowRepair", {
      automaticRepairProjectAllowed: () => true,
      stringValue: (value: unknown) => typeof value === "string" ? value : undefined,
      getWorkflowRunDetails: async () => ({ run: original }),
      recordRunAction: async (receipt: typeof receipts[number]) => { receipts.push(receipt); },
      indexProjectForRun: forbidden, allowAutomaticRepairDispatch: forbidden, queueWorkflow: forbidden
    });
    assert.equal(await dispatch({ run: { ...original, ...candidate, id: "derived" }, projectDir: "synthetic-project", reason: "Recorded failure", actor: "synthetic" }), false);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].artifactContent.finding, "Recorded failure");
    assert.equal(receipts[0].artifactContent.lineageStatus, "resolved");
  }
});

test("production supervisor stops cyclic lineage", async () => {
  let loads = 0;
  let status: unknown;
  const run = { id: "cycle", task: "Named task", projectRootUri: "synthetic-project", evaluationMetadata: { sourceRunId: "cycle" } };
  const dispatch = entry("queueSupervisedWorkflowRepair", {
    automaticRepairProjectAllowed: () => true,
    stringValue: (value: unknown) => typeof value === "string" ? value : undefined,
    getWorkflowRunDetails: async () => { loads += 1; return { run }; },
    recordRunAction: async (receipt: { artifactContent: { lineageStatus: string } }) => { status = receipt.artifactContent.lineageStatus; }
  });
  assert.equal(await dispatch({ run, projectDir: "synthetic-project", reason: "Failure", actor: "synthetic" }), false);
  assert.equal(loads, 0);
  assert.equal(status, "cycle");
});

test("original named task retains the policy-controlled supervisor path", async () => {
  for (const allowed of [false, true]) {
    let queued = 0;
    const dispatch = entry("queueSupervisedWorkflowRepair", {
      ctx: {}, automaticRepairProjectAllowed: () => true, indexProjectForRun: async () => {},
      supervisedRepairWorkflowId: () => "debug-failure", allowAutomaticRepairDispatch: async () => allowed,
      inheritedCodexOrigin: () => ({}), recordRunAction: async () => {},
      queueWorkflow: async () => { queued += 1; return { ok: true, run: { runId: "repair" }, workflow: { id: "debug-failure" } }; }
    });
    assert.equal(await dispatch({ run: { id: "original", task: "Fix the named parser defect", projectRootUri: "synthetic-project" }, projectDir: "synthetic-project", reason: "Failure", actor: "synthetic" }), allowed);
    assert.equal(queued, Number(allowed));
  }
});
