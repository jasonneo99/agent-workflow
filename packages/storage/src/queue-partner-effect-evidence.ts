import type {Client} from 'pg';
import {acceptanceDigest} from './acceptance.js';
import {captureRepairRevisionManifest,repairRevisionManifestHash,type RepairRevisionManifestEntry} from './repaired-revision.js';
import {quarantinedAssessmentOfflineCommands} from './quarantined-assessment.js';
import {exactPartnerPaths} from './queue-partner-reasoning.js';

export interface PartnerEffectObservation {
 action_type:string;target:string;metadata:Record<string,any>;receipt_hash:string;
 artifact_uri:string;artifact_kind:string;artifact_task_id:string;artifact_content:Record<string,any>;
 side_effect_key:string;side_effect_target:string;side_effect_operation:string;side_effect_status:string;side_effect_receipt:Record<string,any>;
}
export interface PartnerEffectReconciliation {
 digest:string;originalSubjectHash:string;currentSubjectHash:string;receiptHashes:string[];
 actionResults:Record<string,unknown>[];
}
/** Evidence only. Callers must independently authenticate the complete run chain,
 * project, original reservation, live intents, task leases and approval fences.
 * Only completed preimage-checked patches and literal offline tests qualify.
 */
export function reconcilePartnerEffectObservations(input:{taskId:string;stageId:string;root:string;paths:string[];
 originalSubjectHash:string;manifest:RepairRevisionManifestEntry[];observations:PartnerEffectObservation[];
 sideEffects:Array<{idempotency_key:string;status:string}>}):PartnerEffectReconciliation|null {
 const hash=/^[a-f0-9]{64}$/u;
 if(!exactPartnerPaths(input.paths)||!input.paths.length||!hash.test(input.originalSubjectHash)
  ||!input.observations.length||input.observations.length>20||input.sideEffects.length!==input.observations.length
  ||input.sideEffects.some(s=>s.status!=='completed')
  ||new Set(input.sideEffects.map(s=>s.idempotency_key)).size!==input.sideEffects.length
  ||acceptanceDigest(input.manifest.map(e=>e.path).sort())!==acceptanceDigest([...input.paths].sort()))return null;
 const keys=new Set<string>(),receipts=new Set<string>(),commands:string[]=[],results:Record<string,unknown>[]=[];
 for(const row of input.observations){
  const a=row.artifact_content,s=row.side_effect_receipt;
  if(!a||!s||!hash.test(row.receipt_hash)||receipts.has(row.receipt_hash)||!hash.test(a.idempotencyKey??'')||keys.has(a.idempotencyKey)
   ||!input.sideEffects.some(e=>e.idempotency_key===a.idempotencyKey)||row.side_effect_key!==a.idempotencyKey
   ||row.side_effect_status!=='completed'||s.artifactUri!==row.artifact_uri
   ||row.artifact_task_id!==input.taskId||a.requestedByTaskId!==input.taskId||a.requestedByStageId!==input.stageId
   ||acceptanceDigest(row.metadata)!==acceptanceDigest(a))return null;
  keys.add(a.idempotencyKey);receipts.add(row.receipt_hash);
  if(row.action_type==='file_write'){
   if(row.artifact_kind!=='file_write'||row.side_effect_operation!=='file_write'||row.target!==a.relativePath
    ||row.side_effect_target!==row.target||s.path!==row.target||!input.paths.includes(row.target)
    ||a.mode!=='patch'||a.existed!==true||a.outcome!=='applied'||a.projectRoot!==input.root
    ||!hash.test(a.previousHash??'')||a.expectedHash!==a.previousHash||!hash.test(a.nextHash??'')||s.nextHash!==a.nextHash)return null;
   results.push({type:'file_write',path:row.target,previousHash:a.previousHash,nextHash:a.nextHash,artifactUri:row.artifact_uri,
    reconciledObservation:true,receiptHash:row.receipt_hash});
  }else if(row.action_type==='local_command'){
   if(row.artifact_kind!=='command_output'||row.side_effect_operation!=='local_command'||row.target!==a.commandLine
    ||row.side_effect_target!==row.target||a.cwd!==input.root||a.timedOut!==false||s.timedOut!==false
    ||a.exitCode!==0||s.exitCode!==0||a.signal!==null)return null;
   commands.push(row.target);
   // No invented source-before/after binding or fresh-execution claim.
   results.push({type:'local_command',commandLine:row.target,exitCode:a.exitCode,timedOut:a.timedOut,artifactUri:row.artifact_uri,
    reconciledObservation:true,historicalExecution:true,receiptHash:row.receipt_hash});
  }else return null;
 }
 if(commands.length&&!quarantinedAssessmentOfflineCommands([...new Set(commands)],input.paths))return null;
 const manifest=input.manifest.map(({path,mode,hash})=>({path,mode,hash})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const before=manifest.map(e=>({...e}));
 for(const row of [...input.observations].reverse())if(row.action_type==='file_write'){
  const entry=before.find(e=>e.path===row.target);
  if(!entry||entry.hash!==row.artifact_content.nextHash)return null;
  entry.hash=row.artifact_content.previousHash;
 }
 if(repairRevisionManifestHash(before)!==input.originalSubjectHash)return null;
 const currentSubjectHash=repairRevisionManifestHash(manifest),receiptHashes=[...receipts];
 return {digest:acceptanceDigest({version:1,taskId:input.taskId,originalSubjectHash:input.originalSubjectHash,currentSubjectHash,receiptHashes,
  effects:results}),originalSubjectHash:input.originalSubjectHash,currentSubjectHash,receiptHashes,actionResults:results};
}

export async function loadPartnerEffectReconciliationOnClient(c:Client,input:{childRunId:string;taskId:string;root:string;paths:string[];originalSubjectHash:string}){
 const task=(await c.query('select stage_id from workflow_tasks where id=$1 and run_id=$2',[input.taskId,input.childRunId])).rows[0];
 if(!task?.stage_id)return null;
 const effects=(await c.query(`select r.action_type,r.target,r.metadata,r.receipt_hash,a.uri artifact_uri,a.kind artifact_kind,
  a.task_id::text artifact_task_id,a.content artifact_content,s.idempotency_key side_effect_key,s.target side_effect_target,
  s.operation side_effect_operation,s.status side_effect_status,s.receipt side_effect_receipt
  from action_receipts r left join artifacts a on a.run_id=r.run_id and a.content=r.metadata
   and a.kind=case when r.action_type='file_write' then 'file_write' else 'command_output' end
  left join side_effect_receipts s on s.project_id=r.run_id::text and s.idempotency_key=a.content->>'idempotencyKey'
  where r.run_id=$1 and r.action_type in ('file_write','local_command') order by r.created_at,r.id limit 21`,[input.childRunId])).rows;
 const sideEffects=(await c.query(`select idempotency_key,status from side_effect_receipts where project_id=$1 order by idempotency_key limit 21 for share`,[input.childRunId])).rows;
 if(Buffer.byteLength(JSON.stringify(effects),'utf8')>4_000_000)return null;
 return reconcilePartnerEffectObservations({...input,stageId:task.stage_id,manifest:await captureRepairRevisionManifest(input.root,input.paths),observations:effects,sideEffects});
}

/** A new checkpoint observation, not a historical preimage or a budget reset.
 * The caller archives the complete prior checkpoint before replacing its live
 * projection; original snapshots and saved action results remain auditable.
 */
export function checkpointWithReconciledPartnerEffects(checkpoint:Record<string,any>,proof:PartnerEffectReconciliation):Record<string,unknown>|null {
 if(!Number.isInteger(checkpoint.round)||checkpoint.round<1||checkpoint.round>3||!Array.isArray(checkpoint.actionResults)
  ||checkpoint.actionResults.length>150||Buffer.byteLength(JSON.stringify(checkpoint),'utf8')>4_000_000)return null;
 const existing=new Set(checkpoint.actionResults.map((r:any)=>r?.artifactUri).filter(Boolean));
 const added=proof.actionResults.filter(r=>!existing.has(r.artifactUri));
 return {...checkpoint,actionResults:[...checkpoint.actionResults,...added],fileReads:[],stateDeltas:[],
  priorReceipts:[...(Array.isArray(checkpoint.priorReceipts)?checkpoint.priorReceipts:[]),{
   agentId:'workflow-orchestrator',actionType:'queue_partner_effects_reconciled',
   summary:`Prior finalized effects were reconciled under a fresh owner, not executed again. Read current source before selecting further work. Historical tests have no invented source binding. This is not original acceptance. Evidence digest: ${proof.digest}`
  }].slice(-40),effectReconciliation:{version:1,digest:proof.digest,currentSubjectHash:proof.currentSubjectHash,
   originalSubjectHash:proof.originalSubjectHash,receiptHashes:proof.receiptHashes,roundUnchanged:true,acceptance:'unverified'}};
}
