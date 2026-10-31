import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Client } from "pg";
import { withClient } from "./client.js";
import { acceptanceDigest } from "./acceptance.js";
import { repairFingerprint } from "./repair-dispatch.js";
import { acknowledgeQueuePartnerOutcomeJournalOnClient,finishQueueCoordinatorOnClient,queueCoordinatorSchemaSql, reserveCoordinatorOnClient, reconcileUnstartedCoordinatorReservationOnClient, reconcileBlockedVerifierOnClient, type CoordinatorReservation } from "./queue-coordinator.js";
import { repairedRevisionSchemaSql, captureRepairRevisionManifest,repairRevisionManifestHash,repairRevisionRequirementsDigest } from "./repaired-revision.js";
import { legacyRecoverySchemaSql,enrollLegacyRecoveryOnClient } from "./legacy-recovery.js";
import { appendActionReceipt } from "./receipt-writer.js";
import { chainReceipt, RECEIPT_CHAIN_GENESIS } from "../../workflow-engine/src/receipt-chain.js";

test('Partner child creation, exposure and fenced attachment share one transaction with idempotent retry',async()=>{
 const postgres=await fs.readFile(new URL('./postgres.ts',import.meta.url),'utf8'),coordinator=await fs.readFile(new URL('./queue-coordinator.ts',import.meta.url),'utf8');
 assert.match(postgres,/queuePartnerEnrollment\?: import\('\.\/queue-coordinator\.js'\)\.QueuePartnerChildEnrollment/);
 assert.equal((postgres.match(/enrollQueuePartnerChildOnClient\(client,/g)??[]).length,2,'new and deduplicated runs both enroll before commit');
 const newRun=postgres.slice(postgres.indexOf('const runId = runResult.rows[0].id'),postgres.indexOf('await client.query("commit")',postgres.indexOf('const runId = runResult.rows[0].id')));
 assert.match(newRun,/enrollQueuePartnerChildOnClient\(client,runId/);
 assert.match(coordinator,/registerQueuePartnerExperimentExposureOnClient\(c/);
 assert.ok(coordinator.indexOf('registerQueuePartnerExperimentExposureOnClient(c')<coordinator.indexOf('attachCoordinatorChildOnClient(c,enrollment.claim,runId)'));
 assert.match(coordinator,/existing\?\.state==='running'&&existing\.childRunId===runId/);
});

async function fixture(body:(c:Client, make:(name:string, scope?:string)=>Promise<CoordinatorReservation>)=>Promise<void>) {
 await withClient(async c=>{await c.query("begin");try{
  const schema=`coordinator_test_${randomUUID().replaceAll("-","")}`;
  await c.query(`create schema ${schema}; set local search_path to ${schema},public;
   create table projects(id uuid primary key,root_uri text);
   create table workflow_runs(id uuid primary key,project_id uuid references projects(id),run_set_id uuid,task text,evaluation_metadata jsonb,status text,started_at timestamptz default clock_timestamp(),replacement_run_id uuid);
   create table workflow_tasks(id uuid primary key,run_id uuid,status text);
   create table action_approvals(id uuid primary key,run_id uuid,status text);
   create table side_effect_receipts(project_id text,status text,idempotency_key text);
   create table action_receipts(id uuid primary key,run_id uuid,action_type text,target text,metadata jsonb,summary text,created_at timestamptz default now(),receipt_hash text);
   create table artifacts(id uuid primary key default gen_random_uuid(),run_id uuid,kind text,uri text,content jsonb);
   create table work_intents(project_id text,owner text,fencing_token bigint,file_scopes jsonb,expires_at timestamptz);
   create table project_identity_locations(project_id uuid,identity_id uuid,kind text);`);
  await c.query(queueCoordinatorSchemaSql);
  const projectId=randomUUID();
  await c.query("insert into projects values($1,'/synthetic/product')",[projectId]);
  await c.query("insert into project_identity_locations values($1,$1,'canonical')",[projectId]);
  const make=async(name:string,scope=`src/${name}.ts`):Promise<CoordinatorReservation>=>{
   const run=randomUUID(),set=randomUUID(),task=`Repair ${name}`,owner=`fixture:${name}`;
   const contract={version:1,originRunId:run,projectId,taskHash:acceptanceDigest(task),subjectHash:"frozen-source",sourcePaths:[scope],deliverables:[{id:"fix",description:"Verified fix",status:"pending",requiredGates:["implementation","verification","packaging","supervision"],receipts:{},gaps:[]}]};
   await c.query("insert into workflow_runs values($1,$2,$3,$4,$5,'blocked')",[run,projectId,set,task,JSON.stringify({acceptanceContract:contract})]);
   await c.query("insert into work_intents values($1,$2,7,$3,now()+interval '10 minutes')",[projectId,owner,JSON.stringify([scope])]);
   return {familyId:`${projectId}:${set}`,sourceRunId:run,projectId,projectRootUri:"/synthetic/product",role:"repair",lane:1,owner,fingerprint:repairFingerprint(task,""),intentFence:"7",fileScopes:[scope]};
  };
  await body(c,make);
 }finally{await c.query("rollback");}});
}
const reserve=(c:Client,r:CoordinatorReservation)=>reserveCoordinatorOnClient(c,r,async()=>{});

test('ordinary reservation instance proof is captured from the live intent, never caller metadata',async()=>fixture(async(c,make)=>{
 await c.query('alter table work_intents add column id uuid default gen_random_uuid()');
 const input={...await make('instance-proof'),intentId:randomUUID()};
 const actual=(await c.query('select id::text from work_intents where owner=$1',[input.owner])).rows[0].id;
 let audited:Record<string,unknown>|undefined;
 const claim=await reserveCoordinatorOnClient(c,input,async(_c,_run,_action,content)=>{audited=content;});
 assert.ok(claim);assert.equal(claim.intentId,actual);assert.equal(audited?.intentId,actual);assert.notEqual(claim.intentId,input.intentId);
}));

test('ordinary repair reservation rejects a source hidden after planning without changing its history',async()=>fixture(async(c,make)=>{
 const input=await make('hidden-after-plan');
 await c.query("insert into action_receipts(id,run_id,action_type,metadata) values($1,$2,'failed_run_superseded','{}')",[randomUUID(),input.sourceRunId]);
 const before=(await c.query('select * from workflow_runs')).rows;
 assert.equal(await reserve(c,input),null);assert.deepEqual((await c.query('select * from workflow_runs')).rows,before);
 assert.equal(Number((await c.query('select count(*) n from queue_coordinator_assignments')).rows[0].n),0);
}));
test('coordinator finalization and the minimal outcome journal commit in one transaction',async()=>fixture(async(c,make)=>{
 const reservation=await make('atomic-outcome'),claim=await reserve(c,reservation);assert.ok(claim);
 await finishQueueCoordinatorOnClient(c,claim,'held','Recovery finished but detailed memory may retry',{phaseTimings:{planning:4,execution:9},resolutionStrategy:'repair-exact-source',blockedSince:'2026-10-26T20:00:00.000Z'},async()=>{});
 const assignment=(await c.query('select state,reason from queue_coordinator_assignments where id=$1',[claim.id])).rows[0];
 const journal=(await c.query('select state,reason,payload,delivery_state from queue_partner_outcome_journal where assignment_id=$1 and fence=$2',[claim.id,claim.fence])).rows[0];
 assert.equal(assignment.state,'held');assert.equal(journal.state,'held');assert.equal(journal.delivery_state,'pending');
 assert.equal(journal.payload.version,2);assert.equal(journal.payload.familyId,claim.familyId);assert.deepEqual(journal.payload.phaseTimings,{planning:4,execution:9});
 assert.equal(journal.payload.resolutionStrategy,'repair-exact-source');assert.equal(journal.payload.blockedSince,'2026-10-26T20:00:00.000Z');assert.equal(Object.hasOwn(journal.payload,'task'),false);
}));

test('only the exact finalized child can acknowledge detailed outcome-memory delivery',async()=>fixture(async(c,make)=>{
 const reservation=await make('atomic-ack'),claim=await reserve(c,reservation);assert.ok(claim);const child=randomUUID();
 await c.query("insert into workflow_runs values($1,$2,$3,'child','{}','completed')",[child,claim.projectId,randomUUID()]);
 await c.query('update queue_coordinator_assignments set child_run_id=$2 where id=$1',[claim.id,child]);
 await finishQueueCoordinatorOnClient(c,claim,'held','Detailed memory pending',{runId:child},async()=>{});
 assert.equal(await acknowledgeQueuePartnerOutcomeJournalOnClient(c,claim,randomUUID()),false);
 assert.equal(await acknowledgeQueuePartnerOutcomeJournalOnClient(c,claim,child),true);
 assert.equal(await acknowledgeQueuePartnerOutcomeJournalOnClient(c,claim,child),false,'Acknowledgement is idempotent and cannot be replayed');
}));

test('fresh independent dependency workflows occupy repair capacity and the single verifier lane',async()=>fixture(async(c,make)=>{
 const target=await make('dependency-target'),dependency=await make('dependency-original');
 for(let lane=1;lane<=4;lane++){const r=await make(`occupied-${lane}`);assert.ok(await reserve(c,{...r,lane}));}
 await c.query("update workflow_runs set status='queued',evaluation_metadata=evaluation_metadata||'{\"source\":\"authorized-project-dependency\"}'::jsonb where id=$1",[dependency.sourceRunId]);
 assert.equal(await reserve(c,{...target,lane:5}),null,'Four repairs plus one dependency consume five family slots');
 assert.equal(await reserve(c,{...target,role:'verifier',lane:1}),null,'Authored dependency verification cannot overlap coordinator verifier');
 await c.query("update workflow_runs set status='completed' where id=$1",[dependency.sourceRunId]);
 assert.ok(await reserve(c,{...target,lane:5}),'Existing coordinator lane guards remain usable after dependency terminates');
}));

test("one exact new human review grant reserves once without bypassing ordinary holds, scope or lane guards", async () => {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'explicit-review-reservation-')));
 try { await fs.writeFile(path.join(root,'source.ts'),'synthetic unchanged source');
  await fixture(async(c,make)=>{
   await c.query(`alter table workflow_runs add column provider_override text,add column model_tier_override text;
    alter table action_receipts add column agent_id text,add column if not exists receipt_hash text,add column prev_hash text,add column metadata_serialization_version integer;`);
   const r={...await make('new-explicit-review','source.ts'),role:'verifier' as const,projectRootUri:root};
   await c.query('update projects set root_uri=$1',[root]);
   const manifest=await captureRepairRevisionManifest(root,r.fileScopes),subjectHash=repairRevisionManifestHash(manifest);
   const contract=(await c.query('select evaluation_metadata->\'acceptanceContract\' contract from workflow_runs where id=$1',[r.sourceRunId])).rows[0].contract;
   contract.contractId='frozen-original';contract.subjectHash=subjectHash;
   await c.query('update workflow_runs set evaluation_metadata=$2::jsonb,provider_override=\'codex-cli\',model_tier_override=\'standard\' where id=$1',[r.sourceRunId,JSON.stringify({acceptanceContract:contract})]);
   const first=await reserve(c,r);assert.ok(first);await c.query("update queue_coordinator_assignments set state='held' where id=$1",[first.id]);
   assert.equal(await reserve(c,r),null,'Ordinary unchanged fingerprint remains denied');
   const uri='db://synthetic/one-new-review',authorizationId=randomUUID(),approvalKey='synthetic-exact-human-grant';
   const auth={version:1,authority:'direct-human',approvalDecision:'approved',offlineOnly:true,reviewLimit:1,authorizationId,approvalKey,sourceRunId:r.sourceRunId,projectId:r.projectId,projectRootUri:root,familyId:r.familyId,failureFingerprint:r.fingerprint,sourcePaths:r.fileScopes,taskHash:contract.taskHash,originalContractDigest:acceptanceDigest(contract),requirementsDigest:repairRevisionRequirementsDigest(contract),sourceHash:subjectHash,provider:'codex-cli',modelTier:'standard'};
   const createdAt=new Date().toISOString(),metadata=JSON.stringify(auth),receipt=chainReceipt(RECEIPT_CHAIN_GENESIS,{runId:r.sourceRunId,agentId:'operator',actionType:'independent_review_reservation_authorized',target:uri,summary:'Exact one new readonly review grant',metadata,createdAt,metadataSerializationVersion:2});
   await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'independent_review_reservation_authorization',$2,$3::jsonb)",[r.sourceRunId,uri,metadata]);
   await c.query("insert into action_receipts(id,run_id,agent_id,action_type,target,summary,metadata,created_at,prev_hash,receipt_hash,metadata_serialization_version) values($1,$2,'operator','independent_review_reservation_authorized',$3,'Exact one new readonly review grant',$4::jsonb,$5,$6,$7,2)",[randomUUID(),r.sourceRunId,uri,metadata,createdAt,receipt.prevHash,receipt.receiptHash]);
   const authorized={...r,independentReviewReservationAuthorizationUri:uri};
   const beforeRuns=(await c.query('select * from workflow_runs')).rows,beforeApprovals=(await c.query('select * from action_approvals')).rows;
   assert.equal(await reserve(c,{...authorized,fileScopes:['other.ts']}),null,'Wrong source scope is not authorized');
   assert.equal(await reserve(c,{...authorized,role:'repair'}),null,'Grant cannot reserve repairs');
   await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'independent_review_reservation_authorization','db://duplicate',$2::jsonb)",[r.sourceRunId,metadata]);
   assert.equal(await reserve(c,authorized),null,'Ambiguous duplicate approval key is refused');await c.query("delete from artifacts where uri='db://duplicate'");
   await fs.writeFile(path.join(root,'source.ts'),'drift');assert.equal(await reserve(c,authorized),null,'Drifted source is refused');await fs.writeFile(path.join(root,'source.ts'),'synthetic unchanged source');
   await c.query("insert into action_approvals values($1,$2,'pending')",[randomUUID(),r.sourceRunId]);assert.equal(await reserve(c,authorized),null,'Pending approvals remain blocking');await c.query('delete from action_approvals');
   const busy=await make('busy-independent-family');const busyClaim=await reserve(c,{...busy,projectRootUri:root,role:'verifier'});assert.ok(busyClaim);
   assert.equal(await reserve(c,authorized),null,'Single verifier capacity remains binding');await c.query("update queue_coordinator_assignments set state='held' where id=$1",[busyClaim.id]);
   const claim=await reserve(c,authorized);assert.ok(claim);assert.notEqual(claim.fingerprint,r.fingerprint);
   for(const state of ['reserved','running','held','failed','verified','uncertain']){await c.query('update queue_coordinator_assignments set state=$2 where id=$1',[claim.id,state]);assert.equal(await reserve(c,authorized),null,`Grant consumed in ${state}`);}
   assert.equal(await reserve(c,r),null,'No ordinary retry permission was introduced');
   assert.deepEqual((await c.query('select * from workflow_runs where id=$1',[r.sourceRunId])).rows,beforeRuns.filter(x=>x.id===r.sourceRunId));assert.deepEqual((await c.query('select * from action_approvals')).rows,beforeApprovals);
  });
 } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("coordinator requires canonical original contract and exact live intent fence",async()=>fixture(async(c,make)=>{
 const r=await make("authority");
 assert.equal(await reserve(c,{...r,legacyEnrollmentId:randomUUID()}),null,"Frozen original cannot be replaced by legacy enrollment");
 assert.equal(await reserve(c,{...r,intentFence:"6"}),null);
 assert.equal(await reserve(c,{...r,projectRootUri:"/synthetic/vendor/product"}),null);
 assert.equal(await reserve(c,{...r,familyId:randomUUID()}),null);
 assert.equal(await reserve(c,{...r,fingerprint:"invented"}),null);
 await c.query("update project_identity_locations set kind='checkout'");
 assert.equal(await reserve(c,r),null);
 await c.query("update project_identity_locations set kind='canonical'");
 await c.query("update workflow_runs set evaluation_metadata=jsonb_set(evaluation_metadata,'{sourceRunId}',to_jsonb($2::text)) where id=$1",[r.sourceRunId,randomUUID()]);
 assert.equal(await reserve(c,r),null);
 await c.query("update workflow_runs set evaluation_metadata=evaluation_metadata-'sourceRunId' where id=$1",[r.sourceRunId]);
 await c.query("update workflow_runs set evaluation_metadata=jsonb_set(evaluation_metadata,'{acceptanceContract,version}','2') where id=$1",[r.sourceRunId]);
 assert.equal(await reserve(c,r),null);
 await c.query("update workflow_runs set evaluation_metadata=jsonb_set(evaluation_metadata,'{acceptanceContract,version}','1') where id=$1",[r.sourceRunId]);
 assert.ok(await reserve(c,r));
}));

