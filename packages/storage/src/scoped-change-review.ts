import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import type {Client} from 'pg';
import {withClient} from './client.js';
import {acceptanceDigest} from './acceptance.js';
import {appendActionReceipt} from './receipt-writer.js';
import {queueWorkingOccupancyOnClient,type CoordinatorClaim} from './queue-coordinator.js';
import {exactPartnerPaths} from './queue-partner-reasoning.js';
import {loadProjectConfig} from '../../agent-registry/src/loaders.js';
import {projectConfigSchema,type ProjectConfig} from '../../agent-registry/src/schemas.js';
import {canonicalJsonHash,resolveExecutionPolicy} from '../../policy-engine/src/index.js';
import {assertCommandAllowed} from '../../local-tools/src/command-executor.js';
import {assertFilePathAllowed} from '../../local-tools/src/file-writer.js';
import {isVerificationCommand} from '../../workflow-engine/src/action-result-continuation.js';
import {sourceSubjectHash} from '../../workflow-engine/src/source-subject.js';
import {ENVIRONMENT_COMMAND} from '../../run-environments/src/schema.js';

export interface ScopedChangeReviewInput {
 sourceRunId:string;projectId:string;projectRootUri:string;familyId:string;
 owner:string;intentFence:string;authorizationArtifactUri:string;
}
export interface ScopedChangeReviewClaim extends CoordinatorClaim {
 scopedReviewAuthorizationUri:string;reviewTaskHash:string;authorizedCommands:string[];sourceHash:string;policyHash:string;
 reviewerAgentId:'test-engineer'|'security-reviewer';
}
export interface ScopedChangeReviewHooks {
 load:typeof loadProjectConfig;hash:typeof sourceSubjectHash;
 chain(c:Client,id:string):Promise<boolean>;
}
const defaults:ScopedChangeReviewHooks={load:loadProjectConfig,hash:sourceSubjectHash,chain:async(c,id)=>{
 const {verifyRunReceiptChainOnClient}=await import('./postgres.js');return (await verifyRunReceiptChainOnClient(c,id)).valid;
}};
const equal=(a:unknown,b:unknown)=>acceptanceDigest(a)===acceptanceDigest(b);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const active="('reserved','running','uncertain')";
export function scopedChangeReviewPolicy(project:ProjectConfig,commands:string[]):ProjectConfig {
 const environmentCapability=project.execution.environments&&project.actions.allowed_commands.includes(ENVIRONMENT_COMMAND)?[ENVIRONMENT_COMMAND]:[];
 // Keep only literal permissions already granted for the reviewed commands.
 // Broad rules and permissions for unrelated actions never enter the review.
 const approvalRules=project.actions.approval_rules.filter(rule=>rule.action_type==='local_command'&&commands.includes(rule.target));
 return projectConfigSchema.parse({...project,actions:{...project.actions,allowed_write_paths:[],allowed_commands:[...new Set([...commands,...environmentCapability])],approval_rules:approvalRules,isolate_command_writes:true}});
}

/** A fresh grant for reviewing a current change, NOT an original-root recovery,
 * repaired-revision attestation, policy grant or substitute for native acceptance.
 * Managed descendants may be evidence anchors; their history is never reset.
 */
