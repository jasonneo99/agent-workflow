import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import YAML from 'yaml';
import {createHash} from 'node:crypto';
import {sourceSubjectHash} from '../../workflow-engine/src/source-subject.js';
import type {Client} from 'pg';
import {withClient} from './client.js';
import {appendActionReceipt} from './receipt-writer.js';
import {queueCoordinatorSchemaSql,queueWorkingOccupancyOnClient} from './queue-coordinator.js';
import {coordinatorClaimFenceSql} from './coordinator-claim-fence.js';
import {reservePartnerReasoningOnClient} from './queue-partner-reasoning.js';
import {authorizeAndHandoffPartnerChildOnClient,handoffReadOnlyPartnerChildOnClient,partnerReadOnlyHandoffEvidenceOnClient} from './queue-partner-continuation.js';
import {acceptanceDigest} from './acceptance.js';
import {loadProjectConfig} from '../../agent-registry/src/loaders.js';
import {canonicalJsonHash,resolveExecutionPolicy} from '../../policy-engine/src/index.js';

async function fixture(body:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>,effectful=false){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'partner-handoff-')));
 try{
  await fs.mkdir(path.join(root,'.agent-workflow'));
  if(effectful){await fs.mkdir(path.join(root,'tests'));await fs.writeFile(path.join(root,'tests/test_example.py'),'# before\n');}
  await fs.writeFile(path.join(root,'.agent-workflow/project.yaml'),YAML.stringify({project:{name:'Synthetic handoff',autonomy:2},actions:{allowed_write_paths:effectful?['tests/test_example.py']:[],allowed_commands:[],approval_rules:[{id:'unrelated-project-rule',effect:'auto_execute',action_type:'file_write',target:'docs/unrelated.md'}]}}));
  await withClient(async c=>{await c.query('begin');try{await body(await setup(c,root,effectful));}finally{await c.query('rollback');}});
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
async function setup(c:Client,root:string,effectful=false){
 const schema=`partner_handoff_${randomUUID().replaceAll('-','')}`;
 await c.query(`create schema ${schema};set local search_path to ${schema},public;
  create table projects(id uuid primary key,root_uri text);
  create table workflow_runs(id uuid primary key,project_id uuid,run_set_id uuid,task text,status text,policy_profile text,evaluation_metadata jsonb,
   policy_snapshot jsonb,policy_snapshot_hash text,lease_owner text,lease_epoch bigint default 0,lease_expires_at timestamptz,requester_channel text);
  create table workflow_tasks(id uuid primary key,run_id uuid,status text,worker_id text,lease_generation bigint default 1,lease_expires_at timestamptz,available_at timestamptz,stage_id text default 'specialist-task');
  create table project_identity_locations(project_id uuid,identity_id uuid,kind text);
  create table work_intents(project_id text,owner text,fencing_token bigint,file_scopes jsonb,expires_at timestamptz);
  create table action_approvals(id uuid,run_id uuid,status text);
  create table action_receipts(id uuid default gen_random_uuid(),run_id uuid,agent_id text,action_type text,target text,summary text,metadata jsonb,prev_hash text,receipt_hash text,created_at timestamptz,metadata_serialization_version int);
  create table artifacts(id uuid default gen_random_uuid(),run_id uuid,task_id uuid,kind text,uri text,content jsonb,created_at timestamptz default clock_timestamp());
  create table side_effect_receipts(project_id text,idempotency_key text,status text,operation text,target text,receipt jsonb);
  create table run_notifications(id uuid primary key default gen_random_uuid(),run_id uuid,channel text,kind text,title text,body text,event_key text,origin_task_id text,created_at timestamptz);
  create unique index fixture_notification_identity on run_notifications(run_id,channel,event_key) where event_key is not null`);
 await c.query(queueCoordinatorSchemaSql);await c.query(coordinatorClaimFenceSql);
 const projectId=randomUUID(),sourceRunId=randomUUID(),set=randomUUID(),child=randomUUID(),task=randomUUID(),oldOwner='synthetic-prior-owner';
 const sourceTask='Recover a synthetic dormant capability',writePaths=effectful?['tests/test_example.py']:[],scopes=effectful?writePaths:[`runtime/queue-partner/recovery/${sourceRunId}`];
 const subjectHash=effectful?await sourceSubjectHash(root,writePaths):null;
 await c.query('insert into projects values($1,$2)',[projectId,root]);
 await c.query("insert into project_identity_locations values($1,$1,'canonical')",[projectId]);
 await c.query("insert into workflow_runs(id,project_id,run_set_id,task,status,policy_profile,evaluation_metadata) values($1,$2,$3,$4,'blocked','local','{}')",[sourceRunId,projectId,set,sourceTask]);
 await c.query("insert into work_intents values($1,$2,7,$3,clock_timestamp()+interval '10 minutes')",[projectId,oldOwner,JSON.stringify(scopes)]);
 const policyHash=canonicalJsonHash(resolveExecutionPolicy(await loadProjectConfig(root),'local').project);
 const claim=await reservePartnerReasoningOnClient(c,{projectId,projectRootUri:root,sourceRunId,familyId:`${projectId}:${set}`,owner:oldOwner,intentFence:'7',
  fileScopes:scopes,writePaths,sourceHash:subjectHash,taskHash:acceptanceDigest(sourceTask),policyHash,fingerprint:acceptanceDigest(sourceTask)});assert.ok(claim);
 const metadata={source:'queue-partner-recovery',sourceRunId,queueCoordinatorClaimId:claim.id,queueCoordinatorFence:claim.fence,
  recoveryTaskHash:acceptanceDigest(sourceTask),recoveryWritePaths:writePaths,recoverySubjectHash:subjectHash,workIntent:{owner:oldOwner,fencingToken:'7'}};
 const snapshot={actions:{allowed_commands:[],allowed_write_paths:writePaths,isolate_command_writes:true,approval_rules:[{id:'unrelated-project-rule',effect:'auto_execute',action_type:'file_write',target:'docs/unrelated.md'}]}};
 await c.query("insert into workflow_runs(id,project_id,run_set_id,task,status,policy_profile,evaluation_metadata,policy_snapshot,policy_snapshot_hash) values($1,$2,$3,'Discover','running','local',$4,$5,$6)",
  [child,projectId,randomUUID(),JSON.stringify(metadata),JSON.stringify(snapshot),canonicalJsonHash(snapshot)]);
 await c.query("insert into workflow_tasks(id,run_id,status,available_at) values($1,$2,'queued',clock_timestamp()-interval '1 second')",[task,child]);
 await c.query("update queue_coordinator_assignments set child_run_id=$2,state='uncertain',reason='Interrupted read-only checkpoint' where id=$1",[claim.id,child]);
 await c.query("update work_intents set expires_at=clock_timestamp()-interval '1 second' where owner=$1",[oldOwner]);
 await appendActionReceipt(c,{runId:child,agentId:'queue-partner',actionType:'file_read',target:'synthetic.ts',summary:'Actual synthetic read-only evidence',metadata:'{}'});
 if(effectful){
  const relative='tests/test_example.py',previousHash=createHash('sha256').update('# before\n').digest('hex'),nextHash=createHash('sha256').update('# after\n').digest('hex');
  await fs.writeFile(path.join(root,relative),'# after\n');
  const key='a'.repeat(64),uri=`db://workflow_runs/${child}/file_write/${key}`;
  const content={idempotencyKey:key,mode:'patch',existed:true,outcome:'applied',projectRoot:root,relativePath:relative,previousHash,expectedHash:previousHash,nextHash,
   requestedByTaskId:task,requestedByStageId:'specialist-task'};
  await appendActionReceipt(c,{runId:child,agentId:'queue-partner',actionType:'file_write',target:relative,summary:'Finalized synthetic preimage-checked patch',metadata:JSON.stringify(content)});
  await c.query("insert into artifacts(run_id,task_id,kind,uri,content) values($1,$2,'file_write',$3,$4)",[child,task,uri,JSON.stringify(content)]);
  await c.query("insert into side_effect_receipts values($1,$2,'completed','file_write',$3,$4)",[child,key,relative,JSON.stringify({artifactUri:uri,path:relative,nextHash})]);
  await c.query("insert into artifacts(run_id,task_id,kind,uri,content) values($1,$2,'stage_continuation',$3,$4)",[child,task,`db://workflow_tasks/${task}/continuation`,JSON.stringify({round:1,verifyRetryRound:1,actionResults:[],fileReads:[{path:relative,content:'# before\n'}],pendingOutput:{requestedCommands:[],requestedFileWrites:[]}})]);
 }
 const authorize=async(owner='synthetic-new-owner')=>{
  const current=(await c.query('select owner,intent_fence from queue_coordinator_assignments where id=$1',[claim.id])).rows[0];
  await c.query("insert into work_intents values($1,$2,9,$3,clock_timestamp()+interval '10 minutes')",[projectId,owner,JSON.stringify(scopes)]);
  const observed=await partnerReadOnlyHandoffEvidenceOnClient(c,child),authorizationUri=`db://synthetic/handoff/${randomUUID()}`;
  const authorization={...observed,purpose:'resume-existing-read-only-partner-child',assignmentId:claim.id,fence:claim.fence,childRunId:child,
   projectId,owner,intentFence:'9',priorOwner:current.owner,priorIntentFence:current.intent_fence,taskId:task,leaseGeneration:'1',policyHash,
   approvalRulesHash:canonicalJsonHash(snapshot.actions.approval_rules),
   originalAcceptanceChanged:false,priorWorkersQuiescent:true};
  await appendActionReceipt(c,{runId:sourceRunId,agentId:'workflow-orchestrator',actionType:'operator_partner_read_only_handoff_authorized',target:claim.id,summary:'Prospective synthetic operator grant',metadata:JSON.stringify(authorization)});
  await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'queue_partner_read_only_handoff_authorization',$2,$3)",[sourceRunId,authorizationUri,JSON.stringify(authorization)]);
  return {assignmentId:claim.id,fence:claim.fence,childRunId:child,owner,intentFence:'9',authorizationUri};
 };
 return {c,root,projectId,sourceRunId,child,task,oldOwner,scopes,claim,authorize};
}

