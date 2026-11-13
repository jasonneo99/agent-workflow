import assert from 'node:assert/strict';
import test from 'node:test';
import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import {withClient} from './client.js';
import {acceptanceDigest} from './acceptance.js';
import {repairRevisionRequirementsDigest} from './repaired-revision.js';
import {reconcileQueuedReviewPreflightOnClient,reconcileQueuedReviewReadinessOnClient} from './queued-review-preflight.js';
import {canonicalJsonHash} from '../../policy-engine/src/index.js';

function fixture(readiness=false){
 const original={version:1,contractId:'original',originRunId:'source',projectId:'project',taskHash:acceptanceDigest('Original task'),subjectHash:'hash',sourcePaths:['source.ts'],deliverables:[{id:'original',description:'Original requirement',requiredGates:['implementation','verification','packaging','supervision'],status:'pending',receipts:{},gaps:[]}]};
 const input={claimId:'claim',claimFence:'7',owner:'owner',intentFence:'9',reviewRunId:'review',approvalId:'approval'};
 const q={state:'held',role:'verifier',owner:'owner',intent_fence:'9',child_id:'review',source_id:'source',project_key:'project',family_id:'project:family',canonical:true,root_uri:'/synthetic',file_scopes:['source.ts'],reason:'Preflight SQL failed'};
 const source={run_id:'source',project_key:'project',run_set_id:'family',task:'Original task',evaluation_metadata:{acceptanceContract:original},provider_override:'codex-cli',model_tier_override:'standard'};
 const policy={actions:{allowed_write_paths:[],allowed_commands:['python3 -m unittest discover -s tests'],isolate_command_writes:true}};
 const review={run_id:'review',project_key:'project',status:'queued',task:source.task,lease_owner:null as string|null,lease_expires_at:null as string|null,policy_snapshot:policy,policy_snapshot_hash:canonicalJsonHash(policy),provider_override:'codex-cli',model_tier_override:'standard',evaluation_metadata:{kind:'explicit-independent-acceptance-review',noAutomaticRepeat:true,sourceRunId:'source',queueCoordinatorClaimId:'claim',queueCoordinatorFence:'7',independentReviewAuthorizationUri:'db://auth',independentReviewReservationAuthorizationUri:'db://reservation',originalAcceptanceDigest:acceptanceDigest(original),acceptanceContract:{...original,contractId:'review-contract',originRunId:'review'}}};
 const auth={version:1,authority:'direct-human',approvalDecision:'approved',offlineOnly:true,sourceRunId:'source',reviewRunId:'review',projectId:'project',projectRootUri:'/synthetic',claimId:'claim',claimFence:'7',authorizedCommands:['python3 -m unittest discover -s tests'],originalContractDigest:acceptanceDigest(original),requirementsDigest:repairRevisionRequirementsDigest(original),sourceHash:'hash',sourcePaths:['source.ts'],provider:'codex-cli',modelTier:'standard'};
 const readinessGrant={version:1,authority:'direct-human',approvalDecision:'approved',operation:'resume-same-unstarted-review',claimId:'claim',claimFence:'7',owner:'owner',intentFence:'9',sourceRunId:'source',reviewRunId:'review',workerPlatform:process.platform,resumeLimit:1,permissionsChanged:false};
 const state={q,source,review,auth,readinessGrant,intent:true,effects:false,pending:false,pendingEffects:false,capacity:0,overlap:false,commandsAllowed:true,platformAllowed:true,grantValid:true,canonical:true,chain:true,reservation:true,hash:'hash',tasks:[{id:'task',status:'queued',attempts:0,started_at:null as string|null,worker_id:null as string|null,lease_expires_at:null as string|null}],approval:{status:'failed',action_type:'local_command',exact_failure:true,task_id:'task',target:'python3 -m unittest discover -s tests'},audits:[] as unknown[],updates:0};
 const c={query:async(sql:string)=>{
  const rows=sql.includes('pg_advisory_xact_lock')?[]:sql.includes('update queue_coordinator_assignments')?(state.updates++,[{}]):sql.includes('operator_queued_review_readiness_authorized')?state.grantValid?[{content:state.readinessGrant}]:[]
   :sql.includes("config->'execution'")?[{platforms:state.platformAllowed?[process.platform]:[]}]:sql.includes('union all select 1 from side_effect_receipts')?state.pendingEffects?[{}]:[]
   :sql.includes("kind='queue_external_reservation'")?[]:sql.includes('select id::text,fence::text,source_run_id::text')?[]
   :sql.includes(' as dependencies')?[{count:state.capacity,dependencies:0,verifier:false}]:sql.includes('select file_scopes from queue_coordinator_assignments')?state.overlap?[{file_scopes:['source.ts']}]:[]
   :sql.includes('select q.*,q.source_run_id')?[state.q]:sql.includes('from work_intents')?state.intent?[{}]:[]
   :sql.includes('select *,id::text run_id')?[state.source,state.review]:sql.includes('select id::text,status,attempts')?state.tasks
   :sql.includes("select 1 from artifacts where run_id=$1")?state.effects?[{}]:[]:sql.includes('select a.*,exists')?[state.approval]
   :sql.includes('select content from artifacts')?[{content:state.auth}]:sql.includes('select receipt_hash from action_receipts')?[{receipt_hash:'a'.repeat(64)}]
   :sql.includes('with recursive family')?state.pending?[{}]:[]:sql.includes('update queue_coordinator_assignments')?(state.updates++,[{}])
   :(()=>{throw Error('Unexpected SQL: '+sql);})();return{rows,rowCount:rows.length};
 }} as unknown as Client;
 const hooks={canonicalRoot:async()=>state.canonical,chain:async()=>state.chain,hash:async()=>state.hash,reservation:async()=>state.reservation,commandsAllowed:async()=>state.commandsAllowed,audit:async(_c:Client,_source:string,payload:Record<string,unknown>)=>{state.audits.push(payload);}};
 const {approvalId,...common}=input;
 const run=()=>readiness?reconcileQueuedReviewReadinessOnClient(c,{...common,workerPlatform:process.platform,readinessAuthorizationArtifactUri:'db://readiness'},hooks):reconcileQueuedReviewPreflightOnClient(c,input,hooks);
 return{state,run};
}
test('pre-effect SQL correction rearms only the existing unstarted queued claim and retains all review/approval data',async()=>{
 const {state,run}=fixture(),before=JSON.stringify({source:state.source,review:state.review,approval:state.approval,tasks:state.tasks});
 assert.equal(await run(),true);assert.equal(state.updates,1);assert.equal(state.audits.length,1);
 assert.equal(JSON.stringify({source:state.source,review:state.review,approval:state.approval,tasks:state.tasks}),before);
});
for(const[name,change]of Object.entries({
 expired:(s:ReturnType<typeof fixture>['state'])=>{s.intent=false;},
 owner:(s:ReturnType<typeof fixture>['state'])=>{s.q.owner='other';},
 fence:(s:ReturnType<typeof fixture>['state'])=>{s.review.evaluation_metadata.queueCoordinatorFence='8';},
 started:(s:ReturnType<typeof fixture>['state'])=>{s.tasks[0].started_at='2026-01-01';},
 attempted:(s:ReturnType<typeof fixture>['state'])=>{s.tasks[0].attempts=1;},
 terminal:(s:ReturnType<typeof fixture>['state'])=>{s.review.status='blocked';},
 effectOrUsed:(s:ReturnType<typeof fixture>['state'])=>{s.effects=true;},
 unrelatedFailure:(s:ReturnType<typeof fixture>['state'])=>{s.approval.exact_failure=false;},
 alreadyExecuted:(s:ReturnType<typeof fixture>['state'])=>{s.approval.status='executed';},
 unauthorizedCommand:(s:ReturnType<typeof fixture>['state'])=>{s.approval.target='other';},
 authMismatch:(s:ReturnType<typeof fixture>['state'])=>{s.auth.reviewRunId='other';},
 reservation:(s:ReturnType<typeof fixture>['state'])=>{s.reservation=false;},
 chain:(s:ReturnType<typeof fixture>['state'])=>{s.chain=false;},
 drift:(s:ReturnType<typeof fixture>['state'])=>{s.hash='drift';},
 pending:(s:ReturnType<typeof fixture>['state'])=>{s.pending=true;},
 changedRequirements:(s:ReturnType<typeof fixture>['state'])=>{s.review.evaluation_metadata.acceptanceContract.deliverables=[];}
}))test(`preflight correction refuses ${name}`,async()=>{const{state,run}=fixture();change(state);assert.equal(await run(),false);assert.equal(state.updates,0);assert.equal(state.audits.length,0);});

