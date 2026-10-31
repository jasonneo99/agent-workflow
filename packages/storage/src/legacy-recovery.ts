import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { Client } from "pg";
import { withClient } from "./client.js";
import { acceptanceDigest } from "./acceptance.js";
import { appendActionReceipt } from "./receipt-writer.js";
import { captureRepairRevisionManifest, repairRevisionManifestHash, RepairedRevisionProofError, type RepairRevisionManifestEntry } from "./repaired-revision.js";

export const legacyRecoverySchemaSql = `
create table if not exists legacy_recovery_enrollments (
 id uuid primary key,source_run_id uuid not null unique references workflow_runs(id),
 payload jsonb not null,digest text not null,created_at timestamptz not null default clock_timestamp()
);
create or replace function forbid_legacy_recovery_mutation() returns trigger language plpgsql as $$
begin raise exception 'Legacy recovery enrollments are immutable'; end $$;
drop trigger if exists legacy_recovery_immutable on legacy_recovery_enrollments;
create trigger legacy_recovery_immutable before update or delete on legacy_recovery_enrollments
 for each row execute function forbid_legacy_recovery_mutation();
drop trigger if exists legacy_recovery_no_truncate on legacy_recovery_enrollments;
create trigger legacy_recovery_no_truncate before truncate on legacy_recovery_enrollments
 for each statement execute function forbid_legacy_recovery_mutation();
create table if not exists legacy_recovery_baseline_revisions (
 id uuid primary key,source_run_id uuid not null references workflow_runs(id),
 enrollment_id uuid not null references legacy_recovery_enrollments(id),
 previous_digest text not null unique,payload jsonb not null,digest text not null,
 created_at timestamptz not null default clock_timestamp()
);
drop trigger if exists legacy_baseline_revision_immutable on legacy_recovery_baseline_revisions;
create trigger legacy_baseline_revision_immutable before update or delete on legacy_recovery_baseline_revisions
 for each row execute function forbid_legacy_recovery_mutation();
drop trigger if exists legacy_baseline_revision_no_truncate on legacy_recovery_baseline_revisions;
create trigger legacy_baseline_revision_no_truncate before truncate on legacy_recovery_baseline_revisions
 for each statement execute function forbid_legacy_recovery_mutation();`;
export interface LegacyRecoveryInput {
 sourceRunId:string;projectId:string;familyId:string;taskHash:string;sourcePaths:string[];
 owner:string;intentFence:string;authorizationId:string;
}
export interface LegacyRecoveryEnrollment extends Record<string,unknown> {
 id:string;enrollmentId:string;mode:'legacy-current-baseline';sourceRunId:string;projectId:string;familyId:string;projectRootUri:string;
 taskHash:string;policyHash:string;sourcePaths:string[];subjectHash:string;manifest:RepairRevisionManifestEntry[];
 provider:'codex-cli';modelTier:'standard';offlineOnly:true;authorizationId:string;authorizationReceiptHash:string;
 contract:{version:1;contractId:string;originRunId:string;projectId:string;taskHash:string;sourcePaths:string[];subjectHash:string;deliverables:Array<{id:string;description:string;requiredGates:string[];status:'pending';receipts:Record<string,never>;gaps:string[]}>};
}
export interface LegacyRecoveryHooks {
 manifest(root:string,paths:string[]):Promise<RepairRevisionManifestEntry[]>;
 chain(runId:string,client?:Client):Promise<boolean>;
 canonicalRoot(root:string):Promise<boolean>;
 audit(c:Client,runId:string,payload:LegacyRecoveryEnrollment):Promise<void>;
}
const defaults:LegacyRecoveryHooks={manifest:captureRepairRevisionManifest,
 chain:async(id,client)=>{const {verifyRunReceiptChain,verifyRunReceiptChainOnClient}=await import('./postgres.js');return (await (client?verifyRunReceiptChainOnClient(client,id):verifyRunReceiptChain(id))).valid;},
 canonicalRoot:async root=>await fs.realpath(root)===root,
 audit:async(c,runId,payload)=>{await appendActionReceipt(c,{runId,agentId:'workflow-orchestrator',actionType:'legacy_current_baseline_enrolled',target:payload.id,summary:'Fresh explicitly authorized legacy recovery baseline; original task, contracts and route remain unchanged.',metadata:JSON.stringify(payload)});
  await c.query('insert into artifacts(run_id,kind,uri,content) values($1,$2,$3,$4::jsonb)',[runId,'legacy_current_baseline_enrollment',`db://workflow_runs/${runId}/legacy_current_baseline_enrollment/${payload.id}`,JSON.stringify(payload)]);}
};
async function transaction<T>(fn:(c:Client)=>Promise<T>):Promise<T>{return withClient(async c=>{await c.query('begin');try{const value=await fn(c);await c.query('commit');return value;}catch(error){await c.query('rollback');throw error;}});}
export const initializeLegacyRecoveryEnrollments=()=>transaction(async c=>{await c.query(legacyRecoverySchemaSql);});
const fail=(message:string):never=>{throw new RepairedRevisionProofError(message);};
const scopes=(value:string[])=>[...value].sort();
function validPaths(paths:string[]){return Array.isArray(paths)&&paths.length>0&&paths.length<=1000&&new Set(paths).size===paths.length&&paths.every(p=>typeof p==='string'&&p.length<=1000&&!p.startsWith('/')&&!p.includes('\\')&&!p.split('/').some(x=>!x||x==='.'||x==='..')&&!/[?*\[\]{}]/u.test(p)&&!/(^|\/)(?:\.env(?:\..*)?|credentials?|secrets?|id_rsa|id_ed25519)(\/|$)/iu.test(p));}
async function original(c:Client,id:string){const row=(await c.query(`select r.*,r.id::text source_id,r.project_id::text project_key,p.root_uri,
 exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical
 from workflow_runs r join projects p on p.id=r.project_id where r.id=$1 for update of r`,[id])).rows[0];if(!row)fail('Original source unavailable');return row;}
