import fs from "node:fs/promises";
import { withClient } from "../../../../packages/storage/src/client.js";

export type QueueWaitReason = { category: string; reason: string; waitedMs: number; budgetMs: number; overdue: boolean; timingKnown?:boolean };
type Candidate = {
  runId:string;available:boolean;availableAt:string;waitSince:string;runStatus:string;coordinatorClaim:boolean;coordinatorReady:boolean;
  requiredProvider:string|null;allowedPlatforms:string[];projectActive:number;dependencyBlocked:boolean;serialBlocked:boolean;checkoutUnavailable:boolean;preparedOnly?:boolean;
};
type WorkerEvidence={status?:string;providerIds?:string[];workerId?:string;perProjectConcurrency?:number};

export function classifyQueueWait(candidate:Candidate,worker:WorkerEvidence,now=Date.now()):QueueWaitReason{
 const waitStart=Date.parse(candidate.waitSince),availableAt=Date.parse(candidate.availableAt);
 const timingKnown=Number.isFinite(waitStart)&&Number.isFinite(now);
 // Zero is only a display lower bound when timing is unknown, never an invented start timestamp.
 const waitedMs=timingKnown?Math.max(0,now-waitStart):0;
 const result=(category:string,reason:string,budgetMs:number):QueueWaitReason=>({category,reason:reason+(!timingKnown?' Wait start time is unavailable.':''),waitedMs,budgetMs,timingKnown,overdue:timingKnown&&category!=='prepared'&&category!=='availability-unknown'&&waitedMs>budgetMs});
 if(candidate.preparedOnly)return result('prepared','Prepared for the new workflow; waiting for explicit activation.',0);
 if(!candidate.available){
  if(!Number.isFinite(availableAt))return result('availability-unknown','Work is unavailable; its next eligible timestamp is missing or invalid.',60_000);
  return result('backoff',`Retry backoff is active until ${new Date(availableAt).toISOString()}.`,Math.max(0,availableAt-(timingKnown?waitStart:Number.isFinite(now)?now:availableAt)));
 }
 if(!['queued','leased','running'].includes(candidate.runStatus))return result('lifecycle',`Parent run is ${candidate.runStatus}; queued child work is not claimable.`,60_000);
 if(candidate.coordinatorClaim&&!candidate.coordinatorReady)return result('intent-conflict','The Queue Partner ownership or work-intent fence is no longer current.',60_000);
 if(candidate.coordinatorClaim)return result('dedicated-owner','Reserved for its fenced Queue Partner actor; waiting for that actor to claim it.',120_000);
 if(worker.status!=='running')return result('worker','The general worker heartbeat is not running.',30_000);
 if(candidate.requiredProvider&&!(worker.providerIds??[]).includes(candidate.requiredProvider))return result('provider',`No live worker advertises the required ${candidate.requiredProvider} provider.`,60_000);
 if(candidate.allowedPlatforms.length&&!candidate.allowedPlatforms.includes(process.platform))return result('worker-mismatch',`This project does not allow the current ${process.platform} worker platform.`,60_000);
 if(candidate.projectActive>=Math.max(1,worker.perProjectConcurrency??1))return result('capacity',`Project worker capacity is full (${candidate.projectActive}/${Math.max(1,worker.perProjectConcurrency??1)} active).`,300_000);
 if(candidate.dependencyBlocked)return result('dependency','A required earlier stage has not completed.',300_000);
 if(candidate.serialBlocked)return result('dependency','Another non-parallel stage in this run is still active.',300_000);
 if(candidate.checkoutUnavailable)return result('worker-mismatch','The worker recently reported that this project checkout is unavailable on this host.',60_000);
 return result('eligible','Eligible for the next worker scheduling poll; no stored exclusion was found.',30_000);
}

