import type { Client } from 'pg';
import { withClient } from './client.js';
import { acceptanceDigest } from './acceptance.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runProcess} from '../../run-environments/src/index.js';
import type {RunPipelineContract} from '../../run-environments/src/pipeline.js';
import type {RunWorkspace} from '../../run-environments/src/workspace.js';
import {loadProjectConfig} from '../../agent-registry/src/loaders.js';
import {captureRepairRevisionManifest} from './repaired-revision.js';
import {appendActionReceipt} from './receipt-writer.js';

export interface ReprocessPreparation {
 version:1;originalRunId:string;familyId:string;canonicalProjectId:string;sourcePaths:string[];
 sourceHash:string;policyHash:string;planHash:string;authority:{kind:'direct-human';instruction:string;threadId:string};
 originalAcceptanceChanged:false;
}
/** Starting prepared work is a separate fenced step. Generic resume cannot
 * clear preparedOnly, and no consumed historical action authority is copied. */
export async function activatePreparedWorkflowRun(input:{runId:string;planHash:string;owner:string;fencingToken:string}){
 return withClient(async c=>{await c.query('begin');try{
  const row=(await c.query(`select r.project_id::text as project_id,r.evaluation_metadata,p.root_uri from workflow_runs r join projects p on p.id=r.project_id where r.id=$1 for update of r`,[input.runId])).rows[0];
  const contract=row?.evaluation_metadata?.executionPipeline as RunPipelineContract|undefined,preparation=row?.evaluation_metadata?.reprocessPreparation as ReprocessPreparation|undefined;
  if(!row||contract?.version!==1||!contract.required||!contract.preparedOnly||preparation?.version!==1||preparation.planHash!==input.planHash||preparation.canonicalProjectId!==row.project_id)throw Error('This exact prepared source plan is unavailable or already activated');
  if(preparation.authority.kind!=='direct-human'||!preparation.authority.instruction||!preparation.sourcePaths.length)throw Error('Prepared work needs its new source grant and exact current source scope');
  const intent=(await c.query('select file_scopes from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3 and expires_at>clock_timestamp() for update',[row.project_id,input.owner,input.fencingToken])).rows[0];
  if(!intent)throw Error('Prepared activation needs a current owning project intent');
  const {assertFilePathAllowed}=await import('../../local-tools/src/file-writer.js');
  const project=await loadProjectConfig(row.root_uri);
  for(const scope of preparation.sourcePaths)assertFilePathAllowed(scope,{...project,actions:{...project.actions,allowed_write_paths:intent.file_scopes}});
  if(acceptanceDigest(project)!==preparation.policyHash||acceptanceDigest(await captureRepairRevisionManifest(row.root_uri,preparation.sourcePaths))!==preparation.sourceHash)throw Error('Prepared source or policy changed; prepare a fresh reviewed plan instead of adopting drift');
  if((await c.query("select 1 from workflow_tasks where run_id=$1 and status<>'queued' limit 1",[input.runId])).rowCount)throw Error('Prepared tasks have already started; activation cannot replay an attempt');
  await c.query(`update workflow_runs set evaluation_metadata=jsonb_set(evaluation_metadata,'{executionPipeline,preparedOnly}','false'::jsonb) where id=$1`,[input.runId]);
  await c.query('update workflow_tasks set available_at=clock_timestamp() where run_id=$1',[input.runId]);
  await appendActionReceipt(c,{runId:input.runId,agentId:'workflow-orchestrator',actionType:'prepared_run_activated',target:input.planHash,summary:'Activated the exact current-source prepared run under its new grant; historical attempts and original acceptance are unchanged.',metadata:JSON.stringify({planHash:input.planHash,owner:input.owner,fencingToken:input.fencingToken,originalRunId:preparation.originalRunId,authority:preparation.authority})});
  await c.query('commit');return {runId:input.runId,activated:true};
 }catch(e){await c.query('rollback');throw e;}});
}

/** Approved actions and the command CLI resolve the same authenticated derived
 * checkout as the worker. A folder name alone never establishes ownership. */
