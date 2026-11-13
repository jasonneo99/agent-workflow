import type { Client } from "pg";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { acceptanceDigest } from "./acceptance.js";
import { effectiveRepairContractOnClient, repairRevisionRequirementsDigest } from "./repaired-revision.js";
import { verifySealedIndependentReviewReservationOnClient } from "./independent-acceptance-review.js";
import { sourceSubjectHash } from "../../workflow-engine/src/source-subject.js";
import { appendActionReceipt } from "./receipt-writer.js";
import {loadProjectConfig} from '../../agent-registry/src/loaders.js';
import {canonicalJsonHash,resolveExecutionPolicy} from '../../policy-engine/src/index.js';
import {assertCommandAllowed} from '../../local-tools/src/command-executor.js';
import {queueWorkingOccupancyOnClient} from './queue-coordinator.js';

export interface QueuedReviewPreflightInput { claimId:string;claimFence:string;owner:string;intentFence:string;reviewRunId:string;approvalId:string }
export interface QueuedReviewReadinessInput extends Omit<QueuedReviewPreflightInput,'approvalId'> {readinessAuthorizationArtifactUri:string;workerPlatform:NodeJS.Platform}
export interface QueuedReviewPreflightHooks {
  chain(c:Client,id:string):Promise<boolean>;
  hash(root:string,paths:string[]):Promise<string>;
  canonicalRoot(root:string):Promise<boolean>;
  reservation(c:Client,auth:any,metadata:any,q:any,taskHash:string):Promise<boolean>;
  audit(c:Client,sourceRunId:string,payload:Record<string,unknown>):Promise<void>;
  commandsAllowed(root:string,commands:string[],profile:string):Promise<boolean>;
}

/** Caller transaction required. Only an unstarted queued review's proven pre-command SQL failure can be reconciled once. */
export async function reconcileQueuedReviewPreflightOnClient(c:Client,input:QueuedReviewPreflightInput,hooks:Partial<QueuedReviewPreflightHooks>={}):Promise<boolean>{
 return reconcileUnstartedReviewOnClient(c,input,hooks);
}

/** Operator-only, once-only readiness correction for the SAME untouched review.
 * No new run, source/task/policy mutation, claim fence, grant or budget refund.
 */
export async function reconcileQueuedReviewReadinessOnClient(c:Client,input:QueuedReviewReadinessInput,hooks:Partial<QueuedReviewPreflightHooks>={}):Promise<boolean>{
 return reconcileUnstartedReviewOnClient(c,input,hooks);
}

