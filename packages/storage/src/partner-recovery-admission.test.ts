import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import YAML from 'yaml';
import {databaseUrl,withClient} from './client.js';
import {createWorkflowRun,seedRegistry} from './postgres.js';
import {workflowSchema,projectConfigSchema} from '../../agent-registry/src/schemas.js';
import {loadProjectConfig} from '../../agent-registry/src/loaders.js';
import {canonicalJsonHash,resolveExecutionPolicy} from '../../policy-engine/src/index.js';
import {acquireWorkIntent,releaseWorkIntent} from './reliability.js';
import {projectIdentitySchemaSql} from './project-identity.js';
import {initializeLegacyRecoveryEnrollments,enrollLegacyRecovery} from './legacy-recovery.js';
import {captureRepairRevisionManifest,repairRevisionManifestHash,initializeRepairedRevisions} from './repaired-revision.js';
import {acceptanceDigest} from './acceptance.js';
import {initializeQueueCoordinator} from './queue-coordinator.js';
import {decideActionApproval,claimActionApprovalExecution,markActionApprovalExecution,requestActionApproval} from './action-approvals.js';
import {planPartnerAdmission,requestPartnerAdmission,executePartnerAdmission,admittedPartnerProject,type PartnerAdmissionPacket} from './partner-recovery-admission.js';

