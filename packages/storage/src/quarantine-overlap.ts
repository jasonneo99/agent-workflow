import type {Client} from 'pg';
import {acceptanceDigest} from './acceptance.js';
import {getEffectiveLegacyRecoveryEnrollmentOnClient,type EffectiveLegacyRecoveryEnrollment} from './legacy-recovery.js';
import {captureRepairRevisionManifest,repairRevisionManifestHash} from './repaired-revision.js';
import {coordinatorClaimFenceSql} from './coordinator-claim-fence.js';

export interface QuarantineOverlapInput {sourceRunId:string;legacyEnrollmentId:string;projectId:string;fileScopes:string[]}
interface Hooks {
 enrollment(c:Client,id:string):Promise<EffectiveLegacyRecoveryEnrollment|null>;
 manifest:typeof captureRepairRevisionManifest;
 chain(c:Client,id:string):Promise<boolean>;
}
const defaults:Hooks={enrollment:getEffectiveLegacyRecoveryEnrollmentOnClient,manifest:captureRepairRevisionManifest,chain:async(c,id)=>{
 const {verifyRunReceiptChainOnClient}=await import('./postgres.js');return(await verifyRunReceiptChainOnClient(c,id)).valid;
}};
const sorted=(v:readonly string[])=>[...v].sort();
const equal=(a:unknown,b:unknown)=>acceptanceDigest(a)===acceptanceDigest(b);
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

/** Inhibiting overlap exception only. Caller must hold the scheduler advisory
 * lock and original run lock before reservation, and repeat this check there.
 * This never replays, cancels, claims, modifies or grants work to the clone. */
export async function loadApprovedQuarantineOverlapOnClient(c:Client,input:QuarantineOverlapInput,hooks:Partial<Hooks>={}):Promise<{ignoredRunIds:string[];authorizationId:string;authorizationReceiptHash:string}|null>{
 const h={...defaults,...hooks};
 if(!uuid.test(input.sourceRunId)||!uuid.test(input.projectId)||!uuid.test(input.legacyEnrollmentId)||!Array.isArray(input.fileScopes)
  ||!input.fileScopes.length||input.fileScopes.length>1000||new Set(input.fileScopes).size!==input.fileScopes.length)return null;
 const enrollment=await h.enrollment(c,input.sourceRunId);
 if(!enrollment||enrollment.enrollmentId!==input.legacyEnrollmentId||enrollment.projectId!==input.projectId
  ||!equal(sorted(enrollment.sourcePaths),sorted(input.fileScopes))||!await h.chain(c,input.sourceRunId))return null;
 const source=(await c.query('select status from workflow_runs where id=$1 for share',[input.sourceRunId])).rows[0];
 if(!source||source.status==='cancelled')return null;
 const grants=(await c.query(`select receipt_hash,metadata,created_at from action_receipts where run_id=$1
  and agent_id in ('operator','workflow-orchestrator') and action_type='operator_quarantine_overlap_exception_authorized'
  and metadata->>'legacyEnrollmentId'=$2 order by created_at desc limit 2`,[input.sourceRunId,input.legacyEnrollmentId])).rows;
 if(grants.length!==1)return null;const grant=grants[0],a=grant.metadata;
 if(!/^[a-f0-9]{64}$/u.test(grant.receipt_hash??'')||a?.version!==1||typeof a.authorizationId!=='string'||!a.authorizationId
  ||a.approvalSource!=='direct-human'||a.approvalDecision!=='approved'||typeof a.approvalReference!=='string'||!a.approvalReference
  ||a.sourceRunId!==input.sourceRunId||a.projectId!==input.projectId||a.legacyEnrollmentId!==input.legacyEnrollmentId
  ||a.familyId!==enrollment.familyId||a.projectRootUri!==enrollment.projectRootUri||a.subjectHash!==enrollment.subjectHash
  ||!Array.isArray(a.fileScopes)||!equal(sorted(a.fileScopes),sorted(input.fileScopes))||new Set(a.fileScopes).size!==a.fileScopes.length
  ||!uuid.test(a.blockedCloneRunId??'')||a.blockedCloneRunId===input.sourceRunId||a.scope!=='reservation-overlap-only'
  ||a.preserveQueuedClone!==true||a.replayAllowed!==false||a.acceptanceWaiver!==false||a.scopeExpansion!==false)return null;
 if((await c.query("select 1 from action_receipts where run_id=$1 and action_type='operator_quarantine_overlap_exception_revoked' and metadata->>'authorizationId'=$2 and created_at>=$3 limit 1",[input.sourceRunId,a.authorizationId,grant.created_at])).rowCount)return null;
 if(!await quarantinedCloneSafetyOnClient(c,{cloneRunId:a.blockedCloneRunId,projectId:input.projectId,sourceFamilyId:enrollment.familyId},h))return null;
 if(repairRevisionManifestHash(await h.manifest(enrollment.projectRootUri,input.fileScopes))!==enrollment.subjectHash)return null;
 return {ignoredRunIds:[a.blockedCloneRunId],authorizationId:a.authorizationId,authorizationReceiptHash:grant.receipt_hash};
}

