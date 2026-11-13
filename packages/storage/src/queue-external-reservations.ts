import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {withClient} from './client.js';
import {acceptanceDigest} from './acceptance.js';
import {appendActionReceipt} from './receipt-writer.js';
import {QUEUE_SHARED_ITEM_LIMIT} from '../../workflow-engine/src/queue-coordinator-plan.js';

export interface ExternalQueueReservationInput {
 sourceRunId:string;projectId:string;projectRootUri:string;familyId:string;
 owner:string;intentId:string;intentFence:string;fileScopes:string[];role:'repair'|'verifier';authorizationArtifactUri:string;
}
export interface ExternalQueueReservation extends ExternalQueueReservationInput {
 version:1;id:string;authorizationDigest:string;expiresAt:string;
 restrictiveOnly:true;grantsExecution:false;workingEvidence:false;
}
export interface ExternalQueueReservationHooks {
 now():number;
 chain(c:Client,runId:string):Promise<boolean>;
 audit(c:Client,runId:string,uri:string,content:ExternalQueueReservation):Promise<void>;
}
const defaults:ExternalQueueReservationHooks={now:Date.now,chain:async(c,runId)=>{
 const {verifyRunReceiptChainOnClient}=await import('./postgres.js');return(await verifyRunReceiptChainOnClient(c,runId)).valid;
},audit:async(c,runId,uri,content)=>{
 await appendActionReceipt(c,{runId,agentId:'workflow-orchestrator',actionType:'queue_external_reservation_registered',target:uri,summary:'Restrictive external source reservation only; no working activity, execution or acceptance asserted.',metadata:JSON.stringify(content)});
 await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'queue_external_reservation',$2,$3::jsonb)",[runId,uri,JSON.stringify(content)]);
}};
const equal=(a:unknown,b:unknown)=>acceptanceDigest(a)===acceptanceDigest(b);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(v);
function exactPaths(paths:unknown):paths is string[]{return Array.isArray(paths)&&paths.length>0&&paths.length<=1000&&new Set(paths).size===paths.length&&paths.every(p=>{
 if(typeof p!=='string'||!p.length||p.length>1000)return false;
 // A literal terminal subtree is retained verbatim for equality, never expanded
 // or interpreted as permission to execute or write within that subtree.
 const prefix=p.endsWith('/**')?p.slice(0,-3):p;
 return !!prefix&&!prefix.startsWith('/')&&!/^[A-Za-z]:/u.test(prefix)&&!/[\\*?\[\]{}\x00-\x1f\x7f]/u.test(prefix)&&prefix.split('/').every(part=>!!part&&part!=='.'&&part!=='..');
});}
function validInput(input:ExternalQueueReservationInput){return uuid(input.sourceRunId)&&uuid(input.projectId)&&uuid(input.intentId)&&typeof input.owner==='string'&&input.owner.length>0&&input.owner.length<=200&&/^\d+$/u.test(input.intentFence)&&['repair','verifier'].includes(input.role)&&exactPaths(input.fileScopes)&&typeof input.authorizationArtifactUri==='string'&&input.authorizationArtifactUri.startsWith('db://')&&input.authorizationArtifactUri.length<=1000;}
function binding(input:ExternalQueueReservationInput){return {sourceRunId:input.sourceRunId,projectId:input.projectId,projectRootUri:input.projectRootUri,familyId:input.familyId,owner:input.owner,intentId:input.intentId,intentFence:input.intentFence,fileScopes:[...input.fileScopes].sort(),role:input.role};}

/** Authorization creates no execution rights. Exact direct-human provenance is
 * required even for this deliberately restrictive capacity-only record. */