function identity(row:any,input:{sourceRunId:string;projectId:string;familyId:string;taskHash:string}){
 const m=row.evaluation_metadata??{};
 if(row.source_id!==input.sourceRunId||row.project_key!==input.projectId||`${row.project_key}:${row.run_set_id}`!==input.familyId||acceptanceDigest(row.task)!==input.taskHash)fail('Original task or execution identity mismatch');
 if(!row.canonical||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(row.root_uri)||['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'].some(k=>Object.hasOwn(m,k)))fail('Canonical original execution scope required');
 if(Object.hasOwn(m,'acceptanceContract'))fail('Existing original acceptance contract cannot use legacy recovery fallback');
 if(m.suiteId||m.evaluationId||/eval(?:uation)?|training/iu.test(String(m.source??'')))fail('Evaluation or training requires separate authorization');
}
async function authorization(c:Client,input:LegacyRecoveryInput|LegacyRecoveryEnrollment){
 const row=(await c.query(`select receipt_hash,metadata from action_receipts where run_id=$1 and action_type='operator_legacy_recovery_authorized'
 and metadata->>'authorizationId'=$2 order by created_at limit 2`,[input.sourceRunId,input.authorizationId])).rows;
 if(row.length!==1||!/^[a-f0-9]{64}$/u.test(row[0].receipt_hash??''))fail('Exact chained direct-human authorization receipt required');
 const m=row[0].metadata;
 if(m?.sourceRunId!==input.sourceRunId||m.projectId!==input.projectId||m.familyId!==input.familyId||m.taskHash!==input.taskHash||!validPaths(m.sourcePaths)||acceptanceDigest(scopes(m.sourcePaths))!==acceptanceDigest(scopes(input.sourcePaths))||m.provider!=='codex-cli'||m.modelTier!=='standard'||m.offlineOnly!==true||m.approvalDecision!=='approved'||m.approvalSource!=='direct-human'||m.authorizationId!==input.authorizationId)fail('Authorization does not bind exact scope and offline route');
 return row[0].receipt_hash as string;
}
async function idleFamily(c:Client,projectId:string,runSetId:string){
 if((await c.query(`select 1 from workflow_runs member where member.project_id=$1 and member.run_set_id=$2 and member.status in ('queued','leased','running')
 union all select 1 from action_approvals a join workflow_runs member on member.id=a.run_id where member.project_id=$1 and member.run_set_id=$2 and a.status in ('pending','executing') limit 1`,[projectId,runSetId])).rowCount)fail('Family activity or approvals remain pending');
}
export async function enrollLegacyRecoveryOnClient(c:Client,input:LegacyRecoveryInput,hooks:Partial<LegacyRecoveryHooks>={}):Promise<LegacyRecoveryEnrollment>{
 const h={...defaults,...hooks};if(!validPaths(input.sourcePaths)||!input.owner||!input.intentFence||!input.authorizationId)fail('Exact source paths and scoped intent required');
 const source=await original(c,input.sourceRunId);identity(source,input);
 if(!await h.canonicalRoot(source.root_uri)||!await h.chain(input.sourceRunId,c))fail('Canonical root or original receipt chain unavailable');
 await idleFamily(c,input.projectId,source.run_set_id);
 const intent=(await c.query(`select file_scopes from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3 and expires_at>now() for update`,[input.projectId,input.owner,input.intentFence])).rows[0];
 if(!intent||acceptanceDigest(scopes(intent.file_scopes))!==acceptanceDigest(scopes(input.sourcePaths)))fail('Live exact scoped work intent required');
 const authorizationReceiptHash=await authorization(c,input);
 const existing=(await c.query('select payload,digest from legacy_recovery_enrollments where source_run_id=$1',[input.sourceRunId])).rows[0];
 if(existing){if(existing.payload.authorizationId!==input.authorizationId||acceptanceDigest(existing.payload.sourcePaths)!==acceptanceDigest(scopes(input.sourcePaths)))fail('Existing immutable enrollment uses another authorization or scope');return (await getLegacyRecoveryEnrollmentOnClient(c,input.sourceRunId,hooks))??fail('Existing enrollment unavailable');}
 const manifest=await h.manifest(source.root_uri,input.sourcePaths),subjectHash=repairRevisionManifestHash(manifest),id=randomUUID();
 // New exact admission decisions bind the observed bytes as well as paths.
 // Preserve old authorization records, but never let a hash-bound decision
 // silently adopt a change that occurred after its human review.
 const reviewed=(await c.query(`select metadata->>'subjectHash' subject_hash from action_receipts where run_id=$1
  and action_type='operator_legacy_recovery_authorized' and metadata->>'authorizationId'=$2`,[input.sourceRunId,input.authorizationId])).rows[0]?.subject_hash;
 if(reviewed!==undefined&&reviewed!==null&&reviewed!==subjectHash)fail('Current source differs from the exact reviewed admission baseline');
 if(acceptanceDigest(manifest.map(e=>e.path).sort())!==acceptanceDigest(scopes(input.sourcePaths)))fail('Captured manifest scope mismatch');
 const payload:LegacyRecoveryEnrollment={id,enrollmentId:id,mode:'legacy-current-baseline',sourceRunId:input.sourceRunId,projectId:input.projectId,familyId:input.familyId,projectRootUri:source.root_uri,taskHash:input.taskHash,policyHash:acceptanceDigest(source.policy_snapshot),sourcePaths:scopes(input.sourcePaths),subjectHash,manifest,provider:'codex-cli',modelTier:'standard',offlineOnly:true,authorizationId:input.authorizationId,authorizationReceiptHash,
 contract:{version:1,contractId:`legacy-current-baseline:${id}`,originRunId:input.sourceRunId,projectId:input.projectId,taskHash:input.taskHash,sourcePaths:scopes(input.sourcePaths),subjectHash,deliverables:[{id:'original-requirements',description:source.task,requiredGates:['implementation','verification','packaging','supervision'],status:'pending',receipts:{},gaps:[]}]}};
 const currentIntent=(await c.query(`select file_scopes from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3 and expires_at>clock_timestamp() for update`,[input.projectId,input.owner,input.intentFence])).rows[0];
 if(!currentIntent||acceptanceDigest(scopes(currentIntent.file_scopes))!==acceptanceDigest(scopes(input.sourcePaths)))fail('Scoped intent expired during baseline capture');
 await idleFamily(c,input.projectId,source.run_set_id);
 await c.query('insert into legacy_recovery_enrollments(id,source_run_id,payload,digest) values($1,$2,$3::jsonb,$4)',[id,input.sourceRunId,JSON.stringify(payload),acceptanceDigest(payload)]);await h.audit(c,input.sourceRunId,payload);return payload;
}
export const enrollLegacyRecovery=(input:LegacyRecoveryInput)=>transaction(c=>enrollLegacyRecoveryOnClient(c,input));
export async function getLegacyRecoveryEnrollmentOnClient(c:Client,sourceRunId:string,hooks:Partial<LegacyRecoveryHooks>={}):Promise<LegacyRecoveryEnrollment|null>{
 const record=(await c.query('select payload,digest from legacy_recovery_enrollments where source_run_id=$1',[sourceRunId])).rows[0];if(!record)return null;
 const p=record.payload as LegacyRecoveryEnrollment,h={...defaults,...hooks};
 if(acceptanceDigest(p)!==record.digest||p.mode!=='legacy-current-baseline'||p.id!==p.enrollmentId||p.sourceRunId!==sourceRunId||p.provider!=='codex-cli'||p.modelTier!=='standard'||p.offlineOnly!==true||!validPaths(p.sourcePaths)||!Array.isArray(p.manifest)||repairRevisionManifestHash(p.manifest.map(({path,mode,hash})=>({path,mode,hash})))!==p.subjectHash)fail('Immutable legacy enrollment invalid');
 const source=await original(c,sourceRunId);identity(source,p);
 if(p.projectRootUri!==source.root_uri||p.policyHash!==acceptanceDigest(source.policy_snapshot)||!await h.canonicalRoot(source.root_uri)||!await h.chain(sourceRunId,c)||await authorization(c,p)!==p.authorizationReceiptHash)fail('Legacy enrollment policy, authorization or receipt proof changed');
 const expected={version:1,contractId:`legacy-current-baseline:${p.id}`,originRunId:sourceRunId,projectId:p.projectId,taskHash:p.taskHash,sourcePaths:p.sourcePaths,subjectHash:p.subjectHash,deliverables:[{id:'original-requirements',description:source.task,requiredGates:['implementation','verification','packaging','supervision'],status:'pending',receipts:{},gaps:[]}]};
 if(acceptanceDigest(p.contract)!==acceptanceDigest(expected)||acceptanceDigest(p.manifest.map(e=>e.path).sort())!==acceptanceDigest(scopes(p.sourcePaths)))fail('Legacy original requirements or scope changed');
 return p;
}
export const getLegacyRecoveryEnrollment=(sourceRunId:string)=>transaction(c=>getLegacyRecoveryEnrollmentOnClient(c,sourceRunId));

