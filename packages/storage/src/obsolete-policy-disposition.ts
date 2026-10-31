import {archiveReconciledEffectKeys,retainedHumanReconciliationAuthority} from './rejected-write-reconciliation.js';
import {randomUUID} from 'node:crypto';
import {computeReceiptHash} from '../../workflow-engine/src/receipt-chain.js';
import type {Client} from 'pg';
import {withClient} from './client.js';
import {acceptanceDigest} from './acceptance.js';
import {appendActionReceipt} from './receipt-writer.js';
import {verifyIndependentAcceptanceReviewOnClient} from './independent-acceptance-review.js';
import {verifyRunReceiptChainOnClient} from './postgres.js';

export const OBSOLETE_POLICY_CONFIRMATION='Retire obsolete policy contract without acceptance.';
export interface ObsoletePolicyDispositionInput {
 projectId:string;runId:string;originalTaskDigest:string;reviewSourceRunId:string;reviewRunId:string;
 claimId:string;claimFence:string;owner:string;intentFence:string;actor:string;reason:string;
 supersedingInstruction:string;confirmation:string;authorizationArtifactUri:string;
}
export function validObsoletePolicyDecision(input:ObsoletePolicyDispositionInput):boolean {
 return input.confirmation===OBSOLETE_POLICY_CONFIRMATION&&Boolean(input.actor.trim()&&input.reason.trim()&&input.supersedingInstruction.trim())
  &&/^[a-f0-9]{64}$/u.test(input.originalTaskDigest)&&input.runId!==input.reviewRunId&&input.runId!==input.reviewSourceRunId;
}
/** Explicit view retirement of one obsolete policy contract, never a successful
 * execution, original-requirement acceptance, contract rewrite or grant refund.
 * A separately accepted current-policy source is linked as evidence, not as
 * retroactive fulfillment of the historical contradictory requirements. */
