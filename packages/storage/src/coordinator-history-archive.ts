import type {Client} from 'pg';
import {archiveReconciledEffectKeys} from './rejected-write-reconciliation.js';
import {randomUUID} from 'node:crypto';
import {withClient} from './client.js';
import {acceptanceDigest} from './acceptance.js';
import {appendActionReceipt} from './receipt-writer.js';
import {verifyIndependentAcceptanceReviewOnClient} from './independent-acceptance-review.js';

export const COORDINATOR_HISTORY_ARCHIVE_CONFIRMATION='Archive from active views.';
export const COORDINATOR_HISTORY_RESTORE_CONFIRMATION='Restore to active views.';

export interface CoordinatorHistoryArchiveInput {
 projectId:string; sourceRunId:string; reviewRunId:string; claimId:string; claimFence:string;
 authorizationArtifactUri:string; owner:string; intentFence:string; runIds:string[];
}

export interface CoordinatorHistoryActionPlan {
 projectId:string; sourceRunId:string; reviewRunId:string; claimId:string; claimFence:string; fileScopes:string[];
}

export interface CoordinatorHistoryAuthorizationInput extends CoordinatorHistoryActionPlan {
 owner:string; intentFence:string; runIds:string[]; actor:string; reason:string; confirmation:string;
}

function exactIds(input:string[],reviewRunId:string):string[]{
 const ids=[...new Set(input)].sort();
 if(!ids.length||ids.length>30||ids.length!==input.length||ids.includes(reviewRunId))throw Error('Action requires 1-30 distinct obsolete runs, excluding the accepted review replacement');
 return ids;
}

export async function prepareCoordinatorHistoryAction(sourceRunId:string,reviewRunId:string):Promise<CoordinatorHistoryActionPlan>{
 return withClient(async c=>{
  const row=(await c.query(`select q.project_id::text "projectId",q.source_run_id::text "sourceRunId",q.child_run_id::text "reviewRunId",
   q.id::text "claimId",q.fence::text "claimFence",q.file_scopes "fileScopes" from queue_coordinator_assignments q
   where q.source_run_id=$1 and q.child_run_id=$2 and q.role='verifier' and q.state='verified'`,[sourceRunId,reviewRunId])).rows;
  if(row.length!==1)throw Error('History action requires the exact independently verified replacement assignment');
  return row[0] as CoordinatorHistoryActionPlan;
 });
}

/** Explicit UI retirement only. Never change terminal statuses, acceptance or leases.
 * Generic managed-run dismissal remains forbidden. A separately approved exact
 * list can leave actionable views only after the existing independent proof passes.
 */
