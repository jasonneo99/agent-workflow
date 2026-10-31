import {canonicalJsonHash} from '../../policy-engine/src/index.js';
import {redactApprovalCardText} from '../../governance/src/high-risk-approval-inbox.js';
import {getActionApproval,listActionApprovals,type ActionApprovalStatus} from './action-approvals.js';
import {readProjectEvidenceGraph} from './project-evidence.js';
import {withClient} from './client.js';
const text=(s:string)=>redactApprovalCardText(s,1000);
const card=(a:ActionApprovalStatus)=>({id:a.id,runId:a.runId,actionType:a.actionType,target:text(a.target),rationale:text(a.rationale),status:a.status,workflowTask:text(a.workflowTask),updatedAt:a.updatedAt,decidedBy:a.decidedBy,executedBy:a.executedBy,decisionNote:a.decisionNote?text(a.decisionNote):null});
export async function readContextApprovals(project:string){const rows=await listActionApprovals({projectRootUri:project,limit:26});return {schemaVersion:1,project,authority:'none',truncated:rows.length>25,items:rows.slice(0,25).map(card)};}
function preview(value:unknown,limit:number){const raw=JSON.stringify(value, (key,v)=>/password|passwd|secret|token|credential|api.?key|authorization/i.test(key)?'[REDACTED]':v,2);return {text:redactApprovalCardText(raw,limit),truncated:raw.length>limit};}
export function approvalReviewSnapshot(a:ActionApprovalStatus){return canonicalJsonHash({id:a.id,project:a.projectRootUri,runId:a.runId,status:a.status,actionType:a.actionType,target:a.target,rationale:a.rationale,payload:a.payload,policyDecision:a.policyDecision,updatedAt:a.updatedAt,decidedAt:a.decidedAt,executedAt:a.executedAt,executionClaimExpiresAt:a.executionClaimExpiresAt});}
export async function readContextApprovalReview(project:string,id:string){
 if(!/^[a-f0-9-]{36}$/i.test(id))throw Error('Invalid approval identity.');
 const approval=await getActionApproval(id);if(!approval||approval.projectRootUri!==project)throw Error('Approval is unavailable in this project.');
 const graph=await readProjectEvidenceGraph(project);
 const related=graph.nodes.filter(n=>n.id===approval.target||n.source.path===approval.target||(typeof approval.payload.relativePath==='string'&&n.source.path===approval.payload.relativePath)||(n.kind==='run'&&n.target.value===approval.runId));
 const receipts=await withClient(async c=>(await c.query(`select id::text,action_type as "actionType",summary,receipt_hash as "receiptHash",created_at::text as "observedAt" from action_receipts where run_id=$1::uuid and metadata->>'approvalId'=$2 order by created_at desc,id desc limit 21`,[approval.runId,id])).rows);
 const payload=preview(approval.payload,16000),policy=preview(approval.policyDecision,4000);
 return {schemaVersion:1,project,authority:'none',snapshotHash:approvalReviewSnapshot(approval),approval:card(approval),payload:payload.text,policy:policy.text,reviewTruncated:payload.truncated||policy.truncated||approval.target.length>1000||approval.rationale.length>1000,related:related.slice(0,10),relatedTruncated:related.length>10||graph.truncated,receipts:receipts.slice(0,20).map(r=>({...r,summary:text(r.summary)})),receiptsTruncated:receipts.length>20,warnings:['Evidence explains the request and grants no execution authority. Approval alone does not establish execution or acceptance.','Relationships are exact target/path or originating-run matches within a bounded graph window; unrecorded dependencies remain unknown.','Receipt references are shown; this review does not independently verify their complete chains.']};
}
