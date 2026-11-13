import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Client } from "pg";
import { withClient } from "./client.js";
import { acceptanceDigest, acceptancePreflight } from "./acceptance.js";
import { appendActionReceipt } from "./receipt-writer.js";
import type { CoordinatorClaim } from "./queue-coordinator.js";
import { getEffectiveLegacyRecoveryEnrollmentOnClient as getLegacyRecoveryEnrollmentOnClient } from "./legacy-recovery.js";

/** Expected unavailable/stale proof is a per-family hold, not a storage outage. */
export class RepairedRevisionProofError extends Error {
 constructor(message:string){super(message);this.name='RepairedRevisionProofError';}
}

export const repairedRevisionSchemaSql = `
create table if not exists repaired_revision_records (
 id uuid primary key,kind text not null check(kind in ('baseline','candidate','attestation')),
 source_run_id uuid not null references workflow_runs(id),claim_id uuid not null references queue_coordinator_assignments(id),
 payload jsonb not null,digest text not null,created_at timestamptz not null default clock_timestamp(),
 unique(kind,claim_id)
);
create or replace function forbid_repaired_revision_mutation() returns trigger language plpgsql as $$
begin raise exception 'Repaired revision records are immutable'; end $$;
drop trigger if exists repaired_revision_immutable on repaired_revision_records;
create trigger repaired_revision_immutable before update or delete on repaired_revision_records
 for each row execute function forbid_repaired_revision_mutation();
drop trigger if exists repaired_revision_no_truncate on repaired_revision_records;
create trigger repaired_revision_no_truncate before truncate on repaired_revision_records
 for each statement execute function forbid_repaired_revision_mutation();`;

export interface RepairRevisionManifestEntry { path:string; mode:number; hash:string }
export interface RepairRevisionHooks {
 manifest(root:string,paths:string[]):Promise<RepairRevisionManifestEntry[]>;
 chain(runId:string):Promise<boolean>;
 audit(c:Client,runId:string,kind:string,payload:Record<string,unknown>):Promise<void>;
 preflight(c:Client,runId:string,artifact:Record<string,unknown>):Promise<{accepted:boolean}>;
}
export interface RepairRevisionCandidate extends Record<string,unknown> {
 id:string;sourceRunId:string;projectId:string;projectRootUri:string;repairRunId:string;repairClaimId:string;repairOwner:string;
 originalContractDigest:string;requirementsDigest:string;sourceHash:string;repairedHash:string;sourcePaths:string[];baselineId:string;
 manifest:RepairRevisionManifestEntry[];
 legacyEnrollmentId?:string;
}
// PostgreSQL jsonb does not retain object-key order. Bind the exact fields in
// the same order as sourceSubjectHash, never storage serialization order.
export const repairRevisionManifestHash=(manifest:RepairRevisionManifestEntry[])=>createHash("sha256").update(JSON.stringify(manifest.map(({path,mode,hash})=>({path,mode,hash})))).digest("hex");
export function repairRevisionRequirementsDigest(contract:any):string {
 if(!contract||!Array.isArray(contract.deliverables)||!contract.deliverables.length)throw new RepairedRevisionProofError("Original requirements unavailable");
 return acceptanceDigest(contract.deliverables.map(({id,description,requiredGates,advisory,severity}:any)=>({id,description,requiredGates,advisory,severity})));
}
export async function captureRepairRevisionManifest(root:string,paths:string[]):Promise<RepairRevisionManifestEntry[]> {
 if(!paths.length||paths.length>1000||new Set(paths).size!==paths.length)throw new RepairedRevisionProofError("Invalid exact source scope");
 const base=await fs.realpath(root),manifest:RepairRevisionManifestEntry[]=[];let bytes=0;
 for(const relative of [...paths].sort()){
  if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/u).some(p=>!p||p==='.'||p==='..'))throw new RepairedRevisionProofError("Invalid source path");
  const target=path.resolve(base,relative);
  if(!target.startsWith(base+path.sep)||await fs.realpath(target)!==target)throw new RepairedRevisionProofError("Source symlink denied");
  const before=await fs.stat(target);bytes+=before.size;
  if(!before.isFile()||bytes>64*1024*1024)throw new RepairedRevisionProofError("Source bound exceeded");
  const content=await fs.readFile(target),after=await fs.stat(target);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino||before.mode!==after.mode)throw new RepairedRevisionProofError("Source changed during capture");
  manifest.push({path:relative,mode:before.mode&0o777,hash:createHash('sha256').update(content).digest('hex')});
 }
 return manifest;
}
const defaults:RepairRevisionHooks={manifest:captureRepairRevisionManifest,chain:async id=>{const {verifyRunReceiptChain}=await import('./postgres.js');return(await verifyRunReceiptChain(id)).valid;},preflight:acceptancePreflight,
 audit:async(c,runId,kind,payload)=>{
  await appendActionReceipt(c,{runId,agentId:'workflow-orchestrator',actionType:kind,target:String(payload.id),summary:'Immutable repaired revision evidence; original workflow unchanged.',metadata:JSON.stringify(payload)});
  await c.query('insert into artifacts(run_id,kind,uri,content) values($1,$2,$3,$4::jsonb)',[runId,kind,`db://workflow_runs/${runId}/${kind}/${payload.id}`,JSON.stringify(payload)]);
 }};
