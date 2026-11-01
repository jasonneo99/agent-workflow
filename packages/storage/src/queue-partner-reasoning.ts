import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import type {Client} from 'pg';
import {withClient} from './client.js';
import {acceptanceDigest} from './acceptance.js';
import {appendActionReceipt} from './receipt-writer.js';
import type {CoordinatorClaim} from './queue-coordinator.js';
import {queueWorkingOccupancyOnClient} from './queue-coordinator.js';
import {loadProjectConfig} from '../../agent-registry/src/loaders.js';
import {resolveExecutionPolicy,canonicalJsonHash} from '../../policy-engine/src/index.js';
import {assertFilePathAllowed} from '../../local-tools/src/file-writer.js';
import {sourceSubjectHash} from '../../workflow-engine/src/source-subject.js';
import {computeReceiptHash} from '../../workflow-engine/src/receipt-chain.js';
import {activeQueueSourceOnClient} from './queue-source-membership.js';

export interface PartnerReasoningReservation {
 projectId:string;projectRootUri:string;sourceRunId:string;familyId:string;
 owner:string;intentFence:string;fileScopes:string[];fingerprint:string;
 taskHash:string;policyHash:string;sourceHash:string|null;writePaths:string[];
 requiresVerifierSlot?:boolean;
}
const active="('reserved','running','uncertain')";
/** Lifetime ledger, not a per-watch or per-fingerprint counter. */
export const PARTNER_RECOVERY_LIFETIME_LIMIT=5;
export function exactPartnerPaths(value:unknown):value is string[]{
 return Array.isArray(value)&&value.length<=40&&new Set(value).size===value.length&&value.every(p=>typeof p==='string'&&p.length>0&&p.length<=500
  &&!p.startsWith('/')&&!/^[a-z]:/iu.test(p)&&!/[\\*?\[\]{}\u0000-\u001f]/u.test(p)&&!p.split('/').some(v=>!v||v==='.'||v==='..')
  &&!/(^|\/)(?:vendor|node_modules|\.git|\.env(?:\..*)?|secrets?|credentials?|id_rsa|id_ed25519)(\/|$)/iu.test(p));
}
/** A reasoning reservation is NOT historical acceptance enrollment. It shares
 * the real family/lane indexes, uncertainty fencing and total capacity. Missing
 * old contracts may inhibit writes, but cannot prevent read-only investigation.
 * Current disk policy, canonical filesystem identity and source are checked
 * again here; a caller's plan or suggested scope cannot grant permission.
 */
