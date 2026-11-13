import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {acceptanceDigest} from './acceptance.js';
import {withClient} from './client.js';
import {appendActionReceipt} from './receipt-writer.js';
import {verifyRunReceiptChainOnClient} from './postgres.js';
import {actionIdempotencyKey} from '../../workflow-engine/src/action-receipts.js';

export interface RejectedWriteProof {
 runId:string; taskId:string; stageId:string; agentId:string; target:string;
 patch:string; expectedHash:string; idempotencyKey:string; rejectionUri:string; rejectionReceiptHash:string;
}
const hash=/^[a-f0-9]{64}$/u;
/** Only errors emitted before the patcher's write syscall qualify. Unknown I/O,
 * partial writes, commands and narrative assurances never establish no effect. */
export function deterministicPrewriteRejection(proof:RejectedWriteProof,error:string):boolean {
 if(!hash.test(proof.expectedHash)||!hash.test(proof.idempotencyKey)||!hash.test(proof.rejectionReceiptHash)
  ||!proof.patch||Buffer.byteLength(proof.patch)>250000||!proof.target||proof.target.startsWith('/')
  ||proof.target.split('/').some(x=>!x||x==='.'||x==='..')||proof.target.includes('\\'))return false;
 const key=actionIdempotencyKey({taskId:proof.taskId,stageId:proof.stageId,agentId:proof.agentId,
  actionType:'file_write',target:proof.target,payload:JSON.stringify({patch:proof.patch,expectedHash:proof.expectedHash})});
 if(key!==proof.idempotencyKey)return false;
 const stale=`File patch rejected: stale preimage hash for ${proof.target}; expected ${proof.expectedHash}, found `;
 if(error.startsWith(stale)&&hash.test(error.slice(stale.length,-1))&&error.slice(stale.length,-1)!==proof.expectedHash&&error.endsWith('.'))return true;
 if(/^File patch rejected: hunk count mismatch; expected -\d+\/\+\d+, received -\d+\/\+\d+\.$/u.test(error))return true;
 return /^File patch rejected: (?:context|removal) mismatch at old line \d+; patch expected "(?:[^"\\]|\\.)*"; file contains "(?:[^"\\]|\\.)*"\. Regenerate from the exact current preimage; do not relax matching\.$/u.test(error);
}

export async function authenticateRejectedWriteProof(c:Client,proof:RejectedWriteProof,seen=new Set<string>()):Promise<boolean>{
 if(seen.has(proof.idempotencyKey)||seen.size>=20)return false;
 seen=new Set([...seen,proof.idempotencyKey]);
 const rows=(await c.query(`select e.*,t.stage_id,t.agent_id,r.status run_status from side_effect_receipts e
  join workflow_tasks t on t.id=$3 and t.run_id=$1::uuid join workflow_runs r on r.id=t.run_id
  where e.project_id=$1::text and e.idempotency_key=$2 for update of e,r`,[proof.runId,proof.idempotencyKey,proof.taskId])).rows;
 const e=rows.length===1?rows[0]:null;
 if(!e||!['blocked','failed','cancelled','completed'].includes(e.run_status)||!['pending','uncertain'].includes(e.status)
  ||e.operation!=='file_write'||e.target!==proof.target||e.stage_id!==proof.stageId||e.agent_id!==proof.agentId
  ||!e.claim_expires_at||new Date(e.claim_expires_at).getTime()>Date.now()||!e.receipt||typeof e.receipt!=='object'||Array.isArray(e.receipt)||Object.keys(e.receipt).length)return false;
 if((await c.query(`select 1 from workflow_tasks where run_id=$1 and status in ('leased','running') limit 1`,[proof.runId])).rowCount)return false;
 const rejections=(await c.query(`select a.uri,a.content,ar.receipt_hash,ar.created_at from artifacts a
  join action_receipts ar on ar.run_id=a.run_id and ar.metadata=a.content and ar.action_type='file_write_rejected'
   and ar.target=$3 and ar.agent_id=$4
  where a.run_id=$1 and a.task_id=$2 and a.kind='action_rejection'
   and a.created_at >= $5 and a.created_at <= least($6::timestamptz,coalesce((select min(next.created_at)
    from side_effect_receipts next where next.project_id=$1::text and next.target=$3 and next.idempotency_key<>$7 and next.created_at>$5),$6::timestamptz))`,
  [proof.runId,proof.taskId,proof.target,proof.agentId,e.created_at,e.claim_expires_at,proof.idempotencyKey])).rows;
 if(rejections.length!==1)return false;
 const rejection=rejections[0],a=rejection.content;
 if(rejection.uri!==proof.rejectionUri||rejection.receipt_hash!==proof.rejectionReceiptHash
  ||a.actionType!=='file_write'||a.target!==proof.target||a.requestedByTaskId!==proof.taskId
  ||a.requestedByStageId!==proof.stageId||!deterministicPrewriteRejection(proof,a.error??''))return false;
 // A matching key cannot identify one attempt when competing same-target claims
 // overlap its rejection. Do not infer which request a path-only error describes.
 const overlapping=(await c.query(`select idempotency_key from side_effect_receipts where project_id=$1 and target=$2
  and idempotency_key<>$3 and created_at<=$4 and coalesce(claim_expires_at,created_at)>=$5 limit 21`,
  [proof.runId,proof.target,proof.idempotencyKey,rejection.created_at,e.created_at])).rows;
 if(overlapping.length>20)return false;
 for(const other of overlapping){
  const prior=(await c.query(`select a.content,pr.created_at rejected_at from artifacts a
   join action_receipts ar on ar.run_id=a.run_id and ar.metadata=a.content and ar.action_type='prewrite_rejection_reconciled'
   join action_receipts pr on pr.run_id=a.run_id and pr.receipt_hash=a.content->'proof'->>'rejectionReceiptHash'
   where a.run_id=$1 and a.kind='prewrite_rejection_reconciliation' and a.content->'proof'->>'idempotencyKey'=$2`,[proof.runId,other.idempotency_key])).rows;
  const a=prior.length===1?prior[0].content:null;
  if(!a||!validReconciliationEnvelope(a,proof.runId)||new Date(prior[0].rejected_at).getTime()>=new Date(e.created_at).getTime()
   ||!await retainedHumanReconciliationAuthority(c,proof.runId,a.authorizationArtifactUri)
   ||!await authenticateRejectedWriteProof(c,a.proof,seen))return false;
 }
 if((await c.query(`select 1 from artifacts where run_id=$1 and kind='file_write'
  and (content->>'idempotencyKey'=$2 or (task_id=$3 and content->>'relativePath'=$4
   and created_at between $5 and $6)) limit 1`,[proof.runId,proof.idempotencyKey,proof.taskId,proof.target,e.created_at,rejection.created_at])).rowCount)return false;
 return (await verifyRunReceiptChainOnClient(c,proof.runId)).valid;
}

/** Append a narrowly authenticated no-write observation. Never finalize/reclaim a
 * reservation, refund authority, replay its request or change any run status. */
export interface RejectedWriteReconciliationInput {projectId:string;owner:string;intentFence:string;actor:string;reason:string;
 authorizationArtifactUri:string;confirmation:'Reconcile proven pre-write rejection only.';proof:RejectedWriteProof}
export async function reconcileRejectedWriteOnClient(c:Client,input:RejectedWriteReconciliationInput):Promise<string>{
  const p=input.proof;
  if(input.confirmation!=='Reconcile proven pre-write rejection only.'||!input.reason.trim()||!input.actor.trim())throw Error('Explicit human no-effect reconciliation authorization required');
  await c.query('select pg_advisory_xact_lock(hashtext($1))',[input.projectId]);
  const intent=(await c.query(`select 1 from work_intents i join workflow_runs r on r.project_id::text=i.project_id
   where r.id=$1 and i.project_id=$2 and i.owner=$3 and i.fencing_token=$4::bigint and i.expires_at>clock_timestamp()
   and i.file_scopes=$5::jsonb for update of i`,[p.runId,input.projectId,input.owner,input.intentFence,JSON.stringify([`runtime/history-reconciliation/${p.runId}`])])).rowCount;
  if(!await retainedHumanReconciliationAuthority(c,p.runId,input.authorizationArtifactUri))throw Error('Retained direct-human prerequisite authorization missing');
  if(!intent||!await authenticateRejectedWriteProof(c,p))throw Error('Exact expired reservation, deterministic rejection, chain, scope or quiescence proof missing');
  const prior=(await c.query(`select uri,content from artifacts where run_id=$1 and kind='prewrite_rejection_reconciliation' and content->'proof'->>'idempotencyKey'=$2`,[p.runId,p.idempotencyKey])).rows;
  if(prior.length){if(prior.length!==1||acceptanceDigest(prior[0].content.proof)!==acceptanceDigest(p))throw Error('Reservation already has a different reconciliation proof');return prior[0].uri;}
  const uri=`db://workflow_runs/${p.runId}/prewrite_rejection_reconciliation/${randomUUID()}`;
  const content={version:1,authority:'direct-human',proof:p,requestDigest:acceptanceDigest(p),
   noWriteOccurred:true,reservationStatusChanged:false,executionAuthorityGranted:false,acceptanceChanged:false,
   authorizationArtifactUri:input.authorizationArtifactUri,projectId:input.projectId,owner:input.owner,intentFence:input.intentFence,actor:input.actor,approvalEvidence:input.reason};
  await c.query('insert into artifacts(run_id,kind,uri,content) values($1,$2,$3,$4::jsonb)',[p.runId,'prewrite_rejection_reconciliation',uri,JSON.stringify(content)]);
  await appendActionReceipt(c,{runId:p.runId,agentId:'workflow-orchestrator',actionType:'prewrite_rejection_reconciled',target:p.idempotencyKey,
   summary:'Authenticated deterministic pre-write rejection; expired reservation and immutable history preserved, no effect replay or acceptance.',metadata:JSON.stringify(content)});
  return uri;
}
export async function reconcileRejectedWrite(input:RejectedWriteReconciliationInput):Promise<string>{
 return withClient(async c=>{await c.query('begin');try{const uri=await reconcileRejectedWriteOnClient(c,input);await c.query('commit');return uri;}catch(error){await c.query('rollback');throw error;}});
}

/** Revalidate each exception at the actual archive boundary, never trust a bare
 * status label or caller-provided list of supposedly harmless effects. */
export async function archiveReconciledEffectKeys(c:Client,runIds:string[]):Promise<string[]>{
 const result:string[]=[];
 for(const runId of runIds){
  const rows=(await c.query(`select a.content from artifacts a join action_receipts ar
   on ar.run_id=a.run_id and ar.metadata=a.content and ar.action_type='prewrite_rejection_reconciled'
   where a.run_id=$1 and a.kind='prewrite_rejection_reconciliation'`,[runId])).rows;
  for(const {content:a} of rows){
   if(!validReconciliationEnvelope(a,runId))continue;
   if(await retainedHumanReconciliationAuthority(c,runId,a.authorizationArtifactUri)&&await authenticateRejectedWriteProof(c,a.proof))result.push(`${runId}:${a.proof.idempotencyKey}`);
  }
 }
 return [...new Set(result)];
}

export async function retainedHumanReconciliationAuthority(c:Client,runId:string,uri:string):Promise<boolean>{
 if(typeof uri!=='string'||!uri.startsWith(`db://workflow_runs/${runId}/`))return false;
 const rows=(await c.query(`select a.content,ar.receipt_hash from artifacts a join action_receipts ar
  on ar.run_id=a.run_id and ar.metadata=a.content and ar.action_type='direct_human_prerequisite_authorization'
  where a.run_id=$1 and a.uri=$2 and a.kind='direct_human_prerequisite_authorization'`,[runId,uri])).rows;
 const a=rows.length===1?rows[0].content:null;
 return Boolean(a&&a.version===1&&a.source==='direct-human-current-chat'&&typeof a.instruction==='string'
  &&a.instruction.trim()&&Array.isArray(a.scope)&&a.scope.length&&hash.test(rows[0].receipt_hash??''));
}

function validReconciliationEnvelope(a:Record<string,any>,runId:string):boolean {
 return a.version===1&&a.authority==='direct-human'&&a.noWriteOccurred===true&&a.executionAuthorityGranted===false
  &&a.reservationStatusChanged===false&&a.acceptanceChanged===false&&a.proof?.runId===runId
  &&a.requestDigest===acceptanceDigest(a.proof);
}
