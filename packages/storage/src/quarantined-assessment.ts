import type {Client} from 'pg';
import {acceptanceDigest} from './acceptance.js';

export interface QuarantinedAssessmentContext {
 sourceRunId:string;priorRunId:string;projectId:string;assignmentId:string;priorFence:string;
 priorTask:string;priorStatus:string;subjectHash:string;originalContractDigest:string;
 provider:string;modelTier:string;
}
export function quarantinedAssessmentOfflineCommands(value:unknown,sourcePaths:readonly string[]):string[]|null{
 if(!Array.isArray(value)||!value.length||value.length>20||new Set(value).size!==value.length)return null;
 let focused=false;
 for(const command of value){
  if(typeof command!=='string')return null;
  if(command==='git diff --check')continue;
  const module=/^python3 -m unittest (tests\.[A-Za-z0-9_]+)(?: -v)?$/u.exec(command);
  const discovery=/^python3 -m unittest discover -s tests -p (test_[A-Za-z0-9_]+\.py)(?: -k [A-Za-z_][A-Za-z0-9_.]*)?(?: -v)?$/u.exec(command);
  const file=module?`${module[1]!.replaceAll('.','/')}.py`:discovery?`tests/${discovery[1]}`:null;
  if(!file||!sourcePaths.includes(file))return null;
  focused=true;
 }
 return focused?[...value]:null;
}
/** Narrow evidence preflight, not execution authority. Its caller must separately
 * validate the exact direct-human assessment authorization and full chains.
 * Queued clones and cancelled predecessors remain unchanged forever.
 */
export async function validateQuarantinedAssessmentOnClient(c:Pick<Client,'query'>,context:QuarantinedAssessmentContext,proof:any):Promise<string[]|null>{
 const hash=/^[a-f0-9]{64}$/u,uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
 if(context.priorStatus!=='cancelled'||proof?.version!==1||proof.mode!=='cancelled-predecessor-readonly-assessment'
  ||proof.priorRunId!==context.priorRunId||proof.assignmentId!==context.assignmentId||proof.priorFence!==context.priorFence
  ||!hash.test(proof.blockedReceiptHash??'')||!hash.test(proof.dismissalReceiptHash??'')
  ||typeof proof.recoveredEvidenceUri!=='string'||!Array.isArray(proof.preservedQueuedRunIds)
  ||!proof.preservedQueuedRunIds.length||proof.preservedQueuedRunIds.length>10||new Set(proof.preservedQueuedRunIds).size!==proof.preservedQueuedRunIds.length
  ||proof.preservedQueuedRunIds.some((id:unknown)=>typeof id!=='string'||!uuid.test(id)||id===context.priorRunId||id===context.sourceRunId))return null;
 const fence=(await c.query(`select current_setting('session_replication_role')<>'replica' and count(distinct t.tgrelid)=2 installed
  from pg_trigger t where not t.tgisinternal and t.tgenabled in ('O','A') and t.tgfoid=to_regprocedure('agentflow_coordinator_claim_fence()')
  and ((t.tgname='agentflow_coordinator_run_claim' and t.tgrelid=to_regclass('workflow_runs'))
   or (t.tgname='agentflow_coordinator_task_claim' and t.tgrelid=to_regclass('workflow_tasks')))`)).rows[0]?.installed;
 if(fence!==true)return null;
 const terminal=(await c.query(`select action_type,receipt_hash,metadata,created_at from action_receipts where run_id=$1
  and receipt_hash=any($2::text[]) order by created_at`,[context.priorRunId,[proof.blockedReceiptHash,proof.dismissalReceiptHash]])).rows;
 if(terminal.length!==2||terminal[0].action_type!=='stage_blocked'||terminal[0].receipt_hash!==proof.blockedReceiptHash
  ||terminal[1].action_type!=='failed_run_dismissed'||terminal[1].receipt_hash!==proof.dismissalReceiptHash||terminal[1].metadata?.priorStatus!=='blocked'
  ||new Date(terminal[0].created_at).getTime()>=new Date(terminal[1].created_at).getTime())return null;
 const recovered=(await c.query(`select content from artifacts where run_id=$1 and uri=$2 and kind='operator_recovered_command_evidence'`,[context.priorRunId,proof.recoveredEvidenceUri])).rows;
 const e=recovered[0]?.content;
 if(recovered.length!==1||e?.runId!==context.priorRunId||e.sourceRunId!==context.sourceRunId||e.projectId!==context.projectId
  ||e.authority!=='evidence-only'||e.acceptance!=='unverified'||e.nativeAcceptance!==false||e.replay!==false||e.rerun!==false
  ||!Array.isArray(e.commands)||!e.commands.length||e.commands.length>20)return null;
 const observation=(await c.query(`select metadata from action_receipts where run_id=$1 and action_type='operator_recovered_command_evidence' and target=$2`,[context.priorRunId,proof.recoveredEvidenceUri])).rows;
 if(!observation.some(r=>acceptanceDigest(r.metadata)===acceptanceDigest(e)))return null;
 for(const command of e.commands){
  const stored=(await c.query(`select content from artifacts where run_id=$1 and uri=$2 and kind='command_output'`,[context.priorRunId,command.uri])).rows;
  const a=stored[0]?.content;
  if(stored.length!==1||!a||acceptanceDigest(a)!==command.artifactDigest||a.exitCode!==0||a.timedOut!==false
   ||a.commandLine!==command.command||a.sourceBefore!==context.subjectHash||a.sourceAfter!==context.subjectHash)return null;
 }
 const rows=(await c.query(`select r.*,r.id::text run_key,r.project_id::text project_key from workflow_runs r
  where r.id=any($1::uuid[]) order by r.id for share`,[proof.preservedQueuedRunIds])).rows;
 if(rows.length!==proof.preservedQueuedRunIds.length)return null;
 for(const row of rows){
  const m=row.evaluation_metadata;
  if(row.status!=='queued'||row.project_key!==context.projectId||row.task!==context.priorTask||row.lease_owner||row.lease_expires_at
   ||row.provider_override!==context.provider||row.model_tier_override!==context.modelTier
   ||m?.sourceRunId!==context.sourceRunId||m.replayOfRunId!==context.priorRunId||m.queueCoordinatorClaimId!==context.assignmentId
   ||m.queueCoordinatorFence!==context.priorFence||m.originalAcceptanceDigest!==context.originalContractDigest)return null;
  // The OLD exact assignment cannot own this clone, even after intent renewal.
  if((await c.query(`select 1 from queue_coordinator_assignments where child_run_id=$1 limit 1`,[row.run_key])).rowCount)return null;
  const unsafe=(await c.query(`select 1 where not exists(select 1 from workflow_tasks where run_id=$1)
   or exists(select 1 from workflow_tasks where run_id=$1 and (status<>'queued' or worker_id is not null or lease_expires_at is not null or started_at is not null or finished_at is not null or attempts<>0))
   or exists(select 1 from action_approvals where run_id=$1)
   or exists(select 1 from artifacts where run_id=$1 and kind in ('file_write','command_output','stage_output','stage_continuation'))
   or exists(select 1 from action_receipts where run_id=$1 and action_type not in ('workflow_replayed','requester_notified','workflow_run_transition'))`,[row.run_key])).rowCount;
  if(unsafe)return null;
 }
 return [...proof.preservedQueuedRunIds];
}