export async function reservePartnerReasoningOnClient(c:Client,input:PartnerReasoningReservation):Promise<CoordinatorClaim|null>{
 if(!exactPartnerPaths(input.writePaths)||!exactPartnerPaths(input.fileScopes)||!input.fileScopes.length
  ||!input.owner||!/^\d+$/u.test(input.intentFence)||![input.fingerprint,input.taskHash,input.policyHash].every(v=>/^[a-f0-9]{64}$/u.test(v))
  ||(input.sourceHash!==null&&!/^[a-f0-9]{64}$/u.test(input.sourceHash))
  ||(input.requiresVerifierSlot!==undefined&&typeof input.requiresVerifierSlot!=='boolean')
  ||(input.writePaths.length>0)!==(input.sourceHash!==null))throw Error('Invalid Partner reasoning binding');
 const expected=input.writePaths.length?input.writePaths:[`runtime/queue-partner/recovery/${input.sourceRunId}`];
 if(acceptanceDigest([...expected].sort())!==acceptanceDigest([...input.fileScopes].sort()))throw Error('Reasoning intent does not cover its exact effects');
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 const row=(await c.query(`select r.id::text,r.project_id::text,r.run_set_id::text,r.task,r.status,r.policy_profile,r.evaluation_metadata metadata,p.root_uri
  from workflow_runs r join projects p on p.id=r.project_id where r.id=$1 for update of r,p`,[input.sourceRunId])).rows[0];
 if(!row||row.project_id!==input.projectId||row.root_uri!==input.projectRootUri||input.familyId!==`${row.project_id}:${row.run_set_id}`
  ||acceptanceDigest(row.task)!==input.taskHash||!['failed','blocked','completed'].includes(row.status)
  ||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(row.root_uri)
  ||['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'].some(k=>Object.hasOwn(row.metadata??{},k))
  ||row.metadata?.suiteId||row.metadata?.evaluationId||/eval(?:uation)?|training/iu.test(String(row.metadata?.source??'')))return null;
 if(!await activeQueueSourceOnClient(c,input.sourceRunId))return null;
 if(!(await c.query("select 1 from project_identity_locations where project_id=$1 and identity_id=project_id and kind='canonical'",[input.projectId])).rowCount)return null;
 if(await fs.realpath(input.projectRootUri)!==input.projectRootUri)return null;
 const policy=resolveExecutionPolicy(await loadProjectConfig(input.projectRootUri),row.policy_profile).project;
 if(canonicalJsonHash(policy)!==input.policyHash)return null;
 const requiresVerifierSlot=input.writePaths.length>0&&policy.execution.repair_commits?.enabled===true;
 // A stale one-stage caller cannot reserve a newly opted-in repair pipeline.
 if(Boolean(input.requiresVerifierSlot)!==requiresVerifierSlot)return null;
 for(const file of input.writePaths)assertFilePathAllowed(file,policy);
 if(input.writePaths.length&&await sourceSubjectHash(input.projectRootUri,input.writePaths)!==input.sourceHash)return null;
 const intent=(await c.query(`select file_scopes,to_jsonb(i)->>'id' intent_id from work_intents i where project_id=$1 and owner=$2 and fencing_token::text=$3
  and expires_at>clock_timestamp() for update`,[input.projectId,input.owner,input.intentFence])).rows[0];
 if(!intent||acceptanceDigest([...(intent.file_scopes??[])].sort())!==acceptanceDigest([...input.fileScopes].sort()))return null;
 const busy=await c.query(`with recursive family(id) as (
  select id from workflow_runs where project_id=$1 and run_set_id=$2
  union select child.id from workflow_runs child join family parent on parent.id::text in (
   child.evaluation_metadata->>'sourceRunId',child.evaluation_metadata->>'replayOfRunId',child.evaluation_metadata->>'repairOriginRunId',child.evaluation_metadata->>'parentRunId')
 ) select 1 from workflow_runs where id in(select id from family) and status in ('queued','leased','running')
 union all select 1 from workflow_tasks where run_id in(select id from family) and status in ('leased','running')
 union all select 1 from action_approvals where run_id in(select id from family) and status in ('pending','executing') limit 1`,[input.projectId,row.run_set_id]);
 if(busy.rowCount)return null;
 const assignments=(await c.query(`select family_id,project_id::text,role,lane,file_scopes from queue_coordinator_assignments where state in ${active}`)).rows;
 const occupancy=await queueWorkingOccupancyOnClient(c);
 if(occupancy.count>=5||(requiresVerifierSlot&&occupancy.verifier)||occupancy.externalFamilyIds.includes(input.familyId)||assignments.some(a=>a.family_id===input.familyId))return null;
 if(assignments.some(a=>a.project_id===input.projectId&&(!exactPartnerPaths(a.file_scopes)||a.file_scopes.some((a:string)=>input.fileScopes.some(b=>a===b||a.startsWith(`${b}/`)||b.startsWith(`${a}/`))))))return null;
 if((await c.query('select 1 from queue_coordinator_assignments where family_id=$1 and role=\'repair\' and fingerprint=$2',[input.familyId,input.fingerprint])).rowCount)return null;
 // A fixed budget and semantic fingerprint are durable across watch restarts.
 if(Number((await c.query("select count(*)::int n from action_receipts where run_id=$1 and action_type='queue_partner_reasoning_reserved'",[input.sourceRunId])).rows[0].n)>=PARTNER_RECOVERY_LIFETIME_LIMIT)return null;
 const lane=[1,2,3,4,5].find(l=>!assignments.some(a=>a.role==='repair'&&a.lane===l));if(!lane)return null;
 const id=randomUUID(),inserted=await c.query(`insert into queue_coordinator_assignments
  (id,family_id,project_id,source_run_id,role,lane,owner,fingerprint,intent_fence,file_scopes,state)
  values($1,$2,$3,$4,'repair',$5,$6,$7,$8,$9::jsonb,'reserved') returning fence::text`,
  [id,input.familyId,input.projectId,input.sourceRunId,lane,input.owner,input.fingerprint,input.intentFence,JSON.stringify(input.fileScopes)]);
 const claim:CoordinatorClaim={...input,intentId:intent.intent_id??undefined,id,fence:inserted.rows[0].fence,role:'repair',lane};
 const proof={...claim,purpose:'autonomous-recovery',writePaths:input.writePaths,taskHash:input.taskHash,policyHash:input.policyHash,sourceHash:input.sourceHash,
  recoveryProtocolVersion:2,lifetimeTurnLimit:PARTNER_RECOVERY_LIFETIME_LIMIT,acceptance:'unverified',historicalContractChanged:false};
 await appendActionReceipt(c,{runId:input.sourceRunId,agentId:'workflow-orchestrator',actionType:'queue_partner_reasoning_reserved',target:id,
  summary:'Partner owns one model-backed recovery turn; original history and acceptance remain unchanged.',metadata:JSON.stringify(proof)});
 await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'queue_partner_reasoning_reserved',$2,$3::jsonb)",[input.sourceRunId,`db://workflow_runs/${input.sourceRunId}/queue_partner_reasoning_reserved/${id}`,JSON.stringify(proof)]);
 return claim;
}
export async function reservePartnerReasoning(input:PartnerReasoningReservation){return withClient(async c=>{
 await c.query('begin');try{const claim=await reservePartnerReasoningOnClient(c,input);await c.query('commit');return claim;}catch(error){await c.query('rollback');throw error;}
});}

