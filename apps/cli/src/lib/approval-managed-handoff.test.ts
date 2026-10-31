import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {projectConfigSchema,workflowSchema} from '../../../../packages/agent-registry/src/schemas.js';
import {databaseUrl,withClient} from '../../../../packages/storage/src/client.js';
import {createWorkflowRun,seedRegistry} from '../../../../packages/storage/src/postgres.js';
import {requestActionApproval,decideActionApproval,getActionApproval,claimActionApprovalExecution,markActionApprovalExecution} from '../../../../packages/storage/src/action-approvals.js';
import {resumeBlockedRunAfterResolvedApprovals} from './builders-shared.js';
import {canonicalJsonHash} from '../../../../packages/policy-engine/src/index.js';

test('a recorded human approval hands managed continuation back without replaying or failing the decision',async()=>{
 assert.match(new URL(databaseUrl()).pathname,/^\/agentflow_suite_test_[a-f0-9]{32}$/u,'Never seed a runtime database');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'synthetic-approval-handoff-')));
 try{
  const config=projectConfigSchema.parse({project:{name:`Synthetic approval ${randomUUID()}`}});
  const workflow=workflowSchema.parse({id:`synthetic-approval-${randomUUID()}`,name:'Synthetic approval',description:'Isolated managed handoff regression',lead:'workflow-orchestrator',stages:[{id:'repair',agent:'workflow-orchestrator',goal:'Synthetic evidence',output:'evidence'}]});
  await withClient(c=>c.query("insert into agents(id,display_name,category,source_path,definition) values('workflow-orchestrator','Synthetic orchestrator','test','synthetic','{}') on conflict(id) do nothing"));
  await seedRegistry([],[{path:'synthetic/workflow',value:workflow}]);
  const run=await createWorkflowRun({projectName:config.project.name,projectRootUri:root,projectProfile:'enterprise',projectConfig:config,workflow,task:'Synthetic original outcome',autonomy:'2',policyProfile:'local',policySnapshot:config,policySnapshotHash:canonicalJsonHash(config)});
  await withClient(async c=>{
   await c.query("update workflow_runs set status='blocked' where id=$1",[run.runId]);
   await c.query("update workflow_tasks set status='blocked' where run_id=$1",[run.runId]);
   await c.query("insert into artifacts(run_id,kind,uri,content) select id,'queue_partner_repair_management',$2,jsonb_build_object('manager','queue-partner','enabled',true,'sourceRunId',id::text,'projectId',project_id::text,'familyId',project_id::text||':'||run_set_id::text) from workflow_runs where id=$1",[run.runId,`db://synthetic/${randomUUID()}`]);
  });
  const request=await requestActionApproval({runId:run.runId,stageId:'repair',agentId:'workflow-orchestrator',actionType:'local_command',target:'synthetic-evidence',rationale:'Synthetic scoped decision',policyDecision:{allowed:false},payload:{},idempotencyKey:randomUUID()});
  await decideActionApproval({approvalId:request.approvalId,decision:'approved',actor:'synthetic-human',actorRole:'approver'});
  assert.equal((await resumeBlockedRunAfterResolvedApprovals(run.runId)).resumedTasks,0,'An approved but unexecuted effect does not release its run');
  assert.equal((await getActionApproval(request.approvalId))?.status,'approved');
  const claim=await claimActionApprovalExecution({approvalId:request.approvalId,actor:'synthetic-executor',actorRole:'operator'});assert.ok(claim);
  await markActionApprovalExecution({approvalId:request.approvalId,status:'executed',actor:'synthetic-executor',actorRole:'operator',summary:'Synthetic effect recorded',executionClaimToken:claim.claimToken});
  const before=await withClient(async c=>(await c.query('select count(*)::int n from workflow_runs where project_id=(select project_id from workflow_runs where id=$1)',[run.runId])).rows[0].n);
  const result=await resumeBlockedRunAfterResolvedApprovals(run.runId);
  assert.equal(result.resumedTasks,0);assert.equal(result.replacementRunId,undefined);assert.match(result.holdReason??'',/Partner|coordinator/u);
  assert.equal((await getActionApproval(request.approvalId))?.status,'executed');
  const after=await withClient(async c=>(await c.query("select status,replacement_run_id,(select count(*)::int from workflow_runs p where p.project_id=r.project_id) n,(select count(*)::int from workflow_tasks t where t.run_id=r.id and t.status<>'blocked') changed_tasks from workflow_runs r where id=$1",[run.runId])).rows[0]);
  assert.equal(after.status,'blocked');assert.equal(after.replacement_run_id,null);assert.equal(after.n,before);assert.equal(after.changed_tasks,0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