/** A new execution baseline is separate evidence, never a rewrite of enrollment. */
export interface LegacyBaselineRevision {
 id:string;enrollmentId:string;sourceRunId:string;projectId:string;previousDigest:string;
 originalContractDigest:string;subjectHash:string;manifest:RepairRevisionManifestEntry[];
 authorizationId:string;authorizationReceiptHash:string;transitionReceiptHashes:string[];
 observationMode?:'independent-current-source';previousSubjectHash?:string;
 historicalContinuity?:'unverified';acceptance?:'unverified';
}
export interface EffectiveLegacyRecoveryEnrollment extends LegacyRecoveryEnrollment {
 originalContractDigest:string;originalSubjectHash:string;baselineRevisionId?:string;baselineRevisionDigest:string;
}
export interface LegacyBaselineReconciliationInput extends LegacyRecoveryInput {
 previousDigest:string;subjectHash:string;transitionReceiptHashes:string[];
}
const hashPattern=/^[a-f0-9]{64}$/u;
/** A separately human-authorized observation is deliberately NOT a proof of
 * historical file transitions. Preserve that distinction in the immutable row;
 * all original deliverables and acceptance gates remain pending and unchanged.
 */
async function currentObservationProof(c:Client,enrollment:LegacyRecoveryEnrollment,previousDigest:string,before:RepairRevisionManifestEntry[],revision:LegacyBaselineRevision){
 if(revision.observationMode!=='independent-current-source'||revision.historicalContinuity!=='unverified'||revision.acceptance!=='unverified'
  ||revision.enrollmentId!==enrollment.id||revision.sourceRunId!==enrollment.sourceRunId||revision.projectId!==enrollment.projectId
  ||revision.previousDigest!==previousDigest||revision.originalContractDigest!==acceptanceDigest(enrollment.contract)
  ||revision.previousSubjectHash!==repairRevisionManifestHash(before.map(({path,mode,hash})=>({path,mode,hash})))
  ||!hashPattern.test(revision.subjectHash)||revision.subjectHash===revision.previousSubjectHash
  ||!Array.isArray(revision.transitionReceiptHashes)||revision.transitionReceiptHashes.length
  ||!Array.isArray(revision.manifest)||acceptanceDigest(revision.manifest.map(e=>e.path).sort())!==acceptanceDigest(scopes(enrollment.sourcePaths))
  ||revision.manifest.some(e=>!hashPattern.test(e.hash)||!Number.isInteger(e.mode))
  ||repairRevisionManifestHash(revision.manifest.map(({path,mode,hash})=>({path,mode,hash})))!==revision.subjectHash
  ||revision.authorizationId===enrollment.authorizationId)fail('Independent current-source observation binding invalid');
 const receiptHash=await authorization(c,{...enrollment,authorizationId:revision.authorizationId});
 if(receiptHash!==revision.authorizationReceiptHash)fail('Independent observation authorization receipt mismatch');
 const times=(await c.query(`select
  (select created_at from action_receipts where run_id=$1 and action_type='operator_legacy_recovery_authorized'
   and metadata->>'authorizationId'=$2) authorized_at,
  (select created_at from legacy_recovery_enrollments where source_run_id=$1 and digest=$3
   union all select created_at from legacy_recovery_baseline_revisions where source_run_id=$1 and digest=$3) predecessor_at`,
  [enrollment.sourceRunId,revision.authorizationId,previousDigest])).rows[0];
 if(!times||!Number.isFinite(new Date(times.authorized_at).getTime())||!Number.isFinite(new Date(times.predecessor_at).getTime())
  ||new Date(times.authorized_at).getTime()<=new Date(times.predecessor_at).getTime())fail('Fresh direct-human observation authorization required');
}
async function revisionProof(c:Client,enrollment:LegacyRecoveryEnrollment,previousDigest:string,before:RepairRevisionManifestEntry[],revision:LegacyBaselineRevision,h:LegacyRecoveryHooks){
 if(revision.observationMode!==undefined)return currentObservationProof(c,enrollment,previousDigest,before,revision);
 if(revision.enrollmentId!==enrollment.id||revision.sourceRunId!==enrollment.sourceRunId||revision.projectId!==enrollment.projectId||revision.previousDigest!==previousDigest||revision.originalContractDigest!==acceptanceDigest(enrollment.contract)||!hashPattern.test(revision.subjectHash)||!revision.authorizationId||!Array.isArray(revision.transitionReceiptHashes)||!revision.transitionReceiptHashes.length||revision.transitionReceiptHashes.length>1000||new Set(revision.transitionReceiptHashes).size!==revision.transitionReceiptHashes.length||!revision.transitionReceiptHashes.every(v=>hashPattern.test(v)))fail('Baseline revision identity or transition references invalid');
 const auth=(await c.query(`select receipt_hash,metadata from action_receipts where run_id=$1 and action_type='operator_legacy_baseline_reconciliation_authorized' and metadata->>'authorizationId'=$2`,[enrollment.sourceRunId,revision.authorizationId])).rows;
 const a=auth[0]?.metadata;
 if(auth.length!==1||auth[0].receipt_hash!==revision.authorizationReceiptHash||!hashPattern.test(auth[0].receipt_hash??'')||a?.approvalSource!=='direct-human'||a.approvalDecision!=='approved'||a.sourceRunId!==enrollment.sourceRunId||a.projectId!==enrollment.projectId||a.familyId!==enrollment.familyId||a.enrollmentId!==enrollment.id||a.taskHash!==enrollment.taskHash||a.originalContractDigest!==acceptanceDigest(enrollment.contract)||a.previousDigest!==previousDigest||a.subjectHash!==revision.subjectHash||a.provider!==enrollment.provider||a.modelTier!==enrollment.modelTier||a.offlineOnly!==true||acceptanceDigest(a.sourcePaths)!==acceptanceDigest(enrollment.sourcePaths)||acceptanceDigest(a.transitionReceiptHashes)!==acceptanceDigest(revision.transitionReceiptHashes))fail('Exact direct-human baseline reconciliation authority required');
 const predecessor=(await c.query(`select created_at from legacy_recovery_enrollments where source_run_id=$1 and digest=$2 union all select created_at from legacy_recovery_baseline_revisions where source_run_id=$1 and digest=$2`,[enrollment.sourceRunId,previousDigest])).rows;
 if(predecessor.length!==1||!Number.isFinite(new Date(predecessor[0].created_at).getTime()))fail('Baseline predecessor timestamp unavailable');
 const state=new Map(before.map(e=>[e.path,{...e}]));let lastTime=new Date(predecessor[0].created_at).getTime();
 for(const receiptHash of revision.transitionReceiptHashes){
  const rows=(await c.query(`select a.run_id::text,a.target,a.metadata,a.created_at from action_receipts a join workflow_runs r on r.id=a.run_id where a.receipt_hash=$1 and a.action_type='file_write' and r.project_id=$2`,[receiptHash,enrollment.projectId])).rows;
  if(rows.length!==1)fail('Exact same-project governed transition receipt required');
  const row=rows[0],w=row.metadata,entry=state.get(w?.relativePath),time=new Date(row.created_at).getTime();
  if(!entry||row.target!==entry.path||w.previousHash!==entry.hash||!hashPattern.test(w.nextHash??'')||!Number.isFinite(time)||time<=lastTime||!await h.chain(row.run_id,c))return fail('Baseline transition preimage, ordering or receipt chain invalid');
  const artifact=(await c.query("select 1 from artifacts where run_id=$1 and kind='file_write' and content=$2::jsonb limit 1",[row.run_id,JSON.stringify(w)])).rowCount;
  if(!artifact)fail('Governed transition artifact missing');
  state.set(entry.path,{...entry,hash:w.nextHash});lastTime=time;
 }
 const expected=[...state.values()].sort((a,b)=>a.path.localeCompare(b.path));
 if(!Array.isArray(revision.manifest)||acceptanceDigest(expected)!==acceptanceDigest([...revision.manifest].sort((a,b)=>a.path.localeCompare(b.path)))||repairRevisionManifestHash(revision.manifest.map(({path,mode,hash})=>({path,mode,hash})))!==revision.subjectHash||revision.subjectHash===repairRevisionManifestHash(before.map(({path,mode,hash})=>({path,mode,hash}))))fail('Baseline manifest has unrelated, mode-changing or unreceipted changes');
}
export async function getEffectiveLegacyRecoveryEnrollmentOnClient(c:Client,sourceRunId:string,hooks:Partial<LegacyRecoveryHooks>={}):Promise<EffectiveLegacyRecoveryEnrollment|null>{
 const originalEnrollment=await getLegacyRecoveryEnrollmentOnClient(c,sourceRunId,hooks);if(!originalEnrollment)return null;
 const h={...defaults,...hooks},exists=(await c.query("select to_regclass('legacy_recovery_baseline_revisions') is not null present")).rows[0]?.present;
 const records=exists?(await c.query('select payload,digest from legacy_recovery_baseline_revisions where source_run_id=$1 order by created_at,id limit 101',[sourceRunId])).rows:[];
 if(records.length>100)fail('Baseline reconciliation chain limit reached');
 let manifest=originalEnrollment.manifest,digest=acceptanceDigest(originalEnrollment),revisionId:string|undefined;
 for(const record of records){const p=record.payload as LegacyBaselineRevision;if(acceptanceDigest(p)!==record.digest)fail('Immutable baseline revision digest invalid');await revisionProof(c,originalEnrollment,digest,manifest,p,h);manifest=p.manifest;digest=record.digest;revisionId=p.id;}
 const subjectHash=repairRevisionManifestHash(manifest.map(({path,mode,hash})=>({path,mode,hash})));
 return {...originalEnrollment,manifest,subjectHash,contract:{...originalEnrollment.contract,subjectHash},originalContractDigest:acceptanceDigest(originalEnrollment.contract),originalSubjectHash:originalEnrollment.subjectHash,baselineRevisionDigest:digest,...(revisionId?{baselineRevisionId:revisionId}:{})};
}
export async function reconcileLegacyRecoveryBaselineOnClient(c:Client,input:LegacyBaselineReconciliationInput,hooks:Partial<LegacyRecoveryHooks>={}):Promise<LegacyBaselineRevision>{
 const h={...defaults,...hooks},effective=await getEffectiveLegacyRecoveryEnrollmentOnClient(c,input.sourceRunId,hooks),enrollment=await getLegacyRecoveryEnrollmentOnClient(c,input.sourceRunId,hooks);
 if(!effective||!enrollment||effective.baselineRevisionDigest!==input.previousDigest||input.projectId!==enrollment.projectId||input.familyId!==enrollment.familyId||input.taskHash!==enrollment.taskHash||acceptanceDigest(scopes(input.sourcePaths))!==acceptanceDigest(enrollment.sourcePaths))return fail('Exact current enrollment baseline required');
 const source=await original(c,input.sourceRunId);await idleFamily(c,input.projectId,source.run_set_id);
 const checkOverlap=async()=>{if((await c.query(`select 1 from queue_coordinator_assignments q where q.project_id=$1 and q.state in ('reserved','running','uncertain') and exists(select 1 from jsonb_array_elements_text(q.file_scopes) held cross join jsonb_array_elements_text($2::jsonb) requested where held=requested or left(held,length(requested)+1)=requested||'/' or left(requested,length(held)+1)=held||'/') limit 1`,[input.projectId,JSON.stringify(enrollment.sourcePaths)])).rowCount)fail('Overlapping coordinator family is active');};
 await checkOverlap();
 const checkIntent=async()=>{const row=(await c.query('select file_scopes from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3 and expires_at>clock_timestamp() for update',[input.projectId,input.owner,input.intentFence])).rows[0];if(!row||acceptanceDigest(scopes(row.file_scopes))!==acceptanceDigest(enrollment.sourcePaths))fail('Live exact baseline reconciliation intent required');};
 await checkIntent();
 const auth=(await c.query("select receipt_hash from action_receipts where run_id=$1 and action_type='operator_legacy_baseline_reconciliation_authorized' and metadata->>'authorizationId'=$2",[input.sourceRunId,input.authorizationId])).rows;
 const revision:LegacyBaselineRevision={id:randomUUID(),enrollmentId:enrollment.id,sourceRunId:input.sourceRunId,projectId:input.projectId,previousDigest:input.previousDigest,originalContractDigest:acceptanceDigest(enrollment.contract),subjectHash:input.subjectHash,manifest:await h.manifest(enrollment.projectRootUri,enrollment.sourcePaths),authorizationId:input.authorizationId,authorizationReceiptHash:auth[0]?.receipt_hash,transitionReceiptHashes:input.transitionReceiptHashes};
 await revisionProof(c,enrollment,input.previousDigest,effective.manifest,revision,h);await checkIntent();await idleFamily(c,input.projectId,source.run_set_id);await checkOverlap();
 if(repairRevisionManifestHash(await h.manifest(enrollment.projectRootUri,enrollment.sourcePaths))!==revision.subjectHash)fail('Source changed during baseline reconciliation');
 await c.query('insert into legacy_recovery_baseline_revisions(id,source_run_id,enrollment_id,previous_digest,payload,digest) values($1,$2,$3,$4,$5::jsonb,$6)',[revision.id,input.sourceRunId,enrollment.id,input.previousDigest,JSON.stringify(revision),acceptanceDigest(revision)]);
 await appendActionReceipt(c,{runId:input.sourceRunId,agentId:'workflow-orchestrator',actionType:'legacy_baseline_reconciled',target:revision.id,summary:'Separately authorized receipt-proven execution baseline; original enrollment, requirements, approvals and terminal history preserved.',metadata:JSON.stringify(revision)});
 return revision;
}
export const reconcileLegacyRecoveryBaseline=(input:LegacyBaselineReconciliationInput)=>transaction(c=>reconcileLegacyRecoveryBaselineOnClient(c,input));
export const getEffectiveLegacyRecoveryEnrollment=(sourceRunId:string)=>transaction(c=>getEffectiveLegacyRecoveryEnrollmentOnClient(c,sourceRunId));

