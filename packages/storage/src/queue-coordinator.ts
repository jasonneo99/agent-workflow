import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { withClient } from "./client.js";
import { appendActionReceipt } from "./receipt-writer.js";
import { acceptanceDigest, acceptancePreflight } from "./acceptance.js";
import { sourceSubjectHash } from "../../workflow-engine/src/source-subject.js";
import { repairFingerprint } from "./repair-dispatch.js";
import { verifyRepairedRevisionAttestation, effectiveRepairContractOnClient, repairRevisionRequirementsDigest } from "./repaired-revision.js";
import { getEffectiveLegacyRecoveryEnrollmentOnClient as getLegacyRecoveryEnrollmentOnClient } from "./legacy-recovery.js";
import { authorizedIndependentReviewFingerprintOnClient } from "./independent-review-reservation.js";
import {loadApprovedQuarantineOverlapOnClient} from './quarantine-overlap.js';
import {enqueueRunNotification} from './run-notifications.js';
import {activeQueueSourceOnClient} from './queue-source-membership.js';
import {QUEUE_SHARED_ITEM_LIMIT} from '../../workflow-engine/src/queue-coordinator-plan.js';
import {externalQueueReservationOccupancyOnClient} from './queue-external-reservations.js';
import {registerQueuePartnerExperimentExposureOnClient,type PartnerGuideArm} from './queue-partner-experiments.js';

import { queueCoordinatorSchemaSql } from "./queue-coordinator-schema.js";
export { queueCoordinatorSchemaSql } from "./queue-coordinator-schema.js";

export interface CoordinatorReservation {
 familyId:string; sourceRunId:string; projectId:string; projectRootUri:string;
 role:"repair"|"verifier"; lane:number; owner:string; fingerprint:string;
 intentFence:string; fileScopes:string[]; revisionCandidateId?:string; legacyEnrollmentId?:string;
 independentReviewAuthorizationUri?:string;
 independentReviewReservationAuthorizationUri?:string;
 quarantineOverlap?:{blockedCloneRunId:string;authorizationReceiptHash:string};
}
export interface CoordinatorClaim extends CoordinatorReservation { id:string; fence:string; intentId?:string }
export interface QueuePartnerOutcomeJournalInput {runId?:string;phaseTimings?:Record<string,number>;resolutionStrategy?:string;blockedSince?:string}
type Audit = (client:Client,runId:string,action:string,content:Record<string,unknown>)=>Promise<void>;
const audit:Audit = async (client,runId,action,content) => {
 await appendActionReceipt(client,{runId,agentId:"workflow-orchestrator",actionType:action,
   target:String(content.familyId??content.id),summary:`Queue coordinator ${action}; no original workflow state changed.`,metadata:JSON.stringify(content)});
 const uri=`db://workflow_runs/${runId}/${action}/${randomUUID()}`;
 await client.query("insert into artifacts(run_id,kind,uri,content) values($1,$2,$3,$4::jsonb)",[runId,action,uri,JSON.stringify(content)]);
};
const active="('reserved','running','uncertain')";
async function transaction<T>(body:(c:Client)=>Promise<T>):Promise<T>{return withClient(async c=>{
 await c.query("begin");try{const value=await body(c);await c.query("commit");return value;}catch(e){await c.query("rollback");throw e;}
});}
export const initializeQueueCoordinator=()=>transaction(async c=>{await c.query(queueCoordinatorSchemaSql);});

/** Count assignment-backed children once, include genuinely executing external
 * work, and retain queued independently authorized dependencies. Ordinary queued
 * history is not working capacity; uncertainty still reserves its assignment.
 * Two-stage repair pipelines reserve the verifier for their whole lifetime.
 * These signals only inhibit capacity; they grant no execution authority. */
export async function queueWorkingOccupancyOnClient(c:Client){
 const row=(await c.query(`select
  (select count(*) from queue_coordinator_assignments where state in ${active})+
  (select count(*) from workflow_runs r where (r.status in ('leased','running') or
   (r.status='queued' and (r.evaluation_metadata->>'source'='authorized-project-dependency'
    or (r.evaluation_metadata->'partnerRepairPipeline'->>'requiresVerifierSlot'='true'
      and coalesce(r.evaluation_metadata#>>'{executionPipeline,preparedOnly}','false')<>'true'))))
   and not exists(select 1 from queue_coordinator_assignments q where q.child_run_id=r.id and q.project_id=r.project_id
    and q.state in ${active} and r.evaluation_metadata->>'queueCoordinatorClaimId'=q.id::text
    and r.evaluation_metadata->>'queueCoordinatorFence'=q.fence::text)) as count,
  (select count(*) from workflow_runs where status in ('queued','leased','running')
   and evaluation_metadata->>'source'='authorized-project-dependency') as dependencies,
  (exists(select 1 from queue_coordinator_assignments q where q.state in ${active} and
    (q.role='verifier' or exists(select 1 from action_receipts a where a.run_id=q.source_run_id
     and a.action_type='queue_partner_reasoning_reserved' and a.target=q.id::text
     and a.metadata->>'fence'=q.fence::text and a.metadata->>'requiresVerifierSlot'='true')))
   or exists(select 1 from workflow_runs r where r.status in ('queued','leased','running')
    and r.evaluation_metadata->'partnerRepairPipeline'->>'requiresVerifierSlot'='true'
    and coalesce(r.evaluation_metadata#>>'{executionPipeline,preparedOnly}','false')<>'true')) verifier`)).rows[0];
 const external=await externalQueueReservationOccupancyOnClient(c);
 return {count:Number(row.count)+external.count,dependencies:Number(row.dependencies),verifier:Boolean(row.verifier)||external.verifier,externalFamilyIds:external.reservations.map(b=>b.familyId)};
}

