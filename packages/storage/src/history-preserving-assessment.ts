import type { Client } from 'pg';
import { withClient } from './client.js';
import { acceptanceDigest } from './acceptance.js';
import { appendActionReceipt } from './receipt-writer.js';
import { effectiveRepairContractOnClient, captureRepairRevisionManifest, repairRevisionManifestHash, repairRevisionRequirementsDigest } from './repaired-revision.js';
import type { CoordinatorClaim } from './queue-coordinator.js';
import {verifyHistoricalAssessmentSnapshot} from './historical-assessment-snapshot.js';
import {validateQuarantinedAssessmentOnClient,quarantinedAssessmentOfflineCommands} from './quarantined-assessment.js';
import {loadProjectConfig} from '../../agent-registry/src/loaders.js';
import {resolveExecutionPolicy} from '../../policy-engine/src/index.js';
import {assertCommandAllowed} from '../../local-tools/src/command-executor.js';
import {loadAssessmentSupplementalEvidence,type AssessmentSupplementalEvidence} from './assessment-supplemental-evidence.js';

export interface HistoryAssessmentInput { assignmentId:string; owner:string; intentFence:string; authorizationArtifactUri:string }
export interface HistoryAssessmentClaim extends CoordinatorClaim {
 assessment:{priorRunId:string;authorizationArtifactUri:string;authorizationDigest:string;subjectHash:string;offlineCommands?:string[];commandTimeoutMs?:number;supplementalEvidence?:AssessmentSupplementalEvidence[]};
}
export interface HistoryAssessmentHooks {
 chain(c:Client,id:string):Promise<boolean>;
 manifest(root:string,paths:string[]):ReturnType<typeof captureRepairRevisionManifest>;
}
const defaults:HistoryAssessmentHooks={manifest:captureRepairRevisionManifest,chain:async(c,id)=>{
 const {verifyRunReceiptChainOnClient}=await import('./postgres.js');return(await verifyRunReceiptChainOnClient(c,id)).valid;
}};
const equal=(a:unknown,b:unknown)=>acceptanceDigest(a)===acceptanceDigest(b);
const active="('reserved','running','uncertain')";
async function allowedQuarantinedRecipe(root:string,profile:string,paths:string[],value:unknown):Promise<string[]|null>{
 const commands=quarantinedAssessmentOfflineCommands(value,paths);if(!commands)return null;
 try{const policy=resolveExecutionPolicy(await loadProjectConfig(root),profile).project;for(const command of commands)assertCommandAllowed(command,policy);return commands;}catch{return null;}
}

/** Read-only CLI projection preflight. This never reserves a claim or grants
 * authority: the reservation repeats every check under its fresh intent. */