async function authorization(c:Client,input:ScopedChangeReviewInput,h:ScopedChangeReviewHooks){
 if(!input.owner||!/^\d+$/u.test(input.intentFence)||!input.authorizationArtifactUri.startsWith('db://'))return null;
 const r=(await c.query(`select r.id::text,r.project_id::text,r.run_set_id::text,r.task,r.status,r.policy_profile,r.evaluation_metadata,p.root_uri,
  exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical
  from workflow_runs r join projects p on p.id=r.project_id where r.id=$1 for update of r,p`,[input.sourceRunId])).rows[0];
 if(!r||!r.canonical||r.project_id!==input.projectId||r.root_uri!==input.projectRootUri||input.familyId!==`${r.project_id}:${r.run_set_id}`
  ||!['failed','blocked','completed'].includes(r.status)||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(r.root_uri)
  ||r.evaluation_metadata?.suiteId||r.evaluation_metadata?.evaluationId||/eval(?:uation)?|training/iu.test(String(r.evaluation_metadata?.source??''))
  ||await fs.realpath(r.root_uri)!==r.root_uri)return null;
 const rows=(await c.query("select content from artifacts where run_id=$1 and uri=$2 and kind='scoped_change_review_authorization' for share",[r.id,input.authorizationArtifactUri])).rows;
 const a=rows[0]?.content;
 if(rows.length!==1||a?.version!==1||a.purpose!=='scoped-change-review'||a.authority!=='direct-human'||a.approvalDecision!=='approved'
  ||a.offlineOnly!==true||a.reviewLimit!==1||a.originalAcceptanceChanged!==false||typeof a.authorizationId!=='string'||!a.authorizationId
  ||typeof a.approvalEvidence!=='string'||!a.approvalEvidence.trim()||a.sourceRunId!==r.id||a.projectId!==r.project_id||a.projectRootUri!==r.root_uri
  ||a.familyId!==input.familyId||a.taskHash!==acceptanceDigest(r.task)||!hash(a.sourceHash)||!hash(a.policyHash)||!hash(a.reviewTaskHash)
  ||!['test-engineer','security-reviewer'].includes(a.reviewerAgentId)
  ||!exactPartnerPaths(a.sourcePaths)||!a.sourcePaths.length||!exactPartnerPaths(a.reviewPaths)||!a.reviewPaths.length
  ||a.reviewPaths.some((p:string)=>!a.sourcePaths.includes(p))||!Array.isArray(a.authorizedCommands)||!a.authorizedCommands.length
  ||a.authorizedCommands.length>8||new Set(a.authorizedCommands).size!==a.authorizedCommands.length
  ||a.authorizedCommands.some((v:unknown)=>typeof v!=='string'||v.length>2000||!isVerificationCommand(v)))return null;
 const proof=(await c.query(`select receipt_hash from action_receipts where run_id=$1 and action_type='scoped_change_review_authorized'
  and target=$2 and metadata=$3::jsonb and agent_id in ('operator','workflow-orchestrator') limit 2`,[r.id,input.authorizationArtifactUri,JSON.stringify(a)])).rows;
 if(proof.length!==1||!hash(proof[0].receipt_hash)||!await h.chain(c,r.id))return null;
 if((await c.query(`select 1 from artifacts where kind='scoped_change_review_authorization' and content->>'authorizationId'=$1 and uri<>$2
  union all select 1 from action_receipts where run_id=$3 and action_type='scoped_change_review_revoked' and target=$2 limit 1`,[a.authorizationId,input.authorizationArtifactUri,r.id])).rowCount)return null;
 const policy=resolveExecutionPolicy(await h.load(r.root_uri),r.policy_profile).project;
 if(canonicalJsonHash(policy)!==a.policyHash)return null;
 for(const p of a.sourcePaths)assertFilePathAllowed(p,policy);
 for(const command of a.authorizedCommands)assertCommandAllowed(command,policy);
 if(await h.hash(r.root_uri,a.sourcePaths)!==a.sourceHash)return null;
 const intent=(await c.query(`select file_scopes from work_intents where project_id::text=$1 and owner=$2 and fencing_token::text=$3
  and expires_at>clock_timestamp() for update`,[input.projectId,input.owner,input.intentFence])).rows[0];
 if(!intent||!equal([...intent.file_scopes].sort(),[...a.sourcePaths].sort()))return null;
 return {a,r,policy};
}

