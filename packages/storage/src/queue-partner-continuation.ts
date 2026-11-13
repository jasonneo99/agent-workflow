import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {withClient} from './client.js';
import {appendActionReceipt} from './receipt-writer.js';
import {acceptanceDigest} from './acceptance.js';
import {loadProjectConfig} from '../../agent-registry/src/loaders.js';
import {canonicalJsonHash,resolveExecutionPolicy} from '../../policy-engine/src/index.js';
import {computeReceiptHash} from '../../workflow-engine/src/receipt-chain.js';
import {sourceSubjectHash} from '../../workflow-engine/src/source-subject.js';
import {partnerReasoningReceiptValid} from './queue-partner-reasoning.js';
import type {CoordinatorClaim} from './queue-coordinator.js';
import {assertFilePathAllowed} from '../../local-tools/src/file-writer.js';
import {assertCommandAllowed} from '../../local-tools/src/command-executor.js';
import {checkpointWithReconciledPartnerEffects,loadPartnerEffectReconciliationOnClient} from './queue-partner-effect-evidence.js';

export const READ_ONLY_PARTNER_CONTINUATION_LIMIT=2;
export interface PartnerReadOnlyHandoff {
 assignmentId:string;fence:string;childRunId:string;owner:string;intentFence:string;authorizationUri:string;
}
export interface AutomaticPartnerContinuation {assignmentId:string;owner:string;intentFence:string}
function authentic(row:any):boolean{
 try{return row?.metadata_serialization_version===2&&typeof row.prev_hash==='string'&&computeReceiptHash(row.prev_hash,{
  runId:row.run_id,agentId:row.agent_id,actionType:row.action_type,target:row.target,summary:row.summary,
  metadata:JSON.stringify(row.metadata),metadataSerializationVersion:2,createdAt:new Date(row.created_at).toISOString()})===row.receipt_hash;}catch{return false;}
}
const readOnlyActions=['workflow_created','workflow_run_transition','workflow_run_lease_acquired','stage_leased','stage_started',
 'file_read','file_search','file_read_rejected','file_search_rejected','model_route','context_influence','context_influence_result',
 'execution_progress','requester_notified','stage_continuation_scheduled','stage_requeued','expired_worker_lease_requeued',
 'queue_partner_read_only_continuation_granted'];

async function lockPartnerContinuationPolicy(c:Client,assignmentId:string):Promise<boolean>{
 // Match ordinary file mutations and approved policy changes. Acquire this
 // before run-row locks so a policy writer can finish its audit without a cycle.
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:workflow-task-scheduler'))");
 const row=(await c.query('select p.root_uri from queue_coordinator_assignments q join projects p on p.id=q.project_id where q.id=$1',[assignmentId])).rows[0];
 if(!row)return false;
 await c.query('select pg_advisory_xact_lock(hashtext($1))',[`${row.root_uri}:file:.agent-workflow/project.yaml`]);
 return true;
}

/** Read-only observation for an exact operator authorization. A digest of an old
 * checkpoint is a NEW observation, not invented historical payload provenance.
 */
export async function partnerReadOnlyHandoffEvidenceOnClient(c:Client,childRunId:string){
 const checkpoint=(await c.query(`select content from artifacts where run_id=$1 and kind='stage_continuation'
  order by created_at desc limit 2`,[childRunId])).rows;
 if(checkpoint.length>1)throw Error('Ambiguous continuation checkpoint');
 const content=checkpoint[0]?.content??null;
 if(content!==null&&(Buffer.byteLength(JSON.stringify(content),'utf8')>4_000_000
  ||!Number.isInteger(content.round)||content.round<0||content.round>3))throw Error('Invalid bounded continuation checkpoint');
 const rows=(await c.query(`select action_type,target,receipt_hash from action_receipts where run_id=$1
  order by created_at,id limit 501`,[childRunId])).rows;
 if(rows.length>500)throw Error('Continuation receipt observation exceeds its bounded scope');
 return {checkpointDigest:acceptanceDigest(content),checkpointPresent:content!==null,
  effectsDigest:acceptanceDigest(rows),observedReceiptCount:rows.length};
}