test('read-only handoff retains immutable snapshots and capacity, while actual SQL claim triggers reject the old worker',async()=>fixture(async f=>{
 const {c}=f,before=(await c.query('select * from workflow_runs order by id')).rows,request=await f.authorize();
 assert.equal((await queueWorkingOccupancyOnClient(c)).count,1);
 const grant=await handoffReadOnlyPartnerChildOnClient(c,request);assert.ok(grant);
 assert.equal(grant.claim.id,f.claim.id);assert.equal(grant.claim.fence,f.claim.fence);assert.equal(grant.claim.owner,request.owner);
 assert.equal((await queueWorkingOccupancyOnClient(c)).count,1);
 assert.deepEqual((await c.query('select * from workflow_runs order by id')).rows,before);
 await c.query('savepoint stale_worker');
 await assert.rejects(()=>c.query("update workflow_tasks set status='leased',worker_id=$2,lease_generation=2,lease_expires_at=clock_timestamp()+interval '1 minute' where id=$1",
  [f.task,`${f.oldOwner}:${f.claim.fence}`]),/exact live authorized worker/);
 await c.query('rollback to savepoint stale_worker;release savepoint stale_worker');
 await c.query("update workflow_tasks set status='leased',worker_id=$2,lease_generation=2,lease_expires_at=clock_timestamp()+interval '1 minute' where id=$1",[f.task,`${request.owner}:${request.fence}`]);
 assert.equal((await c.query('select lease_generation::text from workflow_tasks where id=$1',[f.task])).rows[0].lease_generation,'2');
 assert.equal(await handoffReadOnlyPartnerChildOnClient(c,request),null,'The consumed authorization cannot hand off an active task again');
 assert.equal(Number((await c.query("select count(*) n from action_receipts where action_type='queue_partner_reasoning_reserved'")).rows[0].n),1,'Reservation budget was not refunded or reallocated');
}));