async function authorization(c:Client,input:ExternalQueueReservationInput,h:ExternalQueueReservationHooks){
 if(!validInput(input))return null;
 const r=(await c.query(`select r.id::text,r.project_id::text,r.run_set_id::text,r.task,r.evaluation_metadata,p.root_uri,
  exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical
  from workflow_runs r join projects p on p.id=r.project_id where r.id=$1 for share of r,p`,[input.sourceRunId])).rows[0];
 if(!r?.canonical||r.project_id!==input.projectId||r.root_uri!==input.projectRootUri||input.familyId!==`${r.project_id}:${r.run_set_id}`||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(r.root_uri)
  ||['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'].some(key=>r.evaluation_metadata?.[key]))return null;
 const rows=(await c.query("select content from artifacts where run_id=$1 and uri=$2 and kind='queue_external_reservation_authorization' for share",[input.sourceRunId,input.authorizationArtifactUri])).rows;
 const a=rows[0]?.content;
 if(rows.length!==1||a?.version!==1||a.purpose!=='restrictive-external-queue-reservation'||a.authority!=='direct-human'||a.approvalDecision!=='approved'||!uuid(a.authorizationId)||!exactPaths(a.fileScopes)
  ||typeof a.approvalEvidence!=='string'||!a.approvalEvidence.trim()||a.restrictiveOnly!==true||a.grantsExecution!==false||a.taskHash!==acceptanceDigest(r.task)||!equal(binding(a),binding(input)))return null;
 const expiry=Date.parse(a.expiresAt),now=h.now();
 if(!Number.isFinite(expiry)||a.expiresAt!==new Date(expiry).toISOString()||expiry<=now||expiry>now+900_000)return null;
 const intent=(await c.query(`select file_scopes,expires_at from work_intents i where project_id::text=$1 and owner=$2 and fencing_token::text=$3 and to_jsonb(i)->>'id'=$4 and expires_at>clock_timestamp() for share`,[input.projectId,input.owner,input.intentFence,input.intentId])).rows;
 if(intent.length!==1||!exactPaths(intent[0].file_scopes)||!equal([...intent[0].file_scopes].sort(),[...input.fileScopes].sort())||expiry>new Date(intent[0].expires_at).getTime())return null;
 const proof=(await c.query(`select receipt_hash from action_receipts where run_id=$1 and action_type='queue_external_reservation_authorized'
  and target=$2 and metadata=$3::jsonb and agent_id='workflow-orchestrator' limit 2`,[input.sourceRunId,input.authorizationArtifactUri,JSON.stringify(a)])).rows;
 if(proof.length!==1||!hash(proof[0].receipt_hash))return null;
 if(!await h.chain(c,input.sourceRunId))throw Error('External reservation receipt chain is unverifiable; capacity reconciliation required');
 if((await c.query("select 1 from artifacts where kind='queue_external_reservation_authorization' and content->>'authorizationId'=$1 and uri<>$2 limit 1",[a.authorizationId,input.authorizationArtifactUri])).rowCount)throw Error('Ambiguous external reservation authorization requires reconciliation');
 // No receipt prose can release a live source owner. The exact intent must
 // actually expire, be released, or change instance/fencing token. Row identity
 // prevents a release/reacquire ABA even if owner and token are reused.
 return a;
}

/** No name/ledger inference and no claims of positive activity. Unbound or
 * expired intents have no effect. A valid uncertain owner only inhibits slots. */
export async function listActiveExternalQueueReservationsOnClient(c:Client,hooks:Partial<ExternalQueueReservationHooks>={}):Promise<ExternalQueueReservation[]>{
 const h={...defaults,...hooks};
 const rows=(await c.query("select run_id::text,uri,content from artifacts where kind='queue_external_reservation' and content->>'expiresAt'>$1 order by uri limit 501",[new Date(h.now()).toISOString()])).rows;
 if(rows.length>500)throw Error('External reservation evidence exceeds bounded review limit');
 const result:ExternalQueueReservation[]=[],families=new Set<string>();
 for(const row of rows){const b=row.content as ExternalQueueReservation;
  if(!b||b.version!==1||!uuid(b.id)||b.restrictiveOnly!==true||b.grantsExecution!==false||b.workingEvidence!==false||row.run_id!==b.sourceRunId||!validInput(b))continue;
  const a=await authorization(c,b,h);
  if(!a||acceptanceDigest(a)!==b.authorizationDigest||a.expiresAt!==b.expiresAt)continue;
  const proof=(await c.query(`select receipt_hash from action_receipts where run_id=$1 and action_type='queue_external_reservation_registered'
   and target=$2 and metadata=$3::jsonb and agent_id='workflow-orchestrator' limit 2`,[b.sourceRunId,row.uri,JSON.stringify(b)])).rows;
  if(proof.length!==1||!hash(proof[0].receipt_hash))continue;
  if(families.has(b.familyId))throw Error('Ambiguous external family reservation records require reconciliation');
  families.add(b.familyId);result.push(b);
 }
 return result;
}
export async function externalQueueReservationOccupancyOnClient(c:Client,hooks:Partial<ExternalQueueReservationHooks>={}){
 const reservations=await listActiveExternalQueueReservationsOnClient(c,hooks);
 const assignments=(await c.query("select id::text,fence::text,source_run_id::text,project_id::text,family_id,owner,intent_fence,file_scopes,role,lane from queue_coordinator_assignments where state in ('reserved','running','uncertain')")).rows;
 const unmatched:ExternalQueueReservation[]=[];
 for(const b of reservations){let matched=false;for(const q of assignments)if(await assignmentInstanceMatches(c,q,b)){matched=true;break;}if(!matched)unmatched.push(b);}
 return {count:unmatched.length,verifier:unmatched.some(b=>b.role==='verifier'),reservations,workingEvidence:false as const};
}