export async function reserveScopedChangeReviewOnClient(c:Client,input:ScopedChangeReviewInput,hooks:Partial<ScopedChangeReviewHooks>={}):Promise<ScopedChangeReviewClaim|null>{
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 const h={...defaults,...hooks},checked=await authorization(c,input,h);if(!checked)return null;
 const {a,r}=checked,occupancy=await queueWorkingOccupancyOnClient(c);
 if(occupancy.count>=5||occupancy.verifier||occupancy.dependencies)return null;
 const busy=await c.query(`with recursive family(id) as (
  select id from workflow_runs where run_set_id=$1 union select child.id from workflow_runs child join family parent
  on parent.id::text in (child.evaluation_metadata->>'sourceRunId',child.evaluation_metadata->>'replayOfRunId',child.evaluation_metadata->>'parentRunId',child.evaluation_metadata->>'repairOriginRunId')
 ) select 1 from workflow_runs where id in(select id from family) and status in ('queued','leased','running')
 union all select 1 from workflow_tasks where run_id in(select id from family) and status in ('queued','leased','running')
 union all select 1 from action_approvals where run_id in(select id from family) and status in ('pending','executing') limit 1`,[r.run_set_id]);
 if(busy.rowCount)return null;
 const others=(await c.query(`select project_id::text,family_id,file_scopes from queue_coordinator_assignments where state in ${active}`)).rows;
 if(others.some(o=>o.family_id===input.familyId||(o.project_id===input.projectId&&(!exactPartnerPaths(o.file_scopes)||!o.file_scopes.length
  ||o.file_scopes.some((p:string)=>a.sourcePaths.some((q:string)=>p===q||p.startsWith(q+'/')||q.startsWith(p+'/')))))))return null;
 // Rewording a task or replacing an approval does not create new work. All
 // terminal attempts remain consumed; changing the baseline still has a cap.
 const fingerprint=acceptanceDigest({kind:'scoped-change-review',projectId:input.projectId,familyId:input.familyId,
  sourceHash:a.sourceHash,policyHash:a.policyHash,sourcePaths:[...a.sourcePaths].sort(),reviewPaths:[...a.reviewPaths].sort()});
 if((await c.query("select 1 from queue_coordinator_assignments where family_id=$1 and role='verifier' and fingerprint=$2",[input.familyId,fingerprint])).rowCount)return null;
 if(Number((await c.query("select count(*)::int n from action_receipts where action_type='scoped_change_review_reserved' and metadata->>'familyId'=$1",[input.familyId])).rows[0].n)>=5)return null;
 // No effects occurred during preflight; recheck the exact disk/intent grant.
 if(!await authorization(c,input,h))return null;
 const id=randomUUID(),inserted=await c.query(`insert into queue_coordinator_assignments
  (id,family_id,project_id,source_run_id,role,lane,owner,fingerprint,intent_fence,file_scopes,state)
  values($1,$2,$3,$4,'verifier',1,$5,$6,$7,$8::jsonb,'reserved') returning fence::text`,
  [id,input.familyId,input.projectId,input.sourceRunId,input.owner,fingerprint,input.intentFence,JSON.stringify(a.sourcePaths)]);
 const claim:ScopedChangeReviewClaim={...input,id,fence:inserted.rows[0].fence,role:'verifier',lane:1,fingerprint,fileScopes:a.sourcePaths,
  scopedReviewAuthorizationUri:input.authorizationArtifactUri,reviewTaskHash:a.reviewTaskHash,authorizedCommands:a.authorizedCommands,sourceHash:a.sourceHash,policyHash:a.policyHash,reviewerAgentId:a.reviewerAgentId};
 await appendActionReceipt(c,{runId:r.id,agentId:'workflow-orchestrator',actionType:'scoped_change_review_reserved',target:id,
  summary:'One read-only current-change review; original acceptance and terminal history unchanged.',metadata:JSON.stringify(claim)});
 return claim;
}

/** The existing kernel/database worker fence remains authoritative. A generic
 * worker cannot claim this child before this exact readonly attachment succeeds.
 */