/** Caller owns the transaction. Display-only family inference is NOT dispatch authority.
 * Enrollment is bound to an original canonical run's immutable typed contract,
 * exact execution project, persisted run set, source scope and live intent fence.
 */
export async function reserveCoordinatorOnClient(c:Client,input:CoordinatorReservation,writeAudit:Audit=audit):Promise<CoordinatorClaim|null>{
 if(!input.owner || !input.intentFence || !input.fileScopes.length || input.fileScopes.some(f=>!f||f.startsWith("/")||/[\\*?\[\]{}]/u.test(f)||f.split("/").some(p=>!p||p===".."||p===".")))throw new Error("Invalid coordinator scope or intent");
 if(!Number.isInteger(input.lane)||input.lane<1||input.lane>(input.role==="repair"?QUEUE_SHARED_ITEM_LIMIT:1)||!["repair","verifier"].includes(input.role))throw new Error("Invalid coordinator lane");
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 const row=(await c.query(`select r.id::text,r.project_id::text,r.run_set_id::text,r.task,r.evaluation_metadata metadata,p.root_uri,
   (select coalesce(a.metadata->>'reason',a.summary) from action_receipts a where a.run_id=r.id
    and a.action_type in ('stage_failed','stage_blocked') order by a.created_at desc limit 1) blocker
   from workflow_runs r join projects p on p.id=r.project_id where r.id=$1 for update of r,p`,[input.sourceRunId])).rows[0];
 const frozen=row?.metadata?.acceptanceContract;
 if(row&&input.role==='repair'&&!await activeQueueSourceOnClient(c,input.sourceRunId))return null;
 const legacy=!frozen&&row?await getLegacyRecoveryEnrollmentOnClient(c,row.id):null;
 if(legacy ? input.legacyEnrollmentId!==legacy.enrollmentId : input.legacyEnrollmentId!==undefined)return null;
 const contract=frozen??legacy?.contract;
 if(input.quarantineOverlap){
   if(!legacy||input.role!=='repair')return null;
   const exception=await loadApprovedQuarantineOverlapOnClient(c,{sourceRunId:input.sourceRunId,projectId:input.projectId,
     legacyEnrollmentId:legacy.enrollmentId,fileScopes:input.fileScopes});
   if(!exception||exception.authorizationReceiptHash!==input.quarantineOverlap.authorizationReceiptHash
     ||exception.ignoredRunIds.length!==1||exception.ignoredRunIds[0]!==input.quarantineOverlap.blockedCloneRunId)return null;
 }
 let expectedFingerprint=row?repairFingerprint(row.task,row.blocker??""):'';
 if(input.revisionCandidateId){
   if(input.role!=='verifier')return null;
   const table=(await c.query("select to_regclass('repaired_revision_records') name")).rows[0]?.name;
   if(!table)return null;
   const candidate=(await c.query("select payload,digest from repaired_revision_records where id=$1 and kind='candidate' and source_run_id=$2",[input.revisionCandidateId,input.sourceRunId])).rows[0];
   if(!candidate||acceptanceDigest(candidate.payload)!==candidate.digest||candidate.payload.projectId!==input.projectId
     ||candidate.payload.originalContractDigest!==acceptanceDigest(contract)
     ||acceptanceDigest(candidate.payload.sourcePaths)!==acceptanceDigest(input.fileScopes))return null;
   expectedFingerprint=acceptanceDigest({failure:expectedFingerprint,revisionCandidateId:input.revisionCandidateId});
 }
 if(!row||row.project_id!==input.projectId||row.root_uri!==input.projectRootUri
   ||input.familyId!==`${row.project_id}:${row.run_set_id}`
   ||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(row.root_uri)
   ||["sourceRunId","replayOfRunId","repairOriginRunId","parentRunId"].some(k=>row.metadata?.[k])
   ||/repair|queue-coordinator/u.test(String(row.metadata?.source??""))
   ||row.metadata?.suiteId||row.metadata?.evaluationId||/eval(?:uation)?|training/iu.test(String(row.metadata?.source??""))
   ||contract?.version!==1||typeof contract?.subjectHash!=="string"||!contract.subjectHash
   ||!Array.isArray(contract?.deliverables)||!contract.deliverables.length
   ||["implementation","verification","packaging","supervision"].some(g=>!contract.deliverables.some((d:any)=>Array.isArray(d.requiredGates)&&d.requiredGates.includes(g)))
   ||contract?.originRunId!==row.id||contract?.projectId!==row.project_id||contract?.taskHash!==acceptanceDigest(row.task)
   ||acceptanceDigest([...(contract?.sourcePaths??[])].sort())!==acceptanceDigest([...input.fileScopes].sort())
   ||input.fingerprint!==expectedFingerprint)return null;
 if(input.independentReviewReservationAuthorizationUri){
   const authorizedFingerprint=await authorizedIndependentReviewFingerprintOnClient(c,input);
   if(!authorizedFingerprint)return null;
   input={...input,fingerprint:authorizedFingerprint};
 }
 const identityTable=Boolean((await c.query("select to_regclass('project_identity_locations') name")).rows[0]?.name);
 if(!identityTable)return null;
 const canonical=await c.query("select 1 from project_identity_locations where project_id=$1 and identity_id=project_id and kind='canonical'",[input.projectId]);
 if(!canonical.rowCount)return null;
 // Fresh dependency workflows retain their own project contracts and run sets.
 // Count them as repair-family occupancy and reserve the single verifier lane
 // while their sequential authored verification may execute. Metadata can only
 // inhibit dispatch here; it can never add authority or bypass another guard.
 const occupancy=await queueWorkingOccupancyOnClient(c),dependencyCount=occupancy.dependencies;
 // The single verifier is inside the five-item ceiling, never an extra item.
 // This repeats the planner's bound atomically under the queue advisory lock.
 if(occupancy.count>=QUEUE_SHARED_ITEM_LIMIT||occupancy.externalFamilyIds.includes(input.familyId)||(input.role==='verifier'&&occupancy.verifier))return null;
 if(dependencyCount){
   if(input.role==='verifier')return null;
   const occupied=Number((await c.query(`select count(*) as count from queue_coordinator_assignments where role='repair' and state in ${active}`)).rows[0].count);
   if(occupied+dependencyCount>=QUEUE_SHARED_ITEM_LIMIT)return null;
 }
 const intent=(await c.query(`select file_scopes,to_jsonb(i)->>'id' intent_id from work_intents i where project_id=$1 and owner=$2 and fencing_token=$3::bigint and expires_at>clock_timestamp() for update`,[input.projectId,input.owner,input.intentFence])).rows[0];
 if(!intent||acceptanceDigest([...(intent.file_scopes??[])].sort())!==acceptanceDigest([...input.fileScopes].sort()))return null;
 // Explicit descendant links only widen inhibition, never execution permission.
 // Repairs/replays may have a different persisted run set from their original.
 const busy=await c.query(`with recursive family(id) as (
   select id from workflow_runs where project_id=$1 and run_set_id=$2
   union select child.id from workflow_runs child join family parent on parent.id::text in (
     child.evaluation_metadata->>'sourceRunId',child.evaluation_metadata->>'replayOfRunId',
     child.evaluation_metadata->>'repairOriginRunId',child.evaluation_metadata->>'parentRunId')
     where child.project_id in (select project_id from project_identity_locations where identity_id=$1)
 ) select 1 from workflow_runs r where r.id in (select id from family) and
   (r.status in ('queued','leased','running') or exists(select 1 from workflow_tasks t where t.run_id=r.id and t.status in ('leased','running')))
   union all select 1 from action_approvals a where a.run_id in (select id from family) and a.status in ('pending','executing') limit 1`,[input.projectId,row.run_set_id]);
 if(busy.rowCount)return null;
 // An uncertain writer continues to own its source scope even after its intent
 // expires. Never infer safe takeover from a missing worker heartbeat.
 const overlapping=await c.query(`select file_scopes from queue_coordinator_assignments where project_id=$1 and state in ${active}`,[input.projectId]);
 if(overlapping.rows.some(r=>!Array.isArray(r.file_scopes)||!r.file_scopes.length||r.file_scopes.some((a:unknown)=>typeof a!=="string"||input.fileScopes.some(b=>a===b||a.startsWith(`${b}/`)||b.startsWith(`${a}/`)))))return null;
 if((await c.query(`select 1 from queue_coordinator_assignments where (family_id=$1 and (state in ${active} or (role=$2 and fingerprint=$3)))
   or (role=$2 and lane=$4 and state in ${active}) limit 1`,[input.familyId,input.role,input.fingerprint,input.lane])).rowCount)return null;
 const count=(await c.query(`select count(*)::int n from queue_coordinator_assignments q where family_id=$1 and role='repair'
  and not exists(select 1 from action_receipts a where a.run_id=q.source_run_id and a.action_type='queue_partner_reasoning_reserved' and a.target=q.id::text)`,[input.familyId])).rows[0].n;
 if(input.role==="repair"&&count>=3)return null;
 const id=randomUUID();
 const result=await c.query(`insert into queue_coordinator_assignments(id,family_id,project_id,source_run_id,role,lane,owner,fingerprint,intent_fence,file_scopes,state,legacy_enrollment_id)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'reserved',$11::uuid) returning fence::text`,[id,input.familyId,input.projectId,input.sourceRunId,input.role,input.lane,input.owner,input.fingerprint,input.intentFence,JSON.stringify(input.fileScopes),input.legacyEnrollmentId??null]);
 const claim={...input,intentId:intent.intent_id??undefined,id,fence:result.rows[0].fence};await writeAudit(c,input.sourceRunId,"queue_coordinator_reserved",claim);return claim;
}
export const reserveQueueCoordinator=(input:CoordinatorReservation)=>transaction(c=>reserveCoordinatorOnClient(c,input));