test("coordinator persists an additive exact legacy enrollment identity without changing original contracts",()=>{
 assert.match(queueCoordinatorSchemaSql,/add column if not exists legacy_enrollment_id uuid/);
 assert.doesNotMatch(queueCoordinatorSchemaSql,/update workflow_runs|alter table workflow_runs|delete from workflow_runs/);
});

test("explicit unstarted reconciliation is once-only, fenced and refuses every possible-effect boundary",async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'unstarted-coordinator-')));
 try{
  await fs.writeFile(path.join(root,'source.ts'),'unchanged enrolled source');
  await withClient(async c=>{await c.query('begin');try{
   const schema=`unstarted_${randomUUID().replaceAll('-','')}`;
   await c.query(`create schema ${schema};set local search_path to ${schema},public;
    create table projects(id uuid primary key,root_uri text);
    create table workflow_runs(id uuid primary key,project_id uuid,run_set_id uuid,task text,evaluation_metadata jsonb,status text,policy_snapshot jsonb);
    create table workflow_tasks(id uuid primary key,run_id uuid,status text);
    create table action_approvals(id uuid primary key,run_id uuid,status text);
    create table action_receipts(id uuid primary key default gen_random_uuid(),run_id uuid,agent_id text,action_type text,target text,summary text,metadata jsonb,prev_hash text,receipt_hash text,metadata_serialization_version int,created_at timestamptz default clock_timestamp());
    create table artifacts(id uuid primary key default gen_random_uuid(),run_id uuid,kind text,uri text,content jsonb,created_at timestamptz default clock_timestamp());
    create table work_intents(project_id text,owner text,fencing_token bigint,file_scopes jsonb,expires_at timestamptz);
    create table project_identity_locations(project_id uuid,identity_id uuid,kind text);`);
   await c.query(queueCoordinatorSchemaSql);await c.query(repairedRevisionSchemaSql);await c.query(legacyRecoverySchemaSql);
   const project=randomUUID(),source=randomUUID(),set=randomUUID(),id=randomUUID(),authorizationId=randomUUID(),owner='retained-original-owner',task='Preserve complete original requirements',sourcePaths=['source.ts'];
   const familyId=`${project}:${set}`;
   await c.query('insert into projects values($1,$2)',[project,root]);await c.query("insert into project_identity_locations values($1,$1,'canonical')",[project]);
   await c.query("insert into workflow_runs values($1,$2,$3,$4,'{}','blocked','{}')",[source,project,set,task]);
   await c.query("insert into work_intents values($1,$2,9,$3,clock_timestamp()+interval '10 minutes')",[project,owner,JSON.stringify(sourcePaths)]);
   const authority={authorizationId,sourceRunId:source,projectId:project,familyId,taskHash:acceptanceDigest(task),sourcePaths,provider:'codex-cli',modelTier:'standard',offlineOnly:true,approvalDecision:'approved',approvalSource:'direct-human'};
   await appendActionReceipt(c,{runId:source,agentId:'operator',actionType:'operator_legacy_recovery_authorized',target:authorizationId,summary:'Synthetic scoped human authorization',metadata:JSON.stringify(authority)});
   const enrollment=await enrollLegacyRecoveryOnClient(c,{sourceRunId:source,projectId:project,familyId,taskHash:acceptanceDigest(task),sourcePaths,owner,intentFence:'9',authorizationId});
   const before=JSON.stringify((await c.query('select * from workflow_runs where id=$1',[source])).rows);
   const inserted=await c.query("insert into queue_coordinator_assignments(id,family_id,project_id,source_run_id,role,lane,owner,fingerprint,intent_fence,file_scopes,state,reason,legacy_enrollment_id) values($1,$2,$3,$4,'repair',1,$5,'failure','9',$6,'uncertain','Pre-effect SQL type error',$7) returning fence::text",[id,familyId,project,source,owner,JSON.stringify(sourcePaths),enrollment.id]);
   async function denied(sql:string,args:unknown[],rejects=false){
    await c.query('savepoint negative');try{await c.query(sql,args);
     if(rejects)await assert.rejects(reconcileUnstartedCoordinatorReservationOnClient(c,id));
     else assert.equal(await reconcileUnstartedCoordinatorReservationOnClient(c,id),null);
    }finally{await c.query('rollback to savepoint negative');}
   }
   await denied("update queue_coordinator_assignments set state='held' where id=$1",[id]);
   await denied("update work_intents set expires_at=clock_timestamp()-interval '1 second'",[]);
   await denied("update work_intents set fencing_token=10",[]);
   await denied("update work_intents set file_scopes='[\"other.ts\"]'",[]);
   await denied("insert into workflow_runs values($1,$2,$3,'Orphan child',$4,'blocked','{}')",[randomUUID(),project,randomUUID(),JSON.stringify({queueCoordinatorClaimId:id})]);
   await denied("insert into action_approvals values($1,$2,'pending')",[randomUUID(),source]);
   await denied("update workflow_runs set status='running' where id=$1",[source]);
   await denied("insert into repaired_revision_records values($1,'baseline',$2,$3,'{}','synthetic',clock_timestamp())",[randomUUID(),source,id]);
   await denied("insert into artifacts(run_id,kind,content) values($1,'repair_dispatch_claim','{}')",[source]);
   await denied("update action_receipts set metadata=jsonb_set(metadata,'{offlineOnly}','false') where action_type='operator_legacy_recovery_authorized'",[],true);
   await fs.writeFile(path.join(root,'source.ts'),'changed outside enrollment');assert.equal(await reconcileUnstartedCoordinatorReservationOnClient(c,id),null);await fs.writeFile(path.join(root,'source.ts'),'unchanged enrolled source');
   const reconciled=await reconcileUnstartedCoordinatorReservationOnClient(c,id);
   assert.ok(reconciled);assert.equal(reconciled.id,id);assert.equal(reconciled.owner,owner);assert.equal(reconciled.intentFence,'9');
   assert.ok(BigInt(reconciled.fence)>BigInt(inserted.rows[0].fence));assert.equal(reconciled.legacyEnrollmentId,enrollment.id);
   const updated=(await c.query('select state,child_run_id from queue_coordinator_assignments where id=$1',[id])).rows[0];
   assert.equal(updated.state,'reserved');assert.equal(updated.child_run_id,null);
   assert.equal((await c.query("select count(*)::int n from action_receipts where action_type='operator_no_effect_reservation_reconciled' and metadata->>'id'=$1",[id])).rows[0].n,1);
   assert.equal(await reconcileUnstartedCoordinatorReservationOnClient(c,id),null);
   await c.query("update queue_coordinator_assignments set state='uncertain' where id=$1",[id]);
   assert.equal(await reconcileUnstartedCoordinatorReservationOnClient(c,id),null,'Cannot reset another uncertainty on the same claim');
   assert.equal(JSON.stringify((await c.query('select * from workflow_runs where id=$1',[source])).rows),before);
  }finally{await c.query('rollback');}});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('corrected verifier reconciliation preserves terminal predecessor and only rearms its assignment once',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'held-verifier-')));
 try{await fs.writeFile(path.join(root,'source.ts'),'synthetic verified candidate');
  await withClient(async c=>{await c.query('begin');try{
   const schema=`held_verifier_${randomUUID().replaceAll('-','')}`;
   await c.query(`create schema ${schema};set local search_path to ${schema},public;
    create table projects(id uuid primary key,root_uri text);
    create table workflow_runs(id uuid primary key,project_id uuid,run_set_id uuid,task text,evaluation_metadata jsonb,status text,policy_snapshot jsonb,provider_override text,model_tier_override text);
    create table workflow_tasks(id uuid primary key,run_id uuid,status text,output_uri text,attempts int,executor_snapshot jsonb);
    create table action_approvals(id uuid primary key,run_id uuid,status text);
    create table action_receipts(id uuid primary key default gen_random_uuid(),run_id uuid,agent_id text,action_type text,target text,summary text,metadata jsonb,prev_hash text,receipt_hash text,metadata_serialization_version int,created_at timestamptz default clock_timestamp());
    create table artifacts(id uuid primary key default gen_random_uuid(),run_id uuid,kind text,uri text,content jsonb,created_at timestamptz default clock_timestamp());
    create table work_intents(project_id text,owner text,fencing_token bigint,file_scopes jsonb,expires_at timestamptz);
    create table project_identity_locations(project_id uuid,identity_id uuid,kind text);`);
   await c.query(queueCoordinatorSchemaSql);await c.query(repairedRevisionSchemaSql);
   const project=randomUUID(),source=randomUUID(),set=randomUUID(),repair=randomUUID(),oldVerifier=randomUUID(),repairClaim=randomUUID(),assignmentId=randomUUID(),candidateId=randomUUID();
   const familyId=`${project}:${set}`,sourcePaths=['source.ts'],owner='explicit-corrected-verifier',task='All unchanged original requirements';
   const manifest=await captureRepairRevisionManifest(root,sourcePaths),subjectHash=repairRevisionManifestHash(manifest);
   const contract={version:1,contractId:'original-frozen',originRunId:source,projectId:project,taskHash:acceptanceDigest(task),subjectHash:'original-pre-repair-hash',sourcePaths,deliverables:[{id:'all-original',description:task,requiredGates:['implementation','verification','packaging','supervision'],advisory:false,severity:'block'}]};
   const contractDigest=acceptanceDigest(contract);
   await c.query('insert into projects values($1,$2)',[project,root]);await c.query("insert into project_identity_locations values($1,$1,'canonical')",[project]);
   await c.query("insert into workflow_runs values($1,$2,$3,$4,$5,'blocked','{}','codex-cli','standard')",[source,project,set,task,JSON.stringify({acceptanceContract:contract})]);
   await c.query("insert into workflow_runs values($1,$2,$3,'Repair',$4,'completed','{}','codex-cli','standard')",[repair,project,randomUUID(),JSON.stringify({sourceRunId:source,queueCoordinatorClaimId:repairClaim,originalAcceptanceDigest:contractDigest})]);
   await c.query("insert into workflow_runs values($1,$2,$3,'Independent verification','{}','blocked',$4,'codex-cli','standard')",[oldVerifier,project,randomUUID(),JSON.stringify({actions:{allowed_write_paths:[]}})]);
   await c.query("insert into queue_coordinator_assignments(id,family_id,project_id,source_run_id,role,lane,owner,fingerprint,intent_fence,file_scopes,state,child_run_id) values($1,$2,$3,$4,'repair',1,'prior-repair','repair','1',$5,'held',$6)",[repairClaim,familyId,project,source,JSON.stringify(sourcePaths),repair]);
   const q=await c.query("insert into queue_coordinator_assignments(id,family_id,project_id,source_run_id,role,lane,owner,fingerprint,intent_fence,file_scopes,state,child_run_id) values($1,$2,$3,$4,'verifier',1,'prior-verifier','verify','2',$5,'held',$6) returning fence::text",[assignmentId,familyId,project,source,JSON.stringify(sourcePaths),oldVerifier]);
   const oldFence=q.rows[0].fence;
   const verifierContract={...contract,contractId:'old-verifier-contract',originRunId:oldVerifier,taskHash:acceptanceDigest('Independent verification'),subjectHash};
   const oldMetadata={sourceRunId:source,queueCoordinatorClaimId:assignmentId,queueCoordinatorFence:oldFence,originalAcceptanceDigest:contractDigest,repairedRevisionCandidateId:candidateId,repairedRevisionSourceRunId:source,acceptanceContract:verifierContract};
   await c.query('update workflow_runs set evaluation_metadata=$2 where id=$1',[oldVerifier,JSON.stringify(oldMetadata)]);
   const oldTask=randomUUID();await c.query("insert into workflow_tasks values($1,$2,'blocked','db://synthetic/prior-output',3,$3)",[oldTask,oldVerifier,JSON.stringify({pendingOutput:{summary:'Preserve original blocked diagnosis'}})]);
   const candidate={id:candidateId,sourceRunId:source,projectId:project,projectRootUri:root,repairRunId:repair,repairClaimId:repairClaim,repairOwner:'prior-repair',originalContractDigest:contractDigest,requirementsDigest:repairRevisionRequirementsDigest(contract),sourceHash:contract.subjectHash,repairedHash:subjectHash,sourcePaths,baselineId:randomUUID(),manifest};
   await c.query("insert into repaired_revision_records values($1,'candidate',$2,$3,$4,$5,clock_timestamp())",[candidateId,source,repairClaim,JSON.stringify(candidate),acceptanceDigest(candidate)]);
   await c.query("insert into work_intents values($1,$2,11,$3,clock_timestamp()+interval '10 minutes')",[project,owner,JSON.stringify(sourcePaths)]);
   for(const runId of [source,repair,oldVerifier])await appendActionReceipt(c,{runId,agentId:'operator',actionType:'synthetic_preserved_evidence',target:runId,summary:'Synthetic original audited evidence',metadata:'{}'});
   const evidence={assignmentId,candidateId,sourceRunId:source,priorVerifierRunId:oldVerifier,originalContractDigest:contractDigest,subjectHash,reason:'Correct stale historical prerequisite interpretation without changing original requirements',actor:'operator',authority:'direct-human',offlineOnly:true};
   const correctionArtifactUri=`db://workflow_runs/${oldVerifier}/operator_verifier_context_correction/exact`;
   await appendActionReceipt(c,{runId:oldVerifier,agentId:'workflow-orchestrator',actionType:'operator_verifier_context_correction',target:oldVerifier,summary:evidence.reason,metadata:JSON.stringify(evidence)});
   await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'operator_verifier_context_correction',$2,$3)",[oldVerifier,correctionArtifactUri,JSON.stringify(evidence)]);
   const input={assignmentId,owner,intentFence:'11',correctionArtifactUri};
   const frozenRun=JSON.stringify((await c.query('select * from workflow_runs where id=any($1)',[[source,oldVerifier]])).rows),frozenTasks=JSON.stringify((await c.query('select * from workflow_tasks')).rows);
   async function denied(sql:string,args:unknown[]){await c.query('savepoint negative');try{await c.query(sql,args);assert.equal(await reconcileBlockedVerifierOnClient(c,input),null);}finally{await c.query('rollback to savepoint negative');}}
   await denied("update work_intents set expires_at=clock_timestamp()-interval '1 second'",[]);
   await denied("update work_intents set file_scopes='[\"other.ts\"]'",[]);
   await denied("update workflow_runs set provider_override='other' where id=$1",[oldVerifier]);
   await denied("update workflow_runs set status='running' where id=$1",[oldVerifier]);
   await denied("insert into action_approvals values($1,$2,'pending')",[randomUUID(),repair]);
   await denied("insert into artifacts(run_id,kind,content) values($1,'file_write','{}')",[oldVerifier]);
   await denied("update artifacts set content=jsonb_set(content,'{candidateId}',to_jsonb($2::text)) where uri=$1",[correctionArtifactUri,randomUUID()]);
   await denied("update action_receipts set metadata='{}' where action_type='operator_verifier_context_correction'",[]);
   await fs.writeFile(path.join(root,'source.ts'),'changed candidate');assert.equal(await reconcileBlockedVerifierOnClient(c,input),null);await fs.writeFile(path.join(root,'source.ts'),'synthetic verified candidate');
   const result=await reconcileBlockedVerifierOnClient(c,input);assert.ok(result);
   assert.equal(result.id,assignmentId);assert.equal(result.owner,owner);assert.equal(result.intentFence,'11');assert.equal(result.revisionCandidateId,candidateId);assert.ok(BigInt(result.fence)>BigInt(oldFence));
   const after=(await c.query('select state,child_run_id from queue_coordinator_assignments where id=$1',[assignmentId])).rows[0];assert.equal(after.state,'reserved');assert.equal(after.child_run_id,null);
   assert.equal(JSON.stringify((await c.query('select * from workflow_runs where id=any($1)',[[source,oldVerifier]])).rows),frozenRun);
   assert.equal(JSON.stringify((await c.query('select * from workflow_tasks')).rows),frozenTasks);
   assert.equal((await c.query("select count(*)::int n from action_receipts where action_type='operator_verifier_assignment_reconciled'",[])).rows[0].n,1);
   assert.equal(await reconcileBlockedVerifierOnClient(c,input),null);
   await c.query('savepoint repeated_reconciliation');
   await c.query("update queue_coordinator_assignments set state='held',child_run_id=$2,fence=$3::bigint where id=$1",[assignmentId,oldVerifier,oldFence]);
   assert.equal(await reconcileBlockedVerifierOnClient(c,input),null,'Durable audit prevents repeating reconciliation even if prior held shape is restored');
   await c.query('rollback to savepoint repeated_reconciliation');
   assert.equal((await c.query('select count(*)::int n from workflow_runs')).rows[0].n,3,'No new workflow is created by reconciliation');
  }finally{await c.query('rollback');}});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("coordinator preserves approvals and holds healthy family activity",async()=>fixture(async(c,make)=>{
 const r=await make("held");
 await c.query("insert into action_approvals values($1,$2,'pending')",[randomUUID(),r.sourceRunId]);
 const before=JSON.stringify((await c.query("select * from action_approvals")).rows);
 assert.equal(await reserve(c,r),null);
 assert.equal(JSON.stringify((await c.query("select * from action_approvals")).rows),before);
 await c.query("update action_approvals set status='approved'");
 await c.query("update workflow_runs set status='running' where id=$1",[r.sourceRunId]);
 assert.equal(await reserve(c,r),null);
 await c.query("update workflow_runs set status='blocked' where id=$1",[r.sourceRunId]);
 await c.query("insert into workflow_tasks values($1,$2,'leased')",[randomUUID(),r.sourceRunId]);
 assert.equal(await reserve(c,r),null);
 await c.query("update workflow_tasks set status='blocked'");
 assert.ok(await reserve(c,r));
 assert.equal((await c.query("select status from workflow_runs where id=$1",[r.sourceRunId])).rows[0].status,"blocked");
}));