test('readiness correction preserves the same untouched review, fence, original data and consumed authorization',async()=>{
 const{state,run}=fixture(true),before=JSON.stringify({source:state.source,review:state.review,tasks:state.tasks});
 assert.equal(await run(),true);assert.equal(state.updates,1);assert.equal(state.audits.length,1);
 assert.equal(JSON.stringify({source:state.source,review:state.review,tasks:state.tasks}),before);
 assert.equal((state.audits[0] as any).budgetRefunded,false);
 state.effects=true;assert.equal(await run(),false,'The durable correction ledger prevents another rearm');
});
for(const[name,change]of Object.entries({
 missingGrant:(s:ReturnType<typeof fixture>['state'])=>{s.grantValid=false;},
 changedGrant:(s:ReturnType<typeof fixture>['state'])=>{s.readinessGrant.claimFence='8';},
 expired:(s:ReturnType<typeof fixture>['state'])=>{s.intent=false;},
 foreignOwner:(s:ReturnType<typeof fixture>['state'])=>{s.q.owner='other';},
 terminal:(s:ReturnType<typeof fixture>['state'])=>{s.review.status='blocked';},
 attempted:(s:ReturnType<typeof fixture>['state'])=>{s.tasks[0].attempts=1;},
 leased:(s:ReturnType<typeof fixture>['state'])=>{s.tasks[0].worker_id='other';},
 activeRunLease:(s:ReturnType<typeof fixture>['state'])=>{s.review.lease_owner='other';},
 effectOrUsed:(s:ReturnType<typeof fixture>['state'])=>{s.effects=true;},
 pendingEffectOrApproval:(s:ReturnType<typeof fixture>['state'])=>{s.pendingEffects=true;},
 fullCapacity:(s:ReturnType<typeof fixture>['state'])=>{s.capacity=5;},
 overlappingWriter:(s:ReturnType<typeof fixture>['state'])=>{s.overlap=true;},
 wrongPlatform:(s:ReturnType<typeof fixture>['state'])=>{s.platformAllowed=false;},
 revokedCommand:(s:ReturnType<typeof fixture>['state'])=>{s.commandsAllowed=false;},
 policyDrift:(s:ReturnType<typeof fixture>['state'])=>{s.review.policy_snapshot_hash='drift';},
 sourceDrift:(s:ReturnType<typeof fixture>['state'])=>{s.hash='drift';},
 chain:(s:ReturnType<typeof fixture>['state'])=>{s.chain=false;},
 sealedReservation:(s:ReturnType<typeof fixture>['state'])=>{s.reservation=false;},
 pendingFamily:(s:ReturnType<typeof fixture>['state'])=>{s.pending=true;}
}))test(`readiness correction refuses ${name}`,async()=>{const{state,run}=fixture(true);change(state);assert.equal(await run(),false);assert.equal(state.updates,0);assert.equal(state.audits.length,0);});