export async function previewQuarantinedHistoryAssessmentOnClient(c:Client,input:Pick<HistoryAssessmentInput,'assignmentId'|'authorizationArtifactUri'>,hooks:Partial<HistoryAssessmentHooks>={}):Promise<string[]|null>{
 const h={...defaults,...hooks};
 const q=(await c.query(`select q.*,q.id::text claim_id,q.project_id::text project_key,q.source_run_id::text source_id,
  q.child_run_id::text prior_id,q.fence::text prior_fence,p.root_uri from queue_coordinator_assignments q
  join projects p on p.id=q.project_id where q.id=$1::uuid for share of q,p`,[input.assignmentId])).rows[0];
 if(!q||q.state!=='held'||q.role!=='repair'||!q.prior_id||!Array.isArray(q.file_scopes)||!q.file_scopes.length||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(q.root_uri))return null;
 if(!(await c.query("select 1 from project_identity_locations where project_id=$1 and identity_id=project_id and kind='canonical'",[q.project_key])).rowCount)return null;
 const source=(await c.query('select *,id::text run_id,project_id::text project_key from workflow_runs where id=$1 for share',[q.source_id])).rows[0];
 const prior=(await c.query('select *,project_id::text project_key from workflow_runs where id=$1 for share',[q.prior_id])).rows[0];
 if(!source||source.status==='cancelled'||!prior||prior.status!=='cancelled'||prior.project_key!==q.project_key||q.family_id!==`${q.project_key}:${source.run_set_id}`
  ||['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'].some(k=>Object.hasOwn(source.evaluation_metadata??{},k))
  ||source.evaluation_metadata?.suiteId||source.evaluation_metadata?.evaluationId||/eval(?:uation)?|training/iu.test(String(source.evaluation_metadata?.source??'')))return null;
 const effective=await effectiveRepairContractOnClient(c,source,{sourceRunId:q.source_id,projectId:q.project_key,fileScopes:q.file_scopes,legacyEnrollmentId:q.legacy_enrollment_id??undefined});
 const contract=effective.contract,provider=effective.legacy?.provider??source.provider_override,tier=effective.legacy?.modelTier??source.model_tier_override,m=prior.evaluation_metadata;
 const manifest=await h.manifest(q.root_uri,q.file_scopes),subjectHash=repairRevisionManifestHash(manifest);
 if(!effective.legacy||!provider||!tier||subjectHash!==contract.subjectHash||!equal(contract.sourcePaths,q.file_scopes)
  ||prior.provider_override!==provider||prior.model_tier_override!==tier||m?.sourceRunId!==q.source_id||m.queueCoordinatorClaimId!==q.claim_id||m.queueCoordinatorFence!==q.prior_fence
  ||m.originalAcceptanceDigest!==acceptanceDigest(contract)||m.legacyEnrollmentId!==q.legacy_enrollment_id)return null;
 const auth=(await c.query("select content,created_at from artifacts where run_id=$1 and uri=$2 and kind='operator_history_assessment_authorized' for share",[q.prior_id,input.authorizationArtifactUri])).rows;
 const a=auth[0]?.content;
 if(auth.length!==1||a?.assignmentId!==q.claim_id||a.sourceRunId!==q.source_id||a.priorRunId!==q.prior_id||a.projectId!==q.project_key||a.familyId!==q.family_id
  ||a.originalContractDigest!==acceptanceDigest(contract)||a.subjectHash!==subjectHash||!equal(a.sourcePaths,q.file_scopes)||a.provider!==provider||a.modelTier!==tier
  ||a.actor!=='operator'||a.authority!=='direct-human'||a.approvalDecision!=='approved'||a.offlineOnly!==true
  ||typeof a.reason!=='string'||!a.reason.trim()||a.reason.length>2000||new Date(auth[0].created_at).getTime()<new Date(q.updated_at).getTime())return null;
 const receipt=(await c.query("select metadata from action_receipts where run_id=$1 and action_type='operator_history_assessment_authorized' and target=$1::text and agent_id in ('operator','workflow-orchestrator') and created_at>=$2",[q.prior_id,q.updated_at])).rows;
 if(!receipt.some(r=>equal(r.metadata,a))||!await h.chain(c,q.source_id)||!await h.chain(c,q.prior_id)||!await allowedQuarantinedRecipe(q.root_uri,source.policy_profile,q.file_scopes,a.offlineCommands))return null;
 if(!await loadAssessmentSupplementalEvidence(c,{priorRunId:q.prior_id,sourceRunId:q.source_id,projectId:q.project_key,subjectHash,uris:a.supplementalEvidenceUris}))return null;
 if((await c.query("select 1 from artifacts where run_id=$1 and kind='file_write' union all select 1 from action_receipts where run_id=$1 and action_type='file_write' limit 1",[q.prior_id])).rowCount)return null;
 if((await c.query("select 1 from action_receipts where run_id=$1 and action_type='operator_history_assessment_reserved' and metadata->>'id'=$2 limit 1",[q.source_id,q.claim_id])).rowCount)return null;
 const ignored=await validateQuarantinedAssessmentOnClient(c,{sourceRunId:q.source_id,priorRunId:q.prior_id,projectId:q.project_key,assignmentId:q.claim_id,priorFence:q.prior_fence,priorTask:prior.task,priorStatus:prior.status,subjectHash,originalContractDigest:acceptanceDigest(contract),provider,modelTier:tier},a.quarantineReconciliation);
 if(!ignored)return null;
 for(const id of ignored)if(!await h.chain(c,id))return null;
 return repairRevisionManifestHash(await h.manifest(q.root_uri,q.file_scopes))===subjectHash?ignored:null;
}
export const previewQuarantinedHistoryAssessment=(input:Pick<HistoryAssessmentInput,'assignmentId'|'authorizationArtifactUri'>)=>withClient(async c=>{
 await c.query('begin');try{return await previewQuarantinedHistoryAssessmentOnClient(c,input);}finally{await c.query('rollback');}
});