export interface LegacyCurrentSourceObservationInput extends LegacyRecoveryInput {
 previousDigest:string;subjectHash:string;acknowledgeUnprovenContinuity:true;
}
/** Append a new prospective execution baseline only after a fresh exact human
 * current-source decision. Never reconstruct or relabel unrecorded old writes.
 */
export async function observeLegacyRecoveryCurrentSourceOnClient(c:Client,input:LegacyCurrentSourceObservationInput,hooks:Partial<LegacyRecoveryHooks>={}):Promise<LegacyBaselineRevision>{
 if(input.acknowledgeUnprovenContinuity!==true)fail('Explicit unverified-continuity acknowledgment required');
 const h={...defaults,...hooks},source=await original(c,input.sourceRunId);
 const enrollment=await getLegacyRecoveryEnrollmentOnClient(c,input.sourceRunId,hooks),effective=await getEffectiveLegacyRecoveryEnrollmentOnClient(c,input.sourceRunId,hooks);
 if(!enrollment||!effective||input.projectId!==enrollment.projectId||input.familyId!==enrollment.familyId||input.taskHash!==enrollment.taskHash
  ||!validPaths(input.sourcePaths)||acceptanceDigest(scopes(input.sourcePaths))!==acceptanceDigest(enrollment.sourcePaths)
  ||input.previousDigest!==effective.baselineRevisionDigest)return fail('Exact original requirements and current baseline required');
 const preflight=async()=>{
  await idleFamily(c,input.projectId,source.run_set_id);
  const intent=(await c.query(`select file_scopes from work_intents where project_id=$1 and owner=$2
   and fencing_token::text=$3 and expires_at>clock_timestamp() for update`,[input.projectId,input.owner,input.intentFence])).rows[0];
  if(!intent||acceptanceDigest(scopes(intent.file_scopes))!==acceptanceDigest(enrollment.sourcePaths))fail('Exact observation intent required');
  if((await c.query(`select 1 from queue_coordinator_assignments q where q.project_id=$1 and q.state in ('reserved','running','uncertain')
   and exists(select 1 from jsonb_array_elements_text(q.file_scopes) held cross join jsonb_array_elements_text($2::jsonb) requested
    where held=requested or left(held,length(requested)+1)=requested||'/' or left(requested,length(held)+1)=held||'/') limit 1`,
   [input.projectId,JSON.stringify(enrollment.sourcePaths)])).rowCount)fail('Overlapping coordinator execution remains');
 };
 await preflight();
 if((await c.query(`select 1 from legacy_recovery_baseline_revisions where source_run_id=$1 and payload->>'authorizationId'=$2 limit 1`,
  [input.sourceRunId,input.authorizationId])).rowCount)fail('Human observation authorization already consumed');
 const revision:LegacyBaselineRevision={id:randomUUID(),enrollmentId:enrollment.id,sourceRunId:input.sourceRunId,projectId:input.projectId,
  previousDigest:input.previousDigest,originalContractDigest:acceptanceDigest(enrollment.contract),subjectHash:input.subjectHash,
  manifest:await h.manifest(enrollment.projectRootUri,enrollment.sourcePaths),authorizationId:input.authorizationId,
  authorizationReceiptHash:await authorization(c,{...enrollment,authorizationId:input.authorizationId}),transitionReceiptHashes:[],
  observationMode:'independent-current-source',previousSubjectHash:effective.subjectHash,historicalContinuity:'unverified',acceptance:'unverified'};
 await currentObservationProof(c,enrollment,effective.baselineRevisionDigest,effective.manifest,revision);
 await preflight();
 if(repairRevisionManifestHash(await h.manifest(enrollment.projectRootUri,enrollment.sourcePaths))!==revision.subjectHash)fail('Source changed during independent observation');
 await c.query('insert into legacy_recovery_baseline_revisions(id,source_run_id,enrollment_id,previous_digest,payload,digest) values($1,$2,$3,$4,$5::jsonb,$6)',
  [revision.id,input.sourceRunId,enrollment.id,input.previousDigest,JSON.stringify(revision),acceptanceDigest(revision)]);
 await appendActionReceipt(c,{runId:input.sourceRunId,agentId:'workflow-orchestrator',actionType:'legacy_current_source_observed',target:revision.id,
  summary:'Fresh human-authorized prospective baseline; historical transition continuity unverified, original requirements and acceptance gates unchanged.',metadata:JSON.stringify(revision)});
 return revision;
}
export const observeLegacyRecoveryCurrentSource=(input:LegacyCurrentSourceObservationInput)=>transaction(c=>observeLegacyRecoveryCurrentSourceOnClient(c,input));