const hooksFor=(hooks:Partial<RepairRevisionHooks>)=>({...defaults,...hooks});
async function transaction<T>(body:(c:Client)=>Promise<T>):Promise<T>{return withClient(async c=>{await c.query('begin');try{const v=await body(c);await c.query('commit');return v;}catch(e){await c.query('rollback');throw e;}});}
export const initializeRepairedRevisions=()=>transaction(async c=>{await c.query(repairedRevisionSchemaSql);});
async function liveClaim(c:Client,claim:CoordinatorClaim,role:'repair'|'verifier'){
 const row=(await c.query(`select q.*,q.child_run_id::text child_id,p.root_uri from queue_coordinator_assignments q join projects p on p.id=q.project_id
  join work_intents i on i.project_id::text=q.project_id::text and i.owner=q.owner and i.fencing_token::text=q.intent_fence and i.expires_at>now()
  where q.id=$1 and q.fence=$2::bigint and q.owner=$3 and q.role=$4 and q.state in ('reserved','running') for update of q,i`,[claim.id,claim.fence,claim.owner,role])).rows[0];
 if(!row||String(row.source_run_id)!==claim.sourceRunId||String(row.project_id)!==claim.projectId||row.root_uri!==claim.projectRootUri||row.intent_fence!==claim.intentFence||row.family_id!==claim.familyId||row.lane!==claim.lane||row.fingerprint!==claim.fingerprint||acceptanceDigest(row.file_scopes)!==acceptanceDigest(claim.fileScopes)||claim.role!==role||(row.legacy_enrollment_id??undefined)!==claim.legacyEnrollmentId)throw new RepairedRevisionProofError('Live matching coordinator claim and intent required');
 const intent=(await c.query('select file_scopes from work_intents where project_id=$1 and owner=$2',[claim.projectId,claim.owner])).rows[0];
 if(acceptanceDigest(intent?.file_scopes)!==acceptanceDigest(claim.fileScopes))throw new RepairedRevisionProofError('Intent scope changed');
 return row;
}
async function run(c:Client,id:string){const row=(await c.query('select *,id::text run_id,project_id::text project_key from workflow_runs where id=$1 for share',[id])).rows[0];if(!row)throw new RepairedRevisionProofError('Run unavailable');return row;}
export async function effectiveRepairContractOnClient(c:Client,source:any,claim:Pick<CoordinatorClaim,'projectId'|'sourceRunId'|'fileScopes'|'legacyEnrollmentId'>){
 const frozen=source.evaluation_metadata?.acceptanceContract;
 const legacy=!frozen?await getLegacyRecoveryEnrollmentOnClient(c,claim.sourceRunId):null;
 if(legacy?claim.legacyEnrollmentId!==legacy.enrollmentId:claim.legacyEnrollmentId!==undefined)throw new RepairedRevisionProofError('Exact legacy recovery enrollment binding required');
 const contract=frozen??legacy?.contract;
 if(source.project_key!==claim.projectId||contract?.version!==1||contract.originRunId!==claim.sourceRunId||contract.projectId!==claim.projectId||contract.taskHash!==acceptanceDigest(source.task)||!contract.contractId||!contract.subjectHash||acceptanceDigest([...(contract.sourcePaths??[])].sort())!==acceptanceDigest([...claim.fileScopes].sort()))throw new RepairedRevisionProofError('Original frozen contract identity mismatch');
 for(const gate of ['implementation','verification','packaging','supervision'])if(!contract.deliverables?.some((d:any)=>d.requiredGates?.includes(gate)))throw new RepairedRevisionProofError('Original four gates required');
 repairRevisionRequirementsDigest(contract);return {contract,legacy};
}
async function chains(h:RepairRevisionHooks,ids:string[]){for(const id of new Set(ids))if(!await h.chain(id))throw new RepairedRevisionProofError('Receipt chain invalid');}
async function store(c:Client,kind:string,claim:CoordinatorClaim,payload:Record<string,unknown>,h:RepairRevisionHooks){
 await c.query('insert into repaired_revision_records(id,kind,source_run_id,claim_id,payload,digest) values($1,$2,$3,$4,$5::jsonb,$6)',[payload.id,kind,claim.sourceRunId,claim.id,JSON.stringify(payload),acceptanceDigest(payload)]);
 await h.audit(c,claim.sourceRunId,`repaired_revision_${kind}`,payload);
}
async function record(c:Client,id:string,kind:string){const row=(await c.query('select payload,digest,created_at from repaired_revision_records where id=$1 and kind=$2 for share',[id,kind])).rows[0];if(!row||acceptanceDigest(row.payload)!==row.digest)throw new RepairedRevisionProofError('Immutable revision record invalid');return row;}
async function terminal(c:Client,id:string){
 if((await run(c,id)).status!=='completed')throw new RepairedRevisionProofError('Completed governed child required');
 if((await c.query("select 1 from action_approvals where run_id=$1 and status in ('pending','executing') union all select 1 from workflow_tasks where run_id=$1 and status in ('queued','leased','running') limit 1",[id])).rowCount)throw new RepairedRevisionProofError('Active approvals or tasks remain');
}
async function lineageApprovals(c:Client,sourceRunId:string,excludedRunId:string|null=null){
 const result=await c.query(`with recursive family(id) as (
  select r.id from workflow_runs r join workflow_runs original on original.id=$1
   where r.id=original.id or (r.project_id=original.project_id and r.run_set_id=original.run_set_id)
  union select child.id from workflow_runs child join family parent on parent.id::text in (
   child.evaluation_metadata->>'sourceRunId',child.evaluation_metadata->>'replayOfRunId',
   child.evaluation_metadata->>'repairOriginRunId',child.evaluation_metadata->>'parentRunId')
 ) select 1 from action_approvals where run_id in (select id from family) and status in ('pending','executing')
 union all select 1 from workflow_runs where id in (select id from family) and id<>coalesce($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid) and status in ('queued','leased','running')
 union all select 1 from workflow_tasks where run_id in (select id from family) and run_id<>coalesce($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid) and status in ('queued','leased','running') limit 1`,[sourceRunId,excludedRunId]);
 if(result.rowCount)throw new RepairedRevisionProofError('Original lineage approvals or activity remain pending');
}
function childBinding(child:any,claim:CoordinatorClaim){const m=child.evaluation_metadata;
 if(child.project_key!==claim.projectId||m?.sourceRunId!==claim.sourceRunId||m?.queueCoordinatorClaimId!==claim.id||m?.queueCoordinatorFence!==claim.fence)throw new RepairedRevisionProofError('Exact child provenance required');
}
function sameOriginalRoute(source:any,child:any,effective:{contract:any;legacy:any}){
 const provider=effective.legacy?.provider??source.provider_override,tier=effective.legacy?.modelTier??source.model_tier_override;
 if(typeof provider!=='string'||!provider.trim()||typeof tier!=='string'||!tier.trim()||child.provider_override!==provider||child.model_tier_override!==tier)throw new RepairedRevisionProofError('Exact explicit original provider and tier required');
 if(effective.legacy&&child.evaluation_metadata?.legacyEnrollmentId!==effective.legacy.enrollmentId)throw new RepairedRevisionProofError('Legacy child enrollment binding changed');
 const binding=child.evaluation_metadata?.originalAcceptanceDigest;
 if((binding!==undefined||effective.legacy)&&binding!==acceptanceDigest(effective.contract))throw new RepairedRevisionProofError('Original acceptance metadata binding changed');
}

