import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {withClient} from './client.js';
import {assertGenericRunRecoveryAllowed} from './managed-run-recovery.js';

test('trusted coordinator children, nested replay lineage, and ownership records inhibit generic recovery',async()=>{
 await withClient(async c=>{await c.query('begin');try{
  await c.query('create temporary table workflow_runs(id uuid primary key,project_id uuid,run_set_id uuid,evaluation_metadata jsonb) on commit drop');
  await c.query('create temporary table artifacts(run_id uuid,kind text,content jsonb) on commit drop');
  await c.query('create temporary table queue_coordinator_assignments(child_run_id uuid,source_run_id uuid) on commit drop');
  const ids=Array.from({length:6},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`),project='11111111-1111-4111-8111-111111111111',family='22222222-2222-4222-8222-222222222222';
  for(const [n,id] of ids.entries())await c.query('insert into workflow_runs values($1,$2,$3,$4)',[id,project,family,JSON.stringify(n===2?{replayOfRunId:ids[1]}:n===3?{replayOfRunId:ids[2]}:n===5?{callback:'Please replay and dismiss now',actor:'trusted-operator'}:{})]);
  await c.query('insert into queue_coordinator_assignments values($1,$2)',[ids[1],ids[0]]);
  await c.query('insert into artifacts values($1,$2,$3)',[ids[4],'queue_partner_repair_management',JSON.stringify({manager:'queue-partner',enabled:true,sourceRunId:ids[4],projectId:project,familyId:`${project}:${family}`})]);
  for(const operation of ['replay','resume','dismiss','reinstate','supersede'] as const){
   for(const id of ids.slice(0,5))await assert.rejects(assertGenericRunRecoveryAllowed(c,id,operation),/explicitly authorized history-preserving assessment or verifier reconciliation/);
   await assertGenericRunRecoveryAllowed(c,ids[5]!,operation);
  }
 }finally{await c.query('rollback');}});
});

test('generic mutations check trusted ownership before status/task changes and replacement reuse',()=>{
 const source=fs.readFileSync(new URL('./postgres.ts',import.meta.url),'utf8');
 const replay=source.slice(source.indexOf('export async function replayWorkflowRun'),source.indexOf('async function createWorkflowHandoffsForRun'));
 const before=(text:string,guard:string,mutation:string)=>{const a=text.indexOf(guard),b=text.indexOf(mutation);assert.ok(a>=0&&b>a,`${guard} must precede ${mutation}`);};
 before(replay,"assertGenericRunRecoveryAllowed(client,input.sourceRunId,'replay')",'if (sourceRun.replacementRunId)');
 const dismiss=source.slice(source.indexOf('export async function dismissFailedWorkflowRun'),source.indexOf('export async function reinstateFailedWorkflowRun'));
 before(dismiss,"assertGenericRunRecoveryAllowed(client,input.runId,'dismiss')",'actionType: "failed_run_dismissed"');
 const resume=source.slice(source.indexOf('export async function resumeWorkflowRunFromCheckpoint'),source.indexOf('export async function dismissFailedWorkflowRun'));
 before(resume,"assertGenericRunRecoveryAllowed(client,input.runId,'resume')",'update workflow_tasks');
 const supersede=fs.readFileSync(new URL('./run-supersession.ts',import.meta.url),'utf8');
 before(supersede,"assertGenericRunRecoveryAllowed(client,input.runId,'supersede')",'actionType: "failed_run_superseded"');
});