async function reconcileUnstartedReviewOnClient(c:Client,input:QueuedReviewPreflightInput|QueuedReviewReadinessInput,hooks:Partial<QueuedReviewPreflightHooks>):Promise<boolean>{
 const readiness='readinessAuthorizationArtifactUri' in input,approvalId=readiness?null:input.approvalId;
 const action=readiness?'queued_review_readiness_reconciled':'queued_review_preflight_reconciled';
 const h={hash:sourceSubjectHash,canonicalRoot:async(root:string)=>await fs.realpath(root)===root,
  chain:async(client:Client,id:string)=>{const {verifyRunReceiptChainOnClient}=await import('./postgres.js');return(await verifyRunReceiptChainOnClient(client,id)).valid;},
  reservation:verifySealedIndependentReviewReservationOnClient,
  commandsAllowed:async(root:string,commands:string[],profile:string)=>{try{const policy=resolveExecutionPolicy(await loadProjectConfig(root),profile).project;for(const command of commands)assertCommandAllowed(command,policy);return true;}catch{return false;}},
  audit:async(client:Client,sourceRunId:string,payload:Record<string,unknown>)=>{await appendActionReceipt(client,{runId:sourceRunId,agentId:'workflow-orchestrator',actionType:action,target:input.claimId,summary:'Once-only pre-effect correction; same queued review, claim fence, budgets and approval history retained.',metadata:JSON.stringify(payload)});await client.query("insert into artifacts(run_id,kind,uri,content) values($1,$2,$3,$4::jsonb)",[sourceRunId,action,`db://workflow_runs/${sourceRunId}/${action}/${payload.id}`,JSON.stringify(payload)]);},...hooks};
 if(!input.claimId||!input.claimFence||!input.owner||!input.intentFence||!input.reviewRunId||(!readiness&&!approvalId)
  ||(readiness&&(!input.readinessAuthorizationArtifactUri?.startsWith('db://')||input.workerPlatform!==process.platform)))return false;
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 if(readiness)await c.query("select pg_advisory_xact_lock(hashtext('agentflow:workflow-task-scheduler'))");
 const q=(await c.query(`select q.*,q.source_run_id::text source_id,q.project_id::text project_key,q.child_run_id::text child_id,p.root_uri,
  exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical
  from queue_coordinator_assignments q join projects p on p.id=q.project_id where q.id=$1 and q.fence=$2::bigint for update of q`,[input.claimId,input.claimFence])).rows[0];
 if(!q||q.state!=='held'||q.role!=='verifier'||q.owner!==input.owner||q.intent_fence!==input.intentFence||q.child_id!==input.reviewRunId
  ||!q.canonical||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(q.root_uri)||!await h.canonicalRoot(q.root_uri))return false;
 const intent=(await c.query(`select 1 from work_intents where project_id::text=$1::text and owner=$2 and fencing_token::text=$3
  and file_scopes=$4::jsonb and expires_at>clock_timestamp() for update`,[q.project_key,input.owner,input.intentFence,JSON.stringify(q.file_scopes)])).rowCount;
 if(!intent)return false;
 const runs=(await c.query('select *,id::text run_id,project_id::text project_key from workflow_runs where id=any($1::uuid[]) for update',[[q.source_id,input.reviewRunId]])).rows;
 const source=runs.find(r=>r.run_id===q.source_id),review=runs.find(r=>r.run_id===input.reviewRunId),m=review?.evaluation_metadata;
 if(!source||!review||review.status!=='queued'||review.project_key!==q.project_key||review.task!==source.task||q.family_id!==`${q.project_key}:${source.run_set_id}`
  ||m?.kind!=='explicit-independent-acceptance-review'||m.noAutomaticRepeat!==true||m.sourceRunId!==q.source_id
  ||m.queueCoordinatorClaimId!==input.claimId||m.queueCoordinatorFence!==input.claimFence||!m.independentReviewAuthorizationUri||!m.independentReviewReservationAuthorizationUri
  ||!Array.isArray(review.policy_snapshot?.actions?.allowed_write_paths)||review.policy_snapshot.actions.allowed_write_paths.length)return false;
 const tasks=(await c.query('select id::text,status,attempts,started_at,worker_id,lease_expires_at from workflow_tasks where run_id=$1 for update',[input.reviewRunId])).rows;
 if(!tasks.length||tasks.some(t=>t.status!=='queued'||t.attempts!==0||t.started_at!==null))return false;
 if(readiness&&(review.lease_owner||review.lease_expires_at&&new Date(review.lease_expires_at).getTime()>Date.now()
  ||tasks.some(t=>t.worker_id||t.lease_expires_at&&new Date(t.lease_expires_at).getTime()>Date.now())))return false;
 if(readiness&&(review.policy_snapshot.actions.isolate_command_writes!==true||canonicalJsonHash(review.policy_snapshot)!==review.policy_snapshot_hash))return false;
 const effects=await c.query(`select 1 from artifacts where run_id=$1 and kind in ('command_output','file_write','executor_output','model_route','stage_output','stage_continuation')
  union all select 1 from action_receipts where run_id=$1 and action_type in ('stage_leased','stage_started','model_route','model_route_failed','execution_progress','local_command','file_write','workflow_run_lease_acquired')
  union all select 1 from action_receipts where action_type in ('queued_review_preflight_reconciled','queued_review_readiness_reconciled') and target=$2 limit 1`,[input.reviewRunId,input.claimId]);
 if(effects.rowCount)return false;
 const approval=readiness?null:(await c.query(`select a.*,exists(select 1 from action_receipts r where r.run_id=a.run_id and r.action_type='action_approval_failed'
  and r.metadata->>'approvalId'=a.id::text and r.metadata->>'error'='operator does not exist: text = uuid'
  and r.metadata->>'actionType'='local_command' and r.metadata->>'status'='failed' and r.metadata->>'target'=a.target
  and r.metadata->>'idempotencyKey'=a.idempotency_key) exact_failure from action_approvals a where a.id=$1 and a.run_id=$2 for update of a`,[approvalId,input.reviewRunId])).rows[0];
 if(!readiness&&(!approval||approval.status!=='failed'||approval.action_type!=='local_command'||!approval.exact_failure||!tasks.some(t=>t.id===String(approval.task_id))))return false;
 if(readiness){
  const authorization=(await c.query(`select a.content from artifacts a join action_receipts r on r.run_id=a.run_id and r.target=a.uri and r.metadata=a.content
   and r.action_type='operator_queued_review_readiness_authorized' and r.agent_id='workflow-orchestrator' and r.receipt_hash is not null
   where a.run_id=$1 and a.uri=$2 and a.kind='queued_review_readiness_authorization'`,[q.source_id,input.readinessAuthorizationArtifactUri])).rows;
  const grant=authorization.length===1?authorization[0].content:null;
  if(grant?.version!==1||grant.authority!=='direct-human'||grant.approvalDecision!=='approved'||grant.operation!=='resume-same-unstarted-review'
   ||grant.claimId!==input.claimId||grant.claimFence!==input.claimFence||grant.reviewRunId!==input.reviewRunId||grant.sourceRunId!==q.source_id
   ||grant.owner!==input.owner||grant.intentFence!==input.intentFence||grant.workerPlatform!==input.workerPlatform||grant.resumeLimit!==1||grant.permissionsChanged!==false)return false;
  const platforms=(await c.query("select config->'execution'->'worker_pool'->'allowed_platforms' platforms from projects where id=$1",[q.project_key])).rows[0]?.platforms;
  if(!Array.isArray(platforms)||!platforms.includes(input.workerPlatform))return false;
  if((await c.query(`select 1 from action_approvals where run_id=$1 and status in ('pending','approved','executing','failed')
   union all select 1 from side_effect_receipts where project_id=$2::text and status<>'completed' limit 1`,[input.reviewRunId,input.reviewRunId])).rowCount)return false;
  if((await queueWorkingOccupancyOnClient(c)).count>=5)return false;
  const overlapping=(await c.query("select file_scopes from queue_coordinator_assignments where id<>$1 and project_id=$2 and state in ('reserved','running','uncertain')",[input.claimId,q.project_key])).rows;
  if(overlapping.some(row=>!Array.isArray(row.file_scopes)||!row.file_scopes.length||row.file_scopes.some((file:unknown)=>typeof file!=='string'||q.file_scopes.some((own:string)=>file===own||file.startsWith(own+'/')||own.startsWith(file+'/')))))return false;
 }
 const authRows=(await c.query("select content from artifacts where run_id=$1 and uri=$2 and kind='independent_acceptance_review_authorization'",[q.source_id,m.independentReviewAuthorizationUri])).rows;
 if(authRows.length!==1)return false;const a=authRows[0].content;
 if(a?.version!==1||a.authority!=='direct-human'||a.approvalDecision!=='approved'||a.offlineOnly!==true||a.sourceRunId!==q.source_id||a.reviewRunId!==input.reviewRunId
  ||a.projectId!==q.project_key||a.projectRootUri!==q.root_uri||a.claimId!==input.claimId||a.claimFence!==input.claimFence
  ||!Array.isArray(a.authorizedCommands)||(!readiness&&!a.authorizedCommands.includes(approval!.target)))return false;
 if(readiness&&(acceptanceDigest(a.authorizedCommands)!==acceptanceDigest(review.policy_snapshot.actions.allowed_commands)
  ||!await h.commandsAllowed(q.root_uri,a.authorizedCommands,review.policy_profile??'local')))return false;
 const authority=(await c.query(`select receipt_hash from action_receipts where run_id=$1 and action_type='independent_acceptance_review_authorization'
  and target=$2 and metadata=$3::jsonb and agent_id in ('operator','workflow-orchestrator') limit 2`,[q.source_id,m.independentReviewAuthorizationUri,JSON.stringify(a)])).rows;
 if(authority.length!==1||!/^[a-f0-9]{64}$/u.test(authority[0].receipt_hash??''))return false;
 let effective;try{effective=await effectiveRepairContractOnClient(c,source,{sourceRunId:q.source_id,projectId:q.project_key,fileScopes:q.file_scopes,legacyEnrollmentId:m.legacyEnrollmentId});}catch{return false;}
 const contract=m.acceptanceContract;
 if(!contract||contract.version!==1||contract.originRunId!==input.reviewRunId||contract.projectId!==q.project_key
  ||contract.taskHash!==acceptanceDigest(review.task)||contract.subjectHash!==a.sourceHash||acceptanceDigest(contract.sourcePaths)!==acceptanceDigest(q.file_scopes))return false;
 let requirements:string;try{requirements=repairRevisionRequirementsDigest(contract);}catch{return false;}
 if(a.originalContractDigest!==acceptanceDigest(effective.contract)||m.originalAcceptanceDigest!==a.originalContractDigest
  ||a.requirementsDigest!==repairRevisionRequirementsDigest(effective.contract)||requirements!==a.requirementsDigest||a.sourceHash!==effective.contract.subjectHash
  ||acceptanceDigest(a.sourcePaths)!==acceptanceDigest(q.file_scopes)||review.provider_override!==a.provider||review.model_tier_override!==a.modelTier
  ||a.provider!==(effective.legacy?.provider??source.provider_override)||a.modelTier!==(effective.legacy?.modelTier??source.model_tier_override)
  ||!await h.reservation(c,a,m,q,acceptanceDigest(source.task))||!await h.chain(c,q.source_id)||!await h.chain(c,input.reviewRunId)
  ||await h.hash(q.root_uri,q.file_scopes)!==a.sourceHash)return false;
 const pending=await c.query(`with recursive family(id) as (
  select r.id from workflow_runs r join workflow_runs original on original.id=$5 where r.id=original.id or (r.project_id=original.project_id and r.run_set_id=original.run_set_id)
  union select child.id from workflow_runs child join family parent on parent.id::text in (child.evaluation_metadata->>'sourceRunId',child.evaluation_metadata->>'replayOfRunId',child.evaluation_metadata->>'parentRunId',child.evaluation_metadata->>'repairOriginRunId')
 ) select 1 from action_approvals where run_id in (select id from family) and id is distinct from $2::uuid and status in ('pending','executing')
  union all select 1 from workflow_runs where id in (select id from family) and id<>$1 and status in ('queued','leased','running')
  union all select 1 from queue_coordinator_assignments where id<>$3 and (family_id=$4 or role='verifier') and state in ('reserved','running','uncertain') limit 1`,[input.reviewRunId,approvalId,input.claimId,q.family_id,q.source_id]);
 if(pending.rowCount)return false;
 const updated=await c.query(`update queue_coordinator_assignments set state='running',reason='Once-only queued pre-effect SQL correction; same review and fence retained',updated_at=clock_timestamp()
  where id=$1 and fence=$2::bigint and state='held' and exists(select 1 from work_intents where project_id::text=$3::text and owner=$4
   and fencing_token::text=$5 and file_scopes=$6::jsonb and expires_at>clock_timestamp())`,[input.claimId,input.claimFence,q.project_key,input.owner,input.intentFence,JSON.stringify(q.file_scopes)]);
 if(updated.rowCount!==1)return false;
 await h.audit(c,q.source_id,{id:randomUUID(),...input,sourceRunId:q.source_id,priorState:q.state,priorReason:q.reason,originalRunUnchanged:true,approvalHistoryUnchanged:true,
  correction:readiness?'Operator worker invocation now advertises its actual allowed platform; same task and reservation remain': 'Typed project identity comparison before command dispatch',noEffectsProven:true,budgetRefunded:false});
 return true;
}
