import { z } from 'zod';
import { canonicalJsonHash } from '../../policy-engine/src/index.js';
import { buildProjectEvidenceGraph } from '../../project-evidence/src/index.js';
import { withClient } from './client.js';
import { requestActionApproval } from './action-approvals.js';
import { appendActionReceipt } from './receipt-writer.js';
import { readProjectEvidenceGraph } from './project-evidence.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const payloadSchema=z.object({schemaVersion:z.literal(1),authority:z.literal('none'),nodeId:hash,
 source:z.object({path:z.string().min(1),hash,line:z.number().int().positive(),title:z.string().max(500)}).strict(),
 before:z.string().min(1).max(500),after:z.string().trim().min(1).max(500),reason:z.string().trim().min(1).max(2000),
 proposedBy:z.string().trim().min(1).max(160),previousReceiptId:z.string().uuid().nullable(),
 evidence:z.array(z.object({nodeId:hash,path:z.string(),hash,title:z.string().max(500)}).strict()).min(1).max(10)
}).strict();
export type ContextCorrection= z.infer<typeof payloadSchema>;
export async function readContextCorrections(project:string,nodeId:string){
 hash.parse(nodeId);
 return withClient(async c=>{
  const rows=await c.query(`select r.id::text,r.receipt_hash as "receiptHash",r.created_at::text as "observedAt",r.metadata
   from action_receipts r join workflow_runs w on w.id=r.run_id join projects p on p.id=w.project_id
   where p.root_uri=$1 and r.target=$2 and r.action_type='context_correction_recorded' order by coalesce((r.metadata->>'revision')::bigint,0) desc,r.created_at desc,r.id desc limit 21`,[project,nodeId]);
  const pending=await c.query(`select a.id::text,a.status,a.rationale from action_approvals a join workflow_runs w on w.id=a.run_id join projects p on p.id=w.project_id where p.root_uri=$1 and a.target=$2 and a.action_type='context_correction' and a.status in ('pending','approved','failed','executing') order by a.created_at desc,a.id desc limit 11`,[project,nodeId]);
  return {schemaVersion:1,project,nodeId,authority:'none',pendingApprovals:pending.rows.slice(0,10),pendingTruncated:pending.rows.length>10,truncated:rows.rows.length>20,entries:rows.rows.slice(0,20) as {id:string;receiptHash:string;observedAt:string;metadata:ContextCorrection&{executedBy:string;approvalId:string}}[]};
 });
}
export async function requestContextCorrection(project:string,input:{runId:string;nodeId:string;after:string;reason:string;proposedBy:string;supportIds:string[];previousReceiptId:string|null;sourceHash:string}){
 const graph=await readProjectEvidenceGraph(project);
 const node=graph.nodes.find(n=>n.id===input.nodeId&&['requirement','roadmap','decision'].includes(n.kind));
 if(!node?.source.hash||!node.source.path||!node.source.line)throw new Error('Select an indexed requirement, roadmap item or decision.');
 if(input.sourceHash!==node.source.hash)throw new Error('Indexed source changed; refresh before proposing a correction.');
 const history=await readContextCorrections(project,node.id);const latest=history.entries[0];
 if((latest?.id??null)!==input.previousReceiptId)throw new Error('Correction history changed; refresh before proposing.');
 const before=latest?.metadata.source.hash===node.source.hash?latest.metadata.after:node.title;
 const evidence=input.supportIds.map(id=>{const n=graph.nodes.find(n=>n.id===id);if(!n?.source.path||!n.source.hash)throw new Error('Supporting evidence must be an indexed project file fact.');return {nodeId:n.id,path:n.source.path,hash:n.source.hash,title:n.title};});
 const payload=payloadSchema.parse({schemaVersion:1,authority:'none',nodeId:node.id,source:{path:node.source.path,hash:node.source.hash,line:node.source.line,title:node.title},before,after:input.after,reason:input.reason,proposedBy:input.proposedBy,previousReceiptId:input.previousReceiptId,evidence});
 if(payload.before===payload.after)throw new Error('Correction must change the displayed fact.');
 const valid=await withClient(async c=>(await c.query('select w.id from workflow_runs w join projects p on p.id=w.project_id where p.root_uri=$1 and w.id=$2::uuid',[project,input.runId])).rows.length);
 if(!valid)throw new Error('Correction receipt run must belong to this project.');
 return requestActionApproval({runId:input.runId,stageId:'context-review',agentId:'workflow-orchestrator',actionType:'context_correction',target:node.id,rationale:payload.reason,policyDecision:{effect:'require_approval',authority:'none',scope:'indexed-fact-annotation'},payload,idempotencyKey:`context-correction:${canonicalJsonHash(payload)}`});
}

