import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import * as api from './postgres.js';
import {withClient} from './client.js';
import {appendActionReceipt} from './receipt-writer.js';
import {projectConfigSchema,workflowSchema} from '../../agent-registry/src/schemas.js';

test('prepared source recovery preserves history and uses explicit fresh retry evidence',async t=>{
 const url=process.env.TEST_DATABASE_URL;
 assert.ok(url&&url===process.env.DATABASE_URL,'Use an explicitly owned isolated test database');
 assert.match(new URL(url).pathname,/^\/agentflow_(?:suite_test_[a-f0-9]{32}|v1_reliability_[a-f0-9]{8})$/u);
 await withClient(async c=>assert.equal((await c.query('select current_database() name')).rows[0].name,new URL(url).pathname.slice(1)));
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'source-replay-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await withClient(async c=>{
  for(const id of ['implementation-agent','test-engineer','workflow-orchestrator'])await c.query("insert into agents(id,display_name,category,source_path,definition)values($1,$1,'test','synthetic','{}')on conflict(id)do nothing",[id]);
 });
 const create=async(label:string,options:{structured?:boolean;task?:string;completed?:boolean;readOnly?:boolean;planning?:boolean;planWrites?:boolean}={})=>{
  const cwd=path.join(root,label);await fs.mkdir(cwd);await fs.mkdir(path.join(cwd,'src'));await fs.writeFile(path.join(cwd,'src/main.js'),'export const value = 1;\n');await fs.writeFile(path.join(cwd,'.gitignore'),'.agent-workflow/\n');
  const git=(...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',env:{PATH:process.env.PATH!,HOME:root}}).trim();
  git('init','-q','-b','main');git('add','src/main.js','.gitignore');git('-c','user.name=Synthetic','-c','user.email=developer@example.com','commit','-qm','Synthetic baseline');
  const workflow=workflowSchema.parse({id:'replay-fixture-'+randomUUID(),name:'Synthetic recovery',description:'Bounded source recovery',lead:'implementation-agent',execution:{kind:options.readOnly?'read-only':'source-change'},stages:[...(options.planning?[{id:'plan',agent:'implementation-agent',goal:'Plan only',pattern:{type:'planner'},output:'plan'}]:[]),{id:'repair',agent:'implementation-agent',goal:'Repair synthetic source',output:'candidate'},{id:'verify',agent:'test-engineer',goal:'Verify synthetic source',pattern:{type:'verifier'},output:'verification'}]});
  await withClient(c=>c.query("insert into workflows(id,name,source_path,definition)values($1,$2,'synthetic',$3)",[workflow.id,workflow.name,JSON.stringify(workflow)]));
  const config=projectConfigSchema.parse({project:{name:'Synthetic recovery '+label,autonomy:2},execution:{pipeline:{required:true}},actions:{allowed_write_paths:['src/main.js']}});
  const requirements={subjectHash:'a'.repeat(64),sourcePaths:['src/main.js'],deliverables:[{id:'synthetic-delivery',description:'Synthetic required delivery',status:'pending' as const,requiredGates:['implementation','verification','packaging','supervision'] as Array<'implementation'|'verification'|'packaging'|'supervision'>,receipts:{},gaps:[]}]};
  const created=await api.createWorkflowRun({projectName:config.project.name,projectRootUri:cwd,projectProfile:'test',projectConfig:config,workflow,task:options.task??'Repair this bounded synthetic source function',autonomy:'2',policyProfile:'local',policySnapshot:config,policySnapshotHash:'0'.repeat(64),evaluationMetadata:{taskGrant:{sourceWritePaths:['src/main.js']}},...(options.structured?{acceptanceRequirements:requirements}:{})});
  const stageId=options.planning?'plan':'repair';
  const task=(await withClient(c=>c.query('select id::text from workflow_tasks where run_id=$1 and stage_id=$2',[created.runId,stageId]))).rows[0].id as string;
  const directory=path.join(cwd,'.agent-workflow/runtime',options.planning?'planning-notes':'repair-checkpoints');await fs.mkdir(directory,{recursive:true});
  const checkpoint=path.join(directory,'retained.json'),content={runId:created.runId,phase:'candidate',commit:git('rev-parse','HEAD'),receiptPath:checkpoint,validationReceipt:'.agent-workflow/runtime/run-environments/original.json',recipeHash:'b'.repeat(64),sourceHash:'c'.repeat(64),independentVerification:'pending'};
  await fs.writeFile(checkpoint,JSON.stringify(options.planning?{plan:['Inspect the bounded source']}:content));
  await withClient(async c=>{
   await c.query('begin');try{
   if(options.completed!==false){
    const artifact=options.planning?{summary:'Retained read-only planning observation',plan:['Inspect the bounded source'],actionResults:[]}:{summary:'Retained historical synthetic result',repairCheckpoint:content};
    const uri=`db://workflow_tasks/${task}/output`;
    await c.query("insert into artifacts(run_id,task_id,kind,uri,content)values($1,$2,'stage_output',$3,$4)",[created.runId,task,uri,JSON.stringify(artifact)]);
    await c.query("update workflow_tasks set status='completed',output_uri=$2,attempts=1,started_at=clock_timestamp(),finished_at=clock_timestamp()where id=$1",[task,uri]);
    await appendActionReceipt(c,{runId:created.runId,agentId:'implementation-agent',actionType:'stage_completed',target:task,summary:artifact.summary,metadata:JSON.stringify(artifact)});
    if(options.planWrites)await c.query("insert into artifacts(run_id,task_id,kind,uri,content)values($1,$2,'file_write',$3,$4)",[created.runId,task,`db://synthetic/${task}/write`,JSON.stringify({path:'src/main.js',nextHash:'e'.repeat(64)})]);
   }
   await c.query("update workflow_runs set status='blocked',finished_at=clock_timestamp()where id=$1",[created.runId]);
   await c.query('commit');}catch(error){await c.query('rollback');throw error;}
  });
  const snapshot=()=>withClient(async c=>({projects:(await c.query('select * from projects where id=$1',[created.projectId])).rows,runs:(await c.query('select * from workflow_runs where project_id=$1 order by id',[created.projectId])).rows,tasks:(await c.query('select * from workflow_tasks where run_id in(select id from workflow_runs where project_id=$1)order by id',[created.projectId])).rows,artifacts:(await c.query('select * from artifacts where run_id=$1 order by id',[created.runId])).rows,receipts:(await c.query('select * from action_receipts where run_id=$1 order by id',[created.runId])).rows}));
  return {...created,cwd,task,checkpoint,git,snapshot};
 };

 await t.test('explicit checkpoint resume rejects before recovery writes and retains source evidence',async()=>{
  const f=await create('explicit');const before=await f.snapshot(),bytes=await fs.readFile(f.checkpoint),head=f.git('rev-parse','HEAD');
  // Sequence changes survive rollback: this detects attempted writes, not only
  // a transaction that wrote recovery state and subsequently rolled it back.
  const suffix=randomUUID().replaceAll('-',''),sequence='recovery_write_'+suffix,fn='recovery_watch_'+suffix,trigger='recovery_watch_'+suffix;
  await withClient(async c=>{
   await c.query(`create sequence ${sequence}`);
   await c.query(`create function ${fn}()returns trigger language plpgsql as $$begin if TG_TABLE_NAME='projects' then if NEW.id='${f.projectId}'::uuid then perform nextval('${sequence}');end if;else if NEW.project_id='${f.projectId}'::uuid then perform nextval('${sequence}');end if;end if;return NEW;end$$`);
   await c.query(`create trigger ${trigger} before insert or update on projects for each row execute function ${fn}()`);
   await c.query(`create trigger ${trigger} before insert or update on workflow_runs for each row execute function ${fn}()`);
  });
  try{
   await assert.rejects(api.resumeWorkflowRunFromCheckpoint({runId:f.runId,actor:'synthetic',reason:'Explicit preserve request',includeFailed:true}),/prepared source checkpoint preservation is unsupported/iu);
   await withClient(async c=>assert.equal((await c.query(`select is_called from ${sequence}`)).rows[0].is_called,false,'No recovery write may be attempted before refusal'));
   assert.deepEqual(await f.snapshot(),before);assert.deepEqual(await fs.readFile(f.checkpoint),bytes);assert.equal(f.git('rev-parse','HEAD'),head);
  }finally{await withClient(async c=>{await c.query(`drop trigger ${trigger} on projects`);await c.query(`drop trigger ${trigger} on workflow_runs`);await c.query(`drop function ${fn}()`);await c.query(`drop sequence ${sequence}`);});}
 });

 await t.test('ordinary source-only retry queues a fresh full graph with diagnostic history only',async()=>{
  const f=await create('ordinary',{task:'Fix a bounded parser bug. No deployment/installation or device actions.'});const before=await f.snapshot(),bytes=await fs.readFile(f.checkpoint);
  assert.equal(await api.retryFailedWorkflowRun(f.runId),3);
  const state=await f.snapshot(),replacement=state.runs.find(r=>r.id!==f.runId);assert.ok(replacement);
  assert.equal(replacement.evaluation_metadata.recoveryMode.requestedMode,'checkpoint-preserving');assert.equal(replacement.evaluation_metadata.recoveryMode.effectiveMode,'fresh-full-graph');
  assert.equal(replacement.evaluation_metadata.recoveryMode.historicalCheckpoints,'diagnostic-only');assert.match(replacement.evaluation_metadata.recoveryMode.reason,/prepared source/iu);
  const tasks=state.tasks.filter(r=>r.run_id===replacement.id);assert.equal(tasks.length,3);assert.ok(tasks.every(r=>r.status==='queued'&&r.attempts===0&&!r.output_uri));
  await withClient(async c=>{
   assert.equal((await c.query("select count(*)::int n from artifacts where run_id=$1 and kind in('stage_output','repair_commit_candidate','repair_commit_verification','source_integration','run_preparation')",[replacement.id])).rows[0].n,0);
   const receipt=(await c.query("select metadata from action_receipts where run_id=$1 and action_type='workflow_replayed'",[replacement.id])).rows[0].metadata;
   assert.deepEqual(receipt.recoveryMode,replacement.evaluation_metadata.recoveryMode);assert.equal(receipt.preserveCompletedCheckpoints,false);
   const notification=(await c.query("select title,body from run_notifications where run_id=$1 and event_key=$2",[replacement.id,`replay:${f.runId}:${replacement.id}`])).rows[0];
   assert.equal(notification.title,'Fresh workflow replay queued');assert.match(notification.body,/^Fresh full-graph replay from run /u);
   const context=await api.loadStageContext(c,replacement.id);assert.equal(context.priorStageArtifacts.length,0);
  });
  assert.deepEqual(state.artifacts,before.artifacts);assert.deepEqual(state.receipts,before.receipts);assert.deepEqual(await fs.readFile(f.checkpoint),bytes);assert.equal(f.git('status','--porcelain'),'');
  assert.deepEqual(replacement.evaluation_metadata.taskGrant,before.runs[0].evaluation_metadata.taskGrant);
  const negative=await create('negative-install',{task:'Fix a bounded parser bug. Do not install.'});
  assert.equal(await api.retryFailedWorkflowRun(negative.runId),3);
 });

 await t.test('structured and physical recovery cannot silently convert a preservation request',async()=>{
  for(const [label,options]of [['structured',{structured:true}],['build',{task:'Build the synthetic application'}],['physical',{task:'Deploy the synthetic application to a physical device'}],['mixed-clause',{task:'Fix the parser. No deployment, but install the app.'}],['positive-next-clause',{task:'Fix the parser. No deployment. Install the app.'}]] as const){
   const f=await create(label,options);const before=await f.snapshot();
   await assert.rejects(api.retryFailedWorkflowRun(f.runId),/prepared source checkpoint preservation is unsupported/iu);
   assert.deepEqual(await f.snapshot(),before);
  }
  const f=await create('new-requirements');const before=await f.snapshot();
  await assert.rejects(api.replayWorkflowRun({sourceRunId:f.runId,actor:'synthetic',reason:'Explicit new acceptance enrollment',preserveCompletedCheckpoints:true,ordinarySourceRetry:true,acceptanceRequirements:{subjectHash:'d'.repeat(64),sourcePaths:['src/main.js'],deliverables:[]}}),/prepared source checkpoint preservation is unsupported/iu);
  assert.deepEqual(await f.snapshot(),before);
 });

 await t.test('a prepared source run with no completed checkpoint can resume without inheriting evidence',async()=>{
  const f=await create('no-prefix',{completed:false});const result=await api.resumeWorkflowRunFromCheckpoint({runId:f.runId,actor:'synthetic',reason:'Nothing completed to preserve',includeFailed:true});
  assert.equal(result.completedTasks,0);assert.equal(result.requeuedTasks,3);
 });

 await t.test('supported read-only checkpoint preservation remains available',async()=>{
  const f=await create('read-only',{readOnly:true});const result=await api.resumeWorkflowRunFromCheckpoint({runId:f.runId,actor:'synthetic',reason:'Preserve read-only observations',includeFailed:true});
  assert.equal(result.completedTasks,1);assert.equal(result.requeuedTasks,1);
  await withClient(async c=>{
   const notification=(await c.query('select title,body from run_notifications where run_id=$1 and event_key=$2',[result.replacementRunId,`replay:${f.runId}:${result.replacementRunId}`])).rows[0];
   assert.equal(notification.title,'Run resumed from checkpoint');assert.match(notification.body,/^Resumed from run /u);
  });
 });

 await t.test('attested planning-only prefixes remain usable but planner source effects do not',async()=>{
  const safe=await create('plan-only',{planning:true});const before=await safe.snapshot();
  const result=await api.resumeWorkflowRunFromCheckpoint({runId:safe.runId,actor:'synthetic',reason:'Retain read-only planning context',includeFailed:true});
  assert.equal(result.completedTasks,1);assert.equal(result.requeuedTasks,3);
  const after=await safe.snapshot();assert.deepEqual(after.artifacts,before.artifacts);assert.deepEqual(after.receipts,before.receipts);
  const unsafe=await create('plan-with-write',{planning:true,planWrites:true});const frozen=await unsafe.snapshot();
  await assert.rejects(api.resumeWorkflowRunFromCheckpoint({runId:unsafe.runId,actor:'synthetic',reason:'Do not reuse hidden writer output',includeFailed:true}),/prepared source checkpoint preservation is unsupported/iu);
  assert.deepEqual(await unsafe.snapshot(),frozen);
 });
});