test('supervisor can atomically authorize the same no-effect child under a fresh intent without new action authority',async()=>fixture(async f=>{
 const owner='synthetic-supervisor-continuation';
 await f.c.query("insert into work_intents values($1,$2,12,$3,clock_timestamp()+interval '10 minutes')",[f.projectId,owner,JSON.stringify(f.scopes)]);
 const beforeRuns=(await f.c.query('select * from workflow_runs order by id')).rows;
 const grant=await authorizeAndHandoffPartnerChildOnClient(f.c,{assignmentId:f.claim.id,owner,intentFence:'12'});assert.ok(grant);
 assert.equal(grant.claim.id,f.claim.id);assert.equal(grant.claim.fence,f.claim.fence);assert.equal(grant.claim.owner,owner);
 assert.deepEqual((await f.c.query('select * from workflow_runs order by id')).rows,beforeRuns);
 const audit=(await f.c.query("select metadata from action_receipts where run_id=$1 and action_type='queue_partner_same_attempt_continuation_authorized'",[f.sourceRunId])).rows[0]?.metadata;
 assert.equal(audit?.authority,'same-attempt-fenced-continuation');assert.equal(audit?.originalAcceptanceChanged,false);
 assert.equal((await f.c.query("select count(*)::int n from action_receipts where run_id=$1 and action_type='queue_partner_reasoning_reserved'",[f.sourceRunId])).rows[0].n,1);
}));