export async function resolveRunExecutionRoot(input:{runId:string;canonicalRoot:string;requestedRoot?:string}){
 const canonicalRoot=await fs.realpath(input.canonicalRoot);
 const binding=await withClient(async c=>{
  const row=(await c.query(`select r.project_id::text as "projectId",p.root_uri as root,r.workflow_id as "workflowId",r.evaluation_metadata->'executionPipeline' as contract
   from workflow_runs r join projects p on p.id=r.project_id where r.id=$1`,[input.runId])).rows[0];
  if(!row||await fs.realpath(row.root)!==canonicalRoot)throw Error('Command/action run belongs to another owning project');
  const contract=row.contract as RunPipelineContract|undefined;
  if(!contract?.required)return {...row,contract,workspace:null};
  if(contract.version!==1||contract.preparedOnly)throw Error('Run is prepared but not activated, or needs a newer runtime');
  if(!contract.sourceChanges)return {...row,contract,workspace:null};
  const {verifyRunReceiptChainOnClient}=await import('./postgres.js');
  if(!(await verifyRunReceiptChainOnClient(c,input.runId)).valid)throw Error('Prepared run receipt chain is unavailable or broken');
  const proof=(await c.query(`select content->'workspace' as workspace from artifacts where run_id=$1 and kind='run_preparation' order by created_at desc,id desc limit 1`,[input.runId])).rows[0];
  if(!proof?.workspace)throw Error('Start the required worker preparation before executing this run action');
  return {...row,contract,workspace:proof.workspace as RunWorkspace};
 });
 let root=canonicalRoot;
 if(binding.workspace){
  const workspace=binding.workspace,receipt=path.join(canonicalRoot,'.agent-workflow/runtime/run-workspaces',input.runId,'workspace.json');
  const stat=await fs.lstat(receipt);
  if(!stat.isFile()||stat.size>2_000_000||await fs.realpath(receipt)!==receipt||acceptanceDigest(JSON.parse(await fs.readFile(receipt,'utf8')))!==acceptanceDigest(workspace))throw Error('Workspace receipt does not match its owning run evidence');
  if(workspace.runId!==input.runId||workspace.canonicalRoot!==canonicalRoot||await fs.realpath(workspace.root)!==workspace.root)throw Error('Prepared workspace identity changed');
  const git=async(cwd:string,args:string[])=>{const r=await runProcess(['git',...args],{cwd,timeoutMs:30000,maxOutputChars:20000});if(r.exitCode!==0||r.timedOut||r.outputTruncated)throw Error('Prepared workspace Git identity is unavailable');return r.stdout.trim();};
  if(await git(canonicalRoot,['rev-parse','--path-format=absolute','--git-common-dir'])!==workspace.commonDirectory
   ||await git(workspace.root,['rev-parse','--path-format=absolute','--git-common-dir'])!==workspace.commonDirectory
   ||await git(workspace.root,['symbolic-ref','--short','HEAD'])!==workspace.branch)throw Error('Prepared workspace no longer belongs to its canonical Git identity');
  await git(workspace.root,['merge-base','--is-ancestor',workspace.baselineCommit,'HEAD']);root=workspace.root;
 }
 if(input.requestedRoot){
  if(input.requestedRoot!==root&&input.requestedRoot!==canonicalRoot)throw Error('Approved action root differs from the authenticated prepared checkout');
  // Canonical writes are a separate, exact integration approval.
  root=input.requestedRoot;
 }
 return {root,canonicalRoot,projectId:binding.projectId as string,workflowId:binding.workflowId as string,contract:binding.contract as RunPipelineContract|undefined,workspace:binding.workspace as RunWorkspace|null};
}

/** Installation policy is separate from project action authority. Requiring a
 * prepared runtime grants no command, source-write, replay or acceptance right. */
export const runPipelineSchemaSql = `
create table if not exists run_pipeline_settings (
 id integer primary key check(id=1), required boolean not null default false,
 version integer not null check(version=1), authority jsonb not null,
 updated_at timestamptz not null default clock_timestamp()
);
create or replace function agentflow_prepared_run_fence() returns trigger language plpgsql as $f$
begin
 if coalesce((select required from run_pipeline_settings where id=1),false) then
  if NEW.evaluation_metadata#>>'{executionPipeline,version}' is distinct from '1'
   or NEW.evaluation_metadata#>>'{executionPipeline,required}' is distinct from 'true' then
   raise exception 'This installation requires prepared execution pipeline v1; upgrade this client before creating work.';
  end if;
 end if;
 return NEW;
end $f$;
drop trigger if exists agentflow_prepared_run_insert on workflow_runs;
create trigger agentflow_prepared_run_insert before insert on workflow_runs for each row execute function agentflow_prepared_run_fence();
create or replace function agentflow_prepared_worker_fence() returns trigger language plpgsql as $f$
begin
 if NEW.status in ('leased','running') and NEW.status is distinct from OLD.status
  and (coalesce((select required from run_pipeline_settings where id=1),false)
   or exists(select 1 from workflow_runs r where r.id=NEW.run_id and r.evaluation_metadata#>>'{executionPipeline,required}'='true')) then
  if current_setting('agentflow.execution_pipeline',true) is distinct from '1'
   or not exists(select 1 from workflow_runs r where r.id=NEW.run_id and r.evaluation_metadata#>>'{executionPipeline,required}'='true' and r.evaluation_metadata#>>'{executionPipeline,version}'='1' and coalesce(r.evaluation_metadata#>>'{executionPipeline,preparedOnly}','false')='false') then
   raise exception 'This run requires a prepared execution pipeline v1 worker; legacy runs must be reprocessed and legacy workers cannot claim it.';
  end if;
 end if;
 return NEW;
end $f$;
drop trigger if exists agentflow_prepared_worker_claim on workflow_tasks;
create trigger agentflow_prepared_worker_claim before update of status on workflow_tasks for each row execute function agentflow_prepared_worker_fence();`;

export async function installationRequiresRunPipeline(c: Client): Promise<boolean> {
  if (!(await c.query("select to_regclass('run_pipeline_settings') is not null present")).rows[0]?.present) return false;
  return (await c.query('select required from run_pipeline_settings where id=1')).rows[0]?.required === true;
}
export async function requirePreparedRunPipeline(input: {projectId:string;owner:string;fencingToken:string;authority:Record<string,unknown>}) {
  if(input.authority.kind!=='direct-human'||typeof input.authority.instruction!=='string'||!input.authority.instruction.trim())throw Error('Direct human rollout authority is required');
  return withClient(async c=>{await c.query('begin');try{
    if(!(await c.query('select 1 from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3 and expires_at>clock_timestamp() for update',[input.projectId,input.owner,input.fencingToken])).rowCount)throw Error('Rollout intent is not current');
    await c.query(runPipelineSchemaSql);
    const authority={...input.authority,digest:acceptanceDigest(input.authority)};
    await c.query(`insert into run_pipeline_settings(id,required,version,authority) values(1,true,1,$1)
      on conflict(id) do update set required=true,version=1,authority=excluded.authority,updated_at=clock_timestamp()`,[JSON.stringify(authority)]);
    await c.query('commit');return {required:true,version:1,authorityDigest:authority.digest};
  }catch(e){await c.query('rollback');throw e;}});
}
