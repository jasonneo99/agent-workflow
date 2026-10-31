import { withClient } from '../../../../packages/storage/src/client.js';

export type QueueHistoryCounts={active:number;waiting:number;blocked:number;failed:number;completed:number};
export type QueueHistoryPoint=QueueHistoryCounts&{at:string};
export type QueueHistorySignal={status:keyof QueueHistoryCounts;delta:number;tone:'positive'|'warning'|'neutral';message:string;partnerAction:string};
type QueueLike={runStatus:string;queuedTasks?:number;runningTasks?:number};
let schemaReady:Promise<void>|null=null;
let lastRetentionSweepAt=0;

const schema=`
create table if not exists queue_history_samples(
 scope text not null,
 bucket_start timestamptz not null,
 active integer not null check(active>=0),
 waiting integer not null check(waiting>=0),
 blocked integer not null check(blocked>=0),
 failed integer not null check(failed>=0),
 primary key(scope,bucket_start)
);
create index if not exists queue_history_samples_recent on queue_history_samples(bucket_start desc);`;

export function currentQueueCounts(queue:readonly QueueLike[]):Omit<QueueHistoryCounts,'completed'>{
 return queue.reduce((counts,item)=>{
  if((item.runningTasks??0)>0)counts.active++;
  else if((item.queuedTasks??0)>0)counts.waiting++;
  else if(item.runStatus==='blocked')counts.blocked++;
  else if(item.runStatus==='failed')counts.failed++;
  return counts;
 },{active:0,waiting:0,blocked:0,failed:0});
}

export function queueHistoryRangeMinutes(value:string|null):number{
 return value==='6h'?360:value==='24h'?1440:60;
}

/** Evidence-only trend interpretation shared by the chart and Queue Partner.
 * It changes prioritization, never eligibility, authority, approvals or acceptance.
 */
export function queueHistorySignals(points:readonly QueueHistoryPoint[]):QueueHistorySignal[]{
 if(points.length<2)return [];
 const first=points[0],last=points.at(-1)!;
 const blockedDelta=(Number(last.blocked)||0)-(Number(first.blocked)||0);
 const failedDelta=(Number(last.failed)||0)-(Number(first.failed)||0);
 const completedDelta=(Number(last.completed)||0)-(Number(first.completed)||0);
 const blockerAmplification=blockedDelta+failedDelta>0&&completedDelta<=0;
 const amplificationAction='Pause sibling recovery dispatch, cluster the new blockers by shared evidence or infrastructure cause, preserve live lease owners, repair the shared transport or runtime once, adopt it safely, then reconcile only duplicates made obsolete by verified recovery.';
 const definitions:Array<[keyof QueueHistoryCounts,string,(delta:number)=>QueueHistorySignal['tone'],string,string]>=[
  ['blocked','Blocked',delta=>delta>0?'warning':delta<0?'positive':'neutral','Investigate the newly blocked families before adding avoidable queue pressure.','Fewer blocked families remain; preserve the successful resolution evidence.'],
  ['failed','Failed',delta=>delta>0?'warning':delta<0?'positive':'neutral','Prioritize the demonstrated failure causes and look for a shared root cause.','Fewer failed families remain; retain the verified repair path.'],
  ['waiting','Waiting',delta=>delta>0?'warning':delta<0?'positive':'neutral','Rebalance available capacity toward eligible waiting work without duplicating active families.','Waiting work decreased; keep capacity focused on the current delivery order.'],
  ['active','Active',delta=>delta>0?'positive':delta<0?'warning':'neutral','Maintain the higher safe utilization while respecting ownership and admission gates.','Check whether released active slots should admit eligible waiting or blocked work.'],
  ['completed','Completed',delta=>delta>0?'positive':'neutral','Use the throughput evidence when comparing strategies; completion never proves acceptance by itself.','No new lifecycle completions were observed in this range.']
 ];
 return definitions.map(([status,label,tone,upAction,downAction])=>{const delta=(Number(last[status])||0)-(Number(first[status])||0);return {status,delta,tone:tone(delta),message:`${label} ${delta>0?'+':''}${delta}`,partnerAction:blockerAmplification&&(status==='blocked'||status==='failed')?amplificationAction:delta>0?upAction:downAction};});
}

export const queueHistoryReadQuery=`with bounds as (
    select date_trunc('minute',clock_timestamp()-($1::int*interval '1 minute')) range_start,
      date_trunc('minute',clock_timestamp()) range_end
   ), completed_runs as (
    select r.id,r.project_id,coalesce(max(t.finished_at),r.updated_at) completed_at
    from workflow_runs r left join workflow_tasks t on t.run_id=r.id
    where r.status='completed'
    group by r.id,r.project_id,r.updated_at
   ), completed_by_minute as (
    select date_trunc('minute',r.completed_at) bucket_start,count(*)::int completed
    from completed_runs r join projects p on p.id=r.project_id,bounds b
    where r.completed_at>=b.range_start and r.completed_at<b.range_end+interval '1 minute'
      and ($3::text='all' or p.root_uri=$3)
    group by date_trunc('minute',r.completed_at)
   ), completed_timeline as (
    select minute bucket_start,
      sum(coalesce(c.completed,0)) over(order by minute rows between unbounded preceding and current row)::int completed
    from bounds b cross join lateral generate_series(b.range_start,b.range_end,interval '1 minute') minute
    left join completed_by_minute c on c.bucket_start=minute
   ) select s.bucket_start::text at,s.active,s.waiting,s.blocked,s.failed,coalesce(c.completed,0)::int completed
   from queue_history_samples s left join completed_timeline c on c.bucket_start=s.bucket_start
   where s.scope=$3 and s.bucket_start>=clock_timestamp()-($1::int*interval '1 minute')
   order by s.bucket_start limit $2`;

export async function recordAndLoadQueueHistory(input:{queue:readonly QueueLike[];projectRootUri?:string;rangeMinutes:number}):Promise<QueueHistoryPoint[]>{
 const scope=input.projectRootUri?.trim()||'all';
 const range=Math.max(1,Math.min(1440,Math.trunc(input.rangeMinutes)));
 const counts=currentQueueCounts(input.queue);
 return withClient(async client=>{
  if(!schemaReady)schemaReady=client.query(schema).then(()=>undefined).catch(error=>{schemaReady=null;throw error;});
  await schemaReady;
  await client.query(`insert into queue_history_samples(scope,bucket_start,active,waiting,blocked,failed)
   values($1,date_trunc('minute',clock_timestamp()),$2,$3,$4,$5)
   on conflict(scope,bucket_start) do update set active=excluded.active,waiting=excluded.waiting,blocked=excluded.blocked,failed=excluded.failed`,
   [scope,counts.active,counts.waiting,counts.blocked,counts.failed]);
  if(Date.now()-lastRetentionSweepAt>=3_600_000){await client.query("delete from queue_history_samples where bucket_start<clock_timestamp()-interval '180 days'");lastRetentionSweepAt=Date.now();}
  const rows=(await client.query(queueHistoryReadQuery,[range,range+1,scope])).rows;
  return rows.map(row=>({at:String(row.at),active:Number(row.active),waiting:Number(row.waiting),blocked:Number(row.blocked),failed:Number(row.failed),completed:Number(row.completed)}));
 });
}