test("known older database constraint upgrades idempotently without changing history",async()=>fixture(async(c,make)=>{
 const claim=await reserve(c,await make('preserved'));assert.ok(claim);
 const before=(await c.query('select * from queue_coordinator_assignments order by id')).rows;
 await c.query("alter table queue_coordinator_assignments drop constraint queue_coordinator_assignments_check; alter table queue_coordinator_assignments add constraint queue_coordinator_assignments_check check((role='repair' and lane between 1 and 3) or (role='verifier' and lane=1))");
 await c.query(queueCoordinatorSchemaSql);await c.query(queueCoordinatorSchemaSql);
 assert.deepEqual((await c.query('select * from queue_coordinator_assignments order by id')).rows,before);
 await assert.rejects(reserve(c,{...await make('lane7'),lane:7}),/lane/);
}));

test("coordinator atomically enforces five total items with one independent verifier",async()=>fixture(async(c,make)=>{
 for(let lane=1;lane<=5;lane++) assert.ok(await reserve(c,{...await make(`repair${lane}`),lane}));
 const eighth=await make("eighth");
 assert.equal(await reserve(c,eighth),null);
 await assert.rejects(reserve(c,{...eighth,lane:6}),/lane/);
 assert.equal(await reserve(c,{...await make("verify-full"),role:"verifier"}),null,'A verifier is not a sixth item');
 await c.query("update queue_coordinator_assignments set state='held' where role='repair' and lane=5");
 assert.ok(await reserve(c,{...await make("verify"),role:"verifier"}));
 assert.equal(await reserve(c,{...await make("verify2"),role:"verifier"}),null);
 assert.equal(await reserve(c,{...await make('repair-full'),lane:5}),null,'Four repairs plus one verifier consume the same total ceiling');
 assert.equal((await c.query("select count(*)::int n from queue_coordinator_assignments")).rows[0].n,6);
}));

