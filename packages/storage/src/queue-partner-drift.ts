import type {Client} from 'pg';
import fs from 'node:fs/promises';
import {withClient} from './client.js';
import {acceptanceDigest} from './acceptance.js';
import {appendActionReceipt} from './receipt-writer.js';
import {transitionWorkflowRun} from './run-transitions.js';
import {sourceSubjectHash} from '../../workflow-engine/src/source-subject.js';
import {partnerReasoningReceiptValid} from './queue-partner-reasoning.js';

export interface PartnerDriftDisposition {
 assignmentId:string;childRunId:string;fence:string;owner:string;intentFence:string;
 authorizationId:string;currentSubjectHash:string;
}
interface Hooks {
 hash:typeof sourceSubjectHash;
 chain:(c:Client,id:string)=>Promise<boolean>;
 transition:typeof transitionWorkflowRun;
 receipt:typeof appendActionReceipt;
 canonical:(root:string)=>Promise<boolean>;
}
const defaults:Hooks={hash:sourceSubjectHash,canonical:async root=>await fs.realpath(root)===root,
 chain:async(c,id)=>{const {verifyRunReceiptChainOnClient}=await import('./postgres.js');return(await verifyRunReceiptChainOnClient(c,id)).valid;},
 transition:transitionWorkflowRun,receipt:appendActionReceipt};
const fail=(reason:string):never=>{throw Error('Partner drift disposition refused: '+reason);};
const equal=(a:unknown,b:unknown)=>acceptanceDigest(a)===acceptanceDigest(b);

/** Stop only a proven quiescent, source-drifted queued attempt. This is neither
 * successful recovery nor cancellation/replay. Keep the exact child, checkpoint,
 * source contract, effects, budgets, reservation fence and prior owner intact.
 * A later current-baseline execution still needs all ordinary acceptance gates.
 */
