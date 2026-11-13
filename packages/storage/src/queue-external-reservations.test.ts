import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {deriveQueueAdmissionPressure} from '../../../apps/cli/src/lib/queue-admission-control.js';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {withClient} from './client.js';
import {acceptanceDigest} from './acceptance.js';
import {appendActionReceipt} from './receipt-writer.js';
import {queueCoordinatorSchemaSql,queueWorkingOccupancyOnClient} from './queue-coordinator.js';
import {registerExternalQueueReservationOnClient,listActiveExternalQueueReservationsOnClient,externalQueueReservationOccupancyOnClient,type ExternalQueueReservationInput} from './queue-external-reservations.js';

test('even an oversized worker cannot advertise more than five new shared slots',()=>{
 const now=Date.parse('2026-10-27T12:00:00Z');
 assert.equal(deriveQueueAdmissionPressure({storageReady:true,activeTasks:0,now,worker:{status:'running',lastHeartbeatAt:new Date(now).toISOString(),providerIds:['synthetic-provider'],concurrency:7}}).newItemLimit,5);
});

async function setup(c:Client,schema:string){await c.query(`create schema ${schema};set search_path to ${schema},public;
 create table projects(id uuid primary key,root_uri text);
 create table workflow_runs(id uuid primary key,project_id uuid,run_set_id uuid,task text,status text,evaluation_metadata jsonb);
 create table workflow_tasks(id uuid primary key,run_id uuid,status text);
 create table project_identity_locations(project_id uuid,identity_id uuid,kind text);
 create table work_intents(project_id text,owner text,fencing_token bigint,file_scopes jsonb,expires_at timestamptz,id uuid default gen_random_uuid());
 create table action_approvals(id uuid,run_id uuid,status text);
 create table action_receipts(id uuid default gen_random_uuid(),run_id uuid,agent_id text,action_type text,target text,summary text,metadata jsonb,prev_hash text,receipt_hash text,created_at timestamptz,metadata_serialization_version int);
 create table artifacts(id uuid default gen_random_uuid(),run_id uuid,task_id uuid,kind text,uri text,content jsonb,created_at timestamptz default clock_timestamp());`);await c.query(queueCoordinatorSchemaSql);}
async function make(c:Client,role:'repair'|'verifier'='repair',fileScopes=['src/feature.ts']){
 const projectId=randomUUID(),sourceRunId=randomUUID(),set=randomUUID(),owner=`synthetic-owner:${randomUUID()}`,projectRootUri='/synthetic/canonical';
 await c.query('insert into projects values($1,$2)',[projectId,projectRootUri]);await c.query("insert into project_identity_locations values($1,$1,'canonical')",[projectId]);
 await c.query("insert into workflow_runs values($1,$2,$3,'Original synthetic task','blocked','{}')",[sourceRunId,projectId,set]);
 const intentId=(await c.query("insert into work_intents(project_id,owner,fencing_token,file_scopes,expires_at) values($1,$2,9,$3,clock_timestamp()+interval '10 minutes') returning id::text",[projectId,owner,JSON.stringify(fileScopes)])).rows[0].id;
 const authorizationArtifactUri=`db://workflow_runs/${sourceRunId}/queue_external_reservation_authorization/${randomUUID()}`;
 const input={sourceRunId,projectId,projectRootUri,familyId:`${projectId}:${set}`,owner,intentId,intentFence:'9',fileScopes,role,authorizationArtifactUri};
 const authorization={version:1,purpose:'restrictive-external-queue-reservation',authority:'direct-human',approvalDecision:'approved',authorizationId:randomUUID(),approvalEvidence:'Direct human explicitly requested a restrictive bound for the existing owner.',restrictiveOnly:true,grantsExecution:false,...input,taskHash:acceptanceDigest('Original synthetic task'),expiresAt:new Date(Date.now()+300_000).toISOString()};
 await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'queue_external_reservation_authorization',$2,$3::jsonb)",[sourceRunId,authorizationArtifactUri,JSON.stringify(authorization)]);
 await appendActionReceipt(c,{runId:sourceRunId,agentId:'workflow-orchestrator',actionType:'queue_external_reservation_authorized',target:authorizationArtifactUri,summary:'Synthetic direct-human restrictive reservation authorization.',metadata:JSON.stringify(authorization)});
 return {input,authorization};
}
async function fixture(body:(c:Client)=>Promise<void>){await withClient(async c=>{await c.query('begin');try{await setup(c,`external_reservation_test_${randomUUID().replaceAll('-','')}`);await body(c);}finally{await c.query('rollback');}});}

