import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {databaseUrl,loadStageContext} from './postgres.js';
import {acceptanceDigest,storedAcceptanceDecision} from './acceptance.js';

test('real stage context refreshes superseded references without rewriting outputs or accepting newer failures',async()=>{
 const c=new pg.Client({connectionString:databaseUrl()});await c.connect();
 try{
  await c.query('set search_path to pg_temp');
  await c.query('create temporary table workflow_runs(id uuid,project_id uuid,task text,evaluation_metadata jsonb)');
  await c.query('create temporary table workflow_tasks(id uuid,run_id uuid,stage_id text,agent_id text,status text,finished_at timestamptz)');
  await c.query('create temporary table artifacts(id uuid default gen_random_uuid(),run_id uuid,task_id uuid,kind text,uri text,content jsonb,created_at timestamptz)');
  await c.query('create temporary table action_receipts(run_id uuid,agent_id text,action_type text,target text,summary text,metadata jsonb,metadata_serialization_version int,created_at timestamptz)');
  const run=randomUUID(),project=randomUUID(),task=randomUUID(),laterTask=randomUUID(),subject='a'.repeat(64),paths=['src/feature.ts'];
  const frozen:any={version:1,contractId:'acceptance:'+run,projectId:project,originRunId:run,taskHash:acceptanceDigest('synthetic task'),subjectHash:subject,sourcePaths:paths,
   deliverables:[{id:'feature',description:'Exact original feature',requiredGates:['implementation'],status:'pending',receipts:{},gaps:[]}]};
  await c.query('insert into workflow_runs values($1,$2,$3,$4)',[run,project,'synthetic task',JSON.stringify({acceptanceContract:frozen})]);
  await c.query("insert into workflow_tasks values($1,$2,'implementation','test-engineer','completed','2026-01-01T00:00:02Z'),($3,$2,'verification','test-engineer','completed','2026-01-01T00:00:04Z')",[task,run,laterTask]);
  const add=async(id:string,when:string,exitCode:number,owner:string)=>{
   const uri=`db://workflow_runs/${run}/command_output/${id}`,content={commandLine:'npm test',exitCode,timedOut:false,sourcePaths:paths,sourceBefore:subject,sourceAfter:subject,subjectHash:subject};
   await c.query("insert into artifacts(run_id,task_id,kind,uri,content,created_at) values($1,$2,'command_output',$3,$4,$5)",[run,owner,uri,JSON.stringify(content),when]);
   await c.query("insert into action_receipts values($1,'test-engineer','local_command','npm test','Executed',$2,2,$3)",[run,JSON.stringify(content),when]);
   return {artifactUri:uri,runId:run,taskId:owner,stageId:owner===task?'implementation':'verification',kind:'command_output',contentHash:acceptanceDigest(content),observedAt:when,subjectHash:subject};
  };
  const old=await add('old','2026-01-01T00:00:01.000Z',0,task);
  const proposal={...frozen,deliverables:[{...frozen.deliverables[0],status:'verified',receipts:{implementation:[old]}}]};
  await c.query("insert into artifacts(run_id,task_id,kind,uri,content,created_at) values($1,$2,'stage_output',$3,$4,'2026-01-01T00:00:02Z')",[run,task,'db://synthetic/stage',JSON.stringify({acceptanceContract:proposal})]);
  const newer=await add('new','2026-01-01T00:00:03.000Z',0,laterTask);
  assert.ok((await storedAcceptanceDecision(c,run,'implementation',{acceptanceContract:proposal})).reason,'Old reference remains rejected by strict resolver');
  const context=await loadStageContext(c,run),updated=context.priorStageArtifacts[0].artifact.acceptanceContract as any;
  assert.deepEqual(updated.deliverables[0].receipts.implementation,[newer]);
  assert.equal((await storedAcceptanceDecision(c,run,'implementation',{acceptanceContract:updated})).reason,null);
  const stored=(await c.query("select content from artifacts where uri='db://synthetic/stage'")).rows[0].content;
  assert.deepEqual(stored.acceptanceContract,proposal,'Stored historical output unchanged');
  await add('failed','2026-01-01T00:00:05.000Z',1,laterTask);
  const rejected=await loadStageContext(c,run),unchanged=rejected.priorStageArtifacts[0].artifact.acceptanceContract as any;
  assert.deepEqual(unchanged.deliverables[0].receipts.implementation,[old],'Newer failure must not be hidden behind an older success');
  assert.ok((await storedAcceptanceDecision(c,run,'implementation',{acceptanceContract:unchanged})).reason);
 }finally{await c.end();}
});
