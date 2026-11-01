import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {projectConfigSchema} from '../../agent-registry/src/schemas.js';
import {acquireWorkIntent,releaseWorkIntent,withClient,type ClaimedWorkflowTask} from '../../storage/src/postgres.js';
import type {EnvironmentPlan} from '../../run-environments/src/index.js';
import type {RunPipelineContract} from '../../run-environments/src/pipeline.js';
import {artifactExecutionPolicy,defaultProfileVerificationCommands,prepareTaskExecution} from './run-preparation.js';

const contract:RunPipelineContract={version:1,required:true,sourceChanges:false,isolation:'project-artifacts',preparedOnly:false,checkpointStageIds:[],artifactPaths:['.agent-workflow/context.md']};
const project=projectConfigSchema.parse({project:{name:'Synthetic context maintenance'},actions:{allowed_write_paths:['.agent-workflow/**','docs/**'],allowed_commands:['node --test generic.test.js','node --test special.test.js']}});
const task=()=>({projectId:randomUUID(),runId:randomUUID(),taskId:randomUUID(),executionPipeline:contract}) as ClaimedWorkflowTask;

test('artifact policy intersects current permissions and rejects code, policy, escapes and command grants',()=>{
 const narrowed=artifactExecutionPolicy(project,contract);
 assert.deepEqual(narrowed.actions.allowed_write_paths,['.agent-workflow/context.md']);
 assert.deepEqual(narrowed.actions.allowed_commands,[]);
 const revoked={...project,actions:{...project.actions,allowed_write_paths:[]}};
 assert.deepEqual(artifactExecutionPolicy(project,contract,revoked).actions.allowed_write_paths,[]);
 for(const relative of ['source.ts','.agent-workflow/project.yaml','../context.md','docs/arbitrary.md'])assert.throws(()=>artifactExecutionPolicy(project,{...contract,artifactPaths:[relative]}),/Invalid/);
 assert.throws(()=>artifactExecutionPolicy(project,{...contract,isolation:'read-only'}),/Expected/);
});

test('artifact writes require the exact task grant, current lease, physical paths and their own live fence',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'artifact-preparation-'))),input=task();
 let lease=true;
 const prepared=await prepareTaskExecution(input,root,project,async()=>{if(!lease)throw Error('Lost task lease');});
 try{
  assert.equal(prepared.root,root);assert.equal(prepared.workspace,undefined);assert.deepEqual(prepared.commands,[]);
  await prepared.beforeWrite('.agent-workflow/context.md');
  await assert.rejects(prepared.beforeWrite('.agent-workflow/project.yaml'),/not allowed/);
  const other=await fs.mkdtemp(path.join(os.tmpdir(),'artifact-alias-'));
  try{await fs.symlink(other,path.join(root,'.agent-workflow'));await assert.rejects(prepared.beforeWrite('.agent-workflow/context.md'),/alias/);}
  finally{await fs.unlink(path.join(root,'.agent-workflow'));await fs.rm(other,{recursive:true});}
  lease=false;await assert.rejects(prepared.beforeWrite('.agent-workflow/context.md'),/Lost task lease/);lease=true;
  await withClient(c=>c.query('update work_intents set fencing_token=fencing_token+1 where project_id=$1',[input.projectId]));
  await assert.rejects(prepared.beforeWrite('.agent-workflow/context.md'),/not current/);
 }finally{
  await prepared.release();
  // A stale release must preserve a new owner's fence; only this synthetic fixture is removed.
  const count=await withClient(async c=>(await c.query('delete from work_intents where project_id=$1 returning id',[input.projectId])).rowCount);
  assert.equal(count,1);await fs.rm(root,{recursive:true});
 }
});

test('empty artifact task grants create no authority; conflicting owners block; release removes only the owned fence',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'artifact-intent-'))),input=task();
 try{
  const empty=await prepareTaskExecution({...input,executionWritePaths:[]},root,project,async()=>{});
  try{await assert.rejects(empty.beforeWrite('.agent-workflow/context.md'),/exact task grant/);
   assert.equal(await withClient(async c=>(await c.query('select 1 from work_intents where project_id=$1',[input.projectId])).rowCount),0);
  }finally{await empty.release();}
  const other=await acquireWorkIntent({projectId:input.projectId!,owner:'synthetic-conflict',objective:'Hold exact context',fileScopes:contract.artifactPaths});
  try{await assert.rejects(prepareTaskExecution(input,root,project,async()=>{}),/conflicts/);}
  finally{await releaseWorkIntent(other);}
  const prepared=await prepareTaskExecution(input,root,project,async()=>{});await prepared.release();
  assert.equal(await withClient(async c=>(await c.query('select 1 from work_intents where project_id=$1',[input.projectId])).rowCount),0);
  await assert.rejects(prepared.beforeWrite('.agent-workflow/context.md'),/ownership was lost/);
  await assert.rejects(prepareTaskExecution(input,root,project,async()=>{throw Error('No lease');}),/No lease/);
 }finally{await fs.rm(root,{recursive:true});}
});

test('default test selection never inherits unrelated specialized profile commands',()=>{
 const generic={profile:'generic',spec:{verification:[{commands:['node --test generic.test.js','node --test *.js']}]}} as EnvironmentPlan;
 const specialized={profile:'specialized',spec:{verification:[{commands:['node --test special.test.js']}]}} as EnvironmentPlan;
 const configured={...project,execution:{...project.execution,environments:{...project.execution.environments!,default_profile:'generic'}}};
 assert.deepEqual(defaultProfileVerificationCommands(configured,[specialized,generic]),['node --test generic.test.js']);
 assert.deepEqual(defaultProfileVerificationCommands(project,[generic,specialized]),[]);
 assert.deepEqual(defaultProfileVerificationCommands(project,[generic]),['node --test generic.test.js']);
 assert.deepEqual(defaultProfileVerificationCommands(configured,[specialized]),[]);
});