/** Explicit operator recovery of an exited, provably pre-effect reservation.
 * This never recovers an expired owner or an uncertain child, and may run only
 * once per existing claim. The ordinary uncertain reservation guard is unchanged.
 */
export async function reconcileUnstartedCoordinatorReservationOnClient(c:Client,id:string,writeAudit:Audit=audit):Promise<CoordinatorClaim|null>{
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 const q=(await c.query(`select q.*,q.id::text claim_id,q.fence::text claim_fence,q.project_id::text project_key,
   q.source_run_id::text source_id,q.legacy_enrollment_id::text enrollment_id,p.root_uri,r.run_set_id::text run_set,r.task,r.evaluation_metadata
   from queue_coordinator_assignments q join projects p on p.id=q.project_id join workflow_runs r on r.id=q.source_run_id
   where q.id=$1::uuid for update of q,r,p`,[id])).rows[0];
 if(!q||q.state!=='uncertain'||q.role!=='repair'||q.child_run_id||!q.enrollment_id||q.family_id!==`${q.project_key}:${q.run_set}`
   ||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(q.root_uri))return null;
 const intent=(await c.query(`select file_scopes from work_intents where project_id::text=$1 and owner=$2
   and fencing_token::text=$3 and expires_at>clock_timestamp() for update`,[q.project_key,q.owner,q.intent_fence])).rows[0];
 if(!intent||acceptanceDigest(intent.file_scopes)!==acceptanceDigest(q.file_scopes))return null;
 const enrollment=await getLegacyRecoveryEnrollmentOnClient(c,q.source_id);
 if(!enrollment||enrollment.id!==q.enrollment_id||enrollment.familyId!==q.family_id||enrollment.projectRootUri!==q.root_uri
   ||acceptanceDigest(enrollment.sourcePaths)!==acceptanceDigest(q.file_scopes)
   ||await sourceSubjectHash(q.root_uri,q.file_scopes)!==enrollment.subjectHash)return null;
 if((await c.query(`select 1 from action_receipts where run_id=$1 and action_type='operator_no_effect_reservation_reconciled'
   and metadata->>'id'=$2 limit 1`,[q.source_id,id])).rowCount)return null;
 // A child can exist before attachCoordinatorChild succeeds. Do not rely on
 // child_run_id alone when proving that no worker or provider was dispatched.
 if((await c.query("select 1 from workflow_runs where evaluation_metadata->>'queueCoordinatorClaimId'=$1 limit 1",[id])).rowCount)return null;
 const revisions=(await c.query("select to_regclass('repaired_revision_records') name")).rows[0]?.name;
 if(!revisions||(await c.query("select 1 from repaired_revision_records where source_run_id=$1 or claim_id=$2 limit 1",[q.source_id,id])).rowCount)return null;
 const busy=await c.query(`with recursive family(id) as (
   select id from workflow_runs where project_id=$1 and run_set_id=$2
   union select child.id from workflow_runs child join family parent on parent.id::text in (
    child.evaluation_metadata->>'sourceRunId',child.evaluation_metadata->>'replayOfRunId',
    child.evaluation_metadata->>'repairOriginRunId',child.evaluation_metadata->>'parentRunId')
 ) select 1 from workflow_runs where id in (select id from family) and status in ('queued','leased','running')
 union all select 1 from workflow_tasks where run_id in (select id from family) and status in ('queued','leased','running')
 union all select 1 from action_approvals where run_id in (select id from family) and status in ('pending','executing')
 union all select 1 from artifacts where run_id in (select id from family) and kind='repair_dispatch_claim' and created_at>=$3 limit 1`,[q.project_key,q.run_set,q.created_at]);
 if(busy.rowCount)return null;
 const others=await c.query(`select project_id::text project_key,family_id,role,lane,file_scopes from queue_coordinator_assignments where id<>$1
   and state in ${active}`,[id]);
 if(others.rows.some(other=>other.family_id===q.family_id||(other.role==='repair'&&other.lane===q.lane)
   ||(other.project_key===q.project_key&&(!Array.isArray(other.file_scopes)||other.file_scopes.some((a:unknown)=>typeof a!=='string'||q.file_scopes.some((b:string)=>a===b||a.startsWith(`${b}/`)||b.startsWith(`${a}/`)))))))return null;
 const updated=await c.query(`update queue_coordinator_assignments set state='reserved',
   fence=nextval(pg_get_serial_sequence('queue_coordinator_assignments','fence')),reason='Explicit pre-effect reconciliation; prior uncertainty retained in audit',updated_at=clock_timestamp()
   where id=$1 and fence=$2::bigint and state='uncertain' and child_run_id is null
   and exists(select 1 from work_intents where project_id::text=$3 and owner=$4 and fencing_token::text=$5 and expires_at>clock_timestamp()) returning fence::text`,
   [id,q.claim_fence,q.project_key,q.owner,q.intent_fence]);
 if(updated.rowCount!==1)return null;
 const claim:CoordinatorClaim={id,fence:updated.rows[0].fence,familyId:q.family_id,sourceRunId:q.source_id,projectId:q.project_key,
   projectRootUri:q.root_uri,role:'repair',lane:q.lane,owner:q.owner,fingerprint:q.fingerprint,intentFence:q.intent_fence,
   fileScopes:q.file_scopes,legacyEnrollmentId:q.enrollment_id};
 await writeAudit(c,q.source_id,'operator_no_effect_reservation_reconciled',{...claim,priorFence:q.claim_fence,priorState:q.state,
   priorReason:q.reason,originalWorkflowUnchanged:true,noEffectProven:true});return claim;
}
export const reconcileUnstartedCoordinatorReservation=(id:string)=>transaction(c=>reconcileUnstartedCoordinatorReservationOnClient(c,id));

