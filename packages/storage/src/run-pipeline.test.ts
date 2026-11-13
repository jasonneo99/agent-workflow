import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withClient} from './client.js';
import {runPipelineSchemaSql,installationRequiresRunPipeline} from './run-pipeline.js';

test('installation fence rejects old client creation, old worker claims and generic resume of prepared work',async()=>{
 await withClient(async c=>{await c.query('begin');try{
  const schema='pipeline_'+randomUUID().replaceAll('-','');
  await c.query(`create schema ${schema};set local search_path to ${schema},public;
   create table workflow_runs(id uuid primary key,evaluation_metadata jsonb);
   create table workflow_tasks(id uuid primary key,run_id uuid,status text);`);
  await c.query(runPipelineSchemaSql);assert.equal(await installationRequiresRunPipeline(c),false);
  await c.query("insert into run_pipeline_settings values(1,true,1,'{}',clock_timestamp())");
  assert.equal(await installationRequiresRunPipeline(c),true);
  const denied=async(sql:string,values:unknown[])=>{await c.query('savepoint denied');await assert.rejects(c.query(sql,values),/requires.*prepared|requires prepared/);await c.query('rollback to savepoint denied');};
  const legacy=randomUUID(),run=randomUUID(),task=randomUUID();
  await denied("insert into workflow_runs values($1,'{}')",[legacy]);
  await c.query('insert into workflow_runs values($1,$2)',[run,JSON.stringify({executionPipeline:{version:1,required:true,preparedOnly:true}})]);
  await c.query("insert into workflow_tasks values($1,$2,'queued')",[task,run]);
  await denied("update workflow_tasks set status='leased' where id=$1",[task]);
  await c.query("set local agentflow.execution_pipeline='1'");
  await denied("update workflow_tasks set status='leased' where id=$1",[task]);
  await c.query(`update workflow_runs set evaluation_metadata=jsonb_set(evaluation_metadata,'{executionPipeline,preparedOnly}','false') where id=$1`,[run]);
  await c.query("update workflow_tasks set status='leased' where id=$1",[task]);
  assert.equal((await c.query('select status from workflow_tasks where id=$1',[task])).rows[0].status,'leased');
 }finally{await c.query('rollback');}});
});