/** Read-only safety fact, NOT scheduling authorization. Fresh prospective
 * recoveries must separately bind their own human authority, exact scope,
 * baseline, live intent and overlap checks; this never changes a clone. */
export async function quarantinedCloneSafetyOnClient(c:Client,input:{cloneRunId:string;projectId:string;sourceFamilyId:string},hooks:Partial<Pick<Hooks,'chain'>>={}):Promise<boolean>{
 const h={chain:defaults.chain,...hooks};
 if(!uuid.test(input.cloneRunId)||!uuid.test(input.projectId)||!input.sourceFamilyId.startsWith(input.projectId+':'))return false;
 // Check the installed function body and exact trigger event/column bindings,
 // not merely similarly named triggers or caller-provided claim metadata.
 const fences=(await c.query(`select t.tgname,t.tgtype,t.tgenabled,p.prosrc,p.prosecdef,current_setting('session_replication_role') session_role,
  array(select attname::text from pg_attribute attr where attr.attrelid=t.tgrelid and attr.attnum=any(t.tgattr::smallint[]) order by attname) columns
  from pg_trigger t join pg_proc p on p.oid=t.tgfoid where not t.tgisinternal and p.oid=to_regprocedure('agentflow_coordinator_claim_fence()')
   and ((t.tgname='agentflow_coordinator_run_claim' and t.tgrelid=to_regclass('workflow_runs'))
    or (t.tgname='agentflow_coordinator_task_claim' and t.tgrelid=to_regclass('workflow_tasks')))`)).rows;
 const expectedBody=coordinatorClaimFenceSql.match(/as \$\$([\s\S]*?)\$\$/u)?.[1]?.trim();
 const columns:Record<string,string[]>={agentflow_coordinator_run_claim:['lease_epoch','lease_expires_at','lease_owner'],agentflow_coordinator_task_claim:['lease_expires_at','lease_generation','status','worker_id']};
 if(!expectedBody||fences.length!==2||new Set(fences.map(f=>f.tgname)).size!==2||fences.some(f=>f.tgtype!==23||!['O','A'].includes(f.tgenabled)||f.session_role==='replica'||f.prosecdef!==false||f.prosrc?.trim()!==expectedBody||!equal(f.columns,columns[f.tgname])))return false;
 if((await c.query("select 1 from workflow_tasks where status in ('leased','running') limit 1")).rowCount)return false;
 const clone=(await c.query('select *,id::text run_key,project_id::text project_key from workflow_runs where id=$1 for share',[input.cloneRunId])).rows[0];
 const m=clone?.evaluation_metadata;
 if(!clone||clone.status!=='queued'||clone.project_key!==input.projectId||`${clone.project_key}:${clone.run_set_id}`===input.sourceFamilyId
  ||clone.lease_owner||clone.lease_expires_at||!uuid.test(m?.queueCoordinatorClaimId??'')||!/^\d+$/u.test(m?.queueCoordinatorFence??'')||!await h.chain(c,clone.run_key))return false;
 const old=(await c.query('select id::text,project_id::text project_key,child_run_id::text,fence::text from queue_coordinator_assignments where id=$1 for share',[m.queueCoordinatorClaimId])).rows[0];
 if(!old||old.project_key!==input.projectId||old.child_run_id===clone.run_key||old.fence===m.queueCoordinatorFence)return false;
 if((await c.query('select 1 from queue_coordinator_assignments where child_run_id=$1 limit 1',[clone.run_key])).rowCount)return false;
 if((await c.query(`select 1 where not exists(select 1 from workflow_tasks where run_id=$1)
  or exists(select 1 from workflow_tasks where run_id=$1 and (status<>'queued' or worker_id is not null or lease_expires_at is not null or started_at is not null or finished_at is not null or attempts<>0))
  or exists(select 1 from action_approvals where run_id=$1)
  or exists(select 1 from artifacts where run_id=$1 and kind in ('file_write','command_output','stage_output','stage_continuation'))
  or exists(select 1 from action_receipts where run_id=$1 and action_type not in ('workflow_replayed','requester_notified','workflow_run_transition'))`,[clone.run_key])).rowCount)return false;
 return true;
}
