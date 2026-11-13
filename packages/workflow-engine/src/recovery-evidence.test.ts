import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { databaseUrl } from "../../storage/src/client.js";
import { recoveryEvidence, recoveryLinks, recoveryText, recoveryExitCode } from "./recovery-evidence.js";

test("recovery links use only explicit durable metadata; summaries redact common credentials",()=>{
  const id="00000000-0000-4000-8000-000000000001";
  assert.deepEqual(recoveryLinks({sourceRunId:id,replayOfRunId:id,task:id,repairOriginRunId:"invalid"}),[id]);
  assert.deepEqual(recoveryLinks({task:`inspect ${id}`}),[]);
  assert.deepEqual(recoveryLinks({source:'server-orchestration',actorRole:'operator'},`Source items: review ${id} (cancelled).`),[id]);
  assert.deepEqual(recoveryLinks({},`Source items: review ${id} (cancelled).`),[]);
  assert.equal(recoveryText("API_KEY=private Bearer private sk-abcdefghijk",200),"API_KEY=[redacted] [redacted] [redacted]");
  assert.equal(recoveryText("abcdef",3),"abc");
  assert.equal(recoveryExitCode("1"),1);
  for(const value of [null,{},"private payload","9".repeat(20000),"2147483648","1.5"]) assert.equal(recoveryExitCode(value),null);
});

test("recovery packets include cancelled source evidence but deny cross-project content and cycles",async()=>{
  const client=new pg.Client({connectionString:databaseUrl()});
  const original=pg.Pool.prototype.connect;
  const root="00000000-0000-4000-8000-000000000001";
  const source="00000000-0000-4000-8000-000000000002";
  const foreign="00000000-0000-4000-8000-000000000003";
  try {
    await client.connect();
    await client.query("begin");
    await client.query(`CREATE TEMP TABLE projects(id uuid,root_uri text);
      CREATE TEMP TABLE workflow_runs(id uuid,project_id uuid,status text,task text,evaluation_metadata jsonb);
      CREATE TEMP TABLE action_receipts(run_id uuid,action_type text,summary text,created_at timestamptz);
      CREATE TEMP TABLE artifacts(run_id uuid,uri text,kind text,content jsonb,created_at timestamptz);`);
    pg.Pool.prototype.connect=(async()=>({query:client.query.bind(client),release(){}})) as unknown as typeof original;
    await client.query("INSERT INTO projects VALUES ($1,'/synthetic/project')",[root]);
    for(const [id,project,status,task,metadata] of [
      [root,root,'running','repair',{sourceRunId:source}],
      [source,root,'cancelled','original bounded task',{sourceRunId:foreign,replayOfRunId:root}],
      [foreign,foreign,'failed','FOREIGN PRIVATE CONTENT',{}]
    ]) await client.query("INSERT INTO workflow_runs VALUES ($1,$2,$3,$4,$5)",[id,project,status,task,JSON.stringify(metadata)]);
    await client.query("INSERT INTO action_receipts VALUES ($1,'stage_cancelled','Cancelled by operator',now())",[source]);
    await client.query("INSERT INTO artifacts VALUES ($1,'db://synthetic/output','command_output',$2,now())",[source,JSON.stringify({exitCode:1,stdout:'PRIVATE RAW OUTPUT',env:{SECRET:'private'}})]);
    for(const exitCode of ['OVERSIZED_PRIVATE'.repeat(2000),{PRIVATE_FIELD:'private'},1.5]) {
      await client.query("INSERT INTO artifacts VALUES ($1,'db://synthetic/malformed','command_output',$2,now())",[source,JSON.stringify({exitCode})]);
    }
    const packet=await recoveryEvidence(root,'/synthetic/project');
    assert.match(packet,/original bounded task/u);assert.match(packet,/Cancelled by operator/u);
    assert.match(packet,/db:\/\/synthetic\/output/u);assert.match(packet,/unavailable-or-out-of-project/u);
    assert.ok(!packet.includes('FOREIGN PRIVATE'));assert.ok(!packet.includes('PRIVATE RAW'));assert.ok(!packet.includes('SECRET'));
    assert.ok(!packet.includes('OVERSIZED_PRIVATE'));assert.ok(!packet.includes('PRIVATE_FIELD'));assert.match(packet,/"exitCode":null/u);
    assert.equal(await recoveryEvidence(root,'/synthetic/other'),"");
  } finally {
    pg.Pool.prototype.connect=original;
    await client.query("rollback").catch(()=>{});await client.end();
  }
});