function assignmentScopeMatches(q:any,b:ExternalQueueReservationInput){return q.project_id===b.projectId&&q.source_run_id===b.sourceRunId&&q.family_id===b.familyId&&q.owner===b.owner&&q.intent_fence===b.intentFence&&q.role===b.role&&exactPaths(q.file_scopes)&&equal([...q.file_scopes].sort(),[...b.fileScopes].sort());}
async function assignmentInstanceMatches(c:Client,q:any,b:ExternalQueueReservationInput){
 if(!assignmentScopeMatches(q,b))return false;
 // Old assignments lack instance proof. They remain counted separately rather
 // than silently rewriting history or inferring that an old owner is current.
 const proof=(await c.query(`select metadata,receipt_hash,action_type,target from action_receipts where run_id=$1 and agent_id='workflow-orchestrator'
  and action_type in ('queue_coordinator_reserved','queue_partner_reasoning_reserved') and metadata->>'id'=$2 and metadata->>'fence'=$3`,[b.sourceRunId,q.id,q.fence])).rows;
 return proof.some(r=>hash(r.receipt_hash)&&r.target===(r.action_type==='queue_coordinator_reserved'?b.familyId:q.id)&&r.metadata?.lane===q.lane&&exactPaths(r.metadata?.fileScopes)&&equal(binding(r.metadata),binding(b)));
}

/** Caller owns a transaction. Same advisory lock as all ordinary coordinator
 * reservations: one family/owner is retained, no takeover and no gate opening. */
export async function registerExternalQueueReservationOnClient(c:Client,input:ExternalQueueReservationInput,hooks:Partial<ExternalQueueReservationHooks>={}):Promise<ExternalQueueReservation|null>{
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 const h={...defaults,...hooks},a=await authorization(c,input,h);if(!a)return null;
 const existing=await listActiveExternalQueueReservationsOnClient(c,hooks);
 if(existing.some(b=>b.familyId===input.familyId)|| (await c.query("select 1 from artifacts where kind='queue_external_reservation' and content->>'authorizationArtifactUri'=$1 limit 1",[input.authorizationArtifactUri])).rowCount)return null;
 const assignments=(await c.query("select id::text,fence::text,source_run_id::text,project_id::text,family_id,owner,intent_fence,file_scopes,role,lane from queue_coordinator_assignments where state in ('reserved','running','uncertain') and family_id=$1",[input.familyId])).rows;
 if(assignments.length&&(assignments.length!==1||!assignmentScopeMatches(assignments[0],input)))return null;
 const same=assignments.length===1&&await assignmentInstanceMatches(c,assignments[0],input);
 const {queueWorkingOccupancyOnClient}=await import('./queue-coordinator.js');
 const occupancy=await queueWorkingOccupancyOnClient(c);
 if(!same&&(occupancy.count>=QUEUE_SHARED_ITEM_LIMIT||(input.role==='verifier'&&(occupancy.verifier||occupancy.dependencies>0))))return null;
 const content:ExternalQueueReservation={version:1,id:randomUUID(),...input,fileScopes:[...input.fileScopes].sort(),authorizationDigest:acceptanceDigest(a),expiresAt:a.expiresAt,restrictiveOnly:true,grantsExecution:false,workingEvidence:false};
 await h.audit(c,input.sourceRunId,`db://workflow_runs/${input.sourceRunId}/queue_external_reservation/${content.id}`,content);
 return content;
}
export const registerExternalQueueReservation=(input:ExternalQueueReservationInput)=>withClient(async c=>{
 await c.query('begin');try{const value=await registerExternalQueueReservationOnClient(c,input);await c.query('commit');return value;}catch(error){await c.query('rollback');throw error;}
});
