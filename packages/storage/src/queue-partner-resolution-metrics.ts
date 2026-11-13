import {withClient} from './client.js';

export const queuePartnerResolutionStrategies=['verify-sealed-candidate','reconcile-owned-effects','repair-exact-source','discover-missing-scope','fresh-delivery','unknown'] as const;
export type QueuePartnerResolutionStrategy=typeof queuePartnerResolutionStrategies[number];
export interface QueuePartnerResolutionObservation {sourceRunId:string;strategy:string;state:string;blockedSince:string|null;settledAt:string}
export interface QueuePartnerResolutionMetric {strategy:QueuePartnerResolutionStrategy;blockedFamiliesObserved:number;attempts:number;acceptanceGapsClosed:number;nonResolvingTurns:number;verifiedClosureRate:number|null;averageTimeToVerifiedMs:number|null}
const shadowMinimumSamples=20;
function wilsonLowerBound(successes:number,total:number):number{
 if(total<=0)return 0;
 const z=1.96,p=successes/total,z2=z*z,denominator=1+z2/total;
 return (p+z2/(2*total)-z*Math.sqrt((p*(1-p)+z2/(4*total))/total))/denominator;
}

/** Body-free evidence summary. A verified journal row is valid only because
 * queue coordinator finalization independently enforces original acceptance. */
export function summarizeQueuePartnerResolutionYield(rows:readonly QueuePartnerResolutionObservation[]){
 const validState=new Set(['held','failed','verified','uncertain']);
 const normalized=rows.slice(0,500).filter(row=>row.sourceRunId&&validState.has(row.state)&&Number.isFinite(Date.parse(row.settledAt))).map(row=>({
  ...row,strategy:(queuePartnerResolutionStrategies as readonly string[]).includes(row.strategy)?row.strategy as QueuePartnerResolutionStrategy:'unknown' as const
 }));
 const metrics:QueuePartnerResolutionMetric[]=queuePartnerResolutionStrategies.map(strategy=>{
  const selected=normalized.filter(row=>row.strategy===strategy),verified=selected.filter(row=>row.state==='verified');
  const durations=verified.map(row=>row.blockedSince?Date.parse(row.settledAt)-Date.parse(row.blockedSince):NaN).filter(value=>Number.isFinite(value)&&value>=0);
  return {strategy,blockedFamiliesObserved:new Set(selected.map(row=>row.sourceRunId)).size,attempts:selected.length,
   acceptanceGapsClosed:verified.length,nonResolvingTurns:selected.filter(row=>row.state!=='verified').length,
   verifiedClosureRate:selected.length?verified.length/selected.length:null,
   averageTimeToVerifiedMs:durations.length?Math.round(durations.reduce((sum,value)=>sum+value,0)/durations.length):null};
 }).filter(metric=>metric.attempts>0);
 const eligible=metrics.filter(metric=>metric.strategy!=='unknown'&&metric.attempts>=shadowMinimumSamples).map(metric=>({
  strategy:metric.strategy,attempts:metric.attempts,verifiedClosureLowerBound:Number(wilsonLowerBound(metric.acceptanceGapsClosed,metric.attempts).toFixed(6)),averageTimeToVerifiedMs:metric.averageTimeToVerifiedMs
 })).sort((a,b)=>b.verifiedClosureLowerBound-a.verifiedClosureLowerBound||(a.averageTimeToVerifiedMs??Number.MAX_SAFE_INTEGER)-(b.averageTimeToVerifiedMs??Number.MAX_SAFE_INTEGER)||a.strategy.localeCompare(b.strategy));
 return {version:1,window:'latest-500-outcomes',bodyFree:true,totalAttempts:normalized.length,totalBlockedFamiliesObserved:new Set(normalized.map(row=>row.sourceRunId)).size,
  totalAcceptanceGapsClosed:normalized.filter(row=>row.state==='verified').length,strategies:metrics,
  adaptiveRankingShadow:{applied:false,minimumSamplesPerStrategy:shadowMinimumSamples,eligibleStrategies:eligible.length,
   promotionEligible:eligible.length>=2&&eligible[0]!.verifiedClosureLowerBound-eligible[1]!.verifiedClosureLowerBound>=0.1,proposedOrder:eligible}};
}

export async function queuePartnerResolutionYield(){return withClient(async c=>{
 const exists=Boolean((await c.query("select to_regclass('queue_partner_outcome_journal') name")).rows[0]?.name);
 if(!exists)return summarizeQueuePartnerResolutionYield([]);
 const rows=(await c.query(`select source_run_id::text "sourceRunId",coalesce(payload->>'resolutionStrategy','unknown') strategy,state,
  payload->>'blockedSince' "blockedSince",created_at::text "settledAt" from queue_partner_outcome_journal
  order by created_at desc,assignment_id desc limit 500`)).rows as QueuePartnerResolutionObservation[];
 return summarizeQueuePartnerResolutionYield(rows);
});}
