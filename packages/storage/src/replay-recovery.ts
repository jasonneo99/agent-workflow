import type pg from 'pg';
import type {WorkflowDefinition} from '../../agent-registry/src/schemas.js';
import type {RunPipelineContract} from '../../run-environments/src/pipeline.js';
import type {NotificationIntent} from './run-notifications.js';
import {hasPinnedBuildIntent,workflowAcceptanceTask} from '../../model-providers/src/quality.js';
import {validateRecoveryCheckpoint} from './checkpoint-provenance.js';

export class UnsupportedPreparedCheckpointRecoveryError extends Error {
 constructor(){
  super('Prepared source checkpoint preservation is unsupported: the replacement cannot restore the original run-owned workspace and receipt bindings. Original checkpoints remain intact. Request an explicit fresh full-graph source replay with fresh verification instead.');
  this.name='UnsupportedPreparedCheckpointRecoveryError';
 }
}

export interface ReplayRecoveryMode {
 requestedMode:'checkpoint-preserving'|'fresh-full-graph';
 effectiveMode:'checkpoint-preserving'|'fresh-full-graph';
 reason:string;
 historicalCheckpoints:'diagnostic-only'|'preserved-stage-outputs';
 freshAcceptanceRequired:boolean;
}

export function replayRecoveryNotification(input:{runId:string;sourceRunId:string;reason:string;mode:ReplayRecoveryMode}):NotificationIntent {
 return {
  runId:input.runId,
  kind:'recovered',
  eventKey:`replay:${input.sourceRunId}:${input.runId}`,
  title:input.mode.effectiveMode==='fresh-full-graph'?'Fresh workflow replay queued':'Run resumed from checkpoint',
  body:`${input.mode.effectiveMode==='fresh-full-graph'?'Fresh full-graph replay from run':'Resumed from run'} ${input.sourceRunId}. ${input.reason}`
 };
}

function physicalRecoveryIntent(task:string):boolean {
 return workflowAcceptanceTask(task).split(/[.!?;\n]/u).some(clause=>{
  if(!hasPinnedBuildIntent(clause)&&!/\b(?:install(?:ation|ed)?|deploy(?:ment|ed)?|launch(?:ed)?|physical|device)\b/iu.test(clause))return false;
  const negative=clause.trim().match(/^(no|do not|never)\s+(.+)$/iu);
  if(!negative)return true;
  const terms=negative[1]!.toLowerCase()==='no'
   ? /\b(?:deployments?|installations?|launches|builds?|physical|devices?|native|actions?|operations?|acceptance|and|or|any)\b/giu
   : /\b(?:install|deploy|launch|build|the|an?|app|application|product|service|device|anything|and|or)\b/giu;
  // Strip only a complete, unambiguous exclusion list. A positive clause or
  // conjunction such as "but install" remains visible and fails closed.
  return !/^[\s,/&-]*$/u.test(negative[2]!.replace(terms,''));
 });
}

/** Read-only admission, before replacement reuse or any recovery write. This is
 * deliberately not a receipt copier: historical candidate paths are run-owned. */
export async function admitReplayRecovery(client:Pick<pg.Client,'query'>,input:{
 sourceRunId:string;task:string;evaluationMetadata:Record<string,unknown>;
 workflow:WorkflowDefinition|null;preserveCompletedCheckpoints?:boolean;
 ordinarySourceRetry?:boolean;acceptanceRequirements?:unknown;
}):Promise<{preserveCompletedCheckpoints:boolean;mode:ReplayRecoveryMode}>{
 const pipeline=input.evaluationMetadata.executionPipeline as RunPipelineContract|undefined;
 const preparedSource=pipeline?.required===true&&pipeline.sourceChanges===true&&pipeline.isolation==='worktree';
 // A conservative hold is preferable to treating physical/product delivery as
 // an ordinary source retry. Historical quotations are excluded by the shared
 // active-task parser; uncertain prose is not new source-only authority.
 const physicalIntent=physicalRecoveryIntent(input.task);
 const freshSourceRetry=input.ordinarySourceRetry===true&&preparedSource
  &&input.workflow?.execution?.kind==='source-change'
  &&!input.evaluationMetadata.acceptanceContract&&!input.acceptanceRequirements&&!physicalIntent;
 const requested=input.preserveCompletedCheckpoints===true;
 const preserve=requested&&!freshSourceRetry;
 if(preparedSource&&preserve){
  const completed=await client.query<{taskId:string;stageId:string;artifact:Record<string,unknown>|null;sourceEffects:boolean}>(`
   select t.id::text as "taskId",t.stage_id as "stageId",a.content as artifact,
    exists(select 1 from artifacts e where e.run_id=t.run_id and e.task_id=t.id
     and(e.kind in('file_write','command_output','repair_commit_candidate','repair_commit_verification','source_integration')
      or(e.kind='action_reuse' and e.content->>'actionType'='file_write'))) as "sourceEffects"
   from workflow_tasks t left join artifacts a on a.uri=t.output_uri and a.run_id=t.run_id and a.task_id=t.id and a.kind='stage_output'
   where t.run_id=$1::uuid and t.status='completed'`,[input.sourceRunId]);
  for(const checkpoint of completed.rows){
   const stage=input.workflow?.stages.find(stage=>stage.id===checkpoint.stageId),artifact=checkpoint.artifact;
   const actions=artifact?.actionResults;
   const purePlanning=stage&&['planner','single-shot'].includes(stage.pattern.type)&&!stage.runtime_operation
    &&artifact&&!checkpoint.sourceEffects&&!['repairCheckpoint','repairVerification','sourceIntegration','acceptanceContract','acceptanceDecision'].some(key=>artifact[key])
    &&(!artifact.verificationEvidence||(Array.isArray(artifact.verificationEvidence)&&artifact.verificationEvidence.length===0))
    &&(actions===undefined||(Array.isArray(actions)&&actions.every(action=>action&&['file_read','file_read_rejected','file_search','file_search_rejected'].includes(action.type))));
   if(!purePlanning)throw new UnsupportedPreparedCheckpointRecoveryError();
   await validateRecoveryCheckpoint(client,{runId:input.sourceRunId,taskId:checkpoint.taskId,stageId:checkpoint.stageId,artifact});
  }
 }
 return {preserveCompletedCheckpoints:preserve,mode:{
  requestedMode:requested?'checkpoint-preserving':'fresh-full-graph',
  effectiveMode:preserve?'checkpoint-preserving':'fresh-full-graph',
  reason:freshSourceRetry?'Ordinary source-only retry uses a fresh full graph because prepared source checkpoint bindings cannot be transferred; original checkpoints remain diagnostic history.':preserve?'Explicit checkpoint preservation requested.':'Explicit fresh full-graph replay requested.',
  historicalCheckpoints:preserve?'preserved-stage-outputs':'diagnostic-only',
  freshAcceptanceRequired:preparedSource||Boolean(input.evaluationMetadata.acceptanceContract)||Boolean(input.acceptanceRequirements)
 }};
}
