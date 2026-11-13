import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {withClient} from './client.js';
import {recordQueuePartnerDecisionOnClient,validateQueuePartnerDecision,type QueuePartnerDecision} from './queue-partner-decisions.js';

const decision=():QueuePartnerDecision=>{
 const projectId=randomUUID(),runId=randomUUID();
 return {projectId,runId,familyId:`${projectId}:${randomUUID()}`,decision:'held',state:'held',what:'A related family is held.',why:'Exact original evidence is missing.',how:'Preserve the original requirements and recover evidence.',next:'Inspect authentic original receipts before any repair.',requiresPermission:false,evidence:[{label:'Preserved family',url:`/runs?relatedTo=${runId}`}],provenance:{priority:0,sourcePathsCount:2,activeCount:0,pendingApprovalCount:0}};
};
test('decision narrative is bounded evidence, never arbitrary links or permission text',()=>{
 const d=decision();assert.doesNotThrow(()=>validateQueuePartnerDecision(d));
 for(const patch of [{what:''},{why:'x'.repeat(1601)},{requiresPermission:'yes'},{state:1},{evidence:[{label:'remote',url:'https://example.invalid/approval'}]},{provenance:{...d.provenance,activeCount:-1}}]){
  assert.throws(()=>validateQueuePartnerDecision({...d,...patch} as QueuePartnerDecision));
 }
});
test('actual PostgreSQL journal is append-only, scoped, intent-fenced, and quiet for unchanged decisions',async()=>{
 await withClient(async c=>{await c.query('begin');try{
  const schema='partner_activity_'+randomUUID().replaceAll('-','');
  await c.query(`create schema ${schema};set local search_path to ${schema},public;
   create table workflow_runs(id uuid primary key,project_id uuid,run_set_id uuid,status text);
   create table work_intents(project_id text,owner text,fencing_token bigint,file_scopes jsonb,expires_at timestamptz);
   create table artifacts(run_id uuid,kind text,uri text primary key,content jsonb,created_at timestamptz default clock_timestamp());
   create table action_receipts(id bigserial primary key,run_id uuid,agent_id text,action_type text,target text,summary text,
     metadata jsonb,prev_hash text,receipt_hash text,created_at timestamptz,metadata_serialization_version integer);`);
  const d=decision(),set=d.familyId.split(':')[1];
  await c.query("insert into workflow_runs values($1,$2,$3,'blocked')",[d.runId,d.projectId,set]);
  await c.query("insert into work_intents values($1,'journal',7,$2,clock_timestamp()+interval '2 minutes')",[d.projectId,JSON.stringify(['runtime/queue-partner/activity'])]);
  await assert.rejects(()=>recordQueuePartnerDecisionOnClient(c,d,{owner:'journal',fencingToken:'6'}),/intent lost/);
  await assert.rejects(()=>recordQueuePartnerDecisionOnClient(c,{...d,familyId:d.projectId+':'+randomUUID()},{owner:'journal',fencingToken:'7'}),/exact execution family/);
  const intent={owner:'journal',fencingToken:'7'};
  const first=await recordQueuePartnerDecisionOnClient(c,d,intent);assert.equal(first.recorded,true);
  const before=(await c.query('select content from artifacts where uri=$1',[first.uri])).rows[0].content;
  const repeat=await recordQueuePartnerDecisionOnClient(c,d,intent);assert.equal(repeat.recorded,false);assert.equal(repeat.uri,first.uri);
  const changed=await recordQueuePartnerDecisionOnClient(c,{...d,why:'The same family now needs a different exact evidence item.'},intent);assert.equal(changed.recorded,true);
  const reverted=await recordQueuePartnerDecisionOnClient(c,d,intent);assert.equal(reverted.recorded,true);assert.notEqual(reverted.uri,first.uri);
  assert.deepEqual((await c.query('select content from artifacts where uri=$1',[first.uri])).rows[0].content,before);
  assert.equal((await c.query('select count(*)::int n from artifacts')).rows[0].n,3);
  assert.equal((await c.query('select count(*)::int n from action_receipts')).rows[0].n,3);
  assert.equal((await c.query('select status from workflow_runs where id=$1',[d.runId])).rows[0].status,'blocked');
  const receipts=(await c.query('select prev_hash,receipt_hash,metadata from action_receipts order by created_at')).rows;
  assert.equal(receipts[1].prev_hash,receipts[0].receipt_hash);assert.equal(receipts[2].prev_hash,receipts[1].receipt_hash);
  assert.equal(receipts[0].metadata.authority,'evidence-only');assert.equal(receipts[0].metadata.requiresPermission,false);
  const outcome={...d,decision:'outcome' as const,state:'dependency-handoff',what:'Existing child needs technical reconciliation.'};
  assert.equal((await recordQueuePartnerDecisionOnClient(c,outcome,intent)).recorded,true);
  assert.equal((await recordQueuePartnerDecisionOnClient(c,{...d,decision:'active',state:'observed-active'},intent)).recorded,true);
  assert.equal((await recordQueuePartnerDecisionOnClient(c,d,intent)).recorded,true);
  assert.equal((await recordQueuePartnerDecisionOnClient(c,d,intent)).recorded,false);
  assert.equal((await recordQueuePartnerDecisionOnClient(c,outcome,intent)).recorded,false);
  assert.equal((await c.query('select count(*)::int n from artifacts')).rows[0].n,6);
  // Returning to an earlier state within that stream is still a real event.
  assert.equal((await recordQueuePartnerDecisionOnClient(c,{...outcome,state:'dependency-waiting'},intent)).recorded,true);
  assert.equal((await recordQueuePartnerDecisionOnClient(c,outcome,intent)).recorded,true);
 }finally{await c.query('rollback');}});
});