export async function retireObsoletePolicyOnClient(c:Client,input:ObsoletePolicyDispositionInput):Promise<string>{
 if(!validObsoletePolicyDecision(input))throw Error('Exact direct-human obsolete-policy decision required');
 await c.query('select pg_advisory_xact_lock(hashtext($1))',[input.projectId]);
 const run=(await c.query(`select id,task,status,evaluation_metadata from workflow_runs where id=$1 and project_id=$2 for update`,[input.runId,input.projectId])).rows[0];
 if(!run||!['failed','blocked','cancelled'].includes(run.status)||acceptanceDigest(run.task)!==input.originalTaskDigest
  ||run.evaluation_metadata?.acceptance==='accepted')throw Error('Exact unaccepted terminal historical contract required');
 const intent=(await c.query(`select 1 from work_intents where project_id=$1 and owner=$2 and fencing_token=$3::bigint
  and expires_at>clock_timestamp() and file_scopes=$4::jsonb for update`,
  [input.projectId,input.owner,input.intentFence,JSON.stringify([`runtime/policy-disposition/${input.runId}`])])).rowCount;
 if(!intent)throw Error('Fresh exact policy-disposition intent required');
 if(!await retainedHumanReconciliationAuthority(c,input.runId,input.authorizationArtifactUri))throw Error('Retained direct-human prerequisite authorization missing');
 const family=(await c.query(`with recursive family(id) as (
  select id from workflow_runs where id=$1 and project_id=$2
  union select r.id from workflow_runs r join family f on r.project_id=$2 and (
   r.evaluation_metadata->>'sourceRunId'=f.id::text or r.evaluation_metadata->>'replayOfRunId'=f.id::text
   or r.evaluation_metadata->>'repairOriginRunId'=f.id::text or r.evaluation_metadata->>'parentRunId'=f.id::text
   or r.replacement_run_id=f.id or r.id=(select old.replacement_run_id from workflow_runs old where old.id=f.id)
   or (r.run_set_id is not null and r.run_set_id=(select old.run_set_id from workflow_runs old where old.id=f.id))
   or exists(select 1 from queue_coordinator_assignments q where q.project_id=$2 and q.source_run_id=f.id and q.child_run_id=r.id))
 ) select r.id::text from workflow_runs r where r.id in(select id from family) order by r.id for update of r`,[input.runId,input.projectId])).rows.map(r=>r.id as string);
 const reconciled=await archiveReconciledEffectKeys(c,family);
 const unresolved=await c.query(`select 1 where exists(select 1 from workflow_runs where id=any($1::uuid[]) and status in ('queued','leased','running'))
  or exists(select 1 from workflow_tasks where run_id=any($1::uuid[]) and status in ('queued','leased','running'))
  or exists(select 1 from action_approvals where run_id=any($1::uuid[]) and status in ('pending','approved','executing','failed'))
  or exists(select 1 from queue_coordinator_assignments where (source_run_id=any($1::uuid[]) or child_run_id=any($1::uuid[])) and state in ('reserved','running','uncertain'))
  or exists(select 1 from side_effect_receipts where project_id=any($2::text[]) and status<>'completed'
   and not ((project_id||':'||idempotency_key)=any($3::text[])))`,[family,family,reconciled]);
 if(unresolved.rowCount)throw Error('Active or unresolved historical work cannot be retired');
 const q=(await c.query(`select q.*,r.evaluation_metadata metadata from queue_coordinator_assignments q
  join workflow_runs r on r.id=q.child_run_id where q.id=$1 and q.fence=$2::bigint and q.project_id=$3
  and q.source_run_id=$4 and q.child_run_id=$5 and q.role='verifier' and q.state='verified' for update of q`,
  [input.claimId,input.claimFence,input.projectId,input.reviewSourceRunId,input.reviewRunId])).rows[0];
 if(!q||!await verifyIndependentAcceptanceReviewOnClient(c,{sourceRunId:input.reviewSourceRunId,reviewRunId:input.reviewRunId,
  authorizationArtifactUri:q.metadata?.independentReviewAuthorizationUri,claimId:input.claimId,claimFence:input.claimFence})
  ||!(await verifyRunReceiptChainOnClient(c,input.runId)).valid)throw Error('Current-policy independent acceptance or historical chain is unavailable');
 for(const memberId of family){
  const chain=await verifyRunReceiptChainOnClient(c,memberId);
  if(!chain.valid)throw Error(`Historical family full receipt coverage unavailable: ${memberId}: ${chain.reason}`);
 }
 const snapshots=(await c.query('select id::text,task,status from workflow_runs where id=any($1::uuid[]) order by id',[family])).rows;
 const familySnapshotDigest=acceptanceDigest(snapshots);
 const decisionDigest=acceptanceDigest({...input,owner:undefined,intentFence:undefined});
 const prior=(await c.query(`select uri,content from artifacts where run_id=$1 and kind='obsolete_policy_disposition'`,[input.runId])).rows;
 if(prior.length){if(prior.length!==1||prior[0].content.decisionDigest!==decisionDigest||prior[0].content.familySnapshotDigest!==familySnapshotDigest)throw Error('Historical policy already has a different disposition');return prior[0].uri;}
 const uri=`db://workflow_runs/${input.runId}/obsolete_policy_disposition/${randomUUID()}`;
 const content={version:1,decisionDigest,familySnapshotDigest,familySnapshot:snapshots,reconciledEffectKeys:reconciled,authority:'direct-human',approvalDecision:'approved',...input,
  historicalStatus:run.status,originalTask:run.task,familyRunIds:family,originalAcceptanceChanged:false,originalContractChanged:false,executionAuthorityGranted:false,
  disposition:'obsolete-policy-unaccepted',viewOnly:true};
 for(const member of snapshots){
  if(!['failed','blocked','cancelled'].includes(member.status))continue;
  const memberUri=member.id===input.runId?uri:`db://workflow_runs/${member.id}/obsolete_policy_disposition/${randomUUID()}`;
  const bound=member.id===input.runId?content:{...content,runId:member.id,originalTask:member.task,
   originalTaskDigest:acceptanceDigest(member.task),historicalStatus:member.status,sourcePolicyRunId:input.runId,parentDispositionUri:uri};
  await c.query('insert into artifacts(run_id,kind,uri,content) values($1,$2,$3,$4::jsonb)',[member.id,'obsolete_policy_disposition',memberUri,JSON.stringify(bound)]);
  await appendActionReceipt(c,{runId:member.id,agentId:'workflow-orchestrator',actionType:'obsolete_policy_contract_retired',target:member.id,
   summary:'Direct human retired an exactly bound obsolete policy family attempt from actionable views; original requirements remain unaccepted and immutable.',metadata:JSON.stringify(bound)});
 }
 return uri;
}
export async function retireObsoletePolicy(input:ObsoletePolicyDispositionInput):Promise<string>{
 return withClient(async c=>{await c.query('begin');try{const uri=await retireObsoletePolicyOnClient(c,input);await c.query('commit');return uri;}catch(error){await c.query('rollback');throw error;}});
}

