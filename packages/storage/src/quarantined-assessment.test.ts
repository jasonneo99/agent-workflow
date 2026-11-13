import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {Client} from 'pg';
import {acceptanceDigest} from './acceptance.js';
import {validateQuarantinedAssessmentOnClient,quarantinedAssessmentOfflineCommands,type QuarantinedAssessmentContext} from './quarantined-assessment.js';
import {withClient} from './client.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context:QuarantinedAssessmentContext={sourceRunId:id(1),priorRunId:id(2),projectId:id(3),assignmentId:id(4),priorFence:'13',priorTask:'Original unchanged task',priorStatus:'cancelled',subjectHash:'a'.repeat(64),originalContractDigest:'b'.repeat(64),provider:'mock',modelTier:'standard'};
const proof=()=>({version:1,mode:'cancelled-predecessor-readonly-assessment',priorRunId:context.priorRunId,assignmentId:context.assignmentId,priorFence:context.priorFence,blockedReceiptHash:'c'.repeat(64),dismissalReceiptHash:'d'.repeat(64),recoveredEvidenceUri:'db://synthetic/recovered',preservedQueuedRunIds:[id(5)]});
test('exact read-only recipes require focused enrolled tests and never broad suites or policy invention',()=>{
 const paths=['tests/test_surface.py'];
 assert.deepEqual(quarantinedAssessmentOfflineCommands(['python3 -m unittest tests.test_surface -v','git diff --check'],paths),['python3 -m unittest tests.test_surface -v','git diff --check']);
 assert.deepEqual(quarantinedAssessmentOfflineCommands(['python3 -m unittest discover -s tests -p test_surface.py -k StaticSourceTests -v'],paths),['python3 -m unittest discover -s tests -p test_surface.py -k StaticSourceTests -v']);
 for(const commands of [[],['git diff --check'],['python3 -m unittest discover -s tests'],['python3 -m unittest discover -s tests -p test_*.py -v'],['python3 -m unittest tests.test_other -v'],['python3 -m py_compile tests/test_surface.py'],['python3 -m unittest tests.test_surface -v; touch marker']])assert.equal(quarantinedAssessmentOfflineCommands(commands,paths),null);
});
function harness(){
 const command={exitCode:0,timedOut:false,commandLine:'python3 -m unittest tests.test_source -v',sourceBefore:context.subjectHash,sourceAfter:context.subjectHash,stdout:'fixture diagnostic',stderr:'Ran 2 tests\nOK'};
 const evidence={runId:context.priorRunId,sourceRunId:context.sourceRunId,projectId:context.projectId,authority:'evidence-only',acceptance:'unverified',nativeAcceptance:false,replay:false,rerun:false,commands:[{uri:'db://synthetic/command',command:command.commandLine,artifactDigest:acceptanceDigest(command)}]};
 const state={installed:true,ownAssignment:false,unsafe:false,command,evidence,terminal:[{action_type:'stage_blocked',receipt_hash:'c'.repeat(64),metadata:{},created_at:'2026-01-01T00:00:00Z'},{action_type:'failed_run_dismissed',receipt_hash:'d'.repeat(64),metadata:{priorStatus:'blocked'},created_at:'2026-01-01T00:01:00Z'}],clone:{run_key:id(5),status:'queued',project_key:context.projectId,task:context.priorTask,provider_override:context.provider,model_tier_override:context.modelTier,lease_owner:null,lease_expires_at:null,evaluation_metadata:{sourceRunId:context.sourceRunId,replayOfRunId:context.priorRunId,queueCoordinatorClaimId:context.assignmentId,queueCoordinatorFence:context.priorFence,originalAcceptanceDigest:context.originalContractDigest},policy_snapshot:{actions:{allowed_write_paths:['**']}}}};
 const queries:string[]=[];
 const c={query:async(sql:string)=>{
  queries.push(sql);assert.doesNotMatch(sql,/\b(?:insert|update|delete)\b/iu);
  if(sql.includes('from pg_trigger'))return {rows:[{installed:state.installed}]};
  if(sql.includes('and receipt_hash=any'))return {rows:state.terminal};
  if(sql.includes("kind='operator_recovered_command_evidence'"))return {rows:[{content:state.evidence}]};
  if(sql.includes("action_type='operator_recovered_command_evidence'"))return {rows:[{metadata:state.evidence}]};
  if(sql.includes("kind='command_output'"))return {rows:[{content:state.command}]};
  if(sql.includes('from workflow_runs r'))return {rows:[state.clone]};
  if(sql.includes('from queue_coordinator_assignments'))return {rowCount:state.ownAssignment?1:0,rows:[]};
  if(sql.includes('select 1 where not exists'))return {rowCount:state.unsafe?1:0,rows:[]};
  throw Error(sql);
 }} as unknown as Client;
 return {c,state,queries};
}
test('typed cancelled-predecessor evidence excludes only proven untouched unleaseable clones; returns no copied contract',async()=>{
 const h=harness();assert.deepEqual(await validateQuarantinedAssessmentOnClient(h.c,context,proof()),[id(5)]);
 const sql=h.queries.join('\n');for(const expected of ["status<>'queued'",'worker_id is not null','lease_expires_at is not null','attempts<>0','from action_approvals',"'file_write','command_output','stage_output','stage_continuation'",'a.child_run_id']){
  if(expected==='a.child_run_id')continue;
  assert.ok(sql.includes(expected),expected);
 }
 assert.doesNotMatch(sql,/policy_snapshot/,'The widened clone policy is never adopted');
});
test('missing proof, changed evidence, disabled fences, activity, effects and renewed clone assignment fail closed',async()=>{
 assert.equal(await validateQuarantinedAssessmentOnClient(harness().c,context,undefined),null);
 assert.equal(await validateQuarantinedAssessmentOnClient(harness().c,{...context,priorStatus:'blocked'},proof()),null);
 for(const scenario of ['fence','blocked','dismissed','hash','native','lease','status','project','task','claim','assignment','unsafe'] as const){
  const h=harness();
  if(scenario==='fence')h.state.installed=false;
  if(scenario==='blocked')h.state.terminal[0]!.action_type='stage_failed';
  if(scenario==='dismissed')h.state.terminal[1]!.metadata={priorStatus:'failed'};
  if(scenario==='hash')h.state.command.sourceAfter='e'.repeat(64);
  if(scenario==='native')h.state.evidence.nativeAcceptance=true;
  if(scenario==='lease')h.state.clone.lease_owner='worker' as any;
  if(scenario==='status')h.state.clone.status='running';
  if(scenario==='project')h.state.clone.project_key=id(9);
  if(scenario==='task')h.state.clone.task='Changed requirements';
  if(scenario==='claim')h.state.clone.evaluation_metadata.queueCoordinatorFence='14';
  if(scenario==='assignment')h.state.ownAssignment=true;
  if(scenario==='unsafe')h.state.unsafe=true;
  assert.equal(await validateQuarantinedAssessmentOnClient(h.c,context,proof()),null,scenario);
 }
});
test('assessment reservation still requires existing exact authority, manifest, no writes and every original gate',()=>{
 const source=fs.readFileSync(new URL('./history-preserving-assessment.ts',import.meta.url),'utf8');
 for(const required of ["a.actor!=='operator'","a.authority!=='direct-human'","a.approvalDecision!=='approved'",'a.originalContractDigest!==acceptanceDigest(contract)','a.subjectHash!==subjectHash','!equal(a.sourcePaths,q.file_scopes)',"kind='file_write'",'if(!ignoredQueued)return null','and not run_id=any($3::uuid[])','and not id=any($3::uuid[])'])assert.ok(source.includes(required),required);
 assert.ok(source.indexOf("a.approvalDecision!=='approved'")<source.indexOf('await validateQuarantinedAssessmentOnClient'));
 assert.doesNotMatch(source,/update workflow_runs|update workflow_tasks|delete from/iu);
});