/** Explicit once-only evidence assessment, NOT a repair retry or terminal reset.
 * The old child, contracts, approvals and reconciliation budget remain untouched.
 * Repair-role reservations are used only to fence a read-only baseline assessment;
 * a later completed child and independent verifier are still mandatory.
 */
export async function reserveHistoryPreservingAssessmentOnClient(c:Client,input:HistoryAssessmentInput,hooks:Partial<HistoryAssessmentHooks>={}):Promise<HistoryAssessmentClaim|null>{
 const h={...defaults,...hooks};if(!input.owner||!input.intentFence||!input.authorizationArtifactUri)return null;
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 const q=(await c.query(`select q.*,q.id::text claim_id,q.project_id::text project_key,q.source_run_id::text source_id,
 q.child_run_id::text prior_id,q.fence::text prior_fence,p.root_uri from queue_coordinator_assignments q
 join projects p on p.id=q.project_id where q.id=$1::uuid for update of q,p`,[input.assignmentId])).rows[0];
 if(!q||q.state!=='held'||!q.prior_id||!['repair','verifier'].includes(q.role)||!Array.isArray(q.file_scopes)||!q.file_scopes.length
 ||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(q.root_uri))return null;
 if(!(await c.query("select 1 from project_identity_locations where project_id=$1 and identity_id=project_id and kind='canonical'",[q.project_key])).rowCount)return null;
 const intent=(await c.query(`select file_scopes from work_intents where project_id::text=$1 and owner=$2 and fencing_token::text=$3
 and expires_at>clock_timestamp() for update`,[q.project_key,input.owner,input.intentFence])).rows[0];
 if(!intent||!equal(intent.file_scopes,q.file_scopes))return null;
 const source=(await c.query('select *,id::text run_id,project_id::text project_key from workflow_runs where id=$1 for share',[q.source_id])).rows[0];
 const prior=(await c.query('select *,project_id::text project_key from workflow_runs where id=$1 for share',[q.prior_id])).rows[0];
 if(!source||source.status==='cancelled'||!prior||!['blocked','cancelled'].includes(prior.status)||prior.project_key!==q.project_key||q.family_id!==`${q.project_key}:${source.run_set_id}`
 ||['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'].some(k=>Object.hasOwn(source.evaluation_metadata??{},k))
 ||source.evaluation_metadata?.suiteId||source.evaluation_metadata?.evaluationId||/eval(?:uation)?|training/iu.test(String(source.evaluation_metadata?.source??'')))return null;
 const m=prior.evaluation_metadata;
 if(m?.sourceRunId!==q.source_id||m.queueCoordinatorClaimId!==q.claim_id||m.queueCoordinatorFence!==q.prior_fence)return null;
 const effective=await effectiveRepairContractOnClient(c,source,{sourceRunId:q.source_id,projectId:q.project_key,fileScopes:q.file_scopes,legacyEnrollmentId:q.legacy_enrollment_id??undefined});
 const contract=effective.contract,provider=effective.legacy?.provider??source.provider_override,tier=effective.legacy?.modelTier??source.model_tier_override;
 if(!provider||!tier||prior.provider_override!==provider||prior.model_tier_override!==tier||m.originalAcceptanceDigest!==acceptanceDigest(contract)
 ||(q.legacy_enrollment_id&&m.legacyEnrollmentId!==q.legacy_enrollment_id))return null;
 const manifest=await h.manifest(q.root_uri,q.file_scopes),subjectHash=repairRevisionManifestHash(manifest);
 let candidateId:string|undefined;
 if(q.role==='repair'){
  // Only an authorized legacy no-change baseline can take this path. Historical
  // writes cannot be retroactively converted into a successful repair.
  if(!effective.legacy)return null;
  const b=(await c.query("select payload,digest from repaired_revision_records where claim_id=$1 and kind='baseline' for share",[q.claim_id])).rows[0];
  if(!b||b.digest!==acceptanceDigest(b.payload)||b.payload.originalContractDigest!==acceptanceDigest(contract)
   ||b.payload.legacyEnrollmentId!==q.legacy_enrollment_id||b.payload.repairClaimId!==q.claim_id||b.payload.sourceRunId!==q.source_id
   ||b.payload.sourceHash!==contract.subjectHash||repairRevisionManifestHash(b.payload.manifest)!==subjectHash||subjectHash!==contract.subjectHash
   ||!equal(manifest,b.payload.manifest))return null;
  if((await c.query("select 1 from repaired_revision_records where claim_id=$1 and kind='candidate' limit 1",[q.claim_id])).rowCount)return null;
 }else{
  candidateId=m.repairedRevisionCandidateId;
  const r=(await c.query("select payload,digest from repaired_revision_records where id=$1 and source_run_id=$2 and kind='candidate' for share",[candidateId,q.source_id])).rows[0];
  const p=r?.payload;
  if(!p||acceptanceDigest(p)!==r.digest||p.sourceRunId!==q.source_id||p.projectId!==q.project_key||p.projectRootUri!==q.root_uri
   ||p.originalContractDigest!==acceptanceDigest(contract)||p.requirementsDigest!==repairRevisionRequirementsDigest(contract)
   ||p.legacyEnrollmentId!==(q.legacy_enrollment_id??undefined)||p.repairOwner===input.owner||p.repairedHash!==subjectHash
   ||!equal(p.sourcePaths,q.file_scopes)||m.repairedRevisionSourceRunId!==q.source_id)return null;
  const repair=(await c.query('select *,project_id::text project_key from workflow_runs where id=$1 for share',[p.repairRunId])).rows[0];
  if(!repair||repair.status!=='completed'||repair.project_key!==q.project_key||repair.provider_override!==provider||repair.model_tier_override!==tier
   ||repair.evaluation_metadata?.sourceRunId!==q.source_id||repair.evaluation_metadata?.queueCoordinatorClaimId!==p.repairClaimId
   ||repair.evaluation_metadata?.originalAcceptanceDigest!==p.originalContractDigest||!await h.chain(c,p.repairRunId))return null;
  if(!Array.isArray(prior.policy_snapshot?.actions?.allowed_write_paths)||prior.policy_snapshot.actions.allowed_write_paths.length)return null;
  const v=m.acceptanceContract;
  if(v?.version!==1||v.originRunId!==q.prior_id||v.projectId!==q.project_key||v.taskHash!==acceptanceDigest(prior.task)
   ||!v.contractId||v.subjectHash!==subjectHash||repairRevisionRequirementsDigest(v)!==p.requirementsDigest||!equal(v.sourcePaths,q.file_scopes))return null;
 }
 if((await c.query("select 1 from artifacts where run_id=$1 and kind='file_write' union all select 1 from action_receipts where run_id=$1 and action_type='file_write' limit 1",[q.prior_id])).rowCount)return null;
 if((await c.query("select 1 from action_receipts where run_id=$1 and action_type='operator_history_assessment_reserved' and metadata->>'id'=$2 limit 1",[q.source_id,q.claim_id])).rowCount)return null;
 const auth=(await c.query("select content,created_at from artifacts where run_id=$1 and uri=$2 and kind='operator_history_assessment_authorized' for share",[q.prior_id,input.authorizationArtifactUri])).rows;
 if(auth.length!==1)return null;const a=auth[0].content;
 if(a?.assignmentId!==q.claim_id||a.sourceRunId!==q.source_id||a.priorRunId!==q.prior_id||a.projectId!==q.project_key||a.familyId!==q.family_id
 ||a.originalContractDigest!==acceptanceDigest(contract)||a.subjectHash!==subjectHash||!equal(a.sourcePaths,q.file_scopes)||a.provider!==provider||a.modelTier!==tier
 ||a.actor!=='operator'||a.authority!=='direct-human'||a.approvalDecision!=='approved'||a.offlineOnly!==true
 ||typeof a.reason!=='string'||!a.reason.trim()||a.reason.length>2000||new Date(auth[0].created_at).getTime()<new Date(q.updated_at).getTime())return null;
 const receipt=(await c.query("select metadata from action_receipts where run_id=$1 and action_type='operator_history_assessment_authorized' and target=$1::text and agent_id in ('operator','workflow-orchestrator') and created_at>=$2",[q.prior_id,q.updated_at])).rows;
 if(!receipt.some(r=>equal(r.metadata,a))||!await h.chain(c,q.source_id))return null;
 const boundedCommands=a.offlineCommands!==undefined||prior.status==='cancelled';
 const offlineCommands=boundedCommands?await allowedQuarantinedRecipe(q.root_uri,source.policy_profile,q.file_scopes,a.offlineCommands):undefined;
 if(boundedCommands&&!offlineCommands)return null;
 const commandTimeoutMs=a.commandTimeoutMs;
 if(commandTimeoutMs!==undefined&&(!Number.isInteger(commandTimeoutMs)||commandTimeoutMs<=0||commandTimeoutMs>120000))return null;
 const supplementalEvidence=await loadAssessmentSupplementalEvidence(c,{priorRunId:q.prior_id,sourceRunId:q.source_id,projectId:q.project_key,subjectHash,uris:a.supplementalEvidenceUris});
 if(!supplementalEvidence)return null;
 const ignoredQueued=prior.status==='cancelled'
  ?await validateQuarantinedAssessmentOnClient(c,{sourceRunId:q.source_id,priorRunId:q.prior_id,projectId:q.project_key,assignmentId:q.claim_id,priorFence:q.prior_fence,priorTask:prior.task,priorStatus:prior.status,subjectHash,originalContractDigest:acceptanceDigest(contract),provider,modelTier:tier},a.quarantineReconciliation)
  :[];
 if(!ignoredQueued)return null;
 for(const ignored of ignoredQueued)if(!await h.chain(c,ignored))return null;
 // Missing historical coverage is never relabeled valid. An independently
 // audited immutable snapshot can anchor ONLY this new read-only assessment;
 // original/candidate and new acceptance still require complete valid chains.
 if(!await h.chain(c,q.prior_id)&&!await verifyHistoricalAssessmentSnapshot(c,q.prior_id,q.source_id))return null;
 const busy=await c.query(`with recursive family(id) as (
 select id from workflow_runs where project_id=$1 and run_set_id=$2 union select child.id from workflow_runs child join family parent
 on parent.id::text in (child.evaluation_metadata->>'sourceRunId',child.evaluation_metadata->>'replayOfRunId',child.evaluation_metadata->>'repairOriginRunId',child.evaluation_metadata->>'parentRunId'))
 select 1 from workflow_runs where id in(select id from family) and status in ('queued','leased','running') and not id=any($3::uuid[])
 union all select 1 from workflow_tasks where run_id in(select id from family) and status in ('queued','leased','running') and not run_id=any($3::uuid[])
 union all select 1 from action_approvals where run_id in(select id from family) and status in ('pending','executing') limit 1`,[q.project_key,source.run_set_id,ignoredQueued]);
 if(busy.rowCount)return null;
 const others=(await c.query(`select family_id,project_id::text project_key,role,lane,file_scopes from queue_coordinator_assignments where id<>$1 and state in ${active}`,[q.claim_id])).rows;
 if(others.some(o=>o.family_id===q.family_id||(o.role===q.role&&o.lane===q.lane)||(o.project_key===q.project_key&&(!Array.isArray(o.file_scopes)||o.file_scopes.some((x:unknown)=>typeof x!=='string'||q.file_scopes.some((y:string)=>x===y||x.startsWith(y+'/')||y.startsWith(x+'/')))))))return null;
 // Recheck filesystem after authorization/chain queries before reserving.
 if(repairRevisionManifestHash(await h.manifest(q.root_uri,q.file_scopes))!==subjectHash)return null;
 const next=await c.query(`update queue_coordinator_assignments set state='reserved',child_run_id=null,owner=$3,intent_fence=$4,
 fence=nextval(pg_get_serial_sequence('queue_coordinator_assignments','fence')),updated_at=clock_timestamp(),reason='Explicit read-only assessment; terminal predecessor preserved'
 where id=$1 and fence=$2::bigint and state='held' and exists(select 1 from work_intents where project_id::text=$5 and owner=$3 and fencing_token::text=$4 and expires_at>clock_timestamp()) returning fence::text`,[q.claim_id,q.prior_fence,input.owner,input.intentFence,q.project_key]);
 if(next.rowCount!==1)return null;
 const claim:HistoryAssessmentClaim={id:q.claim_id,fence:next.rows[0].fence,familyId:q.family_id,sourceRunId:q.source_id,projectId:q.project_key,projectRootUri:q.root_uri,
 role:q.role,lane:q.lane,owner:input.owner,fingerprint:q.fingerprint,intentFence:input.intentFence,fileScopes:q.file_scopes,
 ...(candidateId?{revisionCandidateId:candidateId}:{}),...(q.legacy_enrollment_id?{legacyEnrollmentId:q.legacy_enrollment_id}:{}),
 assessment:{priorRunId:q.prior_id,authorizationArtifactUri:input.authorizationArtifactUri,authorizationDigest:acceptanceDigest(a),subjectHash,...(offlineCommands?{offlineCommands}:{}),...(commandTimeoutMs===undefined?{}:{commandTimeoutMs}),...(supplementalEvidence.length?{supplementalEvidence}:{})}};
 const payload={...claim,priorFence:q.prior_fence,priorOwner:q.owner,originalWorkflowUnchanged:true,predecessorWorkflowUnchanged:true,repairDispatched:false,readOnlyAssessment:true};
 await appendActionReceipt(c,{runId:q.source_id,agentId:'workflow-orchestrator',actionType:'operator_history_assessment_reserved',target:q.claim_id,summary:'Once-only authorized read-only assessment; no original workflow reset or repair retry.',metadata:JSON.stringify(payload)});
 await c.query('insert into artifacts(run_id,kind,uri,content) values($1,$2,$3,$4::jsonb)',[q.source_id,'operator_history_assessment_reserved',`db://workflow_runs/${q.source_id}/operator_history_assessment_reserved/${q.claim_id}`,JSON.stringify(payload)]);
 return claim;
}
export const reserveHistoryPreservingAssessment=(input:HistoryAssessmentInput)=>withClient(async c=>{
 await c.query('begin');try{const result=await reserveHistoryPreservingAssessmentOnClient(c,input);await c.query('commit');return result;}catch(error){await c.query('rollback');throw error;}
});