/** Verify this new reservation's actual hash segment, not a claim that missing
 * historical receipt provenance has been recovered or the old run accepted. */
export function partnerReasoningReceiptValid(receipt:any,expected:{sourceRunId:string;projectId:string;familyId:string;claimId:string;fence:string;taskHash:string}):boolean{
 try{
  const m=receipt?.metadata;
  if(receipt.run_id!==expected.sourceRunId||receipt.agent_id!=='workflow-orchestrator'||receipt.action_type!=='queue_partner_reasoning_reserved'
   ||receipt.target!==expected.claimId||m?.id!==expected.claimId||m.fence!==expected.fence||m.sourceRunId!==expected.sourceRunId
   ||m.projectId!==expected.projectId||m.familyId!==expected.familyId||m.taskHash!==expected.taskHash||m.purpose!=='autonomous-recovery'
   ||receipt.metadata_serialization_version!==2||typeof receipt.prev_hash!=='string'||typeof receipt.receipt_hash!=='string')return false;
  return computeReceiptHash(receipt.prev_hash,{runId:receipt.run_id,agentId:receipt.agent_id,actionType:receipt.action_type,target:receipt.target,
   summary:receipt.summary,metadata:JSON.stringify(m),metadataSerializationVersion:2,createdAt:new Date(receipt.created_at).toISOString()})===receipt.receipt_hash;
 }catch{return false;}
}

/** Read only outputs from an exact already-owned Partner child. A suggested
 * path selects work within current policy; it never creates a permission grant.
 */
