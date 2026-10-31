import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withClient} from './client.js';
import {acceptanceDigest} from './acceptance.js';
import {queueCoordinatorSchemaSql} from './queue-coordinator.js';
import {repairRevisionManifestHash,repairRevisionRequirementsDigest,repairedRevisionSchemaSql} from './repaired-revision.js';
import {reserveHistoryPreservingAssessmentOnClient} from './history-preserving-assessment.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {legacyRecoverySchemaSql,enrollLegacyRecoveryOnClient} from './legacy-recovery.js';
import {appendActionReceipt} from './receipt-writer.js';
import {verifyRunReceiptChainOnClient} from './postgres.js';
import {captureRepairRevisionManifest,recordRepairRevisionCandidateOnClient,verifyRepairedRevisionAttestationOnClient} from './repaired-revision.js';

test('explicit assessment preserves terminal history and approvals, fences once, and rejects stale or widened proof',async()=>withClient(async c=>{
 await c.query('begin');try{
  const schema='assessment_'+randomUUID().replaceAll('-','');
  await c.query(`create schema ${schema};set local search_path to ${schema},public;
   create table projects(id uuid primary key,root_uri text);
   create table workflow_runs(id uuid primary key,project_id uuid,run_set_id uuid,task text,evaluation_metadata jsonb,status text,policy_snapshot jsonb,provider_override text,model_tier_override text);
   create table workflow_tasks(id uuid primary key,run_id uuid,status text);
   create table action_approvals(id uuid primary key,run_id uuid,status text);
   create table action_receipts(id uuid primary key default gen_random_uuid(),run_id uuid,agent_id text,action_type text,target text,summary text,metadata jsonb,prev_hash text,receipt_hash text,metadata_serialization_version int,created_at timestamptz default clock_timestamp());
   create table artifacts(id uuid primary key default gen_random_uuid(),run_id uuid,kind text,uri text,content jsonb,created_at timestamptz default clock_timestamp());
   create table work_intents(project_id text,owner text,fencing_token bigint,file_scopes jsonb,expires_at timestamptz);
   create table project_identity_locations(project_id uuid,identity_id uuid,kind text);`);
  await c.query(queueCoordinatorSchemaSql);await c.query(repairedRevisionSchemaSql);
  const project=randomUUID(),set=randomUUID(),source=randomUUID(),repair=randomUUID(),prior=randomUUID(),repairClaim=randomUUID(),assignment=randomUUID(),candidateId=randomUUID();
  const root='/synthetic/project',paths=['source.ts'],owner='independent-assessor',family=`${project}:${set}`,task='Prove every original requirement';
  const manifest=[{path:'source.ts',mode:420,hash:'b'.repeat(64)}],hash=repairRevisionManifestHash(manifest);
  const contract={version:1,contractId:'original-contract',originRunId:source,projectId:project,taskHash:acceptanceDigest(task),subjectHash:'a'.repeat(64),sourcePaths:paths,deliverables:[{id:'original',description:task,requiredGates:['implementation','verification','packaging','supervision']}]};
  await c.query('insert into projects values($1,$2)',[project,root]);await c.query("insert into project_identity_locations values($1,$1,'canonical')",[project]);
  await c.query("insert into workflow_runs values($1,$2,$3,$4,$5,'blocked','{}','codex-cli','standard')",[source,project,set,task,JSON.stringify({acceptanceContract:contract})]);
  const repairMeta={sourceRunId:source,queueCoordinatorClaimId:repairClaim,originalAcceptanceDigest:acceptanceDigest(contract)};
  await c.query("insert into workflow_runs values($1,$2,$3,'Repair',$4,'completed','{}','codex-cli','standard')",[repair,project,randomUUID(),JSON.stringify(repairMeta)]);
  await c.query("insert into workflow_runs values($1,$2,$3,'Verifier','{}','blocked',$4,'codex-cli','standard')",[prior,project,randomUUID(),JSON.stringify({actions:{allowed_write_paths:[]}})]);
  await c.query("insert into queue_coordinator_assignments(id,family_id,project_id,source_run_id,role,lane,owner,fingerprint,intent_fence,file_scopes,state,child_run_id) values($1,$2,$3,$4,'repair',1,'repairer','old-repair','1',$5,'held',$6)",[repairClaim,family,project,source,JSON.stringify(paths),repair]);
  const q=(await c.query("insert into queue_coordinator_assignments(id,family_id,project_id,source_run_id,role,lane,owner,fingerprint,intent_fence,file_scopes,state,child_run_id) values($1,$2,$3,$4,'verifier',1,'prior-owner','old-verify','2',$5,'held',$6) returning fence::text",[assignment,family,project,source,JSON.stringify(paths),prior])).rows[0];
  const candidate={id:candidateId,sourceRunId:source,projectId:project,projectRootUri:root,repairRunId:repair,repairClaimId:repairClaim,repairOwner:'repairer',originalContractDigest:acceptanceDigest(contract),requirementsDigest:repairRevisionRequirementsDigest(contract),sourcePaths:paths,repairedHash:hash};
  await c.query("insert into repaired_revision_records values($1,'candidate',$2,$3,$4,$5,clock_timestamp())",[candidateId,source,repairClaim,JSON.stringify(candidate),acceptanceDigest(candidate)]);
  const meta={sourceRunId:source,queueCoordinatorClaimId:assignment,queueCoordinatorFence:q.fence,originalAcceptanceDigest:acceptanceDigest(contract),repairedRevisionCandidateId:candidateId,repairedRevisionSourceRunId:source,acceptanceContract:{...contract,contractId:'prior-verifier',originRunId:prior,taskHash:acceptanceDigest('Verifier'),subjectHash:hash}};
  await c.query('update workflow_runs set evaluation_metadata=$2 where id=$1',[prior,JSON.stringify(meta)]);
  await c.query("insert into work_intents values($1,$2,7,$3,clock_timestamp()+interval '15 minutes')",[project,owner,JSON.stringify(paths)]);
  // A previous once-only verifier reconciliation stays present and unchanged.
  await c.query("insert into action_receipts(run_id,action_type,metadata) values($1,'operator_verifier_assignment_reconciled',$2)",[source,JSON.stringify({id:assignment})]);
  const uri='db://synthetic/authorization';
  const auth={assignmentId:assignment,sourceRunId:source,priorRunId:prior,projectId:project,familyId:family,originalContractDigest:acceptanceDigest(contract),subjectHash:hash,sourcePaths:paths,provider:'codex-cli',modelTier:'standard',offlineOnly:true,actor:'operator',authority:'direct-human',approvalDecision:'approved',reason:'Explicitly assess after independently corrected claim fencing'};
  await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'operator_history_assessment_authorized',$2,$3)",[prior,uri,JSON.stringify(auth)]);
  await c.query("insert into action_receipts(run_id,agent_id,action_type,target,metadata) values($1::uuid,'operator','operator_history_assessment_authorized',$1::text,$2)",[prior,JSON.stringify(auth)]);
  const input={assignmentId:assignment,owner,intentFence:'7',authorizationArtifactUri:uri};
  const hooks={manifest:async()=>manifest,chain:async()=>true};
  async function denied(sql:string,values:unknown[]){await c.query('savepoint negative');await c.query(sql,values);assert.equal(await reserveHistoryPreservingAssessmentOnClient(c,input,hooks),null);await c.query('rollback to savepoint negative');}
  await denied("update work_intents set fencing_token=8",[]);
  await denied("update work_intents set expires_at=clock_timestamp()-interval '1 second'",[]);
  await denied("insert into action_approvals values($1,$2,'pending')",[randomUUID(),source]);
  await denied("insert into artifacts(run_id,kind,content) values($1,'file_write','{}')",[prior]);
  await denied("update artifacts set content=jsonb_set(content,'{subjectHash}',to_jsonb('wrong'::text)) where uri=$1",[uri]);
  await denied("update workflow_runs set provider_override='other' where id=$1",[prior]);
  assert.equal(await reserveHistoryPreservingAssessmentOnClient(c,input,{...hooks,chain:async()=>false}),null);
  assert.equal(await reserveHistoryPreservingAssessmentOnClient(c,input,{...hooks,manifest:async()=>[{...manifest[0],mode:493}]}),null);
  const before=(await c.query('select id,status,evaluation_metadata from workflow_runs order by id')).rows;
  const result=await reserveHistoryPreservingAssessmentOnClient(c,input,hooks);assert.ok(result);
  assert.equal(result.assessment.priorRunId,prior);assert.equal(result.role,'verifier');assert.ok(BigInt(result.fence)>BigInt(q.fence));
  assert.deepEqual((await c.query('select id,status,evaluation_metadata from workflow_runs order by id')).rows,before);
  assert.equal((await c.query("select count(*) from action_receipts where action_type='operator_verifier_assignment_reconciled'")).rows[0].count,'1');
  // Even a fresh held state / new owner cannot reset the assessment budget.
  await c.query("update queue_coordinator_assignments set state='held',child_run_id=$2 where id=$1",[assignment,prior]);
  assert.equal(await reserveHistoryPreservingAssessmentOnClient(c,input,hooks),null);
 }finally{await c.query('rollback');}
}));