test('only exact audited canonical source-owner bindings reserve capacity, never execution or working proof',()=>fixture(async c=>{
 const {input}=await make(c),before=(await c.query('select * from workflow_runs order by id')).rows;
 assert.equal(await registerExternalQueueReservationOnClient(c,{...input,owner:'unrelated'}),null);
 assert.equal(await registerExternalQueueReservationOnClient(c,{...input,intentFence:'8'}),null);
 assert.equal(await registerExternalQueueReservationOnClient(c,{...input,projectId:randomUUID()}),null);
 assert.equal(await registerExternalQueueReservationOnClient(c,{...input,fileScopes:['src/feature.ts','src/feature.ts']}),null);
 assert.equal(await registerExternalQueueReservationOnClient(c,{...input,fileScopes:['src/**']}),null);
 assert.equal(await registerExternalQueueReservationOnClient(c,{...input,role:'verifier'}),null);
 const reserved=await registerExternalQueueReservationOnClient(c,input);assert.ok(reserved);assert.equal(reserved.workingEvidence,false);assert.equal(reserved.grantsExecution,false);
 assert.equal(await registerExternalQueueReservationOnClient(c,input),null,'No repeated binding or new version family');
 assert.equal((await queueWorkingOccupancyOnClient(c)).count,1);
 assert.deepEqual((await c.query('select * from workflow_runs order by id')).rows,before,'Original statuses and contracts remain unchanged');
 assert.equal((await c.query('select count(*)::int n from action_approvals')).rows[0].n,0);
 const unrelated=await make(c);assert.equal((await queueWorkingOccupancyOnClient(c)).count,1,'Unbound live intent is not counted');
 await c.query("update work_intents set expires_at=clock_timestamp()-interval '1 second' where owner=$1",[input.owner]);
 assert.equal((await queueWorkingOccupancyOnClient(c)).count,0,'Expired external binding is not a working claim');
 assert.ok(await registerExternalQueueReservationOnClient(c,unrelated.input),'Unrelated source can receive its own exact restrictive binding');
}));

test('exact assignment-backed owner/fence/scope/role is counted once; uncertain assignment remains reserved',()=>fixture(async c=>{
 const {input}=await make(c);assert.ok(await registerExternalQueueReservationOnClient(c,input));
 await c.query("insert into queue_coordinator_assignments(id,family_id,project_id,source_run_id,role,lane,owner,fingerprint,intent_fence,file_scopes,state) values($1,$2,$3,$4,$5,1,$6,'synthetic-failure',$7,$8,'uncertain')",[randomUUID(),input.familyId,input.projectId,input.sourceRunId,input.role,input.owner,input.intentFence,JSON.stringify(input.fileScopes)]);
 assert.equal((await externalQueueReservationOccupancyOnClient(c)).count,1,'Historical assignment without authentic intent-instance proof is conservatively counted separately');
 const q=(await c.query('select id::text,fence::text from queue_coordinator_assignments')).rows[0];
 await appendActionReceipt(c,{runId:input.sourceRunId,agentId:'workflow-orchestrator',actionType:'queue_coordinator_reserved',target:input.familyId,summary:'Different synthetic intent instance.',metadata:JSON.stringify({...input,intentId:randomUUID(),id:q.id,fence:q.fence,lane:1})});
 assert.equal((await externalQueueReservationOccupancyOnClient(c)).count,1,'Even authentic prose for a different intent instance cannot deduplicate ownership');
 await appendActionReceipt(c,{runId:input.sourceRunId,agentId:'workflow-orchestrator',actionType:'queue_coordinator_reserved',target:input.familyId,summary:'Synthetic exact assignment reservation.',metadata:JSON.stringify({...input,id:q.id,fence:q.fence,lane:1})});
 assert.equal((await externalQueueReservationOccupancyOnClient(c)).count,0);assert.equal((await queueWorkingOccupancyOnClient(c)).count,1);
 await c.query("update queue_coordinator_assignments set intent_fence='8'");assert.equal((await queueWorkingOccupancyOnClient(c)).count,2,'Different fence is not the same owner reservation');
 await c.query('update work_intents set expires_at=clock_timestamp()-interval \'1 second\'');assert.equal((await queueWorkingOccupancyOnClient(c)).count,1,'Uncertain coordinator assignment is not released on intent expiry');
}));

test('reviewed terminal artifact subtree scopes retain exact intent equality',()=>fixture(async c=>{
 const {input}=await make(c,'repair',['src/feature.ts','artifacts/review/**']);
 assert.ok(await registerExternalQueueReservationOnClient(c,input));
 assert.equal((await queueWorkingOccupancyOnClient(c)).count,1);
 for(const bad of ['/**','src/*','src/**/file','../artifacts/**','/absolute/**','C:/absolute/**','src//**','src/./**','src/../**','src/\n/**']){
  const malformed=await make(c,'repair',[bad]);
  assert.equal(await registerExternalQueueReservationOnClient(c,malformed.input),null,'Even exactly audited malformed scopes are denied');
 }
}));