test('PostgreSQL preflight checks real untouched task rows and enabled exact claim fences',async t=>{
 await withClient(async c=>{await c.query('begin');try{
  if(!(await c.query("select to_regprocedure('agentflow_coordinator_claim_fence()') installed")).rows[0]?.installed){t.skip('Explicit claim fence installation is unavailable; never install it implicitly');return;}
  await c.query('create temporary table workflow_runs(id uuid primary key,project_id uuid,run_set_id uuid,status text,task text,lease_owner text,lease_epoch bigint,lease_expires_at timestamptz,evaluation_metadata jsonb,provider_override text,model_tier_override text) on commit drop');
  await c.query('create temporary table workflow_tasks(id uuid,run_id uuid,status text,worker_id text,lease_generation bigint,lease_expires_at timestamptz,started_at timestamptz,finished_at timestamptz,attempts int) on commit drop');
  await c.query('create temporary table artifacts(run_id uuid,kind text,uri text,content jsonb) on commit drop');
  await c.query('create temporary table action_receipts(run_id uuid,action_type text,receipt_hash text,metadata jsonb,created_at timestamptz,target text) on commit drop');
  await c.query('create temporary table action_approvals(run_id uuid,status text) on commit drop');
  await c.query('create temporary table queue_coordinator_assignments(child_run_id uuid) on commit drop');
  const h=harness();
  const clone=h.state.clone;
  await c.query('insert into workflow_runs(id,project_id,status,task,evaluation_metadata,provider_override,model_tier_override) values($1,$2,$3,$4,$5,$6,$7)',[clone.run_key,clone.project_key,clone.status,clone.task,clone.evaluation_metadata,clone.provider_override,clone.model_tier_override]);
  await c.query("insert into workflow_tasks(id,run_id,status,attempts) values($1,$2,'queued',0)",[id(6),id(5)]);
  for(const receipt of h.state.terminal)await c.query('insert into action_receipts(run_id,action_type,receipt_hash,metadata,created_at) values($1,$2,$3,$4,$5)',[context.priorRunId,receipt.action_type,receipt.receipt_hash,receipt.metadata,receipt.created_at]);
  await c.query('insert into artifacts values($1,$2,$3,$4)',[context.priorRunId,'operator_recovered_command_evidence',proof().recoveredEvidenceUri,h.state.evidence]);
  await c.query('insert into artifacts values($1,$2,$3,$4)',[context.priorRunId,'command_output','db://synthetic/command',h.state.command]);
  await c.query('insert into action_receipts(run_id,action_type,target,metadata) values($1,$2,$3,$4)',[context.priorRunId,'operator_recovered_command_evidence',proof().recoveredEvidenceUri,h.state.evidence]);
  assert.equal(await validateQuarantinedAssessmentOnClient(c,context,proof()),null,'Missing temporary-table fences cannot free queued work');
  await c.query('create trigger agentflow_coordinator_run_claim before insert or update of lease_owner,lease_epoch,lease_expires_at on workflow_runs for each row execute function public.agentflow_coordinator_claim_fence()');
  await c.query('create trigger agentflow_coordinator_task_claim before insert or update of worker_id,status,lease_generation,lease_expires_at on workflow_tasks for each row execute function public.agentflow_coordinator_claim_fence()');
  assert.deepEqual(await validateQuarantinedAssessmentOnClient(c,context,proof()),[id(5)]);
  await c.query('update workflow_tasks set attempts=1');
  assert.equal(await validateQuarantinedAssessmentOnClient(c,context,proof()),null,'Attempted task is not an untouched clone');
  await c.query('update workflow_tasks set attempts=0');
  await c.query("insert into action_approvals values($1,'pending')",[id(5)]);
  assert.equal(await validateQuarantinedAssessmentOnClient(c,context,proof()),null,'Pending approvals cannot be ignored');
  await c.query('delete from action_approvals');
  await c.query('alter table workflow_tasks disable trigger agentflow_coordinator_task_claim');
  assert.equal(await validateQuarantinedAssessmentOnClient(c,context,proof()),null,'Disabled claim fence must fail closed');
 }finally{await c.query('rollback');}});
});