export async function archiveVerifiedCoordinatorHistoryOnClient(c:Client,input:CoordinatorHistoryArchiveInput):Promise<string[]> {
 const ids=exactIds(input.runIds,input.reviewRunId);
 await c.query('select pg_advisory_xact_lock(hashtext($1))',[input.projectId]);
 const reconciledKeys=await archiveReconciledEffectKeys(c,ids);
 const q=(await c.query(`select q.*,r.evaluation_metadata metadata from queue_coordinator_assignments q
  join workflow_runs r on r.id=q.child_run_id where q.id=$1 and q.fence=$2::bigint and q.project_id=$3
  and q.source_run_id=$4 and q.child_run_id=$5 and q.role='verifier' and q.state='verified' for update of q`,
  [input.claimId,input.claimFence,input.projectId,input.sourceRunId,input.reviewRunId])).rows[0];
 if(!q)throw Error('Archive requires the exact independently verified assignment');
 const intent=(await c.query(`select file_scopes from work_intents where project_id=$1 and owner=$2
  and fencing_token=$3::bigint and expires_at>clock_timestamp() for update`,[input.projectId,input.owner,input.intentFence])).rows[0];
 if(!intent||acceptanceDigest(intent.file_scopes)!==acceptanceDigest(q.file_scopes))throw Error('Archive requires a fresh exact-scope intent');
 const authorization=(await c.query(`select content from artifacts where run_id=$1 and uri=$2
  and kind='coordinator_history_archive_authorization'`,[input.sourceRunId,input.authorizationArtifactUri])).rows;
 const a=authorization.length===1?authorization[0].content:null;
 if(!a||a.version!==1||a.authority!=='direct-human'||a.approvalDecision!=='approved'||a.archiveOnly!==true
  ||typeof a.approvalEvidence!=='string'||!a.approvalEvidence.trim()||a.projectId!==input.projectId||a.sourceRunId!==input.sourceRunId
  ||a.reviewRunId!==input.reviewRunId||a.claimId!==input.claimId||a.claimFence!==input.claimFence
  ||a.owner!==input.owner||a.intentFence!==input.intentFence||!Array.isArray(a.runIds)
  ||acceptanceDigest([...a.runIds].sort())!==acceptanceDigest(ids))throw Error('Exact direct-human archival authorization is missing');
 const audited=await c.query(`select 1 from action_receipts where run_id=$1 and action_type='operator_coordinator_history_archive_authorized'
  and target=$2 and metadata=$3::jsonb`,[input.sourceRunId,input.authorizationArtifactUri,JSON.stringify(a)]);
 if(audited.rowCount!==1)throw Error('Archival authorization lacks its exact audit receipt');
 if(!await verifyIndependentAcceptanceReviewOnClient(c,{sourceRunId:input.sourceRunId,reviewRunId:input.reviewRunId,
  authorizationArtifactUri:q.metadata?.independentReviewAuthorizationUri,claimId:input.claimId,claimFence:input.claimFence}))throw Error('Independent original-requirement acceptance is no longer valid');
 const runs=(await c.query(`select r.id::text,r.status from workflow_runs r where r.id=any($1::uuid[]) and r.project_id=$2
  and (r.id=$3 or exists(select 1 from queue_coordinator_assignments old where old.child_run_id=r.id
   and old.source_run_id=$3 and old.project_id=$2 and old.family_id=$4 and old.state in ('held','failed','verified')))
  and r.status in ('failed','blocked','cancelled')
  and not exists(select 1 from workflow_tasks t where t.run_id=r.id and t.status in ('leased','running'))
  and not exists(select 1 from action_approvals p where p.run_id=r.id and p.status in ('pending','approved','executing','failed'))
  and not exists(select 1 from side_effect_receipts e where e.project_id=r.id::text and e.status<>'completed'
   and not ((e.project_id||':'||e.idempotency_key)=any($5::text[])))
  order by r.id for update of r`,[ids,input.projectId,input.sourceRunId,q.family_id,reconciledKeys])).rows;
 if(runs.length!==ids.length)throw Error('Archive includes active, unrelated, unresolved or unbound work');
 for(const run of runs){
  const existing=await c.query(`select 1 from action_receipts where run_id=$1 and action_type='failed_run_dismissed'
   and metadata->>'coordinatorArchiveAuthorizationUri'=$2`,[run.id,input.authorizationArtifactUri]);
  if(existing.rowCount)continue;
  await appendActionReceipt(c,{runId:run.id,agentId:'workflow-orchestrator',actionType:'failed_run_dismissed',target:run.id,
   summary:'Direct human archived an obsolete terminal attempt after independent original-requirement verification; immutable history and terminal status preserved.',
   metadata:JSON.stringify({actor:'direct-human',priorStatus:run.status,archiveOnly:true,coordinatorArchiveAuthorizationUri:input.authorizationArtifactUri,
    supersededBy:input.reviewRunId,claimId:input.claimId,claimFence:input.claimFence,workflowAcceptanceChanged:false})});
 }
 return ids;
}

