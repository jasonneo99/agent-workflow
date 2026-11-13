import assert from "node:assert/strict";
import test from "node:test";
import { coordinatorAllowsRepair, repairEvidenceChanged, repairFingerprint } from "./repair-dispatch.js";

test("failure fingerprint ignores run identity and whitespace, not changed diagnosis", () => {
  assert.equal(repairFingerprint("Build product", "Missing source for 00000000-0000-4000-8000-000000000001"),
    repairFingerprint("Build  product", "Missing source for 00000000-0000-4000-8000-000000000002"));
  assert.notEqual(repairFingerprint("Build product", "Missing source"), repairFingerprint("Build product", "Failed test"));
});

test("unchanged or removed evidence cannot rearm repair; new validated evidence can", () => {
  assert.equal(repairEvidenceChanged(null, []), true);
  assert.equal(repairEvidenceChanged([], []), false);
  assert.equal(repairEvidenceChanged(["fix-a"], ["fix-a"]), false);
  assert.equal(repairEvidenceChanged(["fix-a"], []), false);
  assert.equal(repairEvidenceChanged(["fix-a"], ["fix-a", "fix-b"]), true);
});

test("successful-looking counters without governed checks cannot rearm repair", async () => {
  const { validatedRepairEvidence } = await import("./repair-dispatch.js");
  const client = { query: async (sql: string) => {
    if (sql.includes("kind='direct_repair_validation'")) return { rows: [{ id: "synthetic-report", content: { validation: { failed: 0, passed: 100 } } }] };
    assert.ok(sql.includes("from workflow_runs where"));
    return { rows: [{ projectId: "synthetic-project", task: "Synthetic repair", metadata: {} }] };
  } } as unknown as Parameters<typeof validatedRepairEvidence>[0];
  const evidence = await validatedRepairEvidence(client, "synthetic-run");
  assert.deepEqual(evidence, []);
  assert.equal(repairEvidenceChanged([], evidence), false);
});

test("all repair producers respect active coordinator family and live matching claim", async () => {
  const input = { runId: "source", projectId: "project", runSetId: "family" };
  let available = true;
  let rows: Array<{id:string; fence:string; sourceRunId:string; live:boolean}> = [];
  const client = { query: async (sql:string, values?:unknown[]) => {
    if(sql.includes("a.kind='queue_partner_repair_management'"))return {rowCount:0,rows:[]};
    if (sql.includes("to_regclass")) return {rows:[{name:available ? "queue_coordinator_assignments" : null}]};
    assert.deepEqual(values,["project","project:family"]);
    assert.ok(sql.includes("i.fencing_token::text=a.intent_fence and i.expires_at>now()"));
    assert.ok(sql.includes("'uncertain'"));
    return {rows};
  }} as unknown as Parameters<typeof coordinatorAllowsRepair>[0];
  assert.equal(await coordinatorAllowsRepair(client,input),true);
  const coordinatorClaim={id:"claim",fence:"7"};
  assert.equal(await coordinatorAllowsRepair(client,{...input,coordinatorClaim}),false);
  rows=[{id:"claim",fence:"7",sourceRunId:"source",live:true}];
  assert.equal(await coordinatorAllowsRepair(client,input),false);
  assert.equal(await coordinatorAllowsRepair(client,{...input,coordinatorClaim}),true);
  assert.equal(await coordinatorAllowsRepair(client,{...input,coordinatorClaim:{id:"claim",fence:"6"}}),false);
  rows[0].live=false;
  assert.equal(await coordinatorAllowsRepair(client,{...input,coordinatorClaim}),false);
  rows[0].live=true;rows[0].sourceRunId="other";
  assert.equal(await coordinatorAllowsRepair(client,{...input,coordinatorClaim}),false);
  available=false;
  assert.equal(await coordinatorAllowsRepair(client,input),true);
  assert.equal(await coordinatorAllowsRepair(client,{...input,coordinatorClaim}),false);
});

test('Partner managed family cannot fall back to a legacy dispatcher between repairs',async()=>{
 const client={query:async(sql:string)=>{assert.match(sql,/queue_partner_repair_management/);return {rowCount:1,rows:[{}]};}} as unknown as Parameters<typeof coordinatorAllowsRepair>[0];
 assert.equal(await coordinatorAllowsRepair(client,{runId:'source',projectId:'project',runSetId:'family'}),false);
});