export interface PolicyDispositionInvalidationInput {
 projectId:string;runId:string;dispositionUri:string;dispositionDigest:string;
 defectEvidenceUri:string;defectEvidenceDigest:string;owner:string;intentFence:string;actor:string;reason:string;
}
/** Correct a defective view-only retirement. This does not restore execution or
 * accept the historical contract, and never rewrites incomplete legacy chains. */
export async function invalidateObsoletePolicyOnClient(c:Client,input:PolicyDispositionInvalidationInput):Promise<string>{
 if(!input.actor.trim()||!input.reason.trim()||![input.dispositionDigest,input.defectEvidenceDigest].every(x=>/^[a-f0-9]{64}$/u.test(x)))throw Error('Exact disposition and defect bindings required');
 await c.query('select pg_advisory_xact_lock(hashtext($1))',[input.projectId]);
 const root=(await c.query('select id,project_id from workflow_runs where id=$1 and project_id=$2 for update',[input.runId,input.projectId])).rows[0];
 if(!root)throw Error('Exact historical project/run required');
 if(!(await c.query(`select 1 from work_intents where project_id=$1 and owner=$2 and fencing_token=$3::bigint and expires_at>clock_timestamp() and file_scopes=$4::jsonb for update`,[input.projectId,input.owner,input.intentFence,JSON.stringify([`runtime/policy-disposition/${input.runId}`])])).rowCount)throw Error('Fresh exact policy-disposition intent required');
 if(!(await verifyRunReceiptChainOnClient(c,input.runId)).valid)throw Error('Corrective root audit chain unavailable');
 const original=(await c.query("select content from artifacts where run_id=$1 and uri=$2 and kind='obsolete_policy_disposition'",[input.runId,input.dispositionUri])).rows[0]?.content;
 if(!original||acceptanceDigest(original)!==input.dispositionDigest||original.runId!==input.runId||original.projectId!==input.projectId||original.parentDispositionUri||original.executionAuthorityGranted!==false)throw Error('Exact root disposition unavailable');
 const evidence=(await c.query(`select a.content from artifacts a where a.run_id=$1 and a.uri=$2 and exists(select 1 from action_receipts r where r.run_id=a.run_id and r.metadata=a.content and r.receipt_hash is not null)`,[input.runId,input.defectEvidenceUri])).rows[0]?.content;
 if(!evidence||evidence.dispositionUri!==input.dispositionUri||acceptanceDigest(evidence)!==input.defectEvidenceDigest)throw Error('Retained defect evidence unavailable');
 const requestDigest=acceptanceDigest({...input,owner:undefined,intentFence:undefined});
 const prior=(await c.query("select a.uri,a.content from artifacts a where a.run_id=$1 and a.kind='obsolete_policy_disposition_invalidation' and exists(select 1 from action_receipts r where r.run_id=a.run_id and r.action_type='obsolete_policy_disposition_invalidated' and r.metadata=a.content and r.receipt_hash is not null)",[input.runId])).rows;
 if(prior.length){if(prior.length!==1||prior[0].content.requestDigest!==requestDigest)throw Error('Different disposition invalidation already exists');return prior[0].uri;}
 const members=original.familySnapshot;
 if(!Array.isArray(members)||!members.length||acceptanceDigest(members)!==original.familySnapshotDigest)throw Error('Exact disposition family snapshot unavailable');
 const report=[];
 for(const member of members){
  const live=(await c.query('select id::text,task,status from workflow_runs where id=$1 and project_id=$2 for update',[member.id,input.projectId])).rows[0];
  if(!live||acceptanceDigest(live)!==acceptanceDigest(member))throw Error('Disposition member snapshot changed');
  let retirementReceipt:null|{id:string;hash:string;dispositionUri:string}=null;
  if(['failed','blocked','cancelled'].includes(member.status)){
   const receipts=(await c.query(`select r.*,a.uri from action_receipts r join artifacts a on a.run_id=r.run_id and a.kind='obsolete_policy_disposition' and a.content=r.metadata
    where r.run_id=$1 and r.action_type='obsolete_policy_contract_retired' and r.receipt_hash is not null
    and (a.uri=$2 or a.content->>'parentDispositionUri'=$2) and a.content->>'originalTask'=$3 and a.content->>'projectId'=$4`,[member.id,input.dispositionUri,member.task,input.projectId])).rows;
   if(receipts.length!==1)throw Error('Exact member retirement receipt unavailable');
   const receipt=receipts[0];
   if(!receipt.prev_hash||computeReceiptHash(receipt.prev_hash,{runId:member.id,agentId:receipt.agent_id,actionType:receipt.action_type,target:receipt.target,summary:receipt.summary,metadata:JSON.stringify(receipt.metadata),metadataSerializationVersion:receipt.metadata_serialization_version??undefined,createdAt:receipt.created_at.toISOString()})!==receipt.receipt_hash)throw Error('Member retirement receipt hash mismatch');
   retirementReceipt={id:receipt.id,hash:receipt.receipt_hash,dispositionUri:receipt.uri};
  }
  report.push({runId:member.id,originalTaskDigest:acceptanceDigest(member.task),historicalStatus:member.status,retirementReceipt,chain:await verifyRunReceiptChainOnClient(c,member.id)});
 }
 if(!report.some(m=>m.runId===evidence.affectedChild&&!m.chain.valid&&acceptanceDigest(m.chain)===acceptanceDigest(evidence.independentChainResult)))throw Error('No current independently bound full-coverage defect established');
 const uri=`db://workflow_runs/${input.runId}/obsolete_policy_disposition_invalidation/${randomUUID()}`;
 const content={version:1,...input,requestDigest,memberReport:report,disposition:'invalidated-policy-retirement',viewOnly:true,manualReconciliationRequired:true,executionAuthorityGranted:false,originalAcceptanceChanged:false,originalContractChanged:false,historyRewritten:false};
 await c.query('insert into artifacts(run_id,kind,uri,content) values($1,$2,$3,$4::jsonb)',[input.runId,'obsolete_policy_disposition_invalidation',uri,JSON.stringify(content)]);
 await appendActionReceipt(c,{runId:input.runId,agentId:'workflow-orchestrator',actionType:'obsolete_policy_disposition_invalidated',target:input.dispositionUri,summary:'Defective view retirement invalidated; family requires manual evidence reconciliation and receives no execution authority.',metadata:JSON.stringify(content)});
 return uri;
}
export async function invalidateObsoletePolicy(input:PolicyDispositionInvalidationInput):Promise<string>{
 return withClient(async c=>{await c.query('begin');try{const uri=await invalidateObsoletePolicyOnClient(c,input);await c.query('commit');return uri;}catch(error){await c.query('rollback');throw error;}});
}