test("coordinator suppresses unchanged families, overlapping scopes and uncertain takeover",async()=>fixture(async(c,make)=>{
 const r=await make("original","src/component");
 const claim=await reserve(c,r);assert.ok(claim);
 assert.equal(await reserve(c,{...r,role:"verifier"}),null,"One role per active family");
 const overlap=await make("overlap","src/component/child.ts");
 assert.equal(await reserve(c,{...overlap,lane:2}),null,"Disjoint families cannot write overlapping source");
 await c.query("update queue_coordinator_assignments set state='uncertain' where id=$1",[claim.id]);
 await c.query("update work_intents set expires_at=now()-interval '1 second' where owner=$1",[r.owner]);
 assert.equal(await reserve(c,{...overlap,lane:2}),null,"Expired writer intent does not prove no side effect");
 await c.query("update queue_coordinator_assignments set state='failed' where id=$1",[claim.id]);
 await c.query("update work_intents set expires_at=now()+interval '1 minute' where owner=$1",[r.owner]);
 assert.equal(await reserve(c,r),null,"Failure cannot rearm identical fingerprint");
 assert.ok(await reserve(c,{...overlap,lane:2}));
}));

test("changed diagnoses cannot reset the three-attempt family budget",async()=>fixture(async(c,make)=>{
 const r=await make("budget");
 for(let attempt=1;attempt<=4;attempt++){
  const failure=`distinct failure ${attempt}`;
  await c.query("insert into action_receipts(id,run_id,action_type,metadata,summary,created_at) values($1,$2,'stage_blocked',$3,$4,now()+($5::int*interval '1 second'))",[randomUUID(),r.sourceRunId,JSON.stringify({reason:failure}),failure,attempt]);
  const claim=await reserve(c,{...r,fingerprint:repairFingerprint("Repair budget",failure)});
  if(attempt<=3){assert.ok(claim);await c.query("update queue_coordinator_assignments set state='held' where id=$1",[claim.id]);}
  else assert.equal(claim,null);
 }
 assert.equal((await c.query("select count(*)::int n from queue_coordinator_assignments")).rows[0].n,3);
}));