test('production-shaped PostgreSQL preflight preserves the same queued review with TEXT intent project IDs',async()=>withClient(async c=>{
 await c.query('begin');try{
  const schema=`queued_preflight_${randomUUID().replaceAll('-','')}`;
  await c.query(`create schema ${schema};set local search_path to ${schema},public;
   create table projects(id uuid,root_uri text,config jsonb default '{}');create table project_identity_locations(project_id uuid,identity_id uuid,kind text);
   create table workflow_runs(id uuid,project_id uuid,run_set_id uuid,task text,status text,evaluation_metadata jsonb,policy_snapshot jsonb,provider_override text,model_tier_override text,lease_owner text,lease_expires_at timestamptz,policy_snapshot_hash text);
   create table workflow_tasks(id uuid,run_id uuid,status text,attempts int,started_at timestamptz,worker_id text,lease_expires_at timestamptz);
   create table queue_coordinator_assignments(id uuid,fence bigint,project_id uuid,source_run_id uuid,child_run_id uuid,family_id text,role text,state text,owner text,intent_fence text,file_scopes jsonb,reason text,updated_at timestamptz,lane integer default 1);
   create table work_intents(project_id text,owner text,fencing_token bigint,file_scopes jsonb,expires_at timestamptz);
   create table side_effect_receipts(project_id text,status text);
   create table artifacts(run_id uuid,kind text,uri text,content jsonb);
   create table action_receipts(run_id uuid,action_type text,target text,metadata jsonb,agent_id text,receipt_hash text);
   create table action_approvals(id uuid,run_id uuid,task_id uuid,status text,action_type text,target text,idempotency_key text);`);
  const project=randomUUID(),source=randomUUID(),review=randomUUID(),set=randomUUID(),claim=randomUUID(),approval=randomUUID(),task=randomUUID(),family=`${project}:${set}`,paths=['source.ts'];
  const original={version:1,contractId:'original',originRunId:source,projectId:project,taskHash:acceptanceDigest('task'),subjectHash:'hash',sourcePaths:paths,deliverables:[{id:'original',description:'Original requirements',requiredGates:['implementation','verification','packaging','supervision'],status:'pending',receipts:{},gaps:[]}]};
  const auth={version:1,authority:'direct-human',approvalDecision:'approved',offlineOnly:true,sourceRunId:source,reviewRunId:review,projectId:project,projectRootUri:'/synthetic',claimId:claim,claimFence:'7',authorizedCommands:['python3 -m unittest discover -s tests'],originalContractDigest:acceptanceDigest(original),requirementsDigest:repairRevisionRequirementsDigest(original),sourceHash:'hash',sourcePaths:paths,provider:'codex-cli',modelTier:'standard'};
  const metadata={kind:'explicit-independent-acceptance-review',noAutomaticRepeat:true,sourceRunId:source,queueCoordinatorClaimId:claim,queueCoordinatorFence:'7',independentReviewAuthorizationUri:'db://full-auth',independentReviewReservationAuthorizationUri:'db://reservation',originalAcceptanceDigest:acceptanceDigest(original),acceptanceContract:{...original,contractId:'review',originRunId:review}};
  await c.query("insert into projects values($1,'/synthetic')",[project]);
  await c.query("insert into project_identity_locations values($1,$1,'canonical')",[project]);
  await c.query("insert into workflow_runs values($1,$2,$3,'task','failed',$4::jsonb,'{}','codex-cli','standard'),($5,$2,$3,'task','queued',$6::jsonb,'{\"actions\":{\"allowed_write_paths\":[]}}','codex-cli','standard')",[source,project,set,JSON.stringify({acceptanceContract:original}),review,JSON.stringify(metadata)]);
  await c.query("insert into workflow_tasks values($1,$2,'queued',0,null)",[task,review]);
  await c.query("insert into queue_coordinator_assignments values($1,7,$2,$3,$4,$5,'verifier','held','owner','9',$6::jsonb,'pre-effect SQL failure',clock_timestamp())",[claim,project,source,review,family,JSON.stringify(paths)]);
  await c.query("insert into work_intents values($1,'owner',9,$2::jsonb,clock_timestamp()-interval '1 second')",[project,JSON.stringify(paths)]);
  await c.query("insert into artifacts values($1,'independent_acceptance_review_authorization','db://full-auth',$2::jsonb)",[source,JSON.stringify(auth)]);
  await c.query("insert into action_approvals values($1,$2,$3,'failed','local_command','python3 -m unittest discover -s tests','key')",[approval,review,task]);
  await c.query("insert into action_receipts values($1,'action_approval_failed','approval',$2::jsonb,'operator',$3),($4,'independent_acceptance_review_authorization','db://full-auth',$5::jsonb,'operator',$3)",[review,JSON.stringify({approvalId:approval,error:'operator does not exist: text = uuid',actionType:'local_command',status:'failed',target:'python3 -m unittest discover -s tests',idempotencyKey:'key'}),'a'.repeat(64),source,JSON.stringify(auth)]);
  const input={claimId:claim,claimFence:'7',owner:'owner',intentFence:'9',reviewRunId:review,approvalId:approval};let auditCount=0;
  const hooks={canonicalRoot:async()=>true,chain:async()=>true,hash:async()=>'hash',reservation:async()=>true,audit:async()=>{auditCount++;}};
  await c.query('savepoint readiness_fixture');
  const readinessUri='db://readiness',policy={actions:{allowed_commands:auth.authorizedCommands,allowed_write_paths:[],isolate_command_writes:true}};
  const readinessGrant={version:1,authority:'direct-human',approvalDecision:'approved',operation:'resume-same-unstarted-review',claimId:claim,claimFence:'7',owner:'owner',intentFence:'9',sourceRunId:source,reviewRunId:review,workerPlatform:process.platform,resumeLimit:1,permissionsChanged:false};
  const readinessInput={claimId:claim,claimFence:'7',owner:'owner',intentFence:'9',reviewRunId:review,workerPlatform:process.platform,readinessAuthorizationArtifactUri:readinessUri};
  await c.query('update projects set config=$1',[JSON.stringify({execution:{worker_pool:{allowed_platforms:[process.platform]}}})]);
  await c.query('update workflow_runs set policy_snapshot=$2,policy_snapshot_hash=$3 where id=$1',[review,JSON.stringify(policy),canonicalJsonHash(policy)]);
  await c.query("insert into artifacts values($1,'queued_review_readiness_authorization',$2,$3)",[source,readinessUri,JSON.stringify(readinessGrant)]);
  await c.query("insert into action_receipts values($1,'operator_queued_review_readiness_authorized',$2,$3,'workflow-orchestrator',$4)",[source,readinessUri,JSON.stringify(readinessGrant),'a'.repeat(64)]);
  const readinessHooks={...hooks,commandsAllowed:async()=>true,audit:async(client:Client,_source:string,payload:Record<string,unknown>)=>{
   await client.query("insert into action_receipts values($1,'queued_review_readiness_reconciled',$2,$3,'workflow-orchestrator',$4)",[source,claim,JSON.stringify(payload),'b'.repeat(64)]);
  }};
  assert.equal(await reconcileQueuedReviewReadinessOnClient(c,readinessInput,readinessHooks),false,'Expired original intent cannot rearm a review');
  await c.query("update work_intents set expires_at=clock_timestamp()+interval '1 minute'");
  assert.equal(await reconcileQueuedReviewReadinessOnClient(c,readinessInput,readinessHooks),false,'Unresolved approval cannot be hidden by a readiness correction');
  await c.query('delete from action_approvals where id=$1',[approval]);
  const readinessBefore=(await c.query('select * from workflow_runs order by id')).rows,tasksBefore=(await c.query('select * from workflow_tasks')).rows;
  assert.equal(await reconcileQueuedReviewReadinessOnClient(c,{...readinessInput,claimFence:'8'},readinessHooks),false);
  await c.query("update workflow_tasks set worker_id='other'");
  assert.equal(await reconcileQueuedReviewReadinessOnClient(c,readinessInput,readinessHooks),false);
  await c.query('update workflow_tasks set worker_id=null');
  assert.equal(await reconcileQueuedReviewReadinessOnClient(c,readinessInput,readinessHooks),true);
  assert.equal((await c.query('select fence::text from queue_coordinator_assignments')).rows[0].fence,'7');
  assert.deepEqual((await c.query('select * from workflow_runs order by id')).rows,readinessBefore);
  assert.deepEqual((await c.query('select * from workflow_tasks')).rows,tasksBefore);
  await c.query("update queue_coordinator_assignments set state='held'");
  assert.equal(await reconcileQueuedReviewReadinessOnClient(c,readinessInput,readinessHooks),false,'A later hold never refunds the once-only readiness ledger');
  await c.query('rollback to savepoint readiness_fixture');
  assert.equal(await reconcileQueuedReviewPreflightOnClient(c,input,hooks),false,'Expired TEXT intent is denied');
  await c.query("update work_intents set expires_at=clock_timestamp()+interval '1 minute'");
  assert.equal(await reconcileQueuedReviewPreflightOnClient(c,{...input,claimFence:'8'},hooks),false);
  const before=(await c.query('select * from workflow_runs order by id')).rows;
  assert.equal(await reconcileQueuedReviewPreflightOnClient(c,input,hooks),true);assert.equal(auditCount,1);
  assert.equal(await reconcileQueuedReviewPreflightOnClient(c,input,hooks),false);
  assert.deepEqual((await c.query('select * from workflow_runs order by id')).rows,before);
  assert.equal((await c.query('select status from action_approvals where id=$1',[approval])).rows[0].status,'failed');
 }finally{await c.query('rollback');}
}));
