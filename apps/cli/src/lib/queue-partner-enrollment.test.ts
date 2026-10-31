import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {enrollmentOfflineCommands,dependencyEnrollmentPreflight,partnerEnrollmentWindow,dependencyOwnershipChildMatches,advancePartnerEnrollment,advanceAuthorizedPartnerEnrollments} from './queue-partner-enrollment.js';
import {PartnerPlanningStopped} from './queue-partner-watch.js';
import {acceptanceDigest} from '../../../../packages/storage/src/acceptance.js';
import type {CrossProjectEnrollment} from '../../../../packages/storage/src/cross-project-enrollment.js';
import {projectConfigSchema} from '../../../../packages/agent-registry/src/schemas.js';
import {canonicalJsonHash,resolveExecutionPolicy} from '../../../../packages/policy-engine/src/index.js';
import {withClient} from '../../../../packages/storage/src/client.js';
import type {DependencyScope} from '../../../../packages/storage/src/cross-project-enrollment.js';
test('stopped enrollment cannot discover plans or begin another project dependency',async()=>{
 await assert.rejects(()=>advanceAuthorizedPartnerEnrollments('/synthetic',[],()=>true),PartnerPlanningStopped);
 await assert.rejects(()=>advancePartnerEnrollment('/synthetic',{} as CrossProjectEnrollment,[],()=>true),PartnerPlanningStopped);
});
test('enrollment only narrows the target command policy; no grants or external commands',()=>{
  const config=projectConfigSchema.parse({project:{name:'synthetic',autonomy:2},actions:{allowed_commands:['git diff --check'],blocked_commands:[]}});
  assert.deepEqual(enrollmentOfflineCommands(config),['git diff --check']);
});
test('dependency recipes exclude broad suites and bind focused tests to exact source scope',()=>{
  const config=projectConfigSchema.parse({project:{name:'synthetic',autonomy:2},actions:{allowed_commands:[
    'python3 -m unittest discover -s tests',
    'python3 -m unittest discover -s tests -p test_owned.py -v',
    'python3 -m unittest discover -s tests -p test_foreign.py -v',
    'git diff --check'
  ],blocked_commands:[]}});
  assert.deepEqual(enrollmentOfflineCommands(config,['tests/test_owned.py']),[
    'python3 -m unittest discover -s tests -p test_owned.py -v','git diff --check'
  ]);
  assert.deepEqual(enrollmentOfflineCommands(config),['git diff --check']);
  assert.deepEqual(enrollmentOfflineCommands(config,['tests/test_foreign.py']),[
    'python3 -m unittest discover -s tests -p test_foreign.py -v','git diff --check'
  ]);
});
test('runtime retains per-project identities, exact authority, independent freshness and no replay',async()=>{
  const source=await fs.readFile(new URL('./queue-partner-enrollment.ts',import.meta.url),'utf8');
  for(const guard of ['operator_cross_project_enrollment_authorized','planDigest===acceptanceDigest(p)','verifyRunReceiptChainOnClient','acceptancePreflight','sourceSubjectHash','approvalTransfer:false','cross_project_enrollment_attempt','dependencyPlanDigest','expires_at>clock_timestamp()','startBefore']){
    assert.ok(source.includes(guard),guard);
  }
  assert.doesNotMatch(source,/update workflow_runs|delete from workflow_runs|replayWorkflowRun|approveAction/);
});
test('dependency recovery preserves terminal history and keeps technical reasoning with Partner',async()=>{
  const source=await fs.readFile(new URL('../commands/queue-coordinator.ts',import.meta.url),'utf8');
  assert.match(source,/const dependencyHolds=data\.families\.filter\(f=>enrolled\.has\(f\.familyId\)&&!f\.activeRunIds\.length&&data\.sources\.get\(f\.sourceRunId\)\?\.metadata\?\.dependencyPlanId\)/);
  assert.match(source,/!dependencyHolds\.some\(h=>h\.familyId===f\.familyId\)/);
  assert.match(source,/advanceAuthorizedPartnerEnrollments\(ctx\.rootDir,projectRoots,shouldStop\)/);
  const enrollment=await fs.readFile(new URL('./queue-partner-enrollment.ts',import.meta.url),'utf8');
  assert.doesNotMatch(enrollment,/requestQueuePartnerHelp|Codex must/);assert.match(enrollment,/configured Partner model/);
});
test('PostgreSQL target preflight refuses foreign identity, policy drift, pending work and verifier/capacity conflicts',async()=>{
  await withClient(async c=>{
    await c.query('begin');
    try{
      await c.query(`create temporary table projects(id uuid,root_uri text) on commit drop;
        create temporary table project_identity_locations(project_id uuid,identity_id uuid,kind text) on commit drop;
        create temporary table workflow_runs(id uuid,project_id uuid,status text,evaluation_metadata jsonb,run_set_id uuid default gen_random_uuid()) on commit drop;
        create temporary table artifacts(run_id uuid,kind text,uri text,content jsonb) on commit drop;
        create temporary table action_approvals(run_id uuid,status text) on commit drop;
        create temporary table queue_coordinator_assignments(project_id uuid,role text,state text,id uuid,fence bigint,child_run_id uuid,
          source_run_id uuid,family_id text,owner text,intent_fence text,file_scopes jsonb default '[]',lane integer default 1) on commit drop;`);
      const project=randomUUID(),foreign=randomUUID(),root=await fs.realpath(os.tmpdir());
      const config=projectConfigSchema.parse({project:{name:'synthetic',autonomy:2},actions:{allowed_commands:['git diff --check'],allowed_write_paths:['src/**'],blocked_commands:[],blocked_write_paths:[]}});
      const s:DependencyScope={id:'canonical',projectId:project,projectRootUri:root,task:'synthetic original requirements',sourcePaths:['src/main.ts'],policyHash:canonicalJsonHash(resolveExecutionPolicy(config,'local').project),provider:'codex-cli',modelTier:'standard',offlineOnly:true,externalProofRequired:false,requiredGates:['implementation','verification','packaging','supervision']};
      const load=async()=>config;
      await c.query('insert into projects values($1,$2)',[project,root]);
      await c.query("insert into project_identity_locations values($1,$1,'canonical')",[project]);
      assert.equal((await dependencyEnrollmentPreflight(c,s,load)).ok,true);
      assert.equal((await dependencyEnrollmentPreflight(c,{...s,projectId:foreign},load)).ok,false);
      assert.equal((await dependencyEnrollmentPreflight(c,{...s,policyHash:'0'.repeat(64)},load)).ok,false);
      await assert.rejects(dependencyEnrollmentPreflight(c,{...s,sourcePaths:['foreign/source.ts']},load),/not allowed/);
      await c.query("insert into workflow_runs values($1,$2,'blocked','{}')",[randomUUID(),project]);
      const run=(await c.query('select id from workflow_runs limit 1')).rows[0].id;
      await c.query("insert into action_approvals values($1,'pending')",[run]);
      assert.equal((await dependencyEnrollmentPreflight(c,s,load)).ok,false);
      await c.query('delete from action_approvals');
      await c.query("update workflow_runs set status='running'");
      assert.equal((await dependencyEnrollmentPreflight(c,s,load)).ok,false);
      await c.query("update workflow_runs set status='blocked'");
      await c.query("insert into queue_coordinator_assignments(project_id,role,state) values($1,'verifier','reserved')",[foreign]);
      assert.equal((await dependencyEnrollmentPreflight(c,s,load)).ok,false,'Foreign verifier lane is still globally exclusive');
      await c.query('delete from queue_coordinator_assignments');
      await c.query("insert into queue_coordinator_assignments(project_id,role,state) select $1,'repair','reserved' from generate_series(1,5)",[foreign]);
      assert.equal((await dependencyEnrollmentPreflight(c,s,load)).ok,false,'Five reserved repair families exhaust capacity');
      await c.query('delete from queue_coordinator_assignments');
      await c.query("insert into workflow_runs values($1,$2,'queued','{\"source\":\"authorized-project-dependency\"}')",[randomUUID(),foreign]);
      assert.equal((await dependencyEnrollmentPreflight(c,s,load)).ok,false,'Do not start a second independent dependency verifier workflow');
      await c.query("delete from workflow_runs where project_id=$1",[foreign]);
      assert.equal((await dependencyEnrollmentPreflight(c,s,load)).ok,true);
      for(let index=0;index<3;index++){
        const claimId=randomUUID(),childId=randomUUID(),metadata={queueCoordinatorClaimId:claimId,queueCoordinatorFence:String(index+1),source:'queue-partner-recovery'};
        await c.query("insert into queue_coordinator_assignments values($1,'repair','running',$2,$3,$4)",[foreign,claimId,index+1,childId]);
        await c.query("insert into workflow_runs values($1,$2,'running',$3)",[childId,foreign,JSON.stringify(metadata)]);
      }
      assert.equal((await dependencyEnrollmentPreflight(c,s,load)).ok,true,'Three attached actors count three, leaving room for this independent project dependency');
    }finally{await c.query('rollback');}
  });
});
test('PostgreSQL resume is append-only, latest-bound, revocable and never changes plan digest',async()=>{
  await withClient(async c=>{await c.query('begin');try{
    await c.query('create temporary table action_receipts(run_id uuid,agent_id text,action_type text,metadata jsonb,created_at timestamptz) on commit drop');
    const p={id:randomUUID(),sourceRunId:randomUUID(),startBefore:'2020-01-01T00:00:00Z',pauseAt:'2020-01-01T00:05:00Z'} as CrossProjectEnrollment;
    const now=Date.parse('2030-01-01T00:30:00Z');
    const r={version:1,resumeId:randomUUID(),planId:p.id,sourceRunId:p.sourceRunId,planDigest:acceptanceDigest(p),approvalSource:'direct-human',approvalDecision:'approved',authorizedAt:'2030-01-01T00:00:00Z',expiresAt:'2030-01-01T01:00:00Z',replayAllowed:false,approvalTransfer:false};
    assert.equal(await partnerEnrollmentWindow(c,p,now),false);
    await c.query("insert into action_receipts values($1,'workflow-orchestrator','operator_cross_project_enrollment_resumed',$2,'2030-01-01T00:00:00Z')",[p.sourceRunId,r]);
    assert.equal(await partnerEnrollmentWindow(c,p,now),true);
    assert.equal(await partnerEnrollmentWindow(c,p,Date.parse(r.expiresAt)),false);
    await c.query("insert into action_receipts values($1,'workflow-orchestrator','operator_cross_project_enrollment_resume_revoked',$2,'2030-01-01T00:01:00Z')",[p.sourceRunId,{planId:p.id}]);
    assert.equal(await partnerEnrollmentWindow(c,p,now),false);
    assert.equal((await c.query('select count(*)::int n from action_receipts')).rows[0].n,2);
    await c.query("insert into action_receipts values($1,'workflow-orchestrator','operator_cross_project_enrollment_resumed',$2,'2030-01-01T00:02:00Z')",[p.sourceRunId,{...r,resumeId:randomUUID()}]);
    assert.equal(await partnerEnrollmentWindow(c,p,now),true,'Fresh explicit resume can supersede revocation');
    await c.query("insert into action_receipts values($1,'workflow-orchestrator','operator_cross_project_enrollment_resumed',$2,'2030-01-01T00:03:00Z')",[p.sourceRunId,{...r,resumeId:randomUUID(),expiresAt:'2030-01-01T00:01:00Z'}]);
    assert.equal(await partnerEnrollmentWindow(c,p,now),false,'Expired newest authority never falls back to older live authority');
    assert.equal((await c.query('select count(*)::int n from action_receipts')).rows[0].n,4,'Append only');
  }finally{await c.query('rollback');}});
});
test('ownership routing never borrows a foreign project/task/plan or transfers approval',()=>{
  const scope={id:'product',projectId:'canonical',task:'Exact original product requirements'} as DependencyScope;
  const p={id:'plan',scopes:[scope],approvalTransfer:false} as CrossProjectEnrollment;
  const child={project_id:scope.projectId,task:scope.task,evaluation_metadata:{dependencyPlanId:p.id,dependencyScopeId:scope.id,dependencyPlanDigest:acceptanceDigest(p),approvalTransfer:false}};
  assert.equal(dependencyOwnershipChildMatches(p,scope,child),true);
  for(const c of [{...child,project_id:'vendor'},{...child,task:'weakened'},...['dependencyPlanId','dependencyScopeId','dependencyPlanDigest','approvalTransfer'].map(k=>({...child,evaluation_metadata:{...child.evaluation_metadata,[k]:'foreign'}}))])assert.equal(dependencyOwnershipChildMatches(p,scope,c),false);
});