export async function latestPartnerReasoningScopeOnClient(c:Client,sourceRunId:string):Promise<string[]>{
 const rows=(await c.query(`select child.id::text child_id,q.id::text claim_id,q.fence::text fence,q.project_id::text project_id,q.family_id,
  original.task,to_jsonb(proof) proof,child.status child_status,a.task_id::text task_id,a.uri,a.content,
  produced.agent_id producer_id,produced.metadata produced_metadata,
  coalesce(a.content->'artifact'->'proposedSourcePaths',a.content->'proposedSourcePaths') paths
  from (select * from queue_coordinator_assignments where source_run_id=$1 order by fence desc limit 1) q
  join workflow_runs child on child.id=q.child_run_id
  join workflow_runs original on original.id=q.source_run_id
  join artifacts a on a.run_id=child.id and a.kind='stage_output'
  join action_receipts proof on proof.run_id=q.source_run_id and proof.agent_id='workflow-orchestrator'
   and proof.action_type='queue_partner_reasoning_reserved' and proof.target=q.id::text
   and proof.metadata->>'fence'=q.fence::text and proof.metadata->>'taskHash'=child.evaluation_metadata->>'recoveryTaskHash'
  join action_receipts produced on produced.run_id=child.id and produced.agent_id=case
   when not(child.evaluation_metadata?'partnerWorkerTeam') then 'queue-partner'
   when child.evaluation_metadata->'partnerWorkerTeam'->>'schemaVersion'='1'
    and child.evaluation_metadata->'partnerWorkerTeam'->>'leaderAgentId'='queue-partner'
    and child.evaluation_metadata->'partnerWorkerTeam'->>'workflowId'='partner-recovery-'||(child.evaluation_metadata->'partnerWorkerTeam'->>'workerAgentId')
    and child.evaluation_metadata->'partnerWorkerTeam'->>'workerAgentId' in ('technical-architect','implementation-agent','frontend-engineer','backend-engineer','database-engineer','test-engineer','docs-maintainer')
   then child.evaluation_metadata->'partnerWorkerTeam'->>'workerAgentId' else null end
   and produced.target=a.task_id::text and (
    (child.status='completed' and produced.action_type='stage_completed' and produced.metadata=a.content)
    or (child.status='blocked' and produced.action_type='stage_blocked' and produced.metadata->>'outputUri'=a.uri
     and exists(select 1 from workflow_tasks task where task.id=a.task_id and task.run_id=child.id and task.status='blocked')))
  where child.status in ('completed','blocked')
   and child.evaluation_metadata->>'source'='queue-partner-recovery'
   and child.evaluation_metadata->>'sourceRunId'=q.source_run_id::text
   and child.evaluation_metadata->>'queueCoordinatorClaimId'=q.id::text
   and child.evaluation_metadata->>'queueCoordinatorFence'=q.fence::text
   and child.project_id=q.project_id
   and jsonb_typeof(coalesce(a.content->'artifact'->'proposedSourcePaths',a.content->'proposedSourcePaths'))='array'
  order by a.created_at desc limit 1`,[sourceRunId])).rows;
 if(!exactPartnerPaths(rows[0]?.paths))return [];
 const row=rows[0];
 // A blocked artifact is mutable storage. Only a new producer receipt can seal
 // its actual normalized bytes; old unsealed results never revive older scope.
 if(row.child_status==='blocked'&&(row.uri!==`db://workflow_tasks/${row.task_id}/output`
  ||row.produced_metadata?.outputDigest!==acceptanceDigest(row.content)
  ||row.content?.runId!==row.child_id||row.content?.taskId!==row.task_id
  ||row.content?.agentId!==row.producer_id||row.content?.outcome!=='blocked'))return [];
 if(!partnerReasoningReceiptValid(row.proof,{sourceRunId,projectId:row.project_id,familyId:row.family_id,
  claimId:row.claim_id,fence:row.fence,taskHash:acceptanceDigest(row.task)}))return [];
 const {verifyRunReceiptChainOnClient}=await import('./postgres.js');
 return (await verifyRunReceiptChainOnClient(c,rows[0].child_id)).valid?rows[0].paths:[];
}
export const latestPartnerReasoningScope=(sourceRunId:string)=>withClient(c=>latestPartnerReasoningScopeOnClient(c,sourceRunId));

export interface ReadOnlyPartnerReconciliation {
 assignmentId:string;fence:string;childRunId:string;authorizationUri:string;owner:string;intentFence:string;
}
function validStoredReceipt(row:any):boolean{
 try{return row?.metadata_serialization_version===2&&typeof row.prev_hash==='string'&&computeReceiptHash(row.prev_hash,{
  runId:row.run_id,agentId:row.agent_id,actionType:row.action_type,target:row.target,summary:row.summary,
  metadata:JSON.stringify(row.metadata),metadataSerializationVersion:2,createdAt:new Date(row.created_at).toISOString()})===row.receipt_hash;}catch{return false;}
}
/** Close only a proven terminal read-only discovery reservation, never a writer,
 * checkpoint continuation, replay or original acceptance. The operator must
 * acquire the exact scope after the prior intent expires and supply an audited
 * prospective authorization. No old lease, budget or historical result resets.
 */