test('handoff refuses live ownership, missing or changed intent/authority, mutable effects and stale task/checkpoint evidence',async()=>fixture(async f=>{
 const {c}=f,request=await f.authorize();
 const refused=async(change:()=>Promise<unknown>)=>{await c.query('savepoint refusal');try{await change();assert.equal(await handoffReadOnlyPartnerChildOnClient(c,request),null);}finally{await c.query('rollback to savepoint refusal;release savepoint refusal');}};
 assert.equal(await handoffReadOnlyPartnerChildOnClient(c,{...request,fence:'999'}),null);
 assert.equal(await handoffReadOnlyPartnerChildOnClient(c,{...request,owner:'foreign-owner'}),null);
 await refused(()=>c.query("update work_intents set expires_at=clock_timestamp()+interval '10 minutes' where owner=$1",[f.oldOwner]));
 await refused(()=>c.query("update work_intents set expires_at=clock_timestamp()-interval '1 second' where owner=$1",[request.owner]));
 await refused(()=>c.query("update work_intents set file_scopes='[\"foreign-scope\"]' where owner=$1",[request.owner]));
 await refused(()=>c.query("update artifacts set content='{}' where uri=$1",[request.authorizationUri]));
 await refused(()=>c.query("update action_receipts set summary='Modified authorization' where action_type='operator_partner_read_only_handoff_authorized'"));
 await refused(()=>c.query("update action_receipts set summary='Modified reservation' where action_type='queue_partner_reasoning_reserved'"));
 await refused(()=>c.query("update action_receipts set receipt_hash='broken' where run_id=$1",[f.child]));
 await refused(()=>c.query("update workflow_runs set status='completed' where id=$1",[f.child]));
 await refused(()=>c.query("update workflow_runs set status='running' where id=$1",[f.sourceRunId]));
 await refused(()=>c.query("update workflow_tasks set lease_generation=2 where id=$1",[f.task]));
 await refused(()=>c.query("update workflow_tasks set available_at=clock_timestamp()+interval '1 minute' where id=$1",[f.task]));
 await refused(()=>c.query("insert into action_approvals values($1,$2,'executing')",[randomUUID(),f.child]));
 await refused(()=>c.query("insert into action_approvals values($1,$2,'pending')",[randomUUID(),f.sourceRunId]));
 await refused(()=>c.query("insert into action_approvals values($1,$2,'approved')",[randomUUID(),f.sourceRunId]));
 await refused(async()=>{
  const snapshot={actions:{allowed_commands:[],allowed_write_paths:[],approval_rules:[{id:'unsafe-override',effect:'auto_execute',action_type:'file_write',target:'**'}]}};
  await c.query('update workflow_runs set policy_snapshot=$2,policy_snapshot_hash=$3 where id=$1',[f.child,JSON.stringify(snapshot),canonicalJsonHash(snapshot)]);
 });
 await refused(()=>c.query("update workflow_runs set policy_snapshot=jsonb_set(policy_snapshot,'{actions,allowed_commands}','[\"unsafe command\"]') where id=$1",[f.child]));
 await refused(()=>c.query("update workflow_runs set evaluation_metadata=jsonb_set(evaluation_metadata,'{workIntent,owner}','\"foreign\"') where id=$1",[f.child]));
 await refused(()=>appendActionReceipt(c,{runId:f.child,agentId:'queue-partner',actionType:'file_write',target:'synthetic.ts',summary:'A writer cannot use a read-only handoff',metadata:'{}'}));
 await refused(()=>appendActionReceipt(c,{runId:f.child,agentId:'queue-partner',actionType:'local_command',target:'synthetic command',summary:'A command cannot use a read-only handoff',metadata:'{}'}));
 await refused(()=>c.query("insert into artifacts(run_id,task_id,kind,uri,content) values($1,$2,'stage_continuation','db://synthetic/new-checkpoint','{\"round\":1}')",[f.child,f.task]));
 assert.ok(await handoffReadOnlyPartnerChildOnClient(c,request));
}));

