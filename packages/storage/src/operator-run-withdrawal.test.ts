import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {withClient} from "./client.js";
import {acceptanceDigest} from "./acceptance.js";
import {WITHDRAW_RUN_CONFIRMATION,withdrawUnacceptedRunOnClient} from "./operator-run-withdrawal.js";

async function fixture(check:(state:{client:import('pg').Client;input:Parameters<typeof withdrawUnacceptedRunOnClient>[1]})=>Promise<void>){
 await withClient(async client=>{await client.query('begin');try{
  const schema='withdrawal_'+randomUUID().replaceAll('-','');
  await client.query(`create schema ${schema};set local search_path to ${schema},public;
   create table workflow_runs(id uuid primary key,project_id uuid,task text,status text,evaluation_metadata jsonb);
   create table workflow_tasks(run_id uuid,status text);
   create table action_approvals(run_id uuid,status text);
   create table queue_coordinator_assignments(source_run_id uuid,child_run_id uuid,state text);
   create table side_effect_receipts(project_id text,status text);
   create table work_intents(project_id text,owner text,fencing_token bigint,expires_at timestamptz,file_scopes jsonb);
   create table artifacts(run_id uuid,kind text,uri text unique,content jsonb);
   create table action_receipts(run_id uuid,agent_id text,action_type text,target text,summary text,metadata jsonb,prev_hash text,receipt_hash text,created_at timestamptz,metadata_serialization_version int);`);
  const input={projectId:randomUUID(),runId:randomUUID(),originatingThreadId:randomUUID(),originalTaskDigest:acceptanceDigest('Synthetic disposable test'),owner:'synthetic-operator',intentFence:'1',actor:'Human via client',instruction:'Discard this failed synthetic test and recreate after fixes.',confirmation:WITHDRAW_RUN_CONFIRMATION};
  await client.query("insert into workflow_runs values($1,$2,'Synthetic disposable test','blocked',$3)",[input.runId,input.projectId,JSON.stringify({codexThreadId:input.originatingThreadId})]);
  await client.query("insert into work_intents values($1,$2,1,now()+interval '1 minute',$3)",[input.projectId,input.owner,JSON.stringify([`runtime/withdrawals/${input.runId}`])]);
  await check({client,input});
 }finally{await client.query('rollback');}});
}
test('explicit withdrawal preserves unsuccessful terminal history and records no acceptance or replay grant',()=>fixture(async({client,input})=>{
 const before=(await client.query('select * from workflow_runs')).rows;
 const uri=await withdrawUnacceptedRunOnClient(client,input);assert.equal(await withdrawUnacceptedRunOnClient(client,input),uri);
 assert.deepEqual((await client.query('select * from workflow_runs')).rows,before);
 const rows=(await client.query('select metadata from action_receipts')).rows;assert.equal(rows.length,1);
 assert.equal(rows[0].metadata.disposition,'withdrawn-unaccepted');assert.equal(rows[0].metadata.originalAcceptanceChanged,false);assert.equal(rows[0].metadata.executionAuthorityGranted,false);
}));
for(const name of ['foreign-origin','task-drift','expired-intent','pending-approval','active-owner','uncertain-effect','completed'] as const)test(`withdrawal refuses ${name}`,()=>fixture(async({client,input})=>{
 if(name==='foreign-origin')input.originatingThreadId=randomUUID();
 if(name==='task-drift')input.originalTaskDigest=acceptanceDigest('Different task');
 if(name==='expired-intent')await client.query("update work_intents set expires_at=now()-interval '1 minute'");
 if(name==='pending-approval')await client.query("insert into action_approvals values($1,'pending')",[input.runId]);
 if(name==='active-owner')await client.query("insert into queue_coordinator_assignments values($1,null,'running')",[input.runId]);
 if(name==='uncertain-effect')await client.query("insert into side_effect_receipts values($1,'uncertain')",[input.runId]);
 if(name==='completed')await client.query("update workflow_runs set status='completed'");
 await assert.rejects(withdrawUnacceptedRunOnClient(client,input));
 assert.equal((await client.query('select count(*)::int n from artifacts')).rows[0].n,0);
}));
