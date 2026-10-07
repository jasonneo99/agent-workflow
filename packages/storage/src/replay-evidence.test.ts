import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { databaseUrl, loadStageContext } from "./postgres.js";
import { buildStagePrompt } from "../../model-providers/src/prompts.js";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { replayEvidencePacket } from "./replay-evidence.js";

test("replay evidence is bounded and never issues acceptance references", () => {
  const rows = Array.from({length:100}, (_, i) => ({ id:String(i), uri:`db://synthetic/${i}`,
    kind:"command_output", runId:"ancestor", taskId:"task", depth:1,
    createdAt:"2026-01-01T00:00:00.000Z", content:{commandLine:"npm test",exitCode:1,stdout:"x".repeat(20000),stderr:"y".repeat(20000)} }));
  const text = replayEvidencePacket(rows);
  const packet = JSON.parse(text);
  assert.ok(text.length < 24500);
  assert.ok(packet.omittedSelectedArtifacts > 0);
  assert.ok(packet.observations.every((row:Record<string,unknown>) => row.diagnosticOnly === true && !row.acceptanceReference));
});

test("clean replay delivers ancestor red evidence through real storage context to provider prompt", async () => {
  const client = new pg.Client({ connectionString: databaseUrl() });
  try {
    await client.connect();
    await client.query("set search_path to pg_temp");
    await client.query("create temporary table workflow_runs (id uuid, project_id uuid, evaluation_metadata jsonb)");
    await client.query(`create temporary table workflow_tasks (id uuid, run_id uuid, stage_id text,
      agent_id text, status text, finished_at timestamptz)`);
    await client.query(`create temporary table artifacts (id uuid default gen_random_uuid(), run_id uuid,
      task_id uuid, kind text, uri text, content jsonb, created_at timestamptz default now())`);
    await client.query("create temporary table action_receipts (run_id uuid, agent_id text, action_type text, summary text, created_at timestamptz)");
    const [current, parent, ancestor, unrelated, foreign, project, otherProject, task] = Array.from({length:8}, () => randomUUID());
    for (const [id, projectId, metadata] of [
      [current, project, {replayOfRunId: parent, replayReason: "Use the immutable observed red; verify green freshly"}],
      [parent, project, {replayOfRunId: ancestor}], [ancestor, project, {}],
      [unrelated, project, {}], [foreign, otherProject, {}],
    ]) await client.query("insert into workflow_runs values ($1,$2,$3)", [id,projectId,JSON.stringify(metadata)]);
    await client.query("insert into workflow_tasks values ($1,$2,'reproduce','test-engineer','completed',now())", [task,ancestor]);
    const uri = `db://workflow_runs/${ancestor}/command_output/synthetic-red`;
    await client.query("insert into artifacts (run_id,task_id,kind,uri,content) values ($1,$2,'command_output',$3,$4)",
      [ancestor,task,uri,JSON.stringify({commandLine:"npm test",exitCode:1,stdout:"noise".repeat(1000)+"SYNTHETIC_EXPECTED_RED_SIGNATURE",stderr:"",timedOut:false})]);
    await client.query("insert into artifacts (run_id,kind,uri,content) values ($1,'direct_repair_validation',$2,$3)",
      [parent,`db://workflow_runs/${parent}/direct_repair_validation/synthetic-green`,JSON.stringify({tests:{passed:4},promoted:false})]);
    for (const id of [unrelated, foreign]) await client.query("insert into artifacts (run_id,kind,uri,content) values ($1,'direct_repair_validation',$2,$3)",
      [id,`db://workflow_runs/${id}/private`,JSON.stringify({secret:"OTHER_RUN_MUST_NOT_LEAK"})]);
    const context = await loadStageContext(client,current);
    const prompt = buildStagePrompt({ ...context, runId:current, taskId:randomUUID(),
      projectConfig:projectConfigSchema.parse({project:{name:"synthetic"}}), workflowId:"debug-failure",
      workflowTask:"Verify a repaired failure", stageId:"reproduce", stageGoal:"Consume historical red and rerun green",
      agentId:"test-engineer", agentName:"Test", agentPrompt:"Verify" });
    assert.ok(prompt.includes(uri), "exact ancestor artifact URI must reach the stage prompt");
    assert.match(prompt,/SYNTHETIC_EXPECTED_RED_SIGNATURE/);
    assert.match(prompt,/diagnostic only/);
    assert.doesNotMatch(prompt,/OTHER_RUN_MUST_NOT_LEAK/);
    assert.equal(context.priorStageArtifacts.length,0,"clean replay does not inherit completed stage outputs");
    assert.equal(context.acceptanceContract,undefined,"historical evidence is not acceptance enrollment");

    // An old red must not be crowded out by routine recent successful commands.
    for (let i=0;i<20;i++) await client.query("insert into artifacts (run_id,task_id,kind,uri,content) values ($1,$2,'command_output',$3,$4)",
      [ancestor,task,`db://synthetic/pass-${i}`,JSON.stringify({commandLine:"npm test",exitCode:0,stdout:"pass"})]);
    assert.match(JSON.stringify(await loadStageContext(client,current)),/SYNTHETIC_EXPECTED_RED_SIGNATURE/);
    await client.query("update workflow_runs set evaluation_metadata=$2 where id=$1", [ancestor,JSON.stringify({replayOfRunId:current})]);
    const cycle = await loadStageContext(client,current);
    const packet = JSON.parse(cycle.priorReceipts.find(r=>r.actionType==='replay_evidence_packet')!.summary);
    assert.equal(packet.observations.filter((r:{artifactUri:string})=>r.artifactUri===uri).length,1,"cycle does not duplicate evidence");

    await client.query("update workflow_runs set evaluation_metadata=$2 where id=$1", [current,JSON.stringify({replayOfRunId:foreign})]);
    const cross = await loadStageContext(client,current);
    assert.doesNotMatch(JSON.stringify(cross),/OTHER_RUN_MUST_NOT_LEAK|SYNTHETIC_EXPECTED_RED_SIGNATURE/);
    await client.query("update workflow_runs set evaluation_metadata=$2 where id=$1", [current,JSON.stringify({replayOfRunId:"invalid-uuid"})]);
    await loadStageContext(client,current); // malformed lineage must not crash the worker
  } finally { await client.end(); }
});