test('sanitizer legacy baseline assessment requires actual immutable enrollment and preserves failed predecessor',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'assessment-legacy-')));
 try{await fs.writeFile(path.join(root,'source.ts'),'synthetic unchanged baseline');
 await fs.mkdir(path.join(root,'tests'));await fs.writeFile(path.join(root,'tests/test_source.py'),'# synthetic test inventory\n');
 await fs.mkdir(path.join(root,'.agent-workflow'));await fs.writeFile(path.join(root,'.agent-workflow/project.yaml'),'project:\n  name: Synthetic assessment\nactions:\n  allowed_commands:\n    - python3 -m unittest discover -s tests -p test_source.py -v\n    - git diff --check\n  command_timeout_ms: 300000\n');
 await withClient(async c=>{await c.query('begin');try{
  const schema='legacy_assessment_'+randomUUID().replaceAll('-','');
  await c.query(`create schema ${schema};set local search_path to ${schema},public;
   create table projects(id uuid primary key,root_uri text);
   create table workflow_runs(id uuid primary key,project_id uuid,run_set_id uuid,task text,evaluation_metadata jsonb,status text,policy_snapshot jsonb,provider_override text,model_tier_override text);
   create table workflow_tasks(id uuid primary key,run_id uuid,status text);
   create table action_approvals(id uuid primary key,run_id uuid,status text);
   create table action_receipts(id uuid primary key default gen_random_uuid(),run_id uuid,agent_id text,action_type text,target text,summary text,metadata jsonb,prev_hash text,receipt_hash text,metadata_serialization_version int,created_at timestamptz default clock_timestamp());
   create table artifacts(id uuid primary key default gen_random_uuid(),run_id uuid,kind text,uri text,content jsonb,created_at timestamptz default clock_timestamp());
   create table work_intents(project_id text,owner text,fencing_token bigint,file_scopes jsonb,expires_at timestamptz);
   create table project_identity_locations(project_id uuid,identity_id uuid,kind text);`);
  await c.query(queueCoordinatorSchemaSql);await c.query(repairedRevisionSchemaSql);await c.query(legacyRecoverySchemaSql);
  const project=randomUUID(),set=randomUUID(),source=randomUUID(),prior=randomUUID(),assignment=randomUUID(),authorizationId=randomUUID();
  const paths=['source.ts','tests/test_source.py'],owner='offline-baseline-assessor',family=`${project}:${set}`,task='Preserve sanitizer bytes, accounting and every original requirement';
  await c.query('insert into projects values($1,$2)',[project,root]);await c.query("insert into project_identity_locations values($1,$1,'canonical')",[project]);
  await c.query("insert into workflow_runs values($1,$2,$3,$4,'{}','blocked',$5,null,null)",[source,project,set,task,JSON.stringify({actions:{allowed_write_paths:paths}})]);
  await c.query("insert into work_intents values($1,$2,7,$3,clock_timestamp()+interval '15 minutes')",[project,owner,JSON.stringify(paths)]);
  const authorization={authorizationId,sourceRunId:source,projectId:project,familyId:family,taskHash:acceptanceDigest(task),sourcePaths:paths,provider:'codex-cli',modelTier:'standard',offlineOnly:true,approvalDecision:'approved',approvalSource:'direct-human'};
  await appendActionReceipt(c,{runId:source,agentId:'operator',actionType:'operator_legacy_recovery_authorized',target:source,summary:'Exact human-approved synthetic legacy recovery',metadata:JSON.stringify(authorization)});
  const enrollment=await enrollLegacyRecoveryOnClient(c,{sourceRunId:source,projectId:project,familyId:family,taskHash:acceptanceDigest(task),sourcePaths:paths,owner,intentFence:'7',authorizationId});
  await c.query("insert into workflow_runs values($1,$2,$3,'Blocked no-change recovery','{}','blocked',$4,'codex-cli','standard')",[prior,project,randomUUID(),JSON.stringify({actions:{allowed_write_paths:paths}})]);
  const q=(await c.query("insert into queue_coordinator_assignments(id,family_id,project_id,source_run_id,role,lane,owner,fingerprint,intent_fence,file_scopes,state,child_run_id,legacy_enrollment_id) values($1,$2,$3,$4,'repair',1,'historical-repairer','unchanged-failure','2',$5,'held',$6,$7) returning fence::text",[assignment,family,project,source,JSON.stringify(paths),prior,enrollment.id])).rows[0];
  const priorMetadata={sourceRunId:source,queueCoordinatorClaimId:assignment,queueCoordinatorFence:q.fence,originalAcceptanceDigest:acceptanceDigest(enrollment.contract),legacyEnrollmentId:enrollment.id};
  await c.query('update workflow_runs set evaluation_metadata=$2 where id=$1',[prior,JSON.stringify(priorMetadata)]);
  const manifest=await captureRepairRevisionManifest(root,paths),baseline={id:randomUUID(),sourceRunId:source,projectId:project,repairClaimId:assignment,repairOwner:'historical-repairer',originalContractDigest:acceptanceDigest(enrollment.contract),requirementsDigest:repairRevisionRequirementsDigest(enrollment.contract),sourceHash:enrollment.subjectHash,sourcePaths:paths,manifest,legacyEnrollmentId:enrollment.id};
  await c.query("insert into repaired_revision_records values($1,'baseline',$2,$3,$4,$5,clock_timestamp())",[baseline.id,source,assignment,JSON.stringify(baseline),acceptanceDigest(baseline)]);
  const uri='db://synthetic/legacy-assessment-authorization';
  const auth={assignmentId:assignment,sourceRunId:source,priorRunId:prior,projectId:project,familyId:family,originalContractDigest:acceptanceDigest(enrollment.contract),subjectHash:enrollment.subjectHash,sourcePaths:paths,provider:'codex-cli',modelTier:'standard',offlineOnly:true,actor:'operator',authority:'direct-human',approvalDecision:'approved',reason:'Assess unchanged baseline without resetting failed repair',offlineCommands:['python3 -m unittest discover -s tests -p test_source.py -v'],commandTimeoutMs:1000};
  await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'operator_history_assessment_authorized',$2,$3)",[prior,uri,JSON.stringify(auth)]);
  await appendActionReceipt(c,{runId:prior,agentId:'operator',actionType:'operator_history_assessment_authorized',target:prior,summary:'Explicit offline readonly assessment',metadata:JSON.stringify(auth)});
  const input={assignmentId:assignment,owner,intentFence:'7',authorizationArtifactUri:uri};
  async function denied(sql:string,values:unknown[]){await c.query('savepoint negative');await c.query(sql,values);assert.equal(await reserveHistoryPreservingAssessmentOnClient(c,input),null);await c.query('rollback to savepoint negative');}
  await denied("insert into artifacts(run_id,kind,content) values($1,'file_write','{}')",[prior]);
  await denied("insert into action_receipts(run_id,action_type) values($1,'file_write')",[prior]);
  await denied("update workflow_runs set provider_override='other' where id=$1",[prior]);
  for(const change of [{commandTimeoutMs:0},{commandTimeoutMs:120001},{commandTimeoutMs:'120000'},{offlineCommands:['python3 -m unittest discover -s tests -p test_other.py -v']}]){
   await c.query('savepoint invalid_bound');const invalid={...auth,...change};
   await c.query('update artifacts set content=$2 where uri=$1',[uri,JSON.stringify(invalid)]);
   await appendActionReceipt(c,{runId:prior,agentId:'operator',actionType:'operator_history_assessment_authorized',target:prior,summary:'Synthetic invalid bound must be rejected',metadata:JSON.stringify(invalid)});
   assert.equal(await reserveHistoryPreservingAssessmentOnClient(c,input),null);
   await c.query('rollback to savepoint invalid_bound');
  }
  await fs.writeFile(path.join(root,'source.ts'),'changed unreceipted content');assert.equal(await reserveHistoryPreservingAssessmentOnClient(c,input),null);await fs.writeFile(path.join(root,'source.ts'),'synthetic unchanged baseline');
  await fs.chmod(path.join(root,'source.ts'),0o755);assert.equal(await reserveHistoryPreservingAssessmentOnClient(c,input),null);await fs.chmod(path.join(root,'source.ts'),manifest[0].mode);
  const before=(await c.query('select * from workflow_runs order by id')).rows;
  const result=await reserveHistoryPreservingAssessmentOnClient(c,input);assert.ok(result);assert.equal(result.role,'repair');assert.equal(result.legacyEnrollmentId,enrollment.id);assert.equal(result.assessment.subjectHash,enrollment.subjectHash);
  assert.deepEqual(result.assessment.offlineCommands,auth.offlineCommands,'A blocked predecessor must honor the exact newly reviewed subset');
  assert.equal(result.assessment.commandTimeoutMs,1000,'A shorter reviewed timeout cannot inherit the broader project timeout');
  assert.deepEqual((await c.query('select * from workflow_runs order by id')).rows,before);
  assert.equal((await c.query('select payload from legacy_recovery_enrollments where source_run_id=$1',[source])).rows[0].payload.enrollmentId,enrollment.id);
  assert.equal((await c.query("select count(*) from repaired_revision_records where kind='candidate'")).rows[0].count,'0');
  const assessmentRun=randomUUID(),assessmentTask='Independently assess unchanged baseline without source writes';
  const assessmentMetadata={source:'queue-coordinator-assessment',provenanceKind:'authorized-current-baseline-assessment',historyAssessment:result.assessment,
   sourceRunId:source,queueCoordinatorClaimId:assignment,queueCoordinatorFence:result.fence,originalAcceptanceDigest:acceptanceDigest(enrollment.contract),legacyEnrollmentId:enrollment.id,
   acceptanceContract:{...enrollment.contract,contractId:'new-assessment-contract',originRunId:assessmentRun,taskHash:acceptanceDigest(assessmentTask)}};
  await c.query("insert into workflow_runs values($1,$2,$3,$4,$5,'completed',$6,'codex-cli','standard')",[assessmentRun,project,randomUUID(),assessmentTask,JSON.stringify(assessmentMetadata),JSON.stringify({actions:{allowed_write_paths:[]}})]);
  await appendActionReceipt(c,{runId:assessmentRun,agentId:'test-engineer',actionType:'synthetic_readonly_assessment',target:assessmentRun,summary:'Completed independent source assessment; not original acceptance',metadata:'{}'});
  await c.query("update queue_coordinator_assignments set state='running',child_run_id=$2 where id=$1",[assignment,assessmentRun]);
  const chain=async(id:string)=>(await verifyRunReceiptChainOnClient(c,id)).valid;
  const candidate=await recordRepairRevisionCandidateOnClient(c,result,{chain});
  assert.equal(candidate.repairRunId,assessmentRun);assert.equal(candidate.provenanceKind,'authorized-current-baseline-assessment');assert.equal(candidate.repairedHash,enrollment.subjectHash);
  assert.equal((await c.query('select status from workflow_runs where id=$1',[prior])).rows[0].status,'blocked');
  // A successful baseline assessment creates a candidate, never acceptance.
  assert.equal(await verifyRepairedRevisionAttestationOnClient(c,source,enrollment.subjectHash,{chain}),false);
 }finally{await c.query('rollback');}});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