export async function restoreVerifiedCoordinatorHistoryOnClient(c:Client,input:CoordinatorHistoryArchiveInput):Promise<string[]> {
 const ids=exactIds(input.runIds,input.reviewRunId);
 await c.query('select pg_advisory_xact_lock(hashtext($1))',[input.projectId]);
 const reconciledKeys=await archiveReconciledEffectKeys(c,ids);
 const q=(await c.query(`select q.*,r.evaluation_metadata metadata from queue_coordinator_assignments q join workflow_runs r on r.id=q.child_run_id
  where q.id=$1 and q.fence=$2::bigint and q.project_id=$3 and q.source_run_id=$4 and q.child_run_id=$5
  and q.role='verifier' and q.state='verified' for update of q`,[input.claimId,input.claimFence,input.projectId,input.sourceRunId,input.reviewRunId])).rows[0];
 if(!q)throw Error('Restore requires the exact independently verified assignment');
 const intent=(await c.query(`select file_scopes from work_intents where project_id=$1 and owner=$2 and fencing_token=$3::bigint
  and expires_at>clock_timestamp() for update`,[input.projectId,input.owner,input.intentFence])).rows[0];
 if(!intent||acceptanceDigest(intent.file_scopes)!==acceptanceDigest(q.file_scopes))throw Error('Restore requires a fresh exact-scope intent');
 const authorization=(await c.query(`select content from artifacts where run_id=$1 and uri=$2 and kind='coordinator_history_restore_authorization'`,[input.sourceRunId,input.authorizationArtifactUri])).rows;
 const a=authorization.length===1?authorization[0].content:null;
 if(!a||a.version!==1||a.authority!=='direct-human'||a.approvalDecision!=='approved'||a.restoreViewOnly!==true||a.executionAuthorityGranted!==false
  ||typeof a.approvalEvidence!=='string'||!a.approvalEvidence.trim()||a.projectId!==input.projectId||a.sourceRunId!==input.sourceRunId
  ||a.reviewRunId!==input.reviewRunId||a.claimId!==input.claimId||a.claimFence!==input.claimFence||a.owner!==input.owner||a.intentFence!==input.intentFence
  ||!Array.isArray(a.runIds)||acceptanceDigest([...a.runIds].sort())!==acceptanceDigest(ids))throw Error('Exact direct-human restore authorization is missing');
 const audited=await c.query(`select 1 from action_receipts where run_id=$1 and action_type='operator_coordinator_history_restore_authorized'
  and target=$2 and metadata=$3::jsonb`,[input.sourceRunId,input.authorizationArtifactUri,JSON.stringify(a)]);
 if(audited.rowCount!==1)throw Error('Restore authorization lacks its exact audit receipt');
 if(!await verifyIndependentAcceptanceReviewOnClient(c,{sourceRunId:input.sourceRunId,reviewRunId:input.reviewRunId,
  authorizationArtifactUri:q.metadata?.independentReviewAuthorizationUri,claimId:input.claimId,claimFence:input.claimFence}))throw Error('Independent original-requirement acceptance is no longer valid');
 const runs=(await c.query(`select r.id::text,r.status,arch.id::text archive_receipt_id from workflow_runs r
  join lateral(select d.id,d.created_at from action_receipts d where d.run_id=r.id and d.action_type='failed_run_dismissed'
   and d.metadata->>'archiveOnly'='true' and d.metadata->>'supersededBy'=$5 order by d.created_at desc limit 1) arch on true
  where r.id=any($1::uuid[]) and r.project_id=$2 and (r.id=$3 or exists(select 1 from queue_coordinator_assignments old
   where old.child_run_id=r.id and old.source_run_id=$3 and old.project_id=$2 and old.family_id=$4))
  and r.status in ('failed','blocked','cancelled') and not exists(select 1 from workflow_tasks t where t.run_id=r.id and t.status in ('leased','running'))
  and not exists(select 1 from action_approvals p where p.run_id=r.id and p.status in ('pending','approved','executing','failed'))
  and not exists(select 1 from side_effect_receipts e where e.project_id=r.id::text and e.status<>'completed'
   and not ((e.project_id||':'||e.idempotency_key)=any($6::text[]))) order by r.id for update of r`,
  [ids,input.projectId,input.sourceRunId,q.family_id,input.reviewRunId,reconciledKeys])).rows;
 if(runs.length!==ids.length)throw Error('Restore includes active, unrelated, unresolved, unarchived or unbound work');
 for(const run of runs){
  const existing=await c.query(`select 1 from action_receipts where run_id=$1 and action_type='failed_run_reinstated'
   and metadata->>'coordinatorRestoreAuthorizationUri'=$2`,[run.id,input.authorizationArtifactUri]);
  if(existing.rowCount)continue;
  await appendActionReceipt(c,{runId:run.id,agentId:'workflow-orchestrator',actionType:'failed_run_reinstated',target:run.id,
   summary:'Direct human restored an archived terminal attempt to active views; immutable status and execution authority remain unchanged.',
   metadata:JSON.stringify({actor:'direct-human',priorStatus:run.status,restoreViewOnly:true,executionAuthorityGranted:false,
    coordinatorRestoreAuthorizationUri:input.authorizationArtifactUri,archiveReceiptId:run.archive_receipt_id,
    supersededBy:input.reviewRunId,claimId:input.claimId,claimFence:input.claimFence,workflowAcceptanceChanged:false})});
 }
 return ids;
}

