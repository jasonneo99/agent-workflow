import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {withClient} from './client.js';
import {acceptanceDigest,acceptancePreflight} from './acceptance.js';
import {appendActionReceipt} from './receipt-writer.js';
import {coordinatorAllowsRepair} from './repair-dispatch.js';
import {queueCoordinatorSchemaSql,type CoordinatorClaim} from './queue-coordinator.js';
import {legacyRecoverySchemaSql,enrollLegacyRecoveryOnClient} from './legacy-recovery.js';
import {repairedRevisionSchemaSql,captureRepairRevisionBaselineOnClient,recordRepairRevisionCandidateOnClient,
 attestRepairedRevisionOnClient,verifyRepairedRevisionAttestationOnClient,repairRevisionManifestHash,
 captureRepairRevisionManifest,type RepairRevisionHooks} from './repaired-revision.js';

test('legacy unchanged current baseline requires exact authorization and independent actual four-gate acceptance',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'legacy-current-proof-')));
 try{
  await fs.mkdir(path.join(root,'src'));await fs.writeFile(path.join(root,'src/feature.ts'),'already repaired synthetic source');
  await withClient(async c=>{await c.query('begin');try{
   const schema=`legacy_revision_${randomUUID().replaceAll('-','')}`;
   await c.query(`create schema ${schema};set local search_path to ${schema},public;
    create table projects(id uuid primary key,root_uri text);
    create table workflow_runs(id uuid primary key,project_id uuid,task text,status text,evaluation_metadata jsonb,policy_snapshot jsonb,started_at timestamptz,run_set_id uuid,provider_override text,model_tier_override text);
    create table workflow_tasks(id uuid primary key,run_id uuid,status text,stage_id text);
    create table action_approvals(id uuid primary key,run_id uuid,status text);
    create table action_receipts(id uuid primary key default gen_random_uuid(),run_id uuid,agent_id text,action_type text,target text,summary text,metadata jsonb,prev_hash text,receipt_hash text,metadata_serialization_version int,created_at timestamptz default clock_timestamp());
    create table artifacts(id uuid primary key default gen_random_uuid(),run_id uuid,kind text,content jsonb,created_at timestamptz default clock_timestamp(),task_id uuid,uri text);
    create table work_intents(project_id text,owner text,fencing_token bigint,file_scopes jsonb,expires_at timestamptz);
    create table project_identity_locations(project_id uuid,identity_id uuid,kind text);`);
   await c.query(queueCoordinatorSchemaSql);await c.query(repairedRevisionSchemaSql);await c.query(legacyRecoverySchemaSql);
   const project=randomUUID(),source=randomUUID(),set=randomUUID(),repair=randomUUID(),verify=randomUUID(),authorizationId=randomUUID();
   const sourcePaths=['src/feature.ts'],task='Full original source repair requirements.\nPreserve every original behavior and prove every gate.';
   const familyId=`${project}:${set}`,policy={actions:{allowed_write_paths:sourcePaths}};
   await c.query('insert into projects values($1,$2)',[project,root]);
   await c.query("insert into project_identity_locations values($1,$1,'canonical')",[project]);
   await c.query("insert into workflow_runs values($1,$2,$3,'blocked','{}',$4,clock_timestamp(),$5,null,null)",[source,project,task,JSON.stringify(policy),set]);
   await c.query("insert into work_intents values($1,'enrollment-owner',7,$2,now()+interval '10 minutes')",[project,JSON.stringify(sourcePaths)]);
   const authority={authorizationId,sourceRunId:source,projectId:project,familyId,taskHash:acceptanceDigest(task),sourcePaths,provider:'codex-cli',modelTier:'standard',offlineOnly:true,approvalDecision:'approved',approvalSource:'direct-human'};
   await appendActionReceipt(c,{runId:source,agentId:'operator',actionType:'operator_legacy_recovery_authorized',target:authorizationId,summary:'Synthetic exact human decision',metadata:JSON.stringify(authority)});
   const original=JSON.stringify((await c.query('select * from workflow_runs where id=$1',[source])).rows);
   const enrollment=await enrollLegacyRecoveryOnClient(c,{sourceRunId:source,projectId:project,familyId,taskHash:acceptanceDigest(task),sourcePaths,owner:'enrollment-owner',intentFence:'7',authorizationId});
   assert.equal(enrollment.contract.deliverables[0].description,task);assert.equal(enrollment.mode,'legacy-current-baseline');
   assert.equal(JSON.stringify((await c.query('select * from workflow_runs where id=$1',[source])).rows),original);
   const hooks:RepairRevisionHooks={manifest:captureRepairRevisionManifest,chain:async()=>true,audit:async()=>{},preflight:acceptancePreflight};
   async function claim(role:'repair'|'verifier',child:string):Promise<CoordinatorClaim>{
    const id=randomUUID(),owner=`synthetic:${role}`;
    await c.query("insert into workflow_runs values($1,$2,$3,'completed','{}',$4,clock_timestamp()+interval '1 second',$5,'codex-cli','standard')",[child,project,`${role} unchanged original requirements`,JSON.stringify({actions:{allowed_write_paths:role==='verifier'?[]:sourcePaths}}),randomUUID()]);
    await c.query("insert into work_intents values($1,$2,9,$3,now()+interval '10 minutes')",[project,owner,JSON.stringify(sourcePaths)]);
    const q=await c.query("insert into queue_coordinator_assignments(id,family_id,project_id,source_run_id,role,lane,owner,fingerprint,intent_fence,file_scopes,state,child_run_id,legacy_enrollment_id) values($1,$2,$3,$4,$5,1,$6,$5,'9',$7,'running',$8,$9) returning fence::text",[id,familyId,project,source,role,owner,JSON.stringify(sourcePaths),child,enrollment.id]);
    const result:CoordinatorClaim={id,fence:q.rows[0].fence,familyId,sourceRunId:source,projectId:project,projectRootUri:root,role,lane:1,owner,fingerprint:role,intentFence:'9',fileScopes:sourcePaths,legacyEnrollmentId:enrollment.id};
    await c.query('update workflow_runs set evaluation_metadata=$2 where id=$1',[child,JSON.stringify({sourceRunId:source,queueCoordinatorClaimId:id,queueCoordinatorFence:result.fence,legacyEnrollmentId:enrollment.id,originalAcceptanceDigest:acceptanceDigest(enrollment.contract)})]);return result;
   }
   const repairClaim=await claim('repair',repair);
   // Production reliability storage uses text IDs while workflow ownership is
   // UUID-typed. Both must compare exact identities without an SQL type error.
   assert.equal(await coordinatorAllowsRepair(c,{runId:source,projectId:project,runSetId:set,coordinatorClaim:repairClaim}),true);
   assert.equal(await coordinatorAllowsRepair(c,{runId:source,projectId:project,runSetId:set,coordinatorClaim:{...repairClaim,fence:'0'}}),false);
   await assert.rejects(captureRepairRevisionBaselineOnClient(c,{...repairClaim,legacyEnrollmentId:randomUUID()},hooks),/claim|enrollment/);
   await captureRepairRevisionBaselineOnClient(c,repairClaim,hooks);
   await c.query('savepoint wrong_route');await c.query("update workflow_runs set provider_override='other' where id=$1",[repair]);
   await assert.rejects(recordRepairRevisionCandidateOnClient(c,repairClaim,hooks),/provider/);await c.query('rollback to savepoint wrong_route');
   await assert.rejects(recordRepairRevisionCandidateOnClient(c,{...repairClaim,fileScopes:['other.ts']},hooks),/claim|scope/);
   const candidate=await recordRepairRevisionCandidateOnClient(c,repairClaim,hooks);
   assert.equal(candidate.repairedHash,enrollment.subjectHash);assert.equal(candidate.sourceHash,candidate.repairedHash);
   assert.equal(candidate.legacyEnrollmentId,enrollment.id);
   assert.equal((await c.query("select count(*)::int n from artifacts where run_id=$1 and kind='file_write'",[repair])).rows[0].n,0);
   await c.query("update queue_coordinator_assignments set state='held' where id=$1",[repairClaim.id]);
   const verifierClaim=await claim('verifier',verify),verificationTask='verifier unchanged original requirements';
   const verifierContract={...enrollment.contract,contractId:`verification:${verify}`,originRunId:verify,taskHash:acceptanceDigest(verificationTask),subjectHash:candidate.repairedHash};
   await c.query("update workflow_runs set evaluation_metadata=evaluation_metadata||$2::jsonb where id=$1",[verify,JSON.stringify({acceptanceContract:verifierContract,repairedRevisionCandidateId:candidate.id,repairedRevisionSourceRunId:source})]);
   const taskId=randomUUID(),uri=`db://workflow_runs/${verify}/verification/executed`;
   await c.query("insert into workflow_tasks values($1,$2,'completed','verification')",[taskId,verify]);
   const command={commandLine:'npm run test',exitCode:0,timedOut:false,subjectHash:candidate.repairedHash,sourcePaths,sourceBefore:candidate.repairedHash,sourceAfter:candidate.repairedHash};
   const written=await c.query("insert into artifacts(run_id,task_id,kind,uri,content) values($1,$2,'command_output',$3,$4) returning created_at",[verify,taskId,uri,JSON.stringify(command)]);
   const ref={artifactUri:uri,kind:'command_output',runId:verify,taskId,stageId:'verification',contentHash:acceptanceDigest(command),observedAt:written.rows[0].created_at.toISOString(),subjectHash:candidate.repairedHash};
   const receipts=Object.fromEntries(['implementation','verification','packaging','supervision'].map(g=>[g,[ref]]));
   const output={acceptanceContract:{...verifierContract,deliverables:verifierContract.deliverables.map(d=>({...d,status:'verified',receipts}))}};
   await c.query("insert into artifacts(run_id,kind,content) values($1,'stage_output',$2)",[verify,JSON.stringify(output)]);
   assert.equal((await acceptancePreflight(c,verify,output)).accepted,true);
   await c.query('savepoint bad_gate');await c.query("update artifacts set content=jsonb_set(content,'{exitCode}','1') where uri=$1",[uri]);
   await assert.rejects(attestRepairedRevisionOnClient(c,verifierClaim,candidate.id,verify,hooks),/acceptance/);await c.query('rollback to savepoint bad_gate');
   await fs.writeFile(path.join(root,sourcePaths[0]),'unreceipted changed source');
   await assert.rejects(attestRepairedRevisionOnClient(c,verifierClaim,candidate.id,verify,hooks),/source/);
   await fs.writeFile(path.join(root,sourcePaths[0]),'already repaired synthetic source');
   await c.query('savepoint bad_authority');await c.query("update action_receipts set metadata=jsonb_set(metadata,'{offlineOnly}','false') where action_type='operator_legacy_recovery_authorized'");
   await assert.rejects(attestRepairedRevisionOnClient(c,verifierClaim,candidate.id,verify,hooks),/authorization|receipt|chain/);await c.query('rollback to savepoint bad_authority');
   const attestation=await attestRepairedRevisionOnClient(c,verifierClaim,candidate.id,verify,hooks);
   assert.equal(attestation.legacyEnrollmentId,enrollment.id);assert.equal(attestation.originalWorkflowUnchanged,true);
   assert.equal(await verifyRepairedRevisionAttestationOnClient(c,source,candidate.repairedHash,hooks),true);
   assert.equal(await verifyRepairedRevisionAttestationOnClient(c,source,'wrong-current-hash',hooks),false);
   assert.equal(repairRevisionManifestHash(await captureRepairRevisionManifest(root,sourcePaths)),candidate.repairedHash);
   assert.equal(JSON.stringify((await c.query('select * from workflow_runs where id=$1',[source])).rows),original);
   await c.query('savepoint immutable');await assert.rejects(c.query("update legacy_recovery_enrollments set digest='forged' where id=$1",[enrollment.id]),/immutable/);await c.query('rollback to savepoint immutable');
  }finally{await c.query('rollback');}});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
