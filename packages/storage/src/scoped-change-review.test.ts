import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parse,stringify} from 'yaml';
import {withClient} from './client.js';
import {appendActionReceipt} from './receipt-writer.js';
import {acceptanceDigest,acceptancePreflight} from './acceptance.js';
import {sourceSubjectHash} from '../../workflow-engine/src/source-subject.js';
import {canonicalJsonHash,resolveExecutionPolicy} from '../../policy-engine/src/index.js';
import {projectConfigSchema} from '../../agent-registry/src/schemas.js';
import {reserveScopedChangeReviewOnClient as reserveOnClient,attachScopedChangeReviewOnClient as attachOnClient,scopedChangeReviewPolicy} from './scoped-change-review.js';
import {finishQueueCoordinatorOnClient} from './queue-coordinator.js';
import {coordinatorClaimFenceSql} from './coordinator-claim-fence.js';
import {verifyRunReceiptChainOnClient} from './postgres.js';
import {ENVIRONMENT_COMMAND} from '../../run-environments/src/schema.js';

test('scoped review policy removes writes/approval shortcuts, preserves unrelated restrictions',()=>{
 const original=projectConfigSchema.parse({project:{name:'review-fixture'},actions:{allowed_write_paths:['src/**'],allowed_commands:['npm run typecheck'],blocked_commands:['ssh *']}});
 const narrowed=scopedChangeReviewPolicy(original,['npm run typecheck']);
 assert.deepEqual(narrowed.actions.allowed_write_paths,[]);assert.deepEqual(narrowed.actions.approval_rules,[]);
 assert.equal(narrowed.actions.isolate_command_writes,true);assert.deepEqual(narrowed.actions.blocked_commands,['ssh *']);
 assert.deepEqual(original.actions.allowed_write_paths,['src/**']);
});

test('scoped reviews retain declared environment capability and only exact reviewed command permissions',()=>{
 const command='node --test tests/example.test.js';
 const original=projectConfigSchema.parse({project:{name:'review-fixture'},execution:{environments:{profiles:{test:{
  kind:'native',platform:'darwin/arm64',source_paths:['src/example.js'],readiness:[{argv:['node','--version']}]
 }}}},actions:{allowed_commands:[command,ENVIRONMENT_COMMAND,'node unrelated.js'],approval_rules:[
  {id:'broad',action_type:'local_command',target:'node *'},
  {id:'exact',action_type:'local_command',target:command},
  {id:'other',action_type:'local_command',target:'node unrelated.js'},
  {id:'writer',action_type:'file_write',target:'src/**'}
 ]}});
 const narrowed=scopedChangeReviewPolicy(original,[command]);
 assert.deepEqual(narrowed.actions.allowed_commands,[command,ENVIRONMENT_COMMAND]);
 assert.deepEqual(narrowed.actions.approval_rules.map(rule=>rule.id),['exact']);
 assert.deepEqual(narrowed.actions.allowed_write_paths,[]);
 assert.equal(narrowed.actions.isolate_command_writes,true);
 const undeclared=projectConfigSchema.parse({...original,execution:{...original.execution,environments:undefined}});
 assert.deepEqual(scopedChangeReviewPolicy(undeclared,[command]).actions.allowed_commands,[command]);
});

