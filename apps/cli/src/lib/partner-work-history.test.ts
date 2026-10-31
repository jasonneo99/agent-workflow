import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { databaseUrl } from '../../../../packages/storage/src/postgres.js';
import { buildPartnerWorkHistory, parseWorkCursor, projectWorkStep, readPartnerWorkSnapshot, type WorkHistoryRow } from './partner-work-history.js';

const projectId=randomUUID(),runId=randomUUID();
const row=(patch:Partial<WorkHistoryRow>={}):WorkHistoryRow=>({id:randomUUID(),runId,at:'2026-01-01T00:00:00.123456Z',agent:'test-engineer',action:'local_command',target:'npm test',summary:'Synthetic result',metadata:{exitCode:0},...patch});

test('history projects observed actions without turning starts, reused results or decisions into acceptance',()=>{
  assert.equal(projectWorkStep(row({action:'execution_progress',metadata:{operation:'command'}}),runId)?.state,'started');
  assert.equal(projectWorkStep(row({metadata:{}}),runId)?.state,'recorded');
  assert.equal(projectWorkStep(row({metadata:{exitCode:0,timedOut:true}}),runId)?.state,'failed');
  assert.match(projectWorkStep(row({action:'local_command_reused'}),runId)!.title,/Reused recorded/);
  const decision=projectWorkStep(row({action:'action_approval_executed'}),runId)!;
  assert.equal(decision.state,'recorded');assert.match(decision.detail,/separate from acceptance/);
  assert.equal(projectWorkStep(row({runId:randomUUID()}),runId),null);
  assert.equal(projectWorkStep(row({action:'unrelated_private_action'}),runId),null);
});

test('projection excludes payloads and scrubs command credentials, paths and private filenames',()=>{
  const step=projectWorkStep(row({target:'check --token=synthetic-secret',summary:'Bearer synthetic-bearer',metadata:{exitCode:1,stdout:'RAW_OUTPUT_SENTINEL',payload:{token:'PAYLOAD_SENTINEL'}}}),runId)!;
  assert.doesNotMatch(JSON.stringify(step),/synthetic-secret|synthetic-bearer|RAW_OUTPUT|PAYLOAD/);
  for(const target of ['.env.local','secrets/key.pem','../outside','/private/work/file']) assert.match(projectWorkStep(row({action:'file_read',target}),runId)!.title,/a project file/);
});

test('cursor preserves microseconds and rejects ambiguous or malformed pagination',async()=>{
  const cursor='2026-01-01T00:00:00.123456Z|'+randomUUID();assert.equal(parseWorkCursor(cursor)![0],'2026-01-01T00:00:00.123456Z');
  for(const value of ['bad','2026-01-01|'+randomUUID(),cursor+'|extra'])assert.throws(()=>parseWorkCursor(value));
  await assert.rejects(buildPartnerWorkHistory({projectId,runId,after:cursor,before:cursor}),/exact project/);
});

test('active display requires an unexpired owned worker lease and a live run',async()=>{
  const now=Date.now(), task={id:randomUUID(),agent:'frontend-engineer',stage:'implement',status:'running',worker:'owned-worker',lease:new Date(now+10000).toISOString(),startedAt:new Date(now-10000).toISOString()};
  const snapshot={run:{id:runId,projectId,title:'Synthetic task',status:'running'},rows:[row()],tasks:[task,{...task,id:randomUUID(),worker:null},{...task,id:randomUUID(),lease:new Date(now-1).toISOString()}]};
  const adapter={snapshot:async()=>snapshot};const report=(await buildPartnerWorkHistory({projectId,runId},adapter,now))!;assert.equal(report.active.length,1);
  snapshot.run.status='completed';assert.equal((await buildPartnerWorkHistory({projectId,runId},adapter,now))!.active.length,0);
  snapshot.run.projectId=randomUUID();assert.equal(await buildPartnerWorkHistory({projectId,runId},adapter,now),null);
});

test('real storage paginates equal-time receipts without duplicates or cross-project reads and performs no writes',async()=>{
  const client=new pg.Client({connectionString:databaseUrl()});await client.connect();
  try{
    await client.query('set search_path to pg_temp');
    await client.query('create temporary table workflow_runs(id uuid,project_id uuid,task text,status text)');
    await client.query('create temporary table action_receipts(id uuid,run_id uuid,created_at timestamptz,agent_id text,action_type text,target text,summary text,metadata jsonb)');
    await client.query('create temporary table workflow_tasks(id uuid,run_id uuid,agent_id text,stage_id text,status text,worker_id text,lease_expires_at timestamptz,started_at timestamptz)');
    const foreign=randomUUID();await client.query("insert into workflow_runs values($1,$2,'Synthetic task','running'),($3,$4,'Foreign sentinel','running')",[runId,projectId,foreign,randomUUID()]);
    await client.query("insert into action_receipts select gen_random_uuid(),$1,'2026-01-01T00:00:00.123456Z','test-engineer','local_command','npm test','Recorded check','{\"exitCode\":0,\"stdout\":\"PRIVATE_OUTPUT_SENTINEL\"}' from generate_series(1,165)",[runId]);
    await client.query("insert into action_receipts values(gen_random_uuid(),$1,now(),'private-agent','local_command','FOREIGN_SENTINEL','Private summary','{}')",[foreign]);
    const adapter={snapshot:(input:Parameters<typeof readPartnerWorkSnapshot>[1])=>readPartnerWorkSnapshot(client,input)};
    const first=(await buildPartnerWorkHistory({projectId,runId},adapter))!;assert.equal(first.steps.length,80);assert.equal(first.hasOlder,true);assert.match(first.before!,/\.123456Z\|/);
    const older=(await buildPartnerWorkHistory({projectId,runId,before:first.before!},adapter))!,last=(await buildPartnerWorkHistory({projectId,runId,before:older.before!},adapter))!;
    assert.equal(new Set([...first.steps,...older.steps,...last.steps].map(x=>x.id)).size,165);
    assert.equal(last.steps.length,5);assert.equal(last.hasOlder,false);
    const forward=(await buildPartnerWorkHistory({projectId,runId,after:last.after!},adapter))!;assert.equal(forward.steps.length,80);assert.equal(forward.hasMore,true);
    assert.equal(await buildPartnerWorkHistory({projectId,runId:foreign},adapter),null);
    assert.doesNotMatch(JSON.stringify([first,older,last]),/PRIVATE_OUTPUT_SENTINEL|FOREIGN_SENTINEL/);
    assert.equal((await client.query('select count(*)::int n from action_receipts')).rows[0].n,166);
    // Production stage-start receipts are emitted by the orchestrator with a
    // task reference. Resolve the recorded specialist without reading a payload.
    const taskId=randomUUID();await client.query("insert into workflow_tasks values($1,$2,'frontend-engineer','implement','running','synthetic-worker',now()+interval '1 minute',now())",[taskId,runId]);
    await client.query("insert into action_receipts values(gen_random_uuid(),$1,now(),'workflow-orchestrator','stage_started',$2,'Leased worker started stage execution.',$3)",[runId,taskId,JSON.stringify({taskId,fencingToken:'MUST_NOT_SURFACE'})]);
    const started=(await buildPartnerWorkHistory({projectId,runId,after:first.after!},adapter))!;
    assert.equal(started.steps.length,1);assert.equal(started.steps[0].agent,'frontend-engineer');assert.equal(started.steps[0].stage,'implement');assert.doesNotMatch(JSON.stringify(started),/MUST_NOT_SURFACE/);
  }finally{await client.end();}
});
