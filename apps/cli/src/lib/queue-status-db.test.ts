import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {withClient} from '../../../../packages/storage/src/client.js';
import {queueDecisionReadSql} from './queue-status.js';

test('family-local history selects newest exact receipted evidence and rejects forged or foreign observations',async()=>withClient(async c=>{
 await c.query('begin');
 try{
  await c.query(`create temporary table workflow_runs(id uuid,project_id uuid,run_set_id uuid);
   create temporary table artifacts(run_id uuid,kind text,content jsonb,created_at timestamptz,uri text);
   create temporary table action_receipts(run_id uuid,agent_id text,action_type text,target text,metadata_serialization_version int,metadata jsonb);`);
  const project=randomUUID(),run=randomUUID(),set=randomUUID(),foreign=randomUUID();
  await c.query('insert into workflow_runs values($1,$2,$3),($4,$2,$3)',[run,project,set,foreign]);
  const content=(id:string,label:string)=>({version:1,authority:'evidence-only',projectId:project,runId:id,familyId:project+':'+set,decision:label});
  const add=async(id:string,label:string,second:number,receipt:boolean)=>{
   const value=content(id,label);
   await c.query("insert into artifacts values($1,'queue_partner_decision',$2,'2026-01-01T00:00:00Z'::timestamptz+($3::int*interval '1 second'),$4)",[id,value,second,label]);
   if(receipt)await c.query("insert into action_receipts values($1,'workflow-orchestrator','queue_partner_decision',$2,2,$3)",[id,project+':'+set,value]);
  };
  const read=async()=>c.query(`select decision.content from (select $2::uuid[] members) qf left join lateral(${queueDecisionReadSql}) decision on true`,[project,[run]]);
  await add(run,'older-valid',1,true);await add(run,'newer-unreceipted',2,false);await add(foreign,'foreign-member',3,true);
  assert.equal((await read()).rows[0].content.decision,'older-valid');
  await add(run,'newest-valid',4,true);
  assert.equal((await read()).rows[0].content.decision,'newest-valid');
  await c.query("update action_receipts set metadata_serialization_version=1 where metadata->>'decision'='newest-valid'");
  assert.equal((await read()).rows[0].content.decision,'older-valid');
  await c.query('delete from action_receipts');assert.equal((await read()).rows[0].content,null);
 }finally{await c.query('rollback');}
}));