test('actual PostgreSQL scoped review preserves source history, single-verifier fencing and consumed grants',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'scoped-review-fixture-')));
 try{
  await fs.mkdir(path.join(root,'src'));await fs.mkdir(path.join(root,'.agent-workflow'));
  const sourceFile=path.join(root,'src/main.ts'),policyFile=path.join(root,'.agent-workflow/project.yaml');
  await fs.writeFile(sourceFile,'export const fixture = true;\n');
  const config=projectConfigSchema.parse({project:{name:'review-fixture',autonomy:3},actions:{allowed_write_paths:['src/**'],allowed_commands:['npm run typecheck','git diff --check'],blocked_commands:['ssh *']}});
  const policyText=stringify(config);await fs.writeFile(policyFile,policyText);
  const policy=resolveExecutionPolicy(config,'local').project;
  // Keep synthetic policy expectations independent of the host's global
  // trusted-command file, while still reading actual fixture policy changes.
  const hooks={load:async(dir:string)=>projectConfigSchema.parse(parse(await fs.readFile(path.join(dir,'.agent-workflow/project.yaml'),'utf8')))};
  const reserveScopedChangeReviewOnClient:typeof reserveOnClient=(client,input)=>reserveOnClient(client,input,hooks);
  const attachScopedChangeReviewOnClient:typeof attachOnClient=(client,claim,runId)=>attachOnClient(client,claim,runId,hooks);
  await withClient(async c=>{await c.query('begin');try{
   const schema='scoped_review_'+randomUUID().replaceAll('-','');
   await c.query(`create schema ${schema};set local search_path to ${schema},public;
    create table projects(id uuid primary key,root_uri text);
    create table project_identity_locations(project_id uuid,identity_id uuid,kind text);
    create table workflow_runs(id uuid primary key,project_id uuid,run_set_id uuid,task text,status text,policy_profile text default 'local',autonomy text default '3',workflow_snapshot jsonb default '{"stages":[{"agent":"test-engineer"}]}',evaluation_metadata jsonb default '{}',policy_snapshot jsonb default '{}',policy_snapshot_hash text,provider_override text,model_tier_override text,lease_owner text,lease_epoch bigint default 0,lease_expires_at timestamptz);
    create table workflow_tasks(id uuid primary key,run_id uuid,status text,started_at timestamptz,agent_id text default 'test-engineer',worker_id text,lease_generation bigint default 0,lease_expires_at timestamptz,stage_id text default 'verify');
    create table action_approvals(id uuid primary key,run_id uuid,status text);
    create table action_receipts(id uuid primary key default gen_random_uuid(),run_id uuid,agent_id text,action_type text,target text,summary text,metadata jsonb,prev_hash text,receipt_hash text,metadata_serialization_version int,created_at timestamptz default clock_timestamp());
    create table artifacts(id uuid primary key default gen_random_uuid(),run_id uuid,kind text,uri text,content jsonb,created_at timestamptz default clock_timestamp(),task_id uuid);
    create table work_intents(project_id text,owner text,fencing_token bigint,file_scopes jsonb,expires_at timestamptz);
    create table queue_coordinator_assignments(id uuid primary key,fence bigserial unique,family_id text,project_id uuid,source_run_id uuid,role text,lane int,owner text,fingerprint text,intent_fence text,file_scopes jsonb,state text,child_run_id uuid,reason text,legacy_enrollment_id uuid,created_at timestamptz default clock_timestamp(),updated_at timestamptz default clock_timestamp(),unique(family_id,role,fingerprint));
    create unique index one_active_family on queue_coordinator_assignments(family_id) where state in ('reserved','running','uncertain');
    create unique index one_active_lane on queue_coordinator_assignments(role,lane) where state in ('reserved','running','uncertain');`);
   const project=randomUUID(),source=randomUUID(),family=randomUUID(),reviewTask='Independently review the current bounded source change only.',paths=['src/main.ts'];
   await c.query('insert into projects values($1,$2)',[project,root]);await c.query("insert into project_identity_locations values($1,$1,'canonical')",[project]);
   await c.query("insert into workflow_runs(id,project_id,run_set_id,task,status,evaluation_metadata) values($1,$2,$3,'Original delivered outcome including native acceptance','blocked',$4)",[source,project,family,JSON.stringify({sourceRunId:randomUUID(),source:'workflow-root-repair'})]);
   const original=(await c.query('select * from workflow_runs where id=$1',[source])).rows[0];
   await c.query("insert into work_intents values($1,'independent-reviewer',1,$2,clock_timestamp()+interval '30 minutes')",[project,JSON.stringify(paths)]);
   await appendActionReceipt(c,{runId:source,agentId:'operator',actionType:'current_source_observed',target:source,summary:'Synthetic fresh observation, not historical acceptance.',metadata:'{}'});
   const authBase={version:1,purpose:'scoped-change-review',authority:'direct-human',approvalDecision:'approved',reviewLimit:1,offlineOnly:true,originalAcceptanceChanged:false,
    approvalEvidence:'Synthetic explicit instruction to independently review this current source correction.',sourceRunId:source,projectId:project,projectRootUri:root,familyId:`${project}:${family}`,
    taskHash:acceptanceDigest(original.task),sourceHash:await sourceSubjectHash(root,paths),policyHash:canonicalJsonHash(policy),reviewTaskHash:acceptanceDigest(reviewTask),reviewerAgentId:'test-engineer',sourcePaths:paths,reviewPaths:paths,authorizedCommands:['npm run typecheck','git diff --check']};
   const grant=async(patch:Record<string,unknown>={})=>{
    const a={...authBase,authorizationId:randomUUID(),...patch},uri=`db://workflow_runs/${source}/scoped_change_review_authorization/${randomUUID()}`;
    await appendActionReceipt(c,{runId:source,agentId:'operator',actionType:'scoped_change_review_authorized',target:uri,summary:'Synthetic bounded readonly review grant.',metadata:JSON.stringify(a)});
    await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'scoped_change_review_authorization',$2,$3)",[source,uri,JSON.stringify(a)]);
    return {sourceRunId:source,projectId:project,projectRootUri:root,familyId:`${project}:${family}`,owner:'independent-reviewer',intentFence:'1',authorizationArtifactUri:uri};
   };
   const input=await grant();
   for(const patch of [{authority:'model'},{approvalDecision:'pending'},{offlineOnly:false},{originalAcceptanceChanged:true},{reviewLimit:2},{sourceHash:'f'.repeat(64)},
    {policyHash:'f'.repeat(64)},{taskHash:'f'.repeat(64)},{reviewPaths:['unrelated.ts']},{sourcePaths:['.env']},{authorizedCommands:['node --eval untrusted']},
    {authorizedCommands:[]},{authorizedCommands:['git diff --check','git diff --check']},{reviewerAgentId:'implementation-agent'}])assert.equal(await reserveScopedChangeReviewOnClient(c,await grant(patch)),null);
   await assert.rejects(reserveScopedChangeReviewOnClient(c,await grant({authorizedCommands:['npm test']})),/not allowed/);
   const negative=async(sql:string,values:unknown[])=>{await c.query('savepoint negative');try{await c.query(sql,values);assert.equal(await reserveScopedChangeReviewOnClient(c,input),null);}finally{await c.query('rollback to savepoint negative');}};
   await negative("update work_intents set expires_at=clock_timestamp()-interval '1 second'",[]);
   await negative("update work_intents set file_scopes='[\"unrelated.ts\"]'",[]);
   await negative("update work_intents set fencing_token=2",[]);
   await negative("delete from project_identity_locations",[]);
   await negative("update workflow_runs set status='running' where id=$1",[source]);
   await negative("insert into workflow_tasks(id,run_id,status) values($1,$2,'queued')",[randomUUID(),source]);
   await negative("insert into action_approvals values($1,$2,'pending')",[randomUUID(),source]);
   await negative("insert into action_receipts(run_id,agent_id,action_type,metadata) values($1,'operator','historical_unhashed','{}')",[source]);
   await negative("update action_receipts set summary='tampered' where run_id=$1",[source]);
   await negative("insert into artifacts(run_id,kind,uri,content) select run_id,kind,uri||'/duplicate',content from artifacts where uri=$1",[input.authorizationArtifactUri]);
   await negative("insert into action_receipts(run_id,action_type,target,metadata) values($1,'scoped_change_review_revoked',$2,'{}')",[source,input.authorizationArtifactUri]);
   const otherClaim=async(role:string,lane:number,otherProject:string=project,scopes:string[]=['unrelated.ts'],state='running')=>c.query("insert into queue_coordinator_assignments(id,family_id,project_id,source_run_id,role,lane,owner,fingerprint,intent_fence,file_scopes,state) values($1,$2,$3,$4,$5,$6,'other-owner',$7,'1',$8,$9)",[randomUUID(),randomUUID(),otherProject,source,role,lane,randomUUID(),JSON.stringify(scopes),state]);
   await c.query('savepoint occupied');await otherClaim('verifier',1,randomUUID());assert.equal(await reserveScopedChangeReviewOnClient(c,input),null);await c.query('rollback to savepoint occupied');
   await c.query('savepoint capacity');for(let lane=1;lane<=5;lane++)await otherClaim('repair',lane,randomUUID());assert.equal(await reserveScopedChangeReviewOnClient(c,input),null);await c.query('rollback to savepoint capacity');
   await c.query('savepoint overlap');await otherClaim('repair',2,project,['src'],'uncertain');assert.equal(await reserveScopedChangeReviewOnClient(c,input),null);await c.query('rollback to savepoint overlap');
   await fs.writeFile(sourceFile,'changed');assert.equal(await reserveScopedChangeReviewOnClient(c,input),null);await fs.writeFile(sourceFile,'export const fixture = true;\n');
   await fs.writeFile(policyFile,stringify({...config,project:{...config.project,name:'changed-review-fixture'}}));assert.equal(await reserveScopedChangeReviewOnClient(c,input),null);await fs.writeFile(policyFile,policyText);
   const claim=await reserveScopedChangeReviewOnClient(c,input);assert.ok(claim);assert.equal(claim.role,'verifier');assert.equal(claim.lane,1);
   assert.equal(await reserveScopedChangeReviewOnClient(c,input),null);
   assert.deepEqual((await c.query('select * from workflow_runs where id=$1',[source])).rows[0],original);
   const child=randomUUID(),task=randomUUID(),snapshot=scopedChangeReviewPolicy(policy,authBase.authorizedCommands);
   const metadata={kind:'scoped-change-review',sourceRunId:source,queueCoordinatorClaimId:claim.id,queueCoordinatorFence:claim.fence,scopedReviewAuthorizationUri:input.authorizationArtifactUri,originalAcceptanceChanged:false,noAutomaticRepeat:true};
   await c.query("insert into workflow_runs(id,project_id,run_set_id,task,status,evaluation_metadata,policy_snapshot,policy_snapshot_hash) values($1,$2,$3,$4,'queued',$5,$6,$7)",[child,project,family,reviewTask,JSON.stringify(metadata),JSON.stringify(snapshot),canonicalJsonHash(snapshot)]);
   await c.query("insert into workflow_tasks(id,run_id,status) values($1,$2,'queued')",[task,child]);
   await c.query(coordinatorClaimFenceSql);
   const badWorker=async(worker:string)=>{await c.query('savepoint claim_denied');await assert.rejects(c.query("update workflow_tasks set status='leased',worker_id=$2 where id=$1",[task,worker]),{code:'55P03'});await c.query('rollback to savepoint claim_denied');};
   await badWorker('generic-worker');
   await c.query('savepoint writer');await c.query("update workflow_runs set policy_snapshot=jsonb_set(policy_snapshot,'{actions,allowed_write_paths}','[\"src/**\"]') where id=$1",[child]);await assert.rejects(attachScopedChangeReviewOnClient(c,claim,child),/exact readonly/);await c.query('rollback to savepoint writer');
   await c.query('savepoint route');await c.query("update workflow_runs set provider_override='stale-provider' where id=$1",[child]);await assert.rejects(attachScopedChangeReviewOnClient(c,claim,child),/exact readonly/);await c.query('rollback to savepoint route');
   await c.query('savepoint autonomy');await c.query("update workflow_runs set autonomy='wide-open' where id=$1",[child]);await assert.rejects(attachScopedChangeReviewOnClient(c,claim,child),/exact readonly/);await c.query('rollback to savepoint autonomy');
   await c.query('savepoint wrong_agent');await c.query("update workflow_tasks set agent_id='implementation-agent' where run_id=$1",[child]);await assert.rejects(attachScopedChangeReviewOnClient(c,claim,child),/unbound reviewer/);await c.query('rollback to savepoint wrong_agent');
   await c.query('savepoint contract');await c.query("update workflow_runs set evaluation_metadata=jsonb_set(evaluation_metadata,'{acceptanceContract}','{}') where id=$1",[child]);await assert.rejects(attachScopedChangeReviewOnClient(c,claim,child),/exact readonly/);await c.query('rollback to savepoint contract');
   await assert.rejects(attachScopedChangeReviewOnClient(c,{...claim,fence:'999'},child),/exact readonly/);
   await attachScopedChangeReviewOnClient(c,claim,child);
   await badWorker('generic-worker');
   await c.query("update workflow_tasks set status='leased',worker_id=$2 where id=$1",[task,`${claim.owner}:${claim.fence}`]);
   // A real accepted fixture is not permission to borrow its source identity.
   // All records below are synthetic and disappear with this transaction.
   const donor=randomUUID(),donorTask=randomUUID(),donorGoal='Already verified independent synthetic outcome';
   await c.query("insert into workflow_runs(id,project_id,run_set_id,task,status) values($1,$2,$3,$4,'completed')",[donor,project,randomUUID(),donorGoal]);
   await c.query("insert into workflow_tasks(id,run_id,status) values($1,$2,'completed')",[donorTask,donor]);
   const command={commandLine:'npm run typecheck',exitCode:0,timedOut:false,subjectHash:authBase.sourceHash,sourceBefore:authBase.sourceHash,sourceAfter:authBase.sourceHash,sourcePaths:paths};
   const commandUri=`db://synthetic/${donor}/check`;
   const observed=(await c.query("insert into artifacts(run_id,task_id,kind,uri,content) values($1,$2,'command_output',$3,$4) returning created_at",[donor,donorTask,commandUri,JSON.stringify(command)])).rows[0].created_at.toISOString();
   const reference={artifactUri:commandUri,runId:donor,taskId:donorTask,stageId:'verify',kind:'command_output',contentHash:acceptanceDigest(command),observedAt:observed,subjectHash:authBase.sourceHash};
   const gates=['implementation','verification','packaging','supervision'];
   const donorContract={version:1,contractId:randomUUID(),projectId:project,originRunId:donor,taskHash:acceptanceDigest(donorGoal),subjectHash:authBase.sourceHash,sourcePaths:paths,
    deliverables:[{id:'synthetic-delivery',description:donorGoal,requiredGates:gates,status:'verified',receipts:Object.fromEntries(gates.map(gate=>[gate,[reference]])),gaps:[]}]};
   await c.query("update workflow_runs set evaluation_metadata=$2 where id=$1",[donor,JSON.stringify({acceptanceContract:donorContract})]);
   await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'stage_output',$2,$3)",[donor,`db://synthetic/${donor}/output`,JSON.stringify({acceptanceContract:donorContract})]);
   await appendActionReceipt(c,{runId:donor,agentId:'test-engineer',actionType:'synthetic_acceptance_observed',target:commandUri,summary:'Synthetic fixture only, not product acceptance.',metadata:'{}'});
   assert.equal((await acceptancePreflight(c,donor,{acceptanceContract:donorContract})).accepted,true);
   assert.equal((await verifyRunReceiptChainOnClient(c,donor)).valid,true);
   for(const patch of [{sourceRunId:donor},{projectId:randomUUID()},{projectRootUri:root+'/unrelated'},{fileScopes:['unrelated.ts']},
    {familyId:randomUUID()},{role:'repair' as const},{lane:2},{fingerprint:'different'},{intentFence:'2'},{legacyEnrollmentId:randomUUID()}]){
    await c.query('savepoint identity_substitution');try{
     await assert.rejects(finishQueueCoordinatorOnClient(c,{...claim,...patch},'held','Substituted identity must not finalize',undefined,async()=>{}),/persisted coordinator identity/);
    }finally{await c.query('rollback to savepoint identity_substitution');}
   }
   await assert.rejects(finishQueueCoordinatorOnClient(c,{...claim,sourceRunId:donor},'verified','Cannot borrow accepted outcome'),/persisted coordinator identity/);
   await assert.rejects(finishQueueCoordinatorOnClient(c,claim,'verified','Not permitted'),/cannot certify original/);
   await c.query("update workflow_tasks set status='completed',worker_id=null where id=$1",[task]);
   await c.query("update workflow_runs set status='completed' where id=$1",[child]);
   await finishQueueCoordinatorOnClient(c,claim,'held','Scoped review complete; original installed acceptance still open',undefined,async()=>{});
   assert.equal(await reserveScopedChangeReviewOnClient(c,input),null); // Terminal grant not refunded.
   assert.equal(await reserveScopedChangeReviewOnClient(c,await grant({reviewTaskHash:acceptanceDigest('Reworded same review')})),null);
   assert.deepEqual((await c.query('select * from workflow_runs where id=$1',[source])).rows[0],original);
   const afterSource=await sourceSubjectHash(root,paths);assert.equal(afterSource,authBase.sourceHash);
   // Distinct source observations still cannot exceed the durable total budget.
   for(let i=0;i<4;i++)await appendActionReceipt(c,{runId:source,agentId:'operator',actionType:'scoped_change_review_reserved',target:randomUUID(),summary:'Synthetic consumed earlier review.',metadata:JSON.stringify({familyId:input.familyId})});
   await fs.writeFile(sourceFile,'export const fixture = false;\n');
   const changed=await grant({sourceHash:await sourceSubjectHash(root,paths)});assert.equal(await reserveScopedChangeReviewOnClient(c,changed),null);
  }finally{await c.query('rollback');}});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