test('released and recreated same-owner fence cannot revive an old intent-instance authorization',()=>fixture(async c=>{
 const {input,authorization}=await make(c);assert.ok(await registerExternalQueueReservationOnClient(c,input));
 await c.query('delete from work_intents where id=$1',[input.intentId]);
 const next=(await c.query("insert into work_intents(project_id,owner,fencing_token,file_scopes,expires_at) values($1,$2,9,$3,clock_timestamp()+interval '10 minutes') returning id::text",[input.projectId,input.owner,JSON.stringify(input.fileScopes)])).rows[0].id;
 assert.notEqual(next,input.intentId);
 assert.equal((await queueWorkingOccupancyOnClient(c)).count,0,'Old binding cannot revive after ABA');
 assert.equal(await registerExternalQueueReservationOnClient(c,{...input,intentId:next}),null,'New instance requires a fresh exact authorization');
 const nextInput={...input,intentId:next,authorizationArtifactUri:`db://synthetic/replacement-authorization/${randomUUID()}`};
 const nextAuthorization={...authorization,...nextInput,authorizationId:randomUUID()};
 await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'queue_external_reservation_authorization',$2,$3::jsonb)",[input.sourceRunId,nextInput.authorizationArtifactUri,JSON.stringify(nextAuthorization)]);
 await appendActionReceipt(c,{runId:input.sourceRunId,agentId:'workflow-orchestrator',actionType:'queue_external_reservation_authorized',target:nextInput.authorizationArtifactUri,summary:'Synthetic prospective instance-specific authorization.',metadata:JSON.stringify(nextAuthorization)});
 assert.ok(await registerExternalQueueReservationOnClient(c,nextInput));
 assert.deepEqual((await listActiveExternalQueueReservationsOnClient(c)).map(b=>b.intentId),[next]);
}));

test('CLI reports the same shared five-slot bound it enforces',async()=>{
 const source=await readFile(new URL('../../../apps/cli/src/commands/queue-coordinator.ts',import.meta.url),'utf8');
 assert.doesNotMatch(source,/repairLanes:7|stretch:7|up to 7/u);
 assert.match(source,/repairLanes:QUEUE_SHARED_ITEM_LIMIT/u);
});

test('forged, cross-project, expired and overlong authorization cannot reserve, and corrupt proof fails closed',()=>fixture(async c=>{
 const {input,authorization}=await make(c);
 async function mutation(content:unknown){await c.query('savepoint forged');try{await c.query('update artifacts set content=$2 where uri=$1',[input.authorizationArtifactUri,JSON.stringify(content)]);assert.equal(await registerExternalQueueReservationOnClient(c,input),null);}finally{await c.query('rollback to savepoint forged');}}
 await mutation({...authorization,authority:'callback'});await mutation({...authorization,projectId:randomUUID()});await mutation({...authorization,fileScopes:['other.ts']});await mutation({...authorization,expiresAt:new Date(Date.now()-1000).toISOString()});await mutation({...authorization,expiresAt:new Date(Date.now()+901_000).toISOString()});
 await c.query('savepoint corrupt');await c.query("update action_receipts set summary='forged proof'");await assert.rejects(registerExternalQueueReservationOnClient(c,input),/unverifiable/);await c.query('rollback to savepoint corrupt');
 await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'queue_external_reservation','db://forged',$2)",[input.sourceRunId,JSON.stringify({...input,version:1,id:randomUUID(),expiresAt:authorization.expiresAt,authorizationDigest:acceptanceDigest(authorization),restrictiveOnly:true,grantsExecution:false,workingEvidence:false})]);
 assert.equal((await listActiveExternalQueueReservationsOnClient(c)).length,0,'Unaudited binding grants no reservation');
}));

test('verifier is inside the shared five and external families cannot reserve twice',()=>fixture(async c=>{
 const verifier=await make(c,'verifier');assert.ok(await registerExternalQueueReservationOnClient(c,verifier.input));
 const second=await make(c,'verifier');assert.equal(await registerExternalQueueReservationOnClient(c,second.input),null);
 for(let i=0;i<4;i++){const repair=await make(c);assert.ok(await registerExternalQueueReservationOnClient(c,repair.input));}
 assert.equal((await queueWorkingOccupancyOnClient(c)).count,5);
 assert.equal(await registerExternalQueueReservationOnClient(c,(await make(c)).input),null,'Sixth owner never admitted');
}));

test('two concurrent registrations share the existing admission lock and cannot admit a sixth owner',async()=>{
 const schema=`external_capacity_race_${randomUUID().replaceAll('-','')}`;
 await withClient(async c=>{
  assert.match((await c.query('select current_database() name')).rows[0].name,/^agentflow_suite_test_[a-f0-9]{32}$/u,'Race fixture requires the exact UUID disposable suite database');
  await setup(c,schema);
  try{
   await c.query('begin');for(let i=0;i<4;i++)assert.ok(await registerExternalQueueReservationOnClient(c,(await make(c)).input));
   const a=await make(c),b=await make(c);await c.query('commit');
   const attempt=(input:ExternalQueueReservationInput)=>withClient(async client=>{await client.query('begin');try{await client.query(`set local search_path to ${schema},public`);const value=await registerExternalQueueReservationOnClient(client,input);await client.query('commit');return value;}catch(error){await client.query('rollback');throw error;}});
   const results=await Promise.all([attempt(a.input),attempt(b.input)]);assert.equal(results.filter(Boolean).length,1);
   assert.equal((await queueWorkingOccupancyOnClient(c)).count,5);assert.equal((await c.query("select count(*)::int n from workflow_runs where status<>'blocked'")).rows[0].n,0);
  }finally{await c.query('rollback');await c.query(`set search_path to public;drop schema ${schema} cascade`);}
 });
});