export async function reconcileReadOnlyPartnerChildOnClient(c:Client,input:ReadOnlyPartnerReconciliation):Promise<boolean>{
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 const q=(await c.query(`select q.*,q.project_id::text project_key,q.source_run_id::text source_id,q.fence::text claim_fence,
  original.task,original.run_set_id::text run_set,child.status child_status,child.policy_snapshot,child.policy_snapshot_hash,
  child.evaluation_metadata child_metadata,p.root_uri,original.policy_profile
  from queue_coordinator_assignments q join workflow_runs original on original.id=q.source_run_id
  join workflow_runs child on child.id=q.child_run_id and child.project_id=q.project_id join projects p on p.id=q.project_id
  where q.id=$1 and q.fence::text=$2 and q.child_run_id=$3 for update of q,original,child,p`,[input.assignmentId,input.fence,input.childRunId])).rows[0];
 if(!q||q.state!=='uncertain'||q.role!=='repair'||!['completed','blocked'].includes(q.child_status)
  ||q.family_id!==`${q.project_key}:${q.run_set}`||acceptanceDigest(q.file_scopes)!==acceptanceDigest([`runtime/queue-partner/recovery/${q.source_id}`]))return false;
 const m=q.child_metadata,actions=q.policy_snapshot?.actions;
 if(m?.source!=='queue-partner-recovery'||m.sourceRunId!==q.source_id||m.queueCoordinatorClaimId!==input.assignmentId
  ||m.queueCoordinatorFence!==input.fence||m.recoveryTaskHash!==acceptanceDigest(q.task)||m.workIntent?.owner!==q.owner||m.workIntent?.fencingToken!==q.intent_fence
  ||!Array.isArray(m.recoveryWritePaths)||m.recoveryWritePaths.length||m.recoverySubjectHash!==null
  ||!Array.isArray(actions?.allowed_write_paths)||actions.allowed_write_paths.length
  ||!Array.isArray(actions.allowed_commands)||actions.allowed_commands.length
  ||!Array.isArray(actions.approval_rules)||actions.approval_rules.length
  ||canonicalJsonHash(q.policy_snapshot)!==q.policy_snapshot_hash)return false;
 if(!(await c.query("select 1 from project_identity_locations where project_id=$1 and identity_id=project_id and kind='canonical'",[q.project_key])).rowCount
  ||await fs.realpath(q.root_uri)!==q.root_uri||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(q.root_uri))return false;
 const policyHash=canonicalJsonHash(resolveExecutionPolicy(await loadProjectConfig(q.root_uri),q.policy_profile).project);
 const auth=(await c.query(`select a.content,to_jsonb(r) receipt from artifacts a join action_receipts r on r.run_id=a.run_id
  and r.agent_id='workflow-orchestrator' and r.action_type='operator_partner_terminal_reconciliation_authorized'
  and r.target=$2 and r.metadata=a.content where a.uri=$1 and a.run_id=$3 and a.kind='queue_partner_terminal_reconciliation_authorization'`,
  [input.authorizationUri,input.assignmentId,q.source_id])).rows[0];
 const a=auth?.content;
 if(!validStoredReceipt(auth?.receipt)||a?.purpose!=='close-terminal-read-only-reservation'||a.assignmentId!==input.assignmentId
  ||a.fence!==input.fence||a.childRunId!==input.childRunId||a.projectId!==q.project_key||a.owner!==input.owner
  ||a.intentFence!==input.intentFence||a.policyHash!==policyHash||a.originalAcceptanceChanged!==false)return false;
 const intent=(await c.query(`select file_scopes from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3
  and expires_at>clock_timestamp() for update`,[q.project_key,input.owner,input.intentFence])).rows[0];
 if(!intent||acceptanceDigest(intent.file_scopes)!==acceptanceDigest(q.file_scopes))return false;
 // Never take over another still-live owner, even with operator authorization.
 if((await c.query("select 1 from work_intents where project_id=$1 and owner=$2 and expires_at>clock_timestamp()",[q.project_key,q.owner])).rowCount)return false;
 const proof=(await c.query(`select * from action_receipts where run_id=$1 and action_type='queue_partner_reasoning_reserved' and target=$2`,[q.source_id,input.assignmentId])).rows[0];
 if(!partnerReasoningReceiptValid(proof,{sourceRunId:q.source_id,projectId:q.project_key,familyId:q.family_id,claimId:input.assignmentId,fence:input.fence,taskHash:acceptanceDigest(q.task)})
  ||proof.metadata.recoveryProtocolVersion!==2||proof.metadata.sourceHash!==null
  ||!Array.isArray(proof.metadata.writePaths)||proof.metadata.writePaths.length)return false;
 const forbidden=await c.query(`select 1 from action_receipts where run_id=$1 and action_type<>all($2::text[]) limit 1`,[input.childRunId,
  ['workflow_created','workflow_run_transition','workflow_run_lease_acquired','stage_leased','stage_started','stage_completed','stage_blocked',
   'file_read','file_search','file_read_rejected','file_search_rejected','model_route','context_influence','context_influence_result','execution_progress','requester_notified']]);
 if(forbidden.rowCount||(await c.query("select 1 from action_approvals where run_id in ($1,$2) and status in ('pending','approved','executing') limit 1",[input.childRunId,q.source_id])).rowCount)return false;
 const tasks=(await c.query(`select t.id,t.status,t.output_uri,a.content,exists(select 1 from action_receipts r where r.run_id=t.run_id
  and r.agent_id='queue-partner' and r.target=t.id::text and ((t.status='completed' and r.action_type='stage_completed' and r.metadata=a.content)
   or(t.status='blocked' and r.action_type='stage_blocked' and r.metadata->>'outputUri'=t.output_uri))) bound
  from workflow_tasks t left join artifacts a on a.run_id=t.run_id and a.task_id=t.id and a.kind='stage_output' and a.uri=t.output_uri where t.run_id=$1 for update of t`,[input.childRunId])).rows;
 if(!tasks.length||tasks.some(t=>!['completed','blocked'].includes(t.status)||!t.bound||!t.content
  ||['requestedCommands','requestedFileWrites','requestedFileReads','requestedFileSearches'].some(k=>!Array.isArray(t.content[k])||t.content[k].length)))return false;
 const {verifyRunReceiptChainOnClient}=await import('./postgres.js');
 if(!(await verifyRunReceiptChainOnClient(c,input.childRunId)).valid)return false;
 const updated=await c.query(`update queue_coordinator_assignments set state='held',reason=$3,updated_at=clock_timestamp()
  where id=$1 and fence::text=$2 and state='uncertain'
   and exists(select 1 from work_intents where project_id=$4 and owner=$5 and fencing_token::text=$6 and expires_at>clock_timestamp())
   and not exists(select 1 from work_intents where project_id=$4 and owner=$7 and expires_at>clock_timestamp())
   and not exists(select 1 from action_approvals where run_id in ($8,$9) and status in ('pending','approved','executing')) returning id`,
  [input.assignmentId,input.fence,'Terminal read-only evidence reconciled; original outcome and acceptance remain unresolved.',q.project_key,input.owner,input.intentFence,q.owner,input.childRunId,q.source_id]);
 if(updated.rowCount!==1)return false;
 const audit={...input,projectId:q.project_key,sourceRunId:q.source_id,priorState:q.state,priorReason:q.reason,childStatus:q.child_status,
  policyHash,childReceiptChainVerified:true,readOnlyEffectsVerified:true,originalAcceptanceChanged:false,historyRewritten:false,budgetRefunded:false};
 await appendActionReceipt(c,{runId:q.source_id,agentId:'workflow-orchestrator',actionType:'queue_partner_terminal_read_only_reconciled',target:input.assignmentId,
  summary:'Closed a proven terminal read-only discovery reservation; original failures, acceptance and recovery budget remain unchanged.',metadata:JSON.stringify(audit)});
 await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'queue_partner_terminal_read_only_reconciled',$2,$3::jsonb)",
  [q.source_id,`db://workflow_runs/${q.source_id}/queue_partner_terminal_read_only_reconciled/${input.assignmentId}`,JSON.stringify(audit)]);
 return true;
}
export const reconcileReadOnlyPartnerChild=(input:ReadOnlyPartnerReconciliation)=>withClient(async c=>{
 await c.query('begin');try{const result=await reconcileReadOnlyPartnerChildOnClient(c,input);await c.query('commit');return result;}catch(error){await c.query('rollback');throw error;}
});
