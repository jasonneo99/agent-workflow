import type {Client} from 'pg';
import {withClient} from '../../storage/src/client.js';
import {acceptanceDigest} from '../../storage/src/acceptance.js';
import {getEffectiveLegacyRecoveryEnrollmentOnClient as getLegacyRecoveryEnrollmentOnClient} from '../../storage/src/legacy-recovery.js';
import {sourceSubjectHash} from './source-subject.js';
import {repairRevisionManifestHash} from '../../storage/src/repaired-revision.js';
import {isVerificationCommand} from './action-result-continuation.js';

export interface LegacyNoChangeInput {runId:string;taskId:string;workerId:string;fencingToken:string;projectRootUri:string}
export interface LegacyNoChangeHooks {
 enrollment(c:Client,sourceRunId:string):Promise<any>;
 chain(c:Client,runId:string):Promise<boolean>;
 source(root:string,paths:string[]):Promise<string>;
}
export interface LegacyNoChangeSourceBinding {sourceRunId:string;rootUri:string;sourcePaths:string[];subjectHash:string;baselineCreatedAt:unknown}
const defaults:LegacyNoChangeHooks={enrollment:getLegacyRecoveryEnrollmentOnClient,source:sourceSubjectHash,
 chain:async(c,id)=>{const {verifyRunReceiptChainOnClient}=await import('../../storage/src/postgres.js');return(await verifyRunReceiptChainOnClient(c,id)).valid;}};
/** Runtime evidence only. A provider's prose/output flag cannot grant this exception.
 * This proves a no-change repair inspection, NOT original acceptance or a verifier gate.
 */