/** Capture before any repair writes. Missing historical preimages cannot be manufactured. */
export async function captureRepairRevisionBaselineOnClient(c:Client,claim:CoordinatorClaim,hooks:Partial<RepairRevisionHooks>={}){
 const h=hooksFor(hooks),q=await liveClaim(c,claim,'repair');await lineageApprovals(c,claim.sourceRunId,q.child_id);const source=await run(c,claim.sourceRunId),effective=await effectiveRepairContractOnClient(c,source,claim),{contract}=effective;
 if((await c.query("select 1 from artifacts where run_id in (select child_run_id from queue_coordinator_assignments where id=$1) and kind='file_write' limit 1",[claim.id])).rowCount)throw new RepairedRevisionProofError('Baseline must precede repair writes');
 await chains(h,[claim.sourceRunId]);const manifest=await h.manifest(claim.projectRootUri,claim.fileScopes);
 if(repairRevisionManifestHash(manifest)!==contract.subjectHash)throw new RepairedRevisionProofError('Actual preimage does not match original source');
 const baseline={id:randomUUID(),sourceRunId:claim.sourceRunId,projectId:claim.projectId,repairClaimId:claim.id,repairOwner:claim.owner,originalContractDigest:acceptanceDigest(contract),requirementsDigest:repairRevisionRequirementsDigest(contract),sourceHash:contract.subjectHash,sourcePaths:claim.fileScopes,manifest,...(effective.legacy?{legacyEnrollmentId:effective.legacy.enrollmentId}:{} )};
 await store(c,'baseline',claim,baseline,h);return baseline;
}
export const captureRepairRevisionBaseline=(claim:CoordinatorClaim)=>transaction(c=>captureRepairRevisionBaselineOnClient(c,claim));
export async function recordRepairRevisionCandidateOnClient(c:Client,claim:CoordinatorClaim,hooks:Partial<RepairRevisionHooks>={}):Promise<RepairRevisionCandidate>{
 const h=hooksFor(hooks),q=await liveClaim(c,claim,'repair'),source=await run(c,claim.sourceRunId),effective=await effectiveRepairContractOnClient(c,source,claim),{contract}=effective;await lineageApprovals(c,claim.sourceRunId);
 if(!q.child_id)throw new RepairedRevisionProofError('Repair child missing');const child=await run(c,q.child_id);childBinding(child,claim);sameOriginalRoute(source,child,effective);await terminal(c,q.child_id);
 const b=(await c.query("select id from repaired_revision_records where claim_id=$1 and kind='baseline'",[claim.id])).rows[0];if(!b)throw new RepairedRevisionProofError('Pre-repair baseline unavailable');const baselineRecord=await record(c,String(b.id),'baseline'),baseline=baselineRecord.payload;
 if(baseline.originalContractDigest!==acceptanceDigest(contract)||baseline.legacyEnrollmentId!==claim.legacyEnrollmentId)throw new RepairedRevisionProofError('Original contract changed');
 await chains(h,[claim.sourceRunId,q.child_id]);
 const manifest=await h.manifest(claim.projectRootUri,claim.fileScopes),before=new Map<string,RepairRevisionManifestEntry>(baseline.manifest.map((e:RepairRevisionManifestEntry)=>[e.path,e]));
 const writes=(await c.query("select a.content,a.created_at from artifacts a where a.run_id=$1 and a.kind='file_write' order by a.created_at,a.id",[q.child_id])).rows;
 if(!writes.length&&!effective.legacy)throw new RepairedRevisionProofError('Governed file-write evidence required');
 for(const {content:w,created_at} of writes){const previous=before.get(w.relativePath);
  const receipt=(await c.query("select 1 from action_receipts where run_id=$1 and action_type='file_write' and target=$2 and metadata=$3::jsonb limit 1",[q.child_id,w.relativePath,JSON.stringify(w)])).rowCount;
  if(!previous||!receipt||typeof w.previousHash!=='string'||w.previousHash!==previous.hash||typeof w.nextHash!=='string'||!Number.isFinite(Date.parse(String(created_at)))||new Date(created_at).getTime()<=new Date(baselineRecord.created_at).getTime())throw new RepairedRevisionProofError('Governed preimage transition mismatch');before.set(w.relativePath,{...previous,hash:w.nextHash});}
 if(manifest.length!==before.size||manifest.some(e=>acceptanceDigest(e)!==acceptanceDigest(before.get(e.path))))throw new RepairedRevisionProofError('Unrelated or unreceipted source changes');
 const repairedHash=repairRevisionManifestHash(manifest);if(repairedHash===contract.subjectHash&&!effective.legacy)throw new RepairedRevisionProofError('No repaired revision');
 const candidate:RepairRevisionCandidate={id:randomUUID(),sourceRunId:claim.sourceRunId,projectId:claim.projectId,projectRootUri:claim.projectRootUri,repairRunId:q.child_id,repairClaimId:claim.id,repairOwner:claim.owner,originalContractDigest:acceptanceDigest(contract),requirementsDigest:repairRevisionRequirementsDigest(contract),sourceHash:contract.subjectHash,repairedHash,sourcePaths:claim.fileScopes,baselineId:baseline.id,manifest,...(effective.legacy?{legacyEnrollmentId:effective.legacy.enrollmentId}:{} ),...(child.evaluation_metadata?.historyAssessment?{provenanceKind:'authorized-current-baseline-assessment',historyAssessment:child.evaluation_metadata.historyAssessment}:{})};
 await store(c,'candidate',claim,candidate,h);return candidate;
}
export const recordRepairRevisionCandidate=(claim:CoordinatorClaim)=>transaction(c=>recordRepairRevisionCandidateOnClient(c,claim));
export async function listRepairRevisionCandidates(sourceRunId?:string){return withClient(async c=>(await c.query("select id::text,payload,digest,created_at from repaired_revision_records where kind='candidate' and ($1::uuid is null or source_run_id=$1) order by created_at desc limit 100",[sourceRunId??null])).rows);}

