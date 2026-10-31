import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import pg from 'pg';
import { databaseUrl, withClient } from './client.js';
import { queuePartnerDelegationEfficiency } from './queue-partner-delegation-metrics.js';
import { queuePartnerGuidePolicy } from './queue-partner-guide-policy.js';
import { queuePartnerExperimentReport } from './queue-partner-experiments.js';

const originalUrl=databaseUrl(), schema='partner_reporting_'+randomUUID().replaceAll('-','');
const setup=new pg.Client({connectionString:originalUrl});
const project=randomUUID(),otherProject=randomUUID(),source=randomUUID(),otherSource=randomUUID();
const direct=randomUUID(),specialist=randomUUID(),foreign=randomUUID();
let schemaCreated=false;

before(async()=>{
  // The normal test runner migrates a disposable database. Never seed the
  // configured runtime, even when this file is accidentally invoked directly.
  assert.match(new URL(originalUrl).pathname,/^\/agentflow_suite_test_[a-f0-9]{32}$/);
  await setup.connect();
  await setup.query(`create schema ${schema}`);schemaCreated=true;
  // Clone the migrated relations, including their actual columns and checks.
  // A hand-written mock with created_at would conceal the production defect.
  for(const table of ['workflow_runs','action_receipts','memory_nodes'])await setup.query(`create table ${schema}.${table} (like public.${table} including all)`);
  await setup.query(`set search_path to ${schema}`);
  const isolated=new URL(originalUrl);isolated.searchParams.set('options',`-c search_path=${schema}`);process.env.DATABASE_URL=isolated.href;
  await setup.query(`insert into workflow_runs(id,project_id,workflow_id,status,task,autonomy,started_at) values
    ($1,$2,'synthetic-repair','blocked','PRIVATE_SOURCE_SENTINEL','2','2026-10-30T12:00:00Z'),
    ($3,$4,'foreign-repair','blocked','FOREIGN_BODY_SENTINEL','2','2026-10-30T12:00:00Z')`,[source,project,otherSource,otherProject]);
  for(const [id,p,origin,worker,minute]of [[direct,project,source,null,1],[specialist,project,source,'backend-engineer',2],[foreign,otherProject,otherSource,'test-engineer',3]] as const){
    const metadata={source:'queue-partner-recovery',sourceRunId:origin,...(worker?{partnerWorkerTeam:{workerAgentId:worker}}:{})};
    await setup.query(`insert into workflow_runs(id,project_id,workflow_id,status,task,autonomy,started_at,finished_at,evaluation_metadata)
      values($1,$2,'synthetic-recovery','completed','PRIVATE_RECOVERY_SENTINEL','2',$3::timestamptz,$3::timestamptz+interval '2 minutes',$4)`,[id,p,`2026-10-30T12:0${minute}:00Z`,JSON.stringify(metadata)]);
    await setup.query(`insert into action_receipts(run_id,action_type,target,summary,metadata) values
      ($1,$2,'synthetic-guide','Synthetic observation','{}'),
      ($1,'queue_partner_experiment_exposure','synthetic-exposure','Synthetic observation',$3)`,[id,id===direct?'guide_baseline':'guide_intervention',JSON.stringify({assignments:[{arm:worker?'specialist':'partner-direct'},{arm:id===direct?'unguided':'guided'}]})]);
  }
});

after(async()=>{
  process.env.DATABASE_URL=originalUrl;
  if(schemaCreated)await setup.query(`drop schema ${schema} cascade`);
  await setup.end();
});

const counts=()=>withClient(async c=>(await c.query(`select (select count(*)::int from workflow_runs) runs,
  (select count(*)::int from action_receipts) receipts,(select count(*)::int from memory_nodes) memories`)).rows[0]);

test('report fixtures use the migrated run schema without an invented creation timestamp',async()=>{
  const columns=await withClient(async c=>(await c.query("select column_name from information_schema.columns where table_schema=current_schema() and table_name='workflow_runs'")).rows.map(r=>r.column_name));
  assert.ok(columns.includes('started_at'));assert.ok(!columns.includes('created_at'));
});

test('delegation metrics read actual run timestamps without equating completion with acceptance',async()=>{
  const before=await counts(),report=await queuePartnerDelegationEfficiency();
  assert.equal(report.totalSamples,3);assert.equal(report.baseline.samples,1);assert.equal(report.specialist.samples,2);
  assert.equal(report.diagnostics.latestObservedAt,'2026-10-30T12:03:00.000Z');
  assert.equal(report.baseline.accepted,0);assert.equal(report.specialist.accepted,0);assert.equal(report.routingDecision.applied,false);
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_|FOREIGN_BODY/);assert.deepEqual(await counts(),before);
});

test('Guide reporting executes on migrated timestamps and keeps foreign recovery cohorts out',async()=>{
  const before=await counts(),report=await queuePartnerGuidePolicy(project,source);
  assert.equal(report.guided.samples,1);assert.equal(report.unguided.samples,1);assert.equal(report.guided.averageDurationMs,120000);
  assert.equal(report.policy.mode,'canary');assert.equal(report.decision.authority,'routing-advisory-only');
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_|FOREIGN_BODY/);assert.deepEqual(await counts(),before);
});

test('factorial reporting executes on migrated timestamps with exact optional project scope',async()=>{
  const before=await counts(),scoped=await queuePartnerExperimentReport(project),global=await queuePartnerExperimentReport();
  assert.equal(scoped.cells.reduce((n,c)=>n+c.samples,0),2);assert.equal(global.cells.reduce((n,c)=>n+c.samples,0),3);
  assert.equal(scoped.createsRuns,false);assert.equal(scoped.changesQueueEligibility,false);assert.equal(scoped.decision.applied,false);
  assert.doesNotMatch(JSON.stringify(scoped),/PRIVATE_|FOREIGN_BODY/);assert.deepEqual(await counts(),before);
});