export async function attachScopedChangeReviewOnClient(c:Client,claim:ScopedChangeReviewClaim,runId:string,hooks:Partial<ScopedChangeReviewHooks>={}):Promise<void>{
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 const checked=await authorization(c,{...claim,authorizationArtifactUri:claim.scopedReviewAuthorizationUri},{...defaults,...hooks});
 if(!checked)throw Error('Scoped review authorization, policy, source or live intent changed');
 const q=(await c.query("select *,fence::text claim_fence from queue_coordinator_assignments where id=$1 for update",[claim.id])).rows[0];
 const child=(await c.query('select *,project_id::text project_key from workflow_runs where id=$1 for update',[runId])).rows[0],m=child?.evaluation_metadata;
 const proof=(await c.query("select metadata from action_receipts where run_id=$1 and action_type='scoped_change_review_reserved' and target=$2",[claim.sourceRunId,claim.id])).rows;
 const expected=scopedChangeReviewPolicy(checked.policy,checked.a.authorizedCommands);
 if(!q||q.state!=='reserved'||q.claim_fence!==claim.fence||q.owner!==claim.owner||q.intent_fence!==claim.intentFence||q.source_run_id!==claim.sourceRunId
  ||q.project_id!==claim.projectId||q.family_id!==claim.familyId||q.role!=='verifier'||q.lane!==1||q.fingerprint!==claim.fingerprint||!equal(q.file_scopes,claim.fileScopes)
  ||proof.length!==1||!equal(proof[0].metadata,claim)||!child||child.status!=='queued'||child.lease_owner||child.project_key!==claim.projectId
  ||child.run_set_id!==checked.r.run_set_id||acceptanceDigest(child.task)!==checked.a.reviewTaskHash
  ||child.policy_profile!==checked.r.policy_profile||String(child.autonomy)!==String(expected.project.autonomy)
  ||!Array.isArray(child.workflow_snapshot?.stages)||child.workflow_snapshot.stages.length!==1||child.workflow_snapshot.stages[0].agent!==checked.a.reviewerAgentId
  ||child.provider_override!=null||child.model_tier_override!=null||m?.kind!=='scoped-change-review'||m.sourceRunId!==claim.sourceRunId
  ||m.queueCoordinatorClaimId!==claim.id||m.queueCoordinatorFence!==claim.fence||m.scopedReviewAuthorizationUri!==claim.scopedReviewAuthorizationUri
  ||m.originalAcceptanceChanged!==false||m.noAutomaticRepeat!==true||m.acceptanceContract!==undefined
  ||canonicalJsonHash(child.policy_snapshot)!==canonicalJsonHash(expected)||child.policy_snapshot_hash!==canonicalJsonHash(expected))throw Error('Scoped review child must preserve exact readonly policy and independent bindings');
 const tasks=(await c.query('select status,started_at,agent_id from workflow_tasks where run_id=$1',[runId])).rows;
 if(tasks.length!==1||tasks[0].status!=='queued'||tasks[0].started_at!=null||tasks[0].agent_id!==checked.a.reviewerAgentId
  ||(await c.query("select 1 from action_receipts where run_id=$1 and action_type in ('file_write','local_command','stage_started') limit 1",[runId])).rowCount)throw Error('Scoped review child already executed or has an unbound reviewer');
 await c.query("update queue_coordinator_assignments set child_run_id=$3,state='running',updated_at=clock_timestamp() where id=$1 and fence=$2::bigint",[claim.id,claim.fence,runId]);
 await appendActionReceipt(c,{runId:claim.sourceRunId,agentId:'workflow-orchestrator',actionType:'scoped_change_review_dispatched',target:runId,
  summary:'Exact readonly review child attached; current provider routing, no original acceptance grant.',metadata:JSON.stringify({...claim,childRunId:runId})});
}
async function transaction<T>(fn:(c:Client)=>Promise<T>){return withClient(async c=>{await c.query('begin');try{const value=await fn(c);await c.query('commit');return value;}catch(error){await c.query('rollback');throw error;}});}
export const reserveScopedChangeReview=(input:ScopedChangeReviewInput)=>transaction(c=>reserveScopedChangeReviewOnClient(c,input));
export const attachScopedChangeReview=(claim:ScopedChangeReviewClaim,runId:string)=>transaction(c=>attachScopedChangeReviewOnClient(c,claim,runId));