test('intent expiry at the ownership effect refuses the handoff without changing the assignment',async()=>fixture(async f=>{
 const request=await f.authorize(),before=(await f.c.query('select * from queue_coordinator_assignments where id=$1',[f.claim.id])).rows[0];
 const guarded=new Proxy(f.c,{get(target,key){
  if(key==='query')return async(sql:any,...args:any[])=>{
   if(typeof sql==='string'&&sql.startsWith('update queue_coordinator_assignments set owner='))
    await target.query("update work_intents set expires_at=clock_timestamp()-interval '1 second' where owner=$1",[request.owner]);
   return (target.query as any)(sql,...args);
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 assert.equal(await handoffReadOnlyPartnerChildOnClient(guarded,request),null);
 assert.deepEqual((await f.c.query('select * from queue_coordinator_assignments where id=$1',[f.claim.id])).rows[0],before);
 assert.equal((await f.c.query("select 1 from action_receipts where action_type='queue_partner_read_only_continuation_granted'")).rowCount,0);
}));

test('handoff observes an existing bounded checkpoint without upgrading its missing historical payload provenance',async()=>fixture(async f=>{
 const checkpoint={round:1,actionResults:[{type:'file_read',path:'synthetic.ts'}],pendingOutput:{requestedCommands:[],requestedFileWrites:[]}};
 await f.c.query("insert into artifacts(run_id,task_id,kind,uri,content) values($1,$2,'stage_continuation','db://synthetic/checkpoint',$3)",[f.child,f.task,JSON.stringify(checkpoint)]);
 const before=(await f.c.query("select * from artifacts where kind='stage_continuation'")).rows;
 const grant=await handoffReadOnlyPartnerChildOnClient(f.c,await f.authorize());assert.ok(grant);
 assert.deepEqual((await f.c.query("select * from artifacts where kind='stage_continuation'")).rows,before);
 const audit=(await f.c.query("select metadata from action_receipts where run_id=$1 and action_type='queue_partner_read_only_continuation_granted'",[f.child])).rows[0].metadata;
 assert.match(audit.checkpointProvenance,/historical URI-only receipt is not promoted/);assert.equal(audit.budgetRefunded,false);assert.equal(audit.snapshotsChanged,false);
}));

test('read-only continuation has a durable two-handoff breaker, independent of restarts or generated authorization IDs',async()=>fixture(async f=>{
 for(let i=0;i<2;i++){
  const request=await f.authorize(`synthetic-resumer-${i}`);assert.ok(await handoffReadOnlyPartnerChildOnClient(f.c,request));
  await f.c.query("update work_intents set expires_at=clock_timestamp()-interval '1 second' where owner=$1",[request.owner]);
 }
 assert.equal(await handoffReadOnlyPartnerChildOnClient(f.c,await f.authorize('synthetic-exhausted')),null);
 assert.equal(Number((await f.c.query("select count(*) n from action_receipts where run_id=$1 and action_type='queue_partner_read_only_continuation_granted'",[f.sourceRunId])).rows[0].n),2);
}));

test('finalized effects get a separate same-child reconciliation, with archived checkpoint and unchanged contracts/fences',async()=>fixture(async f=>{
 const beforeRuns=(await f.c.query('select * from workflow_runs order by id')).rows;
 const oldCheckpoint=(await f.c.query("select content from artifacts where run_id=$1 and kind='stage_continuation'",[f.child])).rows[0].content;
 const request=await f.authorize();assert.equal(await handoffReadOnlyPartnerChildOnClient(f.c,request),null,'The strict no-effect path must stay strict');
 const grant=await authorizeAndHandoffPartnerChildOnClient(f.c,{assignmentId:f.claim.id,owner:request.owner,intentFence:request.intentFence});assert.ok(grant);
 assert.equal(grant.childRunId,f.child);assert.equal(grant.claim.id,f.claim.id);assert.equal(grant.claim.fence,f.claim.fence);
 assert.deepEqual((await f.c.query('select * from workflow_runs order by id')).rows,beforeRuns);
 const archived=(await f.c.query("select content from artifacts where run_id=$1 and kind='queue_partner_checkpoint_history'",[f.child])).rows;
 assert.equal(archived.length,1);assert.deepEqual(archived[0].content.checkpoint,oldCheckpoint);
 const current=(await f.c.query("select content from artifacts where run_id=$1 and kind='stage_continuation'",[f.child])).rows[0].content;
 assert.equal(current.round,1);assert.equal(current.verifyRetryRound,1);assert.deepEqual(current.fileReads,[]);assert.equal(current.actionResults[0].type,'file_write');
 assert.equal((await f.c.query("select 1 from action_receipts where run_id=$1 and action_type='queue_partner_effect_continuation_granted'",[f.child])).rowCount,1);
 assert.equal((await f.c.query("select 1 from action_receipts where action_type='queue_partner_reasoning_reserved'")).rowCount,1);
 await f.c.query('savepoint obsolete_owner');
 await assert.rejects(()=>f.c.query("update workflow_tasks set status='leased',worker_id=$2,lease_generation=2,lease_expires_at=clock_timestamp()+interval '1 minute' where id=$1",[f.task,`${f.oldOwner}:${f.claim.fence}`]),/exact live authorized worker/);
 await f.c.query('rollback to savepoint obsolete_owner;release savepoint obsolete_owner');
 await f.c.query("update workflow_tasks set status='leased',worker_id=$2,lease_generation=2,lease_expires_at=clock_timestamp()+interval '1 minute' where id=$1",[f.task,`${request.owner}:${f.claim.fence}`]);
},true));

test('effect continuation refuses pending effects and approval races without changing ownership or checkpoint',async()=>fixture(async f=>{
 const request=await f.authorize(),before=(await f.c.query('select * from queue_coordinator_assignments where id=$1',[f.claim.id])).rows[0];
 await f.c.query('savepoint pending_effect');
 await f.c.query("update side_effect_receipts set status='pending'");
 assert.equal(await authorizeAndHandoffPartnerChildOnClient(f.c,{assignmentId:f.claim.id,owner:request.owner,intentFence:request.intentFence}),null);
 await f.c.query('rollback to savepoint pending_effect;release savepoint pending_effect');
 const guarded=new Proxy(f.c,{get(target,key){if(key==='query')return async(sql:any,...args:any[])=>{
  if(typeof sql==='string'&&sql.startsWith('update queue_coordinator_assignments set owner='))
   await target.query("insert into action_approvals values($1,$2,'approved')",[randomUUID(),f.sourceRunId]);
  return(target.query as any)(sql,...args);
 };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 assert.equal(await authorizeAndHandoffPartnerChildOnClient(guarded,{assignmentId:f.claim.id,owner:request.owner,intentFence:request.intentFence}),null);
 assert.deepEqual((await f.c.query('select * from queue_coordinator_assignments where id=$1',[f.claim.id])).rows[0],before);
 assert.equal((await f.c.query("select 1 from artifacts where kind='queue_partner_checkpoint_history'")).rowCount,0);
},true));

test('full-policy revocation between observation and reconciliation refuses ownership even with unchanged allowlists',async()=>fixture(async f=>{
 const request=await f.authorize(),before=(await f.c.query('select * from queue_coordinator_assignments where id=$1',[f.claim.id])).rows[0];
 const file=path.join(f.root,'.agent-workflow/project.yaml'),original=await fs.readFile(file,'utf8');let changed=false;
 const guarded=new Proxy(f.c,{get(target,key){if(key==='query')return async(sql:any,...args:any[])=>{
  if(!changed&&typeof sql==='string'&&sql.startsWith('select file_scopes from work_intents')){
   changed=true;const policy=YAML.parse(original);policy.actions.approval_rules=[];await fs.writeFile(file,YAML.stringify(policy));
  }
  return(target.query as any)(sql,...args);
 };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 try{assert.equal(await authorizeAndHandoffPartnerChildOnClient(guarded,{assignmentId:f.claim.id,owner:request.owner,intentFence:request.intentFence}),null);}
 finally{await fs.writeFile(file,original);}
 assert.equal(changed,true);assert.deepEqual((await f.c.query('select * from queue_coordinator_assignments where id=$1',[f.claim.id])).rows[0],before);
 assert.equal((await f.c.query("select 1 from artifacts where kind='queue_partner_checkpoint_history'")).rowCount,0);
},true));

test('handoff and approved policy writers share the real per-file advisory mutex',async()=>fixture(async f=>{
 const request=await f.authorize();assert.ok(await authorizeAndHandoffPartnerChildOnClient(f.c,{assignmentId:f.claim.id,owner:request.owner,intentFence:request.intentFence}));
 const key=`${f.root}:file:.agent-workflow/project.yaml`;
 await withClient(async other=>{const result=(await other.query('select pg_try_advisory_lock(hashtext($1)) acquired',[key])).rows[0].acquired;
  if(result)await other.query('select pg_advisory_unlock(hashtext($1))',[key]);assert.equal(result,false,'A cooperating policy writer cannot cross the ownership transaction');});
 const policyWriter=await fs.readFile(new URL('../../../apps/cli/src/lib/builders-shared.ts',import.meta.url),'utf8');
 assert.match(policyWriter,/withProjectExecutionLock\(\{projectRootUri:canonicalRoot,resource:'file:\.agent-workflow\/project\.yaml'\}/u);
 assert.match(policyWriter,/withProjectExecutionLock\(\{projectRootUri:canonicalProjectRoot,resource:`file:\$\{fileWrite\.request\.path/u);
},true));

test('effect continuation shares the durable two-handoff breaker without resetting execution rounds',async()=>fixture(async f=>{
 for(let i=0;i<2;i++){
  const request=await f.authorize(`effect-resumer-${i}`);
  assert.ok(await authorizeAndHandoffPartnerChildOnClient(f.c,{assignmentId:f.claim.id,owner:request.owner,intentFence:request.intentFence}));
  await f.c.query("update work_intents set expires_at=clock_timestamp()-interval '1 second' where owner=$1",[request.owner]);
 }
 const request=await f.authorize('effect-exhausted');
 assert.equal(await authorizeAndHandoffPartnerChildOnClient(f.c,{assignmentId:f.claim.id,owner:request.owner,intentFence:request.intentFence}),null);
 assert.equal((await f.c.query("select 1 from action_receipts where run_id=$1 and action_type='queue_partner_effect_continuation_granted'",[f.child])).rowCount,2);
 assert.equal((await f.c.query("select content->>'round' round from artifacts where run_id=$1 and kind='stage_continuation'",[f.child])).rows[0].round,'1');
},true));