/** Called only after the existing role gates and fenced approval execution claim. */
export async function executeContextCorrection(input:{approvalId:string;claimToken:string;actor:string}){
 return withClient(async c=>{
  await c.query('begin');try{
   const a=(await c.query(`select aa.*,w.project_id,p.root_uri from action_approvals aa join workflow_runs w on w.id=aa.run_id join projects p on p.id=w.project_id where aa.id=$1::uuid`,[input.approvalId])).rows[0];
   if(!a||a.action_type!=='context_correction')throw new Error('Invalid context correction approval.');
   await c.query('select id from workflow_runs where id=$1 for update',[a.run_id]);
   const fenced=(await c.query(`select id from action_approvals where id=$1 and status='executing' and execution_claim_token=$2::uuid and execution_claim_expires_at>now() for update`,[a.id,input.claimToken])).rows.length;
   if(!fenced)throw new Error('Correction execution claim expired or was replaced.');
   const p=payloadSchema.parse(a.payload);
   if(a.target!==p.nodeId||a.idempotency_key!==`context-correction:${canonicalJsonHash(p)}`)throw new Error('Correction approval snapshot mismatch.');
   await c.query('select pg_advisory_xact_lock(hashtext($1))',[`${a.project_id}:context:${p.nodeId}`]);
   const uri=`db://workflow_runs/${a.run_id}/context_correction/${a.idempotency_key}`;
   if((await c.query('select uri from artifacts where uri=$1',[uri])).rows.length){await c.query('commit');return uri;}
   const file=(await c.query(`select source_uri as "sourceUri",content_hash as "contentHash",metadata,updated_at::text as "updatedAt" from project_files where project_id=$1 and source_uri=$2 for share`,[a.project_id,p.source.path])).rows[0];
   const node=file?buildProjectEvidenceGraph(a.root_uri,{files:[file],runs:[],artifacts:[],tasks:[]}).nodes.find(n=>n.id===p.nodeId):null;
   if(node?.source.hash!==p.source.hash||node?.title!==p.source.title)throw new Error('Indexed source changed; request a fresh correction approval.');
   const latest=(await c.query(`select r.id::text,r.metadata from action_receipts r join workflow_runs w on w.id=r.run_id where w.project_id=$1 and r.target=$2 and r.action_type='context_correction_recorded' order by coalesce((r.metadata->>'revision')::bigint,0) desc,r.created_at desc,r.id desc limit 1`,[a.project_id,p.nodeId])).rows[0];
   if((latest?.id??null)!==p.previousReceiptId)throw new Error('Correction history changed; request a fresh approval.');
   for(const support of p.evidence){if(!(await c.query('select 1 from project_files where project_id=$1 and source_uri=$2 and content_hash=$3 for share',[a.project_id,support.path,support.hash])).rows.length)throw new Error('Supporting evidence changed; request a fresh approval.');}
   const revision=(latest?.metadata.revision??0)+1;
   if(!Number.isSafeInteger(revision)||revision<1)throw new Error("Correction revision is invalid.");
   const metadata={...p,revision,executedBy:input.actor,approvalId:a.id,idempotencyKey:a.idempotency_key};
   await appendActionReceipt(c,{runId:a.run_id,agentId:a.agent_id,actionType:'context_correction_recorded',target:p.nodeId,summary:'Attributed indexed-fact correction recorded; source and execution authority unchanged.',metadata:JSON.stringify(metadata)});
   await c.query(`insert into artifacts(run_id,kind,uri,content) values($1,'context_correction',$2,$3::jsonb)`,[a.run_id,uri,JSON.stringify(metadata)]);
   await c.query('commit');return uri;
  }catch(e){await c.query('rollback');throw e;}
 });
}