test("verifier reservation binds its exact immutable candidate and original requirement digest",async()=>fixture(async(c,make)=>{
 const r=await make("revision");const repair=await reserve(c,r);assert.ok(repair);
 await c.query("update queue_coordinator_assignments set state='held' where id=$1",[repair.id]);
 await c.query(repairedRevisionSchemaSql);
 const contract=(await c.query("select evaluation_metadata->'acceptanceContract' contract from workflow_runs where id=$1",[r.sourceRunId])).rows[0].contract;
 const id=randomUUID(),payload={id,sourceRunId:r.sourceRunId,projectId:r.projectId,sourcePaths:r.fileScopes,originalContractDigest:acceptanceDigest(contract)};
 await c.query("insert into repaired_revision_records(id,kind,source_run_id,claim_id,payload,digest) values($1,'candidate',$2,$3,$4,$5)",[id,r.sourceRunId,repair.id,JSON.stringify(payload),acceptanceDigest(payload)]);
 const verifier={...r,role:'verifier' as const,revisionCandidateId:id,fingerprint:acceptanceDigest({failure:r.fingerprint,revisionCandidateId:id})};
 assert.equal(await reserve(c,{...verifier,revisionCandidateId:randomUUID()}),null);
 assert.equal(await reserve(c,{...verifier,fingerprint:r.fingerprint}),null);
 assert.ok(await reserve(c,verifier));
}));

test("explicit cross-set descendants retain approval and activity holds",async()=>fixture(async(c,make)=>{
 const r=await make("lineage"),child=await make("linked");
 await c.query("update workflow_runs set evaluation_metadata=jsonb_set(evaluation_metadata,'{sourceRunId}',to_jsonb($2::text)),status='running' where id=$1",[child.sourceRunId,r.sourceRunId]);
 assert.equal(await reserve(c,r),null);
 await c.query("update workflow_runs set status='blocked' where id=$1",[child.sourceRunId]);
 await c.query("insert into action_approvals values($1,$2,'pending')",[randomUUID(),child.sourceRunId]);
 assert.equal(await reserve(c,r),null);
 await c.query("update action_approvals set status='approved'");
 assert.ok(await reserve(c,r));
}));
