import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isInternalDiscoveryBlocker, workflowAutomaticRepairEnabled } from "./workflow-supervision.js";

// Execute the production bodies without importing live storage or starting a daemon.
const text = readFileSync(new URL("./commands/learning.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("learning.ts", text, ts.ScriptTarget.Latest, true);
const registration = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "registerLearningCommands");
assert.ok(registration?.body, "Production registration must exist");
const names = ["autoRepairOneWorkflowRun", "allowAutomaticRepairDispatch"];
const bodies = names.map((name) => {
  const declaration = registration.body!.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Production entry point missing: ${name}`);
  return declaration.getText(source);
}).join("\n");
const executable = ts.transpileModule(bodies, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;

async function exercise(suppressed: "repair" | "source" | null, mode = "apply-approved",
  scenario: "discovery" | "active" | "provider" | "ordinary" | "superseded" | "missing" | "cycle" = "discovery",
  automaticRepair = "1") {
  const effects: string[] = [];
  const repair = Object.freeze({
    id: "synthetic-repair", workflowId: "debug-failure", task: "Diagnose synthetic failure",
    status: scenario === "active" ? "running" : "blocked", dismissed: false,
    blockedReason: "The exact implementation and test paths could not be located because repository discovery was unavailable.",
    evaluationMetadata: Object.freeze({ source: scenario === "ordinary" ? "manual" : scenario === "provider" ? "workflow-root-repair" : "workflow-supervisor-repair", sourceRunId: "synthetic-source" })
  });
  // A cancelled ancestor remains available for lineage, without becoming another candidate.
  const ancestor = Object.freeze({ id: "synthetic-source", status: "cancelled", task: "Synthetic original task",
    evaluationMetadata: { rootRepairKind: "provider-recovered", ...(scenario === "cycle" ? { source: "workflow-root-repair", sourceRunId: "synthetic-repair" } : {}) } });
  const runs = Object.freeze([repair, ancestor]);
  const receipts = Object.freeze({
    repair: Object.freeze(suppressed === "repair" ? [Object.freeze({ actionType: "workflow_supervisor_repair_suppressed" })] : []),
    source: Object.freeze(suppressed === "source" ? [Object.freeze({ actionType: "workflow_supervisor_repair_suppressed" })] : [])
  });
  const before = JSON.stringify({ runs, receipts });
  const entry = runInNewContext(`${executable}\nautoRepairOneWorkflowRun`, {
    ctx: Object.freeze({}),
    process: Object.freeze({ env: Object.freeze({ AGENTFLOW_WORKFLOW_AUTO_REPAIR: automaticRepair }) }),
    workflowAutomaticRepairEnabled,
    listWorkflowRunsForProject: async () => runs,
    loadProjectDeliveryReceipts: async () => [],
    stringValue: (value: unknown) => typeof value === "string" ? value : undefined,
    findLaterCompletedEquivalentRun: () => scenario === "superseded" ? { id: "synthetic-completed" } : undefined,
    findSupersedingDeliveryReceipt: () => ({ id: "synthetic-delivery" }),
    dismissRunSupersededByReceipt: async () => { effects.push("dismiss"); },
    getWorkflowRunDetails: async (id: string) => ({
      run: scenario === "missing" && id === ancestor.id ? undefined : runs.find((run) => run.id === id), tasks: [],
      receipts: id === repair.id ? receipts.repair : receipts.source
    }),
    listArtifacts: async () => [],
    listActionApprovals: async () => [],
    isOpenApproval: () => false,
    isInternalDiscoveryBlocker,
    isWithinAutomaticWorkflowRepairWindow: () => false,
    indexProjectForRun: async () => { effects.push("index"); },
    preflightWorkflowAcceptance: async () => ({ accepted: false }),
    reserveSupervisedRepair: async () => { effects.push("reserve"); return true; },
    replayWorkflowRun: async (input: { sourceRunId: string; preserveCompletedCheckpoints: boolean }) => {
      assert.equal(input.sourceRunId, repair.id);
      assert.equal(input.preserveCompletedCheckpoints, true);
      effects.push("replay"); return { runId: "synthetic-continuation" };
    },
    recordRunAction: async () => { effects.push("receipt"); },
    supersedeWorkflowRun: async () => { effects.push("supersede"); },
    cancelWorkflowRun: async () => { effects.push("cancel"); },
    queueSupervisedWorkflowRepair: async () => { effects.push("dispatch"); return true; }
  }) as (project: string, mode: string) => Promise<number>;
  const result = await entry("synthetic-project", mode);
  assert.equal(JSON.stringify({ runs, receipts }), before, "Synthetic inputs and immutable receipts must remain unchanged");
  return { result, effects };
}

for (const suppressed of ["repair", "source"] as const) {
  test(`R4 discovery honors suppressed ${suppressed}`, async () => {
    const observed = await exercise(suppressed);
    assert.deepEqual(observed.effects, [], `R4 suppression violated: ${suppressed}; effects=${JSON.stringify(observed.effects)}`);
    assert.equal(observed.result, 0);
  });
}

test("R4 unsuppressed discovery positive control executes recovery", async () => {
  const observed = await exercise(null);
  assert.deepEqual(observed.effects, ["index", "receipt", "reserve", "replay", "receipt", "supersede"]);
  assert.equal(observed.result, 1);
});

test("R4 observe mode negative control has no effects", async () => {
  const observed = await exercise(null, "observe");
  assert.deepEqual(observed.effects, []);
  assert.equal(observed.result, 0);
});

for (const scenario of ["active", "provider", "ordinary", "superseded"] as const) {
  for (const suppressed of (scenario === "ordinary" ? ["repair"] : ["repair", "source"]) as Array<"repair" | "source">) {
    test(`R4 ${scenario} honors suppressed ${suppressed} before any effects`, async () => {
      const observed = await exercise(suppressed, "apply-approved", scenario);
      assert.deepEqual(observed, { result: 0, effects: [] });
    });
  }
}
for (const scenario of ["missing", "cycle"] as const) {
  test(`R4 ${scenario} ancestry fails closed`, async () => {
    assert.deepEqual(await exercise(null, "apply-approved", scenario), { result: 0, effects: [] });
  });
}
test("R4 unsuppressed active cleanup positive control remains available", async () => {
  assert.deepEqual(await exercise(null, "apply-approved", "active"), { result: 1, effects: ["dismiss"] });
});
test("R4 unsuppressed supersession positive control remains available", async () => {
  assert.deepEqual(await exercise(null, "apply-approved", "superseded"), { result: 1, effects: ["supersede"] });
});

test("R4 disabled automatic repair has no effects in the isolated environment", async () => {
  for (const flag of ["", "0", "true"]) {
    assert.deepEqual(await exercise(null, "apply-approved", "discovery", flag), { result: 0, effects: [] });
  }
});

test("repair reservation follows an audited storage preflight across every downstream gate", async () => {
  const { acceptancePreflight } = await import("../../../packages/storage/src/acceptance.js");
  const order: string[] = [];
  const client = { query: async () => ({ rows: [{ projectId: "synthetic-project", task: "Synthetic failure", metadata: {} }] }) } as unknown as Parameters<typeof acceptancePreflight>[0];
  const entry = runInNewContext(`${executable}\nallowAutomaticRepairDispatch`, {
    process: { env: { AGENTFLOW_WORKFLOW_AUTO_REPAIR: "1" } }, workflowAutomaticRepairEnabled,
    listActionApprovals: async () => [], isOpenApproval: () => false, listArtifacts: async () => [],
    preflightWorkflowAcceptance: async () => acceptancePreflight(client, "synthetic-run", {}),
    recordRunAction: async (action: any) => {
      assert.equal(action.artifactContent.diagnosticOnly, true);
      assert.deepEqual(Array.from(action.artifactContent.decisions, (item: any) => item.gate), ["implementation", "verification", "packaging", "supervision"]);
      assert.equal(action.artifactContent.accepted, false);
      order.push("audit");
    },
    reserveSupervisedRepair: async () => { assert.deepEqual(order, ["audit"]); order.push("reserve"); return true; }
  }) as (run: { id: string; task: string }, failure: string) => Promise<boolean>;
  assert.equal(await entry({ id: "synthetic-run", task: "Synthetic failure" }, "Missing evidence"), true);
  assert.deepEqual(order, ["audit", "reserve"]);
});