export async function authorizeCoordinatorHistoryActionOnClient(c:Client,input:CoordinatorHistoryAuthorizationInput,action:'archive'|'restore'):Promise<string[]>{
 await c.query('select pg_advisory_xact_lock(hashtext($1))',[input.projectId]);
 const ids=exactIds(input.runIds,input.reviewRunId),archive=action==='archive';
 const expected=archive?COORDINATOR_HISTORY_ARCHIVE_CONFIRMATION:COORDINATOR_HISTORY_RESTORE_CONFIRMATION;
 if(input.confirmation!==expected||!input.reason.trim()||!input.actor.trim())throw Error(`Exact human confirmation required: ${expected}`);
 const uri=`db://workflow_runs/${input.sourceRunId}/coordinator_history_${action}_authorization/${randomUUID()}`;
 const content={version:1,authority:'direct-human',approvalDecision:'approved',projectId:input.projectId,sourceRunId:input.sourceRunId,
  reviewRunId:input.reviewRunId,claimId:input.claimId,claimFence:input.claimFence,owner:input.owner,intentFence:input.intentFence,runIds:ids,
  approvalEvidence:input.reason,requestedBy:input.actor,confirmation:input.confirmation,...(archive?{archiveOnly:true}:{restoreViewOnly:true,executionAuthorityGranted:false})};
 const kind=`coordinator_history_${action}_authorization`,receipt=`operator_coordinator_history_${action}_authorized`;
 await c.query('insert into artifacts(run_id,kind,uri,content) values($1,$2,$3,$4::jsonb)',[input.sourceRunId,kind,uri,JSON.stringify(content)]);
 await appendActionReceipt(c,{runId:input.sourceRunId,agentId:'workflow-orchestrator',actionType:receipt,target:uri,
  summary:archive?'Explicit human request to archive an exact obsolete run list from active views.':'Explicit human request to restore an exact archived run list to active views.',metadata:JSON.stringify(content)});
 const bounded={...input,authorizationArtifactUri:uri};
 return archive?archiveVerifiedCoordinatorHistoryOnClient(c,bounded):restoreVerifiedCoordinatorHistoryOnClient(c,bounded);
}

export async function authorizeCoordinatorHistoryAction(input:CoordinatorHistoryAuthorizationInput,action:'archive'|'restore'):Promise<string[]>{
 return withClient(async c=>{await c.query('begin');try{const result=await authorizeCoordinatorHistoryActionOnClient(c,input,action);await c.query('commit');return result;}catch(error){await c.query('rollback');throw error;}});
}
export async function archiveVerifiedCoordinatorHistory(input:CoordinatorHistoryArchiveInput):Promise<string[]> {
 return withClient(async c=>{await c.query('begin');try{const result=await archiveVerifiedCoordinatorHistoryOnClient(c,input);await c.query('commit');return result;}catch(error){await c.query('rollback');throw error;}});
}
