import {withClient} from '../../../../packages/storage/src/client.js';
import {verifyRunReceiptChain} from '../../../../packages/storage/src/postgres.js';
import type {RepairDispositionInput} from './queue-repair-disposition.js';

export interface ChildObservation {source_id:string;project_id:string;claim_id:string;fence:string;child_id:string;status:string;metadata:Record<string,unknown>;reason:string;receipt_id:string}
export function bindChildObservation(row:ChildObservation,valid:boolean):RepairDispositionInput['latestChild'] {
 const bound=row.metadata.sourceRunId===row.source_id&&row.metadata.queueCoordinatorClaimId===row.claim_id&&String(row.metadata.queueCoordinatorFence)===row.fence;
 return {assignmentSourceRunId:row.source_id,projectId:row.project_id,childRunId:row.child_id,status:row.status,fullChainValid:valid&&bound,
  evidenceRefs:row.receipt_id?[`receipt:${row.receipt_id}`,`assignment:${row.claim_id}`]:[],
  ...(row.reason?{blocker:{kind:'reconciliation' as const,reason:row.reason.slice(0,1600),nextAction:'Inspect this exact child’s stage policy and current source against the original contract. Preserve terminal history; do not infer a retry or scope grant from its report.'}}:{})};
}

/** Bounded observation only. Never feeds scheduler fingerprints or eligibility. */
export async function loadLatestRepairDispositions(sourceIds:string[]){
 const result=new Map<string,NonNullable<RepairDispositionInput['latestChild']>>();
 if(!sourceIds.length)return result;
 const rows=await withClient(async c=>(await c.query<ChildObservation>(`select * from (
  select distinct on (q.source_run_id) q.source_run_id::text source_id,q.project_id::text,
   q.id::text claim_id,q.fence::text,q.child_run_id::text child_id,r.status,r.evaluation_metadata metadata,
   coalesce(a.metadata->>'reason',a.summary,'') reason,a.id::text receipt_id,q.updated_at
  from queue_coordinator_assignments q join workflow_runs r on r.id=q.child_run_id and r.project_id=q.project_id
  left join lateral (select id,metadata,summary from action_receipts where run_id=r.id
   and action_type in ('stage_failed','stage_blocked') order by created_at desc,id desc limit 1) a on true
  where q.source_run_id=any($1::uuid[]) and q.role='repair'
  order by q.source_run_id,q.created_at desc,q.id desc
 ) latest order by updated_at desc limit 3`,[sourceIds])).rows);
 for(const row of rows){
  const chain=await verifyRunReceiptChain(row.child_id);
  result.set(row.source_id,bindChildObservation(row,chain.valid)!);
 }
 return result;
}