export async function holdDriftedPartnerChildOnClient(c:Client,input:PartnerDriftDisposition,hooks:Partial<Hooks>={}){
 const h={...defaults,...hooks};
 if(!input.owner||!input.authorizationId||!/^\d+$/u.test(input.fence)||!/^\d+$/u.test(input.intentFence)
  ||!/^[a-f0-9]{64}$/u.test(input.currentSubjectHash))fail('exact authorization, fences and current hash required');
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:workflow-task-scheduler'))");
 const q=(await c.query(`select q.*,q.project_id::text project_key,q.source_run_id::text source_id,
  q.fence::text claim_fence,p.root_uri,source.task original_task,source.run_set_id::text source_set,
  source.status source_status,child.status child_status,child.evaluation_metadata child_metadata,
  child.lease_expires_at>clock_timestamp() live_run_lease
  from queue_coordinator_assignments q join projects p on p.id=q.project_id
  join workflow_runs source on source.id=q.source_run_id and source.project_id=q.project_id
  join workflow_runs child on child.id=q.child_run_id and child.project_id=q.project_id
  where q.id=$1 and q.child_run_id=$2 for update of q,p,source,child`,[input.assignmentId,input.childRunId])).rows[0];
 if(!q||q.role!=='repair'||!['running','uncertain'].includes(q.state)||q.claim_fence!==input.fence
  ||q.child_status!=='running'||q.live_run_lease||!['blocked','failed','completed'].includes(q.source_status)
  ||q.family_id!==`${q.project_key}:${q.source_set}`||q.owner===input.owner)fail('exact interrupted assignment required');
 if(!await h.canonical(q.root_uri)||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(q.root_uri)
  ||!(await c.query("select 1 from project_identity_locations where project_id=$1 and identity_id=project_id and kind='canonical'",[q.project_key])).rowCount)fail('canonical project required');
 const m=q.child_metadata,paths=m?.recoveryWritePaths;
 if(m?.source!=='queue-partner-recovery'||m.sourceRunId!==q.source_id||m.queueCoordinatorClaimId!==input.assignmentId
  ||m.queueCoordinatorFence!==input.fence||m.recoveryTaskHash!==acceptanceDigest(q.original_task)
  ||!Array.isArray(paths)||!paths.length||!equal(paths,q.file_scopes)||!/^[a-f0-9]{64}$/u.test(m.recoverySubjectHash??''))fail('frozen child binding mismatch');
 const tasks=(await c.query(`select id::text,status,worker_id,lease_generation::text,
  lease_expires_at>clock_timestamp() live_lease from workflow_tasks where run_id=$1 for update`,[input.childRunId])).rows;
 if(tasks.length!==1||tasks[0].status!=='queued'||tasks[0].worker_id||tasks[0].live_lease)fail('child worker is not proven quiescent');
 const intent=(await c.query(`select file_scopes from work_intents where project_id=$1 and owner=$2
  and fencing_token::text=$3 and expires_at>clock_timestamp() for update`,[q.project_key,input.owner,input.intentFence])).rows[0];
 if(!intent||!equal(intent.file_scopes,q.file_scopes)
  ||(await c.query('select 1 from work_intents where project_id=$1 and owner=$2 and expires_at>clock_timestamp()',[q.project_key,q.owner])).rowCount)fail('fresh exact intent and expired prior owner required');
 if((await c.query("select 1 from action_approvals where run_id in ($1,$2) and status in ('pending','approved','executing') limit 1",[q.source_id,input.childRunId])).rowCount
  ||(await c.query("select 1 from side_effect_receipts where project_id=$1 and status<>'completed' limit 1",[input.childRunId])).rowCount)fail('approval or unresolved effect remains');
 const auth=(await c.query(`select metadata,receipt_hash from action_receipts where run_id=$1
  and action_type='operator_legacy_recovery_authorized' and metadata->>'authorizationId'=$2`,[q.source_id,input.authorizationId])).rows;
 const a=auth[0]?.metadata;
 if(auth.length!==1||!/^[a-f0-9]{64}$/u.test(auth[0].receipt_hash??'')||a?.approvalSource!=='direct-human'
  ||a.approvalDecision!=='approved'||a.offlineOnly!==true||a.sourceRunId!==q.source_id||a.projectId!==q.project_key
  ||a.familyId!==q.family_id||a.taskHash!==acceptanceDigest(q.original_task)
  ||!Array.isArray(a.sourcePaths)||!equal([...a.sourcePaths].sort(),[...paths].sort()))fail('exact direct-human current-source authority required');
 const proof=(await c.query(`select * from action_receipts where run_id=$1
  and action_type='queue_partner_reasoning_reserved' and target=$2`,[q.source_id,input.assignmentId])).rows;
 if(proof.length!==1||!partnerReasoningReceiptValid(proof[0],{sourceRunId:q.source_id,projectId:q.project_key,
  familyId:q.family_id,claimId:input.assignmentId,fence:input.fence,taskHash:acceptanceDigest(q.original_task)})
  ||proof[0].metadata.sourceHash!==m.recoverySubjectHash||!equal(proof[0].metadata.writePaths,paths)
  ||m.workIntent?.owner!==proof[0].metadata.owner||m.workIntent?.fencingToken!==proof[0].metadata.intentFence)fail('original reservation proof invalid');
 if(!await h.chain(c,q.source_id)||!await h.chain(c,input.childRunId))fail('receipt chain invalid');
 const current=await h.hash(q.root_uri,paths);
 if(current!==input.currentSubjectHash||current===m.recoverySubjectHash)fail('current source drift not proven');
 const checkpoint=(await c.query("select uri,content from artifacts where run_id=$1 and kind='stage_continuation' order by created_at limit 2",[input.childRunId])).rows;
 if(checkpoint.length>1)fail('ambiguous checkpoint');
 const evidence={...input,sourceRunId:q.source_id,projectId:q.project_key,sourcePaths:paths,
  originalSubjectHash:m.recoverySubjectHash,priorOwner:q.owner,priorIntentFence:q.intent_fence,
  taskId:tasks[0].id,leaseGeneration:tasks[0].lease_generation,
  checkpointUri:checkpoint[0]?.uri??null,checkpointDigest:acceptanceDigest(checkpoint[0]?.content??null),
  authorizationReceiptHash:auth[0].receipt_hash,acceptance:'unverified',
  replayed:false,cancelled:false,snapshotsChanged:false,budgetRefunded:false};
 if(await h.hash(q.root_uri,paths)!==current)fail('source changed during observation');
 const reason='Quiescent queued Partner attempt held after authorized current-source drift observation; no replay or acceptance.';
 const task=await c.query(`update workflow_tasks set status='blocked',finished_at=coalesce(finished_at,clock_timestamp())
  where id=$1 and run_id=$2 and status='queued' and worker_id is null
   and (lease_expires_at is null or lease_expires_at<=clock_timestamp()) returning id`,[tasks[0].id,input.childRunId]);
 if(task.rowCount!==1)fail('task acquired execution before disposition');
 await h.transition(c,{runId:input.childRunId,to:'blocked',actor:'workflow-orchestrator',reason,
  idempotencyKey:`partner-source-drift:${input.assignmentId}:${input.authorizationId}`,metadata:evidence});
 const assignment=await c.query(`update queue_coordinator_assignments set state='held',reason=$4,updated_at=clock_timestamp()
  where id=$1 and fence::text=$2 and child_run_id=$3 and state in ('running','uncertain') returning id`,
  [input.assignmentId,input.fence,input.childRunId,reason]);
 if(assignment.rowCount!==1)fail('assignment changed');
 for(const runId of [q.source_id,input.childRunId]){
  await h.receipt(c,{runId,agentId:'workflow-orchestrator',actionType:'queue_partner_source_drift_held',
   target:input.assignmentId,summary:reason,metadata:JSON.stringify(evidence)});
  await c.query('insert into artifacts(run_id,kind,uri,content) values($1,$2,$3,$4::jsonb)',
   [runId,'queue_partner_source_drift_held',`db://workflow_runs/${runId}/queue_partner_source_drift_held/${input.assignmentId}/${input.authorizationId}`,JSON.stringify(evidence)]);
 }
 return evidence;
}
export const holdDriftedPartnerChild=(input:PartnerDriftDisposition)=>withClient(async c=>{
 await c.query('begin');try{const result=await holdDriftedPartnerChildOnClient(c,input);await c.query('commit');return result;}
 catch(error){await c.query('rollback');throw error;}
});