export interface BlockedVerifierReconciliation { assignmentId:string;owner:string;intentFence:string;correctionArtifactUri:string }
/** One explicitly corrected verification attempt under the same assignment.
 * The predecessor remains terminal: no task, contract, output or old run is reset.
 */
export async function reconcileBlockedVerifierOnClient(c:Client,input:BlockedVerifierReconciliation,writeAudit:Audit=audit):Promise<CoordinatorClaim|null>{
 if(!input.owner||!input.intentFence||!input.correctionArtifactUri)return null;
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 const q=(await c.query(`select q.*,q.id::text claim_id,q.project_id::text project_key,q.source_run_id::text source_id,
   q.child_run_id::text predecessor_id,q.legacy_enrollment_id::text enrollment_id,q.fence::text prior_fence,p.root_uri
   from queue_coordinator_assignments q join projects p on p.id=q.project_id where q.id=$1::uuid for update of q,p`,[input.assignmentId])).rows[0];
 if(!q||q.role!=='verifier'||q.state!=='held'||!q.predecessor_id||!Array.isArray(q.file_scopes)||!q.file_scopes.length
   ||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(q.root_uri))return null;
 if(!(await c.query("select 1 from project_identity_locations where project_id=$1 and identity_id=project_id and kind='canonical'",[q.project_key])).rowCount)return null;
 const intent=(await c.query(`select file_scopes from work_intents where project_id::text=$1 and owner=$2
   and fencing_token::text=$3 and expires_at>clock_timestamp() for update`,[q.project_key,input.owner,input.intentFence])).rows[0];
 if(!intent||acceptanceDigest(intent.file_scopes)!==acceptanceDigest(q.file_scopes))return null;
 const original=(await c.query('select *,project_id::text project_key,id::text run_id from workflow_runs where id=$1 for update',[q.source_id])).rows[0];
 const predecessor=(await c.query('select *,project_id::text project_key from workflow_runs where id=$1 for update',[q.predecessor_id])).rows[0];
 if(!original||!predecessor||predecessor.status!=='blocked'||predecessor.project_key!==q.project_key
   ||['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'].some(key=>Object.hasOwn(original.evaluation_metadata??{},key))
   ||original.evaluation_metadata?.suiteId||original.evaluation_metadata?.evaluationId||/eval(?:uation)?|training/iu.test(String(original.evaluation_metadata?.source??''))
   ||q.family_id!==`${q.project_key}:${original.run_set_id}`||predecessor.evaluation_metadata?.sourceRunId!==q.source_id
   ||predecessor.evaluation_metadata?.queueCoordinatorClaimId!==q.claim_id||predecessor.evaluation_metadata?.queueCoordinatorFence!==q.prior_fence
   ||!Array.isArray(predecessor.policy_snapshot?.actions?.allowed_write_paths)||predecessor.policy_snapshot.actions.allowed_write_paths.length)return null;
 const effective=await effectiveRepairContractOnClient(c,original,{sourceRunId:q.source_id,projectId:q.project_key,fileScopes:q.file_scopes,legacyEnrollmentId:q.enrollment_id??undefined});
 const provider=effective.legacy?.provider??original.provider_override,tier=effective.legacy?.modelTier??original.model_tier_override;
 if(!provider||!tier||predecessor.provider_override!==provider||predecessor.model_tier_override!==tier)return null;
 const candidateId=predecessor.evaluation_metadata?.repairedRevisionCandidateId;
 const record=(await c.query("select payload,digest from repaired_revision_records where id=$1 and source_run_id=$2 and kind='candidate' for share",[candidateId,q.source_id])).rows[0];
 const candidate=record?.payload;
 const verificationContract=predecessor.evaluation_metadata?.acceptanceContract;
 if(!candidate||acceptanceDigest(candidate)!==record.digest||candidate.sourceRunId!==q.source_id||candidate.projectId!==q.project_key
   ||candidate.projectRootUri!==q.root_uri||candidate.originalContractDigest!==acceptanceDigest(effective.contract)
   ||candidate.legacyEnrollmentId!==(q.enrollment_id??undefined)||candidate.repairOwner===input.owner
   ||acceptanceDigest(candidate.sourcePaths)!==acceptanceDigest(q.file_scopes)
   ||candidate.requirementsDigest!==repairRevisionRequirementsDigest(effective.contract)
   ||predecessor.evaluation_metadata?.originalAcceptanceDigest!==candidate.originalContractDigest
   ||predecessor.evaluation_metadata?.repairedRevisionSourceRunId!==q.source_id
   ||verificationContract?.version!==1||verificationContract.originRunId!==q.predecessor_id||verificationContract.projectId!==q.project_key
   ||verificationContract.taskHash!==acceptanceDigest(predecessor.task)||!verificationContract.contractId
   ||repairRevisionRequirementsDigest(verificationContract)!==candidate.requirementsDigest
   ||acceptanceDigest(verificationContract.sourcePaths)!==acceptanceDigest(q.file_scopes)||verificationContract.subjectHash!==candidate.repairedHash
   ||await sourceSubjectHash(q.root_uri,q.file_scopes)!==candidate.repairedHash)return null;
 const repair=(await c.query('select *,project_id::text project_key from workflow_runs where id=$1 for share',[candidate.repairRunId])).rows[0];
 if(!repair||repair.status!=='completed'||repair.project_key!==q.project_key||repair.provider_override!==provider||repair.model_tier_override!==tier
   ||repair.evaluation_metadata?.sourceRunId!==q.source_id||repair.evaluation_metadata?.queueCoordinatorClaimId!==candidate.repairClaimId
   ||repair.evaluation_metadata?.originalAcceptanceDigest!==candidate.originalContractDigest)return null;
 if((await c.query("select 1 from artifacts where run_id=$1 and kind='file_write' limit 1",[q.predecessor_id])).rowCount)return null;
 if((await c.query(`select 1 from action_receipts where run_id=$1 and action_type='operator_verifier_assignment_reconciled'
   and metadata->>'id'=$2 limit 1`,[q.source_id,q.claim_id])).rowCount)return null;
 const correction=(await c.query(`select content,created_at from artifacts where run_id=$1 and uri=$2
   and kind='operator_verifier_context_correction' for share`,[q.predecessor_id,input.correctionArtifactUri])).rows;
 if(correction.length!==1)return null;
 const evidence=correction[0].content;
 if(evidence?.assignmentId!==q.claim_id||evidence.candidateId!==candidateId||evidence.sourceRunId!==q.source_id
   ||evidence.priorVerifierRunId!==q.predecessor_id||evidence.originalContractDigest!==candidate.originalContractDigest
   ||evidence.subjectHash!==candidate.repairedHash||evidence.actor!=='operator'||evidence.authority!=='direct-human'||evidence.offlineOnly!==true
   ||typeof evidence.reason!=='string'||!evidence.reason.trim()||evidence.reason.length>2000
   ||new Date(correction[0].created_at).getTime()<new Date(q.updated_at).getTime())return null;
 const proof=(await c.query(`select metadata from action_receipts where run_id=$1 and action_type='operator_verifier_context_correction'
   and target=$1::text and agent_id in ('operator','workflow-orchestrator') and created_at>=$2`,[q.predecessor_id,q.updated_at])).rows;
 if(!proof.some(row=>acceptanceDigest(row.metadata)===acceptanceDigest(evidence)))return null;
 const {verifyRunReceiptChainOnClient}=await import('./postgres.js');
 for(const runId of [q.source_id,candidate.repairRunId,q.predecessor_id])if(!(await verifyRunReceiptChainOnClient(c,runId)).valid)return null;
 const busy=await c.query(`with recursive family(id) as (
   select id from workflow_runs where project_id=$1 and run_set_id=$2
   union select child.id from workflow_runs child join family parent on parent.id::text in (
    child.evaluation_metadata->>'sourceRunId',child.evaluation_metadata->>'replayOfRunId',
    child.evaluation_metadata->>'repairOriginRunId',child.evaluation_metadata->>'parentRunId')
 ) select 1 from workflow_runs where id in (select id from family) and status in ('queued','leased','running')
 union all select 1 from workflow_tasks where run_id in (select id from family) and status in ('queued','leased','running')
 union all select 1 from action_approvals where run_id in (select id from family) and status in ('pending','executing') limit 1`,[q.project_key,original.run_set_id]);
 if(busy.rowCount)return null;
 const others=await c.query(`select project_id::text project_key,family_id,role,lane,file_scopes from queue_coordinator_assignments
   where id<>$1 and state in ${active}`,[q.claim_id]);
 if(others.rows.some(other=>other.family_id===q.family_id||(other.role==='verifier'&&other.lane===q.lane)
   ||(other.project_key===q.project_key&&(!Array.isArray(other.file_scopes)||other.file_scopes.some((a:unknown)=>typeof a!=='string'||q.file_scopes.some((b:string)=>a===b||a.startsWith(`${b}/`)||b.startsWith(`${a}/`)))))))return null;
 const next=await c.query(`update queue_coordinator_assignments set state='reserved',child_run_id=null,owner=$3,intent_fence=$4,
   fence=nextval(pg_get_serial_sequence('queue_coordinator_assignments','fence')),updated_at=clock_timestamp(),reason='Explicit corrected verification attempt; predecessor retained terminal'
   where id=$1 and fence=$2::bigint and state='held' and exists(select 1 from work_intents where project_id::text=$5 and owner=$3 and fencing_token::text=$4 and expires_at>clock_timestamp()) returning fence::text`,
   [q.claim_id,q.prior_fence,input.owner,input.intentFence,q.project_key]);
 if(next.rowCount!==1)return null;
 const claim:CoordinatorClaim={id:q.claim_id,fence:next.rows[0].fence,familyId:q.family_id,sourceRunId:q.source_id,projectId:q.project_key,
   projectRootUri:q.root_uri,role:'verifier',lane:q.lane,owner:input.owner,fingerprint:q.fingerprint,intentFence:input.intentFence,
   fileScopes:q.file_scopes,revisionCandidateId:candidateId,...(q.enrollment_id?{legacyEnrollmentId:q.enrollment_id}:{} )};
 await writeAudit(c,q.source_id,'operator_verifier_assignment_reconciled',{...claim,priorFence:q.prior_fence,priorOwner:q.owner,
   priorVerifierRunId:q.predecessor_id,correctionArtifactUri:input.correctionArtifactUri,correctionDigest:acceptanceDigest(evidence),
   originalWorkflowUnchanged:true,predecessorWorkflowUnchanged:true,repairDispatched:false});return claim;
}
export const reconcileBlockedVerifier=(input:BlockedVerifierReconciliation)=>transaction(c=>reconcileBlockedVerifierOnClient(c,input));
export async function attachCoordinatorChildOnClient(c:Client,claim:CoordinatorClaim,runId:string):Promise<'attached'|'existing'>{
 const assessment=(await c.query("select metadata from action_receipts where run_id=$1 and action_type='operator_history_assessment_reserved' and metadata->>'id'=$2 and metadata->>'fence'=$3",[claim.sourceRunId,claim.id,claim.fence])).rows;
 if(assessment.length){
   if(assessment.length!==1)throw new Error('Ambiguous assessment provenance');
   const proof=assessment[0].metadata;
   const child=(await c.query('select *,id::text run_id from workflow_runs where id=$1 for share',[runId])).rows[0];
   const m=child?.evaluation_metadata,contract=m?.acceptanceContract;
   if(!child||m?.source!=='queue-coordinator-assessment'||m.provenanceKind!=='authorized-current-baseline-assessment'
     ||acceptanceDigest(m.historyAssessment)!==acceptanceDigest(proof.assessment)
     ||!Array.isArray(child.policy_snapshot?.actions?.allowed_write_paths)||child.policy_snapshot.actions.allowed_write_paths.length
     ||(proof.assessment?.offlineCommands&&acceptanceDigest(child.policy_snapshot?.actions?.allowed_commands)!==acceptanceDigest(proof.assessment.offlineCommands))
     ||contract?.subjectHash!==proof.assessment?.subjectHash||contract?.originRunId!==runId
     ||contract?.taskHash!==acceptanceDigest(child.task)||contract?.projectId!==claim.projectId
     ||acceptanceDigest(contract?.sourcePaths)!==acceptanceDigest(claim.fileScopes))throw new Error('Assessment child must preserve exact readonly provenance');
   const source=(await c.query('select *,project_id::text project_key from workflow_runs where id=$1 for share',[claim.sourceRunId])).rows[0];
   const effective=await effectiveRepairContractOnClient(c,source,claim);
   if(repairRevisionRequirementsDigest(contract)!==repairRevisionRequirementsDigest(effective.contract))throw new Error('Assessment changed original acceptance requirements');
 }
 if(claim.legacyEnrollmentId){
  const enrollment=await getLegacyRecoveryEnrollmentOnClient(c,claim.sourceRunId);
  if(!enrollment||enrollment.enrollmentId!==claim.legacyEnrollmentId)throw new Error("Legacy recovery enrollment changed");
  const bound=await c.query(`select 1 from workflow_runs where id=$1 and provider_override=$2 and model_tier_override=$3
    and evaluation_metadata->>'legacyEnrollmentId'=$4 and evaluation_metadata->>'originalAcceptanceDigest'=$5`,
    [runId,enrollment.provider,enrollment.modelTier,enrollment.enrollmentId,acceptanceDigest(enrollment.contract)]);
  if(bound.rowCount!==1)throw new Error("Legacy child route or enrollment binding does not match");
 }
 const child=await c.query(`select 1 from workflow_runs r join work_intents i on i.project_id::text=r.project_id::text
   where r.id=$1 and r.project_id=$2 and r.evaluation_metadata->>'sourceRunId'=$3
   and r.evaluation_metadata->>'queueCoordinatorClaimId'=$4 and r.evaluation_metadata->>'queueCoordinatorFence'=$5
   and i.owner=$6 and i.fencing_token=$7::bigint and i.expires_at>now()`,
   [runId,claim.projectId,claim.sourceRunId,claim.id,claim.fence,claim.owner,claim.intentFence]);
 if(child.rowCount!==1)throw new Error("Child scope or live coordinator intent does not match");
 const existing=(await c.query(`select child_run_id::text "childRunId",state from queue_coordinator_assignments
   where id=$1 and fence=$2::bigint and owner=$3 and legacy_enrollment_id is not distinct from $4::uuid for update`,[claim.id,claim.fence,claim.owner,claim.legacyEnrollmentId??null])).rows[0];
 if(existing?.state==='running'&&existing.childRunId===runId)return 'existing';
 const r=await c.query(`update queue_coordinator_assignments set child_run_id=$3,state='running',updated_at=now()
   where id=$1 and fence=$2::bigint and owner=$4 and state='reserved' and legacy_enrollment_id is not distinct from $5::uuid returning source_run_id`,[claim.id,claim.fence,runId,claim.owner,claim.legacyEnrollmentId??null]);
 if(r.rowCount!==1)throw new Error("Stale coordinator fence");await audit(c,claim.sourceRunId,"queue_coordinator_dispatched",{...claim,childRunId:runId});return 'attached';
}
export async function attachCoordinatorChild(claim:CoordinatorClaim,runId:string):Promise<void>{await transaction(c=>attachCoordinatorChildOnClient(c,claim,runId));}
export interface QueuePartnerChildEnrollment {claim:CoordinatorClaim;workerAgentId:string;guideArm:PartnerGuideArm}
export async function enrollQueuePartnerChildOnClient(c:Client,runId:string,enrollment:QueuePartnerChildEnrollment){
 const exposure=await registerQueuePartnerExperimentExposureOnClient(c,{runId,workerAgentId:enrollment.workerAgentId,guideArm:enrollment.guideArm});
 const attachment=await attachCoordinatorChildOnClient(c,enrollment.claim,runId);
 return {exposure:exposure.exposure,exposureRecorded:exposure.recorded,attachment};
}
export async function finishQueueCoordinatorOnClient(c:Client,claim:CoordinatorClaim,state:"held"|"failed"|"verified"|"uncertain",reason:string,journal?:QueuePartnerOutcomeJournalInput,writeAudit:Audit=audit):Promise<void>{
 // A valid lease token does not authorize replacing the assignment's source
 // identity with another run's acceptance, journal or audit evidence.
 const persisted=(await c.query(`select q.*,q.project_id::text project_key,q.source_run_id::text source_key,
   q.legacy_enrollment_id::text legacy_key,p.root_uri
   from queue_coordinator_assignments q join projects p on p.id=q.project_id
   where q.id=$1 and q.fence=$2::bigint and q.owner=$3 and q.state in ('reserved','running') for update of q`,[claim.id,claim.fence,claim.owner])).rows[0];
 if(!persisted)throw new Error("Stale coordinator finalization fence");
 if(persisted.source_key!==claim.sourceRunId||persisted.project_key!==claim.projectId||persisted.root_uri!==claim.projectRootUri
   ||persisted.family_id!==claim.familyId||persisted.role!==claim.role||persisted.lane!==claim.lane
   ||persisted.fingerprint!==claim.fingerprint||persisted.intent_fence!==claim.intentFence
   ||(persisted.legacy_key??null)!==(claim.legacyEnrollmentId??null)
   ||acceptanceDigest(persisted.file_scopes)!==acceptanceDigest(claim.fileScopes))throw new Error('Claim does not match persisted coordinator identity');
 if(state==="verified"){
   if((await c.query("select 1 from action_receipts where run_id=$1 and action_type='scoped_change_review_reserved' and metadata->>'id'=$2 and metadata->>'fence'=$3 limit 1",[persisted.source_key,claim.id,claim.fence])).rowCount)
     throw new Error('A scoped change review cannot certify original workflow acceptance');
   if(claim.role!=="verifier")throw new Error("Repair lanes cannot certify completion");
   const currentHash=await sourceSubjectHash(claim.projectRootUri,claim.fileScopes);
   let independentAccepted=false;
   if(claim.independentReviewAuthorizationUri){
     const review=(await c.query('select child_run_id::text review_id from queue_coordinator_assignments where id=$1 and fence=$2::bigint and owner=$3',[claim.id,claim.fence,claim.owner])).rows[0];
     const {verifyIndependentAcceptanceReviewOnClient}=await import('./independent-acceptance-review.js');
     independentAccepted=Boolean(review?.review_id)&&await verifyIndependentAcceptanceReviewOnClient(c,{sourceRunId:claim.sourceRunId,reviewRunId:review.review_id,authorizationArtifactUri:claim.independentReviewAuthorizationUri,claimId:claim.id,claimFence:claim.fence,requireLiveClaim:true});
     if(!independentAccepted)throw new Error('Independent review authorization or acceptance is incomplete');
   }
   const revisionAccepted=independentAccepted||(claim.revisionCandidateId&&await verifyRepairedRevisionAttestation(claim.sourceRunId,currentHash));
   if(!revisionAccepted){
   const row=(await c.query("select evaluation_metadata->'acceptanceContract' contract from workflow_runs where id=$1",[claim.sourceRunId])).rows[0];
   const artifacts=await c.query("select content from artifacts where run_id=$1 and kind in ('stage_output','direct_repair_validation') order by created_at desc limit 20",[claim.sourceRunId]);
   let accepted=false;
   for(const a of artifacts.rows){const content=a.content?.artifact??a.content;if((await acceptancePreflight(c,claim.sourceRunId,content)).accepted){accepted=true;break;}}
   const {verifyRunReceiptChain}=await import("./postgres.js");
   if(!accepted||!(await verifyRunReceiptChain(claim.sourceRunId)).valid
     ||currentHash!==row?.contract?.subjectHash)throw new Error("Original acceptance or current source proof is incomplete");
   }
 }
 const r=await c.query(`update queue_coordinator_assignments set state=$3,reason=$4,updated_at=now()
   where id=$1 and fence=$2::bigint and owner=$5 and state in ('reserved','running') returning id,child_run_id::text`,[claim.id,claim.fence,state,reason.slice(0,1000),claim.owner]);
 if(r.rowCount!==1)throw new Error("Stale coordinator finalization fence");
 const childRunId=r.rows[0].child_run_id??null;if(journal?.runId&&journal.runId!==childRunId)throw new Error('Outcome journal child does not match coordinator assignment');
 if(journal)await c.query(`insert into queue_partner_outcome_journal(assignment_id,fence,project_id,source_run_id,child_run_id,state,reason,payload)
  values($1,$2::bigint,$3,$4,$5::uuid,$6,$7,$8::jsonb) on conflict(assignment_id,fence) do nothing`,[claim.id,claim.fence,claim.projectId,claim.sourceRunId,childRunId,state,reason.slice(0,1000),JSON.stringify({version:2,familyId:claim.familyId,role:claim.role,runId:childRunId,phaseTimings:journal.phaseTimings??{},resolutionStrategy:journal.resolutionStrategy??(claim.role==='verifier'?'verify-sealed-candidate':'unknown'),blockedSince:journal.blockedSince??null})]);
 // A verified repaired revision is a user-visible delivery outcome, not merely
 // internal queue bookkeeping. Persist its callback in the same transaction
 // as verification, but only when the immutable original run carries a valid
 // captured origin. The outbox later authenticates that exact destination.
 if(state==='verified'&&claim.role==='verifier'&&claim.revisionCandidateId){
  const origin=(await c.query<{eligible:boolean}>(`select case
    when evaluation_metadata->>'codexThreadId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then true
    when evaluation_metadata->>'originClient' in ('studio','muse')
      and evaluation_metadata->>'originTaskId' ~ '^[a-zA-Z0-9-]{1,160}$' then true
    else false end eligible
   from workflow_runs where id=$1 and project_id=$2`,[claim.sourceRunId,claim.projectId])).rows[0];
  if(origin?.eligible)await enqueueRunNotification(c,{runId:claim.sourceRunId,kind:'recovered',
   eventKey:`queue-partner-code-fix:${claim.id}:${claim.fence}`,
   title:'Verified code fix delivered',
   body:JSON.stringify({version:1,type:'queue_partner_verified_code_fix',authority:'evidence-only; grants no new execution authority',
    sourceRunId:claim.sourceRunId,familyId:claim.familyId,verificationRunId:childRunId,
    repairedRevisionCandidateId:claim.revisionCandidateId,coordinatorAssignmentId:claim.id,
    coordinatorFence:claim.fence,verification:'independent original-requirement attestation passed',
    nextStep:'Review the verified fix and evidence in the originating request. Original history and approval boundaries remain preserved.'})});
 }
 await writeAudit(c,claim.sourceRunId,"queue_coordinator_finished",{...claim,state,reason:reason.slice(0,1000),workflowClosed:false,journaled:Boolean(journal)});
}
export async function finishQueueCoordinator(claim:CoordinatorClaim,state:"held"|"failed"|"verified"|"uncertain",reason:string,journal?:QueuePartnerOutcomeJournalInput):Promise<void>{
 await transaction(c=>finishQueueCoordinatorOnClient(c,claim,state,reason,journal));
}
export async function acknowledgeQueuePartnerOutcomeJournalOnClient(c:Client,claim:CoordinatorClaim,runId:string):Promise<boolean>{return (await c.query(`update queue_partner_outcome_journal set delivery_state='delivered',delivered_at=clock_timestamp()
 where assignment_id=$1 and fence=$2::bigint and project_id=$3 and source_run_id=$4 and child_run_id=$5 and delivery_state='pending'`,[claim.id,claim.fence,claim.projectId,claim.sourceRunId,runId])).rowCount===1;}
export async function acknowledgeQueuePartnerOutcomeJournal(claim:CoordinatorClaim,runId:string):Promise<boolean>{return transaction(c=>acknowledgeQueuePartnerOutcomeJournalOnClient(c,claim,runId));}
export async function listQueueCoordinatorAssignments(){return withClient(async c=>(await c.query("select id::text,fence::text,family_id,source_run_id::text,project_id::text,role,lane,owner,fingerprint,state,child_run_id::text,reason,legacy_enrollment_id::text from queue_coordinator_assignments order by created_at desc limit 500")).rows);}
