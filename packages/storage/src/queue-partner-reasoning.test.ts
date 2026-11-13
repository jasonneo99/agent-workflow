import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type {Client} from 'pg';
import {withClient} from './client.js';
import {queueCoordinatorSchemaSql,queueWorkingOccupancyOnClient} from './queue-coordinator.js';
import {exactPartnerPaths,partnerReasoningReceiptValid,latestPartnerReasoningScopeOnClient,reservePartnerReasoningOnClient,reconcileReadOnlyPartnerChildOnClient,type PartnerReasoningReservation} from './queue-partner-reasoning.js';
import {appendActionReceipt} from './receipt-writer.js';
import {chainReceipt} from '../../workflow-engine/src/receipt-chain.js';
import {acceptanceDigest} from './acceptance.js';
import {loadProjectConfig} from '../../agent-registry/src/loaders.js';
import {resolveExecutionPolicy,canonicalJsonHash} from '../../policy-engine/src/index.js';
import {sourceSubjectHash} from '../../workflow-engine/src/source-subject.js';
import {CodexCliProvider} from '../../model-providers/src/codex-cli.js';
import {registerExternalQueueReservationOnClient} from './queue-external-reservations.js';

async function fixture(body:(c:Client,make:(name:string,writePaths?:string[])=>Promise<PartnerReasoningReservation>,root:string)=>Promise<void>){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'partner-reasoning-')));
 try{
  await fs.mkdir(path.join(root,'.agent-workflow'));await fs.mkdir(path.join(root,'src'));
  await fs.writeFile(path.join(root,'.agent-workflow/project.yaml'),YAML.stringify({project:{name:'Synthetic project',autonomy:2},actions:{allowed_write_paths:['src/**'],allowed_commands:[]}}));
  await fs.writeFile(path.join(root,'src/main.ts'),'export const valid = true;');
  const policyHash=canonicalJsonHash(resolveExecutionPolicy(await loadProjectConfig(root),'local').project);
  await withClient(async c=>{await c.query('begin');try{
   const schema=`partner_reasoning_${randomUUID().replaceAll('-','')}`;
   await c.query(`create schema ${schema};set local search_path to ${schema},public;
    create table projects(id uuid primary key,root_uri text);
    create table workflow_runs(id uuid primary key,project_id uuid,run_set_id uuid,task text,status text,policy_profile text,evaluation_metadata jsonb,started_at timestamptz default clock_timestamp(),replacement_run_id uuid);
    create table workflow_tasks(id uuid primary key,run_id uuid,status text);
    create table project_identity_locations(project_id uuid,identity_id uuid,kind text);
    create table work_intents(project_id text,owner text,fencing_token bigint,file_scopes jsonb,expires_at timestamptz,id uuid default gen_random_uuid());
    create table action_approvals(id uuid,run_id uuid,status text);
    create table side_effect_receipts(project_id text,status text,idempotency_key text);
    create table action_receipts(id uuid default gen_random_uuid(),run_id uuid,agent_id text,action_type text,target text,summary text,metadata jsonb,prev_hash text,receipt_hash text,created_at timestamptz,metadata_serialization_version int);
    create table artifacts(id uuid default gen_random_uuid(),run_id uuid,task_id uuid,kind text,uri text,content jsonb,created_at timestamptz default clock_timestamp());`);
   await c.query(queueCoordinatorSchemaSql);
   const projectId=randomUUID();await c.query('insert into projects values($1,$2)',[projectId,root]);
   await c.query("insert into project_identity_locations values($1,$1,'canonical')",[projectId]);
   const make=async(name:string,writePaths:string[]=[]):Promise<PartnerReasoningReservation>=>{
    const sourceRunId=randomUUID(),set=randomUUID(),task=`Recover the intended ${name}`,owner=`fixture:${name}`;
    const fileScopes=writePaths.length?writePaths:[`runtime/queue-partner/recovery/${sourceRunId}`];
    await c.query("insert into workflow_runs values($1,$2,$3,$4,'blocked','local','{}')",[sourceRunId,projectId,set,task]);
    await c.query("insert into work_intents(project_id,owner,fencing_token,file_scopes,expires_at) values($1,$2,7,$3,clock_timestamp()+interval '10 minutes')",[projectId,owner,JSON.stringify(fileScopes)]);
    return {projectId,projectRootUri:root,sourceRunId,familyId:`${projectId}:${set}`,owner,intentFence:'7',fileScopes,writePaths,
     fingerprint:acceptanceDigest({task,writePaths}),taskHash:acceptanceDigest(task),policyHash,sourceHash:writePaths.length?await sourceSubjectHash(root,writePaths):null};
   };
   await body(c,make,root);
  }finally{await c.query('rollback');}});
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
test('exact discovery suggestions reject broad, secret, alias and malformed paths',()=>{
 assert.equal(exactPartnerPaths([]),true);assert.equal(exactPartnerPaths(['src/main.ts','tests/main.test.ts']),true);
 for(const paths of [['/tmp/source'],['../source'],['src/*'],['vendor/source.ts'],['.env'],['src/./source.ts'],['src/a.ts','src/a.ts'],['C:/source.ts'],['src/bad\nname.ts']])assert.equal(exactPartnerPaths(paths),false,JSON.stringify(paths));
});
test('reasoning admission honors exact external family reservations before selecting a lane or inserting a child',async()=>{
 const source=await fs.readFile(new URL('./queue-partner-reasoning.ts',import.meta.url),'utf8');
 const guard=source.indexOf('occupancy.externalFamilyIds.includes(input.familyId)');
 assert.ok(guard>=0);assert.ok(guard<source.indexOf('const lane=[1,2,3,4,5]'));
 const cli=await fs.readFile(new URL('../../../apps/cli/src/commands/queue-coordinator.ts',import.meta.url),'utf8');
 assert.ok(cli.indexOf('const externalReservations=')<cli.indexOf('const plan=planQueueCoordinator'));
 assert.match(cli,/externalReservations\.map\(r=>\(\{familyId:r\.familyId/);
});
test('an audited external source owner inhibits same-family discovery even with a free queue lane',async()=>fixture(async(c,make)=>{
 const input=await make('external-owned-source',['src/main.ts']),uri=`db://workflow_runs/${input.sourceRunId}/external-authorization/${randomUUID()}`;
 const authority={version:1,purpose:'restrictive-external-queue-reservation',authority:'direct-human',approvalDecision:'approved',authorizationId:randomUUID(),approvalEvidence:'Synthetic direct-human exact owner capacity binding.',restrictiveOnly:true,grantsExecution:false,
  sourceRunId:input.sourceRunId,projectId:input.projectId,projectRootUri:input.projectRootUri,familyId:input.familyId,owner:input.owner,intentId:(await c.query('select id::text from work_intents where owner=$1',[input.owner])).rows[0].id,intentFence:input.intentFence,fileScopes:input.fileScopes,role:'repair' as const,taskHash:input.taskHash,expiresAt:new Date(Date.now()+60_000).toISOString()};
 await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'queue_external_reservation_authorization',$2,$3)",[input.sourceRunId,uri,JSON.stringify(authority)]);
 await appendActionReceipt(c,{runId:input.sourceRunId,agentId:'workflow-orchestrator',actionType:'queue_external_reservation_authorized',target:uri,summary:'Exact restrictive source owner binding',metadata:JSON.stringify(authority)});
 assert.ok(await registerExternalQueueReservationOnClient(c,{...authority,authorizationArtifactUri:uri}));
 assert.equal((await queueWorkingOccupancyOnClient(c)).count,1);
 assert.equal(await reservePartnerReasoningOnClient(c,input),null,'The same family is not duplicated below the global maximum');
 await appendActionReceipt(c,{runId:input.sourceRunId,agentId:'workflow-orchestrator',actionType:'queue_external_reservation_revoked',target:uri,summary:'Unbound prose is not a source-owner release',metadata:'{}'});
 assert.equal(await reservePartnerReasoningOnClient(c,input),null,'A bare revocation receipt cannot release the genuine live owner');
 await c.query("update work_intents set fencing_token=8 where project_id=$1 and owner=$2",[input.projectId,input.owner]);
 assert.equal(await reservePartnerReasoningOnClient(c,input),null,'The prior stale fence cannot continue');
 assert.ok(await reservePartnerReasoningOnClient(c,{...input,intentFence:'8'}),'Only a genuinely new exact intent fence removes the old restrictive reservation; original policy remains binding');
}));
test('scope proposals need an authentic current reservation segment, never altered source bindings',()=>{
 const expected={sourceRunId:randomUUID(),projectId:randomUUID(),familyId:'synthetic-family',claimId:randomUUID(),fence:'7',taskHash:'a'.repeat(64)};
 const metadata={...expected,id:expected.claimId,purpose:'autonomous-recovery'},createdAt='2026-01-01T00:00:00.000Z';
 const hashed=chainReceipt('b'.repeat(64),{runId:expected.sourceRunId,agentId:'workflow-orchestrator',actionType:'queue_partner_reasoning_reserved',target:expected.claimId,summary:'Current bound recovery',metadata:JSON.stringify(metadata),metadataSerializationVersion:2,createdAt});
 const receipt={run_id:expected.sourceRunId,agent_id:'workflow-orchestrator',action_type:'queue_partner_reasoning_reserved',target:expected.claimId,summary:'Current bound recovery',metadata,metadata_serialization_version:2,created_at:createdAt,prev_hash:hashed.prevHash,receipt_hash:hashed.receiptHash};
 assert.equal(partnerReasoningReceiptValid(receipt,expected),true);
 assert.equal(partnerReasoningReceiptValid({...receipt,metadata:{...metadata,taskHash:'c'.repeat(64)}},expected),false);
 assert.equal(partnerReasoningReceiptValid({...receipt,summary:'Altered evidence'},expected),false);
 assert.equal(partnerReasoningReceiptValid(receipt,{...expected,claimId:randomUUID()}),false);
 assert.equal(partnerReasoningReceiptValid({...receipt,receipt_hash:null},expected),false);
});
test('missing original contract permits one genuine reasoning reservation without rewriting original history',async()=>fixture(async(c,make)=>{
 const input=await make('missing-enrollment'),before=(await c.query('select * from workflow_runs')).rows;
 const forged={...input,intentId:randomUUID()},actualIntentId=(await c.query('select id::text from work_intents where owner=$1',[input.owner])).rows[0].id;
 const claim=await reservePartnerReasoningOnClient(c,forged);assert.ok(claim);assert.equal(claim.role,'repair');assert.equal(claim.lane,1);assert.equal(claim.intentId,actualIntentId);
 assert.deepEqual((await c.query('select * from workflow_runs')).rows,before);
 const proof=(await c.query("select metadata from action_receipts where action_type='queue_partner_reasoning_reserved'")).rows[0].metadata;
 assert.equal(proof.acceptance,'unverified');assert.equal(proof.historicalContractChanged,false);assert.deepEqual(proof.writePaths,[]);assert.equal(proof.intentId,actualIntentId);
 await c.query("update queue_coordinator_assignments set state='held' where id=$1",[claim.id]);
 assert.equal(await reservePartnerReasoningOnClient(c,input),null,'Same semantic state is durable across restarts');
}));
test('only receipt-bound output of an exact owned completed child can suggest the next scope',async()=>fixture(async(c,make)=>{
 const input=await make('discovery'),claim=await reservePartnerReasoningOnClient(c,input);assert.ok(claim);
 const child=randomUUID(),task=randomUUID(),createdAt='2026-01-01T00:00:00.000Z';
 const provider=new CodexCliProvider({authStatus:async()=> 'Logged in using ChatGPT; synthetic access token',execute:async()=>({model:'synthetic-model',
  output:JSON.stringify({outcome:'completed',summary:'Actual bounded discovery',proposedSourcePaths:['src/main.ts'],memoryInfluence:{used:[],noInfluenceReason:'Synthetic source inspected directly.'}})})});
 const produced=await provider.executeStage({runId:child,taskId:task,projectConfig:await loadProjectConfig(input.projectRootUri),workflowId:'agent-task-queue-partner',workflowTask:'Discover scope',
  stageId:'specialist-task',agentId:'queue-partner',agentName:'Partner',agentPrompt:'Read-only discovery',stageGoal:'Discover scope',compiledBrief:'Synthetic evidence',priorReceipts:[]});
 const content=produced.artifact;
 assert.deepEqual(produced.requestedFileWrites,[]);assert.deepEqual(produced.requestedCommands,[]);
 const metadata={source:'queue-partner-recovery',sourceRunId:input.sourceRunId,queueCoordinatorClaimId:claim.id,queueCoordinatorFence:claim.fence,recoveryTaskHash:input.taskHash};
 await c.query("insert into workflow_runs values($1,$2,$3,'Actual discovery','completed','local',$4)",[child,input.projectId,randomUUID(),JSON.stringify(metadata)]);
 await c.query("update queue_coordinator_assignments set child_run_id=$2,state='held' where id=$1",[claim.id,child]);
 const hashed=chainReceipt('GENESIS',{runId:child,agentId:'queue-partner',actionType:'stage_completed',target:task,summary:'Actual bounded discovery',metadata:JSON.stringify(content),metadataSerializationVersion:2,createdAt});
 await c.query("insert into action_receipts(run_id,agent_id,action_type,target,summary,metadata,prev_hash,receipt_hash,created_at,metadata_serialization_version) values($1,'queue-partner','stage_completed',$2,'Actual bounded discovery',$3,$4,$5,$6,2)",[child,task,JSON.stringify(content),hashed.prevHash,hashed.receiptHash,createdAt]);
 await c.query("insert into artifacts(run_id,task_id,kind,uri,content) values($1,$2,'stage_output','db://synthetic/discovery',$3)",[child,task,JSON.stringify(content)]);
 assert.deepEqual(await latestPartnerReasoningScopeOnClient(c,input.sourceRunId),['src/main.ts']);
 await c.query("update artifacts set content='{\"proposedSourcePaths\":[\"src/forged.ts\"]}' where run_id=$1",[child]);
 assert.deepEqual(await latestPartnerReasoningScopeOnClient(c,input.sourceRunId),[],'Modified output is not bound to the executed receipt');
 await c.query('update artifacts set content=$2 where run_id=$1',[child,JSON.stringify(content)]);
 await c.query("update action_receipts set summary='Altered reservation' where action_type='queue_partner_reasoning_reserved'");
 assert.deepEqual(await latestPartnerReasoningScopeOnClient(c,input.sourceRunId),[],'Changed reservation bytes do not become authority');
}));
test('a selected specialist can hand off receipt-bound discovery, but foreign or altered team bindings cannot',async()=>fixture(async(c,make)=>{
 const input=await make('specialist-discovery'),claim=await reservePartnerReasoningOnClient(c,input);assert.ok(claim);
 const child=randomUUID(),task=randomUUID(),worker='technical-architect',createdAt='2026-01-01T00:00:00.000Z';
 const provider=new CodexCliProvider({authStatus:async()=> 'Logged in using ChatGPT; synthetic access token',execute:async()=>({model:'synthetic-model',
  output:JSON.stringify({outcome:'completed',summary:'Specialist inspected exact scope',proposedSourcePaths:['src/main.ts'],memoryInfluence:{used:[],noInfluenceReason:'Synthetic direct inspection.'}})})});
 const produced=await provider.executeStage({runId:child,taskId:task,projectConfig:await loadProjectConfig(input.projectRootUri),workflowId:`partner-recovery-${worker}`,workflowTask:'Discover scope',
  stageId:'specialist-task',agentId:worker,agentName:'Architect',agentPrompt:'Read-only discovery',stageGoal:'Discover scope',compiledBrief:'Synthetic evidence',priorReceipts:[]});
 const content=produced.artifact,team={schemaVersion:1,leaderAgentId:'queue-partner',workerAgentId:worker,workflowId:`partner-recovery-${worker}`};
 const metadata={source:'queue-partner-recovery',sourceRunId:input.sourceRunId,queueCoordinatorClaimId:claim.id,queueCoordinatorFence:claim.fence,recoveryTaskHash:input.taskHash,partnerWorkerTeam:team};
 await c.query("insert into workflow_runs values($1,$2,$3,'Actual specialist discovery','completed','local',$4)",[child,input.projectId,randomUUID(),JSON.stringify(metadata)]);
 await c.query("update queue_coordinator_assignments set child_run_id=$2,state='held' where id=$1",[claim.id,child]);
 const hashed=chainReceipt('GENESIS',{runId:child,agentId:worker,actionType:'stage_completed',target:task,summary:'Specialist inspected exact scope',metadata:JSON.stringify(content),metadataSerializationVersion:2,createdAt});
 await c.query("insert into action_receipts(run_id,agent_id,action_type,target,summary,metadata,prev_hash,receipt_hash,created_at,metadata_serialization_version) values($1,$2,'stage_completed',$3,'Specialist inspected exact scope',$4,$5,$6,$7,2)",[child,worker,task,JSON.stringify(content),hashed.prevHash,hashed.receiptHash,createdAt]);
 await c.query("insert into artifacts(run_id,task_id,kind,uri,content) values($1,$2,'stage_output','db://synthetic/specialist-discovery',$3)",[child,task,JSON.stringify(content)]);
 assert.deepEqual(await latestPartnerReasoningScopeOnClient(c,input.sourceRunId),['src/main.ts']);
 for(const changed of [{...team,workerAgentId:'implementation-agent'},{...team,leaderAgentId:'foreign'},{...team,workflowId:'foreign-workflow'},{...team,schemaVersion:2},null]){
  await c.query('update workflow_runs set evaluation_metadata=$2 where id=$1',[child,JSON.stringify({...metadata,partnerWorkerTeam:changed})]);
  assert.deepEqual(await latestPartnerReasoningScopeOnClient(c,input.sourceRunId),[],'Only the exact governed specialist may provide this handoff');
 }
 await c.query('update workflow_runs set evaluation_metadata=$2 where id=$1',[child,JSON.stringify(metadata)]);
 await c.query("update artifacts set content='{\"proposedSourcePaths\":[\"src/forged.ts\"]}' where run_id=$1",[child]);
 assert.deepEqual(await latestPartnerReasoningScopeOnClient(c,input.sourceRunId),[],'Specialist delegation must not waive output integrity');
}));

test('only newly sealed authentic blocked specialist output refines scope without accepting the blocked work',async()=>fixture(async(c,make)=>{
 const input=await make('blocked-specialist'),claim=await reservePartnerReasoningOnClient(c,input);assert.ok(claim);
 const child=randomUUID(),task=randomUUID(),worker='implementation-agent',uri=`db://workflow_tasks/${task}/output`;
 const team={schemaVersion:1,leaderAgentId:'queue-partner',workerAgentId:worker,workflowId:`partner-recovery-${worker}`};
 const metadata={source:'queue-partner-recovery',sourceRunId:input.sourceRunId,queueCoordinatorClaimId:claim.id,queueCoordinatorFence:claim.fence,recoveryTaskHash:input.taskHash,partnerWorkerTeam:team};
 const paths=['src/feature.ts','tests/feature.test.ts','src/transport.ts','tests/transport.test.ts'];
 const content={runId:child,taskId:task,agentId:worker,outcome:'blocked',summary:'Additional exact source/test scope required',proposedSourcePaths:paths};
 await c.query("insert into workflow_runs values($1,$2,$3,'Synthetic bounded specialist','blocked','local',$4)",[child,input.projectId,randomUUID(),JSON.stringify(metadata)]);
 await c.query("update queue_coordinator_assignments set child_run_id=$2,state='held' where id=$1",[claim.id,child]);
 await c.query("insert into artifacts(run_id,task_id,kind,uri,content) values($1,$2,'stage_output',$3,$4)",[child,task,uri,JSON.stringify(content)]);
 await c.query("insert into workflow_tasks values($1,$2,'blocked')",[task,child]);
 // The synthetic schema tests consumption; postgres.test.ts covers the actual
 // producer, including its notification outbox, against the full schema.
 const createdAt=new Date().toISOString(),proofMetadata=JSON.stringify({reason:'Exact scope refinement',outputUri:uri,outputDigest:acceptanceDigest(content)});
 const hashed=chainReceipt('GENESIS',{runId:child,agentId:worker,actionType:'stage_blocked',target:task,summary:content.summary,metadata:proofMetadata,metadataSerializationVersion:2,createdAt});
 await c.query("insert into action_receipts(run_id,agent_id,action_type,target,summary,metadata,prev_hash,receipt_hash,created_at,metadata_serialization_version) values($1,$2,'stage_blocked',$3,$4,$5,$6,$7,$8,2)",[child,worker,task,content.summary,proofMetadata,hashed.prevHash,hashed.receiptHash,createdAt]);
 const before=(await c.query('select id,status from workflow_runs order by id')).rows;
 assert.deepEqual(await latestPartnerReasoningScopeOnClient(c,input.sourceRunId),paths);
 assert.deepEqual((await c.query('select id,status from workflow_runs order by id')).rows,before,'Hints neither accept nor complete source or child');
 async function rejects(change:()=>Promise<unknown>,why:string){await c.query('savepoint rejected_hint');try{await change();assert.deepEqual(await latestPartnerReasoningScopeOnClient(c,input.sourceRunId),[],why);}finally{await c.query('rollback to savepoint rejected_hint');}}
 for(const status of ['failed','cancelled','completed'])await rejects(()=>c.query('update workflow_runs set status=$2 where id=$1',[child,status]),'Lifecycle must match the blocked action');
 await rejects(()=>c.query("update workflow_tasks set status='completed' where id=$1",[task]),'The exact blocked task must still match the output');
 await rejects(()=>c.query("update artifacts set content=jsonb_set(content,'{proposedSourcePaths}','[\"src/forged.ts\"]') where run_id=$1",[child]),'An intact chain cannot authorize changed artifact bytes');
 await rejects(()=>c.query("update action_receipts set metadata=metadata-'outputDigest' where run_id=$1",[child]),'Old unsealed blocked outputs remain ineligible');
 await rejects(()=>c.query("update action_receipts set metadata=jsonb_set(metadata,'{outputDigest}',to_jsonb(repeat('0',64))) where run_id=$1",[child]),'Wrong output digest denied');
 await rejects(()=>c.query("update action_receipts set metadata=jsonb_set(metadata,'{outputUri}','\"db://foreign/output\"') where run_id=$1",[child]),'Foreign artifact URI denied');
 await rejects(()=>c.query("update action_receipts set agent_id='technical-architect' where run_id=$1",[child]),'Foreign producer denied');
 await rejects(()=>c.query('update artifacts set task_id=$2 where run_id=$1',[child,randomUUID()]),'Foreign task denied');
 await rejects(()=>c.query('update workflow_runs set project_id=$2 where id=$1',[child,randomUUID()]),'Foreign execution scope denied');
 for(const key of ['queueCoordinatorFence','queueCoordinatorClaimId','sourceRunId'])await rejects(()=>c.query('update workflow_runs set evaluation_metadata=jsonb_set(evaluation_metadata,array[$2],to_jsonb($3::text)) where id=$1',[child,key,randomUUID()]),'Wrong current reservation binding denied');
 await rejects(()=>c.query("update action_receipts set summary='Tampered result receipt' where run_id=$1",[child]),'Full child receipt chain remains mandatory');
}));
test('a newer reservation or unsealed blocked result never falls back to an older completed scope',async()=>fixture(async(c,make)=>{
 const input=await make('latest-specialist'),old=await reservePartnerReasoningOnClient(c,input);assert.ok(old);
 const oldChild=randomUUID(),oldTask=randomUUID(),worker='technical-architect';
 const team={schemaVersion:1,leaderAgentId:'queue-partner',workerAgentId:worker,workflowId:`partner-recovery-${worker}`};
 const oldContent={runId:oldChild,taskId:oldTask,agentId:worker,outcome:'completed',summary:'Earlier narrower discovery',proposedSourcePaths:['src/main.ts','tests/main.test.ts']};
 const metadata=(claim:typeof old)=>({source:'queue-partner-recovery',sourceRunId:input.sourceRunId,queueCoordinatorClaimId:claim!.id,queueCoordinatorFence:claim!.fence,recoveryTaskHash:input.taskHash,partnerWorkerTeam:team});
 await c.query("insert into workflow_runs values($1,$2,$3,'Earlier specialist','completed','local',$4)",[oldChild,input.projectId,randomUUID(),JSON.stringify(metadata(old))]);
 await c.query("update queue_coordinator_assignments set child_run_id=$2,state='held' where id=$1",[old.id,oldChild]);
 await c.query("insert into artifacts(run_id,task_id,kind,uri,content) values($1,$2,'stage_output',$3,$4)",[oldChild,oldTask,`db://workflow_tasks/${oldTask}/output`,JSON.stringify(oldContent)]);
 const createdAt=new Date().toISOString(),oldProof=chainReceipt('GENESIS',{runId:oldChild,agentId:worker,actionType:'stage_completed',target:oldTask,summary:oldContent.summary,metadata:JSON.stringify(oldContent),metadataSerializationVersion:2,createdAt});
 await c.query("insert into action_receipts(run_id,agent_id,action_type,target,summary,metadata,prev_hash,receipt_hash,created_at,metadata_serialization_version) values($1,$2,'stage_completed',$3,$4,$5,$6,$7,$8,2)",[oldChild,worker,oldTask,oldContent.summary,JSON.stringify(oldContent),oldProof.prevHash,oldProof.receiptHash,createdAt]);
 assert.deepEqual(await latestPartnerReasoningScopeOnClient(c,input.sourceRunId),oldContent.proposedSourcePaths);
 const current=await reservePartnerReasoningOnClient(c,{...input,fingerprint:acceptanceDigest({prior:input.fingerprint,newEvidence:true})});assert.ok(current);
 assert.deepEqual(await latestPartnerReasoningScopeOnClient(c,input.sourceRunId),[],'An outstanding current reservation cannot reuse an earlier result');
 const child=randomUUID(),task=randomUUID(),uri=`db://workflow_tasks/${task}/output`;
 const content={runId:child,taskId:task,agentId:worker,outcome:'blocked',summary:'New result lacks a producer digest',proposedSourcePaths:['src/transport.ts','tests/transport.test.ts']};
 await c.query("insert into workflow_runs values($1,$2,$3,'Current specialist','blocked','local',$4)",[child,input.projectId,randomUUID(),JSON.stringify(metadata(current))]);
 await c.query("update queue_coordinator_assignments set child_run_id=$2,state='held' where id=$1",[current.id,child]);
 await c.query("insert into workflow_tasks values($1,$2,'blocked')",[task,child]);
 await c.query("insert into artifacts(run_id,task_id,kind,uri,content) values($1,$2,'stage_output',$3,$4)",[child,task,uri,JSON.stringify(content)]);
 const blockedAt=new Date().toISOString(),unsealedMetadata=JSON.stringify({reason:content.summary,outputUri:uri});
 const unsealed=chainReceipt('GENESIS',{runId:child,agentId:worker,actionType:'stage_blocked',target:task,summary:content.summary,metadata:unsealedMetadata,metadataSerializationVersion:2,createdAt:blockedAt});
 await c.query("insert into action_receipts(run_id,agent_id,action_type,target,summary,metadata,prev_hash,receipt_hash,created_at,metadata_serialization_version) values($1,$2,'stage_blocked',$3,$4,$5,$6,$7,$8,2)",[child,worker,task,content.summary,unsealedMetadata,unsealed.prevHash,unsealed.receiptHash,blockedAt]);
 assert.deepEqual(await latestPartnerReasoningScopeOnClient(c,input.sourceRunId),[],'Unsealed historical output remains ineligible and does not revive older paths');
}));
test('live source dismissal or supersession cannot be bypassed by an earlier reasoning plan',async()=>fixture(async(c,make)=>{
 for(const action of ['failed_run_dismissed','failed_run_superseded']){
  const input=await make(action);
  await c.query("insert into action_receipts(run_id,action_type,metadata,created_at) values($1,$2,'{}',clock_timestamp()-interval '1 second')",[input.sourceRunId,action]);
  assert.equal(await reservePartnerReasoningOnClient(c,input),null);
  assert.equal(Number((await c.query('select count(*) n from queue_coordinator_assignments where source_run_id=$1',[input.sourceRunId])).rows[0].n),0);
  await c.query("insert into action_receipts(run_id,action_type,metadata,created_at) values($1,'failed_run_reinstated','{}',clock_timestamp())",[input.sourceRunId]);
  const claim=await reservePartnerReasoningOnClient(c,input);assert.ok(claim,'Explicit reinstatement still needs every ordinary grant and exact intent');
  await c.query("update queue_coordinator_assignments set state='held' where id=$1",[claim.id]);
 }
}));
test('five real reasoning claims occupy the ordinary lane indexes and forbid a sixth',async()=>fixture(async(c,make)=>{
 const claims=[];for(let i=0;i<5;i++){const claim=await reservePartnerReasoningOnClient(c,await make(`work-${i}`));assert.ok(claim);claims.push(claim);}
 assert.deepEqual(claims.map(c=>c.lane),[1,2,3,4,5]);
 const next=await make('sixth');assert.equal(await reservePartnerReasoningOnClient(c,next),null);
 await c.query("update queue_coordinator_assignments set state='held' where id=$1",[claims[1].id]);
 assert.equal((await reservePartnerReasoningOnClient(c,next))?.lane,2,'Refill the actual hole, not the last lane');
}));
test('opted-in source repair reserves the verifier and rejects stale callers before consuming a turn',async()=>fixture(async(c,make,root)=>{
 const input=await make('pipeline',['src/main.ts']);
 const config=await loadProjectConfig(root);config.execution.repair_commits={enabled:true,stages:['repair']};
 await fs.writeFile(path.join(root,'.agent-workflow/project.yaml'),YAML.stringify(config));
 input.policyHash=canonicalJsonHash(resolveExecutionPolicy(await loadProjectConfig(root),'local').project);
 assert.equal(await reservePartnerReasoningOnClient(c,input),null,'legacy caller cannot silently use the old one-stage path');
 const occupied=await make('queued-pipeline');
 await c.query("update workflow_runs set status='queued',evaluation_metadata=$2 where id=$1",[occupied.sourceRunId,JSON.stringify({partnerRepairPipeline:{version:1,requiresVerifierSlot:true}})]);
 assert.equal(await reservePartnerReasoningOnClient(c,{...input,requiresVerifierSlot:true}),null);
 assert.equal(Number((await c.query("select count(*) n from action_receipts where run_id=$1 and action_type='queue_partner_reasoning_reserved'",[input.sourceRunId])).rows[0].n),0,'capacity hold consumes no lifetime turn');
 await c.query("update workflow_runs set status='completed' where id=$1",[occupied.sourceRunId]);
 const claim=await reservePartnerReasoningOnClient(c,{...input,requiresVerifierSlot:true});assert.ok(claim);
 const occupancy=await queueWorkingOccupancyOnClient(c);assert.equal(occupancy.count,1);assert.equal(occupancy.verifier,true);
}));
test('attached actor children count once and genuinely executing non-Partner work still occupies capacity',async()=>fixture(async(c,make)=>{
 for(let i=0;i<3;i++){
  const input=await make(`attached-${i}`),claim=await reservePartnerReasoningOnClient(c,input);assert.ok(claim);
  const child=randomUUID();await c.query("insert into workflow_runs values($1,$2,$3,'Recovery child','running','local',$4)",[child,input.projectId,randomUUID(),JSON.stringify({queueCoordinatorClaimId:claim.id,queueCoordinatorFence:claim.fence,sourceRunId:input.sourceRunId})]);
  await c.query("update queue_coordinator_assignments set state='running',child_run_id=$2 where id=$1",[claim.id,child]);
 }
 assert.equal((await queueWorkingOccupancyOnClient(c)).count,3);
 for(let i=0;i<2;i++){const external=await make(`external-${i}`);await c.query("update workflow_runs set status='running' where id=$1",[external.sourceRunId]);}
 assert.equal((await queueWorkingOccupancyOnClient(c)).count,5);assert.equal(await reservePartnerReasoningOnClient(c,await make('no-sixth')),null);
}));
test('ordinary verifier and independent dependencies are inside the shared five-item ceiling',async()=>fixture(async(c,make)=>{
 for(let i=0;i<4;i++)assert.ok(await reservePartnerReasoningOnClient(c,await make(`work-${i}`)));
 const verifier=await make('existing-verifier');
 await c.query("insert into queue_coordinator_assignments(id,family_id,project_id,source_run_id,role,lane,owner,fingerprint,intent_fence,file_scopes,state) values($1,$2,$3,$4,'verifier',1,$5,$6,'7',$7,'running')",[randomUUID(),verifier.familyId,verifier.projectId,verifier.sourceRunId,verifier.owner,verifier.fingerprint,JSON.stringify(verifier.fileScopes)]);
 const next=await make('extra');assert.equal(await reservePartnerReasoningOnClient(c,next),null);
 await c.query("update queue_coordinator_assignments set state='held' where role='verifier'");
 const dependency=await make('independent-dependency');await c.query("update workflow_runs set status='queued',evaluation_metadata='{\"source\":\"authorized-project-dependency\"}' where id=$1",[dependency.sourceRunId]);
 assert.equal(await reservePartnerReasoningOnClient(c,next),null);
}));
test('uncertain writers retain overlap and family fencing even after their old intent expires',async()=>fixture(async(c,make)=>{
 const first=await make('writer',['src/main.ts']),claim=await reservePartnerReasoningOnClient(c,first);assert.ok(claim);
 await c.query("update queue_coordinator_assignments set state='uncertain' where id=$1",[claim.id]);
 await c.query("update work_intents set expires_at=clock_timestamp()-interval '1 second' where owner=$1",[first.owner]);
 const other=await make('overlapping',['src/main.ts']);assert.equal(await reservePartnerReasoningOnClient(c,other),null);
 const same={...first,fingerprint:'d'.repeat(64),owner:other.owner};assert.equal(await reservePartnerReasoningOnClient(c,same),null);
}));
test('fresh identity, task, approval and policy checks cannot be replaced by a caller plan',async()=>fixture(async(c,make)=>{
 const input=await make('guarded');
 assert.equal(await reservePartnerReasoningOnClient(c,{...input,taskHash:'f'.repeat(64)}),null);
 assert.equal(await reservePartnerReasoningOnClient(c,{...input,policyHash:'e'.repeat(64)}),null);
 await c.query("insert into action_approvals values($1,$2,'pending')",[randomUUID(),input.sourceRunId]);assert.equal(await reservePartnerReasoningOnClient(c,input),null);
 await c.query('delete from action_approvals');await c.query("update project_identity_locations set kind='historical'");assert.equal(await reservePartnerReasoningOnClient(c,input),null);
 await c.query("update project_identity_locations set kind='canonical'");await c.query("update workflow_runs set evaluation_metadata='{\"sourceRunId\":\"derived\"}' where id=$1",[input.sourceRunId]);assert.equal(await reservePartnerReasoningOnClient(c,input),null);
}));
test('changed source and exact intent drift refuse effects, and no model suggestion can add write permission',async()=>fixture(async(c,make,root)=>{
 const input=await make('source',['src/main.ts']);
 await fs.writeFile(path.join(root,'src/main.ts'),'export const changed = true;');assert.equal(await reservePartnerReasoningOnClient(c,input),null);
 const fresh={...input,sourceHash:await sourceSubjectHash(root,['src/main.ts'])};
 await c.query("update work_intents set file_scopes='[\"other.ts\"]'");assert.equal(await reservePartnerReasoningOnClient(c,fresh),null);
 await c.query('update work_intents set file_scopes=$1',[JSON.stringify(input.fileScopes)]);
 await assert.rejects(()=>reservePartnerReasoningOnClient(c,{...fresh,fileScopes:['docs/outside.md'],writePaths:['docs/outside.md']}),/not allowed|allowlist|Write path/i);
}));
test('five-turn lifetime breaker preserves the prior three turns and is not reset by fingerprints or watch restarts',async()=>fixture(async(c,make)=>{
 const input=await make('bounded');
 for(let i=0;i<5;i++){
  const claim=await reservePartnerReasoningOnClient(c,{...input,fingerprint:acceptanceDigest({iteration:i})});assert.ok(claim);
  await c.query("update queue_coordinator_assignments set state='held' where id=$1",[claim.id]);
 }
 assert.equal(await reservePartnerReasoningOnClient(c,{...input,fingerprint:'c'.repeat(64)}),null);
 assert.equal(Number((await c.query("select count(*)::int n from action_receipts where action_type='queue_partner_reasoning_reserved'")).rows[0].n),5);
}));

test('terminal read-only closeout requires prospective audit, exact new intent, complete receipts and no remaining actor',async()=>fixture(async(c,make)=>{
 const input=await make('terminal-read-only'),claim=await reservePartnerReasoningOnClient(c,input);assert.ok(claim);
 await c.query('alter table workflow_runs add column policy_snapshot jsonb,add column policy_snapshot_hash text,add column requester_channel text;alter table workflow_tasks add column output_uri text');
 await c.query(`create table run_notifications(id uuid primary key default gen_random_uuid(),run_id uuid,channel text,kind text,title text,body text,event_key text,origin_task_id text,created_at timestamptz);
  create unique index fixture_notification_identity on run_notifications(run_id,channel,event_key) where event_key is not null`);
 const child=randomUUID(),task=randomUUID(),owner='synthetic-terminal-reconciler',uri=`db://synthetic/authorization/${claim.id}`,output=`db://synthetic/output/${task}`;
 const frozen={actions:{allowed_write_paths:[],allowed_commands:[],approval_rules:[]}};
 const metadata={source:'queue-partner-recovery',sourceRunId:input.sourceRunId,queueCoordinatorClaimId:claim.id,queueCoordinatorFence:claim.fence,recoveryTaskHash:input.taskHash,
  workIntent:{owner:claim.owner,fencingToken:claim.intentFence},recoveryWritePaths:[],recoverySubjectHash:null};
 const content={summary:'Actual read-only discovery',requestedCommands:[],requestedFileWrites:[],requestedFileReads:[],requestedFileSearches:[],artifact:{proposedSourcePaths:['src/main.ts']}};
 await c.query("insert into workflow_runs(id,project_id,run_set_id,task,status,policy_profile,evaluation_metadata,policy_snapshot,policy_snapshot_hash) values($1,$2,$3,'Terminal discovery','completed','local',$4,$5,$6)",
  [child,input.projectId,randomUUID(),JSON.stringify(metadata),JSON.stringify(frozen),canonicalJsonHash(frozen)]);
 await c.query("insert into workflow_tasks values($1,$2,'completed',$3)",[task,child,output]);
 await c.query("insert into artifacts(run_id,task_id,kind,uri,content) values($1,$2,'stage_output',$3,$4)",[child,task,output,JSON.stringify(content)]);
 await appendActionReceipt(c,{runId:child,agentId:'queue-partner',actionType:'stage_completed',target:task,summary:'Actual read-only discovery',metadata:JSON.stringify(content)});
 await c.query("update queue_coordinator_assignments set state='uncertain',child_run_id=$2,reason='Ownership observation failed' where id=$1",[claim.id,child]);
 await c.query("update work_intents set expires_at=clock_timestamp()-interval '1 second' where owner=$1",[claim.owner]);
 await c.query("insert into work_intents(project_id,owner,fencing_token,file_scopes,expires_at) values($1,$2,9,$3,clock_timestamp()+interval '10 minutes')",[input.projectId,owner,JSON.stringify(input.fileScopes)]);
 const request={assignmentId:claim.id,fence:claim.fence,childRunId:child,authorizationUri:uri,owner,intentFence:'9'};
 const authorization={...request,purpose:'close-terminal-read-only-reservation',projectId:input.projectId,policyHash:input.policyHash,originalAcceptanceChanged:false};
 await appendActionReceipt(c,{runId:input.sourceRunId,agentId:'workflow-orchestrator',actionType:'operator_partner_terminal_reconciliation_authorized',target:claim.id,summary:'Prospective closeout only',metadata:JSON.stringify(authorization)});
 await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'queue_partner_terminal_reconciliation_authorization',$2,$3)",[input.sourceRunId,uri,JSON.stringify(authorization)]);
 const originalBefore=(await c.query('select * from workflow_runs where id=$1',[input.sourceRunId])).rows;
 const refused=async(change:()=>Promise<unknown>)=>{await c.query('savepoint refusal');try{await change();assert.equal(await reconcileReadOnlyPartnerChildOnClient(c,request),false);}finally{await c.query('rollback to savepoint refusal;release savepoint refusal');}};
 assert.equal(await reconcileReadOnlyPartnerChildOnClient(c,{...request,fence:'999'}),false);
 assert.equal(await reconcileReadOnlyPartnerChildOnClient(c,{...request,owner:'foreign-owner'}),false);
 await refused(()=>c.query("update work_intents set expires_at=clock_timestamp()+interval '10 minutes' where owner=$1",[claim.owner]));
 await refused(()=>c.query("update work_intents set expires_at=clock_timestamp()-interval '1 second' where owner=$1",[owner]));
 await refused(()=>c.query("update work_intents set file_scopes='[\"foreign-scope\"]' where owner=$1",[owner]));
 await refused(()=>c.query("update artifacts set content='{}' where uri=$1",[uri]));
 await refused(()=>c.query("update action_receipts set summary='Changed authorization' where action_type='operator_partner_terminal_reconciliation_authorized'"));
 await refused(()=>c.query("update workflow_runs set status='running' where id=$1",[child]));
 await refused(()=>c.query("update workflow_tasks set status='queued' where run_id=$1",[child]));
 await refused(()=>c.query("insert into action_approvals values($1,$2,'executing')",[randomUUID(),child]));
 await refused(()=>c.query("insert into action_approvals values($1,$2,'approved')",[randomUUID(),child]));
 await refused(()=>c.query("insert into action_approvals values($1,$2,'approved')",[randomUUID(),input.sourceRunId]));
 await refused(async()=>{
  const policy={actions:{allowed_write_paths:[],allowed_commands:[],approval_rules:[{id:'unsafe-override',effect:'auto_execute',action_type:'file_write',target:'**'}]}};
  await c.query('update workflow_runs set policy_snapshot=$2,policy_snapshot_hash=$3 where id=$1',[child,JSON.stringify(policy),canonicalJsonHash(policy)]);
 });
 await refused(()=>c.query("update workflow_runs set policy_snapshot=jsonb_set(policy_snapshot,'{actions,allowed_commands}','[\"unsafe command\"]') where id=$1",[child]));
 await refused(()=>c.query("update workflow_runs set evaluation_metadata=jsonb_set(evaluation_metadata,'{queueCoordinatorFence}','\"999\"') where id=$1",[child]));
 await refused(()=>c.query("update workflow_runs set evaluation_metadata=jsonb_set(evaluation_metadata,'{recoveryTaskHash}','\"foreign\"') where id=$1",[child]));
 await refused(()=>c.query("update action_receipts set summary='Changed reservation' where action_type='queue_partner_reasoning_reserved'"));
 await refused(()=>c.query("update action_receipts set receipt_hash='broken' where run_id=$1",[child]));
 await refused(()=>c.query("update artifacts set content='{}' where uri=$1",[output]));
 await refused(()=>appendActionReceipt(c,{runId:child,agentId:'queue-partner',actionType:'file_write',target:'src/main.ts',summary:'A writer is never read-only',metadata:'{}'}));
 await c.query('savepoint expiry_before_effect');
 try{
  const expiringClient=new Proxy(c,{get(target,key){
   if(key!=='query')return Reflect.get(target,key);
   return async(...args:any[])=>{
    if(typeof args[0]==='string'&&args[0].includes("update queue_coordinator_assignments set state='held'"))
     await target.query("update work_intents set expires_at=clock_timestamp()-interval '1 second' where owner=$1",[owner]);
    return (target.query as any).apply(target,args);
   };
  }}) as Client;
  assert.equal(await reconcileReadOnlyPartnerChildOnClient(expiringClient,request),false,'Expiry during receipt verification is checked again at the effect');
 }finally{await c.query('rollback to savepoint expiry_before_effect;release savepoint expiry_before_effect');}
 await c.query('savepoint approved_before_effect');
 try{
  const approvingClient=new Proxy(c,{get(target,key){
   if(key!=='query')return Reflect.get(target,key);
   return async(...args:any[])=>{
    if(typeof args[0]==='string'&&args[0].includes("update queue_coordinator_assignments set state='held'"))
     await target.query("insert into action_approvals values($1,$2,'approved')",[randomUUID(),child]);
    return (target.query as any).apply(target,args);
   };
  }}) as Client;
  assert.equal(await reconcileReadOnlyPartnerChildOnClient(approvingClient,request),false,'Approved work arriving before the effect must still retain the assignment');
  assert.equal((await c.query('select state from queue_coordinator_assignments where id=$1',[claim.id])).rows[0].state,'uncertain');
 }finally{await c.query('rollback to savepoint approved_before_effect;release savepoint approved_before_effect');}
 await c.query('savepoint blocked_result');
 try{
  await c.query("update workflow_runs set status='blocked' where id=$1;",[child]);
  await c.query("update workflow_tasks set status='blocked' where run_id=$1",[child]);
  await appendActionReceipt(c,{runId:child,agentId:'queue-partner',actionType:'stage_blocked',target:task,summary:'Read-only result remains blocked',metadata:JSON.stringify({reason:'No native proof',outputUri:output})});
  assert.equal(await reconcileReadOnlyPartnerChildOnClient(c,request),true,'A bound blocked read-only result can release capacity without acceptance');
 }finally{await c.query('rollback to savepoint blocked_result;release savepoint blocked_result');}
 assert.equal(await reconcileReadOnlyPartnerChildOnClient(c,request),true);
 assert.equal(await reconcileReadOnlyPartnerChildOnClient(c,request),false,'Once-only closure is not a replay');
 assert.deepEqual((await c.query('select * from workflow_runs where id=$1',[input.sourceRunId])).rows,originalBefore);
 assert.equal((await c.query('select state from queue_coordinator_assignments where id=$1',[claim.id])).rows[0].state,'held');
 const audit=(await c.query("select metadata from action_receipts where action_type='queue_partner_terminal_read_only_reconciled'")).rows[0].metadata;
 assert.equal(audit.originalAcceptanceChanged,false);assert.equal(audit.budgetRefunded,false);assert.equal(audit.priorState,'uncertain');
 assert.equal(Number((await c.query("select count(*) n from action_receipts where action_type='queue_partner_reasoning_reserved'")).rows[0].n),1);
}));