export async function withQueueWaitReasons<T extends {runId:string;queuedTasks:number;runningTasks:number}>(items:T[],heartbeatPath:string):Promise<Array<T&{waitReason?:QueueWaitReason}>>{
 const waiting=items.filter(item=>item.queuedTasks>0&&item.runningTasks===0),ids=waiting.map(item=>item.runId);
 if(!ids.length)return items;
 let worker:WorkerEvidence={status:'unknown',providerIds:[]};
 try{worker=JSON.parse(await fs.readFile(heartbeatPath,'utf8'));}catch{}
 const rows=await withClient(async client=>(await client.query<Candidate>(`select distinct on(wt.run_id)
  wt.run_id::text as "runId",wt.available_at<=clock_timestamp() available,wt.available_at::text as "availableAt",
  coalesce(wt.available_at,wr.started_at)::text as "waitSince",wr.status as "runStatus",
  coalesce(wr.evaluation_metadata#>>'{executionPipeline,preparedOnly}','false')='true' as "preparedOnly",
  coalesce(wr.evaluation_metadata,'{}'::jsonb)?'queueCoordinatorClaimId' as "coordinatorClaim",
  case when coalesce(wr.evaluation_metadata,'{}'::jsonb)?'queueCoordinatorClaimId' then exists(
   select 1 from queue_coordinator_assignments q join work_intents i on i.project_id=q.project_id::text and i.owner=q.owner and i.fencing_token::text=q.intent_fence and i.expires_at>clock_timestamp()
   where q.id::text=wr.evaluation_metadata->>'queueCoordinatorClaimId' and q.child_run_id=wr.id and q.project_id=wr.project_id and q.fence::text=wr.evaluation_metadata->>'queueCoordinatorFence' and q.state='running') else true end as "coordinatorReady",
  coalesce(nullif(nullif(wr.provider_override,'auto'),'default'),nullif(nullif(stage.definition->'routing'->>'provider','auto'),'default')) as "requiredProvider",
  coalesce(p.config->'execution'->'worker_pool'->'allowed_platforms','[]'::jsonb) as "allowedPlatforms",
  (select count(*)::int from workflow_tasks a join workflow_runs ar on ar.id=a.run_id where ar.project_id=wr.project_id and a.status in('leased','running')) as "projectActive",
  exists(select 1 from workflow_tasks prior join lateral jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot,'{}'::jsonb),wf.definition)->'stages') with ordinality ps(definition,stage_order) on ps.definition->>'id'=prior.stage_id
   where prior.run_id=wt.run_id and (case when stage.definition?'depends_on' then prior.stage_id=any(array(select jsonb_array_elements_text(stage.definition->'depends_on'))) else ps.stage_order<stage.stage_order end) and prior.status<>'completed') as "dependencyBlocked",
  exists(select 1 from workflow_tasks active join lateral jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot,'{}'::jsonb),wf.definition)->'stages') astage on astage->>'id'=active.stage_id
   where active.run_id=wt.run_id and active.status in('leased','running') and (stage.definition->>'parallel_group' is null or astage->>'parallel_group' is distinct from stage.definition->>'parallel_group')) as "serialBlocked",
  exists(select 1 from action_receipts r where r.run_id=wt.run_id and r.action_type='worker_project_unavailable' and r.created_at>clock_timestamp()-interval '10 minutes') as "checkoutUnavailable"
 from workflow_tasks wt join workflow_runs wr on wr.id=wt.run_id join projects p on p.id=wr.project_id join workflows wf on wf.id=wr.workflow_id
 join lateral jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot,'{}'::jsonb),wf.definition)->'stages') with ordinality stage(definition,stage_order) on stage.definition->>'id'=wt.stage_id
 where wt.run_id=any($1::uuid[]) and wt.status='queued' order by wt.run_id,wt.available_at,stage.stage_order`,[ids])).rows);
 const byRun=new Map(rows.map(row=>[row.runId,classifyQueueWait(row,worker)]));
 return items.map(item=>{const waitReason=byRun.get(item.runId);return waitReason?{...item,waitReason}:item;});
}