export async function legacyNoChangeSourceBindingOnClient(c:Client,input:LegacyNoChangeInput,hooks:Partial<LegacyNoChangeHooks>={}):Promise<LegacyNoChangeSourceBinding|null>{
 const h={...defaults,...hooks};
 if(!(await c.query("select to_regclass('legacy_recovery_enrollments') legacy,to_regclass('queue_coordinator_assignments') coordinator,to_regclass('repaired_revision_records') revisions")).rows.some(row=>row.legacy&&row.coordinator&&row.revisions))return null;
 const r=(await c.query(`select r.id::text run_id,r.project_id::text project_id,r.evaluation_metadata metadata,r.provider_override,r.model_tier_override,r.policy_snapshot,
  q.id::text claim_id,q.owner,q.source_run_id::text source_id,q.legacy_enrollment_id::text enrollment_id,q.intent_fence,q.file_scopes,i.file_scopes intent_scopes,p.root_uri
  from workflow_runs r join workflow_tasks t on t.run_id=r.id join queue_coordinator_assignments q on q.child_run_id=r.id
  join projects p on p.id=r.project_id join work_intents i on i.project_id::text=q.project_id::text and i.owner=q.owner and i.fencing_token::text=q.intent_fence and i.expires_at>clock_timestamp()
  where r.id=$1::uuid and t.id=$2::uuid and t.worker_id=$3 and t.lease_generation::text=$4 and t.status='running'
   and t.lease_expires_at>clock_timestamp() and r.lease_owner=$3 and r.lease_expires_at>clock_timestamp()
   and r.status='running' and q.state='running' and q.role='repair' and q.project_id=r.project_id
   and q.id::text=r.evaluation_metadata->>'queueCoordinatorClaimId' and q.fence::text=r.evaluation_metadata->>'queueCoordinatorFence'
   and $3=q.owner||':'||q.fence::text and q.legacy_enrollment_id is not null`,[input.runId,input.taskId,input.workerId,input.fencingToken])).rows[0];
 if(!r||r.root_uri!==input.projectRootUri||r.metadata?.source!=='queue-coordinator-repair'||r.metadata?.legacyEnrollmentId!==r.enrollment_id
  ||r.metadata?.sourceRunId!==r.source_id||r.metadata?.enrollmentMode!=='legacy-current-baseline'
  ||r.metadata?.workIntent?.owner!==r.owner||String(r.metadata?.workIntent?.fencingToken)!==r.intent_fence
  ||acceptanceDigest(r.intent_scopes)!==acceptanceDigest(r.file_scopes))return null;
 const enrollment=await h.enrollment(c,r.source_id);
 if(!enrollment||enrollment.mode!=='legacy-current-baseline'||enrollment.enrollmentId!==r.enrollment_id||enrollment.projectId!==r.project_id
  ||enrollment.projectRootUri!==r.root_uri||r.provider_override!==enrollment.provider||r.model_tier_override!==enrollment.modelTier
  ||r.metadata?.originalAcceptanceDigest!==acceptanceDigest(enrollment.contract)
  ||acceptanceDigest([...r.file_scopes].sort())!==acceptanceDigest([...enrollment.sourcePaths].sort())
  ||acceptanceDigest([...(r.policy_snapshot?.actions?.allowed_write_paths??[])].sort())!==acceptanceDigest([...enrollment.sourcePaths].sort()))return null;
 const baseline=(await c.query("select payload,digest,created_at from repaired_revision_records where claim_id=$1::uuid and kind='baseline'",[r.claim_id])).rows[0];
 if(!baseline||acceptanceDigest(baseline.payload)!==baseline.digest||baseline.payload.legacyEnrollmentId!==r.enrollment_id
  ||baseline.payload.sourceRunId!==r.source_id||baseline.payload.originalContractDigest!==acceptanceDigest(enrollment.contract)
  ||baseline.payload.repairClaimId!==r.claim_id||baseline.payload.projectId!==r.project_id||baseline.payload.repairOwner!==r.owner
  ||acceptanceDigest(baseline.payload.sourcePaths)!==acceptanceDigest(enrollment.sourcePaths)
  ||!Array.isArray(baseline.payload.manifest)||repairRevisionManifestHash(baseline.payload.manifest.map(({path,mode,hash}:any)=>({path,mode,hash})))!==enrollment.subjectHash
  ||baseline.payload.sourceHash!==enrollment.subjectHash)return null;
 if((await c.query(`select 1 from artifacts where run_id=$1::uuid and kind='file_write'
  union all select 1 from action_receipts where run_id=$1::uuid and action_type in ('file_write','file_write_rejected')
  union all select 1 from action_approvals where run_id=$1::uuid and status in ('pending','executing') limit 1`,[input.runId])).rowCount)return null;
 if(!await h.chain(c,r.source_id)||!await h.chain(c,input.runId)||await h.source(r.root_uri,enrollment.sourcePaths)!==enrollment.subjectHash)return null;
 return {sourceRunId:r.source_id,rootUri:r.root_uri,sourcePaths:enrollment.sourcePaths,subjectHash:enrollment.subjectHash,baselineCreatedAt:baseline.created_at};
}
export async function verifyLegacyNoChangeRecoveryOnClient(c:Client,input:LegacyNoChangeInput,hooks:Partial<LegacyNoChangeHooks>={}):Promise<boolean>{
 const binding=await legacyNoChangeSourceBindingOnClient(c,input,hooks);if(!binding)return false;
 const h={...defaults,...hooks};
 const commands=(await c.query(`select a.content,exists(select 1 from action_receipts receipt where receipt.run_id=a.run_id and receipt.action_type='local_command'
    and receipt.target=a.content->>'commandLine' and receipt.metadata=a.content and receipt.metadata_serialization_version=2) matched
  from artifacts a where a.run_id=$1::uuid and a.kind='command_output' and a.content->>'requestedByTaskId'=$2 and a.created_at>$3
  order by a.created_at limit 101`,[input.runId,input.taskId,binding.baselineCreatedAt])).rows;
 if(!commands.length||commands.length>100||commands.some(({content,matched})=>!matched||content?.exitCode!==0||content?.timedOut!==false||content?.cwd!==binding.rootUri
  ||content?.subjectHash!==binding.subjectHash||content?.sourceBefore!==binding.subjectHash||content?.sourceAfter!==binding.subjectHash
  ||acceptanceDigest(content?.sourcePaths)!==acceptanceDigest(binding.sourcePaths)))return false;
 if(!commands.some(({content})=>typeof content.commandLine==='string'&&isVerificationCommand(content.commandLine)&&!/^git diff --check(?:\s|$)/u.test(content.commandLine)))return false;
 return await h.source(binding.rootUri,binding.sourcePaths)===binding.subjectHash;
}
export const verifyLegacyNoChangeRecovery=(input:LegacyNoChangeInput)=>withClient(c=>verifyLegacyNoChangeRecoveryOnClient(c,input));
export const legacyNoChangeSourceBinding=(input:LegacyNoChangeInput)=>withClient(c=>legacyNoChangeSourceBindingOnClient(c,input));