export async function attestRepairedRevisionOnClient(c:Client,claim:CoordinatorClaim,candidateId:string,verificationRunId:string,hooks:Partial<RepairRevisionHooks>={}){
 const h=hooksFor(hooks),q=await liveClaim(c,claim,'verifier'),recorded=await record(c,candidateId,'candidate'),candidate=recorded.payload as RepairRevisionCandidate;await lineageApprovals(c,claim.sourceRunId);
 if(candidate.sourceRunId!==claim.sourceRunId||candidate.projectId!==claim.projectId||candidate.projectRootUri!==claim.projectRootUri||candidate.repairOwner===claim.owner||candidate.repairClaimId===claim.id||q.child_id!==verificationRunId||acceptanceDigest(candidate.sourcePaths)!==acceptanceDigest(claim.fileScopes))throw new RepairedRevisionProofError('Independent verifier candidate binding required');
 const source=await run(c,claim.sourceRunId),effective=await effectiveRepairContractOnClient(c,source,claim),original=effective.contract,verification=await run(c,verificationRunId);childBinding(verification,claim);sameOriginalRoute(source,verification,effective);sameOriginalRoute(source,await run(c,candidate.repairRunId),effective);await terminal(c,verificationRunId);
 if(candidate.legacyEnrollmentId!==claim.legacyEnrollmentId)throw new RepairedRevisionProofError('Candidate legacy enrollment changed');
 const metadata=verification.evaluation_metadata,contract=metadata?.acceptanceContract;
 if(metadata?.repairedRevisionCandidateId!==candidateId||metadata?.repairedRevisionSourceRunId!==claim.sourceRunId||new Date(verification.started_at).getTime()<=new Date(recorded.created_at).getTime()||acceptanceDigest(original)!==candidate.originalContractDigest||contract?.version!==1||contract.originRunId!==verificationRunId||contract.projectId!==claim.projectId||contract.taskHash!==acceptanceDigest(verification.task)||!contract.contractId||contract.contractId===original.contractId||contract.subjectHash!==candidate.repairedHash||repairRevisionRequirementsDigest(contract)!==candidate.requirementsDigest||acceptanceDigest(contract.sourcePaths)!==acceptanceDigest(candidate.sourcePaths))throw new RepairedRevisionProofError('Fresh equivalent verification contract required');
 if(!Array.isArray(verification.policy_snapshot?.actions?.allowed_write_paths)||verification.policy_snapshot.actions.allowed_write_paths.length!==0)throw new RepairedRevisionProofError('Verifier must have read-only write policy');
 if((await c.query("select 1 from artifacts where run_id=$1 and kind='file_write' limit 1",[verificationRunId])).rowCount)throw new RepairedRevisionProofError('Verifier wrote source');
 await chains(h,[claim.sourceRunId,candidate.repairRunId,verificationRunId]);
 const outputs=(await c.query("select content from artifacts where run_id=$1 and kind in ('stage_output','direct_repair_validation') order by created_at desc limit 100",[verificationRunId])).rows;
 let accepted=false;for(const {content} of outputs){if((await h.preflight(c,verificationRunId,content?.artifact??content)).accepted){accepted=true;break;}}
 if(!accepted||repairRevisionManifestHash(await h.manifest(claim.projectRootUri,claim.fileScopes))!==candidate.repairedHash)throw new RepairedRevisionProofError('Four-gate acceptance or current repaired source missing');
 const attestation={id:randomUUID(),sourceRunId:claim.sourceRunId,candidateId,verificationRunId,verificationContractDigest:acceptanceDigest(contract),verifierClaimId:claim.id,verifierOwner:claim.owner,originalContractDigest:candidate.originalContractDigest,requirementsDigest:candidate.requirementsDigest,repairedHash:candidate.repairedHash,originalWorkflowUnchanged:true,...(effective.legacy?{legacyEnrollmentId:effective.legacy.enrollmentId,baselineMode:effective.legacy.mode}:{} )};
 await store(c,'attestation',claim,attestation,h);return attestation;
}
export const attestRepairedRevision=(claim:CoordinatorClaim,candidateId:string,verificationRunId:string)=>transaction(c=>attestRepairedRevisionOnClient(c,claim,candidateId,verificationRunId));
export async function verifyRepairedRevisionAttestationOnClient(c:Client,sourceRunId:string,currentHash:string,hooks:Partial<RepairRevisionHooks>={}):Promise<boolean>{
 const h=hooksFor(hooks);
 await lineageApprovals(c,sourceRunId);
 const rows=(await c.query("select payload,digest from repaired_revision_records where source_run_id=$1 and kind='attestation' order by created_at desc limit 100",[sourceRunId])).rows;
 for(const row of rows){if(acceptanceDigest(row.payload)!==row.digest||row.payload.repairedHash!==currentHash)continue;
  const candidate=(await record(c,row.payload.candidateId,'candidate')).payload;
  const source=await run(c,sourceRunId);
  const effective=await effectiveRepairContractOnClient(c,source,{projectId:candidate.projectId,sourceRunId,fileScopes:candidate.sourcePaths,legacyEnrollmentId:candidate.legacyEnrollmentId});
  if(candidate.originalContractDigest!==acceptanceDigest(effective.contract)||row.payload.legacyEnrollmentId!==candidate.legacyEnrollmentId)continue;
  await terminal(c,candidate.repairRunId);await terminal(c,row.payload.verificationRunId);
  const verification=await run(c,row.payload.verificationRunId);
  sameOriginalRoute(source,verification,effective);sameOriginalRoute(source,await run(c,candidate.repairRunId),effective);
  if((await c.query("select 1 from artifacts where run_id=$1 and kind='file_write' limit 1",[row.payload.verificationRunId])).rowCount)continue;
  if(acceptanceDigest(verification.evaluation_metadata?.acceptanceContract)!==row.payload.verificationContractDigest||verification.evaluation_metadata?.repairedRevisionCandidateId!==candidate.id||verification.evaluation_metadata?.repairedRevisionSourceRunId!==sourceRunId||!Array.isArray(verification.policy_snapshot?.actions?.allowed_write_paths)||verification.policy_snapshot.actions.allowed_write_paths.length)continue;
  const artifacts=(await c.query("select content from artifacts where run_id=$1 and kind in ('stage_output','direct_repair_validation') order by created_at desc limit 100",[row.payload.verificationRunId])).rows;
  let accepted=false;for(const {content} of artifacts){if((await h.preflight(c,row.payload.verificationRunId,content?.artifact??content)).accepted){accepted=true;break;}}
  if(!accepted)continue;
  await chains(h,[sourceRunId,candidate.repairRunId,row.payload.verificationRunId]);
  if(repairRevisionManifestHash(await h.manifest(candidate.projectRootUri,candidate.sourcePaths))===currentHash)return true;
 }return false;
}
export const verifyRepairedRevisionAttestation=(sourceRunId:string,currentHash:string)=>withClient(c=>verifyRepairedRevisionAttestationOnClient(c,sourceRunId,currentHash));