async function fixture(body:(f:{packet:PartnerAdmissionPacket;config:ReturnType<typeof projectConfigSchema.parse>;request():ReturnType<typeof requestPartnerAdmission>;release():Promise<void>;sibling():Promise<{runId:string}>})=>Promise<void>){
 assert.match(new URL(databaseUrl()).pathname,/^\/agentflow_suite_test_[a-f0-9]{32}$/u,'Never seed a runtime database');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'synthetic-partner-admission-')));
 let intent:Awaited<ReturnType<typeof acquireWorkIntent>>|undefined;
 try{
  await fs.mkdir(path.join(root,'.agent-workflow'));await fs.mkdir(path.join(root,'src'));await fs.mkdir(path.join(root,'tests'));
  await fs.writeFile(path.join(root,'src/main.py'),'value = 1\n');await fs.writeFile(path.join(root,'tests/test_main.py'),'import unittest\nclass Check(unittest.TestCase):\n def test_value(self): self.assertEqual(1, 1)\n');
  const raw=YAML.stringify({project:{name:`Synthetic admission ${randomUUID()}`,autonomy:2},actions:{allowed_write_paths:['src/**','tests/**'],allowed_commands:['git diff --check'],blocked_commands:[]}});
  await fs.writeFile(path.join(root,'.agent-workflow/project.yaml'),raw);
  const config=await loadProjectConfig(root),policy=resolveExecutionPolicy(config,'local').project;
  const workflow=workflowSchema.parse({id:`synthetic-admission-${randomUUID()}`,name:'Synthetic admission',description:'Synthetic isolated decision fixture',lead:'workflow-orchestrator',stages:[{id:'repair',agent:'workflow-orchestrator',goal:'Synthetic scoped repair',output:'evidence'}]});
  await withClient(c=>c.query(`insert into agents(id,display_name,category,source_path,definition) values('workflow-orchestrator','Synthetic orchestrator','test','synthetic','{}') on conflict(id) do nothing`));
  await seedRegistry([],[{path:'synthetic/workflow',value:workflow}]);
  await withClient(c=>c.query(projectIdentitySchemaSql));await initializeLegacyRecoveryEnrollments();await initializeQueueCoordinator();await initializeRepairedRevisions();
  const run=await createWorkflowRun({projectName:config.project.name,projectRootUri:root,projectProfile:'enterprise',projectConfig:config,workflow,task:'Synthetic original source requirement',autonomy:'2',policyProfile:'local',policySnapshot:policy,policySnapshotHash:canonicalJsonHash(policy)});
  const identity=await withClient(async c=>{
   await c.query("update workflow_runs set status='blocked' where id=$1",[run.runId]);await c.query("update workflow_tasks set status='blocked' where run_id=$1",[run.runId]);
   return(await c.query('select project_id::text,run_set_id::text from workflow_runs where id=$1',[run.runId])).rows[0];
  });
  const sourcePaths=['src/main.py','tests/test_main.py'],manifest=await captureRepairRevisionManifest(root,sourcePaths);
  const packet:PartnerAdmissionPacket={version:1,purpose:'partner-recovery-admission',sourceRunId:run.runId,projectId:identity.project_id,projectRootUri:root,familyId:`${identity.project_id}:${identity.run_set_id}`,
   taskHash:acceptanceDigest('Synthetic original source requirement'),sourcePaths,manifest,sourceHash:repairRevisionManifestHash(manifest),policyHash:canonicalJsonHash(policy),configHash:createHash('sha256').update(raw).digest('hex'),
   recipes:planPartnerAdmission(policy,sourcePaths).recipes,enrollCurrentBaseline:true,provider:'codex-cli',modelTier:'standard',offlineOnly:true,allowApprovedRecipeAdditions:true,historicalContinuity:'unverified',originalAcceptanceChanged:false};
  intent=await acquireWorkIntent({projectId:packet.projectId,owner:'synthetic-admission-request',objective:'Synthetic exact admission request',fileScopes:sourcePaths,ttlSeconds:120});
  const release=async()=>{if(intent){await releaseWorkIntent({projectId:packet.projectId,owner:intent.owner,fencingToken:String(intent.fencingToken)});intent=undefined;}};
  const sibling=async()=>{
   const other=await createWorkflowRun({projectName:config.project.name,projectRootUri:root,projectProfile:'enterprise',projectConfig:config,workflow,task:'A separate synthetic original',autonomy:'2',policyProfile:'local',policySnapshot:policy,policySnapshotHash:canonicalJsonHash(policy)});
   await withClient(async c=>{await c.query("update workflow_runs set status='blocked' where id=$1",[other.runId]);await c.query("update workflow_tasks set status='blocked' where run_id=$1",[other.runId]);});return other;
  };
  await body({packet,config,request:()=>requestPartnerAdmission(packet,intent!.owner,String(intent!.fencingToken)),release,sibling});
 }finally{if(intent)await releaseWorkIntent({projectId:intent.projectId,owner:intent.owner,fencingToken:String(intent.fencingToken)});await fs.rm(root,{recursive:true,force:true});}
}
async function approved(p:PartnerAdmissionPacket,approvalId:string){
 assert.ok(await decideActionApproval({approvalId,decision:'approved',actor:'synthetic-human',actorRole:'operator'}));
 const claim=await claimActionApprovalExecution({approvalId,actor:'synthetic-executor',actorRole:'operator'});assert.ok(claim);
 return {approvalId,executionClaimToken:claim.claimToken,actor:'synthetic-executor'};
}
test('repeated and concurrent admission checks create one pending approval and no repair reservation',async()=>fixture(async f=>{
 const before=await fs.readFile(path.join(f.packet.projectRootUri,'.agent-workflow/project.yaml'),'utf8');
 const results=await Promise.all([f.request(),f.request(),f.request()]);assert.equal(new Set(results.map(r=>r.approvalId)).size,1);
 const counts=await withClient(async c=>(await c.query(`select count(*)::int n from action_receipts where run_id=$1 and action_type='action_approval_requested'`,[f.packet.sourceRunId])).rows[0]);assert.equal(counts.n,1);
 assert.equal(await fs.readFile(path.join(f.packet.projectRootUri,'.agent-workflow/project.yaml'),'utf8'),before);
 await assert.rejects(executePartnerAdmission({approvalId:results[0]!.approvalId,executionClaimToken:randomUUID(),actor:'synthetic-executor'}),/Live approved/);
}));
test('human approval admits exact recipes and hash-bound ownership without accepting the original',async()=>fixture(async f=>{
 const request=await f.request(),input=await approved(f.packet,request.approvalId);await f.release();
 const result=await executePartnerAdmission(input);assert.match(result.artifactUri,/partner_recovery_admission/);
 await markActionApprovalExecution({approvalId:input.approvalId,status:'executed',actor:input.actor,actorRole:'operator',summary:'Synthetic decision applied',artifactUri:result.artifactUri,executionClaimToken:input.executionClaimToken});
 const current=resolveExecutionPolicy(await loadProjectConfig(f.packet.projectRootUri),'local').project;
 assert.equal(planPartnerAdmission(current,f.packet.sourcePaths).ready,true);
 assert.deepEqual(current.actions.allowed_write_paths,f.config.actions.allowed_write_paths);
 assert.deepEqual(current.actions.blocked_commands,f.config.actions.blocked_commands);
 assert.equal(current.actions.auto_approve_max_risk,f.config.actions.auto_approve_max_risk);
 const intent=await acquireWorkIntent({projectId:f.packet.projectId,owner:'synthetic-enrollment',objective:'Synthetic baseline enrollment',fileScopes:f.packet.sourcePaths,ttlSeconds:120});
 try{
  const enrollment=await enrollLegacyRecovery({sourceRunId:f.packet.sourceRunId,projectId:f.packet.projectId,familyId:f.packet.familyId,taskHash:f.packet.taskHash,sourcePaths:f.packet.sourcePaths,authorizationId:input.approvalId,owner:intent.owner,intentFence:String(intent.fencingToken)});
  assert.equal(enrollment.subjectHash,f.packet.sourceHash);assert.equal(enrollment.contract.deliverables[0]!.status,'pending');
  const {readQueueCoordinatorSnapshot}=await import('../../../apps/cli/src/commands/queue-coordinator.js');
  const snapshot=await readQueueCoordinatorSnapshot([f.packet.projectRootUri],[f.packet.sourceRunId]);
  const family=snapshot.families.find(x=>x.sourceRunId===f.packet.sourceRunId)!;
  assert.equal(family.originalAcceptancePresent,true);assert.equal(family.sourceEvidenceReady,true);assert.equal(family.verificationReady,false,'Legacy history cannot substitute for a fresh independent verifier');
 }finally{await releaseWorkIntent({projectId:f.packet.projectId,owner:intent.owner,fencingToken:String(intent.fencingToken)});}
 await assert.rejects(executePartnerAdmission(input),/Live approved/,'Executed claims cannot replay policy or baseline effects');
}));
test('source or policy drift after approval stops before a project policy write',async()=>fixture(async f=>{
 const r=await f.request(),input=await approved(f.packet,r.approvalId);await f.release();
 const configPath=path.join(f.packet.projectRootUri,'.agent-workflow/project.yaml'),before=await fs.readFile(configPath,'utf8');
 await fs.appendFile(path.join(f.packet.projectRootUri,'src/main.py'),'value = 2\n');
 await assert.rejects(executePartnerAdmission(input),/Scoped source drift/);assert.equal(await fs.readFile(configPath,'utf8'),before);
}));
test('a consumed decision cannot enroll bytes that changed after admission',async()=>fixture(async f=>{
 const request=await f.request(),input=await approved(f.packet,request.approvalId);await f.release();
 const result=await executePartnerAdmission(input);
 await markActionApprovalExecution({approvalId:input.approvalId,status:'executed',actor:input.actor,actorRole:'operator',summary:'Synthetic decision applied',artifactUri:result.artifactUri,executionClaimToken:input.executionClaimToken});
 await fs.appendFile(path.join(f.packet.projectRootUri,'src/main.py'),'value = 3\n');
 const intent=await acquireWorkIntent({projectId:f.packet.projectId,owner:'synthetic-drifted-enrollment',objective:'Synthetic drift must remain refused',fileScopes:f.packet.sourcePaths,ttlSeconds:120});
 try{await assert.rejects(enrollLegacyRecovery({sourceRunId:f.packet.sourceRunId,projectId:f.packet.projectId,familyId:f.packet.familyId,taskHash:f.packet.taskHash,sourcePaths:f.packet.sourcePaths,authorizationId:input.approvalId,owner:intent.owner,intentFence:String(intent.fencingToken)}),/differs from the exact reviewed/);}
 finally{await releaseWorkIntent({projectId:f.packet.projectId,owner:intent.owner,fencingToken:String(intent.fencingToken)});}
}));
test('a competing live source owner and an expired decision stop admission without configuration effects',async()=>fixture(async f=>{
 const request=await f.request(),input=await approved(f.packet,request.approvalId);await f.release();
 const configPath=path.join(f.packet.projectRootUri,'.agent-workflow/project.yaml'),before=await fs.readFile(configPath,'utf8');
 const other=await acquireWorkIntent({projectId:f.packet.projectId,owner:'synthetic-other-owner',objective:'Synthetic concurrent source ownership',fileScopes:f.packet.sourcePaths,ttlSeconds:120});
 try{await assert.rejects(executePartnerAdmission(input),/conflicts with active owner/);}
 finally{await releaseWorkIntent({projectId:f.packet.projectId,owner:other.owner,fencingToken:String(other.fencingToken)});}
 await withClient(c=>c.query("update action_approvals set expires_at=clock_timestamp()-interval '1 second' where id=$1",[input.approvalId]));
 await assert.rejects(executePartnerAdmission(input),/Live approved/);assert.equal(await fs.readFile(configPath,'utf8'),before);
}));
test('blocked commands and broader test recipes cannot be installed through admission',async()=>fixture(async f=>{
 const p=projectConfigSchema.parse({...f.config,actions:{...f.config.actions,blocked_commands:['python3 *']}});
 assert.throws(()=>admittedPartnerProject(p,f.packet),/blocked|not allowed/iu);
 assert.throws(()=>admittedPartnerProject(f.config,{...f.packet,recipes:[{...f.packet.recipes[0]!,commands:['python3 -m unittest discover -s tests']}]}),/Invalid exact/);
}));
test('a canary snapshot reads only its exact original family from the migrated schema',async()=>fixture(async f=>{
 const other=await f.sibling();
 const {readQueueCoordinatorSnapshot}=await import('../../../apps/cli/src/commands/queue-coordinator.js');
 const one=await readQueueCoordinatorSnapshot([f.packet.projectRootUri],[f.packet.sourceRunId]);
 assert.equal(one.sources.size,1);assert.ok(one.sources.has(f.packet.sourceRunId));assert.ok(!one.sources.has(other.runId));
 const sibling=await readQueueCoordinatorSnapshot([f.packet.projectRootUri],[other.runId]);
 assert.equal(sibling.sources.size,1);assert.ok(sibling.sources.has(other.runId));assert.ok(!sibling.sources.has(f.packet.sourceRunId));
}));
test('independent exact decisions survive another receipted human-approved recipe addition in their project',async()=>fixture(async f=>{
 const first=await f.request();await f.release();
 const sibling=await f.sibling(),row=await withClient(async c=>(await c.query('select run_set_id::text from workflow_runs where id=$1',[sibling.runId])).rows[0]);
 const packet={...f.packet,sourceRunId:sibling.runId,familyId:`${f.packet.projectId}:${row.run_set_id}`,taskHash:acceptanceDigest('A separate synthetic original')};
 const intent=await acquireWorkIntent({projectId:packet.projectId,owner:'synthetic-second-decision',objective:'Synthetic second exact family decision',fileScopes:packet.sourcePaths,ttlSeconds:120});
 let second;try{second=await requestPartnerAdmission(packet,intent.owner,String(intent.fencingToken));}
 finally{await releaseWorkIntent({projectId:packet.projectId,owner:intent.owner,fencingToken:String(intent.fencingToken)});}
 const a=await approved(f.packet,first.approvalId),applied=await executePartnerAdmission(a);
 await markActionApprovalExecution({approvalId:a.approvalId,status:'executed',actor:a.actor,actorRole:'operator',summary:'Synthetic first reviewed recipe applied',artifactUri:applied.artifactUri,executionClaimToken:a.executionClaimToken});
 const b=await approved(packet,second.approvalId),rebased=await executePartnerAdmission(b);
 const content=await withClient(async c=>(await c.query('select content from artifacts where uri=$1',[rebased.artifactUri])).rows[0].content);
 assert.deepEqual(content.compatibleApprovals,[first.approvalId]);
 assert.equal(content.packet.policyHash,f.packet.policyHash,'The actual human-reviewed packet remains immutable');
}));
test('unreceipted policy widening never qualifies as an approved recipe addition',async()=>fixture(async f=>{
 const request=await f.request(),input=await approved(f.packet,request.approvalId);await f.release();
 const configPath=path.join(f.packet.projectRootUri,'.agent-workflow/project.yaml'),doc=YAML.parseDocument(await fs.readFile(configPath,'utf8'));
 doc.setIn(['actions','allowed_commands'],['python3 *']);await fs.writeFile(configPath,doc.toString());const changed=await fs.readFile(configPath,'utf8');
 await assert.rejects(executePartnerAdmission(input),/drift outside verified approved recipe additions/);
 assert.equal(await fs.readFile(configPath,'utf8'),changed);
}));
test('an audit transaction failure restores the exact policy and leaves no baseline authorization',async()=>fixture(async f=>{
 const request=await f.request(),input=await approved(f.packet,request.approvalId);await f.release();
 const configPath=path.join(f.packet.projectRootUri,'.agent-workflow/project.yaml'),before=await fs.readFile(configPath,'utf8');
 const trigger='synthetic_admission_failure_'+randomUUID().replaceAll('-','');
 await withClient(c=>c.query(`create function ${trigger}() returns trigger language plpgsql as $$ begin
  if new.run_id='${f.packet.sourceRunId}'::uuid and new.action_type='partner_recovery_admission_applied' then raise exception 'Synthetic admission audit failure';end if;return new;end $$;
  create trigger ${trigger} before insert on action_receipts for each row execute function ${trigger}();`));
 try{
  await assert.rejects(executePartnerAdmission(input),/configuration restored to its exact preimage/);
  assert.equal(await fs.readFile(configPath,'utf8'),before);
  const n=await withClient(async c=>(await c.query("select count(*)::int n from action_receipts where run_id=$1 and action_type='operator_legacy_recovery_authorized'",[f.packet.sourceRunId])).rows[0].n);
  assert.equal(n,0);
 }finally{await withClient(c=>c.query(`drop trigger ${trigger} on action_receipts;drop function ${trigger}();`));}
}));
test('pending descendant approvals retain their family fence across separate run sets',async()=>fixture(async f=>{
 const request=await f.request(),child=await f.sibling();await f.release();
 await withClient(c=>c.query("update workflow_runs set evaluation_metadata=jsonb_build_object('sourceRunId',$2::text) where id=$1",[child.runId,f.packet.sourceRunId]));
 await requestActionApproval({runId:child.runId,stageId:'synthetic-child',agentId:'workflow-orchestrator',actionType:'local_command',target:'git diff --check',rationale:'Synthetic still-pending descendant action',policyDecision:{approvalRequired:true},payload:{commandLine:'git diff --check'},idempotencyKey:'synthetic-child-pending'});
 const input=await approved(f.packet,request.approvalId),file=path.join(f.packet.projectRootUri,'.agent-workflow/project.yaml'),before=await fs.readFile(file,'utf8');
 await assert.rejects(executePartnerAdmission(input),/another approval must be reconciled/);assert.equal(await fs.readFile(file,'utf8'),before);
}));