/** Delegate an existing read-only task, not generic replay or lease takeover.
 * All original run/task/policy snapshots stay immutable. The assignment fence
 * remains the same reservation; its new owner has a fresh intent, and the next
 * actual worker claim gets a new task/run lease generation through ordinary APIs.
 * Existing SQL claim fences therefore reject the old worker without relaxation.
 */
async function handoffPartnerChildOnClient(c:Client,input:PartnerReadOnlyHandoff,reconcileEffects=false):Promise<{claim:CoordinatorClaim;childRunId:string}|null>{
 if(!input.owner||!/^\d+$/u.test(input.intentFence))return null;
 if(!await lockPartnerContinuationPolicy(c,input.assignmentId))return null;
 const q=(await c.query(`select q.*,q.project_id::text project_key,q.source_run_id::text source_id,q.fence::text claim_fence,
  original.task,original.run_set_id::text run_set,original.policy_profile,original.status source_status,p.root_uri,
  child.status child_status,child.lease_owner,child.lease_expires_at,child.policy_snapshot,child.policy_snapshot_hash,child.evaluation_metadata child_metadata
  from queue_coordinator_assignments q join workflow_runs original on original.id=q.source_run_id
  join projects p on p.id=q.project_id join workflow_runs child on child.id=q.child_run_id and child.project_id=q.project_id
  where q.id=$1 and q.fence::text=$2 and q.child_run_id=$3 for update of q,original,p,child`,[input.assignmentId,input.fence,input.childRunId])).rows[0];
 if(!q||q.role!=='repair'||!['running','uncertain'].includes(q.state)||!['queued','running'].includes(q.child_status)
  ||!['failed','blocked','completed'].includes(q.source_status)
  ||input.owner===q.owner||q.family_id!==`${q.project_key}:${q.run_set}`)return null;
 const m=q.child_metadata,a=q.policy_snapshot?.actions;
 const recoveryPaths=Array.isArray(m?.recoveryWritePaths)?m.recoveryWritePaths:[];
 const expectedScopes=recoveryPaths.length?recoveryPaths:[`runtime/queue-partner/recovery/${q.source_id}`];
 if(m?.source!=='queue-partner-recovery'||m.sourceRunId!==q.source_id||m.queueCoordinatorClaimId!==input.assignmentId
  ||m.queueCoordinatorFence!==input.fence||m.recoveryTaskHash!==acceptanceDigest(q.task)
  ||acceptanceDigest(q.file_scopes)!==acceptanceDigest(expectedScopes)
  ||(recoveryPaths.length?typeof m.recoverySubjectHash!=='string'||!m.recoverySubjectHash:m.recoverySubjectHash!==null)
  ||!Array.isArray(a?.allowed_commands)||!Array.isArray(a.allowed_write_paths)
  ||acceptanceDigest(a.allowed_write_paths)!==acceptanceDigest(recoveryPaths)
  // Approval rules cannot widen the frozen command/write allowlists. Requiring
  // the project-wide rule list itself to be empty stranded genuinely read-only
  // children in projects that retain unrelated auto-approval preferences.
  ||!Array.isArray(a.approval_rules)
  ||canonicalJsonHash(q.policy_snapshot)!==q.policy_snapshot_hash)return null;
 if(!(await c.query("select 1 from project_identity_locations where project_id=$1 and identity_id=project_id and kind='canonical'",[q.project_key])).rowCount
  ||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(q.root_uri)||await fs.realpath(q.root_uri)!==q.root_uri)return null;
 if(!reconcileEffects&&recoveryPaths.length&&await sourceSubjectHash(q.root_uri,recoveryPaths)!==m.recoverySubjectHash)return null;
 const tasks=(await c.query(`select id::text,status,worker_id,lease_generation::text,
  lease_expires_at>clock_timestamp() live_lease,available_at<=clock_timestamp() available from workflow_tasks where run_id=$1 for update`,[input.childRunId])).rows;
 if(tasks.length!==1||tasks[0].status!=='queued'||tasks[0].worker_id||tasks[0].live_lease||!tasks[0].available
  ||(await c.query("select 1 from workflow_runs where id=$1 and lease_expires_at>clock_timestamp()",[input.childRunId])).rowCount
  ||(await c.query("select 1 from action_approvals where run_id in ($1,$2) and status in ('pending','approved','executing')",[input.childRunId,q.source_id])).rowCount)return null;
 if((await c.query("select 1 from side_effect_receipts where project_id=$1 and status<>'completed' limit 1",[input.childRunId])).rowCount)return null;
 const task=tasks[0],policyHash=canonicalJsonHash(resolveExecutionPolicy(await loadProjectConfig(q.root_uri),q.policy_profile).project);
 const proof=(await c.query(`select * from action_receipts where run_id=$1 and action_type='queue_partner_reasoning_reserved' and target=$2`,[q.source_id,input.assignmentId])).rows[0];
 if(!partnerReasoningReceiptValid(proof,{sourceRunId:q.source_id,projectId:q.project_key,familyId:q.family_id,claimId:input.assignmentId,fence:input.fence,taskHash:acceptanceDigest(q.task)})
  ||proof.metadata.sourceHash!==m.recoverySubjectHash||acceptanceDigest(proof.metadata.writePaths)!==acceptanceDigest(recoveryPaths)
  ||m.workIntent?.owner!==proof.metadata.owner||m.workIntent?.fencingToken!==proof.metadata.intentFence)return null;
 if(recoveryPaths.length||a.allowed_commands.length){
  if(proof.metadata.policyHash!==policyHash)return null;
  const current=resolveExecutionPolicy(await loadProjectConfig(q.root_uri),q.policy_profile).project;
  try{for(const file of recoveryPaths)assertFilePathAllowed(file,current);
   for(const command of a.allowed_commands)assertCommandAllowed(command,current);}catch{return null;}
 }
 const grants=(await c.query(`select * from action_receipts where run_id=$1 and action_type in ('queue_partner_read_only_continuation_granted','queue_partner_effect_continuation_granted')
  and target=$2 order by created_at desc`,[q.source_id,input.assignmentId])).rows;
 if(grants.length>=READ_ONLY_PARTNER_CONTINUATION_LIMIT)return null;
 if(grants.length){const prior=grants[0];if(!authentic(prior)||prior.metadata.owner!==q.owner||prior.metadata.intentFence!==q.intent_fence
  ||prior.metadata.childRunId!==input.childRunId||prior.metadata.fence!==input.fence)return null;}
 else if(q.owner!==proof.metadata.owner||q.intent_fence!==proof.metadata.intentFence)return null;
 const newIntent=(await c.query(`select file_scopes from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3
  and expires_at>clock_timestamp() for update`,[q.project_key,input.owner,input.intentFence])).rows[0];
 if(!newIntent||acceptanceDigest(newIntent.file_scopes)!==acceptanceDigest(q.file_scopes)
  ||(await c.query("select 1 from work_intents where project_id=$1 and owner=$2 and expires_at>clock_timestamp()",[q.project_key,q.owner])).rowCount)return null;
 const permitted=reconcileEffects?[...readOnlyActions,'file_write','local_command','local_command_success_followup','run_feedback','queue_partner_effect_continuation_granted']:readOnlyActions;
 if((await c.query('select 1 from action_receipts where run_id=$1 and action_type<>all($2::text[]) limit 1',[input.childRunId,permitted])).rowCount)return null;
 const {verifyRunReceiptChainOnClient}=await import('./postgres.js');
 if(!(await verifyRunReceiptChainOnClient(c,input.childRunId)).valid)return null;
 const reconciled=reconcileEffects?await loadPartnerEffectReconciliationOnClient(c,{childRunId:input.childRunId,taskId:task.id,
  root:q.root_uri,paths:recoveryPaths,originalSubjectHash:m.recoverySubjectHash}):null;
 let checkpoint:any,newCheckpoint:Record<string,unknown>|null=null;
 if(reconcileEffects){
  if(!reconciled||a.isolate_command_writes!==true||proof.metadata.policyHash!==policyHash)return null;
  const currentPolicy=resolveExecutionPolicy(await loadProjectConfig(q.root_uri),q.policy_profile).project;
  if(canonicalJsonHash(currentPolicy)!==policyHash)return null;
  try{for(const file of recoveryPaths)assertFilePathAllowed(file,currentPolicy);
   for(const command of a.allowed_commands)assertCommandAllowed(command,currentPolicy);}catch{return null;}
  checkpoint=(await c.query(`select uri,content from artifacts where run_id=$1 and task_id=$2 and kind='stage_continuation'
   and uri=$3 for update`,[input.childRunId,task.id,`db://workflow_tasks/${task.id}/continuation`])).rows[0];
  if(!checkpoint||(newCheckpoint=checkpointWithReconciledPartnerEffects(checkpoint.content,reconciled))===null)return null;
 }
 const observed=await partnerReadOnlyHandoffEvidenceOnClient(c,input.childRunId);
 const authorization=(await c.query(`select a.content,to_jsonb(r) receipt,r.created_at>clock_timestamp()-interval '5 minutes' fresh from artifacts a
  join action_receipts r on r.run_id=a.run_id and r.agent_id='workflow-orchestrator'
   and r.action_type in ('operator_partner_read_only_handoff_authorized','queue_partner_same_attempt_continuation_authorized')
   and r.target=$2 and r.metadata=a.content where a.uri=$1 and a.run_id=$3 and a.kind in ('queue_partner_read_only_handoff_authorization','queue_partner_effect_handoff_authorization')`,
  [input.authorizationUri,input.assignmentId,q.source_id])).rows[0];
 const auth=authorization?.content;
 const expectedPurpose=reconcileEffects?'resume-existing-reconciled-partner-child':recoveryPaths.length?'resume-existing-no-effect-partner-child':'resume-existing-read-only-partner-child';
 if(!authentic(authorization?.receipt)||!authorization.fresh||auth?.purpose!==expectedPurpose
  ||auth.assignmentId!==input.assignmentId||auth.fence!==input.fence||auth.childRunId!==input.childRunId
  ||auth.projectId!==q.project_key||auth.owner!==input.owner||auth.intentFence!==input.intentFence
  ||auth.priorOwner!==q.owner||auth.priorIntentFence!==q.intent_fence||auth.taskId!==task.id||auth.leaseGeneration!==task.lease_generation
  ||auth.policyHash!==policyHash||auth.approvalRulesHash!==canonicalJsonHash(a.approval_rules)
  ||auth.checkpointDigest!==observed.checkpointDigest||auth.effectsDigest!==observed.effectsDigest
  ||(reconcileEffects&&auth.reconciliationDigest!==reconciled!.digest)
  ||auth.originalAcceptanceChanged!==false||auth.priorWorkersQuiescent!==true)return null;
 if(reconcileEffects&&await sourceSubjectHash(q.root_uri,recoveryPaths)!==reconciled!.currentSubjectHash)return null;
 if(canonicalJsonHash(resolveExecutionPolicy(await loadProjectConfig(q.root_uri),q.policy_profile).project)!==policyHash)return null;
 const result=await c.query(`update queue_coordinator_assignments set owner=$3,intent_fence=$4,state='running',
  reason='Audited same-attempt continuation under a fresh owner and intent; original snapshots unchanged',updated_at=clock_timestamp()
  where id=$1 and fence::text=$2 and owner=$5 and intent_fence=$6 and state in ('running','uncertain')
   and exists(select 1 from work_intents where project_id=$7 and owner=$3 and fencing_token::text=$4 and expires_at>clock_timestamp())
   and not exists(select 1 from work_intents where project_id=$7 and owner=$5 and expires_at>clock_timestamp())
   and not exists(select 1 from action_approvals where run_id in ($8::uuid,$9::uuid) and status in ('pending','approved','executing')) returning id`,
  [input.assignmentId,input.fence,input.owner,input.intentFence,q.owner,q.intent_fence,q.project_key,input.childRunId,q.source_id]);
 if(result.rowCount!==1)return null;
 const grantKind=reconcileEffects?'queue_partner_effect_continuation_granted':'queue_partner_read_only_continuation_granted';
 if(reconcileEffects){
  const archiveUri=`db://workflow_runs/${input.childRunId}/queue_partner_checkpoint_history/${acceptanceDigest(checkpoint.content)}`;
  await c.query(`insert into artifacts(run_id,task_id,kind,uri,content) values($1,$2,'queue_partner_checkpoint_history',$3,$4::jsonb)`,
   [input.childRunId,task.id,archiveUri,JSON.stringify({checkpointUri:checkpoint.uri,checkpointDigest:acceptanceDigest(checkpoint.content),checkpoint:checkpoint.content})]);
  await c.query(`update artifacts set content=$4::jsonb where run_id=$1 and task_id=$2 and uri=$3 and kind='stage_continuation'`,
   [input.childRunId,task.id,checkpoint.uri,JSON.stringify(newCheckpoint)]);
 }
 const audit={...input,...observed,projectId:q.project_key,sourceRunId:q.source_id,priorOwner:q.owner,priorIntentFence:q.intent_fence,
  taskId:task.id,priorState:q.state,priorReason:q.reason,leaseGeneration:task.lease_generation,continuationNumber:grants.length+1,
  policyHash,originalAcceptanceChanged:false,snapshotsChanged:false,reservationFenceChanged:false,budgetRefunded:false,
  ...(reconciled?{reconciliation:reconciled,checkpointRoundUnchanged:true}:{}),
  checkpointProvenance:reconciled?'Prior checkpoint archived exactly; finalized later effects supplied as a new observation, never a historical preimage or new execution':observed.checkpointPresent?'Observed current checkpoint; historical URI-only receipt is not promoted to a payload-hash proof':'No saved checkpoint; only interrupted read-only discovery may repeat'};
 for(const runId of [q.source_id,input.childRunId]){
  await appendActionReceipt(c,{runId,agentId:'workflow-orchestrator',actionType:grantKind,target:input.assignmentId,
   summary:reconciled?'Finalized effects reconciled for the existing Partner child; no replay, acceptance or budget reset.':'Audited handoff of the existing read-only Partner child; no new run, original acceptance or budget reset.',metadata:JSON.stringify(audit)});
  await c.query('insert into artifacts(run_id,kind,uri,content) values($1,$2,$3,$4::jsonb)',
   [runId,grantKind,`db://workflow_runs/${runId}/${grantKind}/${input.assignmentId}/${grants.length+1}`,JSON.stringify(audit)]);
 }
 return {claim:{id:input.assignmentId,fence:input.fence,projectId:q.project_key,projectRootUri:q.root_uri,sourceRunId:q.source_id,
  familyId:q.family_id,owner:input.owner,intentFence:input.intentFence,fileScopes:q.file_scopes,role:'repair',lane:q.lane,fingerprint:q.fingerprint},childRunId:input.childRunId};
}
export const handoffReadOnlyPartnerChildOnClient=(c:Client,input:PartnerReadOnlyHandoff)=>handoffPartnerChildOnClient(c,input);
export const handoffReadOnlyPartnerChild=(input:PartnerReadOnlyHandoff)=>withClient(async c=>{
 await c.query('begin');try{const grant=await handoffReadOnlyPartnerChildOnClient(c,input);await c.query('commit');return grant;}catch(error){await c.query('rollback');throw error;}
});

/** Automatically rebind one exact interrupted child after quiescence and either
 * zero effects or strict reconciliation of finalized patches/offline checks.
 * Policy, started contracts, task budgets and reservation fences never change.
 * Effect reconciliation archives the old checkpoint and supplies authentic later
 * results; the ordinary SQL claim fence continues rejecting the prior worker.
 */
export async function authorizeAndHandoffPartnerChildOnClient(c:Client,input:AutomaticPartnerContinuation){
 await c.query('savepoint automatic_partner_continuation');
 try{
  if(!await lockPartnerContinuationPolicy(c,input.assignmentId))return null;
  const q=(await c.query(`select q.id::text,q.fence::text,q.owner,q.intent_fence,q.project_id::text project_id,
   q.source_run_id::text source_run_id,q.child_run_id::text child_run_id,q.file_scopes,p.root_uri,
   child.policy_profile,child.policy_snapshot,child.evaluation_metadata,
   (select id::text from workflow_tasks where run_id=child.id) task_id,
   (select lease_generation::text from workflow_tasks where run_id=child.id) lease_generation
   from queue_coordinator_assignments q join projects p on p.id=q.project_id
   join workflow_runs child on child.id=q.child_run_id where q.id=$1 for update of q,child,p`,[input.assignmentId])).rows[0];
  if(!q?.child_run_id||q.owner===input.owner)return null;
  const observed=await partnerReadOnlyHandoffEvidenceOnClient(c,q.child_run_id);
  const currentPolicy=resolveExecutionPolicy(await loadProjectConfig(q.root_uri),q.policy_profile).project;
  const recoveryPaths=Array.isArray(q.evaluation_metadata?.recoveryWritePaths)?q.evaluation_metadata.recoveryWritePaths:[];
  const hasEffects=(await c.query("select 1 from action_receipts where run_id=$1 and action_type in ('file_write','local_command') limit 1",[q.child_run_id])).rowCount!>0;
  const reconciled=hasEffects?await loadPartnerEffectReconciliationOnClient(c,{childRunId:q.child_run_id,taskId:q.task_id,
   root:q.root_uri,paths:recoveryPaths,originalSubjectHash:q.evaluation_metadata?.recoverySubjectHash}):null;
  if(hasEffects&&!reconciled)return null;
  const content={...observed,purpose:hasEffects?'resume-existing-reconciled-partner-child':recoveryPaths.length?'resume-existing-no-effect-partner-child':'resume-existing-read-only-partner-child',
   assignmentId:q.id,fence:q.fence,childRunId:q.child_run_id,projectId:q.project_id,owner:input.owner,
   intentFence:input.intentFence,priorOwner:q.owner,priorIntentFence:q.intent_fence,taskId:q.task_id,
   leaseGeneration:q.lease_generation,policyHash:canonicalJsonHash(currentPolicy),
   approvalRulesHash:canonicalJsonHash(q.policy_snapshot?.actions?.approval_rules),originalAcceptanceChanged:false,
   priorWorkersQuiescent:true,authority:'same-attempt-fenced-continuation',...(reconciled?{reconciliationDigest:reconciled.digest}:{})};
  const authorizationUri=`db://workflow_runs/${q.source_run_id}/queue_partner_same_attempt_continuation_authorized/${randomUUID()}`;
  await appendActionReceipt(c,{runId:q.source_run_id,agentId:'workflow-orchestrator',actionType:'queue_partner_same_attempt_continuation_authorized',target:q.id,
   summary:hasEffects?'Exact finalized-effect Partner child authorized for audited reconciliation; no new action authority.':'Exact no-effect Partner child authorized to continue under a fresh process owner; assignment and action authority unchanged.',metadata:JSON.stringify(content)});
  await c.query('insert into artifacts(run_id,kind,uri,content) values($1,$2,$3,$4::jsonb)',[q.source_run_id,hasEffects?'queue_partner_effect_handoff_authorization':'queue_partner_read_only_handoff_authorization',authorizationUri,JSON.stringify(content)]);
  const grant=await handoffPartnerChildOnClient(c,{assignmentId:q.id,fence:q.fence,childRunId:q.child_run_id,
   owner:input.owner,intentFence:input.intentFence,authorizationUri},hasEffects);
  if(!grant){await c.query('rollback to savepoint automatic_partner_continuation');return null;}
  await c.query('release savepoint automatic_partner_continuation');return grant;
 }catch(error){await c.query('rollback to savepoint automatic_partner_continuation');throw error;}
}
export const authorizeAndHandoffPartnerChild=(input:AutomaticPartnerContinuation)=>withClient(async c=>{
 await c.query('begin');try{const grant=await authorizeAndHandoffPartnerChildOnClient(c,input);await c.query('commit');return grant;}catch(error){await c.query('rollback');throw error;}
});
